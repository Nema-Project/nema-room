import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KnowledgeStore, git } from "@nema/knowledge";
import { entryContentHash, refsHash, relatedSnapshotHash } from "../src/evidencePayload.js";
import { repoPath } from "../src/workspaces.js";
import { importSourceSnapshot } from "../src/sourceImport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/db.js";
import { consumeEvidenceEvent, insertEvidenceEvent, payloadHashFor, reconcileUnconsumedEvents } from "../src/evidenceEvents.js";
import { canonicalJson, type SourceSnapshot } from "@nema/shared";
import { sha256 } from "../src/db/snapshot.js";

let db: Db;
const input = (entryId: string) => ({ workspaceId: "ws_events", entryId, kind: "confirm_entry" as const, contentHash: "content", refsHash: "refs" });
beforeAll(async () => {
  db = await createTestDb();
  await db.query("insert into workspaces(id, name) values ('ws_events', 'Events'), ('ws_other', 'Other')");
});

describe("evidence events", () => {
  it("hashes the canonical payload with absent fields normalized to null", () => {
    expect(payloadHashFor(input("K-1"))).toBe(sha256(canonicalJson({ ...input("K-1"), targetBasis: null, revision: null, snapshotHash: null })));
    expect(payloadHashFor({ ...input("K-1"), revision: null })).toBe(payloadHashFor(input("K-1")));
    expect(payloadHashFor(input("K-2"))).not.toBe(payloadHashFor(input("K-1")));
  });
  it("reuses an unconsumed event with the same payload hash", async () => {
    const first = await insertEvidenceEvent(db, input("K-1"));
    const next = await insertEvidenceEvent(db, input("K-1"));
    expect(first).toMatchObject({ reused: false, id: expect.stringMatching(/^ev_/) });
    expect(next).toEqual({ ...first, reused: true });
    expect(await db.query("select actor from evidence_events where entry_id = 'K-1'")).toEqual([{ actor: "user" }]);
  });
  it("does not reuse a consumed event", async () => {
    const first = await insertEvidenceEvent(db, input("K-2"));
    expect(await consumeEvidenceEvent(db, "ws_events", first.id, first.payloadHash, "commit1")).toBe(true);
    const next = await insertEvidenceEvent(db, input("K-2"));
    expect(next.reused).toBe(false);
    expect(next.id).not.toBe(first.id);
    expect(await db.query("select id from evidence_events where entry_id = 'K-2'")).toHaveLength(2);
  });
  it("consume is a no-op when the hash or workspace differs", async () => {
    const event = await insertEvidenceEvent(db, input("K-3"));
    expect(await consumeEvidenceEvent(db, "ws_other", event.id, event.payloadHash, "bad")).toBe(false);
    expect(await consumeEvidenceEvent(db, "ws_events", event.id, "wrong", "bad")).toBe(false);
    expect(await db.query("select consumed_commit, consumed_at from evidence_events where id = $1", [event.id])).toEqual([{ consumed_commit: null, consumed_at: null }]);
  });
  it("consume cannot run twice", async () => {
    const event = await insertEvidenceEvent(db, input("K-4"));
    expect(await consumeEvidenceEvent(db, "ws_events", event.id, event.payloadHash, "first")).toBe(true);
    expect(await consumeEvidenceEvent(db, "ws_events", event.id, event.payloadHash, "second")).toBe(false);
    expect(await db.query("select consumed_commit from evidence_events where id = $1", [event.id])).toEqual([{ consumed_commit: "first" }]);
  });
  it("rejects a second unconsumed row with the same payload hash", async () => {
    const events = await Promise.all([insertEvidenceEvent(db, input("K-5")), insertEvidenceEvent(db, input("K-5"))]);
    expect(events[0].id).toBe(events[1].id);
    expect(events.map(event => event.reused).sort()).toEqual([false, true]);
    expect(await db.query("select id from evidence_events where entry_id = 'K-5'")).toHaveLength(1);
  });
  it("does not consume an event restored as not consumable", async () => {
    const event = await insertEvidenceEvent(db, input("K-6"));
    await db.query("update evidence_events set consumable = false where id = $1", [event.id]);
    expect(await consumeEvidenceEvent(db, "ws_events", event.id, event.payloadHash, "bad")).toBe(false);
    expect(await db.query("select consumed_commit, consumed_at from evidence_events where id = $1", [event.id])).toEqual([{ consumed_commit: null, consumed_at: null }]);
    const next = await insertEvidenceEvent(db, input("K-6"));
    expect(next.reused).toBe(false);
    expect(next.id).not.toBe(event.id);
  });
});

let dataDir: string;
afterAll(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
it.each(["match", "mismatch", "no trailer", "not consumable", "later entry edit", "dirty worktree", "later source edit"])("reconciles only matching consumable entry commits: %s", async (scenario) => {
  dataDir ??= await mkdtemp(path.join(os.tmpdir(), "event-recovery-"));
  const ws = `reconcile_${scenario.replaceAll(" ", "_")}`;
  await db.query("insert into workspaces(id,name) values ($1,'Recovery')", [ws]);
  const repo = repoPath(dataDir, ws), store = new KnowledgeStore(repo);
  await store.init();
  let source: SourceSnapshot | undefined;
  if (scenario === "later source edit") {
    const payload = { schemaVersion: 1 as const, provider: "fake", resourceId: "doc", revision: "v1", title: "Source", canonicalUrl: null, excerpts: [{ locator: "p1", text: "original" }] };
    source = { ...payload, fetchedAt: new Date().toISOString(), contentHash: sha256(canonicalJson(payload)) };
    await importSourceSnapshot(db, dataDir, ws, source);
  }
  const { entry } = await store.upsert({ kind: "decision", title: "Evidence", body: "Body", basis: "inferred", reason: "test", sourceMessages: [], ...(source ? { sourceRefs: [{ sourceEntryId: "S-1", revision: "v1", snapshotHash: source.contentHash }] } : {}) }, { author: "agent" });
  const event = await insertEvidenceEvent(db, { workspaceId: ws, entryId: entry.id, kind: "promote_basis", targetBasis: "decided", contentHash: scenario === "mismatch" ? "different" : entryContentHash(entry), refsHash: refsHash(entry), snapshotHash: await relatedSnapshotHash(entry, (id) => store.get(id)) });
  const file = path.join(repo, `decisions/${entry.id}.md`);
  await writeFile(file, (await readFile(file, "utf8")).replace("basis: inferred", "basis: decided"));
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", `update ${entry.id}: Evidence\n\nReason: test\nSource-Messages: \nAuthor: user${scenario === "no trailer" ? "" : `\nEvidence-Event: ${event.id}`}\nUI-Action: confirm`]);
  const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();
  if (scenario === "not consumable") await db.query("update evidence_events set consumable=false where id=$1", [event.id]);
  if (scenario === "later entry edit") {
    await writeFile(file, (await readFile(file, "utf8")).replace("Body", "New body"));
    await git(repo, ["add", "."]);
  }
  await git(repo, ["commit", "--allow-empty", "-m", "unrelated commit"]);
  if (scenario === "dirty worktree") await writeFile(file, (await readFile(file, "utf8")).replace("Body", "Uncommitted body"));
  if (source) {
    const { fetchedAt, contentHash, ...payload } = { ...source, revision: "v2" };
    await importSourceSnapshot(db, dataDir, ws, { ...payload, fetchedAt, contentHash: sha256(canonicalJson(payload)) });
  }
  const bytes = await readFile(file, "utf8");
  await reconcileUnconsumedEvents(db, dataDir, ws);
  expect(await db.query("select consumed_commit from evidence_events where id=$1", [event.id])).toEqual([{ consumed_commit: ["match", "dirty worktree", "later source edit"].includes(scenario) ? commit : null }]);
  expect(await readFile(file, "utf8")).toBe(bytes);
});
