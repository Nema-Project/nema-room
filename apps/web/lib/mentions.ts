import { MENTION_LIMITS, keepMentionsFor, mentionText, type MessageMention } from "@nema/shared";
import { memberName } from "@/lib/members";

/** What the hub's `mention-context` route answers (apps/hub/src/mentionContext.ts). */
export type MentionContextResponse = {
  status: "ok";
  entries: Array<{ id: string; kind: string; title: string; status: string }>;
  tags?: Array<{ tag: string; active: number; inactive: number }>;
  attachments: Array<{ id: string; name: string; kind: string; size: number; messageId: string; createdAt: string }>;
  threads: Array<{ id: string; title: string; lastReplyAt: string | null }>;
  /** Active members (#163); the hub sends rows only when the workspace has two or more. Missing on an older hub. */
  members?: Array<{ id: string; displayName: string | null; role: "owner" | "member" }>;
  truncated: boolean;
  /** Empty-query browse continuation; absent on older hubs or at the end. */
  nextCursor?: string;
  /** Missing on an older hub. True means the attachment scan stopped with rows still unread. */
  attachmentBudgetExhausted?: boolean;
};

export type MentionCandidate = { type: MessageMention["type"] | "tag"; active?: number; inactive?: number; id: string; label: string; hint: string; text: string };
export type MentionGroup = { kind: MentionCandidate["type"]; items: MentionCandidate[] };

export type MentionToken = { query: string; start: number; end: number };

const MAX_QUERY = 100;
/** A run of non-space text that may follow `@`, and what ends the whole token. */
const TOKEN_END = /\s/;
const RUN = /[^\s]/;
/** Characters an `@` may follow: nothing (line start), a space, or the punctuation Chinese text uses before a name. */
const BEFORE = /[\s（(「『，。、：]/;

/** Whether `at` is inside a fenced code block (an odd number of ``` before it). */
function inCodeBlock(value: string, at: number): boolean {
  return (value.slice(0, at).match(/```/g) ?? []).length % 2 === 1;
}

/**
 * The `@query` token the caret is in: the nearest `@` before the caret, with nothing but a short run of
 * non-space text between them, sitting at a line start, after whitespace, or after Chinese punctuation.
 * `end` is the end of that whole run, so choosing a row replaces the token even when the caret sits inside it.
 * `a@b`, a caret past a space, and a code block all give null.
 */
export function mentionToken(value: string, cursor: number): MentionToken | null {
  if (cursor < 1) return null;
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const typed = before.slice(at + 1);
  if (typed.length >= MAX_QUERY || [...typed].some((ch) => !RUN.test(ch))) return null;
  if (at > 0 && !BEFORE.test(value[at - 1]!)) return null;
  if (inCodeBlock(value, at)) return null;
  // Extend to the end of the run: text after the caret belongs to the same token.
  let end = cursor;
  while (end < value.length && !TOKEN_END.test(value[end]!) && end - at <= MAX_QUERY) end++;
  return { query: value.slice(at + 1, end), start: at, end };
}

/**
 * The menu's groups, at most `MENTION_LIMITS.menuPerGroup` each, in the order the hub returned.
 * Ranking already happened in SQL; filtering here would drop rows the hub kept and could not see rows it did not.
 * `labels.me` names the local user without a display name (`@Me`), the same word the chat uses.
 */
export function groupCandidates(_q: string, ctx: MentionContextResponse, labels: { me: string } = { me: "me" }): MentionGroup[] {
  const cap = MENTION_LIMITS.menuPerGroup;
  const entries = ctx.entries.slice(0, cap).map((e): MentionCandidate => ({
    type: "entry", id: e.id, label: `[${e.id}]`, hint: e.title,
    text: mentionText({ type: "entry", id: e.id, text: "" }, {}),
  }));
  const attachments = ctx.attachments.slice(0, cap).map((a): MentionCandidate => ({
    type: "attachment", id: a.id, label: a.name, hint: a.kind,
    text: mentionText({ type: "attachment", id: a.id, text: "" }, { attachmentName: a.name }),
  }));
  const threads = ctx.threads.slice(0, cap).map((t): MentionCandidate => ({
    type: "thread", id: t.id, label: t.title, hint: "话题",
    text: mentionText({ type: "thread", id: t.id, text: "" }, { threadTitle: t.title }),
  }));
  return [
    { kind: "entry", items: entries },
    { kind: "tag", items: (ctx.tags ?? []).slice(0, cap).map(t => ({ type: "tag", id: t.tag, label: `#${t.tag}`, hint: "", text: "", active: t.active, inactive: t.inactive })) },
    { kind: "attachment", items: attachments },
    { kind: "thread", items: threads },
    // Empty unless the workspace has two or more active members (#163 D-1): the hub decides, and an older hub sends none.
    { kind: "member", items: (ctx.members ?? []).slice(0, cap).map((m): MentionCandidate => {
      const name = memberName(m.id, m.displayName, labels.me);
      return { type: "member", id: m.id, label: name, hint: "", text: mentionText({ type: "member", id: m.id, text: "" }, { memberName: name }) };
    }) },
  ];
}

/** How many mentions one message may carry, so the composer can refuse the next one instead of failing the send. */
export { MENTION_LIMITS };

/** The mentions whose stored text is still in the body: the same counting rule the hub applies on edit. */
export function syncMentions(content: string, mentions: readonly MessageMention[]): MessageMention[] {
  return keepMentionsFor(content, mentions);
}


/** Expand a navigation tag to the exact entry pointers visible at selection time. Never truncate. */
export function expandTag(tag: string, entries: MentionContextResponse["entries"], remaining: number): { text: string; mentions: MessageMention[] } | { error: "tooMany"; count: number } {
  if (entries.length > remaining) return { error: "tooMany", count: entries.length };
  const mentions: MessageMention[] = entries.map(entry => ({ type: "entry", id: entry.id, text: `[${entry.id}]` }));
  return { text: `#${tag}：${mentions.map(m => m.text).join(" ")}`, mentions };
}
