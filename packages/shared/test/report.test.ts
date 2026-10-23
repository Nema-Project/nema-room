import { expect, test } from "vitest";
import { HookSignal, ReportInput, reportPassed } from "../src/index.js";

const SHA = "a".repeat(40);
const baseReport = { agent: "claude-code", gitCommonDir: "/r/.git", summary: "done", commits: ["abc1234"] };

test("ReportInput rejects an empty summary, a non-hex commit and more than 50 commits", () => {
  const ok = ReportInput.parse(baseReport);
  expect(ok.entries).toEqual([]);
  expect(ok.files).toEqual([]);
  expect(ReportInput.safeParse({ ...baseReport, summary: "" }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, commits: ["xyz1234"] }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, commits: Array.from({ length: 51 }, () => "abc1234") }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, commits: [] }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, entries: ["X-1"] }).success).toBe(false);
  expect(ReportInput.parse({ ...baseReport, entries: ["R-3", "G-1"] }).entries).toEqual(["R-3", "G-1"]);
});

test("HookSignal accepts only the seven fields and strips anything else", () => {
  const raw = {
    agent: "codex",
    cwd: "/r/sub",
    gitCommonDir: "/r/.git",
    branch: null,
    head: SHA,
    at: "2026-10-23T01:02:03.000Z",
    sessionId: "s1",
    transcript: "secret",
  };
  const parsed = HookSignal.strip().parse(raw);
  expect("transcript" in parsed).toBe(false);
  expect(Object.keys(parsed).sort()).toEqual(["agent", "at", "branch", "cwd", "gitCommonDir", "head", "sessionId"]);
  expect(HookSignal.safeParse({ ...raw, head: "abc" }).success).toBe(false);
  expect(HookSignal.safeParse({ ...raw, agent: "" }).success).toBe(false);
});

test("reportPassed needs commits, main and files", () => {
  const check = { commitsExist: true, missingCommits: [], onMain: "yes" as const, filesOk: true, untouchedFiles: [], checkedAt: "2026-10-23T00:00:00.000Z", mainSha: SHA };
  expect(reportPassed(check)).toBe(true);
  expect(reportPassed({ ...check, onMain: "not-yet" })).toBe(false);
  expect(reportPassed({ ...check, filesOk: false })).toBe(false);
  expect(reportPassed({ ...check, commitsExist: false })).toBe(false);
});

test("ReportInput accepts W-2 and task 3, rejects task 16", () => {
  expect(ReportInput.parse({ ...baseReport, entries: ["W-2"], task: 3 }).task).toBe(3);
  expect(ReportInput.safeParse({ ...baseReport, task: 16 }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, task: 0 }).success).toBe(false);
});
