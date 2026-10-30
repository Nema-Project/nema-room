import { afterEach, expect, test } from "vitest";
import type { GithubObservation, ReportCheck, ReportMessageMeta } from "@nema/shared";
import { addReportMessage, listMessages, mergeReportMeta, postSystemTask } from "../src/messages.js";
import { listQueuedTasks } from "../src/tasks.js";
import { createWorkspace, updateWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterEach(cleanupHubDeps);

test("postSystemTask creates a system message and a queued task", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const { message, task } = await postSystemTask(db, ws.id, "为仓库画架构图");
  expect(message).toMatchObject({ workspaceId: ws.id, role: "system", content: "为仓库画架构图", taskId: null });
  expect(task).toMatchObject({ workspaceId: ws.id, messageId: message.id, status: "queued" });
  expect((await listMessages(db, ws.id)).map((m) => m.id)).toEqual([message.id]);
  expect((await listQueuedTasks(db, ws.id)).map((t) => t.id)).toEqual([task.id]);
});

test("postSystemTask refuses an archived workspace like a user message", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  await updateWorkspace(db, ws.id, { archived: true });
  await expect(postSystemTask(db, ws.id, "x")).rejects.toThrow("workspace is archived; unarchive it to send messages");
  expect(await listMessages(db, ws.id)).toEqual([]);
  expect(await listQueuedTasks(db, ws.id)).toEqual([]);
});

const reportInput = { agent: "claude-code", gitCommonDir: "/r/.git", summary: "done", progress: "completed" as const, entries: [], commits: ["abcdef1"], files: [] };
const check = (over: Partial<ReportCheck> = {}): ReportCheck => ({
  commitsExist: true,
  missingCommits: [],
  onMain: "not-yet",
  filesOk: true,
  untouchedFiles: [],
  touchedFiles: [],
  checkedAt: "2026-10-28T00:00:01.000Z",
  mainSha: "1".repeat(40),
  ...over,
});
const observation = (over: Partial<GithubObservation> = {}): GithubObservation => ({
  state: "read",
  observedAt: "2026-10-28T00:00:00.000Z",
  source: "github-plugin-read",
  binding: { repoId: "repo_1", owner: "o", repo: "r", pr: 7, observedHeadSha: "a".repeat(40), claimedHeadSha: null },
  headMatch: "not_comparable",
  checkRuns: [],
  truncated: false,
  ...over,
});
const authors = { checkedAt: "2026-10-28T00:00:00.000Z", source: "git" as const, commits: [], missing: [] };

async function report() {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const message = await addReportMessage(db, ws.id, "done", { report: reportInput, check: null });
  const meta = async () => (await listMessages(db, ws.id)).find((m) => m.id === message.id)!.meta as ReportMessageMeta;
  return { db, id: message.id, meta };
}

test("merges a check without dropping github or authors", async () => {
  const { db, id, meta } = await report();
  await mergeReportMeta(db, id, { authors });
  await mergeReportMeta(db, id, { github: observation() });
  const next = check({ onMain: "yes" });
  const updated = await mergeReportMeta(db, id, { check: next, checkError: null, checkSkipped: null });
  expect((updated!.meta as ReportMessageMeta).check).toEqual(next);
  const m = await meta();
  expect(m.report).toEqual(reportInput);
  expect(m.check).toEqual(next);
  expect(m.authors).toEqual(authors);
  expect(m.github).toEqual({ current: observation(), history: [] });
});

test("appends the previous check to checkHistory", async () => {
  const { db, id, meta } = await report();
  const first = check({ checkedAt: "2026-10-28T00:00:01.000Z" });
  await mergeReportMeta(db, id, { check: first });
  expect((await meta()).checkHistory ?? []).toEqual([]);
  await mergeReportMeta(db, id, { check: check({ checkedAt: "2026-10-28T00:00:02.000Z", onMain: "yes", mainSha: "2".repeat(40) }) });
  expect((await meta()).checkHistory).toEqual([
    { onMain: "not-yet", commitsExist: true, filesOk: true, checkedAt: "2026-10-28T00:00:01.000Z", mainSha: "1".repeat(40) },
  ]);
  await mergeReportMeta(db, id, { check: check({ checkedAt: "2026-10-28T00:00:03.000Z", filesOk: false }) });
  const history = (await meta()).checkHistory!;
  expect(history).toHaveLength(2);
  expect(history[1]).toEqual({ onMain: "yes", commitsExist: true, filesOk: true, checkedAt: "2026-10-28T00:00:02.000Z", mainSha: "2".repeat(40) });
});

test("appends a github current that was not not_requested", async () => {
  const { db, id, meta } = await report();
  const read = observation();
  const unavailable = observation({ state: "unavailable", reasonCode: "timeout", headMatch: null, observedAt: "2026-10-28T00:00:05.000Z" });
  await mergeReportMeta(db, id, { github: read });
  await mergeReportMeta(db, id, { github: unavailable });
  expect((await meta()).github).toEqual({ current: unavailable, history: [read] });

  const other = await report();
  const notRequested = observation({ state: "not_requested", binding: null, headMatch: null });
  await mergeReportMeta(other.db, other.id, { github: notRequested });
  await mergeReportMeta(other.db, other.id, { github: read });
  expect((await other.meta()).github).toEqual({ current: read, history: [] });
});

test("keeps both keys when two merges run together", async () => {
  const { db, id, meta } = await report();
  await Promise.all([mergeReportMeta(db, id, { authors }), mergeReportMeta(db, id, { github: observation() })]);
  const m = await meta();
  expect(m.authors).toEqual(authors);
  expect(m.github?.current).toEqual(observation());
});

test("keeps the newer check when an older one finishes last", async () => {
  const { db, id, meta } = await report();
  const newer = check({ checkedAt: "2026-10-28T00:00:02.000Z" });
  await mergeReportMeta(db, id, { check: newer, checkError: null, checkSkipped: null });
  await mergeReportMeta(db, id, { check: check({ checkedAt: "2026-10-28T00:00:01.000Z", onMain: "yes" }), checkError: "late" });
  let m = await meta();
  expect(m.check).toEqual(newer);
  expect(m.checkError).toBeUndefined();
  expect(m.checkHistory ?? []).toEqual([]);
  const same = check({ checkedAt: "2026-10-28T00:00:02.000Z", onMain: "yes" });
  await mergeReportMeta(db, id, { check: same });
  m = await meta();
  expect(m.check).toEqual(same);
  expect(m.checkHistory).toHaveLength(1);
});

test("a check with no checkedAt does not replace a stored one", async () => {
  const { db, id, meta } = await report();
  const stored = check();
  await mergeReportMeta(db, id, { check: stored });
  await mergeReportMeta(db, id, { check: { ...check({ onMain: "yes" }), checkedAt: undefined as unknown as string } });
  expect((await meta()).check).toEqual(stored);
});

test("clears a key the patch sets to null and refuses a non-report message", async () => {
  const { db, id, meta } = await report();
  await mergeReportMeta(db, id, { check: null, checkError: "daemon offline" });
  expect((await meta()).checkError).toBe("daemon offline");
  await mergeReportMeta(db, id, { check: check(), checkError: null });
  const m = await meta();
  expect(m.check).toEqual(check());
  expect("checkError" in m).toBe(false);
  expect(await mergeReportMeta(db, "m_missing", { authors })).toBeNull();
});
