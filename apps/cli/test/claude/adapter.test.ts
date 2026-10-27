import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { TaskAssign, TaskEvent } from "@nema/shared";
import { CLAUDE_ROOM_TOOLS } from "../../src/claude/launch.js";
import { ClaudeCodeAdapter } from "../../src/claude/adapter.js";
import { claudeTokenPath, saveClaudeToken } from "../../src/claude/token.js";
import { saveConfig } from "../../src/config.js";
import type { AgentResult } from "../../src/daemon/runner.js";
import { Runner } from "../../src/daemon/runner.js";

const TOKEN = "sekret-token";
const NOT_FOUND = "找不到 claude。请先安装 Claude Code 并把它放到 PATH 上。";
const TOOL_LIMIT = "Claude 工具调用超过 60 次，任务已中止。";
const TIMED_OUT = "Claude 运行超过 10 分钟，任务已中止。";
const RUN_FAILED = "Claude 运行失败，任务已中止。";
const NO_INIT = "Claude 没有给出工具面就退出了。";
const LOGIN_FAILED = "Claude 登录失败。请重新运行 claude setup-token，再把令牌从标准输入交给 nema auth claude。";

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const control = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), "control.json"), "utf8"));
fs.writeFileSync(control.argvFile, JSON.stringify({ argv: process.argv, cwd: process.cwd(), env: process.env }));
if (control.childPidFile) {
  const { spawn } = require("node:child_process");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(function () {}, 1 << 30)"], { stdio: "ignore" });
  fs.writeFileSync(control.childPidFile, String(sleeper.pid));
}
function emit(lines) {
  if (!lines || lines.length === 0) return;
  fs.writeSync(1, lines.join("\\n") + "\\n");
}
if (typeof control.stderr === "string" && control.stderr) fs.writeSync(2, control.stderr);
if (control.mode === "exit") process.exit(0);
if (control.mode === "hang") {
  emit(control.lines);
  setInterval(function () {}, 1 << 30);
} else {
  const chunks = [];
  process.stdin.on("data", function (chunk) { chunks.push(chunk); });
  process.stdin.on("end", function () {
    if (control.stdinFile) fs.writeFileSync(control.stdinFile, Buffer.concat(chunks));
    emit(control.lines);
    process.exit(0);
  });
}
`;

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-claude-adapter-test-"));
  home = join(root, "nema");
  saveClaudeToken(home, TOKEN);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

class DirectStub {
  readonly name = "codex-direct";
  runs = 0;
  async run(): Promise<AgentResult> {
    this.runs += 1;
    return { ok: false, error: "codex-direct stub" };
  }
}

function task(taskId: string, prompt: string, confidential = false): TaskAssign {
  return {
    type: "task.assign",
    taskId,
    workspaceId: "ws",
    adapter: "auto",
    confidential,
    prompt,
    runToken: "run-token",
    hubUrl: "http://127.0.0.1:4010",
    pluginTools: [],
  };
}

function roomInit(): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    tools: [...CLAUDE_ROOM_TOOLS],
    mcp_servers: [{ name: "room", status: "connected" }],
  });
}

function toolLine(name: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input: {} }] } });
}

function textLine(text: string): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
}

function resultLine(text: string): string {
  return JSON.stringify({ type: "result", result: text });
}

function installFake(control: {
  mode: "lines" | "hang" | "exit";
  lines?: string[];
  argvFile: string;
  stdinFile?: string;
  childPidFile?: string;
  stderr?: string;
}): string {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "claude");
  writeFileSync(bin, FAKE_CLAUDE);
  chmodSync(bin, 0o755);
  writeFileSync(join(binDir, "control.json"), JSON.stringify(control));
  return bin;
}

function createAdapter(claudeBin: string, timeoutMs?: number): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    nemaHome: home,
    cliEntry: join(root, "cli-entry.js"),
    claudeBin,
    parentEnv: {
      PATH: process.env.PATH,
      LANG: "en_US.UTF-8",
      NEMA_RUN_TOKEN: "leak",
      AWS_SECRET_ACCESS_KEY: "sekret",
    },
    execPath: process.execPath,
    timeoutMs,
  });
}

async function runTask(adapter: ClaudeCodeAdapter, assigned: TaskAssign) {
  const direct = new DirectStub();
  const events: TaskEvent[] = [];
  const runner = new Runner([direct, adapter], () => ({
    adapter: "claude-code",
    reasoningEffort: "medium",
    authMode: "siwc",
  }));
  const result = await new Promise<AgentResult>((resolve) => {
    runner.enqueue(assigned, (event) => events.push(event), resolve);
  });
  return { result, events, runs: direct.runs, names: runner.adapterNames };
}

describe("ClaudeCodeAdapter", () => {
  test("init listing exactly the room tools plus the task's plugin tools passes", async () => {
    const assigned = task("task-plugin-ok", "tidy-plugin");
    assigned.pluginTools = [{ name: "code__read", description: "Read a file", parameters: { type: "object" } }];
    const argvFile = join(root, "argv-plugin-ok.json");
    const bin = installFake({
      mode: "lines",
      argvFile,
      lines: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          tools: [...CLAUDE_ROOM_TOOLS, "mcp__room__code__read"],
          mcp_servers: [{ name: "room", status: "connected" }],
        }),
        toolLine("mcp__room__code__read"),
        resultLine("读完了"),
      ],
    });

    const { result, events, runs } = await runTask(createAdapter(bin), assigned);
    expect(runs).toBe(0);
    expect(result).toEqual({ ok: true, reply: "读完了" });
    expect(events).toContainEqual({ type: "tool_call", text: "mcp__room__code__read" });
    const recorded = JSON.parse(readFileSync(argvFile, "utf8")) as { argv: string[] };
    expect(recorded.argv[recorded.argv.indexOf("--allowedTools") + 1]?.split(",")).toEqual([
      ...CLAUDE_ROOM_TOOLS,
      "mcp__room__code__read",
    ]);
    expect(recorded.argv[recorded.argv.indexOf("--tools") + 1]).toBe("");
  });

  test("init listing a plugin tool not in the task's list fails the run", async () => {
    const assigned = task("task-plugin-bad", "tidy-plugin-bad");
    assigned.pluginTools = [{ name: "code__read", description: "Read a file", parameters: { type: "object" } }];
    const bin = installFake({
      mode: "lines",
      argvFile: join(root, "argv-plugin-bad.json"),
      lines: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          tools: [...CLAUDE_ROOM_TOOLS, "mcp__room__code__search"],
          mcp_servers: [{ name: "room", status: "connected" }],
        }),
        resultLine("should-not-stick"),
      ],
    });

    const { result, runs } = await runTask(createAdapter(bin), assigned);

    expect(runs).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("工具面");
    expect(existsSync(join(home, "run", assigned.taskId))).toBe(false);
  });

  test("a failed room server fails the task", async () => {
    const assigned = task("task-room-failed", "tidy-room-failed");
    const bin = installFake({
      mode: "lines",
      argvFile: join(root, "argv-room-failed.json"),
      lines: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          tools: [...CLAUDE_ROOM_TOOLS],
          mcp_servers: [{ name: "room", status: "failed" }],
        }),
        resultLine("should-not-stick"),
      ],
    });

    const { result, runs } = await runTask(createAdapter(bin), assigned);

    expect(runs).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("工具面");
  });

  test("rejects an init that includes Bash and does not call codex-direct", async () => {
    const assigned = task("task-bad-init", "tidy-bad-init");
    const bin = installFake({
      mode: "lines",
      argvFile: join(root, "argv.json"),
      lines: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          tools: [...CLAUDE_ROOM_TOOLS, "Bash"],
          mcp_servers: [{ name: "room", status: "connected" }],
        }),
      ],
    });

    const { result, runs, names } = await runTask(createAdapter(bin), assigned);

    expect(names).toEqual(["codex-direct", "claude-code"]);
    expect(runs).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("工具面");
    expect(existsSync(join(home, "run", assigned.taskId))).toBe(false);
  });

  test("rejects a Bash tool call and does not keep a later result", async () => {
    const bin = installFake({
      mode: "lines",
      argvFile: join(root, "argv.json"),
      lines: [roomInit(), toolLine("Bash"), resultLine("should-not-stick")],
    });

    const { result, runs } = await runTask(createAdapter(bin), task("task-bad-tool", "tidy-bad-tool"));

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: "Claude 调用了 Room 以外的工具 Bash，任务已中止。" });
  });

  test("fails when Claude exits before init without leaking the token or prompt", async () => {
    const assigned = task("task-no-init", "prompt-not-in-error");
    const bin = installFake({ mode: "exit", argvFile: join(root, "argv.json") });

    const { result, runs } = await runTask(createAdapter(bin), assigned);

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: NO_INIT });
    if (result.ok) return;
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).not.toContain(assigned.prompt);
    expect(result.error).not.toContain("run-token");
  });

  test("reports a rejected setup token as login failure and does not keep stderr", async () => {
    const stderrLine = "authentication failed: sekret-token";
    const bin = installFake({
      mode: "exit",
      argvFile: join(root, "argv.json"),
      stderr: stderrLine,
    });

    const { result, runs } = await runTask(createAdapter(bin), task("task-auth", "prompt-not-in-error"));

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: LOGIN_FAILED });
    if (result.ok) return;
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).not.toContain(stderrLine);
  });

  test("fails an error_max_turns result and does not keep the result text", async () => {
    const bin = installFake({
      mode: "lines",
      argvFile: join(root, "argv.json"),
      lines: [
        roomInit(),
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          result: "should-not-stick",
        }),
      ],
    });

    const { result, runs } = await runTask(createAdapter(bin), task("task-error-result", "prompt-not-in-error"));

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: RUN_FAILED });
    if (result.ok) return;
    expect(result.error).not.toContain("should-not-stick");
  });

  test("returns the Room result for a normal and a confidential task", async () => {
    const prompt = "tidy-this-room-prompt";
    const stdinFile = join(root, "stdin.txt");
    const argvFile = join(root, "argv.json");
    const bin = installFake({
      mode: "lines",
      argvFile,
      stdinFile,
      lines: [roomInit(), textLine("looking"), resultLine("整理好了")],
    });
    saveConfig(home, { model: "sonnet" });
    const tokenPath = claudeTokenPath(home);

    for (const confidential of [false, true]) {
      const before = readFileSync(tokenPath);
      const assigned = task("task-ok", prompt, confidential);
      const { result, events, runs } = await runTask(createAdapter(bin), assigned);

      expect(runs).toBe(0);
      expect(result).toEqual({ ok: true, reply: "整理好了" });
      expect(events).toEqual([{ type: "progress", text: "looking" }]);
      const stdin = readFileSync(stdinFile, "utf8");
      expect(stdin).toContain(prompt);
      expect(JSON.parse(stdin)).toEqual({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      });
      expect(readFileSync(tokenPath)).toEqual(before);
      expect(existsSync(join(home, "run", assigned.taskId))).toBe(false);

      const recorded = JSON.parse(readFileSync(argvFile, "utf8")) as { argv: string[]; cwd: string; env: NodeJS.ProcessEnv };
      expect(recorded.argv).not.toContain("--permission-mode");
      expect(recorded.argv).toContain("--model");
      expect(recorded.argv).toContain("sonnet");
      expect(recorded.argv.join("\0")).not.toContain(TOKEN);
      expect(recorded.argv.join("\0")).not.toContain(prompt);
      expect(recorded.cwd).toBe(join(realpathSync(home), "run", assigned.taskId, "work"));
      expect(recorded.env.HOME).toBe(join(home, "run", assigned.taskId, "claude-config"));
      expect(recorded.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect(recorded.env.NEMA_RUN_TOKEN).toBeUndefined();
      expect(recorded.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    }
  });

  test("stops after 60 Room tool calls", async () => {
    const bin = installFake({
      mode: "lines",
      argvFile: join(root, "argv.json"),
      lines: [roomInit(), ...Array.from({ length: 61 }, () => toolLine(CLAUDE_ROOM_TOOLS[0]))],
    });

    const { result, events, runs } = await runTask(createAdapter(bin), task("task-tools", "tidy-tools"));

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: TOOL_LIMIT });
    expect(events).toEqual(Array.from({ length: 60 }, () => ({ type: "tool_call", text: CLAUDE_ROOM_TOOLS[0] })));
  });

  test("claude gets --max-turns 48 for a workpackage task and takes the tool cap from its limits", async () => {
    const argvFile = join(root, "argv-limits.json");
    const bin = installFake({
      mode: "lines",
      argvFile,
      lines: [roomInit(), ...Array.from({ length: 4 }, () => toolLine(CLAUDE_ROOM_TOOLS[0]))],
    });
    const assigned = { ...task("task-wp", "write-wp"), limits: { maxModelCalls: 48, maxToolCalls: 3, timeoutMs: 1_200_000 } };

    const { result, events } = await runTask(createAdapter(bin), assigned);

    const recorded = JSON.parse(readFileSync(argvFile, "utf8")) as { argv: string[] };
    expect(recorded.argv[recorded.argv.indexOf("--max-turns") + 1]).toBe("48");
    expect(result).toEqual({ ok: false, error: "Claude 工具调用超过 3 次，任务已中止。" });
    expect(events.length).toBe(3);
  });

  test("counts each parallel Room tool call toward the 60 limit", async () => {
    const parallel = (n: number) =>
      JSON.stringify({
        type: "assistant",
        message: {
          content: Array.from({ length: n }, () => ({ type: "tool_use", name: CLAUDE_ROOM_TOOLS[2], input: {} })),
        },
      });
    const bin = installFake({
      mode: "lines",
      argvFile: join(root, "argv.json"),
      lines: [roomInit(), ...Array.from({ length: 12 }, () => parallel(5)), parallel(5), resultLine("should-not-stick")],
    });

    const { result, events, runs } = await runTask(createAdapter(bin), task("task-parallel", "tidy-parallel"));

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: TOOL_LIMIT });
    expect(events).toEqual(Array.from({ length: 60 }, () => ({ type: "tool_call", text: CLAUDE_ROOM_TOOLS[2] })));
  });

  test("stops a hung Claude with the 10 minute message when the clock is shortened", async () => {
    const bin = installFake({
      mode: "hang",
      argvFile: join(root, "argv.json"),
      lines: [roomInit()],
    });

    const { result, runs } = await runTask(createAdapter(bin, 50), task("task-hang", "tidy-hang"));

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: TIMED_OUT });
  });

  test("owner cancellation kills an active fake Claude child and waits for its close", async () => {
    const childPidFile = join(root, "cancel-child.pid");
    const bin = installFake({ mode: "hang", argvFile: join(root, "argv-cancel.json"), childPidFile, lines: [roomInit()] });
    const controller = new AbortController();
    const adapter = createAdapter(bin);
    const pending = adapter.run(task("task-cancel", "tidy-cancel"), () => {}, controller.signal);
    await vi.waitFor(() => expect(existsSync(childPidFile)).toBe(true));
    const pid = Number(readFileSync(childPidFile, "utf8"));
    controller.abort(new Error("owner stopped"));
    await pending;
    // The pid file is a grandchild. Group SIGKILL can reap the parent before that child is gone.
    try {
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    expect(existsSync(join(home, "run", "task-cancel"))).toBe(false);
  });

  test("kills Claude's process group on failure and on success", async () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const stop = async (pidFile: string) => {
      const pid = Number(readFileSync(pidFile, "utf8"));
      try {
        await vi.waitFor(() => expect(alive(pid)).toBe(false));
      } finally {
        if (!alive(pid)) return;
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    };

    const failurePid = join(root, "failure-child.pid");
    const failureBin = installFake({
      mode: "lines",
      argvFile: join(root, "argv-failure.json"),
      childPidFile: failurePid,
      lines: [
        JSON.stringify({
          type: "system",
          subtype: "init",
          tools: [...CLAUDE_ROOM_TOOLS, "Bash"],
          mcp_servers: [{ name: "room", status: "connected" }],
        }),
      ],
    });
    const failed = await runTask(createAdapter(failureBin), task("task-kill-fail", "tidy-kill-fail"));
    expect(failed.result.ok).toBe(false);
    if (!failed.result.ok) expect(failed.result.error).toContain("工具面");
    await stop(failurePid);

    const successPid = join(root, "success-child.pid");
    const successBin = installFake({
      mode: "lines",
      argvFile: join(root, "argv-success.json"),
      childPidFile: successPid,
      lines: [roomInit(), resultLine("整理好了")],
    });
    const succeeded = await runTask(createAdapter(successBin), task("task-kill-ok", "tidy-kill-ok"));
    expect(succeeded.result).toEqual({ ok: true, reply: "整理好了" });
    await stop(successPid);
  });

  test("reports a missing claude binary", async () => {
    const assigned = task("task-missing", "tidy-missing");
    const { result, runs } = await runTask(createAdapter(join(root, "missing-claude")), assigned);

    expect(runs).toBe(0);
    expect(result).toEqual({ ok: false, error: NOT_FOUND });
    expect(existsSync(join(home, "run", assigned.taskId))).toBe(false);
    expect(readFileSync(claudeTokenPath(home), "utf8")).toBe(TOKEN);
  });
});
