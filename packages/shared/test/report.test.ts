import { expect, test } from "vitest";
import { HookSignal, ReportInput, reportPassed, type ReportCheck, type ReportMessageMeta } from "../src/index.js";

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

test("parses a pre-v1 report as completed", () => {
  const parsed = ReportInput.parse(baseReport);
  expect(parsed.progress).toBe("completed");
  expect(parsed.commits).toEqual(["abc1234"]);
});

test("rejects a completed report with no commits", () => {
  expect(ReportInput.safeParse({ ...baseReport, commits: [] }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, progress: "completed", commits: [] }).success).toBe(false);
  const { commits: _commits, ...noCommits } = baseReport;
  expect(ReportInput.safeParse(noCommits).success).toBe(false);
});

test("accepts an in-progress report with no commits", () => {
  const { commits: _commits, ...noCommits } = baseReport;
  expect(ReportInput.parse({ ...noCommits, progress: "in_progress" }).commits).toEqual([]);
  expect(ReportInput.parse({ ...baseReport, progress: "in_progress", commits: [] }).commits).toEqual([]);
  expect(ReportInput.safeParse({ ...baseReport, progress: "paused" }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, progress: "in_progress", commits: Array.from({ length: 51 }, () => "abc1234") }).success).toBe(false);
});

test("strips unknown report keys", () => {
  const parsed = ReportInput.parse({ ...baseReport, extra: true });
  expect("extra" in parsed).toBe(false);
});

test("accepts the agent claim fields", () => {
  const parsed = ReportInput.parse({
    ...baseReport,
    branch: "feat/x",
    pr: 7,
    headSha: SHA,
    ci: [{ name: "test", conclusion: "success", url: "https://ci.example/1" }, { name: "lint" }],
    verified: ["unit"],
    notVerified: ["e2e"],
    blockers: ["needs review"],
  });
  expect(parsed).toMatchObject({ branch: "feat/x", pr: 7, headSha: SHA, verified: ["unit"], notVerified: ["e2e"], blockers: ["needs review"] });
  expect(parsed.ci).toEqual([{ name: "test", conclusion: "success", url: "https://ci.example/1" }, { name: "lint" }]);
});

test("rejects a bad claim shape", () => {
  expect(ReportInput.safeParse({ ...baseReport, headSha: "A".repeat(40) }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, headSha: "a".repeat(39) }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, branch: "a\nb" }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, branch: "a\rb" }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, branch: "" }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, pr: 0 }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, pr: 1.5 }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, verified: Array.from({ length: 31 }, () => "x") }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, notVerified: [""] }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, blockers: Array.from({ length: 21 }, () => "x") }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, ci: [{ name: "" }] }).success).toBe(false);
  expect(ReportInput.safeParse({ ...baseReport, ci: Array.from({ length: 31 }, () => ({ name: "x" })) }).success).toBe(false);
});

test("keeps reportPassed on the three git fields", () => {
  const check: ReportCheck = { commitsExist: true, missingCommits: [], onMain: "yes", filesOk: true, untouchedFiles: [], touchedFiles: [], checkedAt: "2026-10-23T00:00:00.000Z", mainSha: SHA };
  expect(reportPassed(check)).toBe(true);
  expect(reportPassed({ ...check, onMain: "not-yet" })).toBe(false);
  expect(Object.keys(check).sort()).toEqual(["checkedAt", "commitsExist", "filesOk", "mainSha", "missingCommits", "onMain", "touchedFiles", "untouchedFiles"]);
});

test("ReportMessageMeta keeps pre-v1 meta valid", () => {
  const legacy: ReportMessageMeta = { report: ReportInput.parse(baseReport), check: null };
  expect(legacy.checkSkipped).toBeUndefined();
  expect(legacy.github).toBeUndefined();
});
