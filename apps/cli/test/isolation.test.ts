import { canSymlinkFiles } from "./links.js";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildEnv, checkCodexAuth, cleanupRun, prepareIsolation, preflight, renderCodexConfig } from "../src/codex/isolation.js";

const mcp = {
  command: "/usr/bin/node",
  args: ["/abs/dist/index.js", "mcp"],
  env: { NEMA_HUB_URL: "http://127.0.0.1:1234", NEMA_RUN_TOKEN: "tok" },
};

// The CLI adapter links the user's auth.json into the isolated home. A file symlink needs privilege on
// Windows (admin or Developer Mode), so these run only where one can be created; a skip is not Windows acceptance.
// The active direct adapter does not use this path.
const linkTest = test.runIf(canSymlinkFiles);

let root: string, userHome: string, nemaHome: string, emptyDir: string;
const runDirs: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-iso-test-"));
  userHome = join(root, "user-codex");
  nemaHome = join(root, "nema");
  emptyDir = join(root, "empty");
  for (const d of [userHome, nemaHome, emptyDir]) mkdirSync(d);
  writeFileSync(join(userHome, "auth.json"), '{"token":"secret"}');
});
afterEach(async () => {
  for (const d of runDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const prep = async (workspaceId = "ws_a", m = mcp) => {
  const p = await prepareIsolation({ nemaHome, workspaceId, userCodexHome: userHome, mcp: m });
  runDirs.push(p.workDir);
  return p;
};

describe("checkCodexAuth", () => {
  test("refuses when auth.json missing or keyring store configured", () => {
    expect(checkCodexAuth(emptyDir)).toMatchObject({ ok: false, error: expect.stringContaining("codex login") });
    expect((checkCodexAuth(emptyDir) as { error: string }).error).toBe(
      `找不到 Codex 登录文件 ${join(emptyDir, "auth.json")}。请先运行 codex login；如果凭证存在系统钥匙串里，请在 ~/.codex/config.toml 设置 cli_auth_credentials_store = "file" 后重新登录。`,
    );
    writeFileSync(join(userHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    expect(checkCodexAuth(userHome)).toMatchObject({ ok: false, error: expect.stringMatching(/^Codex 凭证存放在系统钥匙串中/) });
  });
  test("ok when auth.json present", () => {
    expect(checkCodexAuth(userHome)).toEqual({ ok: true, authPath: join(userHome, "auth.json") });
  });
});

describe("prepareIsolation", () => {
  linkTest("isolated home: symlinked auth, generated config only", async () => {
    writeFileSync(join(userHome, "AGENTS.md"), "user global instructions");
    writeFileSync(join(userHome, "config.toml"), '[mcp_servers.github]\ncommand = "gh-mcp"\n');
    mkdirSync(join(userHome, "memories"));
    writeFileSync(join(userHome, "history.jsonl"), "secret history");
    const p = await prep();
    expect(lstatSync(join(p.codexHome, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(p.codexHome, "auth.json"), "utf8")).toContain("secret");
    for (const f of ["AGENTS.md", "history.jsonl", "memories"]) expect(existsSync(join(p.codexHome, f))).toBe(false);
    const cfg = parseToml(readFileSync(join(p.codexHome, "config.toml"), "utf8")) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual(["room"]);
    expect(cfg).toMatchObject({ sandbox_mode: "read-only", approval_policy: "never", history: { persistence: "none" }, features: { memories: false } });
    expect(statSync(p.wsHome).mode & 0o777).toBe(0o700);
    expect(statSync(p.codexHome).mode & 0o777).toBe(0o700);
    expect(statSync(join(p.codexHome, "config.toml")).mode & 0o777).toBe(0o600);
    expect(p.wsHome).toBe(join(nemaHome, "ws", "ws_a"));
    expect(p.codexHome).toBe(join(p.wsHome, "codex-home"));
    expect(p.tmpDir).toBe(join(p.workDir, ".tmp"));
    expect(existsSync(p.tmpDir)).toBe(true);
    expect(preflight(p)).toEqual({ ok: true });
  });

  linkTest("replaces a regular auth.json file with a symlink and regenerates config each run", async () => {
    const p1 = await prep();
    rmSync(join(p1.codexHome, "auth.json"));
    writeFileSync(join(p1.codexHome, "auth.json"), "stale copy");
    const p2 = await prep("ws_a", { ...mcp, env: { ...mcp.env, NEMA_RUN_TOKEN: "tok2" } });
    expect(lstatSync(join(p2.codexHome, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(p2.codexHome, "config.toml"), "utf8")).toContain("tok2");
    expect(readFileSync(join(p2.codexHome, "config.toml"), "utf8")).not.toContain('"tok"');
  });

  linkTest("workspaces get separate homes", async () => {
    const a = await prep("ws_a");
    const b = await prep("ws_b");
    expect(a.wsHome).not.toBe(b.wsHome);
    expect(a.codexHome).not.toBe(b.codexHome);
    expect(a.workDir).not.toBe(b.workDir);
    writeFileSync(join(a.wsHome, "marker"), "A");
    expect(existsSync(join(b.wsHome, "marker"))).toBe(false);
  });

  test("rejects workspace ids that could escape the ws directory", async () => {
    await expect(prep("../evil")).rejects.toThrow();
  });
});

describe("renderCodexConfig", () => {
  test("values with quotes and backslashes cannot break out of TOML", () => {
    const evil = {
      command: 'C:\\node "x".exe',
      args: ['a"b\\', "mcp"],
      env: { NEMA_HUB_URL: 'http://h/"\n[mcp_servers.evil]\ncommand = "x', NEMA_RUN_TOKEN: 't"\\ok' },
    };
    const cfg = parseToml(renderCodexConfig(evil)) as any;
    expect(Object.keys(cfg.mcp_servers)).toEqual(["room"]);
    expect(cfg.mcp_servers.room.command).toBe(evil.command);
    expect(cfg.mcp_servers.room.args).toEqual(evil.args);
    expect(cfg.mcp_servers.room.env).toEqual(evil.env);
  });
  test("contains the fixed hardening keys", () => {
    expect(parseToml(renderCodexConfig(mcp))).toMatchObject({
      approval_policy: "never",
      sandbox_mode: "read-only",
      web_search: "disabled",
      check_for_update_on_startup: false,
      history: { persistence: "none" },
      features: { memories: false },
      analytics: { enabled: false },
      shell_environment_policy: { inherit: "core" },
      mcp_servers: { room: { default_tools_approval_mode: "approve" } },
    });
  });
});

describe("buildEnv", () => {
  linkTest("env is an allowlist", async () => {
    const p = await prep();
    const env = buildEnv(p, { PATH: "/bin", OPENAI_API_KEY: "sk-x", GITHUB_TOKEN: "g", HOME: "/Users/me", LANG: "ja_JP.UTF-8" });
    expect(Object.keys(env).sort()).toEqual(["CODEX_HOME", "HOME", "LANG", "PATH", "TMPDIR"]);
    expect(env.HOME).toBe(p.wsHome);
    expect(env.CODEX_HOME).toBe(p.codexHome);
    expect(env.TMPDIR).toBe(p.tmpDir);
  });
});

describe("preflight", () => {
  linkTest("reports planted instruction files and extra MCP servers", async () => {
    const p = await prep();
    writeFileSync(join(p.codexHome, "AGENTS.md"), "planted");
    writeFileSync(join(p.codexHome, "config.toml"), '[mcp_servers.room]\ncommand = "x"\n[mcp_servers.github]\ncommand = "y"\n');
    const r = preflight(p);
    expect(r.ok).toBe(false);
    const problems = (r as { problems: string[] }).problems;
    expect(problems.some((s) => s.includes("AGENTS.md"))).toBe(true);
    expect(problems.some((s) => s.includes("mcp_servers"))).toBe(true);
  });
  linkTest("reports auth.json that is not a symlink", async () => {
    const p = await prep();
    rmSync(join(p.codexHome, "auth.json"));
    writeFileSync(join(p.codexHome, "auth.json"), "copy");
    expect(preflight(p)).toMatchObject({ ok: false });
  });
  linkTest("reports .git / AGENTS.md in workDir or any ancestor", async () => {
    const p = await prep();
    const parent = join(p.workDir, "..");
    // ancestor marker: put AGENTS.md in a synthetic parent via a fake paths object
    const fakeParent = join(root, "proj");
    mkdirSync(join(fakeParent, ".git"), { recursive: true });
    writeFileSync(join(fakeParent, "AGENTS.md"), "x");
    const nested = join(fakeParent, "work");
    mkdirSync(nested);
    const r = preflight({ ...p, workDir: nested });
    expect(r.ok).toBe(false);
    const problems = (r as { problems: string[] }).problems.join("\n");
    expect(problems).toContain(".git");
    expect(problems).toContain("AGENTS.md");
    void parent;
  });
});

describe("cleanupRun", () => {
  linkTest("removes workDir only", async () => {
    const p = await prep();
    writeFileSync(join(p.tmpDir, "x"), "x");
    await cleanupRun(p);
    expect(existsSync(p.workDir)).toBe(false);
    expect(existsSync(p.wsHome)).toBe(true);
    expect(existsSync(join(p.codexHome, "config.toml"))).toBe(true);
  });
});
