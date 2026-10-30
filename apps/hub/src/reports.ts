// Hooks and reports from coding agents: `nema report hook` and `nema report` post here with the report token.
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { KnowledgeStore } from "@nema/knowledge";
import { HookSignal, ReportInput, reportPassed, type ReportAuthors, type ReportCheck, type ReportMessageMeta, type StoredReport } from "@nema/shared";
import { INDEX_RPC_TIMEOUT_MS, type DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { ArchivedWorkspaceError, addReportMessage, mergeReportMeta, postSystemTask, type Message, type ReportMetaPatch } from "./messages.js";
import { getRepo, type Repo } from "./repos.js";
import { insertQueuedTask, toUiTask, type Task } from "./tasks.js";
import { repoPath } from "./workspaces.js";
import { applyReportToWorkPackage, noteLinkedCheckChanged } from "./workpackages.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

/** A report's git check fetches main first, which can take minutes on a large repo. */
export const REPORT_CHECK_TIMEOUT_MS = INDEX_RPC_TIMEOUT_MS;

export type ReportDeps = { db: Db; events: EventBus; daemon: DaemonRpc; dataDir?: string; ownedHelpers?: OwnedHelperScope };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Stores the sha256 of a daemon's report token (sent in its hello). Registering it twice is a no-op. */
export async function registerReportToken(db: Db, hash: string): Promise<void> {
  await db.query(`insert into report_tokens(hash) values ($1) on conflict (hash) do nothing`, [hash]);
}

async function authorized(db: Db, header: string | undefined): Promise<boolean> {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  if (!match) return false;
  const rows = await db.query(`select 1 from report_tokens where hash = $1`, [sha256(match[1]!)]);
  return rows.length > 0;
}

/** The repo with this git common dir, when its workspace is not archived. */
export async function routeRepo(db: Db, gitCommonDir: string): Promise<Repo | null> {
  const rows = await db.query<{ id: string }>(
    `select r.id from workspace_repos r join workspaces w on w.id = r.workspace_id
     where r.git_common_dir = $1 and w.archived_at is null`,
    [gitCommonDir],
  );
  return rows[0] ? getRepo(db, rows[0].id) : null;
}

/** Stores what the hook sent (never its cwd) and asks the daemon to look at that repo's main now. */
export async function receiveHook(deps: ReportDeps, repo: Repo, signal: HookSignal): Promise<void> {
  await deps.db.query(
    `insert into repo_hooks(repo_id, agent, branch, head, session_id, at) values ($1, $2, $3, $4, $5, $6)`,
    [repo.id, signal.agent, signal.branch, signal.head, signal.sessionId, signal.at],
  );
  void deps.daemon.call("repo.tick", { repoId: repo.id }).catch((error) => {
    console.error(`repo.tick failed for ${repo.id}`, error);
  });
}

async function queueReportTask(db: Db, workspaceId: string, messageId: string): Promise<Task | null> {
  return db.tx(async (t) => {
    // Archived while the check ran: the report stays in chat but starts no work.
    const ws = await t.query<{ archived_at: Date | string | null }>(`select archived_at from workspaces where id = $1`, [workspaceId]);
    if (!ws[0] || ws[0].archived_at) return null;
    return insertQueuedTask(t, workspaceId, messageId);
  });
}

/**
 * Stores the report as a `report` message right away. `done` then runs the daemon's git check and merges it
 * into the message meta (or `checkError`). A completed report is then applied to its work package task and
 * gets an organizing task, the same way a user message does. An in-progress report only keeps its check: it
 * is not applied and starts no task. An in-progress report with no commits is not checked at all
 * (`checkSkipped`).
 */
export async function receiveReport(deps: ReportDeps, repo: Repo, report: ReportInput): Promise<{ messageId: string; done: Promise<void> }> {
  const { db, events, daemon } = deps;
  const message = await addReportMessage(db, repo.workspaceId, report.summary, { report, check: null });
  events.emit(repo.workspaceId, { type: "message.created", message });
  const inProgress = report.progress === "in_progress";
  const done = (async () => {
    if (inProgress && report.commits.length === 0) {
      const skipped = await mergeReportMeta(db, message.id, { check: null, checkError: null, checkSkipped: "in_progress_no_commits" });
      if (skipped) events.emit(repo.workspaceId, { type: "message.updated", message: skipped });
      return;
    }
    let patch: ReportMetaPatch;
    let checked = false;
    try {
      const check = (await daemon.call("report.check", checkParams(repo, report), REPORT_CHECK_TIMEOUT_MS)) as ReportCheck;
      patch = { check, checkError: null, checkSkipped: null };
      checked = true;
    } catch (error) {
      patch = { check: null, checkError: error instanceof Error ? error.message : String(error) };
    }
    let updated = await mergeReportMeta(db, message.id, patch);
    if (checked) updated = (await recordAuthors(deps, repo, message.id, report)) ?? updated;
    if (updated) events.emit(repo.workspaceId, { type: "message.updated", message: updated });
    if (inProgress) return;
    if (updated && deps.dataDir) await applyReportToWorkPackage(db, deps.dataDir, events, repo.workspaceId, updated, deps.ownedHelpers);
    const task = await queueReportTask(db, repo.workspaceId, message.id);
    if (task) events.emit(repo.workspaceId, { type: "task.updated", task: toUiTask(task) });
  })().catch((error) => {
    console.error(`handling report ${message.id} failed`, error);
  });
  return { messageId: message.id, done };
}

/** The system task for a completed report whose commits now pass the git check. A commit check, not acceptance. */
export function commitsCheckedTask(messageId: string): string {
  return `上报 ${messageId} 的提交已核对（不是验收）。把还没有用户确认的需求 implementation 设为 verified，且不要写 confirmedBy。不要改写 confirmedBy 已是 "user" 的 implementation。`;
}

/**
 * Reads the commits' author and committer and merges them as `authors`. A failed read leaves `authors` unset
 * rather than storing an empty list that would look read; the log names the message, never an email.
 */
async function recordAuthors(deps: ReportDeps, repo: Repo, messageId: string, report: StoredReport): Promise<Message | null> {
  try {
    const authors = (await deps.daemon.call("report.authors", { ...repoParams(repo), commits: report.commits }, REPORT_CHECK_TIMEOUT_MS)) as ReportAuthors;
    return await mergeReportMeta(deps.db, messageId, { authors });
  } catch {
    console.error(`report ${messageId}: author lookup failed`);
    return null;
  }
}

function repoParams(repo: Repo) {
  return { workspaceId: repo.workspaceId, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch };
}

function checkParams(repo: Repo, report: StoredReport) {
  return { workspaceId: repo.workspaceId, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch, commits: report.commits, files: report.files };
}

/** Queues a system task and announces it. An archived workspace is skipped: it starts no work. */
async function queueSystemTask(db: Db, events: EventBus, workspaceId: string, content: string): Promise<boolean> {
  try {
    const { message, task } = await postSystemTask(db, workspaceId, content);
    events.emit(workspaceId, { type: "message.created", message });
    events.emit(workspaceId, { type: "task.updated", task: toUiTask(task) });
    return true;
  } catch (error) {
    if (error instanceof ArchivedWorkspaceError) return false;
    throw error;
  }
}

/** How long a report that is not on main yet keeps being re-checked when main moves. */
const RECHECK_DAYS = 30;

/**
 * After main moved: re-runs the check of this repo's reports that were not on main yet (from the last 30 days).
 * The new check is merged into the meta; the claim, authors and GitHub observation stay. A completed report that
 * now passes is applied to its package task and gets a system task saying its commits are checked (not accepted).
 * An in-progress report only keeps its new check.
 * A daemon error leaves that report as it was.
 */
export async function recheckReports(deps: ReportDeps, repoId: string): Promise<void> {
  const { db, events, daemon } = deps;
  const repo = await getRepo(db, repoId);
  if (!repo) return;
  const rows = await db.query<{ id: string; meta: ReportMessageMeta }>(
    `select id, meta from messages
     where workspace_id = $1 and role = 'report'
       and meta->'report'->>'gitCommonDir' = $2
       and meta->'check'->>'onMain' = 'not-yet'
       and created_at > now() - make_interval(days => $3)
     order by seq`,
    [repo.workspaceId, repo.gitCommonDir, RECHECK_DAYS],
  );
  for (const row of rows) {
    let check: ReportCheck;
    try {
      check = (await daemon.call("report.check", checkParams(repo, row.meta.report), REPORT_CHECK_TIMEOUT_MS)) as ReportCheck;
    } catch (error) {
      console.error(`re-checking report ${row.id} failed`, error);
      continue;
    }
    const previous = row.meta.check;
    // An older result than the stored one changes nothing (the merge would refuse it too).
    if (previous?.checkedAt && !(typeof check.checkedAt === "string" && check.checkedAt >= previous.checkedAt)) continue;
    // Mark the review before the meta moves on: the knowledge repo and the database are not one transaction,
    // and a failure here should leave an extra mark rather than a lost one.
    await noteLinkedCheckChanged(db, deps.dataDir, repo.workspaceId, row.id, previous, check, row.meta.report.commits);
    const updated = await mergeReportMeta(db, row.id, { check, checkError: null, checkSkipped: null });
    if (updated) events.emit(repo.workspaceId, { type: "message.updated", message: updated });
    // An in-progress report only keeps its new check, even once it is on main.
    if (row.meta.report.progress === "in_progress") continue;
    if (updated && deps.dataDir) await applyReportToWorkPackage(db, deps.dataDir, events, repo.workspaceId, updated, deps.ownedHelpers);
    if (reportPassed(check)) await queueSystemTask(db, events, repo.workspaceId, commitsCheckedTask(row.id));
  }
}

export type ReportFallbackOptions = {
  /** How often to look for uncovered moves. Default 5 minutes. */
  intervalMs?: number;
  /** How old a move must be before it counts as having no report. Default 30 minutes. */
  graceMs?: number;
  /** The clock; tests inject it. */
  now?: () => Date;
};

type MoveRow = { id: string; repo_id: string; from_sha: string | null; to_sha: string };

function uncoveredTask(repo: Repo, shas: string[]): string {
  return (
    `主分支有新提交但没有收到上报（仓库 ${repo.label}，${repo.id}）：\n${shas.join("\n")}\n` +
    "用 code__changes / code__read 判断它们对应哪些需求；仅凭代码推断的关联把 implementation 设为 reported，evidence.inferred 为 true，basis 为 inferred。"
  );
}

/** Commits of this repo's reports whose check found them on main. */
async function coveredCommits(db: Db, repo: Repo): Promise<string[]> {
  const rows = await db.query<{ sha: string }>(
    `select distinct c.sha from messages m, jsonb_array_elements_text(m.meta->'report'->'commits') as c(sha)
     where m.workspace_id = $1 and m.role = 'report'
       and m.meta->'report'->>'gitCommonDir' = $2
       and m.meta->'check'->>'onMain' = 'yes'
     order by c.sha`,
    [repo.workspaceId, repo.gitCommonDir],
  );
  return rows.map((r) => r.sha);
}

async function handleMove(db: Db, daemon: DaemonRpc, events: EventBus, move: MoveRow): Promise<void> {
  const markHandled = () => db.query(`update main_moves set handled = true where id = $1`, [move.id]);
  const repo = await getRepo(db, move.repo_id);
  // No earlier sha means no range to look at: the move only set the baseline.
  if (!repo || move.from_sha === null) {
    await markHandled();
    return;
  }
  const uncovered = await daemon.call("repo.uncovered", {
    workspaceId: repo.workspaceId,
    repoId: repo.id,
    path: repo.path,
    mainBranch: repo.mainBranch,
    from: move.from_sha,
    to: move.to_sha,
    covered: await coveredCommits(db, repo),
  });
  if (!Array.isArray(uncovered) || !uncovered.every((sha) => typeof sha === "string")) throw new Error("invalid repo.uncovered result");
  if (uncovered.length > 0) await queueSystemTask(db, events, repo.workspaceId, uncoveredTask(repo, uncovered as string[]));
  await markHandled();
}

/**
 * The no-report fallback: every `intervalMs`, each main move older than `graceMs` that is not handled yet is
 * compared against the commits reports cover. Uncovered commits start one system task per move. A daemon
 * error leaves the move unhandled, so a later tick tries again.
 */
export function startReportFallback(
  db: Db,
  daemon: DaemonRpc,
  events: EventBus,
  opts: ReportFallbackOptions = {},
): { tick: () => Promise<void>; stop: () => void; drain: () => Promise<void> } {
  const intervalMs = opts.intervalMs ?? 300_000;
  const graceMs = opts.graceMs ?? 1_800_000;
  const now = opts.now ?? (() => new Date());
  let running: Promise<void> | null = null;
  let stopped = false;

  const runTick = async (): Promise<void> => {
    const cutoff = new Date(now().getTime() - graceMs).toISOString();
    const moves = await db.query<MoveRow>(
      `select id::text as id, repo_id, from_sha, to_sha from main_moves where handled = false and at < $1 order by id`,
      [cutoff],
    );
    for (const move of moves) {
      try {
        await handleMove(db, daemon, events, move);
      } catch (error) {
        console.error(`report fallback for main move ${move.id} failed`, error);
      }
    }
  };
  // Ticks never overlap: a slow daemon call holds the next tick back.
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    running ??= runTick().finally(() => {
      running = null;
    });
    return running;
  };
  const timer = setInterval(() => {
    void tick().catch((error) => console.error("report fallback tick failed", error));
  }, intervalMs);
  timer.unref?.();
  return {
    tick,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    drain: async () => { await running; },
  };
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/**
 * `POST /report/hook` and `POST /report`. A wrong or missing token is a bare 401. A repo not bound to a
 * non-archived workspace is a 204 with nothing stored.
 */
export function reportRoutes(deps: ReportDeps): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (!(await authorized(deps.db, c.req.header("authorization")))) return c.body(null, 401);
    await next();
  });

  app.post("/hook", async (c) => {
    const parsed = HookSignal.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: "上报信号格式不对" }, 400);
    const repo = await routeRepo(deps.db, parsed.data.gitCommonDir);
    if (repo) await receiveHook(deps, repo, parsed.data);
    return c.body(null, 204);
  });

  // The packages a coding agent can fetch: approved or in progress, and covering the routed repo.
  const fetchable = async (gitCommonDir: string | undefined) => {
    if (!gitCommonDir || !deps.dataDir) return null;
    const repo = await routeRepo(deps.db, gitCommonDir);
    return repo ? { repo, store: new KnowledgeStore(repoPath(deps.dataDir, repo.workspaceId), deps.ownedHelpers) } : null;
  };
  const servable = (wp: { entry: { status: string; workpackage?: { repos: string[] } | undefined } }, repoId: string): boolean =>
    (wp.entry.status === "approved" || wp.entry.status === "in_progress") && (wp.entry.workpackage?.repos.includes(repoId) ?? false);

  app.get("/workpackages", async (c) => {
    const routed = await fetchable(c.req.query("gitCommonDir"));
    if (!routed) return c.body(null, 204);
    const out: { id: string; title: string; tasks: number }[] = [];
    for (const s of await routed.store.list()) {
      if (s.kind !== "workpackage") continue;
      const wp = await routed.store.readWorkPackage(s.id);
      if (wp && servable(wp, routed.repo.id)) out.push({ id: wp.entry.id, title: wp.entry.title, tasks: wp.entry.workpackage?.tasks.length ?? 0 });
    }
    return c.json(out);
  });

  app.get("/workpackages/:wid", async (c) => {
    const id = c.req.param("wid");
    const routed = await fetchable(c.req.query("gitCommonDir"));
    const wp = routed ? await routed.store.readWorkPackage(id) : null;
    if (!routed || !wp || !servable(wp, routed.repo.id) || wp.spec === null || wp.plan === null) return c.json({ error: `没有可取的开发包 ${id}` }, 404);
    return c.json({ id: wp.entry.id, title: wp.entry.title, spec: wp.spec, plan: wp.plan });
  });

  app.post("/", async (c) => {
    const parsed = ReportInput.safeParse(await body(c));
    if (!parsed.success) return c.json({ error: "上报内容不完整或格式不对" }, 400);
    const repo = await routeRepo(deps.db, parsed.data.gitCommonDir);
    if (!repo) return c.body(null, 204);
    // The check waits on a fetch of main; `nema report` gives up after 1.5 s, so the reply does not wait for it.
    const { messageId } = await receiveReport(deps, repo, parsed.data);
    return c.json({ messageId }, 202);
  });

  return app;
}
