import { z } from "zod";

/** Limits for `@` mentions (spec 2026-10-31-mentions-design.md §1–§3). */
export const MENTION_LIMITS = {
  perMessage: 20,
  entryBytes: 4096,
  entriesTotalBytes: 16384,
  fileCandidates: 50,
  menuPerGroup: 8,
  threadAnchorBytes: 1024,
} as const;

/** The readable text inserted into the message body for a mention, stored as written. */
const MentionText = z.string().min(1).max(1100);

/**
 * A context reference the user put in a message with `@`. The body keeps the readable `text`; hub and agent
 * read only this record. A mention is the user's pointer, not a decision: it never changes an entry.
 */
export const MessageMention = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entry"), id: z.string().regex(/^(R|D|T|Q|S|G|W)-[1-9]\d*$/), text: MentionText }),
  z.object({
    type: z.literal("file"),
    repoId: z.string().min(1),
    path: z.string().min(1).max(1024),
    /** The main-branch commit the file is pinned to when the hub received the message. */
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** Written by the hub only: "head" when it pinned `commit` itself, "candidate" when it kept the web's value. */
    commitSource: z.enum(["head", "candidate"]).optional(),
    text: MentionText,
  }),
  z.object({ type: z.literal("thread"), id: z.string().min(1), text: MentionText }),
]);
export type MessageMention = z.infer<typeof MessageMention>;

export const MessageMentions = z.array(MessageMention).max(MENTION_LIMITS.perMessage);

/** The readable text a mention puts into the body: `[D-12]`, `` `label:path` `` or `[话题：标题]`. */
export function mentionText(m: MessageMention, labels: { repoLabel?: string; threadTitle?: string }): string {
  switch (m.type) {
    case "entry":
      return `[${m.id}]`;
    case "file":
      return `\`${labels.repoLabel ?? m.repoId}:${m.path}\``;
    case "thread":
      return `[话题：${labels.threadTitle ?? m.id}]`;
  }
}

/** A repository-relative path with `./` and empty segments removed; null for `..`, absolute, backslash or NUL. */
export function normalizeMentionPath(p: string): string | null {
  if (p.length === 0 || p.length > 1024 || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.length === 0 ? null : parts.join("/");
}

const TIER = 100_000;

/**
 * How well `query` matches a path-like `candidate`, case-insensitive; higher is better, null is no match.
 * File-name prefix > path-segment prefix > subsequence; within a tier the shorter candidate scores higher.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const shortness = TIER - 1 - Math.min(c.length, TIER - 1);
  if (q.length === 0) return shortness;
  const base = c.slice(c.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 3 * TIER + shortness;
  for (let i = 0; i < c.length; i = c.indexOf("/", i) + 1 || c.length) {
    if (c.startsWith(q, i)) return 2 * TIER + shortness;
  }
  let at = 0;
  for (const ch of c) if (ch === q[at] && ++at === q.length) return TIER + shortness;
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
