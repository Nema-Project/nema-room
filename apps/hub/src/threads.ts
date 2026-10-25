import type { Thread, ThreadOpenedBy, AgentMessageMeta } from "@nema/shared";
import type { Db } from "./db/db.js";
import { MessageOpError, type AgentMessage, type Message } from "./messages.js";

type ThreadRow = {
  id: string; workspace_id: string; title: string; opened_by: ThreadOpenedBy;
  last_read_seq?: string | number; created_at: Date | string;
  reply_count?: string | number; unread?: string | number; last_reply_at?: Date | string | null;
};

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id, workspaceId: row.workspace_id, title: row.title, openedBy: row.opened_by,
    replyCount: Number(row.reply_count ?? 0), unread: Number(row.unread ?? 0),
    lastReplyAt: row.last_reply_at ? new Date(row.last_reply_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function ensureThread(db: Db, anchorId: string, title: string, openedBy: ThreadOpenedBy): Promise<Thread> {
  return db.tx(async (t) => {
    const anchor = await t.query<{ id: string; workspace_id: string; thread_id: string | null }>(
      "select id, workspace_id, thread_id from messages where id=$1 for update", [anchorId],
    );
    if (!anchor[0]) throw new MessageOpError(400, "thread anchor not found");
    if (anchor[0].thread_id) throw new MessageOpError(400, "thread anchor cannot be inside another thread");
    await t.query("insert into threads(id, workspace_id, title, opened_by) values ($1,$2,$3,$4) on conflict (id) do nothing", [anchorId, anchor[0].workspace_id, title, openedBy]);
    const rows = await t.query<ThreadRow>("select id, workspace_id, title, opened_by, last_read_seq, created_at from threads where id=$1", [anchorId]);
    return toThread(rows[0]!);
  });
}

export async function associateQuestion(db: Db, workspaceId: string, questionId: string, threadId: string): Promise<{ threadId: string; inserted: boolean }> {
  return db.tx(async (t) => {
    const found = await t.query<{ id: string }>("select id from threads where id=$1 and workspace_id=$2", [threadId, workspaceId]);
    if (!found[0]) throw new MessageOpError(400, "question thread not in this workspace");
    const inserted = await t.query<{ thread_id: string }>("insert into question_threads(workspace_id, question_id, thread_id) values ($1,$2,$3) on conflict (workspace_id, question_id) do nothing returning thread_id", [workspaceId, questionId, threadId]);
    const row = inserted[0] ?? (await t.query<{ thread_id: string }>("select thread_id from question_threads where workspace_id=$1 and question_id=$2", [workspaceId, questionId]))[0]!;
    return { threadId: row.thread_id, inserted: inserted.length > 0 };
  });
}

export async function getQuestionThread(db: Db, workspaceId: string, questionId: string): Promise<string | null> {
  const explicit = await db.query<{ thread_id: string }>("select thread_id from question_threads where workspace_id=$1 and question_id=$2", [workspaceId, questionId]);
  if (explicit[0]) return explicit[0].thread_id;
  const inferred = await db.query<{ thread_id: string | null }>(
    `select coalesce(message.thread_id, anchored.id) as thread_id
     from task_changes change
     join tasks task on task.id=change.task_id
     join messages message on message.id=task.message_id
     left join threads anchored on anchored.id=message.id
     where message.workspace_id=$1 and change.entry_id=$2 and change.kind='question' and change.op='add'
     order by message.seq asc limit 1`, [workspaceId, questionId],
  );
  return inferred[0]?.thread_id ?? null;
}

export async function getThread(db: Db, id: string): Promise<Thread | null> {
  const rows = await db.query<ThreadRow>(
    `select t.id,t.workspace_id,t.title,t.opened_by,t.last_read_seq,t.created_at,
       count(m.id) filter (where m.id is not null)::int as reply_count,
       count(m.id) filter (where m.seq > t.last_read_seq)::int as unread,
       max(m.created_at) as last_reply_at
     from threads t left join messages m on m.thread_id=t.id
     where t.id=$1 group by t.id`, [id],
  );
  return rows[0] ? toThread(rows[0]) : null;
}

export async function renameThread(db: Db, id: string, title: string): Promise<Thread> {
  const rows = await db.query<{ id: string }>(
    "update threads set title=$2 where id=$1 returning id",
    [id, title],
  );
  if (!rows[0]) throw new MessageOpError(404, "thread not found");
  const thread = await getThread(db, id);
  if (!thread) throw new MessageOpError(404, "thread not found");
  return thread;
}

export async function listThreads(db: Db, workspaceId: string): Promise<Thread[]> {
  const rows = await db.query<ThreadRow>(
    `select t.id,t.workspace_id,t.title,t.opened_by,t.last_read_seq,t.created_at,
       count(m.id) filter (where m.id is not null)::int as reply_count,
       count(m.id) filter (where m.seq > t.last_read_seq)::int as unread,
       max(m.created_at) as last_reply_at
     from threads t left join messages m on m.thread_id=t.id
     where t.workspace_id=$1 group by t.id order by coalesce(max(m.seq),0) desc,t.created_at desc`, [workspaceId],
  );
  return rows.map(toThread);
}

export async function markThreadRead(db: Db, id: string, throughSeq: number): Promise<void> {
  if (!Number.isSafeInteger(throughSeq) || throughSeq <= 0) throw new MessageOpError(400, "invalid thread read sequence");
  const rows = await db.query<{ seq: number }>("select m.seq from messages m join threads t on t.id=m.thread_id where t.id=$1 and m.seq=$2", [id, throughSeq]);
  if (!rows[0]) throw new MessageOpError(400, "read sequence is not a message in this thread");
  await db.query("update threads set last_read_seq=greatest(last_read_seq,$2) where id=$1", [id, throughSeq]);
}

export async function conversationOf(db: Db, message: Message): Promise<string | null> {
  if (message.threadId) return message.threadId;
  const rows = await db.query<{ id: string }>("select id from threads where id=$1", [message.id]);
  return rows[0]?.id ?? null;
}

export async function getLastAgentMessage(db: Db, workspaceId: string, threadId: string | null): Promise<AgentMessage | null> {
  const rows = await db.query<{ id: string; workspace_id: string; role: "agent"; content: string; meta: AgentMessageMeta | null; task_id: string | null; created_at: Date | string; edited_at: Date | string | null; thread_id: string | null }>(
    `select id,workspace_id,role,content,meta,task_id,created_at,edited_at,thread_id from messages
     where workspace_id=$1 and role='agent' and ${threadId === null ? "thread_id is null" : "thread_id=$2"} order by seq desc limit 1`,
    threadId === null ? [workspaceId] : [workspaceId, threadId],
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return { id:r.id, workspaceId:r.workspace_id, role:r.role, content:r.content, meta:r.meta, taskId:r.task_id, createdAt:new Date(r.created_at).toISOString(), editedAt:r.edited_at ? new Date(r.edited_at).toISOString() : null, threadId:r.thread_id };
}

export async function getLastAskedQuestion(db: Db, workspaceId: string, threadId: string | null): Promise<{ id: string; title: string; body: string } | null> {
  const rows = await db.query<{ asked_question: NonNullable<AgentMessageMeta["askedQuestion"]> }>(
    `select meta->'askedQuestion' as asked_question from messages
     where workspace_id=$1 and ${threadId === null ? "thread_id is null" : "thread_id=$2"}
       and role in ('agent','system') and meta->'askedQuestion' is not null and meta->'askedQuestion' <> 'null'::jsonb
     order by seq desc limit 1`, threadId === null ? [workspaceId] : [workspaceId, threadId],
  );
  // Legacy converted question cards persist the same typed question in system-message metadata.
  return rows[0]?.asked_question ?? null;
}
