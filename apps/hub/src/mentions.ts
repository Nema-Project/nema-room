import { MENTION_LIMITS, keepMentionsFor, type MessageMention } from "@nema/shared";
import { KnowledgeStore } from "@nema/knowledge";
import { listAttachmentsForMessages } from "./attachments.js";
import type { Db } from "./db/db.js";
import { MessageOpError } from "./messages.js";
import { repoPath } from "./workspaces.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { getThread } from "./threads.js";

/** How often `text` appears in `content`; mentions are matched by the exact text they wrote. */
function occurrences(content: string, text: string): number {
  let count = 0;
  for (let i = content.indexOf(text); i !== -1; i = content.indexOf(text, i + text.length)) count++;
  return count;
}

/** Dedupe by what a mention points at, keeping the first occurrence: the prompt expands each object once. */
function unique(mentions: readonly MessageMention[]): MessageMention[] {
  const seen = new Set<string>();
  return mentions.filter((m) => {
    const key = `${m.type}\0${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every mention must be something this workspace owns, and its stored `text` must appear in the body at least
 * as often as it was mentioned. Throws the 400 the UI API returns; nothing is written.
 */
export async function validateMentions(db: Db, workspaceId: string, content: string, mentions: readonly MessageMention[]): Promise<void> {
  if (mentions.length === 0) return;
  const seenText = new Map<string, number>();
  for (const m of mentions) seenText.set(m.text, (seenText.get(m.text) ?? 0) + 1);
  for (const [text, needed] of seenText) {
    if (occurrences(content, text) < needed) throw new MessageOpError(400, `提及的「${text}」在正文里出现的次数不够`);
  }
  const entryIds = [...new Set(mentions.filter((m) => m.type === "entry").map((m) => m.id))];
  if (entryIds.length > 0) {
    const rows = await db.query<{ entry_id: string }>(
      `select entry_id from entry_index where workspace_id = $1 and entry_id = any($2)`,
      [workspaceId, entryIds],
    );
    const found = new Set(rows.map((r) => r.entry_id));
    const missing = entryIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new MessageOpError(400, `提及的条目不在这个 workspace：${missing.join("、")}`);
  }
  const attachmentIds = [...new Set(mentions.filter((m) => m.type === "attachment").map((m) => m.id))];
  if (attachmentIds.length > 0) {
    const rows = await db.query<{ id: string }>(
      `select id from message_attachments where workspace_id = $1 and status = 'attached' and id = any($2)`,
      [workspaceId, attachmentIds],
    );
    const found = new Set(rows.map((r) => r.id));
    const missing = attachmentIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new MessageOpError(400, "提及的附件必须已经发送过，且属于这个 workspace");
  }
  const threadIds = [...new Set(mentions.filter((m) => m.type === "thread").map((m) => m.id))];
  if (threadIds.length > 0) {
    const rows = await db.query<{ id: string }>(`select id from threads where workspace_id = $1 and id = any($2)`, [workspaceId, threadIds]);
    const found = new Set(rows.map((r) => r.id));
    const missing = threadIds.filter((id) => !found.has(id));
    if (missing.length > 0) throw new MessageOpError(400, "提及的话题不在这个 workspace");
  }
}

/** The attachment ids mentioned by a message, in mention order. */
export function mentionedAttachmentIds(mentions: readonly MessageMention[] | undefined): string[] {
  return unique(mentions ?? []).filter((m) => m.type === "attachment").map((m) => m.id);
}

/** What an edit keeps: mentions whose stored text still appears in the new body (shared counting rule). */
export function filterMentionsForEdit(content: string, mentions: readonly MessageMention[] | undefined): MessageMention[] {
  return keepMentionsFor(content, mentions ?? []);
}

/** The attachments a send must deliver beyond the message's own and any quote's: the mentioned ones. */
export async function mentionedAttachmentViews(db: Db, mentions: readonly MessageMention[] | undefined) {
  const ids = mentionedAttachmentIds(mentions);
  if (ids.length === 0) return [];
  const byMessage = await listAttachmentsForMessages(db, (await db.query<{ message_id: string }>(`select message_id from message_attachments where id = any($1)`, [ids])).map((r) => r.message_id));
  const wanted = new Set(ids);
  const views = [...byMessage.values()].flat().filter((v) => wanted.has(v.id));
  // Mention order, and only files the agent can still be given.
  return ids.map((id) => views.find((v) => v.id === id)).filter((v): v is NonNullable<typeof v> => !!v && v.status !== "deleted");
}

export type ResolvedEntry =
  | { id: string; kind: string; title: string; status: string; body: string; missing?: undefined }
  | { id: string; title: string; missing: true };
export type ResolvedAttachment = { id: string; name: string; kind: string; status: string; messageId: string };
export type ResolvedThread = { id: string; title: string; anchor: { role: string; content: string } };

export type ResolvedMentions = { entries: ResolvedEntry[]; attachments: ResolvedAttachment[]; threads: ResolvedThread[] };

/** Reads what each mention points at, at prompt time: entries latest, attachments as they are now, a thread's anchor. */
export async function resolveMentions(
  db: Db,
  dataDir: string,
  workspaceId: string,
  mentions: readonly MessageMention[],
  opts: { ownedHelpers?: OwnedHelperScope; delivered?: ReadonlySet<string> } = {},
): Promise<ResolvedMentions> {
  const ownedHelpers = opts.ownedHelpers;
  const items = unique(mentions);
  const store = items.some((m) => m.type === "entry") ? new KnowledgeStore(repoPath(dataDir, workspaceId), ownedHelpers) : null;
  const entries: ResolvedEntry[] = [];
  for (const m of items) {
    if (m.type !== "entry") continue;
    const entry = store ? await store.get(m.id) : null;
    entries.push(entry ? { id: entry.id, kind: entry.kind, title: entry.title, status: entry.status, body: entry.body } : { id: m.id, title: "", missing: true });
  }
  const attachments: ResolvedAttachment[] = [];
  for (const m of items) {
    if (m.type !== "attachment") continue;
    const rows = await db.query<{ id: string; name: string; kind: string; status: string; message_id: string }>(
      `select id, name, kind, status, message_id from message_attachments where workspace_id = $1 and id = $2`,
      [workspaceId, m.id],
    );
    const row = rows[0];
    attachments.push(row ? { id: row.id, name: row.name, kind: row.kind, status: row.status, messageId: row.message_id } : { id: m.id, name: m.text, kind: "unknown", status: "missing", messageId: "" });
  }
  const threads: ResolvedThread[] = [];
  for (const m of items) {
    if (m.type !== "thread") continue;
    const thread = await getThread(db, m.id);
    const anchor = thread ? (await db.query<{ role: string; content: string }>(`select role, content from messages where id = $1`, [thread.id]))[0] : undefined;
    if (thread && anchor) threads.push({ id: thread.id, title: thread.title, anchor: { role: anchor.role, content: anchor.content } });
  }
  return { entries, attachments, threads };
}

/** Trim `text` to at most `max` UTF-8 bytes without splitting a character. */
export function cutBytes(text: string, max: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, cut: false };
  let used = 0;
  const kept: string[] = [];
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > max) break;
    used += n;
    kept.push(ch);
  }
  return { text: kept.join(""), cut: true };
}

/**
 * The `# 本次提及的上下文` section, or "" when the message mentions nothing (so the prompt is byte-identical to
 * before). Entries are inlined within 4 KiB each and 16 KiB in total; attachments get one line each and their
 * bytes travel as this task's attachments; a thread shows its title and a shortened anchor, never its replies.
 */
export function mentionSection(input: ResolvedMentions & { delivered: ReadonlySet<string> }): string {
  const { entries, attachments, threads, delivered } = input;
  if (entries.length === 0 && attachments.length === 0 && threads.length === 0) return "";
  const lines: string[] = ["# 本次提及的上下文", "以下是用户在本条消息里用 @ 明确指定的上下文。它是用户给的参考，不是用户的决定。"];
  let budget = MENTION_LIMITS.entriesTotalBytes;
  for (const e of entries) {
    if (e.missing) {
      lines.push(`## 条目 [${e.id}]：已不存在`);
      continue;
    }
    if (budget <= 0) {
      lines.push(`## 条目 [${e.id}] ${e.title}：超出本次预算，用 read_entry 读取`);
      continue;
    }
    const room = Math.min(MENTION_LIMITS.entryBytes, budget);
    const { text, cut } = cutBytes(e.body, room);
    budget -= Buffer.byteLength(text, "utf8");
    lines.push(`## 条目 [${e.id}] ${e.title}（${e.kind}，${e.status}）`);
    lines.push(cut ? `${text}\n（已截断，完整内容用 read_entry ${e.id} 读取）` : text);
  }
  for (const a of attachments) {
    lines.push(`## 附件「${a.name}」（${a.kind}，message ${a.messageId || "未知"}）`);
    lines.push(a.status === "deleted" ? "该附件已删除，内容不可用。" : delivered.has(a.id) ? "已随本次任务投递，不需要再读取。" : "本次没有随附，内容不可用。");
  }
  for (const t of threads) {
    const { text } = cutBytes(t.anchor.content, MENTION_LIMITS.threadAnchorBytes);
    lines.push(`## 话题「${t.title}」`);
    lines.push(`[${t.id}] ${t.anchor.role}: ${text}`);
    lines.push("需要更多上下文时请用户在该话题里继续，或引用具体消息。");
  }
  return lines.join("\n");
}
