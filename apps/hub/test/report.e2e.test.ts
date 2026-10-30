import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { afterAll, expect, test } from "vitest";
import type { ReportMessageMeta } from "@nema/shared";
import { createApp } from "../src/app.js";
import type { Db } from "../src/db/db.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { EventBus } from "../src/events.js";
import { getMessage, listMessages, type Message } from "../src/messages.js";
import { registerReportToken, startReportFallback } from "../src/reports.js";
import { getRepo, type Repo } from "../src/repos.js";
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

function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

function writeGraphify(file: string): void {
  writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
const cmd = process.argv[2];
if (cmd === "extract" || cmd === "update") {
  fs.mkdirSync("graphify-out", { recursive: true });
  fs.writeFileSync("graphify-out/graph.json", "{}\\n");
  process.exit(0);
}
process.stderr.write("unexpected graphify args\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
  chmodSync(file, 0o755);
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${label}`);
}

type StartedDaemon = { close(): void; watcher: { tick(): Promise<void> } };
type Out = { log(s: string): void; error(s: string): void };
type SendOpts = { connectMs: number; totalMs: number };
type CliReport = {
  ensureReportToken(nemaHome: string): string;
  runReportHook(o: { agent: string; nemaHome: string; hubUrl: string; stdin: NodeJS.ReadableStream | null; sendOpts?: SendOpts }): Promise<number>;
  runReport(o: {
    nemaHome: string;
    hubUrl: string;
    cwd: string;
    out: Out;
    flags: { agent?: string; summary?: string; commits?: string; entries?: string; files?: string };
    sendOpts?: SendOpts;
  }): Promise<number>;
};

/** Hub's project root stops at apps/hub, so the real daemon and the real `nema report` are loaded at runtime. */
async function loadCli(): Promise<{
  startDaemon(o: {
    hubUrl: string;
    token: string;
    nemaHome: string;
    userCodexHome: string;
    version: string;
    cliEntry: string;
    getConfig: () => never;
    graphify: { bin: string };
  }): StartedDaemon;
  report: CliReport;
}> {
  const setup = (await import(new URL("../../cli/src/daemon/setup.ts", import.meta.url).href)) as { startDaemon: never };
  const commands = (await import(new URL("../../cli/src/report/commands.ts", import.meta.url).href)) as Pick<CliReport, "runReport" | "runReportHook">;
  const token = (await import(new URL("../../cli/src/report/token.ts", import.meta.url).href)) as Pick<CliReport, "ensureReportToken">;
  return { startDaemon: setup.startDaemon, report: { ...commands, ...token } };
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep the raw body so a non-JSON failure is visible.
  }
  return { status: res.status, json };
}

async function taskFor(db: Db, messageId: string): Promise<boolean> {
  return (await db.query(`select 1 from tasks where message_id = $1`, [messageId])).length > 0;
}

const FALLBACK_PREFIX = "主分支有新提交但没有收到上报";
// Generous for a loaded CI box; the production hook still uses 0.5 s / 1.5 s.
const SEND: SendOpts = { connectMs: 5_000, totalMs: 10_000 };

test("hook, report, merge re-check and the no-report fallback against a real hub and daemon", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nema-report-e2e-")));
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
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  const mainBefore = commitAll(repo, "init");
  git(repo, ["remote", "add", "origin", bare]);
  git(repo, ["push", "-u", "origin", "main"]);

  const cli = await loadCli();
  // The daemon's hello carries this token's hash, so `nema report` is authorized by the same hub.
  cli.report.ensureReportToken(nemaHome);

  const { db, dataDir } = await makeHubDeps();
  const workspace = await createWorkspace(db, dataDir, "API");
  const events = new EventBus();
  let listener: http.RequestListener = (_req, res) => res.end();
  const server = http.createServer((req, res) => listener(req, res));
  let daemon: StartedDaemon | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const hubUrl = `http://127.0.0.1:${port}`;
    const attached = attachDaemonSocket(server, { db, dataDir, events, daemonToken: "tok", hubUrl });
    listener = getRequestListener(
      createApp({ db, dataDir, nemaHome, events, daemonStatus: () => attached.isConnected(), daemon: attached.rpc, port }).fetch,
    );
    daemon = cli.startDaemon({
      hubUrl,
      token: "tok",
      nemaHome,
      userCodexHome: path.join(root, "codex"),
      version: "0.0.0",
      cliEntry: path.join(root, "index.js"),
      // No model: any task the hub assigns fails on the config before an adapter is picked.
      getConfig: () => {
        throw new Error("e2e: no agent runs");
      },
      graphify: { bin: graphify },
    });
    await waitFor("daemon", async () => attached.isConnected());
    await waitFor("report token", async () => (await db.query(`select 1 from report_tokens`)).length > 0);

    // 1. Bind the repo.
    const bound = await postJson(`${hubUrl}/api/workspaces/${workspace.id}/repos`, { path: repo, label: "API" });
    expect(bound.status, JSON.stringify(bound.json)).toBe(200);
    const boundRepo = bound.json as Repo;
    await waitFor("indexed sha", async () => (await getRepo(db, boundRepo.id))?.lastMainSha === mainBefore);

    // 2. `nema report hook` from a worktree routes to the bound repo through the git common dir.
    const wt = path.join(root, "wt");
    git(repo, ["worktree", "add", "-b", "feature", wt]);
    mkdirSync(path.join(wt, "sub"));
    const hookPayload = JSON.stringify({ cwd: path.join(wt, "sub"), session_id: "s-1", prompt: "never forwarded" });
    expect(
      await cli.report.runReportHook({ agent: "claude-code", nemaHome, hubUrl, stdin: Readable.from([Buffer.from(hookPayload)]), sendOpts: SEND }),
    ).toBe(0);
    const hooks = await waitFor("hook", async () => {
      const rows = await db.query<{ repo_id: string; agent: string; branch: string; head: string; session_id: string }>(
        `select repo_id, agent, branch, head, session_id from repo_hooks`,
      );
      return rows.length > 0 ? rows : null;
    });
    expect(hooks).toEqual([{ repo_id: boundRepo.id, agent: "claude-code", branch: "feature", head: mainBefore, session_id: "s-1" }]);

    // 3. Commit on the branch and report it: the commit exists but is not on main yet.
    mkdirSync(path.join(wt, "src"));
    writeFileSync(path.join(wt, "src", "stream.ts"), "export const stream = true;\n");
    const reported = commitAll(wt, "feat: streaming");
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await cli.report.runReport({
      nemaHome,
      hubUrl,
      cwd: wt,
      out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
      flags: { agent: "claude-code", summary: "实现了流式输出", commits: reported, entries: "R-1", files: "src/stream.ts" },
      sendOpts: SEND,
    });
    expect({ code, logs, errors }).toEqual({ code: 0, logs: ["已上报到 Nema"], errors: [] });
    const reportMessage = await waitFor("report check", async () => {
      const m = (await listMessages(db, workspace.id)).find((x) => x.role === "report");
      return m && (m.meta as ReportMessageMeta).check ? m : null;
    });
    const firstCheck = (reportMessage.meta as ReportMessageMeta).check!;
    expect(firstCheck).toMatchObject({ commitsExist: true, onMain: "not-yet", filesOk: true });
    await waitFor("report task", async () => taskFor(db, reportMessage.id));

    // 4. Merge to origin/main; one watcher tick re-checks the report, which now passes.
    git(wt, ["push", "origin", "feature:main"]);
    await daemon.watcher.tick();
    await waitFor("moved to the merge", async () => (await getRepo(db, boundRepo.id))?.lastMainSha === reported);
    const verifiedTask = await waitFor("verified system task", async () =>
      (await listMessages(db, workspace.id)).find((m) => m.role === "system" && m.content.startsWith(`上报 ${reportMessage.id} 的提交已核对（不是验收）`)),
    );
    expect(((await getMessage(db, reportMessage.id))!.meta as ReportMessageMeta).check).toMatchObject({ onMain: "yes", filesOk: true });
    await waitFor("verified task queued", async () => taskFor(db, verifiedTask.id));

    // 5. An unreported commit lands on main; once the fallback clock is past 30 minutes, one system task lists it.
    const other = path.join(root, "other");
    git(root, ["clone", bare, other]);
    git(other, ["config", "user.email", "test@example.com"]);
    git(other, ["config", "user.name", "Test"]);
    writeFileSync(path.join(other, "README.md"), "unreported\n");
    const unreported = commitAll(other, "chore: unreported");
    git(other, ["push", "origin", "main"]);
    await daemon.watcher.tick();
    await waitFor("moved to the unreported commit", async () => (await getRepo(db, boundRepo.id))?.lastMainSha === unreported);

    const fallbackSystem = async (): Promise<Message[]> =>
      (await listMessages(db, workspace.id)).filter((m) => m.role === "system" && m.content.startsWith(FALLBACK_PREFIX));
    const early = startReportFallback(db, attached.rpc, events, { intervalMs: 3_600_000 });
    try {
      await early.tick();
    } finally {
      early.stop();
    }
    expect(await fallbackSystem()).toEqual([]);

    const later = startReportFallback(db, attached.rpc, events, { intervalMs: 3_600_000, now: () => new Date(Date.now() + 31 * 60_000) });
    try {
      await later.tick();
    } finally {
      later.stop();
    }
    const fallback = await fallbackSystem();
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.content).toContain(unreported);
    expect(fallback[0]!.content).not.toContain(reported);
    await waitFor("fallback task queued", async () => taskFor(db, fallback[0]!.id));
    expect(await db.query(`select handled from main_moves where handled = false`)).toEqual([]);
  } finally {
    daemon?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test("an in-progress report with no commits is accepted by a real hub", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "nema-report-progress-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  commitAll(repo, "init");
  const gitCommonDir = path.join(repo, ".git");

  const { db, dataDir } = await makeHubDeps();
  const workspace = await createWorkspace(db, dataDir, "API");
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url)
     values ('repo_progress', $1, $2, $3, 'API', 'main', false, null)`,
    [workspace.id, repo, gitCommonDir],
  );
  const token = "c".repeat(64);
  await registerReportToken(db, createHash("sha256").update(token).digest("hex"));
  const daemonCalls: string[] = [];
  let listener: http.RequestListener = (_req, res) => res.end();
  const server = http.createServer((req, res) => listener(req, res));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const daemon = {
      async call(method: string): Promise<unknown> {
        daemonCalls.push(method);
        throw new Error("e2e: no daemon");
      },
    };
    listener = getRequestListener(createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon, port }).fetch);
    const res = await fetch(`http://127.0.0.1:${port}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent: "claude-code", gitCommonDir, summary: "做到一半", progress: "in_progress" }),
    });
    expect(res.status).toBe(202);
    const { messageId } = (await res.json()) as { messageId: string };
    const meta = await waitFor("skipped check", async () => {
      const m = (await getMessage(db, messageId))?.meta as ReportMessageMeta | undefined;
      return m?.checkSkipped ? m : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(meta.check).toBeNull();
    expect(meta.checkSkipped).toBe("in_progress_no_commits");
    expect(meta.report).toMatchObject({ progress: "in_progress", commits: [] });
    expect(daemonCalls).not.toContain("report.check");
    expect(await db.query(`select 1 from tasks where workspace_id = $1 and status = 'queued'`, [workspace.id])).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
