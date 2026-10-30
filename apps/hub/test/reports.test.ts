import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { afterAll, beforeEach, expect, test } from "vitest";
import type { ReportCheck, ReportMessageMeta } from "@nema/shared";
import { createApp } from "../src/app.js";
import type { DaemonRpc } from "../src/daemonRpc.js";
import { DaemonRpcError } from "../src/daemonRpc.js";
import type { Db } from "../src/db/db.js";
import { EventBus, type HubEvent } from "../src/events.js";
import { addReportMessage, getMessage, listMessages, mergeReportMeta } from "../src/messages.js";
import { recheckReports, registerReportToken, routeRepo, startReportFallback } from "../src/reports.js";
import { applyRepoMoved } from "../src/repos.js";
import { listQueuedTasks } from "../src/tasks.js";
import { KnowledgeStore } from "@nema/knowledge";
import { createWorkspace, repoPath, updateWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
const TOKEN = "a".repeat(64);
const HASH = createHash("sha256").update(TOKEN).digest("hex");
const GIT_DIR = "/real/a/.git";
const HEAD = "1".repeat(40);

type Call = { method: string; params: unknown; timeoutMs?: number };

let db: Db;
let dataDir: string;
let events: EventBus;
let seen: { ws: string; e: HubEvent }[];
let calls: Call[];
let handlers: Record<string, (params: unknown) => Promise<unknown> | unknown>;
let app: Hono;
let daemon: DaemonRpc;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  events = new EventBus();
  seen = [];
  events.subscribeAll((ws, e) => seen.push({ ws, e }));
  calls = [];
  handlers = {};
  daemon = {
    async call(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs });
      const h = handlers[method];
      if (!h) throw new DaemonRpcError("daemon 未连接");
      return h(params);
    },
  };
  app = createApp({ db, dataDir, events, daemonStatus: () => true, daemon });
  await registerReportToken(db, HASH);
});
afterAll(cleanupHubDeps);

async function bind(gitCommonDir = GIT_DIR, workspaceName = "A"): Promise<{ ws: string; repoId: string }> {
  const ws = (await createWorkspace(db, dataDir, workspaceName)).id;
  const repoId = `repo_${workspaceName}`;
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url)
     values ($1, $2, '/real/a', $3, 'API', 'main', true, null)`,
    [repoId, ws, gitCommonDir],
  );
  return { ws, repoId };
}

const post = (p: string, body: unknown, token: string | null = TOKEN) =>
  app.request(`${HUB}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const signal = (gitCommonDir = GIT_DIR) => ({
  agent: "claude-code",
  cwd: "/real/a/sub",
  gitCommonDir,
  branch: "feature/x",
  head: HEAD,
  at: "2026-10-23T10:00:00.000Z",
  sessionId: "s-1",
});

const report = (gitCommonDir = GIT_DIR) => ({
  agent: "claude-code",
  gitCommonDir,
  summary: "实现了流式输出",
  entries: ["R-1"],
  commits: ["abcdef1"],
  files: ["src/a.ts"],
});

const passing: ReportCheck = {
  commitsExist: true,
  missingCommits: [],
  onMain: "yes",
  filesOk: true,
  untouchedFiles: [],
  touchedFiles: [],
  checkedAt: "2026-10-23T10:01:00.000Z",
  mainSha: "2".repeat(40),
};

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("hook without a valid token is 401", async () => {
  await bind();
  for (const token of [null, "b".repeat(64), "garbage"]) {
    const r = await post("/report/hook", signal(), token);
    expect(r.status).toBe(401);
    expect(await r.text()).toBe("");
  }
  const r = await post("/report", report(), null);
  expect(r.status).toBe(401);
  expect(await db.query(`select * from repo_hooks`)).toEqual([]);
  expect(calls).toEqual([]);
});

test("hook for an unbound or archived repo is 204 and stores nothing", async () => {
  const unbound = await post("/report/hook", signal("/elsewhere/.git"));
  expect(unbound.status).toBe(204);

  const { ws } = await bind();
  await updateWorkspace(db, ws, { archived: true });
  expect(await routeRepo(db, GIT_DIR)).toBeNull();
  const archived = await post("/report/hook", signal());
  expect(archived.status).toBe(204);
  const archivedReport = await post("/report", report());
  expect(archivedReport.status).toBe(204);

  expect(await db.query(`select * from repo_hooks`)).toEqual([]);
  expect(await listMessages(db, ws)).toEqual([]);
  expect(calls).toEqual([]);
});

test("hook for a bound repo stores the signal and asks the daemon to tick that repo", async () => {
  const { repoId } = await bind();
  // The tick is fired, not awaited: a daemon that never answers does not hold up the reply.
  handlers["repo.tick"] = () => new Promise(() => {});
  const r = await post("/report/hook", signal());
  expect(r.status).toBe(204);
  const rows = await db.query<Record<string, unknown>>(`select repo_id, agent, branch, head, session_id, at from repo_hooks`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ repo_id: repoId, agent: "claude-code", branch: "feature/x", head: HEAD, session_id: "s-1" });
  expect(new Date(rows[0]!.at as string).toISOString()).toBe("2026-10-23T10:00:00.000Z");
  expect(calls).toEqual([{ method: "repo.tick", params: { repoId }, timeoutMs: undefined }]);
});

test("an invalid hook body is 400", async () => {
  await bind();
  const r = await post("/report/hook", { ...signal(), head: "nope" });
  expect(r.status).toBe(400);
  expect(await db.query(`select * from repo_hooks`)).toEqual([]);
});

test("registering a report token hash twice keeps one row", async () => {
  await registerReportToken(db, HASH);
  expect(await db.query(`select hash from report_tokens`)).toEqual([{ hash: HASH }]);
});

test("report creates a report message, stores the check, then queues a task", async () => {
  const { ws, repoId } = await bind();
  let release!: (v: ReportCheck) => void;
  handlers["report.check"] = () => new Promise<ReportCheck>((resolve) => (release = resolve));

  const r = await post("/report", report());
  expect(r.status).toBe(202);
  const { messageId } = (await r.json()) as { messageId: string };

  const message = await getMessage(db, messageId);
  expect(message).toMatchObject({ workspaceId: ws, role: "report", content: "实现了流式输出", taskId: null });
  expect(message!.meta).toEqual({ report: { ...report(), progress: "completed" }, check: null });
  expect(seen.some((s) => s.ws === ws && s.e.type === "message.created" && s.e.message.id === messageId)).toBe(true);

  await waitFor(async () => calls.some((c) => c.method === "report.check"));
  const call = calls.find((c) => c.method === "report.check")!;
  expect(call.params).toEqual({ workspaceId: ws, repoId, path: "/real/a", mainBranch: "main", commits: ["abcdef1"], files: ["src/a.ts"] });
  expect(call.timeoutMs).toBe(300_000);
  // No task before the check is stored.
  expect(await listQueuedTasks(db, ws)).toEqual([]);

  release(passing);
  const [task] = await waitFor(async () => {
    const queued = await listQueuedTasks(db, ws);
    return queued.length > 0 ? queued : null;
  });
  expect(task).toMatchObject({ workspaceId: ws, messageId, status: "queued" });
  expect(((await getMessage(db, messageId))!.meta as ReportMessageMeta).check).toEqual(passing);
  expect(seen.some((s) => s.ws === ws && s.e.type === "task.updated" && s.e.task.id === task!.id)).toBe(true);
  // The stored check reaches the UI as message.updated carrying the whole message.
  const updated = seen.filter((s) => s.e.type === "message.updated");
  expect(updated).toHaveLength(1);
  expect(updated[0]!.ws).toBe(ws);
  expect(updated[0]!.e).toEqual({ type: "message.updated", message: await getMessage(db, messageId) });
});

test("a report check error still queues the task with checkError", async () => {
  const { ws } = await bind();
  handlers["report.check"] = () => {
    throw new DaemonRpcError("没有这个提交");
  };
  const r = await post("/report", report());
  expect(r.status).toBe(202);
  const { messageId } = (await r.json()) as { messageId: string };
  const [task] = await waitFor(async () => {
    const queued = await listQueuedTasks(db, ws);
    return queued.length > 0 ? queued : null;
  });
  expect(task).toMatchObject({ messageId });
  expect((await getMessage(db, messageId))!.meta).toEqual({ report: { ...report(), progress: "completed" }, check: null, checkError: "没有这个提交" });
});

test("an invalid report is 400 and stores nothing", async () => {
  const { ws } = await bind();
  const r = await post("/report", { ...report(), commits: [] });
  expect(r.status).toBe(400);
  expect(await r.json()).toEqual({ error: "上报内容不完整或格式不对" });
  const completed = await post("/report", { ...report(), progress: "completed", commits: [] });
  expect(completed.status).toBe(400);
  const { commits: _commits, ...noCommits } = report();
  expect((await post("/report", noCommits)).status).toBe(400);
  expect(await listMessages(db, ws)).toEqual([]);
});

/** An approved package with one task on src/a.ts, for reports that name it. */
async function approvedPackage(ws: string, repoId: string): Promise<string> {
  const store = new KnowledgeStore(repoPath(dataDir, ws));
  await store.upsert({ kind: "requirement", title: "流式输出", body: "b", sourceMessages: [], reason: "r" }, { author: "user" });
  const wp = await store.createWorkPackage({ title: "流式", requirements: ["R-1"], repos: [repoId], reason: "r", sourceMessages: [] }, { author: "user" });
  const task = { n: 1, title: "t", satisfies: ["R-1"], files: [{ op: "modify" as const, repo: "API", path: "src/a.ts" }], status: "pending" as const, inferred: false, reportMessageId: null, confirmedBy: null };
  await store.writeWorkPackageDoc(wp.id, "spec", "# spec\n", {}, "s", [], { author: "user" });
  await store.writeWorkPackageDoc(wp.id, "plan", "### 任务 1：a\n- 满足：R-1\n", { tasks: [task] }, "p", [], { author: "user" });
  await store.setWorkPackageMeta(wp.id, { status: "approved", approvedAt: "2026-10-23T10:00:00.000Z", approvedCommit: "c" }, "x", { author: "user" });
  return wp.id;
}

async function taskStatus(ws: string, wpId: string): Promise<string | undefined> {
  return (await new KnowledgeStore(repoPath(dataDir, ws)).get(wpId))?.workpackage?.tasks[0]?.status;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const metaOf = async (id: string) => (await getMessage(db, id))!.meta as ReportMessageMeta;

test("stores an in-progress report with no commits and does not check, queue, or apply", async () => {
  const { ws, repoId } = await bind();
  const wpId = await approvedPackage(ws, repoId);
  const body = { ...report(), entries: [wpId], task: 1, progress: "in_progress", commits: [] };
  const r = await post("/report", body);
  expect(r.status).toBe(202);
  const { messageId } = (await r.json()) as { messageId: string };
  const meta = await waitFor(async () => {
    const m = await metaOf(messageId);
    return m.checkSkipped ? m : null;
  });
  await settle();
  expect(calls.map((c) => c.method)).not.toContain("report.check");
  expect(meta.report).toEqual(body);
  expect(meta.check).toBeNull();
  expect(meta.checkSkipped).toBe("in_progress_no_commits");
  expect("checkError" in meta).toBe(false);
  expect(await listQueuedTasks(db, ws)).toEqual([]);
  expect(await taskStatus(ws, wpId)).toBe("pending");
});

test("checks an in-progress report that has commits without queueing it", async () => {
  const { ws, repoId } = await bind();
  const wpId = await approvedPackage(ws, repoId);
  const notYet: ReportCheck = { ...passing, onMain: "not-yet" };
  handlers["report.check"] = () => notYet;
  const r = await post("/report", { ...report(), entries: [wpId], task: 1, progress: "in_progress" });
  expect(r.status).toBe(202);
  const { messageId } = (await r.json()) as { messageId: string };
  const meta = await waitFor(async () => {
    const m = await metaOf(messageId);
    return m.check ? m : null;
  });
  await settle();
  expect(meta.check).toEqual(notYet);
  expect(meta.report.progress).toBe("in_progress");
  expect(await listQueuedTasks(db, ws)).toEqual([]);
  expect(await taskStatus(ws, wpId)).toBe("pending");
});

const S3 = (id: string) =>
  `上报 ${id} 的提交已核对（不是验收）。把还没有用户确认的需求 implementation 设为 verified，且不要写 confirmedBy。不要改写 confirmedBy 已是 "user" 的 implementation。`;

test("rechecks an in-progress report onto main without applying or queueing", async () => {
  const { ws, repoId } = await bind();
  const wpId = await approvedPackage(ws, repoId);
  const message = await addReportMessage(db, ws, "进行中", {
    report: { ...report(), entries: [wpId], task: 1, progress: "in_progress" },
    check: { ...passing, onMain: "not-yet", checkedAt: "2026-10-23T10:00:00.000Z" },
  });
  handlers["report.check"] = () => passing;
  await recheckReports({ db, events, daemon, dataDir }, repoId);
  const meta = await metaOf(message.id);
  expect(meta.check?.onMain).toBe("yes");
  expect(meta.report.progress).toBe("in_progress");
  expect(await taskStatus(ws, wpId)).toBe("pending");
  expect((await listMessages(db, ws)).filter((m) => m.role === "system")).toEqual([]);
  expect(await listQueuedTasks(db, ws)).toEqual([]);
});

test("keeps github when a completed report is rechecked", async () => {
  const { ws, repoId } = await bind();
  const message = await addReportMessage(db, ws, "未合入", { report: report(), check: { ...passing, onMain: "not-yet", checkedAt: "2026-10-23T10:00:00.000Z" } });
  const authors = { checkedAt: "2026-10-23T10:00:00.000Z", source: "git" as const, commits: [], missing: [] };
  const github = {
    state: "read" as const,
    observedAt: "2026-10-23T10:00:00.000Z",
    source: "github-plugin-read" as const,
    binding: { repoId, owner: "o", repo: "r", pr: 7, observedHeadSha: "a".repeat(40), claimedHeadSha: null },
    headMatch: "not_comparable" as const,
    checkRuns: [],
    truncated: false,
  };
  await mergeReportMeta(db, message.id, { authors });
  await mergeReportMeta(db, message.id, { github });
  handlers["report.check"] = () => passing;
  await recheckReports({ db, events, daemon }, repoId);
  const meta = await metaOf(message.id);
  expect(meta.check).toEqual(passing);
  expect(meta.authors).toEqual(authors);
  expect(meta.github?.current).toEqual(github);
  expect(meta.checkHistory).toHaveLength(1);
});

test("a completed recheck that passes applies the report to its package task", async () => {
  const { ws, repoId } = await bind();
  const wpId = await approvedPackage(ws, repoId);
  const message = await addReportMessage(db, ws, "未合入", {
    report: { ...report(), entries: [wpId], task: 1 },
    check: { ...passing, onMain: "not-yet", touchedFiles: ["src/a.ts"], checkedAt: "2026-10-23T10:00:00.000Z" },
  });
  handlers["report.check"] = () => ({ ...passing, touchedFiles: ["src/a.ts"] });
  await recheckReports({ db, events, daemon, dataDir }, repoId);
  const task = (await new KnowledgeStore(repoPath(dataDir, ws)).get(wpId))?.workpackage?.tasks[0];
  expect(task).toMatchObject({ status: "verified", confirmedBy: null, reportMessageId: message.id });
  const system = (await listMessages(db, ws)).filter((m) => m.role === "system");
  expect(system.map((m) => m.content)).toEqual([S3(message.id)]);
});

test("does not recheck a report that is already on main", async () => {
  const { ws, repoId } = await bind();
  const message = await addReportMessage(db, ws, "已合入", { report: report(), check: passing });
  handlers["report.check"] = () => ({ ...passing, filesOk: false });
  await recheckReports({ db, events, daemon }, repoId);
  expect(calls.map((c) => c.method)).not.toContain("report.check");
  expect((await metaOf(message.id)).check).toEqual(passing);
});

test("an older recheck result does not replace a newer stored check", async () => {
  const { ws, repoId } = await bind();
  const stored: ReportCheck = { ...passing, onMain: "not-yet", checkedAt: "2026-10-23T10:05:00.000Z" };
  const message = await addReportMessage(db, ws, "未合入", { report: report(), check: stored });
  handlers["report.check"] = () => ({ ...passing, checkedAt: "2026-10-23T10:01:00.000Z" });
  await recheckReports({ db, events, daemon }, repoId);
  const meta = await metaOf(message.id);
  expect(meta.check).toEqual(stored);
  expect(meta.checkHistory ?? []).toEqual([]);
  expect((await listMessages(db, ws)).filter((m) => m.role === "system")).toEqual([]);
});

test("a main move re-checks a not-yet report and queues the verified system task when it now passes", async () => {
  const { ws, repoId } = await bind();
  const notYet: ReportCheck = { ...passing, onMain: "not-yet" };
  handlers["report.check"] = () => notYet;
  const r = await post("/report", report());
  const { messageId } = (await r.json()) as { messageId: string };
  await waitFor(async () => ((await getMessage(db, messageId))!.meta as ReportMessageMeta).check !== null);
  const before = (await listMessages(db, ws)).length;

  // A move that still leaves the report off main stores the new check and queues nothing.
  expect(await applyRepoMoved(db, events, { repoId, mainRef: "origin/main", from: "a".repeat(40), to: "b".repeat(40) })).toBe(true);
  await recheckReports({ db, events, daemon }, repoId);
  expect(((await getMessage(db, messageId))!.meta as ReportMessageMeta).check).toEqual(notYet);
  expect(await listMessages(db, ws)).toHaveLength(before);

  // The re-check that still leaves it off main is announced too.
  const notYetUpdates = seen.filter((s) => s.e.type === "message.updated" && s.e.message.id === messageId);
  expect(notYetUpdates).toHaveLength(2);

  handlers["report.check"] = () => passing;
  calls.length = 0;
  expect(await applyRepoMoved(db, events, { repoId, mainRef: "origin/main", from: "b".repeat(40), to: "c".repeat(40) })).toBe(true);
  const moves = await db.query<{ repo_id: string; from_sha: string | null; to_sha: string; handled: boolean }>(
    `select repo_id, from_sha, to_sha, handled from main_moves order by id`,
  );
  expect(moves).toEqual([
    { repo_id: repoId, from_sha: "a".repeat(40), to_sha: "b".repeat(40), handled: false },
    { repo_id: repoId, from_sha: "b".repeat(40), to_sha: "c".repeat(40), handled: false },
  ]);
  await recheckReports({ db, events, daemon }, repoId);
  expect(calls.map((c) => c.method)).toEqual(["report.check"]);
  expect(calls[0]!.params).toEqual({ workspaceId: ws, repoId, path: "/real/a", mainBranch: "main", commits: ["abcdef1"], files: ["src/a.ts"] });
  expect(((await getMessage(db, messageId))!.meta as ReportMessageMeta).check).toEqual(passing);
  const last = seen.filter((s) => s.e.type === "message.updated").at(-1)!;
  expect(last).toEqual({ ws, e: { type: "message.updated", message: await getMessage(db, messageId) } });
  expect(((last.e as { message: { meta: ReportMessageMeta } }).message.meta).check).toEqual(passing);
  const system = (await listMessages(db, ws)).filter((m) => m.role === "system");
  expect(system.map((m) => m.content)).toEqual([S3(messageId)]);
  for (const banned of ["验收通过", "已核实", "全部任务已核实"]) expect(system[0]!.content).not.toContain(banned);
  const queued = await listQueuedTasks(db, ws);
  expect(queued.some((t) => t.messageId === system[0]!.id)).toBe(true);

  // Already on main: a later move does not re-check it again.
  calls.length = 0;
  await recheckReports({ db, events, daemon }, repoId);
  expect(calls).toEqual([]);
});

const NOW = new Date("2026-10-23T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

async function insertMove(repoId: string, from: string, to: string, at: string): Promise<void> {
  await db.query(`insert into main_moves(repo_id, from_sha, to_sha, at) values ($1, $2, $3, $4)`, [repoId, from, to, at]);
}

const uncoveredText = (shas: string[]) =>
  `主分支有新提交但没有收到上报（仓库 API，repo_A）：\n${shas.join("\n")}\n用 code__changes / code__read 判断它们对应哪些需求；仅凭代码推断的关联把 implementation 设为 reported，evidence.inferred 为 true，basis 为 inferred。`;

test("the fallback ignores a move younger than 30 minutes, marks a covered move handled, and queues one system task for uncovered commits", async () => {
  const { ws, repoId } = await bind();
  await addReportMessage(db, ws, "已上报", { report: { ...report(), commits: ["abcdef1"] }, check: passing });
  await addReportMessage(db, ws, "未合入", { report: { ...report(), commits: ["fedcba9"] }, check: { ...passing, onMain: "not-yet" } });
  await insertMove(repoId, "a".repeat(40), "b".repeat(40), minutesAgo(10));
  await insertMove(repoId, "c".repeat(40), "d".repeat(40), minutesAgo(40));
  await insertMove(repoId, "d".repeat(40), "e".repeat(40), minutesAgo(35));
  const uncovered = ["1".repeat(40), "2".repeat(40)];
  handlers["repo.uncovered"] = (params) => ((params as { to: string }).to === "d".repeat(40) ? [] : uncovered);

  const fallback = startReportFallback(db, daemon, events, { intervalMs: 3_600_000, now: () => NOW });
  try {
    await fallback.tick();
  } finally {
    fallback.stop();
  }

  const uncoveredCalls = calls.filter((c) => c.method === "repo.uncovered");
  expect(uncoveredCalls.map((c) => c.params)).toEqual([
    { workspaceId: ws, repoId, path: "/real/a", mainBranch: "main", from: "c".repeat(40), to: "d".repeat(40), covered: ["abcdef1"] },
    { workspaceId: ws, repoId, path: "/real/a", mainBranch: "main", from: "d".repeat(40), to: "e".repeat(40), covered: ["abcdef1"] },
  ]);
  const rows = await db.query<{ to_sha: string; handled: boolean }>(`select to_sha, handled from main_moves order by id`);
  expect(rows).toEqual([
    { to_sha: "b".repeat(40), handled: false },
    { to_sha: "d".repeat(40), handled: true },
    { to_sha: "e".repeat(40), handled: true },
  ]);
  const system = (await listMessages(db, ws)).filter((m) => m.role === "system");
  expect(system.map((m) => m.content)).toEqual([uncoveredText(uncovered)]);
  expect((await listQueuedTasks(db, ws)).filter((t) => t.messageId === system[0]!.id)).toHaveLength(1);
});

test("a fallback daemon error leaves the move unhandled", async () => {
  const { ws, repoId } = await bind();
  await insertMove(repoId, "a".repeat(40), "b".repeat(40), minutesAgo(45));
  handlers["repo.uncovered"] = () => {
    throw new DaemonRpcError("daemon 响应超时");
  };
  const fallback = startReportFallback(db, daemon, events, { intervalMs: 3_600_000, now: () => NOW });
  try {
    await fallback.tick();
  } finally {
    fallback.stop();
  }
  expect(await db.query(`select handled from main_moves`)).toEqual([{ handled: false }]);
  expect(await listMessages(db, ws)).toEqual([]);
});

const get = (p: string, token: string | null = TOKEN) =>
  app.request(`${HUB}${p}`, { headers: token !== null ? { authorization: `Bearer ${token}` } : {} });

test("only approved/in_progress packages for the routed repo are listed and served", async () => {
  const { ws, repoId } = await bind(GIT_DIR, "WP");
  const other = await bind("/real/b/.git", "WPB");
  const store = new KnowledgeStore(repoPath(dataDir, ws));
  const mk = async (title: string, repos: string[], status: "approved" | "in_progress" | "dropped" | "draft") => {
    const wp = await store.createWorkPackage({ title, requirements: ["R-1"], repos, reason: "r", sourceMessages: [] }, { author: "user" });
    const task = (n: number) => ({ n, title: "t", satisfies: ["R-1"], files: [], status: "pending" as const, inferred: false, reportMessageId: null, confirmedBy: null });
    await store.writeWorkPackageDoc(wp.id, "spec", `# spec ${title}\n`, {}, "s", [], { author: "user" });
    await store.writeWorkPackageDoc(wp.id, "plan", `### 任务 1：a\n- 满足：R-1\n\n### 任务 2：b\n- 满足：R-1\n`, { tasks: [task(1), task(2)] }, "p", [], { author: "user" });
    if (status !== "draft") await store.setWorkPackageMeta(wp.id, { status, approvedAt: "2026-10-23T10:00:00.000Z", approvedCommit: "c" }, "x", { author: "user" });
    return wp.id;
  };
  const a = await mk("甲", [repoId], "approved");
  const b = await mk("乙", [repoId], "in_progress");
  await mk("丙", [repoId], "dropped");
  await mk("丁", [other.repoId], "approved");
  const draft = await mk("戊", [repoId], "draft");

  const res = await get(`/report/workpackages?gitCommonDir=${encodeURIComponent(GIT_DIR)}`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual([
    { id: a, title: "甲", tasks: 2 },
    { id: b, title: "乙", tasks: 2 },
  ]);

  const one = await get(`/report/workpackages/${a}?gitCommonDir=${encodeURIComponent(GIT_DIR)}`);
  expect(one.status).toBe(200);
  expect(await one.json()).toEqual({ id: a, title: "甲", spec: "# spec 甲\n", plan: expect.stringContaining("### 任务 1：a") });

  expect((await get(`/report/workpackages?gitCommonDir=${encodeURIComponent(GIT_DIR)}`, null)).status).toBe(401);
  expect((await get(`/report/workpackages?gitCommonDir=${encodeURIComponent("/nowhere/.git")}`)).status).toBe(204);
  void draft;
});

test("a draft package is 404", async () => {
  const { ws, repoId } = await bind(GIT_DIR, "WP2");
  const store = new KnowledgeStore(repoPath(dataDir, ws));
  const wp = await store.createWorkPackage({ title: "草稿", requirements: ["R-1"], repos: [repoId], reason: "r", sourceMessages: [] }, { author: "user" });
  const res = await get(`/report/workpackages/${wp.id}?gitCommonDir=${encodeURIComponent(GIT_DIR)}`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: `没有可取的开发包 ${wp.id}` });
  const missing = await get(`/report/workpackages/W-99?gitCommonDir=${encodeURIComponent(GIT_DIR)}`);
  expect(missing.status).toBe(404);
});

const authorsResult = {
  checkedAt: "2026-10-23T10:02:00.000Z",
  source: "git" as const,
  commits: [{ sha: "abcdef1".padEnd(40, "0"), authorName: "Ada", authorEmail: "author@example.com", committerName: "Cy", committerEmail: "committer@example.com" }],
  missing: [],
};

test("stores authors beside the check and still passes on git alone", async () => {
  const { ws, repoId } = await bind();
  const wpId = await approvedPackage(ws, repoId);
  handlers["report.check"] = () => ({ ...passing, touchedFiles: ["src/a.ts"] });
  handlers["report.authors"] = () => authorsResult;
  const errors: unknown[][] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const r = await post("/report", { ...report(), entries: [wpId], task: 1 });
    expect(r.status).toBe(202);
    const { messageId } = (await r.json()) as { messageId: string };
    await waitFor(async () => (await listQueuedTasks(db, ws)).length > 0);
    const meta = await metaOf(messageId);
    expect(meta.authors).toEqual(authorsResult);
    expect(meta.check).toEqual({ ...passing, touchedFiles: ["src/a.ts"] });
    expect(calls.map((c) => c.method)).toEqual(expect.arrayContaining(["report.check", "report.authors"]));
    expect(calls.find((c) => c.method === "report.authors")!.params).toEqual({ workspaceId: ws, repoId, path: "/real/a", mainBranch: "main", commits: ["abcdef1"] });
    expect(await taskStatus(ws, wpId)).toBe("verified");
  } finally {
    console.error = saved;
  }
  expect(JSON.stringify(errors)).not.toContain("author@example.com");
});

test("keeps the report when author lookup throws", async () => {
  const { ws } = await bind();
  handlers["report.check"] = () => passing;
  handlers["report.authors"] = () => {
    throw new DaemonRpcError("author@example.com is unreadable");
  };
  const errors: unknown[][] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  let messageId: string;
  try {
    const r = await post("/report", report());
    expect(r.status).toBe(202);
    ({ messageId } = (await r.json()) as { messageId: string });
    await waitFor(async () => (await listQueuedTasks(db, ws)).length > 0);
  } finally {
    console.error = saved;
  }
  const meta = await metaOf(messageId!);
  expect(meta.check).toEqual(passing);
  expect("authors" in meta).toBe(false);
  expect(JSON.stringify(errors)).not.toContain("author@example.com");
});

test("an in-progress report with no commits does not look up authors", async () => {
  const { ws } = await bind();
  handlers["report.authors"] = () => authorsResult;
  const r = await post("/report", { ...report(), progress: "in_progress", commits: [] });
  const { messageId } = (await r.json()) as { messageId: string };
  await waitFor(async () => (await metaOf(messageId)).checkSkipped);
  await settle();
  expect(calls.map((c) => c.method)).not.toContain("report.authors");
  void ws;
});

test("a recheck whose result is overtaken by a newer stored check neither applies nor queues", async () => {
  const { ws, repoId } = await bind();
  const wpId = await approvedPackage(ws, repoId);
  const message = await addReportMessage(db, ws, "未合入", {
    report: { ...report(), entries: [wpId], task: 1 },
    check: { ...passing, onMain: "not-yet", touchedFiles: ["src/a.ts"], checkedAt: "2026-10-23T10:00:00.000Z" },
  });
  const newer: ReportCheck = { ...passing, filesOk: false, untouchedFiles: ["src/a.ts"], checkedAt: "2026-10-23T10:03:00.000Z" };
  handlers["report.check"] = async () => {
    // Another recheck stores a newer failing check while this one is still running.
    await mergeReportMeta(db, message.id, { check: newer, checkError: null, checkSkipped: null });
    return { ...passing, touchedFiles: ["src/a.ts"], checkedAt: "2026-10-23T10:02:00.000Z" };
  };
  await recheckReports({ db, events, daemon, dataDir }, repoId);
  expect((await metaOf(message.id)).check).toEqual(newer);
  expect(await taskStatus(ws, wpId)).toBe("pending");
  expect((await listMessages(db, ws)).filter((m) => m.role === "system")).toEqual([]);
});
