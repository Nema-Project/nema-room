import { describe, expect, it } from "vitest";
import { validateSnapshot } from "../src/migration.js";

const empty = {
  schemaVersion: 1,
  appVersion: "0.1.0",
  tableData: {
    workspaces: [], messages: [], tasks: [], task_changes: [], entry_index: [], workspace_repos: [],
    workspace_plugins: [], plugin_calls: [], diagram_status: [], repo_hooks: [], main_moves: [],
  },
  knowledgeManifest: [],
};

describe("snapshot allowlist and references", () => {
  const event = { id: "ev1", workspace_id: "ws_missing", kind: "confirm_revision", entry_id: "S-1", target_basis: null, revision: null, content_hash: "a".repeat(64), refs_hash: "b".repeat(64), snapshot_hash: "c".repeat(64), payload_hash: "d".repeat(64), actor: "user", consumed_commit: null, consumed_at: null, consumable: true };
  it("imports a snapshot from before source evidence tables", () => {
    const snapshot = validateSnapshot(empty);
    for (const table of ["evidence_events", "source_import_receipts", "source_freshness"]) expect(snapshot.tableData[table]).toEqual([]);
  });
  it("rejects an evidence event for an unknown workspace", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, evidence_events: [event] } })).toThrow(/workspace/i);
  });
  const snapshotWith = (table: string, row: Record<string, unknown>) => ({ ...empty, tableData: { ...empty.tableData, workspaces: [{ id: "ws_a", name: "A", confidential: true, knowledge_language: "follow" }], [table]: [{ ...row, workspace_id: "ws_a" }] }, knowledgeManifest: [{ workspaceId: "ws_a", path: "repos/ws_a", bundle: "knowledge/ws_a.bundle", sha256: "a".repeat(64), refs: {}, head: "a".repeat(40) }] });
  it("rejects a freshness reason that is not in the check list", () => {
    expect(() => validateSnapshot(snapshotWith("source_freshness", { entry_id: "S-1", freshness: "unknown", reason: "invalid" }))).toThrow(/freshness/i);
  });
  it("rejects confirm_revision without a snapshot hash", () => {
    expect(() => validateSnapshot(snapshotWith("evidence_events", { ...event, snapshot_hash: null }))).toThrow(/snapshot hash/i);
  });
  it("rejects an evidence event with only one consumed column", () => {
    expect(() => validateSnapshot(snapshotWith("evidence_events", { ...event, consumed_commit: "abc" }))).toThrow(/consumed/i);
  });
  it.each(["content_hash", "refs_hash", "snapshot_hash", "payload_hash"])("rejects invalid %s", (column) => {
    expect(() => validateSnapshot(snapshotWith("evidence_events", { ...event, [column]: "invalid" }))).toThrow(/hash/i);
  });

  it("rejects tables and columns outside the static schema allowlist", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, arbitrary: [] } })).toThrow(/table/i);
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, workspaces: [{ id: "ws_abc", injected: "x" }] } })).toThrow(/column/i);
  });

  it("rejects dangling message and workspace references", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, messages: [{ id: "m1", workspace_id: "ws_missing", role: "user", content: "x" }] } })).toThrow(/workspace/i);
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, workspaces: [{ id: "ws_abc", name: "A", confidential: true, knowledge_language: "follow" }], tasks: [{ id: "t1", workspace_id: "ws_abc", message_id: "m_missing", status: "done" }] } })).toThrow(/message/i);
  });

  it("accepts a snapshot from before message versions", () => {
    expect(validateSnapshot(empty).tableData.message_versions).toEqual([]);
  });

  it("rejects a version that cites an unknown message", () => {
    const ws = { id: "ws_abc", name: "A", confidential: true, knowledge_language: "follow" };
    const withVersion = {
      ...empty,
      tableData: {
        ...empty.tableData,
        workspaces: [ws],
        messages: [{ id: "m1", workspace_id: "ws_abc", role: "user", content: "now" }],
        message_versions: [{ message_id: "m_missing", version: 1, content: "old" }],
      },
    };
    expect(() => validateSnapshot(withVersion)).toThrow(/message/i);
  });

  it("rejects report-token hashes instead of migrating credential material", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, report_tokens: [{ hash: "a".repeat(64) }] } })).toThrow(/table/i);
  });
});
