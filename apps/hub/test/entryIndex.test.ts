import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { KnowledgeStore } from "@nema/knowledge";
import { createWorkspace, repoPath } from "../src/workspaces.js";
import { backfillEntryTags, chooseAskedQuestion, indexEntry, openQuestionCounts, timeline, topOpenQuestion } from "../src/entryIndex.js";

let db: Db;
let dataDir: string;
let wsA: string;
let wsB: string;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  wsA = (await createWorkspace(db, dataDir, "A")).id;
  wsB = (await createWorkspace(db, dataDir, "B")).id;
});
afterAll(cleanupHubDeps);

async function add(ws: string, input: Record<string, unknown>) {
  const { entry } = await new KnowledgeStore(repoPath(dataDir, ws)).upsert(
    { body: "b", reason: "r", sourceMessages: [], ...input } as never,
    { author: "agent" },
  );
  await indexEntry(db, ws, entry);
  return entry;
}

describe("entry index", () => {
  test("timeline orders by business date ascending, null last", async () => {
    await add(wsA, { kind: "requirement", title: "none" });
    await add(wsA, { kind: "requirement", title: "late", businessDate: "2026-12-01" });
    await add(wsA, { kind: "decision", title: "early", businessDate: "2026-01-05" });
    const t = await timeline(db, dataDir, wsA);
    expect(t.map((e) => e.title)).toEqual(["early", "late", "none"]);
    expect(t[0]!.businessDate).toBe("2026-01-05");
    expect(t[2]!.businessDate).toBeNull();
    expect(await timeline(db, dataDir, wsB)).toEqual([]);
  });

  test("timeline keeps url and related, skips entries missing from the store", async () => {
    await add(wsA, { kind: "requirement", title: "req" });
    await add(wsA, { kind: "source", title: "doc", url: "https://example.com/x", related: ["R-1"] });
    await db.query(`insert into entry_index(workspace_id, entry_id, kind, title, status, updated_at) values ($1,'R-99','requirement','ghost','active',now())`, [wsA]);
    const t = await timeline(db, dataDir, wsA);
    expect(t.map((e) => e.id)).toEqual(["R-1", "S-1"]);
    expect(t[1]).toMatchObject({ url: "https://example.com/x", related: ["R-1"] });
  });

  test("topOpenQuestion skips stale index rows without a file", async () => {
    await add(wsA, { kind: "question", title: "real", priority: 2 });
    await db.query(`insert into entry_index(workspace_id, entry_id, kind, title, status, priority, updated_at) values ($1,'Q-99','question','ghost','open',1,now())`, [wsA]);
    expect((await topOpenQuestion(db, dataDir, wsA))?.id).toBe("Q-1");
  });

  test("openQuestionCounts counts only open questions per workspace", async () => {
    await add(wsA, { kind: "question", title: "q1", priority: 1 });
    await add(wsA, { kind: "question", title: "q2", priority: 2 });
    await add(wsA, { kind: "question", title: "q3", priority: 2, status: "resolved" });
    await add(wsA, { kind: "requirement", title: "r" });
    expect(await openQuestionCounts(db)).toEqual({ [wsA]: 2 });
  });

  test("chooseAskedQuestion prefers a question this task left open", () => {
    const older = { id: "Q-2", kind: "question", status: "open", title: "old", body: "old body", priority: 1 } as never;
    const created = { id: "Q-3", kind: "question", status: "open", title: "new", body: "new body", priority: 2 } as never;
    const resolved = { id: "Q-1", kind: "question", status: "resolved", title: "done", body: "done", priority: 1 } as never;
    expect(chooseAskedQuestion([created, resolved], older)?.id).toBe("Q-3");
    expect(chooseAskedQuestion([resolved], older)?.id).toBe("Q-2");
    expect(chooseAskedQuestion([], null)).toBeNull();
  });

  test("topOpenQuestion picks lowest priority then lowest number", async () => {
    expect(await topOpenQuestion(db, dataDir, wsA)).toBeNull();
    await add(wsA, { kind: "question", title: "one", priority: 2 });
    await add(wsA, { kind: "question", title: "two", priority: 1 });
    await add(wsA, { kind: "question", title: "three", priority: 1, status: "resolved" });
    expect((await topOpenQuestion(db, dataDir, wsA))?.id).toBe("Q-2");
    await add(wsA, { kind: "question", title: "ten-ish", priority: 1 });
    expect((await topOpenQuestion(db, dataDir, wsA))?.id).toBe("Q-2");
    await new KnowledgeStore(repoPath(dataDir, wsA)).upsert(
      { id: "Q-2", kind: "question", title: "two", body: "b", reason: "r", sourceMessages: [], status: "resolved", priority: 1 } as never,
      { author: "agent" },
    );
    await indexEntry(db, wsA, (await new KnowledgeStore(repoPath(dataDir, wsA)).get("Q-2"))!);
    expect((await topOpenQuestion(db, dataDir, wsA))?.id).toBe("Q-4");
    await db.query(`update entry_index set status='resolved' where kind='question'`);
    expect(await topOpenQuestion(db, dataDir, wsA)).toBeNull();
  });
});

test("indexEntry writes tags and exactly equal timestamps on insert and update", async () => {
  const entry = await add(wsA, { kind: "requirement", title: "Tagged", tags: ["api"] });
  const check = async (tags: string[]) => expect(await db.query("select tags, tags_indexed_at = updated_at as same from entry_index where workspace_id=$1", [wsA])).toEqual([{ tags, same: true }]);
  await check(["api"]);
  await indexEntry(db, wsA, { ...entry, tags: [] });
  await check([]);
});


test.each([null, "2000-01-01T00:00:00.000Z"])("backfill preserves unreadable entries and retries after access is restored (stamp %s)", async (stamp) => {
  const entry = await add(wsA, { kind: "requirement", title: "Tagged", tags: ["real"] });
  await db.query("update entry_index set tags=$2, tags_indexed_at=$3 where workspace_id=$1", [wsA, ["previous"], stamp]);
  const file = path.join(repoPath(dataDir, wsA), "requirements", `${entry.id}.md`);
  const contents = await readFile(file);
  // A directory at the file path deterministically makes readFile fail, even as root.
  await rm(file);
  await mkdir(file);
  const before = await db.query("select tags, tags_indexed_at from entry_index where workspace_id=$1", [wsA]);
  try {
    await backfillEntryTags(db, dataDir);
    expect(await db.query("select tags, tags_indexed_at from entry_index where workspace_id=$1", [wsA])).toEqual(before);
  } finally {
    await rm(file, { recursive: true });
    await writeFile(file, contents);
  }
  await backfillEntryTags(db, dataDir);
  expect(await db.query("select tags, tags_indexed_at >= updated_at as fresh from entry_index where workspace_id=$1", [wsA])).toEqual([{ tags: ["real"], fresh: true }]);
});

test("backfill preserves the whole workspace when a kind directory cannot be listed", async () => {
  await add(wsA, { kind: "requirement", title: "Tagged", tags: ["real"] });
  await add(wsB, { kind: "requirement", title: "Other workspace", tags: ["other"] });
  await db.query("insert into entry_index(workspace_id,entry_id,kind,title,status,tags,updated_at) values ($1,'R-99','requirement','Deleted','active',$2,clock_timestamp())", [wsA, ["deleted"]]);
  await db.query("update entry_index set tags_indexed_at=null");
  await db.query("update entry_index set tags=$2 where workspace_id=$1 and entry_id='R-1'", [wsA, ["previous"]]);
  const snapshot = () => db.query("select entry_id,tags,tags_indexed_at from entry_index where workspace_id=$1 order by entry_id", [wsA]);
  const before = await snapshot();
  const kindDir = path.join(repoPath(dataDir, wsA), "questions");
  await rm(kindDir, { recursive: true });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await backfillEntryTags(db, dataDir);
    expect(await snapshot()).toEqual(before);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(wsA));
    expect(await db.query("select tags,tags_indexed_at >= updated_at as fresh from entry_index where workspace_id=$1", [wsB])).toEqual([{ tags: ["other"], fresh: true }]);
  } finally {
    warn.mockRestore();
    await mkdir(kindDir);
  }
  await backfillEntryTags(db, dataDir);
  expect(await db.query("select entry_id,tags,tags_indexed_at >= updated_at as fresh from entry_index where workspace_id=$1 order by entry_id", [wsA])).toEqual([
    { entry_id: "R-1", tags: ["real"], fresh: true },
    { entry_id: "R-99", tags: [], fresh: true },
  ]);
});
