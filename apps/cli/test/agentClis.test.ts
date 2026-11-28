// The `--version` executor split, the ENOENT PATH lookup, and the readiness-only cache (#302 D-4, D-7).
// Fake runners and temporary PATH directories only: nothing here launches a real agent CLI.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  VersionProbe,
  classifyVersion,
  commandOnSearchPath,
  detectAgentClis,
  executeVersion,
  runVersion,
  type VersionResult,
} from "../src/agentClis.js";
import { commandPathCandidates } from "../src/platform.js";
import { canSymlinkFiles } from "./links.js";

const enoent = () => Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
// What execFile rejects with when its `timeout` fires: the child was killed by the default signal.
const timedOut = () => Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", code: null });
const nonZero = () => Object.assign(new Error("Command failed: claude --version"), { code: 1, killed: false, signal: null });
// What `commandSpec` throws on Windows for a shim it cannot read (platform.ts).
const badShim = () => new Error("Unsupported command shim: claude.cmd; install a native executable or a standard npm shim.");

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "nema-agent-clis-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("executeVersion splits the outcome", () => {
  test("a version answer is ok, first line trimmed", async () => {
    expect(await executeVersion(async () => "  2.1.400 (Claude Code)\nextra\n")("claude")).toEqual({ kind: "ok", version: "2.1.400 (Claude Code)" });
  });
  test("an empty answer is ok with no version", async () => {
    expect(await executeVersion(async () => "\n")("claude")).toEqual({ kind: "ok", version: null });
  });
  test("ENOENT, timeout and other failures are told apart", async () => {
    expect(await executeVersion(async () => { throw enoent(); })("claude")).toEqual({ kind: "enoent" });
    expect(await executeVersion(async () => { throw timedOut(); })("claude")).toEqual({ kind: "timeout" });
    expect(await executeVersion(async () => { throw nonZero(); })("claude")).toEqual({ kind: "error" });
    expect(await executeVersion(async () => { throw badShim(); })("claude")).toEqual({ kind: "error" });
  });
});

describe("runVersion: the deadline bounds the wait without changing a successful exit", () => {
  // Synthetic node children, not agent CLIs; the timeout is shortened to 500ms through runVersion's
  // second parameter (long enough for a node child to start under load) so these cases do not wait
  // out the real 10s probe timeout.
  // Node documents that ChildProcess.kill('SIGTERM') force-terminates the process on Windows, so a
  // handler that runs on the signal can never execute there; these cases only run on POSIX.
  test.runIf(process.platform !== "win32")("a child that traps SIGTERM and exits 0 after the timer fired is still ok (D-7: base execFile behavior)", async () => {
    const script = path.join(root, "trap-sigterm.cjs");
    writeFileSync(script, "process.on('SIGTERM', () => process.exit(0));\nsetTimeout(() => {}, 5000);\n");
    await expect(executeVersion((command) => runVersion(command, 500))(script)).resolves.toEqual({ kind: "ok", version: null });
  });
  test("a child that traps SIGTERM and exits non-zero after the timer fired is a timeout", async () => {
    const script = path.join(root, "trap-sigterm-7.cjs");
    writeFileSync(script, "process.on('SIGTERM', () => process.exit(7));\nsetTimeout(() => {}, 5000);\n");
    await expect(executeVersion((command) => runVersion(command, 500))(script)).resolves.toEqual({ kind: "timeout" });
  });
  test("a child that ignores SIGTERM is a timeout within the kill grace", async () => {
    const script = path.join(root, "ignore-sigterm.cjs");
    writeFileSync(script, "process.on('SIGTERM', () => {});\nsetTimeout(() => process.exit(0), 5000);\n");
    const start = Date.now();
    await expect(executeVersion((command) => runVersion(command, 500))(script)).resolves.toEqual({ kind: "timeout" });
    // Deadline 500ms plus the 250ms SIGKILL grace; 2s leaves room for a loaded machine.
    expect(Date.now() - start).toBeLessThan(2000);
  });
  test("a child that exits 0 before the timer is still ok", async () => {
    const script = path.join(root, "fast.cjs");
    writeFileSync(script, "process.stdout.write('9.9.9\\n');\n");
    await expect(executeVersion((command) => runVersion(command, 500))(script)).resolves.toEqual({ kind: "ok", version: "9.9.9" });
  });
  // A descendant that inherits stdout/stderr holds execFile's callback open until it exits, so the
  // probe must settle on the direct child's exit (or the kill grace), not on the pipes closing.
  // The grandchild lives 5s: without the bound the probe would take ~5s, not ~750ms.
  test.runIf(process.platform !== "win32")("a child that ignores SIGTERM is a timeout within the kill grace even when a descendant holds the pipes", async () => {
    const script = path.join(root, "launcher-ignore.cjs");
    writeFileSync(
      script,
      "const { spawn } = require('node:child_process');\n" +
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit' });\n" +
        "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 5000);\n",
    );
    const start = Date.now();
    await expect(executeVersion((command) => runVersion(command, 500))(script)).resolves.toEqual({ kind: "timeout" });
    expect(Date.now() - start).toBeLessThan(2000);
  });
  test.runIf(process.platform !== "win32")("a child that exits 0 on SIGTERM is still ok even when a descendant holds the pipes", async () => {
    const script = path.join(root, "launcher-trap.cjs");
    writeFileSync(
      script,
      "const { spawn } = require('node:child_process');\n" +
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit' });\n" +
        "process.stdout.write('9.9.9\\n');\n" +
        "process.on('SIGTERM', () => process.exit(0));\nsetTimeout(() => {}, 5000);\n",
    );
    const start = Date.now();
    await expect(executeVersion((command) => runVersion(command, 500))(script)).resolves.toEqual({ kind: "ok", version: "9.9.9" });
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("detectAgentClis keeps its mapping (D-7 regression)", () => {
  test.each([
    ["ENOENT", enoent],
    ["a timeout", timedOut],
    ["a non-zero exit", nonZero],
    ["an unreadable Windows shim", badShim],
  ])("%s is still installed: false with no version", async (_label, failure) => {
    const agents = await detectAgentClis(async (command) => {
      if (command === "claude") throw failure();
      return "codex-cli 0.99.0\n";
    });
    expect(agents).toEqual([
      { id: "codex", command: "codex", installed: true, version: "codex-cli 0.99.0", installUrl: "https://developers.openai.com/codex/cli" },
      { id: "claude-code", command: "claude", installed: false, version: null, installUrl: "https://code.claude.com/docs/en/setup" },
    ]);
  });
  test("runs every time: no cache on the components page path", async () => {
    let calls = 0;
    const run = async () => { calls++; return "1.0.0"; };
    await detectAgentClis(run);
    await detectAgentClis(run);
    expect(calls).toBe(4);
  });
});

describe("commandPathCandidates follows commandSpec's lookup rules", () => {
  test("POSIX: each PATH directory, no extensions", () => {
    expect(commandPathCandidates("claude", { PATH: "/a:/b" }, "linux")).toEqual(["/a/claude", "/b/claude"]);
  });
  test("POSIX: an empty PATH entry means the current directory", () => {
    expect(commandPathCandidates("claude", { PATH: ":/usr/bin" }, "linux")).toEqual(["./claude", "/usr/bin/claude"]);
  });
  test("POSIX: a command with a directory part is the only candidate", () => {
    expect(commandPathCandidates("./bin/claude", { PATH: "/a" }, "darwin")).toEqual(["./bin/claude"]);
  });
  test("POSIX: a PATH entry with .. keeps its segments (the kernel resolves them)", () => {
    expect(commandPathCandidates("claude", { PATH: "/a/b/../c" }, "linux")).toEqual(["/a/b/../c/claude"]);
  });
  test("Windows: case-insensitive Path, the same extension order as commandSpec", () => {
    expect(commandPathCandidates("claude", { Path: "C:\\a" }, "win32")).toEqual(
      [".exe", ".com", ".cmd", ".bat", ""].map((ext) => path.win32.join("C:\\a", `claude${ext}`)),
    );
  });
  test("Windows: a name with an extension is not extended", () => {
    expect(commandPathCandidates("claude.exe", { PATH: "C:\\a" }, "win32")).toEqual([path.win32.join("C:\\a", "claude.exe")]);
  });
});

describe("commandOnSearchPath only looks at directory entries", () => {
  test("no entry anywhere on PATH", () => {
    expect(commandOnSearchPath("claude", { PATH: [path.join(root, "a"), path.join(root, "b")].join(path.delimiter) })).toBe(false);
  });
  test("a regular entry is found without being executed", () => {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin", process.platform === "win32" ? "claude.cmd" : "claude"), "not a program");
    expect(commandOnSearchPath("claude", { PATH: path.join(root, "bin") })).toBe(true);
  });
  test.runIf(canSymlinkFiles && process.platform !== "win32")("a dangling link is found: lstat, not stat", () => {
    mkdirSync(path.join(root, "bin"));
    symlinkSync(path.join(root, "gone", "claude.js"), path.join(root, "bin", "claude"));
    expect(commandOnSearchPath("claude", { PATH: path.join(root, "bin") })).toBe(true);
  });
  test.runIf(canSymlinkFiles && process.platform !== "win32")("an empty PATH entry looks in the current directory", () => {
    symlinkSync(path.join(root, "gone"), path.join(root, "claude"));
    const cwd = process.cwd();
    try {
      process.chdir(root);
      expect(commandOnSearchPath("claude", { PATH: `:${path.join(root, "bin")}` })).toBe(true);
    } finally {
      process.chdir(cwd);
    }
  });
  test.runIf(process.platform !== "win32")("a PATH entry with .. is resolved by the kernel, not normalized", () => {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin", "claude"), "not a program");
    expect(commandOnSearchPath("claude", { PATH: `${path.join(root, "bin")}/nonexistent/..` })).toBe(false);
  });
});

describe("classifyVersion: what readiness sees", () => {
  const env = () => ({ PATH: path.join(root, "bin") });
  test("ok passes the version through", () => {
    expect(classifyVersion("claude", { kind: "ok", version: "2.1.0" }, env())).toEqual({ kind: "ok", version: "2.1.0" });
  });
  test("ENOENT with no PATH entry is not_found", () => {
    expect(classifyVersion("claude", { kind: "enoent" }, env())).toEqual({ kind: "not_found" });
  });
  test.runIf(canSymlinkFiles && process.platform !== "win32")("ENOENT with a dangling link on PATH is broken", () => {
    mkdirSync(path.join(root, "bin"));
    symlinkSync(path.join(root, "gone"), path.join(root, "bin", "claude"));
    expect(classifyVersion("claude", { kind: "enoent" }, env())).toEqual({ kind: "broken" });
  });
  test("timeout and other failures pass through", () => {
    expect(classifyVersion("claude", { kind: "timeout" }, env())).toEqual({ kind: "timeout" });
    expect(classifyVersion("claude", { kind: "error" }, env())).toEqual({ kind: "error" });
  });
});

/** A runner whose answers the test releases one by one, in any order. */
function controlledRunner() {
  const pending: Array<{ command: string; settle: (r: VersionResult) => void }> = [];
  const run = (command: string) => new Promise<VersionResult>((resolve) => pending.push({ command, settle: resolve }));
  return { run, pending };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("VersionProbe: cache and concurrency (readiness only)", () => {
  test("an ok answer is cached for 30 seconds, then probed again", async () => {
    let t = 1_000;
    let calls = 0;
    const probe = new VersionProbe({ execute: async () => { calls++; return { kind: "ok", version: `v${calls}` }; }, now: () => t });
    expect(await probe.version("claude")).toEqual({ kind: "ok", version: "v1" });
    t += 29_999;
    expect(await probe.version("claude")).toEqual({ kind: "ok", version: "v1" });
    expect(calls).toBe(1);
    t += 1;
    expect(await probe.version("claude")).toEqual({ kind: "ok", version: "v2" });
    expect(calls).toBe(2);
  });

  test.each<VersionResult>([{ kind: "enoent" }, { kind: "timeout" }, { kind: "error" }])("a %o answer is never cached", async (failure) => {
    let calls = 0;
    const probe = new VersionProbe({ execute: async () => { calls++; return failure; }, now: () => 0 });
    await probe.version("claude");
    await probe.version("claude");
    expect(calls).toBe(2);
  });

  test("the cache is per command", async () => {
    const seen: string[] = [];
    const probe = new VersionProbe({ execute: async (c) => { seen.push(c); return { kind: "ok", version: c }; }, now: () => 0 });
    await probe.version("claude");
    await probe.version("codex");
    await probe.version("claude");
    expect(seen).toEqual(["claude", "codex"]);
  });

  test("ordinary requests share the in-flight probe", async () => {
    const { run, pending } = controlledRunner();
    const probe = new VersionProbe({ execute: run, now: () => 0 });
    const a = probe.version("claude");
    const b = probe.version("claude");
    await flush();
    expect(pending).toHaveLength(1);
    pending[0]!.settle({ kind: "ok", version: "1" });
    expect(await a).toEqual({ kind: "ok", version: "1" });
    expect(await b).toEqual({ kind: "ok", version: "1" });
  });

  test("force skips the cache and clears it at once", async () => {
    let n = 0;
    const probe = new VersionProbe({ execute: async () => ({ kind: "ok", version: String(++n) }), now: () => 0 });
    await probe.version("claude");
    expect(await probe.version("claude", { force: true })).toEqual({ kind: "ok", version: "2" });
    expect(n).toBe(2);
  });

  test("an older probe answering after a force cannot write the cache", async () => {
    const { run, pending } = controlledRunner();
    const probe = new VersionProbe({ execute: run, now: () => 0 });
    const old = probe.version("claude");
    await flush();
    const forced = probe.version("claude", { force: true });
    await flush();
    expect(pending).toHaveLength(2);
    // The forced probe fails; the old one answers ok afterwards.
    pending[1]!.settle({ kind: "enoent" });
    expect(await forced).toEqual({ kind: "enoent" });
    pending[0]!.settle({ kind: "ok", version: "stale" });
    expect(await old).toEqual({ kind: "ok", version: "stale" });
    // Nothing was cached: the next ordinary request probes again.
    const next = probe.version("claude");
    await flush();
    expect(pending).toHaveLength(3);
    pending[2]!.settle({ kind: "ok", version: "fresh" });
    expect(await next).toEqual({ kind: "ok", version: "fresh" });
  });

  test("an ordinary request after a force shares the forced probe, not the older one", async () => {
    const { run, pending } = controlledRunner();
    const probe = new VersionProbe({ execute: run, now: () => 0 });
    void probe.version("claude");
    await flush();
    const forced = probe.version("claude", { force: true });
    const ordinary = probe.version("claude");
    await flush();
    expect(pending).toHaveLength(2);
    pending[1]!.settle({ kind: "ok", version: "new" });
    pending[0]!.settle({ kind: "ok", version: "old" });
    expect(await forced).toEqual({ kind: "ok", version: "new" });
    expect(await ordinary).toEqual({ kind: "ok", version: "new" });
  });

  test("after a failed force the next ordinary request probes again", async () => {
    let answer: VersionResult = { kind: "ok", version: "1" };
    let calls = 0;
    const probe = new VersionProbe({ execute: async () => { calls++; return answer; }, now: () => 0 });
    await probe.version("claude");
    answer = { kind: "timeout" };
    expect(await probe.version("claude", { force: true })).toEqual({ kind: "timeout" });
    answer = { kind: "ok", version: "2" };
    expect(await probe.version("claude")).toEqual({ kind: "ok", version: "2" });
    expect(calls).toBe(3);
  });

  test("an executor that throws counts as an uncached error", async () => {
    let calls = 0;
    const probe = new VersionProbe({ execute: async () => { calls++; throw new Error("boom"); }, now: () => 0 });
    expect(await probe.version("claude")).toEqual({ kind: "error" });
    expect(await probe.version("claude")).toEqual({ kind: "error" });
    expect(calls).toBe(2);
  });
});
