import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, chmod, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, git, withRepoLock } from "@nema/knowledge";
import { canonicalJson, type SourceSnapshot } from "@nema/shared";
import { createTestDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/db.js";
import { sha256 } from "../src/db/snapshot.js";
import { repoPath } from "../src/workspaces.js";
import { importSourceSnapshot, reconcileSourceImports } from "../src/sourceImport.js";
let db: Db, dataDir: string, repo: string, store: KnowledgeStore;
let seq = 0, ws: string;
function snapshot(text = "A"): SourceSnapshot {
  const payload = { schemaVersion: 1 as const, provider: "fake", resourceId: "doc", revision: null, title: text, canonicalUrl: "https://example.com/doc", excerpts: [{ locator: "p1", text }] };
  return { ...payload, fetchedAt: "2000-01-01T00:00:00Z", contentHash: sha256(canonicalJson(payload)) };
}
const run = (s = snapshot()) => importSourceSnapshot(db, dataDir, ws, s);
const receipt = async () => (await db.query<{ entry_id: string; phase: string }>("select entry_id, phase from source_import_receipts where workspace_id=$1 order by created_at", [ws]));
beforeAll(async () => { db = await createTestDb(); dataDir = await mkdtemp(path.join(os.tmpdir(), "source-import-")); });
beforeEach(async () => { ws = `import_${++seq}`; await db.query("insert into workspaces(id,name) values ($1,'Import')", [ws]); repo = repoPath(dataDir, ws); store = new KnowledgeStore(repo); await store.init(); });
afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });
it("imports a snapshot as an inferred source", async () => {
  const result = await run(); expect(result.entry).toMatchObject({ id: "S-1", basis: "inferred", status: "active", body: "Imported source. provider=fake resource=doc", sourceMessages: [], quotes: [], confirmedRevision: null });
  expect(result.entry.sourceSnapshot?.fetchedAt).not.toBe(snapshot().fetchedAt); expect((await receipt())[0].phase).toBe("indexed");
});
it("validates before writing any receipt", async () => {
  for (const s of [{ ...snapshot(), contentHash: "0".repeat(64) }, { ...snapshot(), schemaVersion: 2 }, { ...snapshot(), canonicalUrl: "file:///etc/passwd" }]) await expect(run(s as SourceSnapshot)).rejects.toMatchObject({ status: 400 });
  expect(await receipt()).toEqual([]);
});
it("returns the same entry for the same hash without a second commit", async () => { const first = await run(); const count = await git(repo, ["rev-list", "--count", "HEAD"]); expect(await run()).toMatchObject({ commit: first.commit, alreadyImported: true }); expect(await git(repo, ["rev-list", "--count", "HEAD"])).toBe(count); });
it("reimport with a new hash keeps the id and the basis", async () => { const first = await run(); await store.confirm(first.entry.id, { author: "user" }); await withRepoLock(repo, async () => { const entry = (await store.get(first.entry.id))!; await store.writeImportedSource({ ...entry, confirmedRevision: "confirmed-v1" }); }); const before = await store.get(first.entry.id); const next = await run(snapshot("B")); expect(next.entry).toMatchObject({ id: first.entry.id, basis: before!.basis, confirmedRevision: before!.confirmedRevision, confirmedAt: before!.confirmedAt }); });
it("refuses a dropped source", async () => { await run(); await store.withdraw("S-1", { author: "user" }); await expect(run(snapshot("B"))).rejects.toMatchObject({ status: 409, message: "来源已撤回，不能重新导入" }); });
it("reuses the reserved id when git commit fails", async () => {
  const hook = path.join(repo, ".git/hooks/pre-commit"); await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755); await git(repo, ["config", "core.hooksPath", ".git/hooks"]);
  await expect(run()).rejects.toThrow(); expect(await store.get("S-1")).toBeNull(); expect(await receipt()).toEqual([{ entry_id: "S-1", phase: "reserved" }]); await rm(hook); expect((await run()).entry.id).toBe("S-1");
});
it("does not allocate a second id when indexing fails", async () => { await expect(importSourceSnapshot(db, dataDir, ws, snapshot(), async () => { throw Error("index failed"); })).rejects.toMatchObject({ status: 500, message: "导入已写入知识库但索引未完成：S-1" }); expect((await run()).entry.id).toBe("S-1"); expect((await readdir(path.join(repo, "sources"))).filter(n => n.endsWith(".md"))).toEqual(["S-1.md"]); });
it("reconciles a reserved receipt whose file is already committed", async () => { await run(); await db.query("update source_import_receipts set phase='reserved', knowledge_commit=null where workspace_id=$1", [ws]); const head = await git(repo, ["rev-parse", "HEAD"]); await reconcileSourceImports(db, dataDir, ws); expect((await receipt())[0].phase).toBe("indexed"); expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head); });
it("finishes without deadlocking", async () => { await run(); }, 5000);
it("reapplies hash A after a null-revision reimport of B", async () => { await run(); await run(snapshot("B")); const next = await run(); expect(next.alreadyImported).toBe(false); expect(next.entry.sourceSnapshot?.contentHash).toBe(snapshot().contentHash); expect(next.entry.id).toBe("S-1"); });
it("restores a committed receipt whose blob still exists", async () => { await run(); const file = path.join(repo, "sources/S-1.md"); const bytes = await readFile(file, "utf8"); await db.query("update source_import_receipts set phase='committed' where workspace_id=$1", [ws]); await rm(file); await reconcileSourceImports(db, dataDir, ws); expect(await readFile(file, "utf8")).toBe(bytes); expect((await receipt())[0].phase).toBe("indexed"); });
it("rewrites the same id when the committed blob is gone", async () => { await run(); await db.query("update source_import_receipts set phase='committed',knowledge_commit='0000000000000000000000000000000000000000' where workspace_id=$1", [ws]); await rm(path.join(repo, "sources/S-1.md")); expect((await run()).entry.id).toBe("S-1"); expect((await store.get("S-1"))?.sourceSnapshot?.contentHash).toBe(snapshot().contentHash); });
it("conflicts when the path is a different resource", async () => { await run(); const file = path.join(repo, "sources/S-1.md"); await writeFile(file, (await readFile(file,"utf8")).replace("resource_id: doc", "resource_id: other")); await expect(run()).rejects.toMatchObject({ status: 409, message: "导入记录与知识库不一致：S-1" }); });
it("restores the recorded blob after a committed file deletion", async () => {
  const first = await run();
  await db.query("update source_import_receipts set phase='committed' where workspace_id=$1", [ws]);
  await git(repo, ["rm", "sources/S-1.md"]);
  await git(repo, ["commit", "-m", "Delete file"]);
  await reconcileSourceImports(db, dataDir, ws);
  expect((await store.get("S-1"))?.sourceSnapshot?.contentHash).toBe(snapshot().contentHash);
  expect((await receipt())[0].phase).toBe("indexed");
  expect(await db.query("select knowledge_commit from source_import_receipts where workspace_id=$1", [ws])).toEqual([{ knowledge_commit: first.commit }]);
});
it("does not reuse another resource's reserved id", async () => {
  const hook = path.join(repo, ".git/hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755); await git(repo, ["config", "core.hooksPath", ".git/hooks"]);
  await expect(run()).rejects.toThrow(); await rm(hook);
  const { fetchedAt, contentHash, ...payload } = { ...snapshot(), resourceId: "other" };
  const other = { ...payload, fetchedAt, contentHash: sha256(canonicalJson(payload)) };
  expect((await run(other)).entry.id).toBe("S-2");
  expect((await run()).entry.id).toBe("S-1");
});
it("claims the existing resource when receipts were lost", async () => {
  await run(); await db.query("delete from source_import_receipts where workspace_id=$1", [ws]);
  expect((await run(snapshot("B"))).entry.id).toBe("S-1");
});
it("preserves the file bytes when an update commit fails", async () => {
  await run(); const file = path.join(repo, "sources/S-1.md"), before = await readFile(file, "utf8");
  const hook = path.join(repo, ".git/hooks/pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755); await git(repo, ["config", "core.hooksPath", ".git/hooks"]);
  await expect(run(snapshot("B"))).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(before);
  await rm(hook); expect((await run(snapshot("B"))).entry.id).toBe("S-1");
});
it("supports imported sources without a canonical URL", async () => {
  const { fetchedAt, contentHash, ...payload } = { ...snapshot(), canonicalUrl: null };
  const result = await run({ ...payload, fetchedAt, contentHash: sha256(canonicalJson(payload)) });
  expect(result.entry.url).toBeUndefined();
  expect((await store.get(result.entry.id))?.url).toBeUndefined();
});
