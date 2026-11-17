import { Hono } from "hono";
import { z } from "zod";
import { MENTION_LIMITS } from "@nema/shared";
import type { AttachmentStore } from "./attachments.js";
import type { Db } from "./db/db.js";
import { getWorkspace } from "./workspaces.js";

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
  /** True when the menu is not every match, or the attachment stat budget stopped early with rows left. */
  truncated: boolean;
  /** Opaque continuation for empty-query browsing; absent when all groups are exhausted. */
  nextCursor?: string;
  /** True only when 50 attachment stats were used and a later matching row was not opened. */
  attachmentBudgetExhausted: boolean;
};

// Browse cursors retain the database's microseconds; JS Date would skip rows within one millisecond.
const Position = z.object({
  at: z.string().datetime().refine((at) => !at.startsWith("0000")),
  id: z.string().min(1).max(256).refine((id) => !id.includes("\0")),
});
type Position = z.infer<typeof Position>;
const BrowseCursor = z.object({
  workspaceId: z.string(),
  entries: Position.nullable(), threads: Position.nullable(), attachments: Position.nullable(),
});
type BrowseCursor = z.infer<typeof BrowseCursor>;
type BrowseRow = { browse_at: string };
function clock(expr: string): string {
  return `to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
function position(row: BrowseRow, id: string): Position {
  return { at: row.browse_at, id };
}

const MENU = MENTION_LIMITS.menuPerGroup;
const STAT_BUDGET = MENTION_LIMITS.attachmentCandidates;
/** POSIX metacharacters. Each code point of the folded query is escaped before it is joined with `.*`. */
const REGEX_META = new Set(["\\", "^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);

/**
 * UTF-16 code units of a SQL text expression: the same number as JavaScript `String.length`.
 * PGlite rejects `convert_to(..., 'UTF16')`, so this counts a non-BMP code point as two units.
 * `char_length` is the wrong substitute: `a😀😀` is 3 characters and 5 code units.
 * ponytail: one correlated pass per sorted row. On a Postgres that has the UTF16 encoding,
 * switch back to `(octet_length(convert_to(expr, 'UTF16')) - 2) / 2`.
 */
function utf16Units(expr: string): string {
  return `(select coalesce(sum(case when ascii(substring(${expr} from i for 1)) > 65535 then 2 else 1 end), 0) from generate_series(1, char_length(${expr})) as i)`;
}

/** Bound for `~`. Built from SQL `lower`, never from `String.prototype.toLowerCase`. */
function subsequencePattern(folded: string): string {
  return Array.from(folded).map((ch) => (REGEX_META.has(ch) ? `\\${ch}` : ch)).join(".*");
}

/** Last-segment prefix, then any segment-boundary prefix, then subsequence. Shorter UTF-16 text wins inside a tier. */
function tierOrder(folded: string): string {
  return `case
    when strpos(reverse(split_part(reverse(${folded}), '/', 1)), $2) = 1 then 3
    when strpos(${folded}, $2) = 1 or strpos(${folded}, '/' || $2) > 0 then 2
    else 1
  end desc, ${utf16Units(folded)} asc`;
}

type EntryRow = { browse_at?: string; entry_id: string; kind: string; title: string; status: string };
type ThreadRow = { browse_at?: string; id: string; title: string; last_reply_at: Date | string | null };
type AttachmentRow = { id: string; name: string; kind: string; size: number; message_id: string; created_at: Date | string };

function toEntry(r: EntryRow): MentionEntry {
  return { id: r.entry_id, kind: r.kind, title: r.title, status: r.status };
}
function toThread(r: ThreadRow): MentionThread {
  return { id: r.id, title: r.title, lastReplyAt: r.last_reply_at ? new Date(r.last_reply_at).toISOString() : null };
}
function toAttachment(r: AttachmentRow): MentionAttachment {
  return { id: r.id, name: r.name, kind: r.kind, size: r.size, messageId: r.message_id, createdAt: new Date(r.created_at).toISOString() };
}

async function searchEntries(db: Db, workspaceId: string, folded: string | null, pattern: string | null, after?: Position): Promise<{ items: MentionEntry[]; more: boolean; next: Position | null }> {
  const rows = folded === null
    ? await db.query<EntryRow & BrowseRow>(
        `select entry_id, kind, title, status, ${clock("updated_at")} as browse_at from entry_index
         where workspace_id = $1 and ($3::timestamptz is null or (updated_at, entry_id) < ($3::timestamptz, $4::text))
         order by updated_at desc, entry_id desc limit $2`,
        [workspaceId, MENU + 1, after?.at ?? null, after?.id ?? null],
      )
    : await db.query<EntryRow>(
        `select entry_id, kind, title, status from (
           select entry_id, kind, title, status, updated_at, lower(entry_id || ' ' || title) as folded
           from entry_index where workspace_id = $1
         ) s
         where folded ~ $3
         order by (lower(entry_id) = $2) desc, ${tierOrder("folded")}, updated_at desc, entry_id desc
         limit $4`,
        [workspaceId, folded, pattern, MENU + 1],
      );
  const last = rows[MENU - 1];
  return {
    items: rows.slice(0, MENU).map(toEntry), more: rows.length > MENU,
    next: folded === null && rows.length > MENU && last?.browse_at ? { at: last.browse_at, id: last.entry_id } : null,
  };
}

async function searchThreads(db: Db, workspaceId: string, folded: string | null, pattern: string | null, after?: Position): Promise<{ items: MentionThread[]; more: boolean; next: Position | null }> {
  const rows = folded === null
    ? await db.query<ThreadRow & BrowseRow>(
        `select t.id, t.title, max(m.created_at) as last_reply_at, ${clock("coalesce(max(m.created_at), t.created_at)")} as browse_at
         from threads t left join messages m on m.thread_id = t.id
         where t.workspace_id = $1 group by t.id
         having $3::timestamptz is null or (coalesce(max(m.created_at), t.created_at), t.id) < ($3::timestamptz, $4::text)
         order by coalesce(max(m.created_at), t.created_at) desc, t.id desc limit $2`,
        [workspaceId, MENU + 1, after?.at ?? null, after?.id ?? null],
      )
    : await db.query<ThreadRow>(
        `select t.id, t.title, max(m.created_at) as last_reply_at
         from threads t left join messages m on m.thread_id = t.id
         where t.workspace_id = $1 and lower(t.title) ~ $3
         group by t.id
         order by ${tierOrder("lower(t.title)")}, coalesce(max(m.created_at), t.created_at) desc, t.id desc
         limit $4`,
        [workspaceId, folded, pattern, MENU + 1],
      );
  const last = rows[MENU - 1];
  return {
    items: rows.slice(0, MENU).map(toThread), more: rows.length > MENU,
    next: folded === null && rows.length > MENU && last?.browse_at ? { at: last.browse_at, id: last.id } : null,
  };
}

async function searchAttachmentRows(db: Db, workspaceId: string, folded: string | null, pattern: string | null, after?: Position): Promise<AttachmentRow[]> {
  if (folded === null) {
    return db.query<AttachmentRow & BrowseRow>(
      `select id, name, kind, size, message_id, created_at, ${clock("created_at")} as browse_at from message_attachments
       where workspace_id = $1 and status = 'attached' and message_id is not null
         and ($3::timestamptz is null or (created_at, id) < ($3::timestamptz, $4::text))
       order by created_at desc, id desc limit $2`,
      [workspaceId, STAT_BUDGET + 1, after?.at ?? null, after?.id ?? null],
    );
  }
  return db.query<AttachmentRow>(
    `select id, name, kind, size, message_id, created_at from (
       select id, name, kind, size, message_id, created_at, lower(name) as folded
       from message_attachments
       where workspace_id = $1 and status = 'attached' and message_id is not null
     ) s
     where folded ~ $3
     order by ${tierOrder("folded")}, created_at desc, id desc
     limit $4`,
    [workspaceId, folded, pattern, STAT_BUDGET + 1],
  );
}

/**
 * Open files in rank order, one id at a time, and stop at 8 that still exist or at 50 stats.
 * The 51st row is only a sign that something remains; it is not stated and not returned.
 */
async function takeAvailable(store: AttachmentStore | undefined, workspaceId: string, rows: readonly AttachmentRow[]): Promise<{ items: MentionAttachment[]; more: boolean; exhausted: boolean; consumed: number }> {
  if (!store) {
    const items = rows.slice(0, MENU).map(toAttachment);
    return { items, more: rows.length > items.length, exhausted: false, consumed: items.length };
  }
  const items: MentionAttachment[] = [];
  let stats = 0;
  let index = 0;
  while (index < rows.length && stats < STAT_BUDGET && items.length < MENU) {
    const row = rows[index]!;
    index += 1;
    stats += 1;
    const ok = await store.available(workspaceId, [row.id]);
    if (ok.has(row.id)) items.push(toAttachment(row));
  }
  const more = index < rows.length;
  return { items, more, exhausted: stats >= STAT_BUDGET && more, consumed: index };
}

/**
 * What the `@` menu can offer in this workspace: entries, sent attachments and threads, at most
 * `MENTION_LIMITS.menuPerGroup` of each. A typed query is filtered in SQL. No daemon is involved.
 */
export async function mentionContext(db: Db, workspaceId: string, q: string, attachments?: AttachmentStore, cursor?: BrowseCursor): Promise<MentionContext> {
  const folded = q === "" ? null : (await db.query<{ folded: string }>("select lower($1::text) as folded", [q]))[0]?.folded ?? "";
  const pattern = folded === null ? null : subsequencePattern(folded);
  const [entries, threads, attachmentRows] = await Promise.all([
    cursor?.entries === null ? { items: [], more: false, next: null } : searchEntries(db, workspaceId, folded, pattern, cursor?.entries),
    cursor?.threads === null ? { items: [], more: false, next: null } : searchThreads(db, workspaceId, folded, pattern, cursor?.threads),
    cursor?.attachments === null ? [] : searchAttachmentRows(db, workspaceId, folded, pattern, cursor?.attachments),
  ]);
  const files = await takeAvailable(attachments, workspaceId, attachmentRows);
  const lastFile = attachmentRows[files.consumed - 1];
  const next: BrowseCursor = {
    workspaceId, entries: entries.next, threads: threads.next,
    attachments: folded === null && files.more && lastFile ? position(lastFile as AttachmentRow & BrowseRow, lastFile.id) : null,
  };
  return {
    ...(folded === null && (entries.more || threads.more || files.more)
      ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}),
    status: "ok",
    entries: entries.items,
    attachments: files.items,
    threads: threads.items,
    truncated: entries.more || threads.more || files.more,
    attachmentBudgetExhausted: files.exhausted,
  };
}

function hasNulQuery(rawUrl: string, decoded: string): boolean {
  if (decoded.includes("\0")) return true;
  return /(?:^|[?&])q=[^&#]*%00/i.test(rawUrl);
}

export function mentionContextRoutes(deps: { db: Db; attachments: AttachmentStore }): Hono {
  const app = new Hono();
  app.get("/workspaces/:id/mention-context", async (c) => {
    const workspaceId = c.req.param("id");
    const raw = c.req.query("q") ?? "";
    // Measured before trimming: a long run of spaces is still a long query.
    if (raw.length > MAX_QUERY_LENGTH) return c.json({ error: `q is longer than ${MAX_QUERY_LENGTH} characters` }, 400);
    // PostgreSQL text cannot store NUL; refuse it before it becomes a 500. `%00` is the same character.
    if (hasNulQuery(c.req.url, raw)) return c.json({ error: "q contains a NUL character" }, 400);
    const q = raw.trim();
    let cursor: BrowseCursor | undefined;
    const encoded = c.req.query("cursor");
    if (encoded !== undefined) {
      try {
        if (q !== "" || encoded.length > 2048) throw new Error("invalid cursor");
        cursor = BrowseCursor.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
        if (cursor.workspaceId !== workspaceId) throw new Error("wrong workspace");
      } catch {
        return c.json({ error: "invalid browse cursor" }, 400);
      }
    }
    // An archived workspace can still be searched: its messages stay readable.
    if (!(await getWorkspace(deps.db, workspaceId))) return c.json({ error: "workspace not found" }, 404);
    return c.json(await mentionContext(deps.db, workspaceId, q, deps.attachments, cursor));
  });
  return app;
}
