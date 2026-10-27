import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/db.js";
import { consumeEvidenceEvent, insertEvidenceEvent, payloadHashFor } from "../src/evidenceEvents.js";
import { canonicalJson } from "@nema/shared";
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
