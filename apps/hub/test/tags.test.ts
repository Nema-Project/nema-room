import { afterAll, beforeEach, expect, test } from "vitest";
import { KnowledgeStore } from "@nema/knowledge";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";
import { indexEntry } from "../src/entryIndex.js";
import { tagGuard } from "../src/tags.js";

let db: Db;
let ws: string;
let store: KnowledgeStore;
const input = { kind: "requirement" as const, title: "T", body: "b", reason: "r", sourceMessages: [] };
beforeEach(async () => {
  const deps = await makeHubDeps();
  db = deps.db;
  ws = (await createWorkspace(db, deps.dataDir, "Tags")).id;
  store = new KnowledgeStore(repoPath(deps.dataDir, ws));
});
afterAll(cleanupHubDeps);

async function fullVocabulary() {
  const other = await store.upsert(input, { author: "user" });
  await indexEntry(db, ws, other.entry);
  await db.query("update entry_index set tags=array(select 'tag'||n from generate_series(1,199) n) where workspace_id=$1", [ws]);
  const own = await store.upsert({ ...input, tags: ["unique"] }, { author: "user" });
  await indexEntry(db, ws, own.entry);
  return own.entry.id;
}

test("user can replace an entry's unique tag at the 200-tag cap", async () => {
  const id = await fullVocabulary();
  const result = await store.upsert({ ...input, id, tags: ["replacement"] }, { author: "user" }, tagGuard(db, ws, "user"));
  expect(result.entry.tags).toEqual(["replacement"]);
});

test("user cannot replace a unique tag with two tags resulting in 201", async () => {
  const id = await fullVocabulary();
  await expect(store.upsert({ ...input, id, tags: ["replacement", "extra"] }, { author: "user" }, tagGuard(db, ws, "user"))).rejects.toMatchObject({ status: 400, message: "Workspace tag limit: 200" });
  expect((await store.get(id))!.tags).toEqual(["unique"]);
});

test("agent can resubmit the entry's own tags even when the index lacks them", async () => {
  const { entry } = await store.upsert({ ...input, tags: ["own"] }, { author: "user" });
  const result = await store.upsert({ ...input, id: entry.id, tags: ["own"] }, { author: "agent" }, tagGuard(db, ws, "agent"));
  expect(result.entry.tags).toEqual(["own"]);
});
