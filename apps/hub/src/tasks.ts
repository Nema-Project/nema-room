import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { normalizeRemoteUrl } from "@nema/shared";
import type { Db } from "./db/db.js";

export type Task = {
  id: string;
  workspaceId: string;
  messageId: string;
  status: "queued" | "running" | "done" | "failed";
  runToken: string | null;
  daemonId: string | null;
  error: string | null;
  /** `workpackage` tasks write a work package and run with larger limits. */
  kind: "organize" | "workpackage" | "edit";
  /**
   * The account this message asked for, as the daemon will read it (spec 2026-10-31 §5.4). Opaque here: an
   * account id means nothing to the hub, and a stale one is the daemon's to report.
   */
  accountId: string | null;
  /** Whether this task allowed automatic routing. Only ever "auto" or null in this version. */
  routing: string | null;
};

/**
 * Task as exposed to the web UI (REST + SSE): never carries the run token or daemon id.
 *
 * The account choice stays out too. It is an input the daemon consumes, not a fact about the task's progress,
 * and the UI that would show it (S2's picker) reads the choice from where the user made it.
 */
export type UiTask = Omit<Task, "runToken" | "daemonId" | "kind" | "accountId" | "routing"> & {
  /**
   * Why a queued task is still waiting (D-6), derived live at read time, never stored. Absent unless the
   * caller computed it — only the daemon socket knows which daemons are online.
   */
  waitingReason?: WaitingReason | null;
};

/** Why a queued task has no daemon to run it. `missingRepos` are the bound repos' labels. */
export type WaitingReason =
  | { kind: "no-daemon-online" }
  | { kind: "no-member-daemon"; onlineDaemons: number }
  | { kind: "repo-not-held"; missingRepos: string[] };

/** One online daemon as the waiting-reason derivation sees it. `ownerUserId` null is the local daemon, which counts as a member of every workspace (D-6 rule ①). */
export type OnlineDaemon = { ownerUserId: string | null; heldRepos: ReadonlySet<string> };

export function toUiTask(t: Task, waitingReason?: WaitingReason | null): UiTask {
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    messageId: t.messageId,
    status: t.status,
    error: t.error,
    ...(waitingReason ? { waitingReason } : {}),
  };
}

/**
 * Why `task` is still queued, or null when no daemon-side reason applies (a qualified daemon is online, or
 * the workspace already has a running task and this one waits for it, not for a daemon).
 */
export async function computeWaitingReason(db: Db, task: Task, online: OnlineDaemon[]): Promise<WaitingReason | null> {
  if (task.status !== "queued") return null;
  const [running] = await db.query<{ ok: number }>(
    `select 1 as ok from tasks where workspace_id = $1 and status = 'running' limit 1`,
    [task.workspaceId],
  );
  if (running) return null;
  if (online.length === 0) return { kind: "no-daemon-online" };
  const members = await db.query<{ user_id: string }>(
    `select user_id from workspace_members where workspace_id = $1 and removed_at is null`,
    [task.workspaceId],
  );
  const memberIds = new Set(members.map((m) => m.user_id));
  const memberDaemons = online.filter((d) => d.ownerUserId === null || memberIds.has(d.ownerUserId));
  if (memberDaemons.length === 0) return { kind: "no-member-daemon", onlineDaemons: online.length };
  const repos = await db.query<{ label: string; remote_url: string | null }>(
    `select label, remote_url from workspace_repos where workspace_id = $1`,
    [task.workspaceId],
  );
  const missing: string[] = [];
  for (const repo of repos) {
    const normalized = normalizeRemoteUrl(repo.remote_url);
    // A bound repo with no remote has nothing to hold; it cannot block routing.
    if (normalized === null) continue;
    if (!memberDaemons.some((d) => d.heldRepos.has(normalized))) missing.push(repo.label);
  }
  if (missing.length === 0) return null;
  return { kind: "repo-not-held", missingRepos: missing };
}

type Row = {
  id: string;
  workspace_id: string;
  message_id: string;
  status: Task["status"];
  run_token: string | null;
  daemon_id: string | null;
  error: string | null;
  kind: Task["kind"];
  account_id: string | null;
  routing: string | null;
};

const COLS = "id, workspace_id, message_id, status, run_token, daemon_id, error, kind, account_id, routing";

function toTask(r: Row): Task {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    messageId: r.message_id,
    status: r.status,
    runToken: r.run_token,
    daemonId: r.daemon_id,
    error: r.error,
    kind: r.kind,
    accountId: r.account_id,
    routing: r.routing,
  };
}

export async function insertQueuedTask(
  db: Db,
  workspaceId: string,
  messageId: string,
  kind: Task["kind"] = "organize",
  choice: { accountId?: string | null; routing?: string | null } = {},
): Promise<Task> {
  const rows = await db.query<Row>(
    `insert into tasks(id, workspace_id, message_id, status, kind, account_id, routing, created_at)
     values ($1, $2, $3, 'queued', $4, $5, $6, clock_timestamp()) returning ${COLS}`,
    [`t_${nanoid(12)}`, workspaceId, messageId, kind, choice.accountId ?? null, choice.routing ?? null],
  );
  return toTask(rows[0]!);
}

/**
 * The registered owner of a daemon, for routing. Null is the local (unregistered) daemon, which counts as
 * a member of every workspace; undefined is a revoked registration, which may claim nothing.
 */
export async function getDaemonOwner(db: Db, daemonId: string): Promise<string | null | undefined> {
  const [row] = await db.query<{ owner_user_id: string; revoked_at: Date | string | null }>(
    `select owner_user_id, revoked_at from daemons where id = $1`,
    [daemonId],
  );
  if (!row) return null;
  if (row.revoked_at !== null) return undefined;
  return row.owner_user_id;
}

/**
 * Claims the oldest queued task this daemon is qualified for (D-6). A candidate is skipped, never claimed,
 * unless ① its owner is an unremoved member of the task's workspace (a local daemon counts everywhere),
 * ② every bound repo's normalized remote is in the daemon's held set (no bound repos, or a repo with no
 * remote, makes this vacuous), and ③ the workspace has nothing running (the existing invariant, kept in
 * both the candidate query and the update). Eligibility is decided before the update, inside the same
 * transaction, so a claim never has to be discovered unqualified afterwards.
 */
export async function claimNextTask(db: Db, daemonId: string, opts: { heldRepos?: Iterable<string> } = {}): Promise<Task | null> {
  return db.tx(async (t) => {
    const owner = await getDaemonOwner(t, daemonId);
    if (owner === undefined) return null;
    const held = new Set<string>();
    for (const raw of opts.heldRepos ?? []) {
      const normalized = normalizeRemoteUrl(raw);
      if (normalized !== null) held.add(normalized);
    }
    const cand = await t.query<{ id: string; workspace_id: string }>(
      `select t.id, t.workspace_id from tasks t
       join workspaces w on w.id = t.workspace_id
       where t.status = 'queued'
         and w.archived_at is null
         and not exists (select 1 from tasks r where r.workspace_id = t.workspace_id and r.status = 'running')
       order by t.seq
       limit 50
       for update of t, w skip locked`,
    );
    for (const c of cand) {
      if (owner !== null) {
        const [member] = await t.query<{ ok: number }>(
          `select 1 as ok from workspace_members where workspace_id = $1 and user_id = $2 and removed_at is null`,
          [c.workspace_id, owner],
        );
        if (!member) continue;
      }
      const repos = await t.query<{ remote_url: string | null }>(
        `select remote_url from workspace_repos where workspace_id = $1`,
        [c.workspace_id],
      );
      const required = repos
        .map((r) => normalizeRemoteUrl(r.remote_url))
        .filter((r): r is string => r !== null);
      if (!required.every((r) => held.has(r))) continue;
      const rows = await t.query<Row>(
        `update tasks set status = 'running', run_token = $2, daemon_id = $3, started_at = now(), error = null
         where id = $1 and status = 'queued'
           and not exists (select 1 from tasks r where r.workspace_id = tasks.workspace_id and r.status = 'running')
         returning ${COLS}`,
        [c.id, randomBytes(32).toString("hex"), daemonId],
      );
      if (rows[0]) return toTask(rows[0]);
    }
    return null;
  });
}

/** Returns true iff a running task was finished (and, if given, its run token matched). */
export async function finishTask(
  db: Db,
  taskId: string,
  result: { ok: true } | { ok: false; error: string },
  expectedRunToken?: string,
): Promise<boolean> {
  const params: unknown[] = [taskId, result.ok ? "done" : "failed", result.ok ? null : result.error];
  let tokenCond = "";
  if (expectedRunToken !== undefined) {
    params.push(expectedRunToken);
    tokenCond = ` and run_token = $${params.length}`;
  }
  const rows = await db.query(
    `update tasks set status = $2, error = $3, run_token = null, finished_at = now()
     where id = $1 and status = 'running'${tokenCond} returning id`,
    params,
  );
  return rows.length > 0;
}

/** The workspace's currently running task, if any (most recently started wins). */
export async function getRunningTask(db: Db, workspaceId: string): Promise<Task | null> {
  const rows = await db.query<Row>(`select ${COLS} from tasks where workspace_id = $1 and status = 'running' order by seq desc limit 1`, [workspaceId]);
  return rows[0] ? toTask(rows[0]) : null;
}

export async function listQueuedTasks(db: Db, workspaceId: string): Promise<Task[]> {
  const rows = await db.query<Row>(`select ${COLS} from tasks where workspace_id = $1 and status = 'queued' order by seq`, [workspaceId]);
  return rows.map(toTask);
}

export async function getTask(db: Db, taskId: string): Promise<Task | null> {
  const rows = await db.query<Row>(`select ${COLS} from tasks where id = $1`, [taskId]);
  return rows[0] ? toTask(rows[0]) : null;
}

export async function requeueDaemonTasks(db: Db, daemonId: string): Promise<number> {
  const rows = await db.query(
    `update tasks set status = 'queued', run_token = null, daemon_id = null, started_at = null
     where daemon_id = $1 and status = 'running' returning id`,
    [daemonId],
  );
  return rows.length;
}

/** A running task may be interrupted this many times and still return to the queue. */
export const MAX_INTERRUPT_RETRIES = 3;

export const INTERRUPTED_ERROR = "任务被中断，自动重试 3 次后仍未完成。请重新发送这条消息。";

/**
 * Counts one interruption on each matching running task. The 1st–3rd return it to the queue
 * (run token cleared). The 4th fails it. One transaction. Dispatch races use requeueDaemonTasks
 * instead, so a claim that never reached the daemon does not spend a retry.
 */
export async function interruptRunning(
  db: Db,
  scope: { daemonId: string } | { exceptDaemonId: string } | { exceptDaemonIds: string[] } | "all",
): Promise<{ requeued: string[]; failed: string[] }> {
  const params: unknown[] = [MAX_INTERRUPT_RETRIES, INTERRUPTED_ERROR];
  let where = "status = 'running'";
  if (scope !== "all") {
    if ("daemonId" in scope) {
      params.push(scope.daemonId);
      where += ` and daemon_id = $${params.length}`;
    } else if ("exceptDaemonId" in scope) {
      params.push(scope.exceptDaemonId);
      where += ` and daemon_id is distinct from $${params.length}`;
    } else {
      // Every running task not held by one of these daemons (the hub's listed connections).
      params.push(scope.exceptDaemonIds);
      where += ` and (daemon_id is null or not (daemon_id = any($${params.length}::text[])))`;
    }
  }
  const rows = await db.tx((t) =>
    t.query<{ id: string; status: Task["status"] }>(
      `update tasks set
         interruptions = interruptions + 1,
         status = case when interruptions + 1 <= $1 then 'queued' else 'failed' end,
         error = case when interruptions + 1 <= $1 then error else $2 end,
         run_token = null,
         daemon_id = case when interruptions + 1 <= $1 then null else daemon_id end,
         started_at = case when interruptions + 1 <= $1 then null else started_at end,
         finished_at = case when interruptions + 1 <= $1 then finished_at else now() end
       where ${where}
       returning id, status`,
      params,
    ),
  );
  return {
    requeued: rows.filter((r) => r.status === "queued").map((r) => r.id),
    failed: rows.filter((r) => r.status === "failed").map((r) => r.id),
  };
}

export async function resolveRunToken(db: Db, token: string): Promise<{ taskId: string; workspaceId: string } | null> {
  const rows = await db.query<{ id: string; workspace_id: string }>(
    `select id, workspace_id from tasks where run_token = $1 and status = 'running'`,
    [token],
  );
  return rows[0] ? { taskId: rows[0].id, workspaceId: rows[0].workspace_id } : null;
}

export type TaskChange = { entryId: string; kind: string; title: string; op: "add" | "update" };

/** One row per (task, entry): latest kind/title wins, op stays "add" if any change was an add. */
export async function recordTaskChange(db: Db, taskId: string, change: TaskChange): Promise<void> {
  await db.tx(async (t) => {
    const ex = await t.query<{ op: string }>(`select op from task_changes where task_id = $1 and entry_id = $2 for update`, [
      taskId,
      change.entryId,
    ]);
    if (ex.length === 0) {
      await t.query(`insert into task_changes(task_id, entry_id, kind, title, op) values ($1,$2,$3,$4,$5)`, [
        taskId,
        change.entryId,
        change.kind,
        change.title,
        change.op,
      ]);
    } else {
      const op = ex.some((r) => r.op === "add") || change.op === "add" ? "add" : "update";
      await t.query(`update task_changes set kind = $3, title = $4, op = $5 where task_id = $1 and entry_id = $2`, [
        taskId,
        change.entryId,
        change.kind,
        change.title,
        op,
      ]);
    }
  });
}

export async function listTaskChanges(db: Db, taskId: string): Promise<TaskChange[]> {
  const rows = await db.query<{ entry_id: string; kind: string; title: string; op: "add" | "update" }>(
    `select entry_id, kind, title, op from task_changes where task_id = $1 order by created_at, entry_id`,
    [taskId],
  );
  return rows.map((r) => ({ entryId: r.entry_id, kind: r.kind, title: r.title, op: r.op }));
}
