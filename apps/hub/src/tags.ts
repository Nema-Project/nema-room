import { TAG_LIMITS } from "@nema/shared";
import { UpsertRejected, type UpsertGuard } from "@nema/knowledge";
import type { Db } from "./db/db.js";

/** Vocabulary spans all statuses, and never crosses the workspace boundary. */
export async function workspaceTags(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db.query<{ tag: string }>(
    `select distinct unnest(tags) as tag from entry_index
     where workspace_id = $1 and tags is not null order by tag`,
    [workspaceId],
  );
  return rows.map(row => row.tag);
}

/** Must be invoked by KnowledgeStore.upsert, while its repository lock is held. */
export function tagGuard(db: Db, workspaceId: string, author: "agent" | "user"): UpsertGuard {
  return async ({ existing, input }) => {
    if (input.tags === undefined) return;
    const vocabulary = new Set(await workspaceTags(db, workspaceId));
    const ownTags = new Set(existing?.tags ?? []);
    const introduced = input.tags.filter(tag => !vocabulary.has(tag) && !ownTags.has(tag));
    if (author === "agent" && introduced.length > 0) {
      throw new UpsertRejected(400, "新 tag 需要用户先在面板里创建");
    }
    const resulting = new Set([...vocabulary].filter(tag => !ownTags.has(tag)));
    for (const tag of input.tags) resulting.add(tag);
    if (resulting.size > TAG_LIMITS.perWorkspace) {
      throw new UpsertRejected(400, `Workspace tag limit: ${TAG_LIMITS.perWorkspace}`);
    }
  };
}
