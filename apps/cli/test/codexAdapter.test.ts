import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { TaskAssign } from "@nema/shared";
import { CodexAdapter } from "../src/codex/adapter.js";

const fake = resolve(import.meta.dirname, "fixtures/fake-codex.mjs");
let root: string, userHome: string, nemaHome: string, dump: string;

const task: TaskAssign = { type: "task.assign", taskId: "t1", workspaceId: "ws_a", adapter: "codex-cli", confidential: false, prompt: "请整理需求 R-1", runToken: "tok", hubUrl: "http://127.0.0.1:9", pluginTools: [] };
// The adapter hands Codex a whitelisted env, so the fake's mode/dump path travel via a per-test wrapper script.
let wrapper = "";
const adapter = (o: Partial<ConstructorParameters<typeof CodexAdapter>[0]> = {}) =>
  new CodexAdapter({ codexBin: wrapper, nemaHome, userCodexHome: userHome, cliEntry: "/abs/dist/index.js", ...o });
const mode = (m: string) => {
  wrapper = join(root, "codex-wrapper.sh");
  writeFileSync(wrapper, `#!/bin/sh\nFAKE_CODEX_MODE=${m} FAKE_CODEX_DUMP=${dump} exec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-adapter-test-"));
  userHome = join(root, "user-codex");
  nemaHome = join(root, "nema");
  mkdirSync(userHome); mkdirSync(nemaHome);
  writeFileSync(join(userHome, "auth.json"), '{"token":"secret"}', { mode: 0o600 });
  dump = join(root, "dump.json");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The CLI adapter is retired. Its fixtures run Codex through a /bin/sh wrapper and its isolation links auth.json
// with a file symlink (privileged on Windows), so these tests are POSIX-only. They prove the legacy adapter,
// not Windows: the active direct adapter has its own native tests (test/direct).
const posixTest = test.runIf(process.platform !== "win32");

describe("CodexAdapter", () => {
  test("name is codex-cli", () => {
    expect(adapter().name).toBe("codex-cli");
  });

  test("refuses confidential tasks before touching Codex, auth or isolation", async () => {
    mode("ok");
    const r = await adapter().run({ ...task, confidential: true }, () => {});
    expect(r).toEqual({
      ok: false,
      error: "codex-cli 适配器在保密 workspace 中被禁用（隔离未通过验证）。请改用 codex-direct：nema config set adapter codex-direct，或在 workspace 设置中关闭保密。",
    });
    expect(existsSync(dump)).toBe(false);
    expect(existsSync(join(nemaHome, "ws"))).toBe(false);
  });

  posixTest("ok: reply from -o file, argv/env/stdin, workDir cleaned, events emitted", async () => {
    mode("ok");
    const events: unknown[] = [];
    const r = await adapter().run(task, (e) => events.push(e));
    expect(r).toEqual({ ok: true, reply: "已更新：需求 R-1" });
    expect(events).toContainEqual({ type: "agent_message", text: "ok" });
    const d = JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; envKeys: string[]; stdin: string };
    expect(d.argv).toEqual(expect.arrayContaining(["--json", "--ephemeral", "--skip-git-repo-check"]));
    const wd = d.argv[d.argv.indexOf("-C") + 1]!;
    expect(d.argv.slice(-1)).toEqual(["-"]);
    expect(d.argv[d.argv.indexOf("-o") + 1]).toBe(join(wd, "last.txt"));
    expect(d.stdin).toBe(task.prompt);
    const allowed = new Set(["PATH", "LANG", "LC_ALL", "TERM", "HOME", "CODEX_HOME", "TMPDIR"]);
    // the /bin/sh wrapper itself injects PWD/SHLVL/_/__CF_USER_TEXT_ENCODING; everything else must be whitelisted
    const keys = d.envKeys.filter((k) => !["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(k));
    expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
    expect(d.envKeys).toEqual(expect.arrayContaining(["HOME", "CODEX_HOME", "TMPDIR"]));
    expect(existsSync(wd)).toBe(false);
  });

  posixTest("exit1", async () => {
    mode("exit1");
    const r = await adapter().run(task, () => {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("Codex 退出码 1");
    expect((r as { error: string }).error).toContain("boom");
  });

  posixTest("badjson", async () => {
    mode("badjson");
    expect(await adapter().run(task, () => {})).toEqual({ ok: false, error: "Agent 没有返回回复" });
  });

  posixTest("foreign mcp server kills the process", async () => {
    mode("foreign-mcp");
    const r = await adapter().run(task, () => {});
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("github");
    const pid = Number(readFileSync(dump + ".pid", "utf8"));
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  const dead = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const waitFor = async (cond: () => boolean, ms = 2000) => {
    for (const end = Date.now() + ms; Date.now() < end && !cond(); ) await new Promise((r) => setTimeout(r, 20));
    return cond();
  };
  posixTest.each([["grandchild-hang", { timeoutMs: 2000 }], ["grandchild-foreign", {}]] as const)("%s: whole process tree is killed", async (m, o) => {
    mode(m);
    const r = await adapter(o).run(task, () => {});
    expect(r.ok).toBe(false);
    expect(await waitFor(() => existsSync(dump + ".gcpid"))).toBe(true);
    const gc = Number(readFileSync(dump + ".gcpid", "utf8"));
    expect(await waitFor(() => dead(gc))).toBe(true);
  });

  posixTest("multi-byte text split across stdout chunks arrives intact", async () => {
    mode("utf8-split");
    const events: { text: string }[] = [];
    const r = await adapter().run(task, (e) => events.push(e as { text: string }));
    expect(events.map((e) => e.text)).toEqual(["已更新：需求"]);
    expect(r).toEqual({ ok: true, reply: "已更新：需求" });
  });

  posixTest("hang times out", async () => {
    mode("hang");
    expect(await adapter({ timeoutMs: 200 }).run(task, () => {})).toEqual({ ok: false, error: "Codex 运行超时" });
  });

  posixTest("missing codex binary", async () => {
    mode("ok");
    const r = await adapter({ codexBin: join(root, "nope") }).run(task, () => {});
    expect((r as { error: string }).error).toContain("找不到 codex 命令");
  });

  test("missing auth.json: fake never started", async () => {
    mode("ok");
    rmSync(join(userHome, "auth.json"));
    const r = await adapter().run(task, () => {});
    expect((r as { error: string }).error).toContain("codex login");
    expect(existsSync(dump)).toBe(false);
  });

  posixTest("auth.json replaced by a regular file is moved back and re-linked", async () => {
    mode("replace-auth");
    const r = await adapter().run(task, () => {});
    expect(r.ok).toBe(true);
    const target = join(userHome, "auth.json");
    expect(readFileSync(target, "utf8")).toBe('{"token":"refreshed"}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    const link = join(nemaHome, "ws", "ws_a", "codex-home", "auth.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});
