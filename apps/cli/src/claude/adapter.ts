import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { commandSpec } from "../platform.js";
import type { TaskAssign, TaskEvent } from "@nema/shared";
import { attachmentCapabilities } from "../attachments/capabilities.js";
import { attachmentLabel, attachmentPreamble, textAttachmentBlock } from "../attachments/blocks.js";
import { loadTaskAttachments, type LoadedAttachment } from "../attachments/fetch.js";
import { configErrorMessage, loadConfig, type NemaConfig } from "../config.js";
import type { AgentAdapter, AgentResult } from "../daemon/runner.js";
import { parseClaudeLine, roomToolsOk } from "./events.js";
import { claudeAllowedToolNames } from "../direct/tools.js";
import { prepareClaudeLaunch, type ClaudeLaunch } from "./launch.js";
import { readClaudeToken } from "./token.js";
import type { OwnedHelperProcess, OwnedHelperScope } from "@nema/shared/ownedHelper";

const NOT_FOUND = "找不到 claude。请先安装 Claude Code 并把它放到 PATH 上。";
const START_FAILED = "无法启动 Claude。";
// timeoutMs only shortens the clock. The sentence names the run's limit: 10 minutes unless the task carries limits.
const toolLimitMessage = (n: number) => `Claude 工具调用超过 ${n} 次，任务已中止。`;
const timedOutMessage = (minutes: number) => `Claude 运行超过 ${minutes} 分钟，任务已中止。`;
const NO_INIT = "Claude 没有给出工具面就退出了。";
const NO_REPLY = "Claude 没有返回回复。";
const RUN_FAILED = "Claude 运行失败，任务已中止。";
const LOGIN_FAILED = "Claude 登录失败。请重新运行 claude setup-token，再把令牌从标准输入交给 nema auth claude。";
const MAX_TOOL_CALLS = 60;
const STDERR_CAP = 8 * 1024;
// Auth hint only. Never copy the stderr buffer into a user-visible error.
const AUTH_STDERR = /authentication|not logged in|login|oauth|setup-token|401/i;

export type ClaudeCodeAdapterOptions = {
  nemaHome: string;
  cliEntry: string;
  claudeBin?: string;
  parentEnv?: NodeJS.ProcessEnv;
  execPath?: string;
  timeoutMs?: number;
  ownedHelpers?: OwnedHelperScope;
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

function attachmentBlocks(a: LoadedAttachment): ContentBlock[] {
  if (a.kind === "text") return [{ type: "text", text: textAttachmentBlock(a) }];
  // A native block carries no name: a one-line JSON label ahead of it says which file it is.
  const label: ContentBlock = { type: "text", text: attachmentLabel(a) };
  const data = a.bytes.toString("base64");
  if (a.kind === "image") return [label, { type: "image", source: { type: "base64", media_type: a.mime, data } }];
  return [label, { type: "document", source: { type: "base64", media_type: "application/pdf", data } }];
}

/** The one stream-json user message: the prompt, then (with attachments) the preamble and every attachment. */
function userMessage(prompt: string, attachments: readonly LoadedAttachment[] = []): string {
  const content: ContentBlock[] = [{ type: "text", text: prompt }];
  if (attachments.length > 0) content.push({ type: "text", text: attachmentPreamble() }, ...attachments.flatMap(attachmentBlocks));
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = "claude-code";

  constructor(private readonly opts: ClaudeCodeAdapterOptions) {}

  async run(task: TaskAssign, onEvent: (e: TaskEvent) => void, signal?: AbortSignal): Promise<AgentResult> {
    if (signal?.aborted) return { ok: false, error: "Claude 运行已中止。" };
    let token: string;
    try {
      token = readClaudeToken(this.opts.nemaHome);
    } catch (e) {
      return { ok: false, error: message(e) };
    }

    let config: NemaConfig;
    try {
      config = loadConfig(this.opts.nemaHome);
    } catch (e) {
      return { ok: false, error: configErrorMessage(e) };
    }
    const model = config.model;

    // Refused or unreadable attachments fail the task before anything is launched (D-2 A).
    const loaded = await loadTaskAttachments(task, attachmentCapabilities({ ...config, adapter: "claude-code" }), signal);
    if (!loaded.ok) return { ok: false, error: loaded.error };
    if (signal?.aborted) return { ok: false, error: "Claude 运行已中止。" };

    let launch: ClaudeLaunch;
    try {
      launch = prepareClaudeLaunch({
        nemaHome: this.opts.nemaHome,
        taskId: task.taskId,
        hubUrl: task.hubUrl,
        runToken: task.runToken,
        token,
        model,
        cliEntry: this.opts.cliEntry,
        execPath: this.opts.execPath ?? process.execPath,
        parentEnv: this.opts.parentEnv ?? process.env,
        pluginTools: task.pluginTools,
        ...(task.limits ? { maxTurns: task.limits.maxModelCalls } : {}),
      });
    } catch (e) {
      return { ok: false, error: message(e) };
    }

    try {
      return await this.execute(task, launch, onEvent, signal, loaded.attachments);
    } finally {
      rmSync(launch.runDir, { recursive: true, force: true });
    }
  }

  private async execute(task: TaskAssign, launch: ClaudeLaunch, onEvent: (e: TaskEvent) => void, signal: AbortSignal | undefined, attachments: readonly LoadedAttachment[]): Promise<AgentResult> {
    const bin = this.opts.claudeBin ?? "claude";
    const timeoutMs = task.limits?.timeoutMs ?? this.opts.timeoutMs ?? 600_000;
    const maxToolCalls = task.limits?.maxToolCalls ?? MAX_TOOL_CALLS;
    const minutes = task.limits ? Math.round(task.limits.timeoutMs / 60_000) : 10;
    const allowed = new Set(claudeAllowedToolNames(task.pluginTools));
    const command = commandSpec(bin, launch.args, launch.env);
    let child: ChildProcess | OwnedHelperProcess;
    try {
      child = this.opts.ownedHelpers
        ? await this.opts.ownedHelpers.spawn(command.bin, command.args, {
          cwd: path.join(launch.runDir, "work"), env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, signal,
        })
        : spawn(command.bin, command.args, {
          cwd: path.join(launch.runDir, "work"), env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true,
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).name === "AbortError") return { ok: false, error: "Claude 运行已中止。" };
      return { ok: false, error: (error as NodeJS.ErrnoException).code === "ENOENT" ? NOT_FOUND : START_FAILED };
    }
    const owned = "closed" in child;
    const closedPromise = owned
      ? (child as OwnedHelperProcess).closed
      : new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClosed) => {
        (child as ChildProcess).once("close", (code, closeSignal) => resolveClosed({ code, signal: closeSignal }));
      });

    return new Promise((resolve) => {
      let settled = false;
      let closed = false;
      let initOk = false;
      let initSeen = false;
      let toolCount = 0;
      let buf = "";
      let stderrBuf = "";

      const killTree = () => {
        if (owned) {
          child.kill("SIGKILL");
          return;
        }
        // detached => the child leads its own process group. pid 0 would signal this group.
        const pid = (child as ChildProcess).pid;
        if (pid === undefined || pid <= 0 || pid === process.pid) return;
        if (process.platform === "win32") {
          spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          return;
        }
        try {
          process.kill(-pid, "SIGKILL");
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code !== "ESRCH" && code !== "EPERM") throw e;
        }
      };

      const finish = (result: AgentResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        killTree();
        if (closed) return resolve(result);
        void closedPromise.then(() => resolve(result));
      };
      const cancel = () => finish({ ok: false, error: "Claude 运行已中止。" });

      const handle = (line: string) => {
        if (settled) return;
        const ev = parseClaudeLine(line);
        if (ev.kind === "ignore") return;
        if (ev.kind === "tools") {
          const outside = ev.names.find((name) => !allowed.has(name));
          if (outside !== undefined) {
            return finish({ ok: false, error: `Claude 调用了 Room 以外的工具 ${outside}，任务已中止。` });
          }
        }
        if (ev.kind === "failure") return finish({ ok: false, error: RUN_FAILED });
        if (ev.kind === "init") {
          if (initSeen) return;
          initSeen = true;
          const check = roomToolsOk(ev.tools, ev.mcpServers, allowed);
          if (!check.ok) return finish({ ok: false, error: check.error });
          initOk = true;
          return;
        }
        if (!initOk) return;
        if (ev.kind === "text") return onEvent({ type: "progress", text: ev.text });
        if (ev.kind === "tools") {
          for (const name of ev.names) {
            toolCount += 1;
            if (toolCount > maxToolCalls) return finish({ ok: false, error: toolLimitMessage(maxToolCalls) });
            onEvent({ type: "tool_call", text: name });
          }
          return;
        }
        finish({ ok: true, reply: ev.text });
      };

      const take = (chunk: string) => {
        if (settled) return;
        buf += chunk;
        let nl: number;
        while (!settled && (nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          handle(line);
        }
      };

      const timer = setTimeout(() => finish({ ok: false, error: timedOutMessage(minutes) }), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      if (!owned) {
        (child as ChildProcess).on("spawn", () => { if (settled) killTree(); });
        (child as ChildProcess).on("error", (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          killTree();
          resolve({ ok: false, error: err.code === "ENOENT" ? NOT_FOUND : START_FAILED });
        });
      }
      child.stdout?.on("data", take);
      child.stderr?.on("data", (chunk: string) => {
        const room = STDERR_CAP - stderrBuf.length;
        if (room <= 0) return;
        stderrBuf += chunk.length > room ? chunk.slice(0, room) : chunk;
      });
      child.stdin?.on("error", () => {});
      const onClose = () => {
        closed = true;
        killTree();
        if (settled) return;
        if (buf.trim()) handle(buf);
        buf = "";
        if (!settled) {
          let error = NO_INIT;
          if (initOk) error = NO_REPLY;
          else if (AUTH_STDERR.test(stderrBuf)) error = LOGIN_FAILED;
          finish({ ok: false, error });
        }
      };
      if (owned) void closedPromise.then(onClose);
      else (child as ChildProcess).once("close", onClose);
      try {
        child.stdin?.end(userMessage(task.prompt, attachments));
      } catch {
        // The child can exit before the prompt is written.
      }
    });
  }
}
