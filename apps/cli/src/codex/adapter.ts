import { spawn } from "node:child_process";
import { lstatSync, renameSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
// Retired (spec 6.7 §6, 2026-10-23): the daemon no longer registers this adapter or spawns `codex`.
// Codex runs through CodexDirectAdapter. Kept so the isolation approach can be reused for a future CLI agent.
import type { TaskAssign, TaskEvent } from "@nema/shared";
import type { AgentAdapter, AgentResult } from "../daemon/runner.js";
import { buildEnv, checkCodexAuth, cleanupRun, prepareIsolation, preflight, type IsolationPaths } from "./isolation.js";
import { parseCodexLine } from "./events.js";

export type CodexAdapterOptions = {
  codexBin?: string;
  nemaHome: string;
  userCodexHome: string;
  cliEntry: string;
  timeoutMs?: number;
};

/** Codex may refresh tokens by atomic rename, replacing our symlink with a regular file. Put it back. */
function restoreAuthSymlink(paths: IsolationPaths, userCodexHome: string): void {
  const link = path.join(paths.codexHome, "auth.json");
  try {
    if (lstatSync(link).isSymbolicLink()) return;
  } catch {
    return;
  }
  const target = path.join(userCodexHome, "auth.json");
  renameSync(link, target);
  chmodSync(target, 0o600);
  symlinkSync(target, link);
}

export const CONFIDENTIAL_REFUSAL =
  "codex-cli 适配器在保密 workspace 中被禁用（隔离未通过验证）。请改用 codex-direct：nema config set adapter codex-direct，或在 workspace 设置中关闭保密。";

export class CodexAdapter implements AgentAdapter {
  readonly name = "codex-cli";
  constructor(private readonly opts: CodexAdapterOptions) {}

  async run(task: TaskAssign, onEvent: (e: TaskEvent) => void): Promise<AgentResult> {
    // Isolation is not verified strongly enough for confidential workspaces: refuse before anything starts.
    if (task.confidential) return { ok: false, error: CONFIDENTIAL_REFUSAL };
    const auth = checkCodexAuth(this.opts.userCodexHome);
    if (!auth.ok) return { ok: false, error: auth.error };

    const paths = await prepareIsolation({
      nemaHome: this.opts.nemaHome,
      workspaceId: task.workspaceId,
      userCodexHome: this.opts.userCodexHome,
      mcp: {
        command: process.execPath,
        args: [this.opts.cliEntry, "mcp"],
        env: { NEMA_HUB_URL: task.hubUrl, NEMA_RUN_TOKEN: task.runToken },
      },
    });
    try {
      const pf = preflight(paths);
      if (!pf.ok) return { ok: false, error: "隔离自检失败：" + pf.problems.join("；") };
      return await this.exec(task, paths, onEvent);
    } finally {
      try {
        restoreAuthSymlink(paths, this.opts.userCodexHome);
      } catch {
        // best effort: never mask the run result
      }
      await cleanupRun(paths);
    }
  }

  private exec(task: TaskAssign, paths: IsolationPaths, onEvent: (e: TaskEvent) => void): Promise<AgentResult> {
    const bin = this.opts.codexBin ?? process.env.NEMA_CODEX_BIN ?? "codex";
    const lastFile = path.join(paths.workDir, "last.txt");
    const timeoutMs = this.opts.timeoutMs ?? 600_000;

    return new Promise<AgentResult>((resolve) => {
      let settled = false;
      let lastMessage = "";
      let stderr = "";
      let buf = "";
      let exited = false;
      let exitWait: NodeJS.Timeout | undefined;
      const killTree = () => {
        // detached => the child leads its own process group; kill the whole tree (Codex's children included).
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // ESRCH: group already gone
        }
      };
      const finish = (r: AgentResult, kill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!kill) return resolve(r);
        // Failure paths: kill the tree, then wait for exit (short grace) before cleanup/restore may run.
        killTree();
        if (exited) return resolve(r);
        exitWait = setTimeout(() => resolve(r), 2000);
        child.once("close", () => {
          clearTimeout(exitWait);
          resolve(r);
        });
      };

      const child = spawn(
        bin,
        ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", paths.workDir, "-o", lastFile, "-"],
        { env: buildEnv(paths, process.env), cwd: paths.workDir, stdio: ["pipe", "pipe", "pipe"], detached: true },
      );
      const timer = setTimeout(() => finish({ ok: false, error: "Codex 运行超时" }, true), timeoutMs);

      child.on("error", (e: NodeJS.ErrnoException) => {
        finish({ ok: false, error: e.code === "ENOENT" ? "找不到 codex 命令，请先安装 Codex CLI" : `无法启动 Codex：${e.message}` });
      });
      child.stdin.on("error", () => {
        // child may exit before reading the prompt
      });
      child.stdin.end(task.prompt);

      const handleLine = (line: string) => {
        const ev = parseCodexLine(line);
        if (!ev || settled) return;
        if (ev.kind === "agent_message") {
          lastMessage = ev.text;
          onEvent({ type: "agent_message", text: ev.text });
        } else if (ev.kind === "mcp_call" && ev.server !== "room") {
          finish({ ok: false, error: `Agent 调用了 Room 以外的 MCP server：${ev.server}` }, true);
        }
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          handleLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on("data", (d: string) => {
        stderr += d;
        if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
      });

      child.on("close", (code) => {
        exited = true;
        killTree(); // reap any stragglers left in the group
        if (buf.trim()) handleLine(buf);
        if (settled) return;
        if (code !== 0) {
          const tail = stderr.trimEnd().split("\n").slice(-20).join("\n");
          return finish({ ok: false, error: `Codex 退出码 ${code}：${tail}` });
        }
        let reply = "";
        try {
          reply = readFileSync(lastFile, "utf8").trim();
        } catch {
          // no -o file written
        }
        if (!reply) reply = lastMessage.trim();
        finish(reply ? { ok: true, reply } : { ok: false, error: "Agent 没有返回回复" });
      });
    });
  }
}
