import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KnowledgeStore } from "@nema/knowledge";
import { canonicalJson, KIND_DIR, PLUGINS, bundledExtensions } from "@nema/shared";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";
import { addMessage, addReportMessage, postSystemTask, postUserMessage } from "../src/messages.js";
import { claimNextTask, finishTask, insertQueuedTask, listTaskChanges } from "../src/tasks.js";
import { EventBus, type HubEvent } from "../src/events.js";
import { USER_BASIS_EVIDENCE_CODE, USER_BASIS_EVIDENCE_ERROR, roomRoutes } from "../src/roomApi.js";
import { markThreadRead } from "../src/threads.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { Hono } from "hono";

let db: Db;
let dataDir: string;
let wsA: string;
let wsB: string;
let events: EventBus;
let app: Hono<any>;
const daemonCalls: { method: string; params: unknown; timeoutMs?: number }[] = [];
/**
 * Offering a tool asks the daemon which extensions the install switched off before it asks for
 * anything else. That read is expected; every other call is what these assertions are about.
 */
const otherCalls = () => daemonCalls.filter((call) => call.method !== "extensions.list");
let daemonCall: (method: string, params: unknown) => Promise<unknown> = async (method) => {
  // Offering a tool asks which extensions the install switched off before it asks the daemon for
  // anything else, so that read is always answered and every other call stays unexpected.
  if (method === "extensions.list") return bundledExtensions();
  throw new Error(`unexpected daemon call ${method}`);
};
const daemon: DaemonRpc = {
  call(method, params, timeoutMs) {
    daemonCalls.push({ method, params, timeoutMs });
    return daemonCall(method, params);
  },
};

beforeEach(async () => {
  daemonCalls.length = 0;
  daemonCall = async (method) => {
    if (method === "extensions.list") return bundledExtensions();
    throw new Error(`unexpected daemon call ${method}`);
  };
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  events = new EventBus();
  wsA = (await createWorkspace(db, deps.dataDir, "A")).id;
  wsB = (await createWorkspace(db, deps.dataDir, "B")).id;
  app = new Hono().route("/room", roomRoutes({ db, dataDir: deps.dataDir, events, daemon }));
});
afterAll(cleanupHubDeps);

async function runningTaskFor(ws: string) {
  const m = await postUserMessage(db, ws, "memo");
  const t = await claimNextTask(db, "d1");
  expect(t?.workspaceId).toBe(ws);
  return { runToken: t!.runToken!, taskId: t!.id, messageId: m.message.id };
}
const req = (method: string, path: string, token?: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const upsert = (o: Record<string, unknown>) => ({ kind: "requirement", title: "T", body: "b", reason: "r", basis: "stated", ...o });

function decisionGuardError(id: string): string {
  return `改写已定决策 ${id} 需要用户消息作为依据（basis 为 stated 或 decided，且 sourceMessages 含用户消息）。若只是推断，请不要改它，改为新建一条 question 询问用户。`;
}

function entryPath(ws: string, kind: keyof typeof KIND_DIR, id: string): string {
  return path.join(repoPath(dataDir, ws), KIND_DIR[kind], `${id}.md`);
}

async function seedActiveDecision(token: string, messageId: string): Promise<void> {
  const created = await req("POST", "/room/entries", token, upsert({
    kind: "decision",
    title: "ship it",
    body: "original",
    basis: "decided",
    sourceMessages: [messageId],
  }));
  expect(created.status).toBe(200);
}

describe("room api", () => {
  test("open_thread anchors on the task message and emits thread.updated", async () => {
    const t = await runningTaskFor(wsA);
    const seen: HubEvent[] = [];
    events.subscribe(wsA, (e) => seen.push(e));
    const r = await req("POST", "/room/threads", t.runToken, { title: "Long topic" });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.threadId).toBe(t.messageId);
    expect(seen).toEqual([{ type: "thread.updated", thread: expect.objectContaining({ id: t.messageId, title: "Long topic" }) }]);
  });

  test("open_thread twice returns the same thread", async () => {
    const t = await runningTaskFor(wsA);
    const first = await req("POST", "/room/threads", t.runToken, { title: "First" });
    const second = await req("POST", "/room/threads", t.runToken, { title: "Second" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });

  test("open_thread on an existing thread renames it", async () => {
    const t = await runningTaskFor(wsA);
    await req("POST", "/room/threads", t.runToken, { title: "First" });
    const r = await req("POST", "/room/threads", t.runToken, { title: "Renamed" });
    expect(r.status).toBe(200);
    const rows = await db.query<{ title: string }>("select title from threads where id=$1", [t.messageId]);
    expect(rows).toEqual([{ title: "Renamed" }]);
  });

  test("open_thread from a thread task renames that thread", async () => {
    const anchor = await postUserMessage(db, wsA, "anchor");
    const t0 = await claimNextTask(db, "d1");
    await req("POST", "/room/threads", t0!.runToken!, { title: "Original" });
    await finishTask(db, t0!.id, { ok: true });
    const nested = await postUserMessage(db, wsA, "reply task", { threadId: anchor.message.id });
    const task = await claimNextTask(db, "d2");
    expect(task?.id).toBe(nested.task.id);
    const secondReply = await postUserMessage(db, wsA, "second reply", { threadId: anchor.message.id });
    const firstSeq = await db.query<{ seq: number }>("select seq from messages where id=$1", [nested.message.id]);
    await markThreadRead(db, anchor.message.id, firstSeq[0]!.seq);
    const seen: HubEvent[] = [];
    events.subscribe(wsA, (e) => seen.push(e));
    const r = await req("POST", "/room/threads", task!.runToken!, { title: "Renamed from reply" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ threadId: anchor.message.id });
    expect(await db.query("select title from threads where id=$1", [anchor.message.id])).toEqual([{ title: "Renamed from reply" }]);
    expect(seen).toEqual([{
      type: "thread.updated",
      thread: expect.objectContaining({
        id: anchor.message.id,
        title: "Renamed from reply",
        replyCount: 2,
        unread: 1,
        lastReplyAt: secondReply.message.createdAt,
      }),
    }]);
  });

  test("title is required and empty title is 400", async () => {
    const t = await runningTaskFor(wsA);
    expect((await req("POST", "/room/threads", t.runToken, {})).status).toBe(400);
    expect((await req("POST", "/room/threads", t.runToken, { title: "" })).status).toBe(400);
  });

  test("token scopes all access to its own workspace", async () => {
    const ta = await runningTaskFor(wsA);
    const tb = await runningTaskFor(wsB);
    const r = await req("POST", "/room/entries", ta.runToken, upsert({ title: "A 的秘密需求", sourceMessages: [ta.messageId] }));
    expect(r.status).toBe(200);
    expect(((await (await req("GET", "/room/entries", ta.runToken)).json()) as any).entries).toHaveLength(1);
    const asB = await req("GET", "/room/entries", tb.runToken);
    expect(((await asB.json()) as any).entries).toEqual([]);
    expect((await req("GET", "/room/entries/R-1", tb.runToken)).status).toBe(404);
    expect((await req("GET", "/room/entries/R-1", ta.runToken)).status).toBe(200);
  });

  test("finished task token → 401", async () => {
    const t = await runningTaskFor(wsA);
    await finishTask(db, t.taskId, { ok: true });
    expect((await req("GET", "/room/entries", t.runToken)).status).toBe(401);
  });

  test("missing or garbage token → 401", async () => {
    expect((await req("GET", "/room/entries")).status).toBe(401);
    expect((await req("GET", "/room/entries", "garbage")).status).toBe(401);
    expect((await req("POST", "/room/entries", "garbage", upsert({}))).status).toBe(401);
    expect((await req("GET", "/room/entries/R-1")).status).toBe(401);
  });

  test("empty sourceMessages or another workspace's message → 400", async () => {
    const ta = await runningTaskFor(wsA);
    const other = await postUserMessage(db, wsB, "b memo");
    const e1 = await req("POST", "/room/entries", ta.runToken, upsert({ sourceMessages: [] }));
    expect(e1.status).toBe(400);
    expect(((await e1.json()) as any).error).toContain("sourceMessages");
    expect((await req("POST", "/room/entries", ta.runToken, upsert({ sourceMessages: [other.message.id] }))).status).toBe(400);
    expect((await req("POST", "/room/entries", ta.runToken, upsert({ sourceMessages: ["m_nope"] }))).status).toBe(400);
    const e2 = await req("POST", "/room/entries", ta.runToken, upsert({ title: "", sourceMessages: [ta.messageId] }));
    expect(e2.status).toBe(400);
    expect(((await e2.json()) as any).error).toContain("title");
  });

  test("upsert indexes, records task change and emits knowledge.changed", async () => {
    const t = await runningTaskFor(wsA);
    const seen: HubEvent[] = [];
    events.subscribe(wsA, (e) => seen.push(e));
    const r = await req("POST", "/room/entries", t.runToken, upsert({ title: "导出", sourceMessages: [t.messageId] }));
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.entry.id).toBe("R-1");
    expect(j.commit).toMatch(/^[0-9a-f]+$/);
    expect(seen).toEqual([{ type: "knowledge.changed", entryId: "R-1" }]);
    expect(await listTaskChanges(db, t.taskId)).toEqual([{ entryId: "R-1", kind: "requirement", title: "导出", op: "add" }]);
    const idx = await db.query(`select entry_id, title from entry_index where workspace_id = $1`, [wsA]);
    expect(idx).toEqual([{ entry_id: "R-1", title: "导出" }]);
  });

  test("update of unknown id → 404", async () => {
    const t = await runningTaskFor(wsA);
    const r = await req("POST", "/room/entries", t.runToken, upsert({ id: "R-7", sourceMessages: [t.messageId] }));
    expect(r.status).toBe(404);
  });

  test("bookkeeping failure after commit still returns 200 and the entry is committed", async () => {
    const t = await runningTaskFor(wsA);
    await db.query("drop table task_changes");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await req("POST", "/room/entries", t.runToken, upsert({ title: "kept", sourceMessages: [t.messageId] }));
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.id).toBe("R-1");
    expect(((await (await req("GET", "/room/entries/R-1", t.runToken)).json()) as any).entry.title).toBe("kept");
  });

  test("rejects an upsert without basis", async () => {
    const t = await runningTaskFor(wsA);
    const { basis: _basis, ...body } = upsert({ sourceMessages: [t.messageId] });
    const r = await req("POST", "/room/entries", t.runToken, body);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("basis: required (stated | decided | inferred)");
  });

  test("rejects a quote whose message is not cited", async () => {
    const t = await runningTaskFor(wsA);
    const other = await postUserMessage(db, wsA, "other memo");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      sourceMessages: [t.messageId],
      quotes: [{ messageId: other.message.id, text: "other memo" }],
    }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe(`quotes: message ${other.message.id} is not in sourceMessages`);
  });

  test("a quote matches the current text or any stored version", async () => {
    const t = await runningTaskFor(wsA);
    const m = await postUserMessage(db, wsA, "current text");
    await db.query(`insert into message_versions(message_id, version, content) values ($1, 1, $2)`, [m.message.id, "the old wording"]);
    const fromOld = await req("POST", "/room/entries", t.runToken, upsert({
      sourceMessages: [t.messageId, m.message.id],
      quotes: [{ messageId: m.message.id, text: "old wording" }],
    }));
    expect(fromOld.status).toBe(200);
    const fromCurrent = await req("POST", "/room/entries", t.runToken, upsert({
      title: "second",
      sourceMessages: [t.messageId, m.message.id],
      quotes: [{ messageId: m.message.id, text: "current text" }],
    }));
    expect(fromCurrent.status).toBe(200);
    const neither = await req("POST", "/room/entries", t.runToken, upsert({
      title: "third",
      sourceMessages: [t.messageId, m.message.id],
      quotes: [{ messageId: m.message.id, text: "never written" }],
    }));
    expect(neither.status).toBe(400);
    expect(((await neither.json()) as any).error).toBe(`quotes: text must be copied verbatim from message ${m.message.id}`);
  });

  test("rejects a quote that is not verbatim, including collapsed whitespace", async () => {
    const t = await runningTaskFor(wsA);
    const content = "先流式\n\n  后面再说多轮 **别动** tool";
    const m = await postUserMessage(db, wsA, content);
    const ok = await req("POST", "/room/entries", t.runToken, upsert({
      sourceMessages: [t.messageId, m.message.id],
      quotes: [{ messageId: m.message.id, text: "后面再说多轮 **别动**" }],
    }));
    expect(ok.status).toBe(200);
    const bad = await req("POST", "/room/entries", t.runToken, upsert({
      title: "other",
      sourceMessages: [t.messageId, m.message.id],
      quotes: [{ messageId: m.message.id, text: "先流式 后面再说多轮" }],
    }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe(`quotes: text must be copied verbatim from message ${m.message.id}`);
  });

  test("blocks an inferred rewrite of an active decision's body", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "rewritten",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
    expect(await readFile(file)).toEqual(before);
  });

  test("blocks an inferred status-only change of an active decision to superseded", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "original",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
    expect(await readFile(file)).toEqual(before);
  });

  test("blocks a stated rewrite whose only source is an agent message", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const agent = await addMessage(db, wsA, "agent", "rewrite the decision");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "rewritten",
      basis: "stated",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
  });

  test("allows a decided rewrite citing a user message", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "new body",
      basis: "decided",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.body).toBe("new body");
  });

  test("does not guard requirements or a superseded decision", async () => {
    const t = await runningTaskFor(wsA);
    const reqCreated = await req("POST", "/room/entries", t.runToken, upsert({
      title: "req",
      body: "old",
      sourceMessages: [t.messageId],
    }));
    expect(reqCreated.status).toBe(200);
    const reqUpdated = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "new",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(reqUpdated.status).toBe(200);
    expect(((await reqUpdated.json()) as any).entry.body).toBe("new");

    const superseded = await req("POST", "/room/entries", t.runToken, upsert({
      kind: "decision",
      title: "old call",
      body: "old",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(superseded.status).toBe(200);
    const rewritten = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "old call",
      body: "rewritten anyway",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(rewritten.status).toBe(200);
    expect(((await rewritten.json()) as any).entry.body).toBe("rewritten anyway");
  });

  test("does not guard a related-only update of an active decision", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "original",
      related: ["R-1"],
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    const saved = (await r.json()) as any;
    // A related-only update must not downgrade the user's decision to inferred.
    expect(saved.entry.basis).toBe("decided");
    expect(saved.entry.related).toEqual(["R-1"]);
    expect(saved.entry.body).toBe("original");
    expect(saved.entry.status).toBe("active");
  });
});

describe("decision basis changes", () => {
  async function seedInferredDecision(token: string, messageId: string): Promise<void> {
    const created = await req("POST", "/room/entries", token, upsert({
      kind: "decision",
      title: "guess",
      body: "original",
      basis: "inferred",
      sourceMessages: [messageId],
    }));
    expect(created.status).toBe(200);
  }

  test("blocks upgrading an inferred active decision to decided without a user message", async () => {
    const t = await runningTaskFor(wsA);
    await seedInferredDecision(t.runToken, t.messageId);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const agent = await addMessage(db, wsA, "agent", "I think this was decided");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "guess",
      body: "original",
      related: ["R-1"],
      basis: "decided",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as any).error).toBe(decisionGuardError("D-1"));
    expect(await readFile(file)).toEqual(before);
  });

  test("allows upgrading an inferred active decision when a user message is cited", async () => {
    const t = await runningTaskFor(wsA);
    await seedInferredDecision(t.runToken, t.messageId);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "guess",
      body: "original",
      basis: "decided",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.basis).toBe("decided");
  });
});

describe("user basis evidence", () => {
  function evidenceBody(): { error: string; code: string } {
    return { error: USER_BASIS_EVIDENCE_ERROR, code: USER_BASIS_EVIDENCE_CODE };
  }

  test("rejects a new decided entry that cites only an agent message", async () => {
    const t = await runningTaskFor(wsA);
    const agent = await addMessage(db, wsA, "agent", "I decided");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      kind: "decision",
      basis: "decided",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    await expect(readFile(entryPath(wsA, "decision", "D-1"))).rejects.toThrow();
  });

  test("rejects a new stated entry that cites a user message from another task", async () => {
    const t = await runningTaskFor(wsA);
    const other = await postUserMessage(db, wsA, "a different request");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      basis: "stated",
      sourceMessages: [other.message.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    await expect(readFile(entryPath(wsA, "requirement", "R-1"))).rejects.toThrow();
  });

  test("rejects a stated body rewrite of a requirement that omits the current task user message", async () => {
    const t = await runningTaskFor(wsA);
    const created = await req("POST", "/room/entries", t.runToken, upsert({
      title: "req",
      body: "old",
      sourceMessages: [t.messageId],
    }));
    expect(created.status).toBe(200);
    const file = entryPath(wsA, "requirement", "R-1");
    const before = await readFile(file);
    const agent = await addMessage(db, wsA, "agent", "rewrite it");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "new",
      basis: "stated",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    expect(await readFile(file)).toEqual(before);
  });

  test("rejects a decided rewrite of an active decision that cites a different user message", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const other = await postUserMessage(db, wsA, "some other user message");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "rewritten",
      basis: "decided",
      sourceMessages: [other.message.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    expect(await readFile(file)).toEqual(before);
  });

  test("rejects reviving a superseded decision without the current task user message", async () => {
    const t = await runningTaskFor(wsA);
    const created = await req("POST", "/room/entries", t.runToken, upsert({
      kind: "decision",
      title: "old call",
      body: "old",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(created.status).toBe(200);
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const agent = await addMessage(db, wsA, "agent", "bring it back");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "old call",
      body: "rewritten",
      status: "active",
      basis: "inferred",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    expect(await readFile(file)).toEqual(before);
  });

  test("rejects a decided entry from a system task that cites an older user message", async () => {
    const user = await postUserMessage(db, wsA, "earlier user");
    const userTask = await claimNextTask(db, "d-user");
    expect(userTask?.workspaceId).toBe(wsA);
    await finishTask(db, userTask!.id, { ok: true });
    const sys = await postSystemTask(db, wsA, "draw the diagram");
    const task = await claimNextTask(db, "d-sys");
    expect(task?.id).toBe(sys.task.id);
    const r = await req("POST", "/room/entries", task!.runToken!, upsert({
      kind: "decision",
      basis: "decided",
      sourceMessages: [user.message.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    await expect(readFile(entryPath(wsA, "decision", "D-1"))).rejects.toThrow();
  });

  test("accepts a stated body rewrite of a requirement that cites the current task user message", async () => {
    const t = await runningTaskFor(wsA);
    const created = await req("POST", "/room/entries", t.runToken, upsert({
      title: "req",
      body: "old",
      sourceMessages: [t.messageId],
    }));
    expect(created.status).toBe(200);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "new",
      basis: "stated",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.body).toBe("new");
  });

  test("accepts reviving a superseded decision when the current task user message is cited", async () => {
    const t = await runningTaskFor(wsA);
    const created = await req("POST", "/room/entries", t.runToken, upsert({
      kind: "decision",
      title: "old call",
      body: "old",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(created.status).toBe(200);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "old call",
      body: "old",
      status: "active",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.status).toBe("active");
  });

  test("rejects reviving a dropped decision without the current task user message", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    const withdrawn = await new KnowledgeStore(repoPath(dataDir, wsA)).withdraw("D-1", { author: "user" });
    expect(withdrawn.entry.status).toBe("dropped");
    const file = entryPath(wsA, "decision", "D-1");
    const before = await readFile(file);
    const agent = await addMessage(db, wsA, "agent", "bring it back");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "original",
      status: "active",
      basis: "inferred",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    expect(await readFile(file)).toEqual(before);
  });

  test("rejects reviving a superseded requirement without the current task user message", async () => {
    const t = await runningTaskFor(wsA);
    const created = await req("POST", "/room/entries", t.runToken, upsert({
      title: "req",
      body: "old",
      sourceMessages: [t.messageId],
    }));
    expect(created.status).toBe(200);
    const superseded = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "old",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(superseded.status).toBe(200);
    const file = entryPath(wsA, "requirement", "R-1");
    const before = await readFile(file);
    const agent = await addMessage(db, wsA, "agent", "bring it back");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "old",
      status: "active",
      basis: "inferred",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    expect(await readFile(file)).toEqual(before);
  });

  test("accepts reviving a dropped decision when the current task user message is cited", async () => {
    const t = await runningTaskFor(wsA);
    await seedActiveDecision(t.runToken, t.messageId);
    await new KnowledgeStore(repoPath(dataDir, wsA)).withdraw("D-1", { author: "user" });
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "D-1",
      kind: "decision",
      title: "ship it",
      body: "original",
      status: "active",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.status).toBe("active");
  });

  test("accepts reviving a superseded requirement when the current task user message is cited", async () => {
    const t = await runningTaskFor(wsA);
    const created = await req("POST", "/room/entries", t.runToken, upsert({
      title: "req",
      body: "old",
      sourceMessages: [t.messageId],
    }));
    expect(created.status).toBe(200);
    const superseded = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "old",
      status: "superseded",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(superseded.status).toBe(200);
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      id: "R-1",
      title: "req",
      body: "old",
      status: "active",
      basis: "inferred",
      sourceMessages: [t.messageId],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.status).toBe("active");
  });

  test("rejects a decided entry from a report task that cites an older user message", async () => {
    const user = await postUserMessage(db, wsA, "earlier user");
    const userTask = await claimNextTask(db, "d-report-user");
    expect(userTask?.workspaceId).toBe(wsA);
    await finishTask(db, userTask!.id, { ok: true });
    const report = await addReportMessage(db, wsA, "done", {
      report: {
        agent: "test",
        gitCommonDir: "/tmp/report/.git",
        summary: "done",
        entries: [],
        commits: ["abcdef1"],
        files: [],
      },
      check: null,
    });
    await insertQueuedTask(db, wsA, report.id);
    const task = await claimNextTask(db, "d-report");
    expect(task?.messageId).toBe(report.id);
    const r = await req("POST", "/room/entries", task!.runToken!, upsert({
      kind: "decision",
      basis: "decided",
      sourceMessages: [user.message.id],
    }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual(evidenceBody());
    await expect(readFile(entryPath(wsA, "decision", "D-1"))).rejects.toThrow();
  });

  test("returns 404 when the entry disappears before the locked write", async () => {
    const t = await runningTaskFor(wsA);
    const created = await req("POST", "/room/entries", t.runToken, upsert({
      title: "req",
      body: "old",
      sourceMessages: [t.messageId],
    }));
    expect(created.status).toBe(200);
    const file = entryPath(wsA, "requirement", "R-1");
    const original = KnowledgeStore.prototype.get;
    let removed = false;
    KnowledgeStore.prototype.get = async function (this: KnowledgeStore, id: string) {
      const entry = await original.call(this, id);
      if (id === "R-1" && entry && !removed) {
        removed = true;
        await rm(file);
      }
      return entry;
    };
    try {
      const r = await req("POST", "/room/entries", t.runToken, upsert({
        id: "R-1",
        title: "req",
        body: "new",
        basis: "stated",
        sourceMessages: [t.messageId],
      }));
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "entry not found: R-1" });
    } finally {
      KnowledgeStore.prototype.get = original;
    }
  });

  test("accepts an inferred entry that cites only an agent message", async () => {
    const t = await runningTaskFor(wsA);
    const agent = await addMessage(db, wsA, "agent", "just a guess");
    const r = await req("POST", "/room/entries", t.runToken, upsert({
      kind: "decision",
      basis: "inferred",
      sourceMessages: [agent.id],
    }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.basis).toBe("inferred");
  });
});

const codeFunctionNames = PLUGINS.find((plugin) => plugin.id === "code")!.functions.filter((fn) => fn.readOnly).map((fn) => fn.name);
const WORKPACKAGE_NAMES = PLUGINS.find((plugin) => plugin.id === "superpowers")!.functions.map((fn) => fn.name);

let repoSeq = 0;
async function insertRepo(workspaceId: string, label: string, remoteUrl: string | null = null) {
  repoSeq += 1;
  const id = `repo_${label}`;
  const storedPath = `/repos/${workspaceId}/${label}`;
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url, created_at)
     values ($1, $2, $3, $4, $5, 'main', $7, $8, $6)`,
    [id, workspaceId, storedPath, `${storedPath}/.git`, label, new Date(Date.UTC(2026, 0, repoSeq)).toISOString(), remoteUrl !== null, remoteUrl],
  );
  return { id, label, path: storedPath, mainBranch: "main" };
}

type PluginCallRow = { task_id: string; name: string; args_summary: string; ok: boolean; result_bytes: number; ms: number };

describe("room plugins", () => {
  test("a disabled function is not offered and calling it is 403", async () => {
    const repo = await insertRepo(wsA, "api");
    await db.query(
      `insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions)
       values ($1, 'code', true, ARRAY['code__read'])`,
      [wsA],
    );
    const t = await runningTaskFor(wsA);
    const listed = await req("GET", "/room/plugins", t.runToken);
    expect(listed.status).toBe(200);
    const tools = ((await listed.json()) as { tools: { name: string; parameters: { properties: { repo: { description: string } } } }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([...codeFunctionNames.filter((name) => name !== "code__read"), "diagram__save", "diagram__read", ...WORKPACKAGE_NAMES]);
    expect(tools[0]?.parameters.properties.repo.description).toBe(`${repo.id} (${repo.label})`);
    const call = await req("POST", "/room/plugins/code__read", t.runToken, { repo: repo.id, path: "a.ts" });
    expect(call.status).toBe(403);
    expect(((await call.json()) as { error: string }).error).toBe("函数 code__read 未在本 workspace 开启");
    expect(otherCalls()).toEqual([]);
    expect(await db.query("select 1 from plugin_calls")).toEqual([]);
  });

  test("a call with another workspace's repo id is 400 and never reaches the daemon", async () => {
    await insertRepo(wsA, "api");
    const other = await insertRepo(wsB, "web");
    const t = await runningTaskFor(wsA);
    const r = await req("POST", "/room/plugins/code__search", t.runToken, { repo: other.id, query: "x" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe(`repo 不是本 workspace 绑定的仓库：${other.id}`);
    expect(otherCalls()).toEqual([]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_id: t.taskId, name: "code__search", ok: false, result_bytes: 0 });
    expect(rows[0]!.args_summary).toContain(other.id);
  });

  test("a call is forwarded with the resolved repo and recorded in plugin_calls", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    const args = { repo: repo.id, query: "login" };
    const result = { hits: ["a"] };
    daemonCall = async (method) => (method === "extensions.list" ? bundledExtensions() : result);
    const r = await req("POST", "/room/plugins/code__search", t.runToken, args);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ result });
    expect(otherCalls()).toEqual([
      {
        method: "plugin.call",
        params: {
          name: "code__search",
          args,
          taskId: t.taskId,
          repo: { workspaceId: wsA, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch },
        },
        // A cold call may build the graphify index first, which takes minutes on a real repo.
        timeoutMs: 300_000,
      },
    ]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_id: t.taskId,
      name: "code__search",
      args_summary: JSON.stringify(args),
      ok: true,
      result_bytes: Buffer.byteLength(JSON.stringify(result)),
    });
    expect(Number.isInteger(rows[0]!.ms)).toBe(true);
    expect(rows[0]!.ms).toBeGreaterThanOrEqual(0);
  });

  test("plugin_calls keeps the first 200 chars of the JSON args", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    const args = { repo: repo.id, query: "q".repeat(300) };
    daemonCall = async (method) => (method === "extensions.list" ? bundledExtensions() : "ok");
    const r = await req("POST", "/room/plugins/code__search", t.runToken, args);
    expect(r.status).toBe(200);
    const [row] = await db.query<{ args_summary: string }>("select args_summary from plugin_calls");
    expect(row!.args_summary).toBe(JSON.stringify(args).slice(0, 200));
    expect(row!.args_summary).toHaveLength(200);
  });

  test("daemon offline gives 503 with daemon 未连接", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    for (const message of ["daemon 未连接", "daemon 已断开", "daemon 响应超时"]) {
      daemonCall = async (method) => {
        if (method === "extensions.list") return bundledExtensions();
        throw new DaemonRpcError(message);
      };
      const r = await req("POST", "/room/plugins/code__search", t.runToken, { repo: repo.id, query: "q" });
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: string }).error).toBe(message);
    }
    const rows = await db.query<{ ok: boolean; result_bytes: number }>("select ok, result_bytes from plugin_calls order by id");
    expect(rows).toEqual([
      { ok: false, result_bytes: 0 },
      { ok: false, result_bytes: 0 },
      { ok: false, result_bytes: 0 },
    ]);
    expect(otherCalls().map((call) => call.method)).toEqual(["plugin.call", "plugin.call", "plugin.call"]);
  });

  test("a rejected call is recorded in plugin_calls and never reaches the daemon", async () => {
    await insertRepo(wsA, "api", "git@github.com:acme/api.git");
    await insertRepo(wsB, "web", "https://github.com/acme/web");
    await db.query(`insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions) values ($1, 'github', true, '{}')`, [wsA]);
    const t = await runningTaskFor(wsA);
    const other = await req("POST", "/room/plugins/github__list_issues", t.runToken, { owner: "acme", repo: "web" });
    expect(other.status).toBe(400);
    expect(((await other.json()) as { error: string }).error).toBe("只能访问本 workspace 绑定仓库的 GitHub：acme/web");
    const search = await req("POST", "/room/plugins/github__search_issues", t.runToken, { query: "is:open login" });
    expect(search.status).toBe(400);
    expect(((await search.json()) as { error: string }).error).toBe("搜索必须且只能限定为本 workspace 绑定的仓库（repo:owner/name）");
    expect(otherCalls()).toEqual([]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls order by id");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ task_id: t.taskId, name: "github__list_issues", ok: false, result_bytes: 0 });
    expect(rows[1]).toMatchObject({ task_id: t.taskId, name: "github__search_issues", ok: false, result_bytes: 0 });
  });

  test("an allowed GitHub call is forwarded with no repo payload", async () => {
    await insertRepo(wsA, "api", "https://github.com/Acme/API.git");
    await db.query(`insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions) values ($1, 'github', true, '{}')`, [wsA]);
    const t = await runningTaskFor(wsA);
    const args = { owner: "acme", repo: "api", pullNumber: 3, method: "get" };
    daemonCall = async (method) => (method === "extensions.list" ? bundledExtensions() : "PR #3");
    const r = await req("POST", "/room/plugins/github__pull_request_read", t.runToken, args);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ result: "PR #3" });
    expect(otherCalls()).toEqual([{ method: "plugin.call", params: { name: "github__pull_request_read", args }, timeoutMs: 90_000 }]);
    const rows = await db.query<PluginCallRow>("select task_id, name, args_summary, ok, result_bytes, ms from plugin_calls");
    expect(rows).toEqual([expect.objectContaining({ name: "github__pull_request_read", ok: true, result_bytes: Buffer.byteLength(JSON.stringify("PR #3")) })]);
  });

  test("a daemon error is 502 and recorded", async () => {
    const repo = await insertRepo(wsA, "api");
    const t = await runningTaskFor(wsA);
    daemonCall = async (method) => {
      if (method === "extensions.list") return bundledExtensions();
      throw new DaemonRpcError("graphify 失败");
    };
    const r = await req("POST", "/room/plugins/code__search", t.runToken, { repo: repo.id, query: "q" });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: string }).error).toBe("graphify 失败");
    const rows = await db.query<{ ok: boolean; result_bytes: number }>("select ok, result_bytes from plugin_calls");
    expect(rows).toEqual([{ ok: false, result_bytes: 0 }]);
  });
});

describe("implementation rules", () => {
  const check = {
    commitsExist: true,
    missingCommits: [],
    onMain: "yes" as const,
    filesOk: true,
    untouchedFiles: [],
    touchedFiles: [],
    checkedAt: "2026-10-23T10:01:00.000Z",
    mainSha: "2".repeat(40),
  };
  const reportInput = {
    agent: "claude-code",
    gitCommonDir: "/real/a/.git",
    summary: "实现了流式输出",
    entries: ["R-1"],
    commits: ["abcdef1"],
    files: ["src/a.ts"],
  };
  const impl = (status: string, evidence: Record<string, unknown> = {}) => ({
    status,
    evidence: { reportMessageId: null, commits: [], inferred: false, note: null, confirmedBy: null, ...evidence },
  });
  const VERIFIED_NEEDS_REPORT = "实现状态 verified 需要一条核实通过的上报作为证据（evidence.reportMessageId）。";

  test("the Agent cannot set verified without a passing report, nor for inferred evidence, nor set confirmedBy", async () => {
    const t = await runningTaskFor(wsA);
    const failing = await addReportMessage(db, wsA, "未合入", { report: reportInput, check: { ...check, onMain: "not-yet" } });
    const other = await addReportMessage(db, wsB, "别的 workspace", { report: reportInput, check });
    const passing = await addReportMessage(db, wsA, "通过", { report: reportInput, check });
    const cases: [Record<string, unknown>, string][] = [
      [impl("verified"), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: failing.id, commits: ["abcdef1"] }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: other.id, commits: ["abcdef1"] }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: t.messageId }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: passing.id, commits: ["1234567"] }), VERIFIED_NEEDS_REPORT],
      [impl("verified", { reportMessageId: passing.id, commits: ["abcdef1"], inferred: true }), "代码推断的实现只能由用户确认为 verified。"],
      [impl("reported", { inferred: true, confirmedBy: "user" }), "confirmedBy 只能由用户确认设置。"],
    ];
    for (const [implementation, error] of cases) {
      const r = await req("POST", "/room/entries", t.runToken, upsert({ sourceMessages: [t.messageId], implementation }));
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe(error);
    }
    expect(((await (await req("GET", "/room/entries", t.runToken)).json()) as any).entries).toEqual([]);
  });

  test("the Agent can set verified citing a passing report", async () => {
    const t = await runningTaskFor(wsA);
    const passing = await addReportMessage(db, wsA, "通过", { report: reportInput, check });
    const implementation = impl("verified", { reportMessageId: passing.id, commits: ["abcdef1"] });
    const r = await req("POST", "/room/entries", t.runToken, upsert({ sourceMessages: [t.messageId, passing.id], implementation }));
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).entry.implementation).toEqual(implementation);
    const inferred = impl("reported", { commits: ["abcdef1"], inferred: true });
    const r2 = await req("POST", "/room/entries", t.runToken, upsert({ sourceMessages: [t.messageId], basis: "inferred", implementation: inferred }));
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).entry.implementation).toEqual(inferred);
  });
});


describe("external source evidence", () => {
  const evidenceError = "引用外部来源时，把条目标成 stated 或 decided 需要当前这条用户消息里的逐字摘录。外部文档不能代替这个确认。";
  async function source(ws = wsA) {
    const payload = { schemaVersion: 1 as const, provider: "fake", resourceId: "doc", revision: "r1", title: "Source", canonicalUrl: "https://example.com/doc", excerpts: [{ locator: "p1", text: "external text" }] };
    const { sha256 } = await import("../src/db/snapshot.js");
    const { importSourceSnapshot } = await import("../src/sourceImport.js");
    return (await importSourceSnapshot(db, dataDir, ws, { ...payload, fetchedAt: "2026-01-01T00:00:00Z", contentHash: sha256(canonicalJson(payload)) })).entry;
  }
  const ref = (s: any) => ({ sourceEntryId: s.id, revision: s.sourceSnapshot.revision, snapshotHash: s.sourceSnapshot.contentHash });
  test("rejects a decided entry with source refs when the quote is only in an old version", async () => {
    const t = await runningTaskFor(wsA); const s = await source();
    await db.query("insert into message_versions(message_id, version, content) values ($1,1,'old wording')", [t.messageId]);
    const r = await req("POST", "/room/entries", t.runToken, upsert({ kind: "decision", basis: "decided", sourceMessages: [t.messageId], sourceRefs: [ref(s)], quotes: [{ messageId: t.messageId, text: "old wording" }] }));
    expect(r.status).toBe(409); expect((await r.json() as any).error).toBe(evidenceError);
  });
  test.each(["decided", "inferred"])("accepts a %s entry with valid source refs", async basis => {
    const t = await runningTaskFor(wsA); const s = await source();
    const r = await req("POST", "/room/entries", t.runToken, upsert({ basis, sourceMessages: [t.messageId], sourceRefs: [ref(s)], ...(basis === "decided" ? { quotes: [{ messageId: t.messageId, text: "memo" }] } : {}) }));
    expect(r.status).toBe(200); expect((await r.json() as any).entry.sourceRefs).toEqual([ref(s)]);
  });
  test.each(["revision", "snapshotHash", "quote", "workspace"])("rejects an invalid source ref: %s", async field => {
    const t = await runningTaskFor(wsA); const s = await source(field === "workspace" ? wsB : wsA);
    const bad = { ...ref(s), ...(field === "revision" ? { revision: "old" } : field === "snapshotHash" ? { snapshotHash: "a".repeat(64) } : field === "quote" ? { locator: "p1", quote: "absent" } : {}) };
    const r = await req("POST", "/room/entries", t.runToken, upsert({ basis: "inferred", sourceMessages: [t.messageId], sourceRefs: [bad] }));
    expect(r.status).toBe(400);
    expect((await r.json() as any).error).toBe(field === "workspace" ? "sourceRefs: unknown source entry S-1" : field === "quote" ? "sourceRefs: quote must be copied verbatim from excerpt p1 of S-1" : `sourceRefs: ${field} must match the current snapshot of S-1`);
  });
  test.each([false, true])("rejects a stated rewrite or clearing refs without a current quote (%s)", async clear => {
    const t = await runningTaskFor(wsA); const s = await source();
    const ks = new KnowledgeStore(repoPath(dataDir, wsA));
    const saved = await ks.upsert(upsert({ basis: "stated", sourceRefs: [ref(s)] }) as any, { author: "user" });
    const file = entryPath(wsA, "requirement", saved.entry.id); const before = await readFile(file);
    const r = await req("POST", "/room/entries", t.runToken, upsert({ id: saved.entry.id, body: "rewrite", basis: clear ? "decided" : "stated", sourceMessages: [t.messageId], ...(clear ? { sourceRefs: [] } : {}) }));
    expect(r.status).toBe(409); expect((await r.json() as any).error).toBe(evidenceError); expect(await readFile(file)).toEqual(before);
  });
  test.each(["body", "basis", "confirmed"])("protects a snapshotted source from agent %s changes", async field => {
    const t = await runningTaskFor(wsA); const s = await source(); const file = entryPath(wsA, "source", s.id); const before = await readFile(file);
    const r = await req("POST", "/room/entries", t.runToken, upsert({ id: s.id, kind: "source", title: s.title, body: field === "body" ? "changed" : s.body, url: s.url, basis: field === "basis" ? "stated" : s.basis, sourceMessages: [t.messageId], quotes: [{ messageId: t.messageId, text: "memo" }], confirmed: field === "confirmed" }));
    expect(r.status).toBe(field === "confirmed" ? 200 : 409);
    if (field !== "confirmed") { expect((await r.json() as any).error).toBe(field === "basis" ? "导入的来源不能由 Agent 改 basis。只有界面的 promote_basis 事件可以。" : "导入的来源快照不能用 upsert 修改"); expect(await readFile(file)).toEqual(before); }
    else expect((await r.json() as any).entry.confirmedAt).toBe(s.confirmedAt);
  });
  test("does not consume an evidence event supplied by the agent", async () => {
    const t = await runningTaskFor(wsA); const s = await source(); const ks = new KnowledgeStore(repoPath(dataDir, wsA));
    const saved = await ks.upsert(upsert({ kind: "decision", basis: "inferred", sourceRefs: [ref(s)] }) as any, { author: "agent" });
    const { insertEvidenceEvent } = await import("../src/evidenceEvents.js");
    const event = await insertEvidenceEvent(db, { workspaceId: wsA, entryId: saved.entry.id, kind: "promote_basis", targetBasis: "decided", contentHash: "a".repeat(64), refsHash: "b".repeat(64) });
    const r = await req("POST", "/room/entries", t.runToken, upsert({ id: saved.entry.id, kind: "decision", basis: "decided", sourceMessages: [t.messageId], confirmationEventId: event.id }));
    expect(r.status).toBe(409); expect((await ks.get(saved.entry.id))?.basis).toBe("inferred");
    expect(await db.query("select consumed_commit from evidence_events where id=$1", [event.id])).toEqual([{ consumed_commit: null }]);
  });
  test("counts a source refs change as an active decision rewrite", async () => {
    const t = await runningTaskFor(wsA); const s = await source(); const ks = new KnowledgeStore(repoPath(dataDir, wsA));
    const saved = await ks.upsert(upsert({ kind: "decision", basis: "decided", sourceRefs: [ref(s)] }) as any, { author: "user" });
    const file = entryPath(wsA, "decision", saved.entry.id); const before = await readFile(file);
    const r = await req("POST", "/room/entries", t.runToken, upsert({ id: saved.entry.id, kind: "decision", basis: "inferred", sourceMessages: [t.messageId], sourceRefs: [] }));
    expect(r.status).toBe(409); expect((await r.json() as any).error).toBe(decisionGuardError(saved.entry.id)); expect(await readFile(file)).toEqual(before);
  });

  test("rejects a decided entry with source refs from a system task that cites an older user message", async () => {
    const t = await runningTaskFor(wsA); const s = await source(); await finishTask(db, t.taskId, { ok: true });
    await postSystemTask(db, wsA, "system task"); const task = await claimNextTask(db, "system");
    const r = await req("POST", "/room/entries", task!.runToken!, upsert({ kind: "decision", basis: "decided", sourceMessages: [t.messageId], sourceRefs: [ref(s)], quotes: [{ messageId: t.messageId, text: "memo" }] }));
    expect(r.status).toBe(409); expect((await r.json() as any).error).toBe(USER_BASIS_EVIDENCE_ERROR);
  });

});

test("source checks and reimports project evidence on all four GET interfaces without rewriting decisions", async () => {
  const { importSourceSnapshot } = await import("../src/sourceImport.js");
  const { recordSourceCheck } = await import("../src/sourceFreshness.js");
  const { sha256 } = await import("../src/db/snapshot.js");
  const { createApp } = await import("../src/app.js");
  const t = await runningTaskFor(wsA);
  const snapshot = (text: string, revision: string | null) => {
    const payload = { schemaVersion: 1 as const, provider: "fake", resourceId: "freshness", revision, title: text, canonicalUrl: "https://example.com/doc", excerpts: [{ locator: "p1", text }] };
    return { ...payload, fetchedAt: new Date().toISOString(), contentHash: sha256(canonicalJson(payload)) };
  };
  const first = await importSourceSnapshot(db, dataDir, wsA, snapshot("A", "v1"));
  const ks = new KnowledgeStore(repoPath(dataDir, wsA));
  const decision = (await ks.upsert({ kind: "decision", title: "Dependent", body: "unchanged", reason: "test", basis: "inferred", sourceMessages: [], sourceRefs: [{ sourceEntryId: first.entry.id, revision: "v1", snapshotHash: first.entry.sourceSnapshot!.contentHash, locator: "p1" }] }, { author: "agent" })).entry;
  const file = entryPath(wsA, "decision", decision.id), before = await readFile(file, "utf8");
  await recordSourceCheck(db, dataDir, wsA, first.entry.id, { outcome: "ok", revision: "v2" });
  expect(await readFile(file, "utf8")).toBe(before);
  expect((await (await req("GET", `/room/entries/${decision.id}`, t.runToken)).json() as any).entry.reviewNeeded).toBe(true);
  await recordSourceCheck(db, dataDir, wsA, first.entry.id, { outcome: "timeout" });
  expect((await (await req("GET", `/room/entries/${decision.id}`, t.runToken)).json() as any).entry.reviewNeeded).toBe(false);
  await expect(recordSourceCheck(db, dataDir, wsB, first.entry.id, { outcome: "offline" })).rejects.toMatchObject({ status: 404 });
  await expect(recordSourceCheck(db, dataDir, wsA, decision.id, { outcome: "offline" })).rejects.toMatchObject({ status: 404 });
  const ui = createApp({ db, dataDir, nemaHome: dataDir, events, daemonStatus: () => true, daemon, webOrigin: "http://localhost:3000" });
  const uiReq = (method: string, suffix: string) => ui.request(`http://127.0.0.1:4400/api/workspaces/${wsA}/entries${suffix}`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
  expect((await uiReq("POST", `/${first.entry.id}/confirm`)).status).toBe(200);
  expect((await (await uiReq("GET", `/${first.entry.id}`)).json() as any).unconfirmedSnapshot).toBe(false);
  await importSourceSnapshot(db, dataDir, wsA, snapshot("B", null));
  await recordSourceCheck(db, dataDir, wsA, first.entry.id, { outcome: "ok", revision: "v3" });
  expect(await db.query("select freshness,reason from source_freshness where workspace_id=$1", [wsA])).toEqual([{ freshness: "unknown", reason: "incomparable" }]);
  const roomList = (await (await req("GET", "/room/entries", t.runToken)).json() as any).entries;
  const roomGet = (await (await req("GET", `/room/entries/${first.entry.id}`, t.runToken)).json() as any).entry;
  const uiList = await (await uiReq("GET", "")).json() as any[];
  const uiGet = await (await uiReq("GET", `/${first.entry.id}`)).json();
  for (const entry of [roomList.find((e: any) => e.id === first.entry.id), roomGet, uiList.find((e: any) => e.id === first.entry.id), uiGet]) {
    expect(entry).toMatchObject({ basis: "stated", freshness: "unknown", reviewNeeded: false, unconfirmedSnapshot: true });
  }
  expect(roomList.find((e: any) => e.id === decision.id)).toMatchObject({ reviewNeeded: true, unconfirmedSnapshot: false });
  expect(await readFile(file, "utf8")).toBe(before);
  const nullDecision = (await ks.upsert({ kind: "decision", title: "Null revision dependency", body: "stable", reason: "test", basis: "inferred", sourceMessages: [], sourceRefs: [{ sourceEntryId: first.entry.id, revision: null, snapshotHash: snapshot("B", null).contentHash }] }, { author: "agent" })).entry;
  const nullFile = entryPath(wsA, "decision", nullDecision.id), nullBefore = await readFile(nullFile, "utf8");
  await importSourceSnapshot(db, dataDir, wsA, snapshot("C", null));
  expect((await (await req("GET", `/room/entries/${nullDecision.id}`, t.runToken)).json() as any).entry).toMatchObject({ reviewNeeded: true, freshness: "unknown" });
  expect(await readFile(nullFile, "utf8")).toBe(nullBefore);
});
