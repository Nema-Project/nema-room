import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import { stagedRow, uploadPng } from "./attachmentFixtures.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace } from "../src/workspaces.js";
import { addMessage, addReportMessage, postUserMessage } from "../src/messages.js";
import { claimNextTask, finishTask, recordTaskChange } from "../src/tasks.js";
import { EventBus } from "../src/events.js";
import { indexEntry } from "../src/entryIndex.js";
import { KnowledgeStore, git } from "@nema/knowledge";
import { repoPath } from "../src/workspaces.js";
import { createApp } from "../src/app.js";
import type { Hono } from "hono";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { getLastAskedQuestion, getQuestionThread } from "../src/threads.js";

let db: Db;
let dataDir: string;
let ws: string;
let events: EventBus;
let app: Hono<any>;
let nemaHome: string;
const homes: string[] = [];
// The hub only answers to its own loopback Host; app.request() derives Host from the URL.
const HUB = "http://127.0.0.1:4400";
const daemon = { call: (): Promise<unknown> => Promise.reject(new Error("daemon 未连接")) };

beforeEach(async () => {
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  events = new EventBus();
  ws = (await createWorkspace(db, dataDir, "A")).id;
  nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
  homes.push(nemaHome);
  app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon, webOrigin: "http://localhost:3000" });
});
afterAll(async () => {
  await cleanupHubDeps();
  await Promise.all(homes.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(`${HUB}${p}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const json = async (r: Response) => (await r.json()) as any;

async function agentEntry(input: Record<string, unknown>, taskId: string) {
  const store = new KnowledgeStore(repoPath(dataDir, ws));
  const r = await store.upsert({ body: "b", reason: "r", sourceMessages: [], ...input } as any, { author: "agent", taskId });
  await indexEntry(db, ws, r.entry);
  await recordTaskChange(db, taskId, { entryId: r.entry.id, kind: r.entry.kind, title: r.entry.title, op: r.op });
  return r.entry;
}
async function legacyQuestion() {
  const store = new KnowledgeStore(repoPath(dataDir, ws));
  const r = await store.upsert({ kind: "question", title: "legacy", body: "Need a choice", sourceMessages: [], reason: "r", priority: 1 }, { author: "agent" });
  await indexEntry(db, ws, r.entry);
  return r.entry;
}
async function doneTask(fn: (taskId: string) => Promise<void>) {
  await postUserMessage(db, ws, "memo");
  const t = (await claimNextTask(db, "d1"))!;
  await fn(t.id);
  await finishTask(db, t.id, { ok: true });
}

describe("ui api", () => {
  test("slash thread creates anchor, thread and task in one go", async () => {
    const seen: string[] = [];
    events.subscribe(ws, (e) => seen.push(e.type));
    const r = await req("POST", `/api/workspaces/${ws}/threads`, { content: "主题一\nsecond" });
    expect(r.status).toBe(200);
    const result = await json(r);
    expect(result.message.role).toBe("user");
    expect(result.thread).toMatchObject({ id: result.message.id, title: "主题一", openedBy: "user" });
    expect(result.task.messageId).toBe(result.message.id);
    expect(seen).toContain("message.created");
    expect((await json(await req("GET", `/api/workspaces/${ws}/messages`))).map((m: any) => m.id)).toContain(result.message.id);
    expect(await json(await req("GET", `/api/workspaces/${ws}/threads`))).toHaveLength(1);
  });

  test("message resolver returns main and thread messages and rejects foreign ids", async () => {
    const main = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "main" }));
    const thread = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "thread" }));
    const reply = await json(await req("POST", `/api/workspaces/${ws}/threads/${thread.thread.id}/messages`, { content: "reply" }));
    const resolvedMain = await json(await req("GET", `/api/workspaces/${ws}/messages/${main.message.id}`));
    const resolvedReply = await json(await req("GET", `/api/workspaces/${ws}/messages/${reply.message.id}`));
    expect(resolvedMain).toMatchObject({ threadId: null, seq: expect.any(Number) });
    expect(resolvedReply).toMatchObject({ threadId: thread.thread.id, seq: reply.message.seq });
    const rendered = await json(await req("GET", `/api/workspaces/${ws}/threads/${thread.thread.id}/messages`));
    expect(rendered.messages.at(-1).seq).toBe(resolvedReply.seq);
    const other = await json(await req("POST", "/api/workspaces", { name: "Other" }));
    expect((await req("GET", `/api/workspaces/${other.id}/messages/${reply.message.id}`)).status).toBe(404);
  });

  test("thread post in archived workspace is 409 and foreign thread is 400", async () => {
    const created = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "thread" }));
    const other = await json(await req("POST", "/api/workspaces", { name: "Other" }));
    expect((await req("POST", `/api/workspaces/${ws}/threads/${created.thread.id}/messages`, { content: "foreign" })).status).toBe(200);
    expect((await req("POST", `/api/workspaces/${other.id}/threads/${created.thread.id}/messages`, { content: "foreign" })).status).toBe(400);
    await req("PATCH", `/api/workspaces/${ws}`, { archived: true });
    expect((await req("POST", `/api/workspaces/${ws}/threads`, { content: "no" })).status).toBe(409);
    expect((await req("POST", `/api/workspaces/${ws}/threads/${created.thread.id}/messages`, { content: "no" })).status).toBe(409);
  });

  test("read acknowledges only the rendered thread sequence", async () => {
    const opened = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "subject" }));
    const reply = await json(await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/messages`, { content: "reply" }));
    const rendered = await json(await req("GET", `/api/workspaces/${ws}/threads/${opened.thread.id}/messages`));
    const throughSeq = rendered.messages.at(-1).seq;
    const seen: string[] = [];
    events.subscribe(ws, (e) => seen.push(e.type));
    expect((await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/read`, { throughSeq })).status).toBe(204);
    expect(seen).toContain("thread.updated");
    expect(rendered.messages.map((m: any) => m.id)).toContain(reply.message.id);
    const later = await json(await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/messages`, { content: "later" }));
    const list = await json(await req("GET", `/api/workspaces/${ws}/threads`));
    expect(list.find((t: any) => t.id === opened.thread.id).unread).toBe(1);
    const bad = await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/read`, { throughSeq: 999999 });
    expect(bad.status).toBe(400);
    expect(later.message.threadId).toBe(opened.thread.id);
    const otherThread = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "other" }));
    const foreignSeq = (await db.query<{ seq: number }>("select seq from messages where id=$1", [otherThread.message.id]))[0]!.seq;
    expect((await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/read`, { throughSeq: foreignSeq })).status).toBe(400);
    const other = await json(await req("POST", "/api/workspaces", { name: "Other" }));
    expect((await req("POST", `/api/workspaces/${other.id}/threads/${opened.thread.id}/read`, { throughSeq })).status).toBe(400);
  });

  test("attention counts unread threads and legacy questions and converts legacy questions", async () => {
    const opened = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "subject" }));
    await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/messages`, { content: "unread" });
    const q = await legacyQuestion();
    const list = await json(await req("GET", "/api/workspaces"));
    expect(list.find((w: any) => w.id === ws).attention).toBe(2);
    const replySeq = (await db.query<{ seq: number }>("select seq from messages where thread_id=$1 order by seq desc limit 1", [opened.thread.id]))[0]!.seq;
    await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/read`, { throughSeq: replySeq });
    const converted = await json(await req("GET", `/api/workspaces/${ws}/attention/next`));
    expect(converted.threadId).toBeTruthy();
    const mapping = await db.query("select 1 from question_threads where workspace_id=$1 and question_id=$2", [ws, q.id]);
    expect(mapping).toHaveLength(1);
    expect(await getLastAskedQuestion(db, ws, converted.threadId)).toEqual({ id: q.id, title: q.title, body: q.body });
    const again = await json(await req("GET", `/api/workspaces/${ws}/attention/next`));
    expect(again.threadId).toBe(converted.threadId); // its card is unread; the question is no longer counted separately
  });

  test("empty legacy history gets one system anchor and repeated conversion returns it", async () => {
    const q = await legacyQuestion();
    const a = await Promise.all([req("GET", `/api/workspaces/${ws}/attention/next`), req("GET", `/api/workspaces/${ws}/attention/next`)]);
    const ids = await Promise.all(a.map(async (r) => (await json(r)).threadId));
    expect(ids[0]).toBe(ids[1]);
    const thread = await db.query<{ n: number }>("select count(*)::int n from threads where workspace_id=$1", [ws]);
    const cards = await db.query("select 1 from messages where workspace_id=$1 and role='system' and meta->'askedQuestion'->>'id'=$2", [ws, q.id]);
    expect(thread[0]!.n).toBe(1);
    expect(cards).toHaveLength(1);
    const anchor = await db.query<{ role: string; task_id: string | null }>("select role,task_id from messages where id=$1", [ids[0]]);
    expect(anchor[0]).toEqual({ role: "system", task_id: null });
  });

  test("legacy conversion explicitly associates a question whose original task is not on its source anchor", async () => {
    const originalTask = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "original task" }));
    const task = (await claimNextTask(db, "d1"))!;
    const source = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "question source" }));
    const question = await agentEntry({ kind: "question", title: "legacy source", body: "body", priority: 1, sourceMessages: [source.message.id] }, task.id);
    await finishTask(db, task.id, { ok: true });
    const result = await json(await req("GET", `/api/workspaces/${ws}/attention/next`));
    expect(originalTask.message.id).not.toBe(result.threadId);
    expect(result.threadId).toBe(source.message.id);
    expect(await db.query("select 1 from question_threads where workspace_id=$1 and question_id=$2 and thread_id=$3", [ws, question.id, source.message.id])).toHaveLength(1);
    expect(await getQuestionThread(db, ws, question.id)).toBe(source.message.id);
  });

  test("question opened inside a thread is not legacy attention", async () => {
    const opened = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "topic" }));
    const task = await claimNextTask(db, "d1");
    await agentEntry({ kind: "question", title: "thread question", body: "body", priority: 1 }, task!.id);
    expect((await json(await req("GET", "/api/workspaces"))).find((w: any) => w.id === ws).attention).toBe(0);
    expect(await getLastAskedQuestion(db, ws, opened.thread.id)).toBeNull();
  });

  test("mixed unread threads and legacy questions are ordered oldest first and empty attention returns null", async () => {
    expect(await json(await req("GET", `/api/workspaces/${ws}/attention/next`))).toBeNull();
    const q = await legacyQuestion();
    const opened = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "newer" }));
    await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/messages`, { content: "unread" });
    const next = await json(await req("GET", `/api/workspaces/${ws}/attention/next`));
    expect(next.threadId).toBe(opened.thread.id);
    expect(await getLastAskedQuestion(db, ws, next.threadId)).toMatchObject({ id: q.id });
  });

  test("reindexing an older legacy question does not move it behind a newer unread reply", async () => {
    const q = await legacyQuestion();
    const opened = await json(await req("POST", `/api/workspaces/${ws}/threads`, { content: "newer thread" }));
    await req("POST", `/api/workspaces/${ws}/threads/${opened.thread.id}/messages`, { content: "newer unread reply" });
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const edited = await store.upsert({ kind: "question", id: q.id, title: q.title, body: "edited body", sourceMessages: [], reason: "edit", priority: q.priority }, { author: "user" });
    await indexEntry(db, ws, edited.entry);
    const next = await json(await req("GET", `/api/workspaces/${ws}/attention/next`));
    expect(await getLastAskedQuestion(db, ws, next.threadId)).toMatchObject({ id: q.id, body: "edited body" });
  });

  test("withdrawn question no longer counts as attention", async () => {
    const q = await legacyQuestion();
    const r = await req("POST", `/api/workspaces/${ws}/entries/${q.id}/withdraw`);
    expect(r.status).toBe(200);
    expect((await json(r)).status).toBe("dropped");
    const list = await json(await req("GET", "/api/workspaces"));
    expect(list.find((w: any) => w.id === ws).attention).toBe(0);
  });

  test("post message returns queued task, messages listed, events emitted", async () => {
    const seen: string[] = [];
    events.subscribe(ws, (e) => seen.push(e.type));
    const r = await req("POST", `/api/workspaces/${ws}/messages`, { content: "hello" });
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.task.status).toBe("queued");
    expect(b.task).not.toHaveProperty("runToken");
    expect(b.task).not.toHaveProperty("daemonId");
    expect(seen).toEqual(["message.created", "task.updated"]);
    const list = await json(await req("GET", `/api/workspaces/${ws}/messages`));
    expect(list.map((m: any) => m.id)).toContain(b.message.id);
    expect((await req("POST", `/api/workspaces/${ws}/messages`, { content: "  " })).status).toBe(400);
  });

  test("a quote must be a message in this workspace", async () => {
    const first = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "alpha beta" }));
    const other = await json(await req("POST", "/api/workspaces", { name: "B" }));
    const foreign = await json(await req("POST", `/api/workspaces/${other.id}/messages`, { content: "secret" }));
    const bad = await req("POST", `/api/workspaces/${ws}/messages`, { content: "about it", quoteMessageId: foreign.message.id });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("quote: message not in this workspace");
    const ok = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "about it", quoteMessageId: first.message.id }));
    expect(ok.message.meta.quote).toEqual({ messageId: first.message.id, role: "user", excerpt: "alpha beta" });
    const long = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "long", quoteMessageId: (await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "你".repeat(250) }))).message.id }));
    expect(long.message.meta.quote.excerpt).toHaveLength(200);
    const system = await addMessage(db, ws, "system", "draw the diagram");
    const quotedSystem = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "about the diagram", quoteMessageId: system.id }));
    expect(quotedSystem.message.meta.quote.role).toBe("system");
  });

  test("editing keeps the previous text, queues an edit task, and blocks while that task is open", async () => {
    const posted = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "original" }));
    const id = posted.message.id as string;
    const busy = await req("PATCH", `/api/workspaces/${ws}/messages/${id}`, { content: "revised" });
    expect(busy.status).toBe(409);
    expect((await json(busy)).error).toBe("message is still being processed");
    expect((await json(await req("GET", `/api/workspaces/${ws}/messages`))).find((m: { id: string }) => m.id === id).content).toBe("original");

    const original = (await claimNextTask(db, "d1"))!;
    await finishTask(db, original.id, { ok: true });
    const seen: string[] = [];
    events.subscribe(ws, (e) => seen.push(e.type));
    const edited = await json(await req("PATCH", `/api/workspaces/${ws}/messages/${id}`, { content: "revised" }));
    expect(edited.message.content).toBe("revised");
    expect(typeof edited.message.editedAt).toBe("string");
    expect(edited.task.status).toBe("queued");
    expect(edited.task).not.toHaveProperty("kind");
    expect(seen).toEqual(["message.updated", "task.updated"]);
    const versions = await json(await req("GET", `/api/workspaces/${ws}/messages/${id}/versions`));
    expect(versions).toEqual([{ version: 1, content: "original", createdAt: expect.any(String) }]);

    const editTask = (await claimNextTask(db, "d1"))!;
    await finishTask(db, editTask.id, { ok: true });
    expect((await req("PATCH", `/api/workspaces/${ws}/messages/${id}`, { content: "third" })).status).toBe(200);
    const again = await json(await req("GET", `/api/workspaces/${ws}/messages/${id}/versions`));
    expect(again.map((v: { content: string }) => v.content)).toEqual(["original", "revised"]);

    const agent = await addMessage(db, ws, "agent", "summary");
    const notUser = await req("PATCH", `/api/workspaces/${ws}/messages/${agent.id}`, { content: "nope" });
    expect(notUser.status).toBe(400);
    expect((await json(notUser)).error).toBe("only user messages can be edited");

    const third = (await claimNextTask(db, "d1"))!;
    await finishTask(db, third.id, { ok: true });
    expect((await req("PATCH", `/api/workspaces/${ws}/messages/${id}`, { content: "   " })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${ws}`, { archived: true })).status).toBe(200);
    const archived = await req("PATCH", `/api/workspaces/${ws}/messages/${id}`, { content: "later" });
    expect(archived.status).toBe(409);
    expect((await json(archived)).error).toMatch(/archived/);

    expect((await req("PATCH", `/api/workspaces/${ws}`, { archived: false })).status).toBe(200);
    expect((await req("DELETE", `/api/workspaces/${ws}`)).status).toBe(204);
    expect(await db.query("select 1 from message_versions where message_id = $1", [id])).toHaveLength(0);
  });

  test("search matches the current text only, literally, newest first", async () => {
    const post = async (content: string) => {
      const created = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content }));
      const task = (await claimNextTask(db, "d1"))!;
      await finishTask(db, task.id, { ok: true });
      return created.message.id as string;
    };
    const a = await post("100% done");
    const b = await post("100% done too");
    const renamed = await post("100% later");
    expect((await req("PATCH", `/api/workspaces/${ws}/messages/${renamed}`, { content: "renamed" })).status).toBe(200);
    const ids = async (q: string) =>
      (await json(await req("GET", `/api/workspaces/${ws}/messages/search?q=${encodeURIComponent(q)}`))).map((m: { id: string }) => m.id);
    expect(await ids("100%")).toEqual([b, a]);
    expect(await ids("%")).toEqual([b, a]);
    expect(await ids("_")).toEqual([]);
    expect(await ids(" ")).toEqual([]);
  });

  test("workspaces create/patch/validation", async () => {
    const c = await json(await req("POST", "/api/workspaces", { name: "New" }));
    expect(c.name).toBe("New");
    expect((await req("POST", "/api/workspaces", { name: " " })).status).toBe(400);
    const p = await req("PATCH", `/api/workspaces/${ws}`, { knowledgeLanguage: "en" });
    expect((await json(p)).knowledgeLanguage).toBe("en");
    expect((await req("PATCH", `/api/workspaces/${ws}`, { knowledgeLanguage: "xx" })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/ws_nope`, { name: "x" })).status).toBe(404);
  });

  test("preflight allows DELETE from the web origin", async () => {
    const r = await app.request(`${HUB}/api/workspaces/ws_x`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:3000", "access-control-request-method": "DELETE" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  test("archive and delete workspaces", async () => {
    expect((await req("DELETE", "/api/workspaces/ws_missing0001")).status).toBe(404);
    expect((await req("DELETE", "/api/workspaces/not-a-workspace")).status).toBe(400);

    await postUserMessage(db, ws, "memo");
    const running = (await claimNextTask(db, "d1"))!;
    const busyPatch = await req("PATCH", `/api/workspaces/${ws}`, { archived: true });
    expect(busyPatch.status).toBe(409);
    expect((await json(busyPatch)).error).toBe("workspace is busy");
    const busyDelete = await req("DELETE", `/api/workspaces/${ws}`);
    expect(busyDelete.status).toBe(409);
    expect((await json(busyDelete)).error).toBe("workspace is busy");
    await finishTask(db, running.id, { ok: true });

    const parked = await json(await req("POST", "/api/workspaces", { name: "Parked" }));
    expect((await req("PATCH", `/api/workspaces/${parked.id}`, { archived: true })).status).toBe(200);
    const list = await json(await req("GET", "/api/workspaces"));
    expect(list.find((w: { id: string }) => w.id === parked.id).archived).toBe(true);

    const gone = await json(await req("POST", "/api/workspaces", { name: "Gone" }));
    const isolation = path.join(nemaHome, "ws", gone.id, "codex-home");
    mkdirSync(isolation, { recursive: true });
    const deleted: string[] = [];
    events.subscribeAll((_w, e) => e.type === "workspace.deleted" && deleted.push(e.workspaceId));
    expect((await req("DELETE", `/api/workspaces/${gone.id}`)).status).toBe(204);
    expect(deleted).toEqual([gone.id]);
    expect(existsSync(path.join(nemaHome, "ws", gone.id))).toBe(false);
    expect((await req("DELETE", `/api/workspaces/${gone.id}`)).status).toBe(404);
  });

  test("queued tasks do not block archive/delete; archived workspace rejects messages; unarchive re-announces queued", async () => {
    const queued = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "pending" }));
    expect(queued.task.status).toBe("queued");
    expect((await req("PATCH", `/api/workspaces/${ws}`, { archived: true })).status).toBe(200);
    const rejected = await req("POST", `/api/workspaces/${ws}/messages`, { content: "more" });
    expect(rejected.status).toBe(409);
    expect((await json(rejected)).error).toMatch(/archived/);
    const seen: Array<{ type: string; id?: string; status?: string }> = [];
    events.subscribe(ws, (e) => e.type === "task.updated" && seen.push({ type: e.type, id: e.task.id, status: e.task.status }));
    expect((await req("PATCH", `/api/workspaces/${ws}`, { archived: false })).status).toBe(200);
    expect(seen).toEqual([{ type: "task.updated", id: queued.task.id, status: "queued" }]);

    const other = await json(await req("POST", "/api/workspaces", { name: "Other" }));
    const q2 = await json(await req("POST", `/api/workspaces/${other.id}/messages`, { content: "x" }));
    expect((await req("DELETE", `/api/workspaces/${other.id}`)).status).toBe(204);
    expect(await db.query("select 1 from tasks where id = $1", [q2.task.id])).toHaveLength(0);
  });

  test("attention counts unassociated open questions", async () => {
    await doneTask(async (t) => {
      await agentEntry({ kind: "question", title: "Q1", priority: 1 }, t);
      await agentEntry({ kind: "question", title: "Q2", priority: 2 }, t);
      await agentEntry({ kind: "requirement", title: "R" }, t);
    });
    const list = await json(await req("GET", "/api/workspaces"));
    expect(list.find((w: any) => w.id === ws).attention).toBe(2);
  });

  test("user PUT edit: author user, reason required", async () => {
    let id = "";
    await doneTask(async (t) => void (id = (await agentEntry({ kind: "requirement", title: "R" }, t)).id));
    const seen: string[] = [];
    events.subscribe(ws, (e) => seen.push(e.type));
    const ok = await req("PUT", `/api/workspaces/${ws}/entries/${id}`, { kind: "requirement", title: "R2", body: "new", reason: "fix" });
    expect(ok.status).toBe(200);
    expect(seen).toContain("knowledge.changed");
    const h = await json(await req("GET", `/api/workspaces/${ws}/entries/${id}/history`));
    expect(h[0].author).toBe("user");
    expect(h).toHaveLength(2);
    const e = await json(await req("GET", `/api/workspaces/${ws}/entries/${id}`));
    expect(e.title).toBe("R2");
    const v = await json(await req("GET", `/api/workspaces/${ws}/entries/${id}/versions/${h[1].commit}`));
    expect(v.title).toBe("R");
    const why = await json(await req("GET", `/api/workspaces/${ws}/entries/${id}/why`));
    expect(Array.isArray(why)).toBe(true);
    const bad = await req("PUT", `/api/workspaces/${ws}/entries/${id}`, { kind: "requirement", title: "R3", body: "x" });
    expect(bad.status).toBe(400);
    expect((await req("PUT", `/api/workspaces/${ws}/entries/R-99`, { kind: "requirement", title: "x", body: "x", reason: "r" })).status).toBe(404);
    expect((await req("GET", `/api/workspaces/${ws}/entries/R-99`)).status).toBe(404);
    expect((await req("GET", `/api/workspaces/${ws}/entries/${id}/versions/deadbeef`)).status).toBe(404);
  });

  test("isNew follows the most recent done task", async () => {
    let r1 = "";
    let d1 = "";
    await doneTask(async (t) => void (d1 = (await agentEntry({ kind: "decision", title: "D" }, t)).id));
    await doneTask(async (t) => {
      r1 = (await agentEntry({ kind: "requirement", title: "R" }, t)).id;
      await agentEntry({ id: d1, kind: "decision", title: "D v2" }, t);
    });
    const flags = async () =>
      Object.fromEntries((await json(await req("GET", `/api/workspaces/${ws}/entries`))).map((e: any) => [e.id, e.isNew]));
    expect(await flags()).toEqual({ [r1]: true, [d1]: false });
    await doneTask(async (t) => void (await agentEntry({ id: d1, kind: "decision", title: "D v3" }, t)));
    expect(await flags()).toEqual({ [r1]: false, [d1]: false });
    const tl = await json(await req("GET", `/api/workspaces/${ws}/timeline`));
    expect(tl).toHaveLength(2);
  });

  test("tasks/active returns the running task or null", async () => {
    expect(await json(await req("GET", `/api/workspaces/${ws}/tasks/active`))).toEqual({ running: null, indexing: [] });
    await postUserMessage(db, ws, "memo");
    expect(await json(await req("GET", `/api/workspaces/${ws}/tasks/active`))).toEqual({ running: null, indexing: [] }); // queued only
    const t = (await claimNextTask(db, "d1"))!;
    const r = await json(await req("GET", `/api/workspaces/${ws}/tasks/active`));
    expect(r.running.id).toBe(t.id);
    expect(r.running.status).toBe("running");
    expect(r.running).not.toHaveProperty("runToken");
    expect(r.running).not.toHaveProperty("daemonId");
    expect(JSON.stringify(r)).not.toContain(t.runToken!);
    await finishTask(db, t.id, { ok: true });
    expect(await json(await req("GET", `/api/workspaces/${ws}/tasks/active`))).toEqual({ running: null, indexing: [] });
  });

  test("unknown workspace → 404", async () => {
    for (const p of ["messages", "tasks/active", "entries", "timeline", "entries/R-1", "events"])
      expect((await req("GET", `/api/workspaces/ws_nope/${p}`)).status).toBe(404);
    expect((await req("POST", `/api/workspaces/ws_nope/messages`, { content: "x" })).status).toBe(404);
  });

  test("daemon status", async () => {
    expect(await json(await req("GET", "/api/daemon/status"))).toEqual({ connected: true });
  });

  test("SSE delivers message.created and global events, cleans up on abort", async () => {
    const ac = new AbortController();
    const res = await app.request(`${HUB}/api/workspaces/${ws}/events`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (needle: string) => {
      const deadline = Date.now() + 3000;
      while (!buf.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle}; got ${buf}`);
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${needle}; got ${buf}`)), 3000)),
        ]);
        if (done) break;
        buf += dec.decode(value);
      }
    };
    await req("POST", `/api/workspaces/${ws}/messages`, { content: "hi sse" });
    await until("message.created");
    await until("task.updated");
    expect(buf).toContain("data: ");
    expect(buf).not.toMatch(/runToken|daemonId/);
    events.emitGlobal({ type: "daemon.status", connected: false });
    await until("daemon.status");
    ac.abort();
    await reader.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect((events as any).byWs.size).toBe(0);
    expect((events as any).all.size).toBe(0);
  });

  test("rejects a foreign Host (DNS rebinding) with 403 on /api and /room", async () => {
    for (const host of ["evil.example:4400", "evil.example", "127.0.0.1:4401", "localhost"]) {
      const r = await req("GET", "/api/workspaces", undefined, { host });
      expect(r.status, host).toBe(403);
      expect((await req("POST", `/api/workspaces/${ws}/messages`, { content: "x" }, { host })).status).toBe(403);
      expect((await app.request(`${HUB}/room/entries`, { headers: { host } })).status).toBe(403);
    }
    expect((await app.request(`http://evil.example:4400/api/workspaces`)).status).toBe(403);
    for (const host of ["127.0.0.1:4400", "localhost:4400", "LOCALHOST:4400"])
      expect((await req("GET", "/api/workspaces", undefined, { host })).status, host).toBe(200);
    expect((await app.request(`http://localhost:4400/api/workspaces`)).status).toBe(200);
    // /room keeps its own auth once the Host is fine.
    expect((await app.request(`${HUB}/room/entries`)).status).toBe(401);
    const onOtherPort = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon, port: 5511 });
    expect((await onOtherPort.request("http://127.0.0.1:5511/api/workspaces")).status).toBe(200);
    expect((await onOtherPort.request(`${HUB}/api/workspaces`)).status).toBe(403);
  });

  test("POST/PUT/PATCH under /api require content-type application/json (415)", async () => {
    const plain = await app.request(`${HUB}/api/workspaces/${ws}/messages`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ content: "csrf" }),
    });
    expect(plain.status).toBe(415);
    const none = await app.request(`${HUB}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "x" }) });
    expect(none.status).toBe(415);
    const form = await app.request(`${HUB}/api/workspaces/${ws}`, {
      method: "PATCH",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "archived=true",
    });
    expect(form.status).toBe(415);
    expect((await json(await req("GET", `/api/workspaces/${ws}/messages`)))).toEqual([]);
    const ok = await req("POST", "/api/workspaces", { name: "ok" }, { "content-type": "application/json; charset=utf-8" });
    expect(ok.status).toBe(200);
    // DELETE carries no body and needs no content-type.
    const del = await app.request(`${HUB}/api/workspaces/${(await json(ok)).id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
  });

  test("CORS only for webOrigin", async () => {
    const evil = await req("GET", "/api/workspaces", undefined, { Origin: "http://evil.example" });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await req("GET", "/api/workspaces", undefined, { Origin: "http://localhost:3000" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });

  const SEEDED_AT = "2020-01-01T00:00:00.000Z";

  async function inferredEntry(input: Record<string, unknown>) {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const r = await store.upsert(
      { body: "b", reason: "r", sourceMessages: [], basis: "inferred", ...input } as any,
      { author: "agent", now: new Date(SEEDED_AT) },
    );
    return r.entry;
  }

  test("a user edit of an inferred decision becomes decided and refreshes confirmedAt", async () => {
    const e = await inferredEntry({ kind: "decision", title: "D" });
    expect(e.basis).toBe("inferred");
    expect(e.confirmedAt).toBe(SEEDED_AT);
    const ok = await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, {
      kind: "decision",
      title: "D",
      body: "edited",
      reason: "user edit",
      basis: "inferred",
      confirmed: false,
    });
    expect(ok.status).toBe(200);
    const saved = await json(ok);
    expect(saved.basis).toBe("decided");
    expect(saved.ingestedAt).toBe(SEEDED_AT);
    expect(Date.parse(saved.confirmedAt)).toBeGreaterThan(Date.parse(SEEDED_AT));
    const got = await json(await req("GET", `/api/workspaces/${ws}/entries/${e.id}`));
    expect(got.basis).toBe("decided");
    expect(got.confirmedAt).toBe(saved.confirmedAt);
  });

  test("a user edit of an inferred requirement becomes stated", async () => {
    const e = await inferredEntry({ kind: "requirement", title: "R" });
    const ok = await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, {
      kind: "requirement",
      title: "R",
      body: "edited",
      reason: "user edit",
      basis: "decided",
      confirmed: false,
    });
    expect(ok.status).toBe(200);
    const saved = await json(ok);
    expect(saved.basis).toBe("stated");
    expect(saved.ingestedAt).toBe(SEEDED_AT);
    expect(Date.parse(saved.confirmedAt)).toBeGreaterThan(Date.parse(SEEDED_AT));
  });

  test("confirm marks an inferred source stated and sets confirmedAt; history shows author user and reason 用户确认仍然有效", async () => {
    const e = await inferredEntry({ kind: "source", title: "S", url: "https://example.com/s" });
    expect(await db.query("select 1 from entry_index where workspace_id = $1 and entry_id = $2", [ws, e.id])).toHaveLength(0);
    const seen: Array<{ type: string; entryId: string }> = [];
    events.subscribe(ws, (ev) => {
      if (ev.type === "knowledge.changed") seen.push({ type: ev.type, entryId: ev.entryId });
    });
    const ok = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect(ok.status).toBe(200);
    const saved = await json(ok);
    expect(saved.basis).toBe("stated");
    expect(saved.ingestedAt).toBe(SEEDED_AT);
    expect(Date.parse(saved.confirmedAt)).toBeGreaterThan(Date.parse(SEEDED_AT));
    const h = await json(await req("GET", `/api/workspaces/${ws}/entries/${e.id}/history`));
    expect(h[0]).toMatchObject({ author: "user", reason: "用户确认仍然有效" });
    expect(seen).toEqual([{ type: "knowledge.changed", entryId: e.id }]);
    expect(await db.query("select entry_id from entry_index where workspace_id = $1 and entry_id = $2", [ws, e.id])).toEqual([
      { entry_id: e.id },
    ]);
  });

  test("confirm of an inferred decision records a consumed promote_basis event", async () => {
    const e = await inferredEntry({ kind: "decision", title: "D" });
    const r = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect(r.status).toBe(200);
    const rows = await db.query<any>("select * from evidence_events where workspace_id = $1", [ws]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "promote_basis", target_basis: "decided", actor: "user" });
    expect(rows[0].consumed_commit).toBe((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim());
    expect(await git(repoPath(dataDir, ws), ["log", "-1", "--format=%B"])).toContain(`Evidence-Event: ${rows[0].id}`);
  });

  test("confirm of a snapshotted source records confirm_revision and does not mark a null revision current", async () => {
    const e = await inferredEntry({ kind: "source", title: "S", url: "https://example.com" });
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    await store.writeImportedSource({ ...e, basis: "stated", sourceSnapshot: {
      schemaVersion: 1, provider: "manual", resourceId: "a", revision: null,
      fetchedAt: SEEDED_AT, title: "S", canonicalUrl: "https://example.com", contentHash: "a".repeat(64),
      excerpts: [{ locator: "p1", text: "excerpt" }],
    } });
    const r = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect(r.status).toBe(200);
    expect((await json(r)).confirmedRevision).toBeNull();
    const rows = await db.query<any>("select * from evidence_events where workspace_id = $1", [ws]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "confirm_revision", revision: null, snapshot_hash: "a".repeat(64) });
    expect(rows[0].consumed_commit).toBeTruthy();
    expect(await db.query("select * from source_freshness where workspace_id = $1", [ws])).toHaveLength(0);
  });

  test("a snapshotted inferred source promotes and confirms its revision in one commit", async () => {
    const e = await inferredEntry({ kind: "source", title: "S", url: "https://example.com" });
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    await store.writeImportedSource({ ...e, sourceSnapshot: {
      schemaVersion: 1, provider: "manual", resourceId: "a", revision: "v2",
      fetchedAt: SEEDED_AT, title: "S", canonicalUrl: "https://example.com", contentHash: "a".repeat(64),
      excerpts: [{ locator: "p1", text: "excerpt" }],
    } });
    const r = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect(r.status).toBe(200);
    expect((await json(r)).confirmedRevision).toBe("v2");
    const rows = await db.query<any>("select * from evidence_events where workspace_id = $1 order by kind", [ws]);
    expect(rows.map((row) => row.kind)).toEqual(["confirm_revision", "promote_basis"]);
    expect(new Set(rows.map((row) => row.consumed_commit))).toEqual(new Set([(await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim()]));
    const head = rows[0].consumed_commit;
    await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await db.query("select * from evidence_events where workspace_id = $1", [ws])).toHaveLength(2);
  });

  test.each(["decision", "source"] as const)("confirm retry reconciles committed evidence after consumption fails: %s", async (kind) => {
    const e = await inferredEntry({ kind, title: "Retry", ...(kind === "source" ? { url: "https://example.com" } : {}) });
    if (kind === "source") {
      await new KnowledgeStore(repoPath(dataDir, ws)).writeImportedSource({ ...e, sourceSnapshot: {
        schemaVersion: 1, provider: "manual", resourceId: "retry", revision: "v2",
        fetchedAt: SEEDED_AT, title: "Retry", canonicalUrl: "https://example.com", contentHash: "a".repeat(64),
        excerpts: [{ locator: "p1", text: "excerpt" }],
      } });
    }
    const query = db.query.bind(db);
    let consumed = 0;
    const fault = vi.spyOn(db, "query").mockImplementation(async (sql, params) => {
      if (sql.includes("update evidence_events") && ++consumed === (kind === "source" ? 2 : 1)) {
        throw new Error("transient evidence consumption failure");
      }
      return query(sql, params);
    });
    try {
      expect((await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {})).status).toBe(500);
    } finally {
      fault.mockRestore();
    }
    const head = (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
    const before = await db.query<any>("select id, consumed_commit from evidence_events where workspace_id = $1 order by id", [ws]);
    expect(before).toHaveLength(kind === "source" ? 2 : 1);
    expect(before.filter((row) => row.consumed_commit === null)).toHaveLength(1);
    expect((await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {})).status).toBe(200);
    expect((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await db.query("select id, consumed_commit from evidence_events where workspace_id = $1 order by id", [ws]))
      .toEqual(before.map((row) => ({ id: row.id, consumed_commit: head })));
  });

  test("a room token cannot confirm through the gated ui route", async () => {
    const e = await inferredEntry({ kind: "decision", title: "D" });
    app = createApp({ db, dataDir, events, daemonStatus: () => true, daemon,
      uiAuth: async (c, next) => {
        if (c.req.header("x-nema-gateway-credential") !== "fake-gateway") return c.json({ error: "Unauthorized" }, 401);
        await next();
      },
    });
    expect((await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {}, { Authorization: "Bearer fake-run-token" })).status).toBe(401);
    expect(await db.query("select * from evidence_events where workspace_id = $1", [ws])).toHaveLength(0);
  });

  test("put records a consumed promote_basis event", async () => {
    const e = await inferredEntry({ kind: "decision", title: "D" });
    const payload = { kind: "decision", title: "Edited", body: "new", reason: "edit", sourceMessages: [], sourceSnapshot: { invalid: true }, confirmedRevision: "forged" };
    expect((await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, payload)).status).toBe(200);
    const rows = await db.query<any>("select * from evidence_events where workspace_id = $1", [ws]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("promote_basis");
    expect(rows[0].consumed_commit).toBe((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim());
    expect((await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, payload)).status).toBe(200);
    expect((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim()).toBe(rows[0].consumed_commit);
  });

  test("PUT cannot spoof confirmation provenance through its reason or client action", async () => {
    const e = await inferredEntry({ kind: "decision", title: "D" });
    const payload = { kind: "decision", title: e.title, body: e.body, reason: "用户确认仍然有效", sourceMessages: [], uiAction: "confirm" };
    expect((await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, payload)).status).toBe(200);
    const putCommit = (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
    expect((await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, { uiAction: "edit" })).status).toBe(200);
    const rows = await db.query<any>("select * from evidence_events where workspace_id = $1 order by kind", [ws]);
    expect(rows.map((row) => row.kind)).toEqual(["confirm_entry", "promote_basis"]);
    const confirmCommit = (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
    expect(confirmCommit).not.toBe(putCommit);
    expect(await git(repoPath(dataDir, ws), ["show", "-s", "--format=%B", putCommit])).toContain("UI-Action: edit");
    expect(await git(repoPath(dataDir, ws), ["show", "-s", "--format=%B", confirmCommit])).toContain("UI-Action: confirm");
    await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim()).toBe(confirmCommit);
    expect(await db.query("select * from evidence_events where workspace_id = $1", [ws])).toHaveLength(2);
  });

  test("confirm after a snapshot PUT requires its own confirm_revision event", async () => {
    const e = await inferredEntry({ kind: "source", title: "S", url: "https://example.com" });
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    await store.writeImportedSource({ ...e, sourceSnapshot: {
      schemaVersion: 1, provider: "manual", resourceId: "a", revision: null,
      fetchedAt: SEEDED_AT, title: "S", canonicalUrl: "https://example.com", contentHash: "a".repeat(64),
      excerpts: [{ locator: "p1", text: "excerpt" }],
    } });
    expect((await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, {
      kind: "source", title: "S", url: "https://example.com", body: e.body, reason: "edit", sourceMessages: [],
    })).status).toBe(200);
    const before = (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
    expect((await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {})).status).toBe(200);
    const rows = await db.query<any>("select * from evidence_events where workspace_id = $1 order by kind", [ws]);
    expect(rows.map((row) => row.kind)).toEqual(["confirm_revision", "promote_basis"]);
    const head = (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
    expect(head).not.toBe(before);
    expect(rows[0].consumed_commit).toBe(head);
    await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim()).toBe(head);
    expect(await db.query("select * from evidence_events where workspace_id = $1", [ws])).toHaveLength(2);
  });

  test.each([
    { field: "related", seed: { kind: "decision" }, patch: { related: ["R-99"] } },
    { field: "url", seed: { kind: "source", url: "https://example.com/old" }, patch: { url: "https://example.com/new" } },
    { field: "priority", seed: { kind: "question", priority: 1 }, patch: { priority: 2 } },
    { field: "businessDate", seed: { kind: "decision" }, patch: { businessDate: "2026-10-28" } },
  ])("PUT replay preserves an edit to $field outside the evidence hash", async ({ seed, patch }) => {
    const e = await inferredEntry({ ...seed, title: "Entry" });
    const payload = { ...seed, title: e.title, body: e.body, reason: "edit", sourceMessages: [] };
    expect((await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, payload)).status).toBe(200);
    const before = (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
    const r = await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, { ...payload, ...patch });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject(patch);
    expect(await new KnowledgeStore(repoPath(dataDir, ws)).get(e.id)).toMatchObject(patch);
    const head = (await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim();
    expect(head).not.toBe(before);
    await req("PUT", `/api/workspaces/${ws}/entries/${e.id}`, { ...payload, ...patch });
    expect((await git(repoPath(dataDir, ws), ["rev-parse", "HEAD"])).trim()).toBe(head);
  });

  test("two concurrent confirms share one event and one commit", async () => {
    const e = await inferredEntry({ kind: "decision", title: "D" });
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const before = await store.get(e.id);
    const countBefore = Number(await git(repoPath(dataDir, ws), ["rev-list", "--count", "HEAD"]));
    const results = await Promise.all([0, 1].map(() => req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {})));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await db.query<any>("select * from evidence_events where workspace_id = $1", [ws]);
    expect(Number(await git(repoPath(dataDir, ws), ["rev-list", "--count", "HEAD"]))).toBe(countBefore + 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("promote_basis");
    expect(rows[0].consumed_commit).toMatch(/^[a-f0-9]{40}$/);
    const saved = await store.get(e.id);
    expect(saved?.confirmedAt).not.toBe(before?.confirmedAt);
    await req("POST", `/api/workspaces/${ws}/entries/${e.id}/confirm`, {});
    expect((await db.query<any>("select * from evidence_events where workspace_id = $1", [ws]))).toHaveLength(1);
    expect((await store.get(e.id))?.confirmedAt).toBe(saved?.confirmedAt);
  });

  test("confirm on a missing entry is 404", async () => {
    const r = await req("POST", `/api/workspaces/${ws}/entries/S-99/confirm`, {});
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type") ?? "").toContain("application/json");
    expect((await json(r)).error).toBe("entry not found: S-99");
  });

  test("implementation confirm turns an inferred reported requirement into verified by user", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const implementation = {
      status: "reported" as const,
      evidence: { reportMessageId: null, commits: ["abcdef1"], inferred: true, note: "从代码推断", confirmedBy: null, acceptanceReview: null, reportEvidence: null },
    };
    const { entry: e } = await store.upsert(
      { kind: "requirement", title: "流式输出", body: "b", reason: "r", basis: "inferred", sourceMessages: [], implementation },
      { author: "agent" },
    );
    const seen: string[] = [];
    events.subscribe(ws, (ev) => {
      if (ev.type === "knowledge.changed") seen.push(ev.entryId);
    });
    const ok = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/implementation/confirm`, {});
    expect(ok.status).toBe(200);
    const saved = await json(ok);
    expect(saved.implementation).toEqual({ status: "verified", evidence: { ...implementation.evidence, confirmedBy: "user" } });
    expect((await store.get(e.id))!.implementation).toEqual(saved.implementation);
    const h = await json(await req("GET", `/api/workspaces/${ws}/entries/${e.id}/history`));
    expect(h[0]).toMatchObject({ author: "user", reason: "用户确认已实现" });
    expect(seen).toEqual([e.id]);
  });

  test("implementation confirm on a requirement with no implementation is 409", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const { entry: e } = await store.upsert(
      { kind: "requirement", title: "没有实现", body: "b", reason: "r", basis: "stated", sourceMessages: [] },
      { author: "agent" },
    );
    const r = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/implementation/confirm`, {});
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("只能确认已上报、有出入，或提交已核对但尚未验收的实现");
    expect((await store.get(e.id))!.implementation).toBeUndefined();
    expect((await req("POST", `/api/workspaces/${ws}/entries/R-99/implementation/confirm`, {})).status).toBe(404);
  });

  test("confirms a requirement that is verified with no user yet", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const evidence = { reportMessageId: "m_1", commits: ["abc1234"], inferred: false, note: null, confirmedBy: null, acceptanceReview: null, reportEvidence: null };
    const { entry: e } = await store.upsert(
      { kind: "requirement", title: "提交已核对", body: "b", reason: "r", basis: "stated", sourceMessages: [], implementation: { status: "verified", evidence } },
      { author: "system" },
    );
    const r = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/implementation/confirm`, {});
    expect(r.status).toBe(200);
    const saved = (await store.get(e.id))!.implementation!;
    expect(saved.status).toBe("verified");
    expect(saved.evidence.confirmedBy).toBe("user");
    expect(saved.evidence.commits).toEqual(["abc1234"]);
  });

  test("clears only the review when the user accepts again", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const acceptanceReview = { needed: true as const, at: "2026-10-28T00:00:00.000Z", reason: "linked_check_changed" as const };
    const evidence = { reportMessageId: "m_1", commits: ["abc1234"], inferred: false, note: "n", confirmedBy: "user" as const, acceptanceReview, reportEvidence: null };
    const { entry: e } = await store.upsert(
      { kind: "requirement", title: "需要复审", body: "b", reason: "r", basis: "stated", sourceMessages: [], implementation: { status: "verified", evidence } },
      { author: "system" },
    );
    const r = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/implementation/confirm`, {});
    expect(r.status).toBe(200);
    expect((await store.get(e.id))!.implementation).toEqual({ status: "verified", evidence: { ...evidence, acceptanceReview: null } });
  });

  test("rejects confirm when the user already accepted and no review is needed", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const evidence = { reportMessageId: "m_1", commits: ["abc1234"], inferred: false, note: null, confirmedBy: "user" as const, acceptanceReview: null, reportEvidence: null };
    const { entry: e } = await store.upsert(
      { kind: "requirement", title: "已验收", body: "b", reason: "r", basis: "stated", sourceMessages: [], implementation: { status: "verified", evidence } },
      { author: "system" },
    );
    const r = await req("POST", `/api/workspaces/${ws}/entries/${e.id}/implementation/confirm`, {});
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe("只能确认已上报、有出入，或提交已核对但尚未验收的实现");
    expect((await store.get(e.id))!.implementation!.evidence.confirmedBy).toBe("user");
  });

  test("attaches report pass state without storing it", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const check = { commitsExist: true, missingCommits: [], onMain: "yes" as const, filesOk: true, untouchedFiles: [], touchedFiles: ["a.ts"], checkedAt: "2026-10-23T10:00:00.000Z", mainSha: "1".repeat(40) };
    const report = { agent: "claude-code", gitCommonDir: "/x/.git", summary: "s", entries: [], commits: ["aaa1111"], files: [] };
    const passed = await addReportMessage(db, ws, "通过", { report, check });
    const pending = await addReportMessage(db, ws, "待核对", { report: { ...report, commits: ["bbb2222"] }, check: null });
    const groups = [{ reportMessageId: passed.id, commits: ["aaa1111"] }, { reportMessageId: pending.id, commits: ["bbb2222"] }];
    const evidence = { reportMessageId: pending.id, commits: ["aaa1111", "bbb2222"], inferred: false, note: null, confirmedBy: null, acceptanceReview: null, reportEvidence: groups };
    const { entry: grouped } = await store.upsert(
      { kind: "requirement", title: "分组", body: "b", reason: "r", basis: "stated", sourceMessages: [], implementation: { status: "verified", evidence } },
      { author: "system" },
    );
    const { entry: single } = await store.upsert(
      { kind: "requirement", title: "单条", body: "b", reason: "r", basis: "stated", sourceMessages: [], implementation: { status: "reported", evidence: { ...evidence, reportMessageId: passed.id, reportEvidence: null } } },
      { author: "system" },
    );
    const { entry: none } = await store.upsert(
      { kind: "requirement", title: "无上报", body: "b", reason: "r", basis: "stated", sourceMessages: [], implementation: { status: "reported", evidence: { ...evidence, reportMessageId: null, reportEvidence: null } } },
      { author: "system" },
    );
    const want = [{ reportMessageId: passed.id, reportPassed: true }, { reportMessageId: pending.id, reportPassed: false }];
    expect((await json(await req("GET", `/api/workspaces/${ws}/entries/${grouped.id}`))).implementation.evidence.reports).toEqual(want);
    const list = await json(await req("GET", `/api/workspaces/${ws}/entries`));
    const byId = (id: string) => list.find((e: { id: string }) => e.id === id);
    expect(byId(grouped.id).implementation.evidence.reports).toEqual(want);
    expect(byId(single.id).implementation.evidence.reports).toEqual([{ reportMessageId: passed.id, reportPassed: true }]);
    expect(byId(none.id).implementation.evidence.reports).toEqual([]);
    for (const e of [grouped, single, none]) await indexEntry(db, ws, e);
    const timeline = await json(await req("GET", `/api/workspaces/${ws}/timeline`));
    expect(timeline.find((e: { id: string }) => e.id === grouped.id).implementation.evidence.reports).toEqual(want);
    const file = await readFile(path.join(repoPath(dataDir, ws), "requirements", `${grouped.id}.md`), "utf8");
    expect(file).toContain(passed.id);
    expect(file).not.toContain("reports:");
    expect(file).not.toContain("reportPassed");
  });

  test("attaches each work package task's report pass state", async () => {
    const store = new KnowledgeStore(repoPath(dataDir, ws));
    const check = { commitsExist: true, missingCommits: [], onMain: "yes" as const, filesOk: true, untouchedFiles: [], touchedFiles: ["a.ts"], checkedAt: "2026-10-23T10:00:00.000Z", mainSha: "1".repeat(40) };
    const report = { agent: "claude-code", gitCommonDir: "/x/.git", summary: "s", entries: [], commits: ["aaa1111"], files: [] };
    const passed = await addReportMessage(db, ws, "通过", { report, check });
    const failed = await addReportMessage(db, ws, "未合入", { report, check: { ...check, onMain: "not-yet" as const } });
    await store.upsert({ kind: "requirement", title: "需求", body: "b", reason: "r", basis: "stated", sourceMessages: [] }, { author: "user" });
    const wp = await store.createWorkPackage({ title: "包", requirements: ["R-1"], repos: [], reason: "r", sourceMessages: [] }, { author: "user" });
    const task = (n: number, reportMessageId: string | null) => ({ n, title: `t${n}`, satisfies: ["R-1"], files: [], status: "verified" as const, inferred: false, reportMessageId, confirmedBy: null });
    await store.setWorkPackageMeta(wp.id, { tasks: [task(1, passed.id), task(2, failed.id), task(3, null)] }, "setup", { author: "user" });
    const read = await json(await req("GET", `/api/workspaces/${ws}/workpackages/${wp.id}`));
    expect(read.entry.workpackage.tasks.map((t: { reportPassed: boolean }) => t.reportPassed)).toEqual([true, false, false]);
    const detail = await json(await req("GET", `/api/workspaces/${ws}/entries/${wp.id}`));
    expect(detail.workpackage.tasks.map((t: { reportPassed: boolean }) => t.reportPassed)).toEqual([true, false, false]);
    expect(JSON.stringify((await store.get(wp.id))!.workpackage)).not.toContain("reportPassed");
  });

  test("POST /repos stores the inspected repo and GET lists it", async () => {
    const calls: string[] = [];
    const rpc: DaemonRpc = {
      async call(method, params) {
        calls.push(method);
        if (method === "repo.inspect") {
          expect(params).toEqual({ path: "/a/x" });
          return {
            root: "/real/a",
            gitCommonDir: "/real/a/.git",
            defaultBranch: "main",
            hasOrigin: false,
            remoteUrl: null,
          };
        }
        if (method === "repo.index") {
          const rejected = Promise.reject(new Error("index failed"));
          rejected.catch(() => {});
          return rejected;
        }
        if (method === "repos.sync") return { ok: true };
        throw new Error(`unexpected ${method}`);
      },
    };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await req("POST", `/api/workspaces/${ws}/repos`, { path: "/a/x", label: "API", mainBranch: "develop" });
    expect(created.status).toBe(200);
    const repo = await json(created);
    expect(repo).toMatchObject({
      workspaceId: ws,
      path: "/real/a",
      gitCommonDir: "/real/a/.git",
      label: "API",
      mainBranch: "develop",
      hasOrigin: false,
      remoteUrl: null,
      githubTarget: null,
      lastMainSha: null,
      lastFetchAt: null,
      lastFetchError: null,
    });
    expect(calls).toEqual(["repo.inspect", "repo.index", "repos.sync"]);
    const list = await json(await req("GET", `/api/workspaces/${ws}/repos`));
    expect(list).toEqual([repo]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors.mock.calls.some((args) => args.join(" ").includes("index failed"))).toBe(true);
    errors.mockRestore();
  });

  test("trustSkills starts off, only PATCH turns it on, and unbinding drops it", async () => {
    const rpc: DaemonRpc = {
      async call(method) {
        if (method === "repo.inspect") return { root: "/real/t", gitCommonDir: "/real/t/.git", defaultBranch: "main", hasOrigin: false, remoteUrl: null };
        if (method === "repo.index") return { sha: "abc" };
        if (method === "repos.sync" || method === "repo.forget") return { ok: true };
        throw new Error(`unexpected ${method}`);
      },
    };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    const repo = await json(await req("POST", `/api/workspaces/${ws}/repos`, { path: "/t", label: "web" }));
    expect(repo.trustSkills).toBe(false);
    const trusted = await json(await req("PATCH", `/api/workspaces/${ws}/repos/${repo.id}`, { trustSkills: true }));
    expect(trusted.trustSkills).toBe(true);
    expect((await req("PATCH", `/api/workspaces/${ws}/repos/${repo.id}`, { trustSkills: "yes" })).status).toBe(400);
    const { trustedSkillRepos } = await import("../src/repos.js");
    expect(await trustedSkillRepos(db, ws)).toEqual([{ repoId: repo.id, label: "web", path: "/real/t", mainBranch: "main", gitCommonDir: "/real/t/.git" }]);
    expect((await req("DELETE", `/api/workspaces/${ws}/repos/${repo.id}`)).status).toBeLessThan(300);
    expect(await trustedSkillRepos(db, ws)).toEqual([]);
    const again = await json(await req("POST", `/api/workspaces/${ws}/repos`, { path: "/t", label: "web" }));
    expect(again.trustSkills).toBe(false);
  });

  test("GET skills asks the daemon with the trusted repositories; an older daemon means supported: false", async () => {
    await db.query(
      `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url, trust_skills)
       values ('repo_t', $1, '/src/web', '/src/web/.git', 'web', 'main', false, null, true),
              ('repo_u', $1, '/src/api', '/src/api/.git', 'api', 'main', false, null, false)`,
      [ws],
    );
    const calls: unknown[] = [];
    const row = { id: "tdd", name: "tdd", description: "d", command: "/tdd", invocation: "model-and-user", runtimes: [], repoId: null };
    let reply: () => Promise<unknown> = async () => [row];
    const rpc: DaemonRpc = {
      async call(method, params) {
        calls.push([method, params]);
        return reply();
      },
    };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    expect(await json(await req("GET", `/api/workspaces/${ws}/skills`))).toEqual({ supported: true, skills: [row] });
    expect(calls).toEqual([["skills.catalog", { projectSkills: [{ repoId: "repo_t", label: "web", path: "/src/web", mainBranch: "main", gitCommonDir: "/src/web/.git" }] }]]);
    reply = () => Promise.reject(new DaemonRpcError("未知方法 skills.catalog"));
    expect(await json(await req("GET", `/api/workspaces/${ws}/skills`))).toEqual({ supported: false, skills: [] });
    reply = () => Promise.reject(new DaemonRpcError("daemon 未连接"));
    expect((await req("GET", `/api/workspaces/${ws}/skills`)).status).toBe(503);
    expect((await req("GET", `/api/workspaces/nope/skills`)).status).toBe(404);
  });

  test("binding the same git common dir twice is 409 even through a different path spelling", async () => {
    const alpha = await json(await req("POST", "/api/workspaces", { name: "Alpha" }));
    const beta = await json(await req("POST", "/api/workspaces", { name: "Beta" }));
    const rpc: DaemonRpc = {
      async call(method, params) {
        if (method === "repo.inspect") {
          return { root: "/real/a", gitCommonDir: "/real/common", defaultBranch: "main", hasOrigin: false, remoteUrl: null };
        }
        if (method === "repo.index") return { sha: "abc" };
        if (method === "repos.sync") return { ok: true };
        throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
      },
    };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    expect((await req("POST", `/api/workspaces/${alpha.id}/repos`, { path: "/a/x", label: "API" })).status).toBe(200);
    const again = await req("POST", `/api/workspaces/${beta.id}/repos`, { path: "/a/x/", label: "API" });
    expect(again.status).toBe(409);
    expect((await json(again)).error).toBe("该仓库已绑定到 workspace Alpha");
  });

  test("binding without a daemon is 503 daemon 未连接", async () => {
    const rpc: DaemonRpc = { call: () => Promise.reject(new DaemonRpcError("daemon 未连接")) };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    const r = await req("POST", `/api/workspaces/${ws}/repos`, { path: "/a/x", label: "API" });
    expect(r.status).toBe(503);
    expect((await json(r)).error).toBe("daemon 未连接");
  });

  test("a daemon timeout is 503 daemon 响应超时", async () => {
    const rpc: DaemonRpc = { call: () => Promise.reject(new DaemonRpcError("daemon 响应超时")) };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    const r = await req("POST", `/api/workspaces/${ws}/repos`, { path: "/a/x", label: "API" });
    expect(r.status).toBe(503);
    expect((await json(r)).error).toBe("daemon 响应超时");
  });

  test("inspecting a path that is not a git root is 400 不是 git 仓库的根目录", async () => {
    const rpc: DaemonRpc = { call: () => Promise.reject(new DaemonRpcError("不是 git 仓库的根目录")) };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    const r = await req("POST", `/api/workspaces/${ws}/repos`, { path: "/a/x", label: "API" });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toBe("不是 git 仓库的根目录");
  });

  test("a refspec as mainBranch is 400 主分支名称无效 before the daemon is asked", async () => {
    const calls: string[] = [];
    const rpc: DaemonRpc = {
      async call(method) {
        calls.push(method);
        throw new Error(`unexpected ${method}`);
      },
    };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    const r = await req("POST", `/api/workspaces/${ws}/repos`, { path: "/a/x", label: "API", mainBranch: "a:refs/heads/x" });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toBe("主分支名称无效");
    expect(calls).toEqual([]);
  });

  test("DELETE of an unknown repo is 404 in Chinese", async () => {
    const r = await req("DELETE", `/api/workspaces/${ws}/repos/repo_missing`);
    expect(r.status).toBe(404);
    const error = (await json(r)).error as string;
    expect(error).not.toMatch(/repo not found/);
    expect(error).toMatch(/[\u4e00-\u9fff]/);
  });

  test("PATCH updates a repo and DELETE fires repo.forget", async () => {
    const calls: unknown[] = [];
    const rpc: DaemonRpc = {
      async call(method, params) {
        if (method === "repo.inspect") {
          return { root: "/real/a", gitCommonDir: "/real/a/.git", defaultBranch: "main", hasOrigin: true, remoteUrl: "git@github.com:Acme/A.git" };
        }
        if (method === "repo.index") return { sha: "abc" };
        if (method === "repo.forget") {
          calls.push(params);
          const rejected = Promise.reject(new Error("forget failed"));
          rejected.catch(() => {});
          return rejected;
        }
        if (method === "repos.sync") return { ok: true };
        throw new Error(`unexpected ${method}`);
      },
    };
    app = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon: rpc, webOrigin: "http://localhost:3000" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const created = await req("POST", `/api/workspaces/${ws}/repos`, { path: "/a/x", label: "API" });
    expect(created.status).toBe(200);
    const repo = await json(created);
    const other = await json(await req("POST", "/api/workspaces", { name: "Other" }));
    const patched = await req("PATCH", `/api/workspaces/${ws}/repos/${repo.id}`, { label: "Renamed", mainBranch: "trunk" });
    expect(patched.status).toBe(200);
    expect(repo.githubTarget).toBe("acme/a");
    expect(await json(patched)).toMatchObject({ id: repo.id, label: "Renamed", mainBranch: "trunk", githubTarget: "acme/a" });
    const badBranch = await req("PATCH", `/api/workspaces/${ws}/repos/${repo.id}`, { mainBranch: "+main" });
    expect(badBranch.status).toBe(400);
    expect((await json(badBranch)).error).toBe("主分支名称无效");
    expect((await req("PATCH", `/api/workspaces/${other.id}/repos/${repo.id}`, { label: "Nope" })).status).toBe(404);

    const deleted = await req("DELETE", `/api/workspaces/${ws}/repos/${repo.id}`);
    expect(deleted.status).toBe(204);
    expect(calls).toEqual([{ workspaceId: ws, repoId: repo.id, path: "/real/a", mainBranch: "trunk" }]);
    expect((await json(await req("GET", `/api/workspaces/${ws}/repos`))).map((row: { id: string }) => row.id)).not.toContain(repo.id);
    expect((await req("DELETE", `/api/workspaces/${ws}/repos/${repo.id}`)).status).toBe(404);
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors.mock.calls.some((args) => args.join(" ").includes("forget failed"))).toBe(true);
    errors.mockRestore();
  });

  test("CORS webOrigin accepts a comma-separated list; default allows localhost and 127.0.0.1", async () => {
    const multi = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon, webOrigin: "http://localhost:3000, http://127.0.0.1:3000" });
    const dflt = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon });
    for (const a of [multi, dflt]) {
      for (const o of ["http://localhost:3000", "http://127.0.0.1:3000"]) {
        const r = await a.request(`${HUB}/api/workspaces`, { headers: { Origin: o } });
        expect(r.headers.get("access-control-allow-origin")).toBe(o);
      }
      const e = await a.request(`${HUB}/api/workspaces`, { headers: { Origin: "http://evil.example" } });
      expect(e.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("diagram routes", () => {
  const CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'none'";
  let renders: { type: string; spec: unknown }[];
  let diagramApp: Hono<any>;

  beforeEach(() => {
    renders = [];
    const archify = {
      async validateDiagram(): Promise<{ ok: true }> {
        return { ok: true };
      },
      async renderDiagram(type: any, spec: unknown): Promise<string> {
        renders.push({ type, spec });
        return `<html><body>${JSON.stringify(spec)}</body></html>`;
      },
    };
    diagramApp = createApp({ db, dataDir, nemaHome, events, daemonStatus: () => true, daemon, webOrigin: "http://localhost:3000", archify });
  });

  const dreq = (method: string, p: string, body?: unknown) =>
    diagramApp.request(`${HUB}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  async function diagram(workspaceId: string, spec: unknown, id?: string) {
    const store = new KnowledgeStore(repoPath(dataDir, workspaceId));
    const { entry } = await store.writeDiagram(
      {
        ...(id !== undefined ? { id } : {}),
        title: "架构",
        body: "总览",
        diagram: { repoId: "repo_x", type: "architecture", sourceCommits: { repo_x: "abc123" }, nodePaths: { hub: ["apps/hub"] } },
        spec,
        reason: "画图：架构",
        sourceMessages: [],
      },
      { author: "agent" },
    );
    return entry;
  }

  test("the update route queues a system task naming the diagram and its source commit", async () => {
    const g = await diagram(ws, { nodes: [] });
    const seen: string[] = [];
    events.subscribe(ws, (e) => seen.push(e.type));
    const r = await dreq("POST", `/api/workspaces/${ws}/diagrams/${g.id}/update`, {});
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.task.status).toBe("queued");
    expect(b.message.role).toBe("system");
    expect(b.message.content).toBe(
      `用户要求更新代码图 ${g.id}：用 diagram__read 读旧图，用 code__changes 看自 abc123 以来的改动，只改受影响的节点和连线，再用 diagram__save（带 id）保存。`,
    );
    expect(seen).toEqual(["message.created", "task.updated"]);
    expect((await dreq("POST", `/api/workspaces/${ws}/diagrams/G-9/update`, {})).status).toBe(404);
    expect((await dreq("POST", `/api/workspaces/${ws}/diagrams/R-1/update`, {})).status).toBe(404);
  });

  test("diagram html is served with the CSP and nosniff headers", async () => {
    const g = await diagram(ws, { v: 1 });
    const r = await dreq("GET", `/api/workspaces/${ws}/diagrams/${g.id}.html`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await r.text()).toBe(`<html><body>{"v":1}</body></html>`);
    // Cached by the json's commit: a second read does not render again; a new version does.
    await dreq("GET", `/api/workspaces/${ws}/diagrams/${g.id}.html`);
    expect(renders).toHaveLength(1);
    await diagram(ws, { v: 2 }, g.id);
    expect(await (await dreq("GET", `/api/workspaces/${ws}/diagrams/${g.id}.html`)).text()).toBe(`<html><body>{"v":2}</body></html>`);
    expect(renders).toHaveLength(2);
    expect(renders[1]).toEqual({ type: "architecture", spec: { v: 2 } });
  });

  test("diagram html for another workspace's gid is 404", async () => {
    const other = (await createWorkspace(db, dataDir, "B")).id;
    const g = await diagram(other, { v: 1 });
    const r = await dreq("GET", `/api/workspaces/${ws}/diagrams/${g.id}.html`);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect((await dreq("GET", `/api/workspaces/${ws}/diagrams/R-1.html`)).status).toBe(404);
    expect((await dreq("GET", `/api/workspaces/${other}/diagrams/${g.id}.html`)).status).toBe(200);
    expect(renders).toHaveLength(1);
  });

  test("POST /workspaces/:id/repos/preview returns the inspect summary", async () => {
    const ws = await createWorkspace(db, dataDir, "Alpha");
    const app = createApp({
      db,
      dataDir,
      nemaHome,
      events,
      daemonStatus: () => true,
      daemon: {
        call: async (method) => {
          if (method !== "repo.inspect") throw new DaemonRpcError("daemon 未连接");
          return { root: "/real/a", gitCommonDir: "/real/a/.git", defaultBranch: "develop", hasOrigin: true, remoteUrl: "https://example.com/a.git" };
        },
      },
      webOrigin: "http://localhost:3000",
    });
    const response = await app.request(`${HUB}/api/workspaces/${ws.id}/repos/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/a/x" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      root: "/real/a",
      defaultBranch: "develop",
      hasOrigin: true,
      remoteUrl: "https://example.com/a.git",
      label: "a",
      labelTaken: false,
    });
  });

  test("POST /pick-directory returns the host daemon's folder", async () => {
    const picker = createApp({
      db,
      dataDir,
      nemaHome,
      events,
      daemonStatus: () => true,
      daemon: { call: async (method) => (method === "dialog.pickDirectory" ? { path: "C:\\src\\app" } : Promise.reject(new DaemonRpcError("daemon 未连接"))) },
      webOrigin: "http://localhost:3000",
    });
    const chosen = await picker.request(`${HUB}/api/pick-directory`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(chosen.status).toBe(200);
    expect(await chosen.json()).toEqual({ path: "C:\\src\\app" });

    const cancel = createApp({
      db,
      dataDir,
      nemaHome,
      events,
      daemonStatus: () => true,
      daemon: { call: async () => ({ path: null }) },
      webOrigin: "http://localhost:3000",
    });
    expect(await (await cancel.request(`${HUB}/api/pick-directory`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).toEqual({ path: null });

    const offline = createApp({
      db,
      dataDir,
      nemaHome,
      events,
      daemonStatus: () => false,
      daemon: { call: async () => Promise.reject(new DaemonRpcError("daemon 未连接")) },
      webOrigin: "http://localhost:3000",
    });
    const down = await offline.request(`${HUB}/api/pick-directory`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: string }).error).toBe("daemon 未连接");
  });
});

describe("sending messages with attachments", () => {
  test("the main, new-thread and thread-reply routes all accept attachmentIds", async () => {
    const a = await uploadPng(db, dataDir, ws);
    const main = await req("POST", `/api/workspaces/${ws}/messages`, { content: "", attachmentIds: [a.id] });
    expect(main.status).toBe(200);
    const mainBody = await json(main);
    expect(mainBody.message.attachments.map((v: { id: string }) => v.id)).toEqual([a.id]);

    const b = await uploadPng(db, dataDir, ws);
    const thread = await req("POST", `/api/workspaces/${ws}/threads`, { content: "", attachmentIds: [b.id] });
    expect(thread.status).toBe(200);
    const threadBody = await json(thread);
    expect(threadBody.message.attachments.map((v: { id: string }) => v.id)).toEqual([b.id]);
    expect(threadBody.thread.title).toBe("新追问");

    const c = await uploadPng(db, dataDir, ws);
    const reply = await req("POST", `/api/workspaces/${ws}/threads/${threadBody.thread.id}/messages`, { content: "see", attachmentIds: [c.id] });
    expect(reply.status).toBe(200);
    expect((await json(reply)).message.attachments.map((v: { id: string }) => v.id)).toEqual([c.id]);
  });

  test("a retried send answers with the original message and task, once", async () => {
    const a = await uploadPng(db, dataDir, ws);
    const seen: string[] = [];
    events.subscribe(ws, (e) => seen.push(e.type));
    const first = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "x", attachmentIds: [a.id] }));
    const again = await req("POST", `/api/workspaces/${ws}/messages`, { content: "x", attachmentIds: [a.id] });
    expect(again.status).toBe(200);
    const body = await json(again);
    expect(body.message.id).toBe(first.message.id);
    expect(body.task.id).toBe(first.task.id);
    expect(seen.filter((t) => t === "message.created")).toHaveLength(1);
    const changed = await req("POST", `/api/workspaces/${ws}/messages`, { content: "y", attachmentIds: [a.id] });
    expect(changed.status).toBe(409);
  });

  test("empty text needs an attachment; more than 8 ids is a 400", async () => {
    expect((await req("POST", `/api/workspaces/${ws}/messages`, { content: " " })).status).toBe(400);
    expect((await req("POST", `/api/workspaces/${ws}/messages`, { content: "", attachmentIds: [] })).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => `att_${String(i).padStart(16, "0")}`);
    expect((await req("POST", `/api/workspaces/${ws}/messages`, { content: "x", attachmentIds: nine })).status).toBe(400);
  });

  test("the delivery limit is a 400 that names it", async () => {
    const MB = 1024 * 1024;
    const ids = [await stagedRow(db, ws, "pdf", 20 * MB), await stagedRow(db, ws, "pdf", 13 * MB)];
    const r = await req("POST", `/api/workspaces/${ws}/messages`, { content: "x", attachmentIds: ids });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toContain("合计超过 32 MB");
  });
});

describe("editing a message to empty text", () => {
  const finish = (taskId: string) => db.query("update tasks set status = 'done' where id = $1", [taskId]);

  test("is allowed while the message still has a file", async () => {
    const a = await uploadPng(db, dataDir, ws);
    const sent = await postUserMessage(db, ws, "caption", { attachmentIds: [a.id] });
    await finish(sent.task.id);
    const r = await req("PATCH", `/api/workspaces/${ws}/messages/${sent.message.id}`, { content: "" });
    expect(r.status).toBe(200);
    const body = await json(r);
    expect(body.message.content).toBe("");
    expect(body.message.attachments.map((v: { id: string }) => v.id)).toEqual([a.id]);
  });

  test("is refused when the message has no file left", async () => {
    const plain = await postUserMessage(db, ws, "text only");
    await finish(plain.task.id);
    expect((await req("PATCH", `/api/workspaces/${ws}/messages/${plain.message.id}`, { content: "  " })).status).toBe(400);

    const a = await uploadPng(db, dataDir, ws);
    const sent = await postUserMessage(db, ws, "caption", { attachmentIds: [a.id] });
    await finish(sent.task.id);
    expect((await req("DELETE", `/api/workspaces/${ws}/attachments/${a.id}`)).status).toBe(200);
    expect((await req("PATCH", `/api/workspaces/${ws}/messages/${sent.message.id}`, { content: "" })).status).toBe(400);
  });

  test("an edit body takes only content", async () => {
    const plain = await postUserMessage(db, ws, "text only");
    await finish(plain.task.id);
    expect((await req("PATCH", `/api/workspaces/${ws}/messages/${plain.message.id}`, { content: "new", attachmentIds: ["att_0000000000000000"] })).status).toBe(400);
  });

  test("sending still refuses empty text without files", async () => {
    expect((await req("POST", `/api/workspaces/${ws}/messages`, { content: "" })).status).toBe(400);
  });
});
