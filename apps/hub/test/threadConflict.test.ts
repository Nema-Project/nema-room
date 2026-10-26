import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { KnowledgeStore } from "@nema/knowledge";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { roomRoutes } from "../src/roomApi.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { addMessage, listThreadMessages, postUserMessage, type AgentMessage } from "../src/messages.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";
import { ensureThread } from "../src/threads.js";
import { getTask, listTaskChanges, toUiTask } from "../src/tasks.js";
import { KIND_DIR } from "@nema/shared";

type WireMessage = Record<string, any>;
type Client = {
  ws: WebSocket;
  next(type: string): Promise<WireMessage>;
  send(message: WireMessage): void;
};

let db: Db;
let dataDir: string;
let workspaceId: string;
let events: EventBus;
let app: ReturnType<typeof roomRoutes>;
let server: http.Server;
let hub: ReturnType<typeof attachDaemonSocket>;
let socket: Client;
let url: string;
let clientSocket: WebSocket | undefined;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  events = new EventBus();
  workspaceId = (await createWorkspace(db, dataDir, "Conflict regression")).id;
  server = http.createServer();
  hub = attachDaemonSocket(server, { db, dataDir, events, daemonToken: "test-daemon-token", hubUrl: "http://hub.test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/daemon`;
  app = roomRoutes({ db, dataDir, events, daemon: hub.rpc });
  socket = await connectDaemon();
  await socket.next("welcome");
  const sync = await socket.next("rpc.request");
  expect(sync.method).toBe("repos.sync");
  socket.send({ type: "rpc.response", id: sync.id, ok: true, result: {} });
});

afterEach(async () => {
  clientSocket?.terminate();
  clientSocket = undefined;
  await hub.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(cleanupHubDeps);

function connectDaemon(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    clientSocket = ws;
    const queue: WireMessage[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (raw) => {
      queue.push(JSON.parse(String(raw)) as WireMessage);
      waiters.shift()?.();
    });
    ws.on("error", reject);
    const client: Client = {
      ws,
      send: (message) => ws.send(JSON.stringify(message)),
      async next(type) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const index = queue.findIndex((message) => message.type === type);
          if (index >= 0) return queue.splice(index, 1)[0]!;
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}`);
          await new Promise<void>((done) => {
            waiters.push(done);
            setTimeout(done, 50);
          });
        }
      },
    };
    ws.on("open", () => {
      client.send({ type: "hello", token: "test-daemon-token", version: "0", adapters: ["codex-direct"] });
      resolve(client);
    });
  });
}

const request = (method: string, path: string, token: string, body?: unknown) => app.request(path, {
  method,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

function entryPath(kind: "decision", id: string): string {
  return `${repoPath(dataDir, workspaceId)}/${KIND_DIR[kind]}/${id}.md`;
}

async function finishAssigned(reply: string): Promise<WireMessage> {
  const assignment = await socket.next("task.assign");
  socket.send({ type: "task.finished", taskId: assignment.taskId, ok: true, reply });
  await viWaitFor(async () => expect((await getTask(db, assignment.taskId))?.status).toBe("done"));
  return assignment;
}

async function viWaitFor(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function makeThreads() {
  const anchorA = (await postTurn("Thread A anchor")).message;
  const threadA = await ensureThread(db, anchorA.id, "Thread A", "user");
  const anchorB = (await postTurn("Thread B anchor")).message;
  const threadB = await ensureThread(db, anchorB.id, "Thread B", "user");
  // Drain the anchor tasks so each following turn is explicitly assigned to the intended thread.
  await finishAssigned("Thread A is ready.");
  await finishAssigned("Thread B is ready.");
  return { threadA, threadB };
}

async function postTurn(content: string, threadId?: string) {
  const posted = await postUserMessage(db, workspaceId, content, threadId ? { threadId } : {});
  events.emit(workspaceId, { type: "task.updated", task: toUiTask(posted.task) });
  return posted;
}

async function upsert(token: string, fields: Record<string, unknown>) {
  return request("POST", "/entries", token, {
    kind: "decision",
    title: "缓存策略",
    body: "缓存用 Redis",
    reason: "用户决定",
    basis: "decided",
    ...fields,
  });
}

describe("thread decision conflict routing", () => {
  test("keeps an active decision intact and asks in the conflicting thread", async () => {
    const { threadA, threadB } = await makeThreads();
    const turnA = await postTurn("就这么定了：缓存用 Redis", threadA.id);
    const assignmentA = await socket.next("task.assign");
    expect(assignmentA.taskId).toBe(turnA.task.id);
    const created = await upsert(assignmentA.runToken, { sourceMessages: [turnA.message.id] });
    expect(created.status).toBe(200);
    expect(((await created.json()) as any).entry.id).toBe("D-1");
    socket.send({ type: "task.finished", taskId: assignmentA.taskId, ok: true, reply: "Redis is recorded." });
    await viWaitFor(async () => expect((await getTask(db, assignmentA.taskId))?.status).toBe("done"));

    const turnB = await postTurn("缓存可能要用本地 LRU", threadB.id);
    const assignmentB = await socket.next("task.assign");
    expect(assignmentB.taskId).toBe(turnB.task.id);
    const agentEvidence = await addMessage(db, workspaceId, "agent", "Maybe use LRU instead.");
    const blockedRewrite = await upsert(assignmentB.runToken, {
      id: "D-1",
      title: "缓存策略",
      body: "缓存用本地 LRU",
      sourceMessages: [agentEvidence.id],
    });
    expect(blockedRewrite.status).toBe(409);

    const asked = await request("POST", "/entries", assignmentB.runToken, {
      kind: "question",
      title: "缓存应该用 Redis 还是本地 LRU？",
      body: "你希望保留 Redis，还是改用本地 LRU？",
      reason: "thread B expressed a conflicting preference without explicitly overriding the prior decision",
      status: "open",
      priority: 2,
      related: ["D-1"],
      basis: "inferred",
      sourceMessages: [turnB.message.id],
      quotes: [{ messageId: turnB.message.id, text: turnB.message.content }],
    });
    expect(asked.status).toBe(200);
    const questionId = ((await asked.json()) as any).entry.id as string;
    expect(await listTaskChanges(db, assignmentB.taskId)).toContainEqual(expect.objectContaining({ entryId: questionId, kind: "question", op: "add" }));
    socket.send({ type: "task.finished", taskId: assignmentB.taskId, ok: true, reply: "Should I keep Redis or switch this cache to local LRU?" });
    await viWaitFor(async () => expect((await getTask(db, assignmentB.taskId))?.status).toBe("done"));

    const store = new KnowledgeStore(repoPath(dataDir, workspaceId));
    expect(await store.get("D-1")).toMatchObject({ id: "D-1", status: "active", body: "缓存用 Redis", sourceMessages: [turnA.message.id] });
    expect(await store.get(questionId)).toMatchObject({ id: questionId, kind: "question", related: ["D-1"], sourceMessages: [turnB.message.id], quotes: [{ messageId: turnB.message.id, text: turnB.message.content }] });
    const threadReplies = await listThreadMessages(db, threadB.id);
    expect(threadReplies.find((message): message is AgentMessage => message.role === "agent" && message.taskId === assignmentB.taskId)).toMatchObject({
      threadId: threadB.id,
      meta: { askedQuestion: { id: questionId } },
    });
  });

  test("accepts explicit user supersession of the active decision", async () => {
    const { threadA, threadB } = await makeThreads();
    const turnA = await postTurn("就这么定了：缓存用 Redis", threadA.id);
    const assignmentA = await socket.next("task.assign");
    const created = await upsert(assignmentA.runToken, { sourceMessages: [turnA.message.id] });
    expect(created.status).toBe(200);
    socket.send({ type: "task.finished", taskId: assignmentA.taskId, ok: true, reply: "Redis is recorded." });
    await viWaitFor(async () => expect((await getTask(db, assignmentA.taskId))?.status).toBe("done"));

    const turnB = await postTurn("改用本地 LRU，推翻 D-1", threadB.id);
    const assignmentB = await socket.next("task.assign");
    const rewritten = await upsert(assignmentB.runToken, {
      id: "D-1",
      title: "缓存策略",
      body: "缓存用本地 LRU",
      status: "superseded",
      sourceMessages: [turnB.message.id],
    });
    expect(rewritten.status).toBe(200);
    expect(((await rewritten.json()) as any).entry).toMatchObject({ id: "D-1", status: "superseded", body: "缓存用本地 LRU", basis: "decided" });
    socket.send({ type: "task.finished", taskId: assignmentB.taskId, ok: true, reply: "Redis is superseded; local LRU is now the decision." });
    await viWaitFor(async () => expect((await getTask(db, assignmentB.taskId))?.status).toBe("done"));
  });
});
