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

  it("rejects knowledge share rows instead of copying tokens into a snapshot", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, knowledge_shares: [{ id: "ks_abcdefghijklmnop" }] } })).toThrow(/table/i);
  });
});

describe("identity tables (#163)", () => {
  const ws = { id: "ws_a", name: "A", confidential: true, knowledge_language: "follow" };
  const manifest = [{ workspaceId: "ws_a", path: "repos/ws_a", bundle: "knowledge/ws_a.bundle", sha256: "a".repeat(64), refs: {}, head: "a".repeat(40) }];
  const good = () => ({
    ...empty,
    tableData: {
      ...empty.tableData,
      users: [{ id: "usr_local", display_name: null }, { id: "usr_zhang", display_name: "张三" }],
      workspaces: [ws],
      workspace_members: [
        { workspace_id: "ws_a", user_id: "usr_local", role: "owner", added_by: null, removed_at: null, removed_by: null },
        { workspace_id: "ws_a", user_id: "usr_zhang", role: "member", added_by: "usr_local", removed_at: "2026-11-17T00:00:00.000Z", removed_by: "usr_local" },
      ],
      member_events: [
        { id: "mev_seed_ws_a", workspace_id: "ws_a", user_id: "usr_local", kind: "added", actor_user_id: null, detail: null },
        { id: "mev_rename", workspace_id: null, user_id: "usr_zhang", kind: "renamed", actor_user_id: "usr_zhang", detail: { from: null, to: "张三" } },
      ],
      messages: [{ id: "m1", workspace_id: "ws_a", role: "user", content: "x", author_user_id: "usr_zhang" }, { id: "m2", workspace_id: "ws_a", role: "agent", content: "y", author_user_id: null }],
    },
    knowledgeManifest: manifest,
  });
  const mutate = (fn: (data: any) => void) => { const s = good(); fn(s.tableData); return s; };

  it("accepts the identity tables and message authors", () => {
    expect(validateSnapshot(good()).tableData.users).toHaveLength(2);
  });
  it("accepts a snapshot without identity tables", () => {
    expect(validateSnapshot(empty).tableData.workspace_members).toEqual([]);
  });
  it.each<[string, (data: any) => void, RegExp]>([
    ["an author missing from users", (d) => { d.messages[0].author_user_id = "usr_ghost"; }, /user reference/],
    ["an author on a non-user message", (d) => { d.messages[1].author_user_id = "usr_local"; }, /author/],
    ["an unknown role", (d) => { d.workspace_members[0].role = "viewer"; }, /member row/],
    ["an unknown event kind", (d) => { d.member_events[0].kind = "deleted"; }, /event row/],
    ["a member of a missing workspace", (d) => { d.workspace_members[0].workspace_id = "ws_missing"; }, /workspace/],
    ["a member who is not a user", (d) => { d.workspace_members[0].user_id = "usr_ghost"; }, /user reference/],
    ["an event for a missing workspace", (d) => { d.member_events[0].workspace_id = "ws_missing"; }, /workspace/],
    ["an event for a missing user", (d) => { d.member_events[0].user_id = "usr_ghost"; }, /user reference/],
    ["a half-removed member", (d) => { d.workspace_members[1].removed_by = null; }, /member row/],
    ["a bad user id", (d) => { d.users[1].id = "bob"; }, /user id/],
    ["a 65-character display name", (d) => { d.users[1].display_name = "x".repeat(65); }, /display name/],
    ["an empty display name", (d) => { d.users[1].display_name = ""; }, /display name/],
  ])("rejects %s", (_name, fn, error) => {
    expect(() => validateSnapshot(mutate(fn))).toThrow(error);
  });
  it("names the tables an older validator does not know (the documented rollback limit)", () => {
    // Spec §快照与恢复: a new snapshot does not import into an older version, same as message_attachments did.
    const before = [...Object.keys(empty.tableData), "message_versions", "threads", "question_threads", "evidence_events", "source_import_receipts", "source_freshness", "message_attachments"];
    expect(Object.keys(validateSnapshot(good()).tableData).filter((t) => !before.includes(t)).sort()).toEqual(["auth_events", "daemon_events", "daemons", "member_events", "user_credentials", "users", "workspace_members"]);
  });
});

it("entry index tags remain outside the snapshot column allowlist", () => {
  for (const column of ["tags", "tags_indexed_at"]) {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, entry_index: [{ [column]: null }] } })).toThrow(/column/i);
  }
});
