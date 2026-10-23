import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GithubMcp } from "../../src/github/client.js";
import { saveGithubToken } from "../../src/secrets/github.js";

vi.setConfig({ testTimeout: 20_000 });

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "fake-github-mcp.mjs");
const ALL_TOOLS = ["pull_request_read", "list_pull_requests", "search_pull_requests", "issue_read", "list_issues", "search_issues"];

let root: string;
let nemaHome: string;
const clients: GithubMcp[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-github-mcp-"));
  nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
});

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  rmSync(root, { recursive: true, force: true });
});

type FakeConfig = {
  tools?: string[];
  record?: string;
  starts?: string;
  crashOnce?: string;
  crashAlways?: boolean;
  exitOnStart?: boolean;
  bigText?: number;
  version?: string;
};

/** Writes a launcher that runs the fake server with this config, and returns its path. */
function fakeServer(config: FakeConfig): string {
  const configPath = join(root, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify({ tools: ALL_TOOLS, ...config }));
  const bin = join(root, `fake-github-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    bin,
    `#!${process.execPath}\nglobalThis.__FAKE_GITHUB_CONFIG = ${JSON.stringify(configPath)};\nawait import(${JSON.stringify(pathToFileURL(FIXTURE).href)});\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function client(opts: { bin: string; warn?: (message: string) => void; retryDelayMs?: number }): GithubMcp {
  const c = new GithubMcp({ nemaHome, bin: opts.bin, warn: opts.warn ?? (() => {}), retryDelayMs: opts.retryDelayMs });
  clients.push(c);
  return c;
}

function starts(file: string): number {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
}

test("the server is started with only --read-only --toolsets pull_requests,issues and the three env vars", async () => {
  saveGithubToken(nemaHome, "ghp_test_token");
  const record = join(root, "record.json");
  const gh = client({ bin: fakeServer({ record }) });
  await expect(gh.call("issue_read", { owner: "o", repo: "r", issue_number: 1, method: "get" })).resolves.toBe(
    'issue_read {"owner":"o","repo":"r","issue_number":1,"method":"get"}',
  );
  const seen = JSON.parse(readFileSync(record, "utf8")) as { args: string[]; env: Record<string, string>; cwd: string };
  expect(seen.args).toEqual(["stdio", "--read-only", "--toolsets", "pull_requests,issues"]);
  // macOS sets __CF_USER_TEXT_ENCODING inside every process at startup; the client never passes it.
  expect(Object.keys(seen.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").sort()).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN", "HOME", "PATH"]);
  expect(seen.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_test_token");
  expect(seen.env.PATH).toBe(process.env.PATH);
  expect(seen.env.HOME.startsWith(join(nemaHome, "run", "github"))).toBe(true);
});

test("a call returns the tool's text, capped at 64 KB", async () => {
  saveGithubToken(nemaHome, "ghp_test_token");
  const gh = client({ bin: fakeServer({ bigText: 100_000 }) });
  const text = (await gh.call("list_issues", { owner: "o", repo: "r" })) as string;
  expect(typeof text).toBe("string");
  expect(Buffer.byteLength(text)).toBe(65_536);
});

test("a manifest tool missing on the server is rejected; a server-only tool is never callable", async () => {
  saveGithubToken(nemaHome, "ghp_test_token");
  const warnings: string[] = [];
  const gh = client({
    bin: fakeServer({ tools: ["pull_request_read", "list_issues", "create_issue"] }),
    warn: (message) => warnings.push(message),
  });
  await expect(gh.call("list_issues", { owner: "o", repo: "r" })).resolves.toContain("list_issues");
  await expect(gh.call("issue_read", { owner: "o", repo: "r", issue_number: 1, method: "get" })).rejects.toThrow(
    "GitHub 插件没有工具 issue_read",
  );
  await expect(gh.call("create_issue", { owner: "o", repo: "r", title: "x" })).rejects.toThrow("GitHub 插件没有工具 create_issue");
  await expect(gh.call("search_issues", { query: "repo:o/r bug" })).rejects.toThrow("GitHub 插件没有工具 search_issues");
  // Logged once per start, one line per missing tool, never for the server-only tool.
  expect(warnings.filter((w) => w.includes("issue_read"))).toHaveLength(1);
  expect(warnings.some((w) => w.includes("create_issue"))).toBe(false);
  expect(warnings).toHaveLength(4);
});

test("a crash mid-call fails with GitHub 插件已停止 and the next call restarts once", async () => {
  saveGithubToken(nemaHome, "ghp_test_token");
  const startsFile = join(root, "starts");
  const gh = client({ bin: fakeServer({ starts: startsFile, crashOnce: join(root, "crashed") }) });
  await expect(gh.call("list_issues", { owner: "o", repo: "r" })).rejects.toThrow("GitHub 插件已停止");
  expect(starts(startsFile)).toBe(1);
  await expect(gh.call("list_issues", { owner: "o", repo: "r" })).resolves.toContain("list_issues");
  expect(starts(startsFile)).toBe(2);
  await expect(gh.call("list_issues", { owner: "o", repo: "r" })).resolves.toContain("list_issues");
  expect(starts(startsFile)).toBe(2);
});

test("a restart that also fails makes calls fail fast with the start error", async () => {
  saveGithubToken(nemaHome, "ghp_test_token");
  const startsFile = join(root, "starts");
  const gh = client({ bin: fakeServer({ starts: startsFile, exitOnStart: true }) });
  const first = await gh.call("list_issues", { owner: "o", repo: "r" }).catch((e: Error) => e.message);
  expect(first).toMatch(/GitHub/);
  const second = await gh.call("list_issues", { owner: "o", repo: "r" }).catch((e: Error) => e.message);
  expect(second).toBe(first);
  expect(starts(startsFile)).toBe(1);
});

test("a missing binary or token gives the Chinese message and does not loop", async () => {
  const startsFile = join(root, "starts");
  const noToken = client({ bin: fakeServer({ starts: startsFile }) });
  await expect(noToken.call("list_issues", { owner: "o", repo: "r" })).rejects.toThrow("未保存 GitHub 令牌：请运行 nema auth github");
  expect(starts(startsFile)).toBe(0);
  await expect(noToken.status()).resolves.toEqual({
    installed: true,
    loggedIn: false,
    detail: "未保存 GitHub 令牌：请运行 nema auth github",
  });

  saveGithubToken(nemaHome, "ghp_test_token");
  const missing = client({ bin: join(root, "no-such-github-mcp-server") });
  await expect(missing.call("list_issues", { owner: "o", repo: "r" })).rejects.toThrow("github-mcp-server 未安装");
  await expect(missing.call("list_issues", { owner: "o", repo: "r" })).rejects.toThrow("github-mcp-server 未安装");
  await expect(missing.status()).resolves.toEqual({ installed: false, loggedIn: true, detail: "github-mcp-server 未安装" });
  const ok = client({ bin: fakeServer({ version: "github-mcp-server 9.9.9" }) });
  await expect(ok.status()).resolves.toEqual({ installed: true, loggedIn: true, detail: "github-mcp-server 9.9.9" });
});

test("a tool outside the fixed list is rejected before anything starts", async () => {
  saveGithubToken(nemaHome, "ghp_test_token");
  const startsFile = join(root, "starts");
  const gh = client({ bin: fakeServer({ starts: startsFile, tools: [...ALL_TOOLS, "merge_pull_request"] }) });
  await expect(gh.call("merge_pull_request", { owner: "o", repo: "r", pullNumber: 1 })).rejects.toThrow(
    "GitHub 插件没有工具 merge_pull_request",
  );
  expect(starts(startsFile)).toBe(0);
});

test("plugin.call routes github__ names to the client and plugins.status reports github", async () => {
  const { RpcRouter } = await import("../../src/daemon/rpc.js");
  const { registerRepoHandlers } = await import("../../src/repos/handlers.js");
  const gh = client({ bin: fakeServer({}) });
  const rpc = new RpcRouter();
  registerRepoHandlers(rpc, { nemaHome, graphify: { bin: join(root, "missing-graphify") }, github: gh });

  const status = await rpc.handle({ type: "rpc.request", id: "s1", method: "plugins.status", params: {} });
  expect(status).toMatchObject({
    ok: true,
    result: { github: { installed: false, detail: "未保存 GitHub 令牌：请运行 nema auth github" } },
  });

  saveGithubToken(nemaHome, "ghp_test_token");
  const call = await rpc.handle({
    type: "rpc.request",
    id: "c1",
    method: "plugin.call",
    params: { name: "github__list_issues", args: { owner: "o", repo: "r" } },
  });
  expect(call).toMatchObject({ ok: true, result: 'list_issues {"owner":"o","repo":"r"}' });
  const status2 = await rpc.handle({ type: "rpc.request", id: "s2", method: "plugins.status", params: {} });
  expect(status2).toMatchObject({ ok: true, result: { github: { installed: true, detail: "github-mcp-server fake 0.0.1" } } });

  const bad = await rpc.handle({ type: "rpc.request", id: "c2", method: "plugin.call", params: { name: "github__create_issue", args: {} } });
  expect(bad).toMatchObject({ ok: false, error: "未知函数 github__create_issue" });
});
