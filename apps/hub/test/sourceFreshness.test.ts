import { expect, it } from "vitest";
import type { Entry } from "@nema/shared";
import { attachSourceEvidence } from "../src/sourceFreshness.js";
const hash = "a".repeat(64);
const source = { id: "S-1", kind: "source", confirmedRevision: null, sourceSnapshot: { revision: null, contentHash: hash } } as Entry;
const decision = { id: "D-1", kind: "decision", sourceRefs: [{ sourceEntryId: "S-1", revision: null, snapshotHash: hash }] } as Entry;
it("does not set reviewNeeded when the source has never been checked", () => {
  expect(attachSourceEvidence([source, decision], [])[1]).toMatchObject({ freshness: "unknown", reviewNeeded: false, unconfirmedSnapshot: false });
});
it("clamps a current row to unknown when the snapshot revision is null", () => {
  expect(attachSourceEvidence([source], [{ entry_id: "S-1", freshness: "current", checked_revision: "v1", reason: "match" }])[0].freshness).toBe("unknown");
});
it("sets reviewNeeded when a null revision snapshot hash changes", () => {
  expect(attachSourceEvidence([{ ...source, sourceSnapshot: { ...source.sourceSnapshot!, contentHash: "b".repeat(64) } }, decision], [])[1].reviewNeeded).toBe(true);
});
it("unknown and timeout do not set reviewNeeded", () => {
  expect(attachSourceEvidence([source, decision], [{ entry_id: "S-1", freshness: "unknown", checked_revision: null, reason: "timeout" }])[1].reviewNeeded).toBe(false);
});
it("a ref revision that differs from the snapshot sets reviewNeeded", () => {
  expect(attachSourceEvidence([{ ...source, sourceSnapshot: { ...source.sourceSnapshot!, revision: "v2" } }, decision], [])[1].reviewNeeded).toBe(true);
});
it("requires a consumed matching event and consistent confirmedRevision", () => {
  const s = { ...source, sourceSnapshot: { ...source.sourceSnapshot!, revision: "v1" }, confirmedRevision: "v1" };
  const event = { entry_id: "S-1", revision: "v1", snapshot_hash: hash };
  expect(attachSourceEvidence([s], [], [event])[0].unconfirmedSnapshot).toBe(false);
  expect(attachSourceEvidence([{ ...s, confirmedRevision: null }], [], [event])[0].unconfirmedSnapshot).toBe(true);
  expect(attachSourceEvidence([s], [], [{ ...event, snapshot_hash: "b".repeat(64) }])[0].unconfirmedSnapshot).toBe(true);
});
it("flags missing sources, missing snapshots and unavailable checks", () => {
  expect(attachSourceEvidence([decision], [])[0].reviewNeeded).toBe(true);
  expect(attachSourceEvidence([{ ...source, sourceSnapshot: undefined }, decision], [])[1].reviewNeeded).toBe(true);
  expect(attachSourceEvidence([source, decision], [{ entry_id: "S-1", freshness: "unavailable", checked_revision: null, reason: "forbidden" }])[1].reviewNeeded).toBe(true);
});
it("confirms null revision snapshots by hash without marking freshness current", () => {
  expect(attachSourceEvidence([source], [], [{ entry_id: source.id, revision: null, snapshot_hash: hash }])[0]).toMatchObject({ freshness: "unknown", unconfirmedSnapshot: false });
});
