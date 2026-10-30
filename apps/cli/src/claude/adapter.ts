import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { commandSpec } from "../platform.js";
import type { TaskAssign, TaskEvent } from "@nema/shared";
import { attachmentCapabilities, refusal } from "../attachments/capabilities.js";
import { attachmentLabel, attachmentPreamble, textAttachmentBlock } from "../attachments/blocks.js";
import { loadTaskAttachments, type LoadedAttachment } from "../attachments/fetch.js";
import { configErrorMessage, loadConfig, type NemaConfig } from "../config.js";
import type { AgentAdapter, AgentResult } from "../daemon/runner.js";
import { parseClaudeLine, roomToolsOk, skillActivationFrom } from "./events.js";
import { claudeAllowedToolNames } from "../direct/tools.js";
import { CLAUDE_SKILL_TOOLS, prepareClaudeLaunch, withSkillArgs, type ClaudeLaunch } from "./launch.js";
import { claudeSkillsSection, prepareClaudeSkills, type ClaudeSkillPrep } from "../skills/claudeSkills.js";
import { MIN_CLAUDE_SKILLS_VERSION, claudeSkillsSupported, claudeVersionRunner, versionAtLeast } from "../skills/claudeVersion.js";
import type { SnapshotSkill } from "../skills/snapshot.js";
import { readRepoSkillFile, takeTaskSnapshot } from "../skills/repoSkills.js";
import { manualSection, preloadSection, readSkillBody } from "../skills/preload.js";
import { settleReports, trackReport } from "../skills/reports.js";
import { RoomClient } from "../room/client.js";
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
  /** Whether this Claude Code can load Skills; production runs `claude --version` once. */
  claudeSkillsOk?: () => Promise<{ ok: boolean; version: string | null }>;
};

/** A task that runs with Skills: the copies, the snapshot rows they came from, and the preload text. */
type SkillRun = { prep: ClaudeSkillPrep; skills: Map<string, SnapshotSkill>; preload: string | null; reports: Promise<unknown>[]; report: (id: string, revision: string) => Promise<void> };

const TOO_OLD = `Claude Code 版本过低（需要 ${MIN_CLAUDE_SKILLS_VERSION} 或更新），本任务不使用 Skills。`;

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
    let config: NemaConfig;
    try {
      config = loadConfig(this.opts.nemaHome);
    } catch (e) {
      return { ok: false, error: configErrorMessage(e) };
    }
    const model = config.model;
    // An attachment Claude cannot take is refused first, before any login or launch problem (D-2 A).
    const caps = attachmentCapabilities({ ...config, adapter: "claude-code" });
    const refused = task.attachments?.length ? refusal(caps, task.attachments) : null;
    if (refused) return { ok: false, error: refused };

    let token: string;
    try {
      token = readClaudeToken(this.opts.nemaHome);
    } catch (e) {
      return { ok: false, error: message(e) };
    }

    // The run's clock starts here: a stalled attachment download counts toward the timeout.
    const timeoutMs = task.limits?.timeoutMs ?? this.opts.timeoutMs ?? 600_000;
    const startedAt = Date.now();
    const clock = AbortSignal.timeout(timeoutMs);
    const loaded = await loadTaskAttachments(task, caps, signal ? AbortSignal.any([signal, clock]) : clock);
    if (signal?.aborted) return { ok: false, error: "Claude 运行已中止。" };
    if (clock.aborted) return { ok: false, error: timedOutMessage(task.limits ? Math.round(task.limits.timeoutMs / 60_000) : 10) };
    if (!loaded.ok) return { ok: false, error: loaded.error };
    // Built before launch, so an attachment that cannot be encoded fails with its own reason.
    let stdin: string;
    try {
      stdin = userMessage(task.prompt, loaded.attachments);
    } catch (e) {
      return { ok: false, error: message(e) };
    }

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

    // Skills never fail the task: anything that goes wrong here leaves the launch as it was.
    let skillRun: SkillRun | null = null;
    let reports: Promise<unknown>[] = [];
    try {
      const prepared = await this.prepareSkills(task, launch, onEvent);
      skillRun = prepared.run;
      reports = prepared.reports;
      const sections: string[] = [];
      if (skillRun) {
        launch = { ...launch, args: withSkillArgs(launch.args, skillRun.prep) };
        sections.push(claudeSkillsSection(skillRun.prep.copied.map((id) => skillRun!.skills.get(id)!)));
      }
      // A Skill called by hand comes before the thread's ones.
      if (prepared.manual) sections.push(prepared.manual);
      if (skillRun?.preload) sections.push(skillRun.preload);
      if (sections.length > 0) stdin = userMessage(`${task.prompt}\n\n${sections.join("\n\n")}`, loaded.attachments);
    } catch (e) {
      skillRun = null;
      onEvent({ type: "progress", text: `Skills 准备失败，本任务不使用 Skills：${message(e)}` });
    }

    try {
      const result = await this.execute(task, launch, onEvent, signal, stdin, Math.max(1, timeoutMs - (Date.now() - startedAt)), skillRun);
      // Activation reports finish before the task does, so the thread has them for its next task.
      if (reports.length > 0) {
        const settled = await settleReports(reports, 5000);
        if (settled.timedOut) onEvent({ type: "progress", text: "Skill 激活记录未能及时上报" });
        else if (settled.failed > 0) onEvent({ type: "progress", text: `${settled.failed} 条 Skill 激活记录上报失败` });
      }
      return result;
    } finally {
      rmSync(launch.runDir, { recursive: true, force: true });
    }
  }

  /**
   * Copies the task's Skills into the run dir (`run` is null when the task runs without them) and builds the
   * section for a Skill the user called with `/name`, which goes in even then.
   */
  private async prepareSkills(task: TaskAssign, launch: ClaudeLaunch, onEvent: (e: TaskEvent) => void): Promise<{ run: SkillRun | null; manual: string | null; reports: Promise<unknown>[] }> {
    const snapshot = await takeTaskSnapshot({ nemaHome: this.opts.nemaHome, claudeCodeOk: true, ...(task.projectSkills ? { projectSkills: task.projectSkills } : {}) });
    if (snapshot.warnings.length > 0) onEvent({ type: "progress", text: `部分 Skill 未载入：${snapshot.warnings.join("；")}` });
    const room = new RoomClient(task.hubUrl, task.runToken);
    const reports: Promise<unknown>[] = [];
    const report = async (id: string, revision: string) => {
      const reported = await room.reportSkillActivation(id, revision);
      if (!reported.ok) throw new Error(reported.error);
    };
    const readBody = (skill: SnapshotSkill) => readSkillBody(this.opts.nemaHome, skill, readRepoSkillFile);
    const finish = async (run: SkillRun | null) => {
      if (!task.manualSkill) return { run, manual: null, reports };
      const copy = (id: string) => run?.prep.skillDirs.get(id);
      const section = await manualSection({
        snapshot,
        manual: task.manualSkill,
        readBody,
        more: (skill, at) => (copy(skill.id) ? `剩下的部分用 Read 读 ${copy(skill.id)}；正文（frontmatter 之后）的前 ${at.lines} 行已附在这里。` : ""),
      });
      if (section.skill) trackReport(reports, report(section.skill.id, section.skill.revision));
      return { run, manual: section.text, reports };
    };
    if (snapshot.skills.length === 0) return finish(null);
    const check = this.opts.claudeSkillsOk ?? (() => claudeSkillsSupported(claudeVersionRunner(this.opts.claudeBin ?? "claude")));
    if (!(await check()).ok) {
      onEvent({ type: "progress", text: TOO_OLD });
      return finish(null);
    }
    const prep = await prepareClaudeSkills({ nemaHome: this.opts.nemaHome, runDir: launch.runDir, snapshot, readRepoFile: readRepoSkillFile });
    const reasons = { budget: "超过 50 MiB", changed: "文件已改变", unreadable: "无法读取" } as const;
    if (prep.skipped.length > 0) {
      onEvent({ type: "progress", text: `部分 Skill 未载入：${prep.skipped.map((s) => `${s.id}（${reasons[s.reason]}）`).join("；")}` });
    }
    if (prep.copied.length === 0) return finish(null);
    const copied = { skills: snapshot.skills.filter((skill) => prep.copied.includes(skill.id)), warnings: [] };
    let preload: string | null = null;
    const retained = (task.retainedSkills ?? []).filter((id) => id !== task.manualSkill?.skillId);
    if (retained.length > 0) {
      const section = await preloadSection({ snapshot: copied, retained, readBody });
      preload = section.text;
      if (section.dropped.length > 0) onEvent({ type: "progress", text: `这些 Skill 放不下，没有预载：${section.dropped.join("、")}` });
    }
    return finish({ prep, skills: new Map(snapshot.skills.map((skill) => [skill.id, skill])), preload, reports, report });
  }

  private async execute(task: TaskAssign, launch: ClaudeLaunch, onEvent: (e: TaskEvent) => void, signal: AbortSignal | undefined, stdin: string, timeoutMs: number, skillRun: SkillRun | null = null): Promise<AgentResult> {
    const bin = this.opts.claudeBin ?? "claude";
    const maxToolCalls = task.limits?.maxToolCalls ?? MAX_TOOL_CALLS;
    const minutes = task.limits ? Math.round(task.limits.timeoutMs / 60_000) : 10;
    const allowed = new Set([...claudeAllowedToolNames(task.pluginTools), ...(skillRun ? CLAUDE_SKILL_TOOLS : [])]);
    // tool_use id → Skill id, until its tool_result says whether the load worked.
    const pendingSkills = new Map<string, string>();
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
          if (skillRun) {
            if (ev.version !== null && !versionAtLeast(ev.version)) {
              onEvent({ type: "progress", text: `Claude Code ${ev.version} 低于 ${MIN_CLAUDE_SKILLS_VERSION}，Skills 可能不按预期工作。` });
            }
            const listed = new Set(ev.skills ?? []);
            const absent = skillRun.prep.copied.filter((id) => !listed.has(id) && !listed.has(path.basename(path.dirname(skillRun!.prep.skillDirs.get(id)!))));
            if (ev.skills === null || absent.length > 0) {
              onEvent({ type: "progress", text: `Claude Code 没有列出这些 Skill：${ev.skills === null ? skillRun.prep.copied.join("、") : absent.join("、")}` });
            }
          }
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
          if (skillRun) {
            for (const use of ev.uses) {
              const id = skillActivationFrom(use, skillRun.prep.skillDirs);
              if (id !== null && use.id) pendingSkills.set(use.id, id);
              else if (use.name === "Skill") onEvent({ type: "progress", text: "认不出这次 Skill 调用的输入，没有记录它读取了哪个 Skill。" });
            }
          }
          return;
        }
        if (ev.kind === "results") {
          for (const r of ev.results) {
            const id = pendingSkills.get(r.toolUseId);
            if (id === undefined) continue;
            pendingSkills.delete(r.toolUseId);
            if (r.isError) continue;
            const revision = skillRun!.skills.get(id)!.revision;
            onEvent({ type: "tool_call", text: `读取 Skill ${id}（${revision}）` });
            trackReport(skillRun!.reports, skillRun!.report(id, revision));
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
        child.stdin?.end(stdin);
      } catch {
        // The child can exit before the prompt is written.
      }
    });
  }
}
