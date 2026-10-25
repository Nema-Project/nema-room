import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// git clone/fetch plus graphify spawns can exceed the 5s default when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });
import WebSocket, { WebSocketServer } from "ws";
import { startDaemon } from "../../src/daemon/setup.js";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerRepoHandlers } from "../../src/repos/handlers.js";
import { inspectRepo } from "../../src/repos/git.js";
import { lf } from "../windowsEnv.js";
import { linkDir } from "../links.js";
import { commitWithSymlink } from "./gitSymlink.js";
import type { GraphifyOpts } from "../../src/repos/graphify.js";
import { GithubMcp } from "../../src/github/client.js";

let root: string;
let savedHome: string | undefined;
/** Handed to the handlers; a test fills in `bin`/`timeoutMs` before the call that spawns graphify. */
let fake: GraphifyOpts;
let server: http.Server | undefined;
let wss: WebSocketServer | undefined;
let conns: WebSocket[] = [];
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-repo-handler-"));
  savedHome = process.env.HOME;
  fake = { bin: join(root, "missing-graphify") };
  mkdirSync(join(root, "home"));
  process.env.HOME = join(root, "home");
});

afterEach(() => {
  for (const close of closers.splice(0)) close();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG ?? "C",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "false",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (e) {
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    throw new Error(`git ${args.join(" ")} failed\n${stderr}`, { cause: e });
  }
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
}

function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function writeBin(body: string): string {
  const file = join(root, `graphify-${Math.random().toString(16).slice(2)}`);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current)) {
      if (name === ".git") continue;
      const abs = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(abs).isSymbolicLink()) {
        out.push(rel);
        continue;
      }
      if (lstatSync(abs).isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function setupOrigin(): { repo: string; bare: string; nemaHome: string } {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const bare = join(root, "origin.git");
  git(root, ["init", "--bare", "-b", "main", bare]);
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "v1\n");
  commitAll(repo, "init");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { repo, bare, nemaHome };
}

/** A GitHub client whose binary does not exist, so no test runs a real github-mcp-server. */
function missingGithub(nemaHome: string): GithubMcp {
  return new GithubMcp({ nemaHome, bin: join(root, "missing-github-mcp-server"), warn: () => {} });
}

const GITHUB_MISSING = { installed: false, loggedIn: false, detail: "github-mcp-server 未安装" };

function routerFor(nemaHome: string): RpcRouter {
  const rpc = new RpcRouter();
  registerRepoHandlers(rpc, { nemaHome, graphify: fake, github: missingGithub(nemaHome) });
  return rpc;
}

test("repo.index exports origin/main into the snapshot and runs graphify extract --code-only there", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "secret\n");
  commitWithSymlink(git, repo, "escape", secret, "link");
  git(repo, ["push", "origin", "main"]);

  const other = join(root, "other");
  git(root, ["clone", bare, other]);
  git(other, ["config", "user.email", "test@example.com"]);
  git(other, ["config", "user.name", "Test"]);
  writeFileSync(join(other, "README.md"), "v2\n");
  writeFileSync(join(other, "extra.txt"), "from-origin\n");
  commitAll(other, "remote");
  git(other, ["push", "origin", "main"]);
  const originSha = git(other, ["rev-parse", "HEAD"]).trim();

  writeFileSync(join(repo, "README.md"), "dirty\n");
  writeFileSync(join(repo, "local-only.txt"), "local\n");

  const record = join(root, "record");
  mkdirSync(record);
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record + "/cwd")}, process.cwd() + "\\n");
fs.writeFileSync(${JSON.stringify(record + "/argv")}, args.join("\\n") + "\\n");
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`);

  const res = await routerFor(nemaHome).handle({
    type: "rpc.request",
    id: "1",
    method: "repo.index",
    params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main" },
  });

  const snapshot = join(nemaHome, "ws", "ws_demo", "graphify", "repo_demo");
  const src = join(snapshot, "src");
  expect(res).toEqual({ type: "rpc.response", id: "1", ok: true, result: { sha: originSha } });
  expect(lf(readFileSync(join(src, "README.md"), "utf8"))).toBe("v2\n");
  expect(lf(readFileSync(join(src, "extra.txt"), "utf8"))).toBe("from-origin\n");
  expect(existsSync(join(src, "local-only.txt"))).toBe(false);
  expect(existsSync(join(src, "escape"))).toBe(false);
  expect(readFileSync(secret, "utf8")).toBe("secret\n");
  expect(readFileSync(join(record, "argv"), "utf8")).toBe(`extract\n${src}\n--code-only\n`);
  expect(realpathSync(readFileSync(join(record, "cwd"), "utf8").trim())).toBe(realpathSync(snapshot));
  expect(readFileSync(join(snapshot, "graphify-out", "graph.json"), "utf8")).toBe("{}");
}, 20_000);

test("a repo with no origin still exports the local branch and runs graphify extract --code-only", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "local-main\n");
  const sha = commitAll(repo, "init");
  writeFileSync(join(repo, "README.md"), "dirty\n");

  const record = join(root, "record");
  mkdirSync(record);
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record + "/cwd")}, process.cwd() + "\\n");
fs.writeFileSync(${JSON.stringify(record + "/argv")}, args.join("\\n") + "\\n");
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`);

  const res = await routerFor(nemaHome).handle({
    type: "rpc.request",
    id: "no-origin",
    method: "repo.index",
    params: { workspaceId: "ws_local", repoId: "repo_local", path: repo, mainBranch: "main" },
  });

  const src = join(nemaHome, "ws", "ws_local", "graphify", "repo_local", "src");
  expect(res).toEqual({ type: "rpc.response", id: "no-origin", ok: true, result: { sha } });
  expect(lf(readFileSync(join(src, "README.md"), "utf8"))).toBe("local-main\n");
  expect(readFileSync(join(record, "argv"), "utf8")).toBe(`extract\n${src}\n--code-only\n`);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("dirty\n");
});

test("a graphify that ignores SIGTERM and outlives the timeout does not return a sha", async () => {
  fake.timeoutMs = 2000;
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "local\n");
  commitAll(repo, "init");
  const pidFile = join(root, "graphify.pid");
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 30000);
`);
  const pending = routerFor(nemaHome).handle({
    type: "rpc.request",
    id: "kill",
    method: "repo.index",
    params: { workspaceId: "ws_local", repoId: "repo_local", path: repo, mainBranch: "main" },
  });
  let winner: { done: true; res: Awaited<ReturnType<RpcRouter["handle"]>> } | { done: false };
  let stillAlive = false;
  try {
    winner = await Promise.race([
      pending.then((res) => ({ done: true as const, res })),
      new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 8000)),
    ]);
    if (existsSync(pidFile)) {
      try { stillAlive = process.kill(Number(readFileSync(pidFile, "utf8")), 0); } catch { stillAlive = false; }
    }
  } finally {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
      // The fake never started, or it has already exited.
    }
  }
  expect(winner.done).toBe(true);
  if (!winner.done) return;
  expect(existsSync(pidFile)).toBe(true);
  // Windows has no SIGTERM to ignore: the kill is immediate, so the child is already gone. What holds on both
  // platforms is that the timed-out index returns an error and no sha.
  expect(stillAlive).toBe(process.platform !== "win32");
  expect(winner.res.ok).toBe(false);
  expect(winner.res).not.toMatchObject({ result: { sha: expect.any(String) } });
});

test("indexing leaves the bound repo's git status and file list unchanged", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const other = join(root, "other");
  git(root, ["clone", bare, other]);
  git(other, ["config", "user.email", "test@example.com"]);
  git(other, ["config", "user.name", "Test"]);
  writeFileSync(join(other, "remote-only.txt"), "from-origin\n");
  commitAll(other, "remote");
  git(other, ["push", "origin", "main"]);

  writeFileSync(join(repo, "README.md"), "dirty\n");
  writeFileSync(join(repo, "untracked.txt"), "mine\n");
  const statusBefore = git(repo, ["status", "--porcelain"]);
  const mainBefore = git(repo, ["rev-parse", "main"]).trim();
  const filesBefore = listFiles(repo);
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`);

  const res = await routerFor(nemaHome).handle({
    type: "rpc.request",
    id: "2",
    method: "repo.index",
    params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main" },
  });

  expect(res.ok).toBe(true);
  expect(git(repo, ["status", "--porcelain"])).toBe(statusBefore);
  expect(git(repo, ["rev-parse", "main"]).trim()).toBe(mainBefore);
  expect(listFiles(repo)).toEqual(filesBefore);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("dirty\n");
  expect(existsSync(join(repo, "remote-only.txt"))).toBe(false);
});

test("repo.inspect returns inspectRepo and rejects a path under nemaHome", async () => {
  const { repo, nemaHome } = setupOrigin();
  const rpc = routerFor(nemaHome);
  const info = await inspectRepo(repo, nemaHome);
  await expect(
    rpc.handle({ type: "rpc.request", id: "3", method: "repo.inspect", params: { path: repo } }),
  ).resolves.toEqual({ type: "rpc.response", id: "3", ok: true, result: info });

  const inside = join(nemaHome, "nested");
  initRepo(inside);
  writeFileSync(join(inside, "a.txt"), "a\n");
  commitAll(inside, "init");
  const rejected = await rpc.handle({ type: "rpc.request", id: "4", method: "repo.inspect", params: { path: inside } });
  expect(rejected).toMatchObject({ ok: false, error: "不能绑定 ~/.nema 之下的目录" });
});

test("repo.forget removes the snapshot and does not follow a symlink", async () => {
  const nemaHome = join(root, "nema-home");
  const snapshot = join(nemaHome, "ws", "ws_demo", "graphify", "repo_demo");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, "graph.json"), "{}\n");
  const rpc = routerFor(nemaHome);
  const removed = await rpc.handle({
    type: "rpc.request",
    id: "5",
    method: "repo.forget",
    params: { workspaceId: "ws_demo", repoId: "repo_demo", path: "/repo", mainBranch: "main" },
  });
  expect(removed).toMatchObject({ ok: true });
  expect(existsSync(snapshot)).toBe(false);

  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep.txt"), "keep\n");
  const linkParent = join(nemaHome, "ws", "ws_link", "graphify");
  mkdirSync(linkParent, { recursive: true });
  linkDir(outside, join(linkParent, "repo_link"));
  await rpc.handle({
    type: "rpc.request",
    id: "6",
    method: "repo.forget",
    params: { workspaceId: "ws_link", repoId: "repo_link", path: "/repo", mainBranch: "main" },
  });
  expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep\n");
  expect(existsSync(join(linkParent, "repo_link"))).toBe(false);

  const victim = join(root, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, "keep.txt"), "keep\n");
  const escaped = await rpc.handle({
    type: "rpc.request",
    id: "7",
    method: "repo.forget",
    params: { workspaceId: "../victim", repoId: "repo_demo", path: "/repo", mainBranch: "main" },
  });
  expect(escaped).toMatchObject({ ok: false });
  expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
});

async function startHub(): Promise<number> {
  const httpServer = http.createServer();
  server = httpServer;
  wss = new WebSocketServer({ server, path: "/daemon" });
  wss.on("connection", (ws) => conns.push(ws));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return (httpServer.address() as AddressInfo).port;
}

async function stopHub(): Promise<void> {
  if (!wss || !server) return;
  for (const client of wss.clients) client.terminate();
  server.closeAllConnections();
  const httpServer = server;
  server = undefined;
  wss = undefined;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  conns = [];
}

afterEach(async () => {
  await stopHub().catch(() => {});
});

function pluginCall(id: string, repoPath: string, name: string, args: unknown, mainBranch = "main") {
  return {
    type: "rpc.request" as const,
    id,
    method: "plugin.call",
    params: {
      name,
      args,
      repo: { workspaceId: "ws_demo", repoId: "repo_demo", path: repoPath, mainBranch },
    },
  };
}

test("plugin.call code__read returns the committed text at the main ref", async () => {
  const { repo, nemaHome } = setupOrigin();
  writeFileSync(join(repo, "notes.txt"), "alpha\nbeta\ngamma\n");
  commitAll(repo, "notes");
  git(repo, ["push", "origin", "main"]);
  writeFileSync(join(repo, "notes.txt"), "local commit\n");
  commitAll(repo, "local");
  writeFileSync(join(repo, "notes.txt"), "DIRTY\n");

  const res = await routerFor(nemaHome).handle(
    pluginCall("read", repo, "code__read", { repo: "repo_demo", path: "notes.txt", startLine: 2, endLine: 3 }),
  );

  expect(res).toEqual({
    type: "rpc.response",
    id: "read",
    ok: true,
    result: {
      path: "notes.txt",
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      text: "beta\ngamma",
      truncated: false,
    },
  });
  expect(readFileSync(join(repo, "notes.txt"), "utf8")).toBe("DIRTY\n");
});

test("plugin.call code__search builds a missing index first, then queries", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "v1\n");
  commitAll(repo, "init");
  writeFileSync(join(repo, "README.md"), "dirty\n");
  writeFileSync(join(repo, "untracked.txt"), "mine\n");

  const record = join(root, "record");
  mkdirSync(record);
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record + "/argv")}, args.join("\\n") + "\\n");
fs.appendFileSync(${JSON.stringify(record + "/argv")}, "\\n");
if (args[0] === "extract") {
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
}
if (args[0] === "query") {
process.stdout.write("hits:" + args[1]);
}
`);

  const rpc = routerFor(nemaHome);
  const first = await rpc.handle(pluginCall("search-1", repo, "code__search", { repo: "repo_demo", query: "alpha" }));
  const second = await rpc.handle(pluginCall("search-2", repo, "code__search", { repo: "repo_demo", query: "beta" }));

  const src = join(nemaHome, "ws", "ws_demo", "graphify", "repo_demo", "src");
  expect(first).toEqual({ type: "rpc.response", id: "search-1", ok: true, result: "hits:alpha" });
  expect(second).toEqual({ type: "rpc.response", id: "search-2", ok: true, result: "hits:beta" });
  expect(lf(readFileSync(join(src, "README.md"), "utf8"))).toBe("v1\n");
  expect(existsSync(join(src, "untracked.txt"))).toBe(false);
  expect(readFileSync(join(record, "argv"), "utf8")).toBe(`extract\n${src}\n--code-only\n\nquery\nalpha\n\nquery\nbeta\n\n`);
});

test("concurrent repo.index and code__search build the index once", async () => {
  const { repo, nemaHome } = setupOrigin();
  const record = join(root, "record");
  mkdirSync(record);
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record + "/argv")}, args[0] + "\\n");
const finish = () => {
  if (args[0] === "extract") {
    fs.mkdirSync("graphify-out", { recursive: true });
    fs.writeFileSync("graphify-out/graph.json", "{}");
  }
  if (args[0] === "query") process.stdout.write("hits:" + args[1]);
};
if (args[0] === "extract") setTimeout(finish, 1000); else finish();
`);

  const rpc = routerFor(nemaHome);
  const [indexed, searched] = await Promise.all([
    rpc.handle({ type: "rpc.request", id: "i", method: "repo.index", params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main" } }),
    rpc.handle(pluginCall("s", repo, "code__search", { repo: "repo_demo", query: "alpha" })),
  ]);

  expect(indexed.ok).toBe(true);
  expect(searched).toEqual({ type: "rpc.response", id: "s", ok: true, result: "hits:alpha" });
  const calls = readFileSync(join(record, "argv"), "utf8").trim().split("\n");
  expect(calls.filter((c) => c === "extract")).toHaveLength(1);
});

test("a graph.json left without a completed index is rebuilt before querying", async () => {
  const { repo, nemaHome } = setupOrigin();
  const snapshot = join(nemaHome, "ws", "ws_demo", "graphify", "repo_demo");
  mkdirSync(join(snapshot, "graphify-out"), { recursive: true });
  writeFileSync(join(snapshot, "graphify-out", "graph.json"), "partial");
  const record = join(root, "record");
  mkdirSync(record);
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record + "/argv")}, args[0] + "\\n");
const finish = () => {
  if (args[0] === "extract") {
    fs.mkdirSync("graphify-out", { recursive: true });
    fs.writeFileSync("graphify-out/graph.json", "{}");
  }
  if (args[0] === "query") process.stdout.write("hits:" + args[1]);
};
finish();
`);

  const res = await routerFor(nemaHome).handle(pluginCall("s", repo, "code__search", { repo: "repo_demo", query: "alpha" }));

  expect(res).toEqual({ type: "rpc.response", id: "s", ok: true, result: "hits:alpha" });
  expect(readFileSync(join(record, "argv"), "utf8")).toBe("extract\nquery\n");
});

test("plugin.call code__explain and code__path query the built index", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "v1\n");
  commitAll(repo, "init");

  const record = join(root, "record");
  mkdirSync(record);
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record + "/argv")}, args.join("\\n") + "\\n");
fs.appendFileSync(${JSON.stringify(record + "/argv")}, "\\n");
if (args[0] === "extract") {
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
}
if (args[0] === "explain") {
process.stdout.write("sym:" + args[1]);
}
if (args[0] === "path") {
process.stdout.write("via:" + args[1] + ":" + args[2]);
}
`);

  const rpc = routerFor(nemaHome);
  const explained = await rpc.handle(pluginCall("explain", repo, "code__explain", { symbol: "Widget" }));
  const linked = await rpc.handle(pluginCall("path", repo, "code__path", { from: "Widget", to: "Button" }));
  const src = join(nemaHome, "ws", "ws_demo", "graphify", "repo_demo", "src");
  expect(explained).toEqual({ type: "rpc.response", id: "explain", ok: true, result: "sym:Widget" });
  expect(linked).toEqual({ type: "rpc.response", id: "path", ok: true, result: "via:Widget:Button" });
  expect(readFileSync(join(record, "argv"), "utf8")).toBe(
    `extract\n${src}\n--code-only\n\nexplain\nWidget\n\npath\nWidget\nButton\n\n`,
  );
});

test("plugin.call code__changes lists files from the given sha to the main ref", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const parent = commitAll(repo, "base");
  writeFileSync(join(repo, "a.txt"), "b\n");
  writeFileSync(join(repo, "b.txt"), "new\n");
  commitAll(repo, "edit");

  const res = await routerFor(nemaHome).handle(pluginCall("chg", repo, "code__changes", { from: parent }));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const rows = res.result as { status: string; path: string }[];
  expect(rows.map((row) => `${row.status} ${row.path}`).sort()).toEqual(["A b.txt", "M a.txt"]);
});

test("plugin.call code__changes omits to as the bound branch sha when origin HEAD is another branch", async () => {
  const { repo, nemaHome } = setupOrigin();
  git(repo, ["checkout", "-b", "develop"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const parent = commitAll(repo, "base");
  writeFileSync(join(repo, "a.txt"), "b\n");
  writeFileSync(join(repo, "b.txt"), "new\n");
  commitAll(repo, "edit");
  git(repo, ["push", "-u", "origin", "develop"]);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  expect(git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]).trim()).toBe("refs/remotes/origin/main");

  const res = await routerFor(nemaHome).handle(
    pluginCall("chg-develop", repo, "code__changes", { from: parent }, "develop"),
  );

  expect(res).not.toMatchObject({ error: "无效的提交 origin/develop" });
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const rows = res.result as { status: string; path: string }[];
  expect(rows.map((row) => `${row.status} ${row.path}`).sort()).toEqual(["A b.txt", "M a.txt"]);
});

test("code__changes rejects a sha that is not on main, including an unpushed local commit", async () => {
  const { repo, nemaHome } = setupOrigin();
  const pushed = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["checkout", "-b", "side"]);
  writeFileSync(join(repo, "side.txt"), "side\n");
  const side = commitAll(repo, "side");
  git(repo, ["checkout", "main"]);
  writeFileSync(join(repo, "local.txt"), "local\n");
  const unpushed = commitAll(repo, "unpushed");
  const rpc = routerFor(nemaHome);

  await expect(rpc.handle(pluginCall("side", repo, "code__changes", { from: side }))).resolves.toMatchObject({
    ok: false,
    error: `提交 ${side} 不在主分支上`,
  });
  await expect(rpc.handle(pluginCall("unpushed", repo, "code__changes", { from: unpushed }))).resolves.toMatchObject({
    ok: false,
    error: `提交 ${unpushed} 不在主分支上`,
  });
  await expect(rpc.handle(pluginCall("to-side", repo, "code__changes", { from: pushed, to: side }))).resolves.toMatchObject({
    ok: false,
    error: `提交 ${side} 不在主分支上`,
  });
  await expect(rpc.handle(pluginCall("head", repo, "code__changes", { from: "HEAD" }))).resolves.toMatchObject({
    ok: false,
    error: "提交 HEAD 不在主分支上",
  });
  await expect(rpc.handle(pluginCall("main-ref", repo, "code__changes", { from: pushed, to: "origin/main" }))).resolves.toMatchObject({
    ok: true,
    result: [],
  });
});

test("repo.changes lists files between two main shas and rejects a sha off main", async () => {
  const { repo, nemaHome } = setupOrigin();
  const from = git(repo, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repo, "README.md"), "v2\n");
  writeFileSync(join(repo, "b.txt"), "new\n");
  const to = commitAll(repo, "edit");
  git(repo, ["push", "origin", "main"]);
  git(repo, ["checkout", "-b", "side"]);
  writeFileSync(join(repo, "side.txt"), "side\n");
  const side = commitAll(repo, "side");
  git(repo, ["checkout", "main"]);
  const rpc = routerFor(nemaHome);
  const call = (id: string, f: string, t: string) => ({
    type: "rpc.request" as const,
    id,
    method: "repo.changes",
    params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main", from: f, to: t },
  });

  const res = await rpc.handle(call("ok", from, to));
  expect(res.ok).toBe(true);
  if (!res.ok) return;
  const rows = res.result as { status: string; path: string }[];
  expect(rows.map((row) => `${row.status} ${row.path}`).sort()).toEqual(["A b.txt", "M README.md"]);

  await expect(rpc.handle(call("side", from, side))).resolves.toMatchObject({ ok: false, error: `提交 ${side} 不在主分支上` });
  await expect(
    rpc.handle({ type: "rpc.request", id: "bad", method: "repo.changes", params: { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main", from } }),
  ).resolves.toMatchObject({ ok: false });
});

test("handlers use the injected graphify binary and ignore NEMA_GRAPHIFY_BIN", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const savedBin = process.env.NEMA_GRAPHIFY_BIN;
  process.env.NEMA_GRAPHIFY_BIN = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdout.write("graphify from-env\\n");
`);
  closers.push(() => {
    if (savedBin === undefined) delete process.env.NEMA_GRAPHIFY_BIN;
    else process.env.NEMA_GRAPHIFY_BIN = savedBin;
  });
  const injected = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdout.write("graphify injected\\n");
`);
  const rpc = new RpcRouter();
  registerRepoHandlers(rpc, { nemaHome, graphify: { bin: injected }, github: missingGithub(nemaHome) });
  await expect(rpc.handle({ type: "rpc.request", id: "status", method: "plugins.status", params: {} })).resolves.toMatchObject({
    ok: true,
    result: { code: { installed: true, detail: "graphify injected" } },
  });
});

test("plugin.call rejects missing args with the field name", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const rpc = routerFor(nemaHome);
  const repoPath = join(root, "missing-repo");
  const rejected = async (name: string, args: unknown) => rpc.handle(pluginCall(name, repoPath, name, args));

  await expect(rejected("code__search", {})).resolves.toMatchObject({ ok: false, error: "code__search 参数无效：query" });
  await expect(rejected("code__search", { query: 1 })).resolves.toMatchObject({ ok: false, error: "code__search 参数无效：query" });
  await expect(rejected("code__explain", { symbol: null })).resolves.toMatchObject({ ok: false, error: "code__explain 参数无效：symbol" });
  await expect(rejected("code__path", { from: "A" })).resolves.toMatchObject({ ok: false, error: "code__path 参数无效：to" });
  await expect(rejected("code__path", { to: "B" })).resolves.toMatchObject({ ok: false, error: "code__path 参数无效：from" });
  await expect(rejected("code__read", {})).resolves.toMatchObject({ ok: false, error: "code__read 参数无效：path" });
  await expect(rejected("code__read", { path: 1 })).resolves.toMatchObject({ ok: false, error: "code__read 参数无效：path" });
  await expect(rejected("code__read", { path: "a.ts", startLine: 0 })).resolves.toMatchObject({
    ok: false,
    error: "code__read 参数无效：startLine",
  });
  await expect(rejected("code__read", { path: "a.ts", endLine: "9" })).resolves.toMatchObject({
    ok: false,
    error: "code__read 参数无效：endLine",
  });
  await expect(rejected("code__changes", {})).resolves.toMatchObject({ ok: false, error: "code__changes 参数无效：from" });
  await expect(rejected("code__changes", { from: "abc1234", to: 2 })).resolves.toMatchObject({
    ok: false,
    error: "code__changes 参数无效：to",
  });
  await expect(rejected("nope", {})).resolves.toMatchObject({ ok: false, error: "未知函数 nope" });
});

test("plugins.status reports installed with the version, or the install hint", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const record = join(root, "version-argv");
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(record)}, args.join("\\n") + "\\n");
process.stdout.write("graphify 1.2.3\\n");
`);
  const rpc = routerFor(nemaHome);
  const installed = await rpc.handle({ type: "rpc.request", id: "st", method: "plugins.status", params: {} });
  expect(installed).toEqual({
    type: "rpc.response",
    id: "st",
    ok: true,
    result: { code: { installed: true, detail: "graphify 1.2.3" }, github: GITHUB_MISSING },
  });
  expect(readFileSync(record, "utf8")).toBe("--version\n");

  fake.bin = join(root, "missing-graphify");
  const missing = await rpc.handle({ type: "rpc.request", id: "st2", method: "plugins.status", params: {} });
  expect(missing).toEqual({
    type: "rpc.response",
    id: "st2",
    ok: true,
    result: { code: { installed: false, detail: "graphify 未安装：请运行 uv tool install graphifyy" }, github: GITHUB_MISSING },
  });
});

test("startDaemon passes the repo router into the daemon connection", async () => {
  const port = await startHub();
  const nemaHome = join(root, "nema-home");
  const snapshot = join(nemaHome, "ws", "ws_live", "graphify", "repo_live");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, "keep.txt"), "x\n");
  const daemon = startDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "tk",
    nemaHome,
    userCodexHome: join(root, "codex"),
    version: "0.0.0",
    graphify: fake,
    github: missingGithub(nemaHome),
  });
  closers.push(() => daemon.close());
  for (let i = 0; i < 100 && conns.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const ws = conns[0]!;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for rpc.response")), 3000);
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type === "rpc.response") {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
  ws.send(JSON.stringify({
    type: "rpc.request",
    id: "live",
    method: "repo.forget",
    params: { workspaceId: "ws_live", repoId: "repo_live", path: "/repo", mainBranch: "main" },
  }));
  await expect(response).resolves.toMatchObject({ type: "rpc.response", id: "live", ok: true });
  expect(existsSync(snapshot)).toBe(false);
});

test("repo.exists reports missing paths and rejects ..", async () => {
  const { repo, nemaHome } = setupOrigin();
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "a\n");
  commitAll(repo, "a");
  git(repo, ["push", "origin", "main"]);
  writeFileSync(join(repo, "src", "local-only.ts"), "x\n");
  commitAll(repo, "local");

  const rpc = routerFor(nemaHome);
  const base = { workspaceId: "ws_demo", repoId: "repo_demo", path: repo, mainBranch: "main" };
  const ok = await rpc.handle({
    type: "rpc.request",
    id: "ex1",
    method: "repo.exists",
    params: { ...base, paths: ["src/a.ts", "README.md", "src/nope.ts", "src/local-only.ts"] },
  });
  expect(ok).toMatchObject({ ok: true, result: { missing: ["src/nope.ts", "src/local-only.ts"] } });

  const bad = await rpc.handle({ type: "rpc.request", id: "ex2", method: "repo.exists", params: { ...base, paths: ["../x"] } });
  expect(bad).toMatchObject({ ok: false });
  const abs = await rpc.handle({ type: "rpc.request", id: "ex3", method: "repo.exists", params: { ...base, paths: ["/etc/passwd"] } });
  expect(abs).toMatchObject({ ok: false });
});
