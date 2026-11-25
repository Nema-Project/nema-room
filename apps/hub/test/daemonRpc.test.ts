import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { DaemonRpcError, withDaemonTarget } from "../src/daemonRpc.js";
import { EventBus } from "../src/events.js";
import type { Db } from "../src/db/db.js";
import { postUserMessage } from "../src/messages.js";
import { toUiTask } from "../src/tasks.js";
import { createWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const TOKEN = "tok";
let db: Db;
let dataDir: string;
let events: EventBus;
let server: http.Server;
let url: string;
let handle: ReturnType<typeof attachDaemonSocket>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  events = new EventBus();
  server = http.createServer();
  handle = attachDaemonSocket(server, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://hub.test" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/daemon`;
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
afterAll(cleanupHubDeps);

type Msg = Record<string, unknown>;
type Client = { ws: WebSocket; next(type?: string): Promise<Msg>; send(m: Msg): void };

function connect(token = TOKEN, targetUrl = url): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(targetUrl);
    sockets.push(ws);
    const queue: Msg[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => {
      queue.push(JSON.parse(String(d)) as Msg);
      waiters.shift()?.();
    });
    ws.on("error", reject);
    const client: Client = {
      ws,
      send: (m) => ws.send(JSON.stringify(m)),
      async next(type) {
        const deadline = Date.now() + 3000;
        for (;;) {
          const i = queue.findIndex((m) => !type || m.type === type);
          if (i >= 0) return queue.splice(i, 1)[0]!;
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${type ?? "message"}`);
          await new Promise<void>((r) => {
            waiters.push(r);
            setTimeout(r, 50);
          });
        }
      },
    };
    ws.on("open", () => {
      client.send({ type: "hello", token, version: "0", adapters: ["codex-direct"] });
      resolve(client);
    });
  });
}

async function hello(token = TOKEN, targetUrl = url): Promise<Client> {
  const c = await connect(token, targetUrl);
  await c.next("welcome");
  const sync = await c.next("rpc.request");
  expect(sync).toMatchObject({ method: "repos.sync", params: { repos: [] } });
  c.send({ type: "rpc.response", id: sync.id, ok: true, result: { ok: true } });
  return c;
}

test("call resolves with the daemon's result", async () => {
  const c = await hello();
  const pending = handle.rpc.call("code__read", { path: "a.ts" });
  const req = await c.next("rpc.request");
  expect(req).toMatchObject({ type: "rpc.request", method: "code__read", params: { path: "a.ts" } });
  c.send({ type: "rpc.response", id: req.id, ok: true, result: { text: "hi" } });
  await expect(pending).resolves.toEqual({ text: "hi" });
});

test("call rejects with daemon 未连接 when no daemon", async () => {
  const err = await handle.rpc.call("code__read", {}).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DaemonRpcError);
  expect((err as DaemonRpcError).message).toBe("daemon 未连接");
});

test("call rejects with daemon 响应超时 after the timeout", async () => {
  const c = await hello();
  const pending = handle.rpc.call("code__read", { path: "a.ts" }, 50);
  await c.next("rpc.request");
  const err = await pending.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DaemonRpcError);
  expect((err as DaemonRpcError).message).toBe("daemon 响应超时");
});

test("in-flight calls reject with daemon 已断开 when the socket closes", async () => {
  const c = await hello();
  const a = handle.rpc.call("code__read", { n: 1 }, 5_000);
  const b = handle.rpc.call("code__list", { n: 2 }, 5_000);
  await c.next("rpc.request");
  await c.next("rpc.request");
  c.ws.close();
  const errs = await Promise.all([a, b].map((p) => p.catch((e: unknown) => e)));
  expect(errs).toEqual([
    expect.objectContaining({ message: "daemon 已断开" }),
    expect.objectContaining({ message: "daemon 已断开" }),
  ]);
  for (const err of errs) expect(err).toBeInstanceOf(DaemonRpcError);
});

test("a response with an unknown id is ignored", async () => {
  const c = await hello();
  const pending = handle.rpc.call("code__read", { path: "a.ts" });
  const req = await c.next("rpc.request");
  c.send({ type: "rpc.response", id: "unknown", ok: true, result: { text: "nope" } });
  c.send({ type: "rpc.response", id: req.id, ok: true, result: { text: "real" } });
  await expect(pending).resolves.toEqual({ text: "real" });
});

test("call rejects with the daemon error text when it replies ok: false", async () => {
  const c = await hello();
  const pending = handle.rpc.call("code__read", { path: "a.ts" });
  const req = await c.next("rpc.request");
  c.send({ type: "rpc.response", id: req.id, ok: false, error: "nope" });
  const err = await pending.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(DaemonRpcError);
  expect((err as DaemonRpcError).message).toBe("nope");
});

describe("connection table: which daemon a call reaches (#167 task 10)", () => {
  async function answerNext(c: Client, result: unknown = { ok: true }): Promise<Msg> {
    const req = await c.next("rpc.request");
    c.send({ type: "rpc.response", id: req.id, ok: true, result });
    return req;
  }

  async function noRequest(c: Client, ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const got = await Promise.race([c.next("rpc.request").then(() => "request"), new Promise((r) => setTimeout(() => r("none"), 50))]);
    expect(got).toBe("none");
  }

  test("with one daemon, every target falls back to it (single-machine behavior unchanged)", async () => {
    const c = await hello();
    const calls = [
      handle.rpc.call("a", {}, undefined, { workspaceId: "w_unknown" }),
      handle.rpc.call("b", {}, undefined, { taskId: "t_unknown" }),
      handle.rpc.call("c", {}, undefined, { daemonId: "d_unknown" }),
      handle.rpc.call("d", {}, undefined, { all: true }),
    ];
    for (let i = 0; i < calls.length; i++) await answerNext(c, i);
    await expect(Promise.all(calls)).resolves.toEqual([0, 1, 2, 3]);
  });

  test("two daemons stay connected; an untargeted call reaches the newest connection", async () => {
    const first = await hello();
    const second = await hello();
    expect(first.ws.readyState).toBe(WebSocket.OPEN);
    expect(handle.connectedDaemonIds()).toHaveLength(2);
    const pending = handle.rpc.call("plugins.status", {});
    expect(await answerNext(second, "second")).toMatchObject({ method: "plugins.status" });
    await expect(pending).resolves.toBe("second");
    await noRequest(first);
  });

  test("a call for a running task reaches the daemon running it, even when another connected later", async () => {
    const workspace = await createWorkspace(db, dataDir, "Task routing");
    const runner = await hello();
    const { task } = await postUserMessage(db, workspace.id, "run me", { authorUserId: "usr_local" });
    events.emit(workspace.id, { type: "task.updated", task: toUiTask(task!) });
    expect((await runner.next("task.assign")).taskId).toBe(task!.id);
    const later = await hello();
    const pending = handle.rpc.call("plugin.call", { name: "x" }, undefined, { taskId: task!.id, workspaceId: workspace.id });
    await answerNext(runner, "from runner");
    await expect(pending).resolves.toBe("from runner");
    await noRequest(later);
  });

  test("a daemonId target reaches that connection; an unknown one falls back to the newest", async () => {
    const first = await hello();
    const second = await hello();
    const [firstId] = handle.connectedDaemonIds();
    const pinned = handle.rpc.call("repo.uncovered", {}, undefined, { daemonId: firstId! });
    await answerNext(first, "first");
    await expect(pinned).resolves.toBe("first");
    const unknown = handle.rpc.call("repo.uncovered", {}, undefined, { daemonId: "d_gone" });
    await answerNext(second, "second");
    await expect(unknown).resolves.toBe("second");
  });

  test("an all-daemons call reaches every connection", async () => {
    const first = await hello();
    const second = await hello();
    const pending = handle.rpc.call("repos.sync", { repos: [] }, undefined, { all: true });
    expect(await answerNext(first, "first")).toMatchObject({ method: "repos.sync" });
    expect(await answerNext(second, "second")).toMatchObject({ method: "repos.sync" });
    await expect(pending).resolves.toBe("first");
  });

  test("one daemon closing fails only its own in-flight calls", async () => {
    const first = await hello();
    const second = await hello();
    const [firstId, secondId] = handle.connectedDaemonIds();
    const onFirst = handle.rpc.call("code__read", {}, 5_000, { daemonId: firstId! });
    const onSecond = handle.rpc.call("code__read", {}, 5_000, { daemonId: secondId! });
    await first.next("rpc.request");
    const secondReq = await second.next("rpc.request");
    first.ws.close();
    await expect(onFirst).rejects.toMatchObject({ message: "daemon 已断开" });
    second.send({ type: "rpc.response", id: secondReq.id, ok: true, result: "alive" });
    await expect(onSecond).resolves.toBe("alive");
    expect(handle.isConnected()).toBe(true);
    expect(handle.isConnected(secondId!)).toBe(true);
    await vi.waitFor(() => expect(handle.isConnected(firstId!)).toBe(false));
  });

  test("withDaemonTarget binds a default target that an explicit target extends", async () => {
    const seen: unknown[] = [];
    const base = { call: async (_m: string, _p: unknown, _t?: number, target?: unknown) => { seen.push(target); return null; } };
    const scoped = withDaemonTarget(base, { taskId: "t_1", workspaceId: "w_1" });
    await scoped.call("a", {});
    await scoped.call("b", {}, undefined, { all: true });
    expect(seen).toEqual([{ taskId: "t_1", workspaceId: "w_1" }, { taskId: "t_1", workspaceId: "w_1", all: true }]);
  });
});

describe("connection table under remote auth: a workspace owner's daemon first", () => {
  let remoteServer: http.Server | undefined;
  let remote: ReturnType<typeof attachDaemonSocket> | undefined;

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await remote?.close();
    const httpServer = remoteServer;
    remote = undefined;
    remoteServer = undefined;
    if (!httpServer) return;
    httpServer.closeAllConnections();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  async function register(userId: string, label: string): Promise<{ id: string; credential: string }> {
    const { createDaemonRegistrationCode, registerDaemon } = await import("../src/daemons.js");
    return (await registerDaemon(db, (await createDaemonRegistrationCode(db, userId)).code, label))!;
  }

  test("a workspace call prefers a daemon owned by a workspace owner; otherwise the newest", async () => {
    await db.query("insert into users(id, display_name) values ('usr_alice','Alice'), ('usr_bob','Bob')");
    const alices = await createWorkspace(db, dataDir, "Alice's", undefined, "usr_alice");
    const nobodys = await createWorkspace(db, dataDir, "Nobody's");
    const alice = await register("usr_alice", "Alice laptop");
    const bob = await register("usr_bob", "Bob laptop");
    const httpServer = http.createServer();
    remoteServer = httpServer;
    remote = attachDaemonSocket(httpServer, { db, dataDir, events: new EventBus(), daemonToken: TOKEN, hubUrl: "http://hub.test", remoteAuth: true });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const remoteUrl = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}/daemon`;

    const aliceConn = await hello(alice.credential, remoteUrl);
    const bobConn = await hello(bob.credential, remoteUrl);
    expect(remote.connectedDaemonIds()).toEqual([alice.id, bob.id]);

    const owned = remote.rpc.call("repo.inspect", { path: "/x" }, undefined, { workspaceId: alices.id });
    await answerOn(aliceConn, "alice");
    await expect(owned).resolves.toBe("alice");

    const unowned = remote.rpc.call("repo.inspect", { path: "/y" }, undefined, { workspaceId: nobodys.id });
    await answerOn(bobConn, "bob");
    await expect(unowned).resolves.toBe("bob");

    const untargeted = remote.rpc.call("plugins.status", {});
    await answerOn(bobConn, "bob again");
    await expect(untargeted).resolves.toBe("bob again");
  });

  async function answerOn(c: Client, result: unknown): Promise<void> {
    const req = await c.next("rpc.request");
    c.send({ type: "rpc.response", id: req.id, ok: true, result });
  }
});
