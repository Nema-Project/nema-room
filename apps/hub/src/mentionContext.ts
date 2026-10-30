import { Hono } from "hono";
import { MENTION_LIMITS, fuzzyScore } from "@nema/shared";
import type { AttachmentStore } from "./attachments.js";
import type { Db } from "./db/db.js";
import { getWorkspace } from "./workspaces.js";

/**
 * How many rows a candidate query reads before ranking. The menu keeps 8, and every group is ranked in memory,
 * so each pool is bounded here instead of loading a workspace's whole history on every keystroke.
 */
export const MENTION_POOL = 500;

const MAX_QUERY_LENGTH = 200;

/** A knowledge entry the menu can offer: an id, its kind, title and status. Never its body. */
export type MentionEntry = { id: string; kind: string; title: string; status: string };
/** A file already uploaded to this workspace and sent with a message. Never its bytes. */
export type MentionAttachment = { id: string; name: string; kind: string; size: number; messageId: string; createdAt: string };
/** A topic: its title and when it was last replied to. Its anchor body comes at prompt time. */
export type MentionThread = { id: string; title: string; lastReplyAt: string | null };

export type MentionContext = {
  status: "ok";
  entries: MentionEntry[];
  attachments: MentionAttachment[];
  threads: MentionThread[];
  truncated: boolean;
};

/** The workspace's own entries, newest first by the index's update clock, at most `limit` of them. */
export async function listMentionEntries(db: Db, workspaceId: string, limit = MENTION_POOL): Promise<MentionEntry[]> {
  const rows = await db.query<{ entry_id: string; kind: string; title: string; status: string }>(
    `select entry_id, kind, title, status from entry_index where workspace_id = $1 order by updated_at desc, entry_id desc limit $2`,
    [workspaceId, limit],
  );
  return rows.map((r) => ({ id: r.entry_id, kind: r.kind, title: r.title, status: r.status }));
}

/** The workspace's topics, newest activity first, at most `limit` of them. One grouped query, not one per thread. */
export async function listMentionThreads(db: Db, workspaceId: string, limit = MENTION_POOL): Promise<MentionThread[]> {
  const rows = await db.query<{ id: string; title: string; last_reply_at: Date | string | null }>(
    `select t.id, t.title, max(m.created_at) as last_reply_at
     from threads t left join messages m on m.thread_id = t.id
     where t.workspace_id = $1 group by t.id
     order by coalesce(max(m.created_at), t.created_at) desc, t.id desc limit $2`,
    [workspaceId, limit],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, lastReplyAt: r.last_reply_at ? new Date(r.last_reply_at).toISOString() : null }));
}

/**
 * Files already sent with a message in this workspace, newest first. Staged uploads, deleted files and files
 * that went missing are left out: a mention has to point at something the agent can still be given.
 */
export async function listMentionAttachments(db: Db, workspaceId: string, limit: number): Promise<{ items: MentionAttachment[]; more: boolean }> {
  // One row past the limit says whether anything was left out, so exactly `limit` files is not "truncated".
  const rows = await db.query<{ id: string; name: string; kind: string; size: number; message_id: string; created_at: Date | string }>(
    `select id, name, kind, size, message_id, created_at from message_attachments
     where workspace_id = $1 and status = 'attached' and message_id is not null
     order by created_at desc, id desc limit $2`,
    [workspaceId, limit + 1],
  );
  return {
    items: rows.slice(0, limit).map((r) => ({ id: r.id, name: r.name, kind: r.kind, size: r.size, messageId: r.message_id, createdAt: new Date(r.created_at).toISOString() })),
    more: rows.length > limit,
  };
}

/** Ranked by `fuzzyScore`; an empty query keeps the incoming order. A typed exact id always wins. */
function ranked<T>(q: string, items: readonly T[], text: (item: T) => string, exact?: (item: T) => boolean): T[] {
  if (q === "") return [...items];
  const needle = q.toLowerCase();
  const scored = items
    .map((item) => ({ item, score: fuzzyScore(needle, text(item)) ?? -1, exact: exact?.(item) ?? false }))
    .filter((row) => row.score >= 0 || row.exact);
  scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  return scored.map((row) => row.item);
}

/**
 * What the `@` menu can offer in this workspace: entries, sent attachments and threads, at most
 * `MENTION_LIMITS.menuPerGroup` of each. Everything comes from the hub's own tables; no daemon is involved.
 */
export async function mentionContext(db: Db, workspaceId: string, q: string, attachments?: AttachmentStore): Promise<MentionContext> {
  const [entries, pool, threads] = await Promise.all([
    listMentionEntries(db, workspaceId),
    listMentionAttachments(db, workspaceId, MENTION_LIMITS.attachmentCandidates),
    listMentionThreads(db, workspaceId),
  ]);
  // The menu must not offer a file whose bytes are already gone: check the disk, and let a vanished file be marked.
  const available = attachments ? await attachments.available(workspaceId, pool.items.map((a) => a.id)) : new Set(pool.items.map((a) => a.id));
  const attachmentsList = pool.items.filter((a) => available.has(a.id));
  const group = MENTION_LIMITS.menuPerGroup;
  return {
    status: "ok",
    entries: ranked(q, entries, (e) => `${e.id} ${e.title}`, (e) => e.id.toLowerCase() === q.toLowerCase()).slice(0, group),
    attachments: ranked(q, attachmentsList, (a) => a.name).slice(0, group),
    threads: ranked(q, threads, (t) => t.title).slice(0, group).map((t) => ({ id: t.id, title: t.title, lastReplyAt: t.lastReplyAt })),
    // Only the attachment pool has a hard cap behind it; the 8-per-group cut is the menu's own limit.
    truncated: pool.more,
  };
}

export function mentionContextRoutes(deps: { db: Db; attachments: AttachmentStore }): Hono {
  const app = new Hono();
  app.get("/workspaces/:id/mention-context", async (c) => {
    const workspaceId = c.req.param("id");
    const raw = c.req.query("q") ?? "";
    // Measured before trimming: a long run of spaces is still a long query.
    if (raw.length > MAX_QUERY_LENGTH) return c.json({ error: `q is longer than ${MAX_QUERY_LENGTH} characters` }, 400);
    const q = raw.trim();
    // An archived workspace can still be searched: its messages stay readable.
    if (!(await getWorkspace(deps.db, workspaceId))) return c.json({ error: "workspace not found" }, 404);
    return c.json(await mentionContext(deps.db, workspaceId, q, deps.attachments));
  });
  return app;
}
