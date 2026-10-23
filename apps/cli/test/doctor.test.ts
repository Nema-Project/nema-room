import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStore, type StoredAuth } from "../src/direct/authStore.js";
import { defaultTokenFile, runDoctor as realRunDoctor, type DoctorOpts } from "../src/doctor.js";
import type { GraphifyOpts } from "../src/repos/graphify.js";

let root: string;
let server: Server | undefined;
/** Every check gets a fake graphify, so no test runs the real one. */
let fake: GraphifyOpts;
/** Every check gets a temp agent home, so no test reads the real ~/.claude or ~/.codex. */
/** Every check gets a missing github-mcp-server by default, so no test runs a real one. */
const runDoctor = (opts: DoctorOpts) =>
  realRunDoctor({ graphify: fake, agentHome: join(root, "agent-home"), githubMcpServerBin: join(root, "missing-github-mcp-server"), ...opts });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-doctor-test-"));
  fake = { bin: join(root, "missing-graphify") };
});
afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const byName = (rs: { name: string; ok: boolean; detail: string }[], part: string) => {
  const r = rs.find((x) => x.name.toLowerCase().includes(part));
  if (!r) throw new Error(`no check named ~${part}`);
  return r;
};

describe("runDoctor", () => {
  test("missing codex binary does not fail; a missing Codex login file does when authMode is compat", async () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const rs = await runDoctor({
      codexBin: join(root, "no-such-codex"),
      userCodexHome: empty,
      hubUrl: "http://127.0.0.1:1",
      tokenFile: join(root, "daemon-token"),
      nemaHome: join(root, "nema"),
      adapter: "codex-direct",
      authMode: "compat",
    });
    expect(byName(rs, "codex 可用").ok).toBe(true);
    expect(byName(rs, "codex 登录").ok).toBe(false);
    expect(byName(rs, "hub").ok).toBe(false);
    expect(byName(rs, "daemon token").ok).toBe(false);
  });

  test("everything present passes", async () => {
    const codex = join(root, "codex");
    writeFileSync(codex, '#!/bin/sh\necho "codex-cli 9.9.9"\n');
    chmodSync(codex, 0o755);
    const home = join(root, "home");
    mkdirSync(home);
    writeFileSync(join(home, "auth.json"), "{}");
    new AuthStore(join(root, "nema"), async () => ({ access_token: "x" })).save({
      version: 1, mode: "siwc", clientId: "c", tokens: { access_token: "a.b.c", refresh_token: "rt" }, lastRefresh: "2026-10-22T00:00:00.000Z",
    });
    const tokenFile = join(root, "daemon-token");
    writeFileSync(tokenFile, "tok");
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/api/daemon/status" ? '{"connected":false}' : "{}");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const rs = await runDoctor({ codexBin: codex, userCodexHome: home, hubUrl, tokenFile, nemaHome: join(root, "nema"), adapter: "codex-direct", authMode: "siwc" });
    expect(rs.every((r) => r.ok), JSON.stringify(rs)).toBe(true);
    expect(byName(rs, "codex 可用").detail).toContain("9.9.9");
    expect(byName(rs, "graphify").ok).toBe(true);
    expect(rs.length).toBe(15);
  });
});

describe("直连登录 check", () => {
  const b64u = (x: string) => Buffer.from(x).toString("base64url");
  const jwt = (p: Record<string, unknown>) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify(p))}.sig`;
  const EXP = Math.floor(Date.UTC(2030, 0, 2, 3, 4, 5) / 1000);
  const stored = (tokens: { access_token: string; refresh_token: string }): StoredAuth => ({
    version: 1,
    mode: "siwc",
    clientId: "oaiapp_x",
    tokens,
    lastRefresh: "2026-10-22T00:00:00.000Z",
  });
  const run = () =>
    runDoctor({ codexBin: join(root, "none"), userCodexHome: join(root, "none"), hubUrl: "http://127.0.0.1:1", tokenFile: join(root, "t"), nemaHome: join(root, "nema"), adapter: "codex-direct" });
  const save = (a: StoredAuth) => new AuthStore(join(root, "nema"), async () => ({ access_token: "x" })).save(a);

  test("logged in: ok with mode and expiry, never any token", async () => {
    save(stored({ access_token: jwt({ exp: EXP }), refresh_token: "SECRET-RT" }));
    const c = byName(await run(), "直连登录");
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("已登录（siwc，");
    expect(c.detail).toContain(new Date(EXP * 1000).toISOString());
    expect(JSON.stringify(c)).not.toContain("SECRET-RT");
  });

  test("invalidated login fails the direct check", async () => {
    save(stored({ access_token: "", refresh_token: "" }));
    expect(byName(await run(), "直连登录")).toMatchObject({ ok: false, detail: "已失效，请运行 nema auth login" });
  });

  test("an untrusted credential file reads as unusable, not as 未登录", async () => {
    save(stored({ access_token: jwt({ exp: EXP }), refresh_token: "rt" }));
    chmodSync(join(root, "nema", "auth.json"), 0o644);
    expect(byName(await run(), "直连登录")).toMatchObject({ ok: false, detail: "凭证文件不可用（权限/符号链接/损坏），请重新运行 nema auth login" });
  });

  test("not logged in fails the direct check", async () => {
    expect(byName(await run(), "直连登录")).toMatchObject({ ok: false, detail: "未登录" });
  });
});

describe("codex rows are informational unless compat needs the login file", () => {
  test("siwc + no codex binary + valid direct login -> everything passes", async () => {
    const opts = {
      codexBin: join(root, "no-such-codex"),
      userCodexHome: join(root, "no-codex-home"),
      hubUrl: "",
      tokenFile: join(root, "daemon-token"),
      nemaHome: join(root, "nema"),
      adapter: "codex-direct" as const,
    };
    writeFileSync(join(root, "daemon-token"), "tok");
    server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"connected":true}');
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    new AuthStore(join(root, "nema"), async () => ({ access_token: "x" })).save({
      version: 1, mode: "siwc", clientId: "c", tokens: { access_token: "a.b.c", refresh_token: "rt" }, lastRefresh: "2026-10-22T00:00:00.000Z",
    });
    const rs = await runDoctor({ ...opts, hubUrl });
    expect(rs.every((r) => r.ok), JSON.stringify(rs)).toBe(true);
    expect(byName(rs, "codex 可用").detail).toContain("不启动 CLI");
    expect(byName(rs, "codex 登录").detail).toContain("仅 authMode=compat");
  });
});

describe("compat login check", () => {
  const b64u = (x: string) => Buffer.from(x).toString("base64url");
  const jwt = (p: Record<string, unknown>) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify(p))}.sig`;

  test("codex-direct + compat reads the Codex file and fails when it is missing", async () => {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access = jwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "acct-4242" } });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: access, refresh_token: "SECRET-RT" } }));
    const base = {
      codexBin: join(root, "no-such-codex"),
      userCodexHome: codexHome,
      hubUrl: "http://127.0.0.1:1",
      tokenFile: join(root, "t"),
      nemaHome: join(root, "nema"),
      adapter: "codex-direct" as const,
      authMode: "compat" as const,
    };
    const ok = byName(await runDoctor(base), "直连登录");
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain("compat");
    expect(ok.detail).toContain("4242");
    expect(JSON.stringify(ok)).not.toContain("SECRET-RT");
    const missing = byName(await runDoctor({ ...base, userCodexHome: join(root, "empty-codex") }), "直连登录");
    expect(missing.ok).toBe(false);
  });
});

describe("BYOK check", () => {
  const run = (authMode: "siwc" | "byok", model?: string) =>
    runDoctor({
      codexBin: join(root, "none"),
      userCodexHome: join(root, "none"),
      hubUrl: "http://127.0.0.1:1",
      tokenFile: join(root, "t"),
      nemaHome: join(root, "nema"),
      adapter: "codex-direct",
      authMode,
      model,
    });

  test("byok fails when the key and model are missing", async () => {
    expect(byName(await run("byok"), "byok").ok).toBe(false);
  });

  test("byok rejects a key file whose mode is not 0600 without revealing its contents", async () => {
    mkdirSync(join(root, "nema"));
    writeFileSync(join(root, "nema", "byok-key"), "sekret-key", { mode: 0o644 });

    const check = byName(await run("byok", "gpt-example"), "byok");

    expect(check.ok).toBe(false);
    expect(check.detail).toContain("0600");
    expect(check.detail).not.toContain("sekret-key");
  });

  test("byok passes with a 0600 key and configured model without revealing the key", async () => {
    mkdirSync(join(root, "nema"));
    writeFileSync(join(root, "nema", "byok-key"), "sekret-key", { mode: 0o600 });

    const check = byName(await run("byok", "gpt-example"), "byok");

    expect(check.ok).toBe(true);
    expect(check.detail).not.toContain("sekret-key");
  });

  test("siwc does not require a BYOK key", async () => {
    const check = byName(await run("siwc"), "byok");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("仅 authMode=byok 需要");
  });
});

describe("Claude Code checks", () => {
  let savedPath: string | undefined;
  beforeEach(() => {
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  const run = (adapter: "codex-direct" | "claude-code") =>
    runDoctor({
      codexBin: join(root, "none"),
      userCodexHome: join(root, "none"),
      hubUrl: "http://127.0.0.1:1",
      tokenFile: join(root, "t"),
      nemaHome: join(root, "nema"),
      adapter,
    });

  test("claude-code fails when PATH has no claude binary and the token file is missing", async () => {
    process.env.PATH = root;
    const rs = await run("claude-code");
    expect(byName(rs, "claude 可用")).toMatchObject({ ok: false });
    expect(byName(rs, "claude code token")).toMatchObject({ ok: false });
  });

  test("any other adapter passes both checks and says only claude-code needs them", async () => {
    process.env.PATH = root;
    const rs = await run("codex-direct");
    for (const part of ["claude 可用", "claude code token"]) {
      const check = byName(rs, part);
      expect(check.ok).toBe(true);
      expect(check.detail).toContain("仅 adapter=claude-code 需要");
    }
  });

  test("a 0600 token file passes and a 0644 file fails, and no detail includes the token", async () => {
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "claude"), '#!/bin/sh\necho "claude 2.0.0"\n');
    chmodSync(join(binDir, "claude"), 0o755);
    process.env.PATH = binDir;
    const nemaHome = join(root, "nema");
    mkdirSync(nemaHome);
    writeFileSync(join(nemaHome, "claude-code-token"), "sekret-token", { mode: 0o600 });

    const ready = await run("claude-code");
    expect(byName(ready, "claude 可用")).toMatchObject({ ok: true });
    expect(byName(ready, "claude 可用").detail).toContain("2.0.0");
    expect(byName(ready, "claude code token").ok).toBe(true);
    expect(JSON.stringify(ready)).not.toContain("sekret-token");

    chmodSync(join(nemaHome, "claude-code-token"), 0o644);
    const loose = await run("claude-code");
    expect(byName(loose, "claude code token").ok).toBe(false);
    expect(JSON.stringify(loose)).not.toContain("sekret-token");
  });
});

describe("graphify check", () => {
  const opts = () => ({
    codexBin: join(root, "none"),
    userCodexHome: join(root, "none"),
    hubUrl: "http://127.0.0.1:1",
    tokenFile: join(root, "t"),
    nemaHome: join(root, "nema"),
    adapter: "codex-direct" as const,
  });

  test("reports graphify version or the install hint without failing", async () => {
    const missing = byName(await runDoctor(opts()), "graphify");
    expect(missing).toMatchObject({
      name: "graphify 可用",
      ok: true,
      detail: "graphify 未安装：请运行 uv tool install graphifyy",
    });

    const bin = join(root, "graphify");
    writeFileSync(bin, "#!/bin/sh\necho graphify 9.9.9\n");
    chmodSync(bin, 0o755);
    fake.bin = bin;
    const present = byName(await runDoctor(opts()), "graphify");
    expect(present).toMatchObject({ name: "graphify 可用", ok: true, detail: "graphify 9.9.9" });
  });
});

describe("report hook and token checks", () => {
  const opts = () => ({
    codexBin: join(root, "none"),
    userCodexHome: join(root, "none"),
    hubUrl: "http://127.0.0.1:1",
    tokenFile: join(root, "t"),
    nemaHome: join(root, "nema"),
    adapter: "codex-direct" as const,
  });

  test("doctor reports hook and token presence without failing", async () => {
    const before = await runDoctor(opts());
    expect(byName(before, "上报钩子：claude")).toMatchObject({ ok: true, detail: "未安装" });
    expect(byName(before, "上报钩子：codex")).toMatchObject({ ok: true, detail: "未安装" });
    expect(byName(before, "上报令牌")).toMatchObject({ ok: true, detail: "不存在" });

    const home = join(root, "agent-home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "/n/node /n/index.js report hook --agent claude" }] }] } }),
    );
    mkdirSync(join(root, "nema"));
    writeFileSync(join(root, "nema", "report-token"), "a".repeat(64), { mode: 0o600 });
    const after = await runDoctor(opts());
    expect(byName(after, "上报钩子：claude")).toMatchObject({ ok: true, detail: "已安装" });
    expect(byName(after, "上报钩子：codex")).toMatchObject({ ok: true, detail: "未安装" });
    expect(byName(after, "上报令牌")).toMatchObject({ ok: true, detail: "存在" });
    expect(JSON.stringify(after)).not.toContain("a".repeat(64));
  });

  test("an unparseable settings file reads as not installed, never a failure", async () => {
    mkdirSync(join(root, "agent-home", ".claude"), { recursive: true });
    writeFileSync(join(root, "agent-home", ".claude", "settings.json"), "{ nope");
    expect(byName(await runDoctor(opts()), "上报钩子：claude")).toMatchObject({ ok: true, detail: "未安装" });
  });
});

describe("GitHub checks", () => {
  const opts = () => ({
    codexBin: join(root, "none"),
    userCodexHome: join(root, "none"),
    hubUrl: "http://127.0.0.1:1",
    tokenFile: join(root, "t"),
    nemaHome: join(root, "nema"),
    adapter: "codex-direct" as const,
  });

  test("doctor reports github-mcp-server and the token without printing it", async () => {
    const before = await runDoctor(opts());
    expect(byName(before, "github-mcp-server")).toMatchObject({ ok: true });
    expect(byName(before, "github-mcp-server").detail).toContain("未安装");
    expect(byName(before, "github-mcp-server").detail).toContain("https://github.com/github/github-mcp-server/releases");
    expect(byName(before, "github 令牌")).toMatchObject({ ok: true });
    expect(byName(before, "github 令牌").detail).toContain("不存在");

    const bin = join(root, "github-mcp-server");
    writeFileSync(bin, "#!/bin/sh\necho 'Version: 0.9.9'\necho 'Commit: abc'\n");
    chmodSync(bin, 0o755);
    mkdirSync(join(root, "nema"));
    writeFileSync(join(root, "nema", "github-token"), "ghp_sekret", { mode: 0o600 });
    const after = await runDoctor({ ...opts(), githubMcpServerBin: bin });
    expect(byName(after, "github-mcp-server")).toMatchObject({ ok: true, detail: "可用：Version: 0.9.9" });
    expect(byName(after, "github 令牌")).toMatchObject({ ok: true });
    expect(byName(after, "github 令牌").detail).toContain("0600");
    expect(JSON.stringify(after)).not.toContain("ghp_sekret");

    chmodSync(join(root, "nema", "github-token"), 0o644);
    const loose = await runDoctor({ ...opts(), githubMcpServerBin: bin });
    expect(byName(loose, "github 令牌").ok).toBe(true);
    expect(byName(loose, "github 令牌").detail).toContain("0600");
    expect(JSON.stringify(loose)).not.toContain("ghp_sekret");
  });
});

describe("defaultTokenFile", () => {
  test("derives from NEMA_DATA_DIR, expanding ~", () => {
    expect(defaultTokenFile({ NEMA_DATA_DIR: "/data/x" })).toBe("/data/x/daemon-token");
    expect(defaultTokenFile({ NEMA_DATA_DIR: "~/nd" })).toBe(join(homedir(), "nd", "daemon-token"));
    expect(defaultTokenFile({})).toBe(join(homedir(), ".nema", "data", "daemon-token"));
  });
});
