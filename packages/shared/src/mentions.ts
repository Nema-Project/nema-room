import { z } from "zod";

/** Limits for `@` mentions (spec 2026-10-31-mentions-design.md §1–§3). */
export const MENTION_LIMITS = {
  perMessage: 20,
  entryBytes: 4096,
  entriesTotalBytes: 16384,
  attachmentCandidates: 50,
  menuPerGroup: 8,
  threadAnchorBytes: 1024,
} as const;

/**
 * The readable text inserted into the message body for a mention, stored as written. 4096 is far above the
 * longest attachment mention: a 200-character name inside a code span whose fence outlasts any backtick in it.
 */
const MentionText = z.string().min(1).max(4096);

/**
 * A context reference the user put in a message with `@`. The body keeps the readable `text`; hub and agent
 * read only this record. A mention is the user's pointer, not a decision: it never changes an entry.
 */
export const MessageMention = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entry"), id: z.string().regex(/^(R|D|T|Q|S|G|W)-[1-9]\d*$/), text: MentionText }),
  z.object({
    type: z.literal("attachment"),
    /** A `message_attachments` id: a file already uploaded to this workspace and sent with a message. */
    id: z.string().min(1).max(64),
    text: MentionText,
  }),
  z.object({ type: z.literal("thread"), id: z.string().min(1), text: MentionText }),
]);
export type MessageMention = z.infer<typeof MessageMention>;

export const MessageMentions = z.array(MessageMention).max(MENTION_LIMITS.perMessage);

/** The readable text a mention puts into the body: `[D-12]`, `` `附件：名字` `` or `[话题：标题]`. */
export function mentionText(m: MessageMention, labels: { attachmentName?: string; threadTitle?: string }): string {
  switch (m.type) {
    case "entry":
      return `[${m.id}]`;
    case "attachment":
      return codeSpan(`附件：${labels.attachmentName ?? m.id}`);
    case "thread":
      return `[话题：${labels.threadTitle ?? m.id}]`;
  }
}

/** A Markdown code span that a backtick inside `text` cannot close (CommonMark: a longer fence, padded if needed). */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const TIER = 100_000;

/**
 * How well `query` matches `candidate`, case-insensitive; higher is better, null is no match. Used for entry
 * titles, attachment names and topic titles as well as paths: a last-segment prefix (the file name, or the whole
 * title when it has no `/`) beats a segment prefix, which beats a subsequence; shorter candidates win ties.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  // Compared by code point, so characters outside the BMP (emoji, rare CJK) match as one unit.
  const qChars = Array.from(q);
  const shortness = TIER - 1 - Math.min(c.length, TIER - 1);
  if (q.length === 0) return shortness;
  const base = c.slice(c.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 3 * TIER + shortness;
  for (let i = 0; i < c.length; i = c.indexOf("/", i) + 1 || c.length) {
    if (c.startsWith(q, i)) return 2 * TIER + shortness;
  }
  let at = 0;
  for (const ch of c) if (ch === qChars[at] && ++at === qChars.length) return TIER + shortness;
  return null;
}

/**
 * The mentions whose stored `text` still appears in `content`: a text found n times keeps the first n of its
 * mentions, in their original order (spec §1 "编辑"). Shared by hub edits and the web composer.
 */
export function keepMentionsFor(content: string, mentions: readonly MessageMention[]): MessageMention[] {
  const left = new Map<string, number>();
  const kept: MessageMention[] = [];
  for (const m of mentions) {
    if (!left.has(m.text)) left.set(m.text, occurrences(content, m.text));
    const n = left.get(m.text)!;
    if (n === 0) continue;
    left.set(m.text, n - 1);
    kept.push(m);
  }
  return kept;
}

function occurrences(content: string, text: string): number {
  let n = 0;
  for (let i = content.indexOf(text); i !== -1; i = content.indexOf(text, i + text.length)) n++;
  return n;
}
