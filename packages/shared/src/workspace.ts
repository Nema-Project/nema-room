import { z } from "zod";
import { EntryKindSchema } from "./entry.js";
import { MessageMentions } from "./mentions.js";

export const KNOWLEDGE_LANGUAGES = ["ja", "en", "zh", "follow"] as const;
export type KnowledgeLanguage = (typeof KNOWLEDGE_LANGUAGES)[number];

export type ThreadOpenedBy = "agent" | "user" | "grill";
export type Thread = {
  id: string;
  workspaceId: string;
  title: string;
  openedBy: ThreadOpenedBy;
  replyCount: number;
  unread: number;
  lastReplyAt: string | null;
  createdAt: string;
};

export const MessageQuote = z.object({
  messageId: z.string(),
  role: z.enum(["user", "agent", "system", "report"]),
  excerpt: z.string(),
});
export type MessageQuote = z.infer<typeof MessageQuote>;

export const UserMessageMeta = z.object({
  quote: MessageQuote.optional(),
  /** `@` mentions in this message, validated and stored by the hub (at most MENTION_LIMITS.perMessage). */
  mentions: MessageMentions.optional(),
});
export type UserMessageMeta = z.infer<typeof UserMessageMeta>;

/**
 * A skill the agent offered to install from chat. It is the preview the daemon pinned, nothing more:
 * the agent cannot install it. The user installs it by pressing Install on the card under the reply,
 * which sends exactly this source, commit and folder through the same install service as the page.
 */
export const SkillInstallOffer = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.string(),
  repository: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string(),
  license: z.string().nullable(),
  target: z.string(),
});
export type SkillInstallOffer = z.infer<typeof SkillInstallOffer>;

export const AgentMessageMeta = z.object({
  changes: z.array(
    z.object({
      entryId: z.string(),
      kind: EntryKindSchema,
      title: z.string(),
      op: z.enum(["add", "update"]),
    }),
  ),
  askedQuestion: z.object({ id: z.string(), title: z.string(), body: z.string() }).nullable(),
  quote: MessageQuote.optional(),
  /** Skills the agent offered to install in this reply; each waits for the user's own click. */
  skillOffers: z.array(SkillInstallOffer).optional(),
});
export type AgentMessageMeta = z.infer<typeof AgentMessageMeta>;

/**
 * A single branch name, not a refspec: `git check-ref-format --branch` rules. `git fetch origin -- a:refs/heads/x`
 * would write a local branch, and `main~3` or `HEAD` would name some other commit.
 */
export function isBranchName(name: string): boolean {
  if (name === "" || name === "HEAD" || name === "@") return false;
  // A leading + would also read as a forced refspec.
  if (/^[-+]/.test(name)) return false;
  // Control characters, space, ~ ^ : ? * [ \ and DEL.
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return name.split("/").every((segment) => segment !== "" && !segment.startsWith(".") && !segment.endsWith(".lock"));
}

export * from "./mentions.js";
