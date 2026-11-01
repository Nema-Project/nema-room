import { afterEach, describe, expect, test } from "vitest";
import { AttachmentRefSchema, type GithubObservation, type ReportCheck, type ReportMessageMeta } from "@nema/shared";
import { AttachmentStore } from "../src/attachments.js";
import type { Db } from "../src/db/db.js";
import { addReportMessage, deliverySet, editUserMessage, getMessage, listMessages, listThreadMessages, mergeReportMeta, postSystemTask, postUserMessage, searchMessages } from "../src/messages.js";
import { ensureThread } from "../src/threads.js";
import { stagedRow, uploadPng } from "./attachmentFixtures.js";
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

test("reads the row for update inside the transaction that writes it", async () => {
  const { db, id } = await report();
  const log: string[] = [];
  const recording = (inner: typeof db, inTx: boolean): typeof db => ({
    query: (sql, params) => {
      log.push(`${inTx ? "tx" : "db"}: ${sql.replace(/\s+/g, " ").trim()}`);
      return inner.query(sql, params);
    },
    tx: (fn) => inner.tx((t) => fn(recording(t, true))),
  });
  await mergeReportMeta(recording(db, false), id, { authors });
  expect(log).toHaveLength(2);
  expect(log[0]).toMatch(/^tx: select meta from messages where id = \$1 and role = 'report' for update$/);
  expect(log[1]).toMatch(/^tx: update messages set meta/);
});

test("a check error does not clear a stored check", async () => {
  const { db, id, meta } = await report();
  const stored = check();
  await mergeReportMeta(db, id, { check: stored, checkError: null, checkSkipped: null });
  await mergeReportMeta(db, id, { check: null, checkError: "daemon offline" });
  const m = await meta();
  expect(m.check).toEqual(stored);
  expect("checkError" in m).toBe(false);
  expect(m.checkHistory ?? []).toEqual([]);
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

describe("messages with attachments", () => {
  const ids = (views: { id: string }[]) => views.map((v) => v.id);
  const bound = async (db: Db, messageId: string) =>
    (await db.query<{ id: string }>("select id from message_attachments where message_id = $1 order by id", [messageId])).map((r) => r.id);
  const counts = async (db: Db, ws: string) => ({
    messages: Number((await db.query<{ n: string }>("select count(*) n from messages where workspace_id = $1", [ws]))[0]!.n),
    tasks: Number((await db.query<{ n: string }>("select count(*) n from tasks where workspace_id = $1", [ws]))[0]!.n),
  });

  test("a message with only attachments can be sent; an empty one cannot", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const a = await uploadPng(db, dataDir, ws.id);
    const { message, task, replayed } = await postUserMessage(db, ws.id, "", { attachmentIds: [a.id] });
    expect(replayed).toBe(false);
    expect(message.content).toBe("");
    expect(message.attachments).toEqual([{ ...a, status: "attached", messageId: message.id }]);
    expect(task.messageId).toBe(message.id);
    await expect(postUserMessage(db, ws.id, "  ", { attachmentIds: [] })).rejects.toMatchObject({ status: 400 });
    await expect(postUserMessage(db, ws.id, "")).rejects.toThrow();
  });

  test("the delivery set over 32 MB or over 8 files is refused with the spec's wording", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const MB = 1024 * 1024;
    const big = [await stagedRow(db, ws.id, "pdf", 17 * MB), await stagedRow(db, ws.id, "pdf", 16 * MB)];
    await expect(postUserMessage(db, ws.id, "x", { attachmentIds: big })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("合计超过 32 MB") });
    // Nothing was bound: both uploads are still unsent.
    expect((await db.query<{ status: string }>("select status from message_attachments where id = any($1)", [big])).map((r) => r.status)).toEqual(["staged", "staged"]);
    expect(await counts(db, ws.id)).toEqual({ messages: 0, tasks: 0 });

    // The quoted message's attachments count too.
    const five = await Promise.all([1, 2, 3, 4, 5].map(() => stagedRow(db, ws.id, "image", 1000)));
    const quoted = await postUserMessage(db, ws.id, "five", { attachmentIds: five });
    const four = await Promise.all([1, 2, 3, 4].map(() => stagedRow(db, ws.id, "image", 1000)));
    await expect(postUserMessage(db, ws.id, "more", { attachmentIds: four, quoteMessageId: quoted.message.id })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("合计超过 32 MB") });
    const three = four.slice(0, 3);
    const ok = await postUserMessage(db, ws.id, "more", { attachmentIds: three, quoteMessageId: quoted.message.id });
    expect(ok.message.attachments).toHaveLength(3);
  });

  test("a retry of the same request returns the original message and task", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const quoted = await postUserMessage(db, ws.id, "q");
    const a = await stagedRow(db, ws.id);
    const b = await stagedRow(db, ws.id);
    const first = await postUserMessage(db, ws.id, "look", { attachmentIds: [a, b], quoteMessageId: quoted.message.id });
    const before = await counts(db, ws.id);
    const again = await postUserMessage(db, ws.id, "look", { attachmentIds: [b, a], quoteMessageId: quoted.message.id });
    expect(again.replayed).toBe(true);
    expect(again.message.id).toBe(first.message.id);
    expect(again.task.id).toBe(first.task.id);
    expect(ids(again.message.attachments).sort()).toEqual([a, b].sort());
    expect(await counts(db, ws.id)).toEqual(before);
  });

  test("a retry that differs in any way is a 409 and changes nothing", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const quoted = await postUserMessage(db, ws.id, "q");
    const anchor = await postUserMessage(db, ws.id, "anchor");
    await ensureThread(db, anchor.message.id, "t", "user");
    const a = await stagedRow(db, ws.id);
    const b = await stagedRow(db, ws.id);
    const first = await postUserMessage(db, ws.id, "look", { attachmentIds: [a, b], quoteMessageId: quoted.message.id });
    const before = await counts(db, ws.id);
    const fresh = await stagedRow(db, ws.id);
    const variants: Parameters<typeof postUserMessage>[3][] = [
      { attachmentIds: [a], quoteMessageId: quoted.message.id },
      { attachmentIds: [a, b, fresh], quoteMessageId: quoted.message.id },
      { attachmentIds: [a, fresh], quoteMessageId: quoted.message.id },
      { attachmentIds: [a, b] },
      { attachmentIds: [a, b], quoteMessageId: anchor.message.id },
      { attachmentIds: [a, b], quoteMessageId: quoted.message.id, threadId: anchor.message.id },
    ];
    for (const v of variants) await expect(postUserMessage(db, ws.id, "look", v)).rejects.toMatchObject({ status: 409 });
    await expect(postUserMessage(db, ws.id, "look again", { attachmentIds: [a, b], quoteMessageId: quoted.message.id })).rejects.toMatchObject({ status: 409 });
    expect(await counts(db, ws.id)).toEqual(before);
    expect(await bound(db, first.message.id)).toEqual([a, b].sort());
    expect((await db.query<{ status: string }>("select status from message_attachments where id = $1", [fresh]))[0]!.status).toBe("staged");
  });

  test("an attachment id from another workspace or an unknown id is a 409", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const other = await createWorkspace(db, dataDir, "Beta");
    const foreign = await stagedRow(db, other.id);
    await expect(postUserMessage(db, ws.id, "x", { attachmentIds: [foreign] })).rejects.toMatchObject({ status: 409 });
    await expect(postUserMessage(db, ws.id, "x", { attachmentIds: ["att_doesnotexist0000"] })).rejects.toMatchObject({ status: 409 });
    expect(await counts(db, ws.id)).toEqual({ messages: 0, tasks: 0 });
  });

  test("the same text sent twice without attachments is two messages", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const one = await postUserMessage(db, ws.id, "same", { attachmentIds: [] });
    const two = await postUserMessage(db, ws.id, "same");
    expect(one.message.id).not.toBe(two.message.id);
    expect(await counts(db, ws.id)).toEqual({ messages: 2, tasks: 2 });
  });

  test("two concurrent sends of one request make one message and one task", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const a = await stagedRow(db, ws.id);
    const b = await stagedRow(db, ws.id);
    const [x, y] = await Promise.all([
      postUserMessage(db, ws.id, "go", { attachmentIds: [a, b] }),
      postUserMessage(db, ws.id, "go", { attachmentIds: [b, a] }),
    ]);
    expect(x.message.id).toBe(y.message.id);
    expect(x.task.id).toBe(y.task.id);
    expect([x.replayed, y.replayed].sort()).toEqual([false, true]);
    expect(await counts(db, ws.id)).toEqual({ messages: 1, tasks: 1 });
  });

  test("the uploads are locked in id order before anything is written", async () => {
    // PGlite runs one transaction at a time, so the race itself needs PostgreSQL; this pins the lock that makes
    // a concurrent duplicate wait and then replay: it must come first, be FOR UPDATE, and be ordered by id.
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const a = await stagedRow(db, ws.id);
    const b = await stagedRow(db, ws.id);
    const log: string[] = [];
    const record = (inner: Db): Db => ({
      query: (sql, params) => { log.push(sql.replace(/\s+/g, " ")); return inner.query(sql, params); },
      tx: (fn) => inner.tx((t) => fn(record(t))),
    });
    await postUserMessage(record(db), ws.id, "go", { attachmentIds: [b, a] });
    const lock = log.findIndex((q) => /from message_attachments where id = any\(\$1\) and workspace_id = \$2 order by id for update/.test(q));
    const insert = log.findIndex((q) => /insert into messages/.test(q));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(insert);
    expect(log.slice(0, lock).some((q) => /insert|update/i.test(q))).toBe(false);
  });

  test("lists carry attachments; messages without any carry []", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const plain = await postUserMessage(db, ws.id, "plain");
    const a = await uploadPng(db, dataDir, ws.id);
    const withFile = await postUserMessage(db, ws.id, "pic", { attachmentIds: [a.id] });
    await ensureThread(db, plain.message.id, "t", "user");
    const b = await uploadPng(db, dataDir, ws.id);
    const reply = await postUserMessage(db, ws.id, "", { attachmentIds: [b.id], threadId: plain.message.id });
    const main = await listMessages(db, ws.id);
    expect(main.find((m) => m.id === plain.message.id)!.attachments).toEqual([]);
    expect(ids(main.find((m) => m.id === withFile.message.id)!.attachments)).toEqual([a.id]);
    expect(ids((await listThreadMessages(db, plain.message.id)).find((m) => m.id === reply.message.id)!.attachments)).toEqual([b.id]);
    expect(ids((await getMessage(db, withFile.message.id))!.attachments)).toEqual([a.id]);
    expect((await searchMessages(db, ws.id, "pic"))[0]!.attachments.map((v) => v.id)).toEqual([a.id]);
  });

  test("deliverySet: this message, then the quoted one, then the thread anchor, once each, without deleted files", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const [p, q, r, s] = await Promise.all([1, 2, 3, 4].map(() => stagedRow(db, ws.id, "image", 100)));
    const anchor = await postUserMessage(db, ws.id, "anchor", { attachmentIds: [p] });
    await ensureThread(db, anchor.message.id, "t", "user");
    const quoted = await postUserMessage(db, ws.id, "quoted", { attachmentIds: [q, s], threadId: anchor.message.id });
    await new AttachmentStore(db, dataDir).remove(ws.id, s);
    const reply = await postUserMessage(db, ws.id, "", { attachmentIds: [r], threadId: anchor.message.id, quoteMessageId: quoted.message.id });
    const set = await deliverySet(db, reply.task.id);
    expect(set.map((x) => x.id)).toEqual([r, q, p]);
    expect(set.map((x) => x.messageId)).toEqual([reply.message.id, quoted.message.id, anchor.message.id]);
    for (const ref of set) expect(AttachmentRefSchema.parse(ref)).toEqual(ref);
    // Quoting the anchor itself does not deliver its files twice.
    const t = await stagedRow(db, ws.id, "image", 100);
    const again = await postUserMessage(db, ws.id, "x", { attachmentIds: [t], threadId: anchor.message.id, quoteMessageId: anchor.message.id });
    expect((await deliverySet(db, again.task.id)).map((x) => x.id)).toEqual([t, p]);
    const textOnly = await postUserMessage(db, ws.id, "no files");
    expect(await deliverySet(db, textOnly.task.id)).toEqual([]);
  });

  test("a blank edit needs a file that can still be delivered; a missing file does not count", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const a = await stagedRow(db, ws.id);
    const sent = await postUserMessage(db, ws.id, "caption", { attachmentIds: [a] });
    await db.query("update tasks set status = 'done' where workspace_id = $1", [ws.id]);
    await db.query("update message_attachments set status = 'missing' where id = $1", [a]);
    await expect(editUserMessage(db, ws.id, sent.message.id, "")).rejects.toMatchObject({ status: 400 });
    expect((await getMessage(db, sent.message.id))!.content).toBe("caption");
  });

  test("a blank edit locks the message's files while it checks them", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const a = await stagedRow(db, ws.id);
    const sent = await postUserMessage(db, ws.id, "caption", { attachmentIds: [a] });
    await db.query("update tasks set status = 'done' where workspace_id = $1", [ws.id]);
    const log: string[] = [];
    const record = (inner: Db): Db => ({
      query: (sql, params) => { log.push(sql.replace(/\s+/g, " ")); return inner.query(sql, params); },
      tx: (fn) => inner.tx((t) => fn(record(t))),
    });
    await editUserMessage(record(db), ws.id, sent.message.id, "");
    const lock = log.findIndex((q) => /from message_attachments where message_id = \$1 .*for update/.test(q));
    const update = log.findIndex((q) => /update messages set content/.test(q));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(update);
  });

  test("an edit runs on the account the original message ran on", async () => {
    // The edit is the same request with new text. Leaving account_id null would let it run on whatever the
    // workspace defaults to now, which is a different account and possibly a different bill.
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const sent = await postUserMessage(db, ws.id, "first try", { accountId: "acct_aaaaaaaaaa" });
    expect(sent.task.accountId).toBe("acct_aaaaaaaaaa");
    await db.query("update tasks set status = 'done' where workspace_id = $1", [ws.id]);
    const edited = await editUserMessage(db, ws.id, sent.message.id, "second try");
    expect(edited.task.accountId).toBe("acct_aaaaaaaaaa");
    expect(edited.task.kind).toBe("edit");
  });

  test("a retry with a different routing choice is a 409, and the same choice replays", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const plainFile = await stagedRow(db, ws.id);
    const autoFile = await stagedRow(db, ws.id);
    const plain = await postUserMessage(db, ws.id, "look", { attachmentIds: [plainFile] });
    const before = await counts(db, ws.id);
    await expect(
      postUserMessage(db, ws.id, "look", { attachmentIds: [plainFile], routing: "auto" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await counts(db, ws.id)).toEqual(before);
    expect(plain.task.routing).toBeNull();

    const auto = await postUserMessage(db, ws.id, "look", { attachmentIds: [autoFile], routing: "auto" });
    const again = await postUserMessage(db, ws.id, "look", { attachmentIds: [autoFile], routing: "auto" });
    expect(again.replayed).toBe(true);
    expect(again.task.id).toBe(auto.task.id);
    expect(again.task.routing).toBe("auto");
  });

  test("a retry that names a different account is a 409, not a replay of the earlier task", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const a = await stagedRow(db, ws.id);
    const first = await postUserMessage(db, ws.id, "look", { attachmentIds: [a], accountId: "acct_aaaaaaaaaa" });
    const before = await counts(db, ws.id);
    await expect(
      postUserMessage(db, ws.id, "look", { attachmentIds: [a], accountId: "acct_bbbbbbbbbb" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await counts(db, ws.id)).toEqual(before);
    expect(first.task.accountId).toBe("acct_aaaaaaaaaa");
  });

  test("editing keeps the attachments and allows empty text only when there are some", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const a = await stagedRow(db, ws.id);
    const withFile = await postUserMessage(db, ws.id, "text", { attachmentIds: [a] });
    const plain = await postUserMessage(db, ws.id, "text");
    await db.query("update tasks set status = 'done' where workspace_id = $1", [ws.id]);
    const edited = await editUserMessage(db, ws.id, withFile.message.id, "");
    expect(edited.message.content).toBe("");
    expect(ids(edited.message.attachments)).toEqual([a]);
    await expect(editUserMessage(db, ws.id, plain.message.id, " ")).rejects.toMatchObject({ status: 400 });
  });
});
