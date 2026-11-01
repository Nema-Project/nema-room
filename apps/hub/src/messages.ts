import { nanoid } from "nanoid";
import {
  ATTACHMENT_LIMITS,
  messageHasBody,
  type AgentMessageMeta,
  type AttachmentRef,
  type AttachmentView,
  type GithubObservation,
  type ReportAuthors,
  type ReportCheck,
  type MessageMention,
  type ReportMessageMeta,
  type UserMessageMeta,
} from "@nema/shared";
import { AttachmentError, bindAttachments, listAttachmentsByIds, listAttachmentsForMessages, toAttachmentRef } from "./attachments.js";
import { filterMentionsForEdit, mentionedAttachmentIds, validateMentions } from "./mentions.js";
import type { Db } from "./db/db.js";
import { getTask, insertQueuedTask, type Task } from "./tasks.js";
import { conversationOf, getLastAgentMessage, getLastAskedQuestion } from "./threads.js";

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
  threadId: string | null;
  /** Database sequence for acknowledging exactly the rendered thread messages. */
  seq: number;
  /** Files bound to a user message, tombstones included; [] for every other message. */
  attachments: AttachmentView[];
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
  thread_id: string | null;
  seq: number | string;
};

const COLS = "id, workspace_id, role, content, meta, task_id, created_at, edited_at, thread_id, seq";

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
    threadId: r.thread_id,
    seq: Number(r.seq),
    attachments: [],
  };
}

/** Fills `attachments` on user messages with one query; other roles never carry files. */
async function withAttachments(db: Db, messages: Message[]): Promise<Message[]> {
  const ids = messages.filter((m) => m.role === "user").map((m) => m.id);
  if (ids.length === 0) return messages;
  const byMessage = await listAttachmentsForMessages(db, ids);
  return messages.map((m) => (byMessage.has(m.id) ? { ...m, attachments: byMessage.get(m.id)! } : m));
}

export const DELIVERY_LIMIT_MESSAGE = `本条、被引用消息和 thread 锚点的附件合计超过 32 MB 或 ${ATTACHMENT_LIMITS.perTaskCount} 个，请去掉一些附件或不引用那条消息`;

/** Files of `message`, of the message it quotes, of its thread anchor, then the files it mentions; each once, tombstones included. */
async function deliveryViewsFor(db: Db, message: Message): Promise<AttachmentView[]> {
  if (message.role !== "user") return [];
  const meta = message.meta as UserMessageMeta | null;
  const quoteId = meta?.quote?.messageId;
  const sources = [...new Set([message.id, ...(quoteId ? [quoteId] : []), ...(message.threadId ? [message.threadId] : [])])];
  const byMessage = await listAttachmentsForMessages(db, sources);
  // Files the message mentions travel with it too, in mention order, after its own and its quote's.
  const mentioned = (await listAttachmentsByIds(db, message.workspaceId, mentionedAttachmentIds(meta?.mentions)));
  const seen = new Set<string>();
  const views: AttachmentView[] = [];
  const push = (view: AttachmentView) => {
    if (seen.has(view.id)) return;
    seen.add(view.id);
    views.push(view);
  };
  for (const source of sources) for (const view of byMessage.get(source) ?? []) push(view);
  for (const view of mentioned) push(view);
  return views;
}

/**
 * The attachments a task for `message` delivers. Deleted files are left out; a missing file stays in so the task
 * fails plainly when the daemon cannot fetch it.
 */
async function deliverySetFor(db: Db, message: Message): Promise<AttachmentRef[]> {
  return (await deliveryViewsFor(db, message)).filter((v) => v.status !== "deleted").map(toAttachmentRef);
}

async function taskMessage(db: Db, taskId: string): Promise<Message | null> {
  const task = await getTask(db, taskId);
  return task ? getMessage(db, task.messageId) : null;
}

/** Ids the room may serve to task `taskId`: its delivery set plus files deleted from it since (answered 410). */
export async function deliveryScope(db: Db, taskId: string): Promise<Set<string>> {
  const message = await taskMessage(db, taskId);
  return new Set(message ? (await deliveryViewsFor(db, message)).map((v) => v.id) : []);
}

/** The attachments task `taskId` hands to the daemon (task.assign.attachments) and may fetch from the room. */
export async function deliverySet(db: Db, taskId: string): Promise<AttachmentRef[]> {
  const message = await taskMessage(db, taskId);
  return message ? deliverySetFor(db, message) : [];
}

async function insertMessage(
  db: Db,
  workspaceId: string,
  role: Message["role"],
  content: string,
  taskId: string | null,
  meta: Message["meta"],
  threadId: string | null = null,
): Promise<Message> {
  const rows = await db.query<Row>(
    `insert into messages(id, workspace_id, role, content, meta, task_id, created_at, thread_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, clock_timestamp(), $7) returning ${COLS}`,
    [`m_${nanoid(12)}`, workspaceId, role, content, meta === null ? null : JSON.stringify(meta), taskId, threadId],
  );
  return toMessage(rows[0]!);
}

export type PostUserMessageOptions = {
  quoteMessageId?: string;
  threadId?: string;
  attachmentIds?: string[];
  mentions?: MessageMention[];
  /**
   * The account the user picked for this one message (spec 2026-10-31 §5.4). Carried to the daemon, which is
   * the only side that knows whether it exists. Shape-checked here so a free string never reaches a task row
   * that ends up in `task.assign`.
   */
  accountId?: string;
};

/** The shape an account id must have to leave this process; the daemon re-checks it against its own file. */
const ACCOUNT_ID = /^acct_[a-z0-9]{10}$/;

/**
 * A user message and its queued task, in one transaction. With attachment ids, the uploads are locked first: if they
 * are already bound to one message that matches this request exactly (same files, text, quote and thread), that
 * message and its task come back with `replayed: true` and nothing is written. Any other bound state is a 409.
 */
export async function postUserMessage(
  db: Db,
  workspaceId: string,
  content: string,
  opts: PostUserMessageOptions | string = {},
): Promise<{ message: Message; task: Task; replayed: boolean }> {
  const options = typeof opts === "string" ? { quoteMessageId: opts } : opts;
  const mentions = options.mentions ?? [];
  const attachmentIds = [...new Set(options.attachmentIds ?? [])].sort();
  if (!messageHasBody(content, attachmentIds)) throw new MessageOpError(400, "message content must not be empty");
  if (options.accountId !== undefined && !ACCOUNT_ID.test(options.accountId)) {
    throw new MessageOpError(400, "accountId must be an account id");
  }
  try {
    return await db.tx(async (t) => {
      if (attachmentIds.length > 0) {
        const replay = await lockForSend(t, workspaceId, content, options, attachmentIds);
        if (replay) return { ...replay, replayed: true };
      }
      await validateMentions(t, workspaceId, content, mentions);
      let meta: UserMessageMeta | null = null;
      if (options.threadId) {
        const thread = await t.query<{ workspace_id: string }>("select workspace_id from threads where id=$1", [options.threadId]);
        if (!thread[0] || thread[0].workspace_id !== workspaceId) throw new MessageOpError(400, "thread not in this workspace");
      }
      if (options.quoteMessageId) {
        const quoted = await getMessage(t, options.quoteMessageId);
        if (!quoted || quoted.workspaceId !== workspaceId) throw new MessageOpError(400, "quote: message not in this workspace");
        meta = { quote: { messageId: quoted.id, role: quoted.role, excerpt: messageExcerpt(quoted.content) } };
      }
      if (mentions.length > 0) meta = { ...(meta ?? {}), mentions };
      const inserted = await insertMessage(t, workspaceId, "user", content, null, meta, options.threadId ?? null);
      const attachments = await bindAttachments(t, workspaceId, inserted.id, attachmentIds);
      const message = { ...inserted, attachments: await reorder(t, inserted.id, attachments) };
      const delivered = await deliverySetFor(t, message);
      if (delivered.length > ATTACHMENT_LIMITS.perTaskCount || delivered.reduce((sum, r) => sum + r.size, 0) > ATTACHMENT_LIMITS.perTaskBytes) {
        throw new MessageOpError(400, DELIVERY_LIMIT_MESSAGE);
      }
      const task = await insertQueuedTask(t, workspaceId, message.id, "organize", {
        ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
      });
      return { message, task, replayed: false };
    });
  } catch (e) {
    if (e instanceof AttachmentError) throw new MessageOpError(e.status === 404 ? 404 : e.status === 400 ? 400 : 409, e.message);
    throw e;
  }
}

/** Same order as listAttachmentsForMessages, so a fresh send and a later read agree. */
async function reorder(db: Db, messageId: string, fallback: AttachmentView[]): Promise<AttachmentView[]> {
  if (fallback.length === 0) return fallback;
  return (await listAttachmentsForMessages(db, [messageId])).get(messageId) ?? fallback;
}

/** Replay compares what a mention points at and its stored text; order matters, nothing else is looked at. */
function sameMentions(a: readonly MessageMention[] | undefined, b: readonly MessageMention[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((m, i) => m.type === right[i]!.type && m.id === right[i]!.id && m.text === right[i]!.text);
}

/**
 * Locks the requested uploads (in id order, so concurrent sends queue here). Returns null when all are unsent;
 * returns the earlier message and task when this request is a retry of it; throws 409 otherwise.
 */
async function lockForSend(
  t: Db,
  workspaceId: string,
  content: string,
  options: PostUserMessageOptions,
  ids: string[],
): Promise<{ message: Message; task: Task } | null> {
  const rows = await t.query<{ id: string; status: string; message_id: string | null }>(
    "select id, status, message_id from message_attachments where id = any($1) and workspace_id = $2 order by id for update",
    [ids, workspaceId],
  );
  if (rows.length !== ids.length) throw new MessageOpError(409, "attachments must be unsent uploads of this workspace");
  if (rows.every((r) => r.status === "staged")) return null;
  const messageId = rows[0]!.message_id;
  const conflict = new MessageOpError(409, "these attachments were already sent with a different message");
  if (!messageId || !rows.every((r) => r.status === "attached" && r.message_id === messageId)) throw conflict;
  const prior = await getMessage(t, messageId);
  if (!prior || prior.workspaceId !== workspaceId || prior.role !== "user") throw conflict;
  const boundIds = prior.attachments.map((a) => a.id).sort();
  const priorQuote = (prior.meta as UserMessageMeta | null)?.quote?.messageId ?? null;
  const same =
    boundIds.length === ids.length && boundIds.every((id, i) => id === ids[i]) &&
    prior.content === content &&
    priorQuote === (options.quoteMessageId ?? null) &&
    prior.threadId === (options.threadId ?? null) &&
    sameMentions((prior.meta as UserMessageMeta | null)?.mentions, options.mentions);
  if (!same) throw conflict;
  const first = await t.query<{ id: string }>("select id from tasks where message_id = $1 order by seq limit 1", [messageId]);
  const task = first[0] ? await getTask(t, first[0].id) : null;
  if (!task) throw conflict;
  // A retry that names a different account is a different request, not a replay of this one: returning the
  // earlier task would answer with the route the user had already moved away from.
  if (task.accountId !== (options.accountId ?? null)) throw conflict;
  return { message: prior, task };
}

export const EDIT_BUSY_MESSAGE = "message is still being processed";

export type MessageVersion = { version: number; content: string; createdAt: string };

/** Current message text only. `%`, `_`, and `\` in `q` are literal. Blank `q` matches nothing. */
export async function searchMessages(db: Db, workspaceId: string, q: string): Promise<Message[]> {
  const term = q.trim();
  if (term === "") return [];
  const pattern = "%" + term.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const rows = await db.query<Row>(
    `select ${COLS} from messages where workspace_id = $1 and content ilike $2 escape '\\' order by seq desc limit 50`,
    [workspaceId, pattern],
  );
  return withAttachments(db, rows.map(toMessage));
}

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
  return db.tx(async (t) => {
    const locked = await t.query<Row>(`select ${COLS} from messages where id = $1 and workspace_id = $2 for update`, [messageId, workspaceId]);
    const row = locked[0];
    if (!row) throw new MessageOpError(404, "message not found");
    if (row.role !== "user") throw new MessageOpError(400, "only user messages can be edited");
    if (content.trim() === "") {
      // Text may only go while the message still has a file the task can deliver. The rows are locked so a
      // delete running at the same time waits for this edit (or this edit sees the delete). A missing file
      // does not count: its task would only fail when the daemon fetched it.
      const usable = await t.query(
        "select id from message_attachments where message_id = $1 and status = 'attached' order by id for update",
        [messageId],
      );
      if (usable.length === 0) throw new MessageOpError(400, "message content must not be empty");
    }
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
    // A mention survives only while the text it wrote is still in the body; dropping it never drops the file.
    const prior = toMessage(row);
    const priorMentions = (prior.meta as UserMessageMeta | null)?.mentions ?? [];
    const kept = filterMentionsForEdit(content, priorMentions);
    const nextMeta: UserMessageMeta | null = kept.length > 0
      ? { ...(prior.meta as UserMessageMeta | null), mentions: kept }
      : prior.meta === null
        ? null
        : (() => {
            const { mentions: _dropped, ...rest } = prior.meta as UserMessageMeta;
            return Object.keys(rest).length > 0 ? rest : null;
          })();
    const updated = await t.query<Row>(`update messages set content = $2, meta = $3::jsonb, edited_at = clock_timestamp() where id = $1 returning ${COLS}`, [
      messageId,
      content,
      nextMeta === null ? null : JSON.stringify(nextMeta),
    ]);
    // The edit is the same request with new text, so it runs on the account the first run used. Without
    // this the row would be null and the edit could quietly land on a different account. The first task is
    // read, not copied from a request field: nothing in an edit names an account.
    const first = await t.query<{ account_id: string | null }>(
      "select account_id from tasks where message_id = $1 order by seq limit 1",
      [messageId],
    );
    const task = await insertQueuedTask(t, workspaceId, messageId, "edit", { accountId: first[0]?.account_id ?? null });
    const [message] = await withAttachments(t, [toMessage(updated[0]!)]);
    return { message: message!, task };
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

/**
 * The hub's own observations a writer may replace on a report message. `report` (the agent's claim) and
 * `checkHistory` are not here: the claim is never rewritten, and the history is appended by the merge.
 * `github` is the new current observation; the merge moves the previous one into `history`.
 */
export type ReportMetaPatch = {
  check?: ReportCheck | null;
  checkError?: string | null;
  checkSkipped?: "in_progress_no_commits" | null;
  authors?: ReportAuthors;
  github?: GithubObservation;
};

/**
 * Merges `patch` into a report message's meta under a row lock, so each writer lands on the latest committed
 * row and replaces only its own keys. A replaced check is summarized into `checkHistory`; a replaced GitHub
 * observation (other than `not_requested`) moves into `github.history`. A check older than the stored one
 * (by `checkedAt`), or one with no `checkedAt`, leaves the check keys as they are. A key set to null is
 * cleared. Returns the updated message, or null when there is no such report.
 */
export async function mergeReportMeta(db: Db, messageId: string, patch: ReportMetaPatch): Promise<Message | null> {
  return db.tx(async (t) => {
    const rows = await t.query<{ meta: ReportMessageMeta | null }>(`select meta from messages where id = $1 and role = 'report' for update`, [messageId]);
    if (!rows[0]?.meta) return null;
    const meta: ReportMessageMeta = { ...rows[0].meta };
    const touchesCheck = "check" in patch || "checkError" in patch || "checkSkipped" in patch;
    // Once a check is stored, only a check at least as new may change the check keys: an older check,
    // a failed call (check null + checkError) or a skip must not clear a newer stored result.
    const stored = meta.check?.checkedAt;
    const stale =
      touchesCheck && stored != null && !(patch.check != null && typeof patch.check.checkedAt === "string" && patch.check.checkedAt >= stored);
    if (touchesCheck && !stale) {
      if ("check" in patch) {
        if (meta.check) {
          const { onMain, commitsExist, filesOk, checkedAt, mainSha } = meta.check;
          meta.checkHistory = [...(meta.checkHistory ?? []), { onMain, commitsExist, filesOk, checkedAt, mainSha }];
        }
        meta.check = patch.check ?? null;
      }
      if ("checkError" in patch) {
        if (patch.checkError == null) delete meta.checkError;
        else meta.checkError = patch.checkError;
      }
      if ("checkSkipped" in patch) {
        if (patch.checkSkipped == null) delete meta.checkSkipped;
        else meta.checkSkipped = patch.checkSkipped;
      }
    }
    if (patch.authors) meta.authors = patch.authors;
    if (patch.github) {
      const previous = meta.github;
      const history = [...(previous?.history ?? [])];
      if (previous && previous.current.state !== "not_requested") history.push(previous.current);
      meta.github = { current: patch.github, history };
    }
    const updated = await t.query<Row>(`update messages set meta = $2::jsonb where id = $1 and role = 'report' returning ${COLS}`, [
      messageId,
      JSON.stringify(meta),
    ]);
    return updated[0] ? toMessage(updated[0]) : null;
  });
}

export function addMessage(
  db: Db,
  workspaceId: string,
  role: "agent" | "system",
  content: string,
  opts: { taskId?: string; meta?: AgentMessageMeta; threadId?: string | null } = {},
): Promise<Message> {
  return insertMessage(db, workspaceId, role, content, opts.taskId ?? null, opts.meta ?? null, opts.threadId ?? null);
}

/** Latest `limit` messages, returned oldest first. */
export async function listMessages(db: Db, workspaceId: string, limit = 200): Promise<Message[]> {
  const rows = await db.query<Row>(
    `select * from (select ${COLS} from messages where workspace_id = $1 and thread_id is null order by seq desc limit $2) m
     order by seq asc`,
    [workspaceId, limit],
  );
  return withAttachments(db, rows.map(toMessage));
}

export async function getMessage(db: Db, id: string): Promise<Message | null> {
  const rows = await db.query<Row>(`select ${COLS} from messages where id = $1`, [id]);
  return rows[0] ? (await withAttachments(db, [toMessage(rows[0])]))[0]! : null;
}

export { getLastAgentMessage, getLastAskedQuestion };

/** Thread replies oldest first. The thread anchor is stored in threads.id, not messages.thread_id. */
export async function listThreadMessages(db: Db, threadId: string, limit = 200): Promise<Message[]> {
  const rows = await db.query<Row>(
    `select * from (select ${COLS} from messages where thread_id=$1 order by seq desc limit $2) latest order by seq asc`, [threadId, limit],
  );
  return withAttachments(db, rows.map(toMessage));
}

/**
 * Last `limit` messages (oldest first) excluding the given user message and any user message
 * posted after it; agent/system messages posted after it are included.
 */
/** Latest `limit` messages except `excludeId`, oldest first. Later user messages are kept. */
export async function listRecentMessages(db: Db, workspaceId: string, excludeId: string, limit = 20): Promise<Message[]> {
  const target = await getMessage(db, excludeId);
  if (!target || target.workspaceId !== workspaceId) return [];
  const threadId = await conversationOf(db, target);
  if (threadId) {
    const anchor = await getMessage(db, threadId);
    const replies = await db.query<Row>(`select ${COLS} from (
      select ${COLS} from messages where workspace_id=$1 and thread_id=$2 and id<>$3
      order by seq desc limit $4) r order by seq asc`, [workspaceId, threadId, excludeId, Math.min(limit, 50)]);
    return [...(anchor ? [anchor] : []), ...(await withAttachments(db, replies.map(toMessage)))];
  }
  const rows = await db.query<Row>(`select * from (
    select ${COLS} from messages where workspace_id=$1 and thread_id is null and id<>$2 order by seq desc limit $3
  ) m order by seq asc`, [workspaceId, excludeId, limit]);
  return withAttachments(db, rows.map(toMessage));
}

export async function listPromptMessages(db: Db, workspaceId: string, userMessageId: string, limit = 20): Promise<Message[]> {
  const targetRows = await db.query<{ id:string; workspace_id:string; role:Message["role"]; content:string; meta:Message["meta"]; task_id:string|null; created_at:Date|string; edited_at:Date|string|null; thread_id:string|null; seq:number }>(`select ${COLS} from messages where id=$1 and workspace_id=$2`, [userMessageId, workspaceId]);
  const target = targetRows[0];
  if (!target) return [];
  const threadId = await conversationOf(db, toMessage(target));
  if (threadId) {
    const anchor = await getMessage(db, threadId);
    const rows = await db.query<Row>(`select * from (
      select ${COLS} from messages where workspace_id=$1 and thread_id=$2 and id<>$3
        and (role<>'user' or seq < $4) order by seq desc limit $5
    ) m order by seq asc`, [workspaceId, threadId, userMessageId, target.seq, Math.min(limit, 50)]);
    return [...(anchor ? [anchor] : []), ...(await withAttachments(db, rows.map(toMessage)))];
  }
  const rows = await db.query<Row>(
    `select * from (
       select ${COLS} from messages
       where workspace_id = $1 and thread_id is null and id <> $2
         and (role <> 'user' or seq < (select seq from messages where id = $2))
       order by seq desc limit $3) m
     order by seq asc`,
    [workspaceId, userMessageId, limit],
  );
  return withAttachments(db, rows.map(toMessage));
}
