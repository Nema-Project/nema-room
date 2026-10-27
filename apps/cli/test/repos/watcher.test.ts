import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lf } from "../windowsEnv.js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { startDaemon } from "../../src/daemon/setup.js";
import { RpcRouter } from "../../src/daemon/rpc.js";
import { registerRepoHandlers } from "../../src/repos/handlers.js";
import type { GraphifyOpts } from "../../src/repos/graphify.js";
import { RepoWatcher, type WatchedRepo } from "../../src/repos/watcher.js";

let root: string;
let savedHome: string | undefined;
/** Handed to the watcher and handlers; a test fills in `bin` before the tick that spawns graphify. */
let fake: GraphifyOpts;
let server: http.Server | undefined;
let wss: WebSocketServer | undefined;
let conns: WebSocket[] = [];
const closers: Array<() => Promise<void>> = [];

const WS = "ws_watch";
const REPO = "repo_watch";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-watcher-"));
  savedHome = process.env.HOME;
  fake = { bin: join(root, "missing-graphify") };
  mkdirSync(join(root, "home"));
  process.env.HOME = join(root, "home");
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  if (wss) for (const client of wss.clients) client.terminate();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
  wss = undefined;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
  conns = [];
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

function setupOrigin(): { repo: string; bare: string; nemaHome: string } {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const bare = join(root, "origin.git");
  git(root, ["init", "--bare", "-b", "main", bare]);
  const repo = join(root, "repo");
  initRepo(repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  commitAll(repo, "init");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { repo, bare, nemaHome };
}

function writeBin(body: string): string {
  const file = join(root, `graphify-${Math.random().toString(16).slice(2)}`);
  writeFileSync(file, body, { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

function installGraphify(record: string): void {
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
fs.appendFileSync(${JSON.stringify(record)}, process.argv.slice(2).join("\\n") + "\\n---\\n");
`);
}

/** Marks the snapshot as indexed at `sha`, so a move takes the incremental update path. */
function seedIndex(nemaHome: string, sha: string, repoId = REPO): void {
  const snapshot = join(nemaHome, "ws", WS, "graphify", repoId);
  mkdirSync(join(snapshot, "graphify-out"), { recursive: true });
  writeFileSync(join(snapshot, "graphify-out", "graph.json"), "{}");
  writeFileSync(join(snapshot, "indexed-sha"), sha);
}

function worktree(repo: string): { status: string; main: string } {
  return {
    status: git(repo, ["status", "--porcelain"]),
    main: git(repo, ["rev-parse", "main"]).trim(),
  };
}

function pushFile(bare: string, name: string, contents: string): string {
  const other = join(root, "other");
  if (!existsSync(other)) {
    git(root, ["clone", bare, other]);
    git(other, ["config", "user.email", "test@example.com"]);
    git(other, ["config", "user.name", "Test"]);
  }
  writeFileSync(join(other, name), contents);
  const sha = commitAll(other, `add ${name}`);
  git(other, ["push", "origin", "main"]);
  return sha;
}

type FetchReport = { repoId: string; ok: boolean; error?: string; at: string };
type MoveReport = { repoId: string; mainRef: string; from: string | null; to: string };

function watch(nemaHome: string): { watcher: RepoWatcher; fetches: FetchReport[]; moves: MoveReport[] } {
  const fetches: FetchReport[] = [];
  const moves: MoveReport[] = [];
  const watcher = new RepoWatcher({
    nemaHome,
    graphify: fake,
    onFetch: (report) => fetches.push(report),
    onMoved: (move) => {
      moves.push(move);
    },
  });
  return { watcher, fetches, moves };
}

function watched(repo: string, lastMainSha: string | null, repoId = REPO): WatchedRepo {
  return { workspaceId: WS, repoId, path: repo, mainBranch: "main", lastMainSha };
}

function expectIso(at: string): void {
  expect(Number.isNaN(Date.parse(at))).toBe(false);
  expect(at).toBe(new Date(at).toISOString());
}

// git clone/fetch plus a graphify spawn can exceed 5s when the suite runs in parallel.
function gitTest(name: string, body: () => Promise<void>): void {
  test(name, body, 20_000);
}

gitTest("start does not fetch on a timer", async () => {
  const { repo, nemaHome } = setupOrigin();
  const fetches: FetchReport[] = [];
  const watcher = new RepoWatcher({
    nemaHome,
    intervalMs: 15,
    graphify: fake,
    onFetch: (report) => fetches.push(report),
    onMoved: () => {},
  });
  watcher.setRepos([watched(repo, null)]);
  watcher.start();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(fetches).toEqual([]);
  await watcher.stop();
});

gitTest("prepare fetches once per task and a later task fetches again", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const before = git(repo, ["rev-parse", "origin/main"]).trim();
  const { watcher, fetches } = watch(nemaHome);
  watcher.setRepos([watched(repo, before)]);
  await watcher.prepare(REPO, "task-1");
  expect(fetches).toHaveLength(1);
  pushFile(bare, "later.txt", "next\n");
  await watcher.prepare(REPO, "task-1");
  expect(fetches).toHaveLength(1);
  expect(git(repo, ["rev-parse", "origin/main"]).trim()).toBe(before);
  await watcher.prepare(REPO, "task-2");
  expect(fetches).toHaveLength(2);
  expect(git(repo, ["rev-parse", "origin/main"]).trim()).not.toBe(before);
  await watcher.stop();
});

gitTest("tick fetches, detects a new origin/main sha, updates the index with the changed files and reports moved", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const before = git(repo, ["rev-parse", "origin/main"]).trim();
  writeFileSync(join(repo, "README.md"), "dirty\n");
  const tree = worktree(repo);
  const next = pushFile(bare, "remote-only.txt", "from-origin\n");
  const record = join(root, "graphify-record");
  installGraphify(record);
  seedIndex(nemaHome, before);

  const { watcher, fetches, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, before)]);
  await watcher.tick();

  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toEqual({ repoId: REPO, ok: true, at: fetches[0]!.at });
  expectIso(fetches[0]!.at);
  expect(moves).toEqual([{ repoId: REPO, mainRef: "origin/main", from: before, to: next }]);
  const src = join(nemaHome, "ws", WS, "graphify", REPO, "src");
  expect(readFileSync(join(src, "remote-only.txt"), "utf8")).toBe("from-origin\n");
  expect(readFileSync(record, "utf8")).toContain(`update\n${src}\n`);
  expect(worktree(repo)).toEqual(tree);
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("dirty\n");
});

gitTest("tick with no change reports a fetch but not a move", async () => {
  const { repo, nemaHome } = setupOrigin();
  const sha = git(repo, ["rev-parse", "origin/main"]).trim();
  const tree = worktree(repo);
  const record = join(root, "graphify-record");
  installGraphify(record);
  seedIndex(nemaHome, sha);

  const { watcher, fetches, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, sha)]);
  await watcher.tick();

  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toMatchObject({ repoId: REPO, ok: true });
  expect(fetches[0]).not.toHaveProperty("error");
  expect(moves).toEqual([]);
  expect(existsSync(record)).toBe(false);
  expect(worktree(repo)).toEqual(tree);
});

gitTest("fetch failing offline keeps the last sha, reports the error, and code__read still works on the last known ref", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const sha = git(repo, ["rev-parse", "origin/main"]).trim();
  writeFileSync(join(repo, "README.md"), "DIRTY\n");
  const tree = worktree(repo);
  git(repo, ["remote", "set-url", "origin", join(root, "missing-origin")]);
  const record = join(root, "graphify-record");
  installGraphify(record);
  seedIndex(nemaHome, sha);

  const { watcher, fetches, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, sha)]);
  await watcher.tick();

  expect(moves).toEqual([]);
  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toMatchObject({ repoId: REPO, ok: false });
  expect(fetches[0]!.error).toEqual(expect.any(String));
  expect(fetches[0]!.error!.length).toBeGreaterThan(0);
  expectIso(fetches[0]!.at);
  expect(existsSync(record)).toBe(false);
  expect(git(repo, ["rev-parse", "origin/main"]).trim()).toBe(sha);
  expect(worktree(repo)).toEqual(tree);

  const rpc = new RpcRouter();
  registerRepoHandlers(rpc, { nemaHome, graphify: fake });
  const read = await rpc.handle({
    type: "rpc.request",
    id: "read",
    method: "plugin.call",
    params: {
      name: "code__read",
      args: { path: "README.md" },
      repo: { workspaceId: WS, repoId: REPO, path: repo, mainBranch: "main" },
    },
  });
  expect(read).toMatchObject({
    ok: true,
    result: { path: "README.md", text: "hello" },
  });
  expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("DIRTY\n");

  git(repo, ["remote", "set-url", "origin", bare]);
  const next = pushFile(bare, "remote-only.txt", "later\n");
  await watcher.tick();
  expect(moves).toEqual([{ repoId: REPO, mainRef: "origin/main", from: sha, to: next }]);
  expect(worktree(repo)).toEqual(tree);
});

gitTest("a repo without origin follows the local branch", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const first = commitAll(repo, "init");
  const record = join(root, "graphify-record");
  installGraphify(record);
  seedIndex(nemaHome, first);

  const { watcher, fetches, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, first)]);
  await watcher.tick();

  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toMatchObject({ repoId: REPO, ok: false, error: "没有 origin" });
  expect(moves).toEqual([]);
  expect(existsSync(record)).toBe(false);

  writeFileSync(join(repo, "a.txt"), "b\n");
  const second = commitAll(repo, "next");
  const tree = worktree(repo);
  await watcher.tick();

  expect(fetches).toHaveLength(2);
  expect(fetches[1]).toMatchObject({ repoId: REPO, ok: false, error: "没有 origin" });
  expect(moves).toEqual([{ repoId: REPO, mainRef: "main", from: first, to: second }]);
  expect(readFileSync(join(nemaHome, "ws", WS, "graphify", REPO, "src", "a.txt"), "utf8")).toBe("b\n");
  expect(readFileSync(record, "utf8")).toContain("update\n");
  expect(worktree(repo)).toEqual(tree);
});

gitTest("when lastMainSha is null the first tick records the sha and a later tick indexes the change", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const first = git(repo, ["rev-parse", "origin/main"]).trim();
  const tree = worktree(repo);
  const record = join(root, "graphify-record");
  installGraphify(record);
  seedIndex(nemaHome, first);

  const { watcher, fetches, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, null)]);
  await watcher.tick();

  expect(fetches).toHaveLength(1);
  expect(fetches[0]).toMatchObject({ repoId: REPO, ok: true });
  expect(moves).toEqual([]);
  expect(existsSync(record)).toBe(false);
  expect(worktree(repo)).toEqual(tree);

  watcher.setRepos([watched(repo, null)]);
  const next = pushFile(bare, "remote-only.txt", "after-baseline\n");
  await watcher.tick();

  expect(moves).toEqual([{ repoId: REPO, mainRef: "origin/main", from: first, to: next }]);
  expect(readFileSync(join(nemaHome, "ws", WS, "graphify", REPO, "src", "remote-only.txt"), "utf8")).toBe("after-baseline\n");
  expect(worktree(repo)).toEqual(tree);
});

gitTest("a missing index is rebuilt in full from the new sha and the move is still reported", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const before = git(repo, ["rev-parse", "origin/main"]).trim();
  const next = pushFile(bare, "remote-only.txt", "from-origin\n");
  const record = join(root, "graphify-record");
  installGraphify(record);

  const { watcher, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, before)]);
  await watcher.tick();

  const src = join(nemaHome, "ws", WS, "graphify", REPO, "src");
  expect(moves).toEqual([{ repoId: REPO, mainRef: "origin/main", from: before, to: next }]);
  expect(readFileSync(record, "utf8")).toBe(`extract\n${src}\n--code-only\n---\n`);
  expect(lf(readFileSync(join(src, "README.md"), "utf8"))).toBe("hello\n");
  expect(lf(readFileSync(join(src, "remote-only.txt"), "utf8"))).toBe("from-origin\n");
});

gitTest("a thrown index still reports the move, stores the sha, and the next repo is fetched", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const firstDir = join(root, "first");
  const secondDir = join(root, "second");
  initRepo(firstDir);
  initRepo(secondDir);
  writeFileSync(join(firstDir, "a.txt"), "a\n");
  const firstBase = commitAll(firstDir, "init");
  writeFileSync(join(secondDir, "b.txt"), "b\n");
  const secondSha = commitAll(secondDir, "init");
  writeFileSync(join(firstDir, "a.txt"), "changed\n");
  const firstNext = commitAll(firstDir, "next");
  const record = join(root, "graphify-record");
  const flag = join(root, "graphify-fail-once");
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2).join("\\n");
fs.appendFileSync(${JSON.stringify(record)}, args + "\\n---\\n");
if (args.includes("repo_first") && !fs.existsSync(${JSON.stringify(flag)})) {
  fs.writeFileSync(${JSON.stringify(flag)}, "1");
  process.stderr.write("index failed\\n");
  process.exit(1);
}
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  const { watcher, fetches, moves } = watch(nemaHome);
  watcher.setRepos([
    watched(firstDir, firstBase, "repo_first"),
    watched(secondDir, secondSha, "repo_second"),
  ]);
  await watcher.tick();

  expect(fetches.map((report) => report.repoId)).toEqual(["repo_first", "repo_second"]);
  expect(fetches[1]).toMatchObject({ repoId: "repo_second", ok: false, error: "没有 origin" });
  expect(moves).toEqual([{ repoId: "repo_first", mainRef: "main", from: firstBase, to: firstNext }]);
  expect(errors.mock.calls.some((args) => args.join(" ").includes("repo_first"))).toBe(true);

  await watcher.tick();
  expect(moves).toHaveLength(1);
  errors.mockRestore();
});

gitTest("onMoved throws or does not send, the recorded sha does not advance, and a later tick calls onMoved again", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const base = commitAll(repo, "init");
  writeFileSync(join(repo, "a.txt"), "b\n");
  const next = commitAll(repo, "next");
  const record = join(root, "graphify-record");
  installGraphify(record);
  const moves: MoveReport[] = [];
  let gate: "throw" | "drop" | "send" = "throw";
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const watcher = new RepoWatcher({
    nemaHome,
    graphify: fake,
    onFetch: () => {},
    onMoved: (move) => {
      moves.push(move);
      if (gate === "throw") throw new Error("send failed");
      if (gate === "drop") return false;
    },
  });
  watcher.setRepos([watched(repo, base)]);

  await watcher.tick();
  expect(moves).toEqual([{ repoId: REPO, mainRef: "main", from: base, to: next }]);

  gate = "send";
  await watcher.tick();
  expect(moves).toEqual([
    { repoId: REPO, mainRef: "main", from: base, to: next },
    { repoId: REPO, mainRef: "main", from: base, to: next },
  ]);
  // The index is already at `next`, so resending the move does not rebuild it.
  expect(readFileSync(record, "utf8").split("---").filter((line) => line.trim())).toHaveLength(1);

  writeFileSync(join(repo, "a.txt"), "c\n");
  const later = commitAll(repo, "later");
  gate = "drop";
  await watcher.tick();
  expect(moves.at(-1)).toEqual({ repoId: REPO, mainRef: "main", from: next, to: later });

  gate = "send";
  await watcher.tick();
  expect(moves.filter((move) => move.from === next && move.to === later)).toHaveLength(2);
  errors.mockRestore();
});

gitTest("a second tick during updateIndex waits and updates the index once", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const base = commitAll(repo, "init");
  writeFileSync(join(repo, "a.txt"), "b\n");
  const next = commitAll(repo, "next");
  const record = join(root, "graphify-record");
  const started = join(root, "update-started");
  const release = join(root, "update-release");
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(record)}, "update\\n");
fs.writeFileSync(${JSON.stringify(started)}, "1");
const deadline = Date.now() + 15000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() > deadline) process.exit(2);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`);
  const moves: MoveReport[] = [];
  const watcher = new RepoWatcher({
    nemaHome,
    graphify: fake,
    onFetch: () => {},
    onMoved: (move) => {
      moves.push(move);
    },
  });
  watcher.setRepos([watched(repo, base)]);
  let first: Promise<void> | undefined;
  try {
    first = watcher.tick();
    const deadline = Date.now() + 5000;
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error("updateIndex did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const second = watcher.tick();
    expect(second).toBe(first);
    writeFileSync(release, "1");
    await first;
    expect(readFileSync(record, "utf8")).toBe("update\n");
    expect(moves).toEqual([{ repoId: REPO, mainRef: "main", from: base, to: next }]);
  } finally {
    writeFileSync(release, "1");
    await first;
  }
});

async function startHub(): Promise<number> {
  const httpServer = http.createServer();
  server = httpServer;
  wss = new WebSocketServer({ server, path: "/daemon" });
  wss.on("connection", (ws) => conns.push(ws));
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  return (httpServer.address() as AddressInfo).port;
}

function nextMsg(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      if (message.type === type) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(message);
      }
    };
    ws.on("message", onMessage);
  });
}

gitTest("a failed incremental update drops the index marker and the next tick rebuilds in full", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const before = git(repo, ["rev-parse", "origin/main"]).trim();
  seedIndex(nemaHome, before);
  const record = join(root, "graphify-record");
  const failOnce = join(root, "fail-once");
  writeFileSync(failOnce, "");
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
const cmd = process.argv[2];
fs.appendFileSync(${JSON.stringify(record)}, cmd + "\\n");
if (cmd === "update" && fs.existsSync(${JSON.stringify(failOnce)})) { fs.rmSync(${JSON.stringify(failOnce)}); process.exit(1); }
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`);
  const next = pushFile(bare, "remote-only.txt", "from-origin\n");
  const marker = join(nemaHome, "ws", WS, "graphify", REPO, "indexed-sha");

  const { watcher, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, before)]);
  await watcher.tick();

  expect(moves).toEqual([{ repoId: REPO, mainRef: "origin/main", from: before, to: next }]);
  expect(existsSync(marker)).toBe(false);

  await watcher.tick();

  expect(readFileSync(record, "utf8")).toBe("update\nextract\n");
  expect(readFileSync(marker, "utf8")).toBe(next);
  expect(moves).toHaveLength(1);
});

gitTest("startDaemon sends repo.fetched and repo.moved when tick sees a new sha", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const before = git(repo, ["rev-parse", "origin/main"]).trim();
  const next = pushFile(bare, "remote-only.txt", "from-origin\n");
  installGraphify(join(root, "graphify-record"));
  const port = await startHub();
  const daemon = startDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "tk",
    nemaHome,
    userCodexHome: join(root, "codex"),
    version: "0.0.0",
    cliEntry: join(root, "index.js"),
    graphify: fake,
  });
  closers.push(() => daemon.close());
  for (let i = 0; i < 100 && conns.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const ws = conns[0]!;
  const response = nextMsg(ws, "rpc.response");
  ws.send(
    JSON.stringify({
      type: "rpc.request",
      id: "sync",
      method: "repos.sync",
      params: { repos: [watched(repo, before)] },
    }),
  );
  await expect(response).resolves.toMatchObject({ type: "rpc.response", id: "sync", ok: true });

  const fetched = nextMsg(ws, "repo.fetched");
  const moved = nextMsg(ws, "repo.moved");
  await daemon.watcher.tick();

  const fetchMessage = await fetched;
  expect(fetchMessage).toMatchObject({ type: "repo.fetched", repoId: REPO, ok: true });
  expect(fetchMessage).not.toHaveProperty("error");
  expect(await moved).toEqual({ type: "repo.moved", repoId: REPO, mainRef: "origin/main", from: before, to: next });
});

gitTest("tickRepo ticks only the named repo; an unknown repo is a no-op", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const before = git(repo, ["rev-parse", "origin/main"]).trim();
  const next = pushFile(bare, "remote-only.txt", "from-origin\n");
  installGraphify(join(root, "graphify-record"));
  const { watcher, fetches, moves } = watch(nemaHome);
  watcher.setRepos([watched(repo, before), watched(repo, before, "repo_other")]);

  await watcher.tickRepo("repo_unknown");
  expect(fetches).toEqual([]);

  await watcher.tickRepo(REPO);
  expect(fetches.map((f) => f.repoId)).toEqual([REPO]);
  expect(moves).toEqual([{ repoId: REPO, mainRef: "origin/main", from: before, to: next }]);
});

gitTest("startDaemon answers repo.tick at once and then ticks that repo", async () => {
  const { repo, bare, nemaHome } = setupOrigin();
  const before = git(repo, ["rev-parse", "origin/main"]).trim();
  const next = pushFile(bare, "remote-only.txt", "from-origin\n");
  installGraphify(join(root, "graphify-record"));
  const port = await startHub();
  const daemon = startDaemon({
    hubUrl: `http://127.0.0.1:${port}`,
    token: "tk",
    nemaHome,
    userCodexHome: join(root, "codex"),
    version: "0.0.0",
    cliEntry: join(root, "index.js"),
    graphify: fake,
  });
  closers.push(() => daemon.close());
  for (let i = 0; i < 100 && conns.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const ws = conns[0]!;
  const synced = nextMsg(ws, "rpc.response");
  ws.send(JSON.stringify({ type: "rpc.request", id: "sync", method: "repos.sync", params: { repos: [watched(repo, before)] } }));
  await expect(synced).resolves.toMatchObject({ id: "sync", ok: true });

  const ticked = nextMsg(ws, "rpc.response");
  const moved = nextMsg(ws, "repo.moved");
  ws.send(JSON.stringify({ type: "rpc.request", id: "tick", method: "repo.tick", params: { repoId: REPO } }));
  await expect(ticked).resolves.toMatchObject({ id: "tick", ok: true });
  expect(await moved).toEqual({ type: "repo.moved", repoId: REPO, mainRef: "origin/main", from: before, to: next });

  const bad = nextMsg(ws, "rpc.response");
  ws.send(JSON.stringify({ type: "rpc.request", id: "bad", method: "repo.tick", params: {} }));
  await expect(bad).resolves.toMatchObject({ id: "bad", ok: false });
});

gitTest("a repo removed during a tick is not reported and its snapshot is gone", async () => {
  const nemaHome = join(root, "nema-home");
  mkdirSync(nemaHome);
  const repo = join(root, "local");
  initRepo(repo);
  writeFileSync(join(repo, "a.txt"), "a\n");
  const base = commitAll(repo, "init");
  writeFileSync(join(repo, "a.txt"), "b\n");
  commitAll(repo, "next");
  const started = join(root, "extract-started");
  const release = join(root, "extract-release");
  const bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(started)}, "1");
const deadline = Date.now() + 15000;
while (!fs.existsSync(${JSON.stringify(release)})) {
  if (Date.now() > deadline) process.exit(2);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
fs.mkdirSync("graphify-out", { recursive: true });
fs.writeFileSync("graphify-out/graph.json", "{}");
`);
  const moves: MoveReport[] = [];
  const watcher = new RepoWatcher({
    nemaHome,
    graphify: { bin },
    onFetch: () => {},
    onMoved: (move) => {
      moves.push(move);
    },
  });
  watcher.setRepos([watched(repo, base)]);
  const snapshot = join(nemaHome, "ws", WS, "graphify", REPO);
  let first: Promise<void> | undefined;
  try {
    first = watcher.tick();
    const deadline = Date.now() + 5000;
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error("extract did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    watcher.setRepos([]);
    writeFileSync(release, "1");
    await first;
    expect(moves).toEqual([]);
    expect(existsSync(snapshot)).toBe(false);
  } finally {
    writeFileSync(release, "1");
    await first;
  }
});

test("stop waits for active tick and prevents queued ticks", async () => {
  const { repo, nemaHome } = setupOrigin();
  const started = join(root, "stop-started");
  const release = join(root, "stop-release");
  fake.bin = writeBin(`#!/usr/bin/env node
const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "1");
const until = Date.now() + 10000; while (!fs.existsSync(${JSON.stringify(release)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
fs.mkdirSync("graphify-out", {recursive:true}); fs.writeFileSync("graphify-out/graph.json", "{}");
`);
  const { watcher } = watch(nemaHome);
  watcher.setRepos([watched(repo, git(repo, ["rev-parse", "HEAD"]).trim())]);
  const tick = watcher.tick();
  const deadline = Date.now() + 5000;
  while (!existsSync(started) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(existsSync(started)).toBe(true);
  const stopping = watcher.stop();
  const queued = watcher.tickRepo(REPO);
  let settled = false;
  void stopping.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 50));
  expect(settled).toBe(false);
  expect(watcher.stop()).toBe(stopping);
  writeFileSync(release, "1");
  await Promise.all([tick, queued, stopping]);
  expect(settled).toBe(true);
});
