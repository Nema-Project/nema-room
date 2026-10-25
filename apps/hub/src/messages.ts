import { nanoid } from "nanoid";
import type { AgentMessageMeta, ReportMessageMeta, UserMessageMeta } from "@nema/shared";
import type { Db } from "./db/db.js";
import { insertQueuedTask, type Task } from "./tasks.js";

export type Message = {
  id: string;
  workspaceId: string;
  role: "user" | "agent" | "system" | "report";
  content: string;
  /** Agent messages carry AgentMessageMeta; report messages carry ReportMessageMeta; user messages may carry UserMessageMeta. */
  meta: AgentMessageMeta | ReportMessageMeta | UserMessageMeta | null;
  taskId: string | null;
  createdAt: string;
  editedAt: string | null;
};

/** An agent message: its meta, when present, is always AgentMessageMeta. */
export type AgentMessage = Message & { role: "agent"; meta: AgentMessageMeta | null };

type Row = {
  id: string;
  workspace_id: string;
  role: Message["role"];
  content: string;
  meta: Message["meta"];
  task_id: string | null;
  created_at: Date | string;
  edited_at: Date | string | null;
};

const COLS = "id, workspace_id, role, content, meta, task_id, created_at, edited_at";

export function messageExcerpt(content: string, max = 200): string {
  return Array.from(content).slice(0, max).join("");
}

export class MessageOpError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "MessageOpError";
  }
}

function toMessage(r: Row): Message {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    role: r.role,
    content: r.content,
    meta: r.meta ?? null,
    taskId: r.task_id,
    createdAt: new Date(r.created_at).toISOString(),
    editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
  };
}

async function insertMessage(
  db: Db,
  workspaceId: string,
  role: Message["role"],
  content: string,
  taskId: string | null,
  meta: Message["meta"],
): Promise<Message> {
  const rows = await db.query<Row>(
    `insert into messages(id, workspace_id, role, content, meta, task_id, created_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, clock_timestamp()) returning ${COLS}`,
    [`m_${nanoid(12)}`, workspaceId, role, content, meta === null ? null : JSON.stringify(meta), taskId],
  );
  return toMessage(rows[0]!);
}

export async function postUserMessage(
  db: Db,
  workspaceId: string,
  content: string,
  quoteMessageId?: string,
): Promise<{ message: Message; task: Task }> {
  if (content.trim() === "") throw new Error("message content must not be empty");
  return db.tx(async (t) => {
    let meta: UserMessageMeta | null = null;
    if (quoteMessageId) {
      const quoted = await getMessage(t, quoteMessageId);
      if (!quoted || quoted.workspaceId !== workspaceId) throw new MessageOpError(400, "quote: message not in this workspace");
      meta = { quote: { messageId: quoted.id, role: quoted.role, excerpt: messageExcerpt(quoted.content) } };
    }
    const message = await insertMessage(t, workspaceId, "user", content, null, meta);
    const task = await insertQueuedTask(t, workspaceId, message.id);
    return { message, task };
  });
}

export const EDIT_BUSY_MESSAGE = "message is still being processed";

export type MessageVersion = { version: number; content: string; createdAt: string };

export async function listMessageVersions(db: Db, messageId: string): Promise<MessageVersion[]> {
  const rows = await db.query<{ version: number; content: string; created_at: Date | string }>(
    `select version, content, created_at from message_versions where message_id = $1 order by version asc`,
    [messageId],
  );
  return rows.map((r) => ({ version: r.version, content: r.content, createdAt: new Date(r.created_at).toISOString() }));
}

export async function editUserMessage(
  db: Db,
  workspaceId: string,
  messageId: string,
  content: string,
): Promise<{ message: Message; task: Task }> {
  if (content.trim() === "") throw new Error("message content must not be empty");
  return db.tx(async (t) => {
    const locked = await t.query<Row>(`select ${COLS} from messages where id = $1 and workspace_id = $2 for update`, [messageId, workspaceId]);
    const row = locked[0];
    if (!row) throw new MessageOpError(404, "message not found");
    if (row.role !== "user") throw new MessageOpError(400, "only user messages can be edited");
    const ws = await t.query<{ archived_at: Date | string | null }>(`select archived_at from workspaces where id = $1`, [workspaceId]);
    if (ws[0]?.archived_at) throw new ArchivedWorkspaceError();
    const busy = await t.query(`select 1 from tasks where message_id = $1 and status in ('queued', 'running') limit 1`, [messageId]);
    if (busy.length > 0) throw new MessageOpError(409, EDIT_BUSY_MESSAGE);
    await t.query(
      `insert into message_versions(message_id, version, content, created_at)
       select $1, coalesce((select max(version) from message_versions where message_id = $1), 0) + 1, content, coalesce(edited_at, created_at)
       from messages where id = $1`,
      [messageId],
    );
    const updated = await t.query<Row>(`update messages set content = $2, edited_at = clock_timestamp() where id = $1 returning ${COLS}`, [
      messageId,
      content,
    ]);
    const task = await insertQueuedTask(t, workspaceId, messageId, "edit");
    return { message: toMessage(updated[0]!), task };
  });
}

export const ARCHIVED_MESSAGE = "workspace is archived; unarchive it to send messages";

/** Thrown when a message would start a task in an archived workspace. The UI API answers 409. */
export class ArchivedWorkspaceError extends Error {
  constructor() {
    super(ARCHIVED_MESSAGE);
    this.name = "ArchivedWorkspaceError";
  }
}

/**
 * Work the system starts itself (draw on bind, update on request): a `system` message and a queued
 * task for it, in one transaction. An archived workspace is refused like a user message.
 */
export async function postSystemTask(
  db: Db,
  workspaceId: string,
  content: string,
  opts: { kind?: Task["kind"] } = {},
): Promise<{ message: Message; task: Task }> {
  if (content.trim() === "") throw new Error("message content must not be empty");
  return db.tx(async (t) => {
    const ws = await t.query<{ archived_at: Date | string | null }>(`select archived_at from workspaces where id = $1`, [workspaceId]);
    if (!ws[0]) throw new Error(`workspace not found: ${workspaceId}`);
    if (ws[0].archived_at) throw new ArchivedWorkspaceError();
    const message = await insertMessage(t, workspaceId, "system", content, null, null);
    const task = await insertQueuedTask(t, workspaceId, message.id, opts.kind ?? "organize");
    return { message, task };
  });
}

/** A coding agent's report, stored before its check runs. Its task is queued separately, once the check is stored. */
export function addReportMessage(db: Db, workspaceId: string, content: string, meta: ReportMessageMeta): Promise<Message> {
  return insertMessage(db, workspaceId, "report", content, null, meta);
}

/** Replaces a report message's meta, for example once its check is stored. Returns the updated message, or null when there is no such report. */
export async function setReportMeta(db: Db, messageId: string, meta: ReportMessageMeta): Promise<Message | null> {
  const rows = await db.query<Row>(`update messages set meta = $2::jsonb where id = $1 and role = 'report' returning ${COLS}`, [
    messageId,
    JSON.stringify(meta),
  ]);
  return rows[0] ? toMessage(rows[0]) : null;
}

export function addMessage(
  db: Db,
  workspaceId: string,
  role: "agent" | "system",
  content: string,
  opts: { taskId?: string; meta?: AgentMessageMeta } = {},
): Promise<Message> {
  return insertMessage(db, workspaceId, role, content, opts.taskId ?? null, opts.meta ?? null);
}

/** Latest `limit` messages, returned oldest first. */
export async function listMessages(db: Db, workspaceId: string, limit = 200): Promise<Message[]> {
  const rows = await db.query<Row>(
    `select * from (select ${COLS}, seq from messages where workspace_id = $1 order by seq desc limit $2) m
     order by seq asc`,
    [workspaceId, limit],
  );
  return rows.map(toMessage);
}

export async function getMessage(db: Db, id: string): Promise<Message | null> {
  const rows = await db.query<Row>(`select ${COLS} from messages where id = $1`, [id]);
  return rows[0] ? toMessage(rows[0]) : null;
}

/** Latest agent message in the workspace, or null. */
export async function getLastAgentMessage(db: Db, workspaceId: string): Promise<AgentMessage | null> {
  const rows = await db.query<Row>(
    `select ${COLS} from messages where workspace_id = $1 and role = 'agent' order by seq desc limit 1`,
    [workspaceId],
  );
  return rows[0] ? (toMessage(rows[0]) as AgentMessage) : null;
}

/**
 * Last `limit` messages (oldest first) excluding the given user message and any user message
 * posted after it; agent/system messages posted after it are included.
 */
export async function listPromptMessages(db: Db, workspaceId: string, userMessageId: string, limit = 20): Promise<Message[]> {
  const rows = await db.query<Row>(
    `select * from (
       select ${COLS}, seq from messages
       where workspace_id = $1 and id <> $2
         and (role <> 'user' or seq < (select seq from messages where id = $2))
       order by seq desc limit $3) m
     order by seq asc`,
    [workspaceId, userMessageId, limit],
  );
  return rows.map(toMessage);
}
