import { z } from "zod";
import { EntryKindSchema } from "./entry.js";

export const KNOWLEDGE_LANGUAGES = ["ja", "en", "zh", "follow"] as const;
export type KnowledgeLanguage = (typeof KNOWLEDGE_LANGUAGES)[number];

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
