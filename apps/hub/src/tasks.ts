import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
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
};

/** Task as exposed to the web UI (REST + SSE): never carries the run token or daemon id. */
export type UiTask = Omit<Task, "runToken" | "daemonId" | "kind">;

export function toUiTask(t: Task): UiTask {
  return { id: t.id, workspaceId: t.workspaceId, messageId: t.messageId, status: t.status, error: t.error };
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
};

const COLS = "id, workspace_id, message_id, status, run_token, daemon_id, error, kind";

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
  };
}

export async function insertQueuedTask(db: Db, workspaceId: string, messageId: string, kind: Task["kind"] = "organize"): Promise<Task> {
  const rows = await db.query<Row>(
    `insert into tasks(id, workspace_id, message_id, status, kind, created_at)
     values ($1, $2, $3, 'queued', $4, clock_timestamp()) returning ${COLS}`,
    [`t_${nanoid(12)}`, workspaceId, messageId, kind],
  );
  return toTask(rows[0]!);
}

/**
 * Claims the oldest queued task whose workspace has nothing running.
 * Locks the task row and its workspace row (SKIP LOCKED) so concurrent claimers
 * neither take the same task nor two tasks of one workspace; the update re-checks
 * "no running task" with a fresh statement snapshot after the locks are held.
 */
export async function claimNextTask(db: Db, daemonId: string): Promise<Task | null> {
  return db.tx(async (t) => {
    const cand = await t.query<{ id: string }>(
      `select t.id from tasks t
       join workspaces w on w.id = t.workspace_id
       where t.status = 'queued'
         and w.archived_at is null
         and not exists (select 1 from tasks r where r.workspace_id = t.workspace_id and r.status = 'running')
       order by t.seq
       limit 1
       for update of t, w skip locked`,
    );
    if (!cand[0]) return null;
    const rows = await t.query<Row>(
      `update tasks set status = 'running', run_token = $2, daemon_id = $3, started_at = now(), error = null
       where id = $1 and status = 'queued'
         and not exists (select 1 from tasks r where r.workspace_id = tasks.workspace_id and r.status = 'running')
       returning ${COLS}`,
      [cand[0].id, randomBytes(32).toString("hex"), daemonId],
    );
    return rows[0] ? toTask(rows[0]) : null;
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
  scope: { daemonId: string } | { exceptDaemonId: string } | "all",
): Promise<{ requeued: string[]; failed: string[] }> {
  const params: unknown[] = [MAX_INTERRUPT_RETRIES, INTERRUPTED_ERROR];
  let where = "status = 'running'";
  if (scope !== "all") {
    if ("daemonId" in scope) {
      params.push(scope.daemonId);
      where += ` and daemon_id = $${params.length}`;
    } else {
      params.push(scope.exceptDaemonId);
      where += ` and daemon_id is distinct from $${params.length}`;
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
