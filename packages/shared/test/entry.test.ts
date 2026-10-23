import { expect, test } from "vitest";
import { AgentMessageMeta, EntryFrontmatter, KIND_DIR, KIND_PREFIX, UpsertEntryInput, idNumber, isStale, kindFromId } from "../src/index.js";

const baseDecision = {
  id: "D-1",
  kind: "decision" as const,
  title: "t",
  status: "active" as const,
  businessDate: null,
  related: [] as string[],
  sourceMessages: [] as string[],
  basis: null,
  ingestedAt: null,
  confirmedAt: null,
  quotes: [] as { messageId: string; text: string }[],
};

const baseUpsert = {
  kind: "decision" as const,
  title: "t",
  body: "b",
  reason: "r",
};

test("kindFromId", () => {
  expect(kindFromId("R-7")).toBe("requirement");
  expect(kindFromId("Q-12")).toBe("question");
  expect(kindFromId("R-0")).toBeNull();
  expect(kindFromId("X-1")).toBeNull();
});
test("kind-specific rules", () => {
  const base = { title: "t", body: "b", sourceMessages: ["m_1"], reason: "r" };
  expect(() => UpsertEntryInput.parse({ ...base, kind: "source" })).toThrow();
  expect(() => UpsertEntryInput.parse({ ...base, kind: "source", url: "javascript:alert(1)" })).toThrow();
  expect(UpsertEntryInput.parse({ ...base, kind: "source", url: "https://docs.google.com/x" }).url).toMatch(/^https/);
  expect(() => UpsertEntryInput.parse({ ...base, kind: "question" })).toThrow();
  expect(UpsertEntryInput.parse({ ...base, kind: "decision", sourceMessages: undefined }).sourceMessages).toEqual([]);
  expect(() => UpsertEntryInput.parse({ ...base, kind: "decision", status: "open" })).toThrow();
});
test("AgentMessageMeta", () => {
  expect(AgentMessageMeta.parse({ changes: [{ entryId: "R-7", kind: "requirement", title: "流式输出", op: "add" }], askedQuestion: null }).changes).toHaveLength(1);
});
test("idNumber", () => {
  expect(idNumber("D-42")).toBe(42);
});
test("frontmatter accepts basis, times and quotes", () => {
  const fm = EntryFrontmatter.parse({ ...baseDecision, basis: "inferred", ingestedAt: "2026-10-23T01:02:03.000Z", confirmedAt: "2026-10-23T01:02:03.000Z", quotes: [{ messageId: "m_1", text: "先流式" }] });
  expect(fm.basis).toBe("inferred");
});
test("frontmatter rejects an unknown basis", () => {
  expect(EntryFrontmatter.safeParse({ ...baseDecision, basis: "guessed", ingestedAt: null, confirmedAt: null, quotes: [] }).success).toBe(false);
});
test("upsert input rejects a quote longer than 500 characters", () => {
  expect(UpsertEntryInput.safeParse({ ...baseUpsert, quotes: [{ messageId: "m_1", text: "x".repeat(501) }] }).success).toBe(false);
});
test("isStale flags only sources unconfirmed for more than 90 days", () => {
  const now = new Date("2026-10-23T00:00:00Z");
  expect(isStale({ kind: "source", confirmedAt: "2026-07-24T23:59:59Z" }, now)).toBe(true);   // 90 days + 1s
  expect(isStale({ kind: "source", confirmedAt: "2026-07-25T00:00:00Z" }, now)).toBe(false);  // exactly 90 days
  expect(isStale({ kind: "decision", confirmedAt: "2020-01-01T00:00:00Z" }, now)).toBe(false);
  expect(isStale({ kind: "source", confirmedAt: null }, now)).toBe(false);
});
test("diagram frontmatter round-trips and is rejected on other kinds", () => {
  const diagram = {
    repoId: "repo_api",
    type: "architecture" as const,
    sourceCommits: { repo_api: "abc123" },
    nodePaths: { hub: ["apps/hub/src"], web: ["apps/web"] },
  };
  expect(kindFromId("G-3")).toBe("diagram");
  const fm = EntryFrontmatter.parse({ ...baseDecision, id: "G-1", kind: "diagram", diagram });
  expect(fm.diagram).toEqual(diagram);
  expect(EntryFrontmatter.safeParse({ ...baseDecision, id: "G-1", kind: "diagram" }).success).toBe(false);
  expect(EntryFrontmatter.safeParse({ ...baseDecision, diagram }).success).toBe(false);
  expect(EntryFrontmatter.safeParse({ ...baseDecision, id: "G-1", kind: "diagram", diagram: { ...diagram, type: "mindmap" } }).success).toBe(false);
  expect(EntryFrontmatter.safeParse({ ...baseDecision, id: "G-1", kind: "diagram", status: "open", diagram }).success).toBe(false);
  // upsert_entry cannot create or rewrite a diagram; only diagram__save can.
  expect(UpsertEntryInput.safeParse({ ...baseUpsert, kind: "diagram" }).success).toBe(false);
});

test("implementation is accepted only on requirements and round-trips", () => {
  const implementation = {
    status: "reported" as const,
    evidence: { reportMessageId: "m_1", commits: ["abc1234"], inferred: false, note: null, confirmedBy: null },
  };
  const req = EntryFrontmatter.parse({ ...baseDecision, id: "R-1", kind: "requirement", implementation });
  expect(req.implementation).toEqual(implementation);
  expect(EntryFrontmatter.parse(JSON.parse(JSON.stringify(req))).implementation).toEqual(implementation);
  expect(EntryFrontmatter.safeParse({ ...baseDecision, implementation }).success).toBe(false);
  expect(EntryFrontmatter.safeParse({ ...baseDecision, id: "R-1", kind: "requirement", implementation: { ...implementation, status: "done" } }).success).toBe(false);
  expect(EntryFrontmatter.parse({ ...baseDecision, id: "R-1", kind: "requirement" }).implementation).toBeUndefined();
});

const wpMeta = { requirements: ["R-1"], repos: ["r1"], approvedAt: null, approvedCommit: null, blockedOn: null, tasks: [] };
test("workpackage meta is required on that kind and rejected elsewhere", () => {
  const wp = { ...baseDecision, id: "W-1", kind: "workpackage" as const, status: "draft" as const };
  expect(EntryFrontmatter.safeParse(wp).success).toBe(false);
  expect(EntryFrontmatter.safeParse({ ...wp, workpackage: wpMeta }).success).toBe(true);
  expect(EntryFrontmatter.safeParse({ ...baseDecision, workpackage: wpMeta }).success).toBe(false);
  expect(UpsertEntryInput.safeParse({ ...baseUpsert, kind: "workpackage" }).success).toBe(false);
});
test("W-n parses as workpackage", () => {
  expect(kindFromId("W-3")).toBe("workpackage");
  expect(KIND_PREFIX.workpackage).toBe("W");
  expect(KIND_DIR.workpackage).toBe("workpackages");
});
