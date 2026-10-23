import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { afterAll, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { EventBus } from "../src/events.js";
import { postUserMessage } from "../src/messages.js";
import { getRepo, type Repo } from "../src/repos.js";
import { claimNextTask } from "../src/tasks.js";
import { createWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterAll(cleanupHubDeps);

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
        GIT_CONFIG_GLOBAL: "/dev/null",
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

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const name of readdirSync(current)) {
      if (name === ".git") continue;
      const abs = path.join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(abs).isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(dir, "");
  return out.sort();
}

function writeGraphify(file: string): void {
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === "extract" || cmd === "update") {
  fs.mkdirSync("graphify-out", { recursive: true });
  fs.writeFileSync("graphify-out/graph.json", "{}\\n");
  process.exit(0);
}
if (cmd === "query") {
  process.stdout.write("found:" + (args[1] ?? ""));
  process.exit(0);
}
process.stderr.write("unexpected graphify args\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
  chmodSync(file, 0o755);
}

async function waitFor(label: string, predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${label}`);
}

type StartedDaemon = { close(): void; watcher: { tick(): Promise<void> } };

/** Hub's project root stops at apps/hub, so the real daemon is loaded at runtime. */
async function startRealDaemon(opts: {
  hubUrl: string;
  token: string;
  nemaHome: string;
  userCodexHome: string;
  version: string;
  graphify: { bin: string };
}): Promise<StartedDaemon> {
  const href = new URL("../../cli/src/daemon/setup.ts", import.meta.url).href;
  const mod = (await import(href)) as { startDaemon(o: typeof opts): StartedDaemon };
  return mod.startDaemon(opts);
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep the raw body so a non-JSON failure is visible.
  }
  return { status: res.status, json };
}

test("bind, index, and one fetch tick follow origin/main without touching the worktree", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "nema-e2e-"));
  const savedHome = process.env.HOME;
  const home = path.join(root, "home");
  mkdirSync(home);
  process.env.HOME = home;
  const graphify = path.join(root, "graphify.cjs");
  writeGraphify(graphify);

  const nemaHome = path.join(root, "nema-home");
  mkdirSync(nemaHome);
  const bare = path.join(root, "origin.git");
  git(root, ["init", "--bare", "-b", "main", bare]);
  const repo = path.join(root, "repo");
  initRepo(repo);
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  commitAll(repo, "init");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);
  writeFileSync(path.join(repo, "README.md"), "local dirty\n");
  const statusBefore = git(repo, ["status", "--porcelain"]);
  const filesBefore = listFiles(repo);
  const mainBefore = git(repo, ["rev-parse", "main"]).trim();

  const { db, dataDir } = await makeHubDeps();
  const workspace = await createWorkspace(db, dataDir, "API");
  const events = new EventBus();
  let listener: http.RequestListener = (_req, res) => res.end();
  const server = http.createServer((req, res) => listener(req, res));
  let daemon: { close(): void; watcher: { tick(): Promise<void> } } | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const attached = attachDaemonSocket(server, {
      db,
      dataDir,
      events,
      daemonToken: "tok",
      hubUrl: `http://127.0.0.1:${port}`,
    });
    listener = getRequestListener(
      createApp({
        db,
        dataDir,
        nemaHome,
        events,
        daemonStatus: () => attached.isConnected(),
        daemon: attached.rpc,
        port,
      }).fetch,
    );
    daemon = await startRealDaemon({
      hubUrl: `http://127.0.0.1:${port}`,
      token: "tok",
      nemaHome,
      userCodexHome: path.join(root, "codex"),
      version: "0.0.0",
      graphify: { bin: graphify },
    });
    await waitFor("daemon", async () => attached.isConnected());

    const bound = await postJson(`http://127.0.0.1:${port}/api/workspaces/${workspace.id}/repos`, {
      path: repo,
      label: "API",
    });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const boundRepo = bound.json as Repo;
    expect(boundRepo.hasOrigin).toBe(true);
    expect(boundRepo.lastMainSha).toBeNull();

    const snapshot = path.join(nemaHome, "ws", workspace.id, "graphify", boundRepo.id);
    await waitFor("index", async () => {
      try {
        return readFileSync(path.join(snapshot, "graphify-out", "graph.json"), "utf8").length > 0;
      } catch {
        return false;
      }
    });
    expect(readFileSync(path.join(snapshot, "src", "README.md"), "utf8")).toBe("hello\n");

    await postUserMessage(db, workspace.id, "memo");
    const task = await claimNextTask(db, "d1");
    expect(task?.runToken).toBeTruthy();
    const token = task!.runToken!;
    const auth = { authorization: `Bearer ${token}` };

    const read = await postJson(`http://127.0.0.1:${port}/room/plugins/code__read`, { repo: boundRepo.id, path: "README.md" }, auth);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect(read.json).toMatchObject({ result: { path: "README.md", text: "hello" } });

    const search = await postJson(
      `http://127.0.0.1:${port}/room/plugins/code__search`,
      { repo: boundRepo.label, query: "readme" },
      auth,
    );
    expect(search.status, JSON.stringify(search.json)).toBe(200);
    expect(search.json).toEqual({ result: "found:readme" });

    // The indexed sha is stored as the baseline. A tick with no new commit only records the fetch.
    // The single tick after the push is what moves last_main_sha.
    await waitFor("indexed sha", async () => (await getRepo(db, boundRepo.id))?.lastMainSha === mainBefore);
    await daemon.watcher.tick();
    await waitFor("fetched", async () => {
      const row = await getRepo(db, boundRepo.id);
      return row?.lastFetchAt != null && row.lastMainSha === mainBefore;
    });

    const other = path.join(root, "other");
    git(root, ["clone", bare, other]);
    git(other, ["config", "user.email", "test@example.com"]);
    git(other, ["config", "user.name", "Test"]);
    writeFileSync(path.join(other, "README.md"), "from origin\n");
    commitAll(other, "remote");
    git(other, ["push", "origin", "main"]);
    const next = git(other, ["rev-parse", "HEAD"]).trim();
    expect(next).not.toBe(mainBefore);

    await daemon.watcher.tick();
    await waitFor("moved", async () => (await getRepo(db, boundRepo.id))?.lastMainSha === next);
    expect(readFileSync(path.join(snapshot, "src", "README.md"), "utf8")).toBe("from origin\n");

    const again = await postJson(`http://127.0.0.1:${port}/room/plugins/code__read`, { repo: boundRepo.id, path: "README.md" }, auth);
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ result: { path: "README.md", text: "from origin" } });

    expect(git(repo, ["status", "--porcelain"])).toBe(statusBefore);
    expect(listFiles(repo)).toEqual(filesBefore);
    expect(git(repo, ["rev-parse", "main"]).trim()).toBe(mainBefore);
    expect(readFileSync(path.join(repo, "README.md"), "utf8")).toBe("local dirty\n");
  } finally {
    daemon?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
