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
  it("rejects tables and columns outside the static schema allowlist", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, arbitrary: [] } })).toThrow(/table/i);
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, workspaces: [{ id: "ws_abc", injected: "x" }] } })).toThrow(/column/i);
  });

  it("rejects dangling message and workspace references", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, messages: [{ id: "m1", workspace_id: "ws_missing", role: "user", content: "x" }] } })).toThrow(/workspace/i);
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, workspaces: [{ id: "ws_abc", name: "A", confidential: true, knowledge_language: "follow" }], tasks: [{ id: "t1", workspace_id: "ws_abc", message_id: "m_missing", status: "done" }] } })).toThrow(/message/i);
  });

  it("rejects report-token hashes instead of migrating credential material", () => {
    expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, report_tokens: [{ hash: "a".repeat(64) }] } })).toThrow(/table/i);
  });
});
