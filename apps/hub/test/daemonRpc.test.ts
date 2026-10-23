import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import WebSocket from "ws";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { DaemonRpcError } from "../src/daemonRpc.js";
import { EventBus } from "../src/events.js";
import type { Db } from "../src/db/db.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const TOKEN = "tok";
let db: Db;
let dataDir: string;
let server: http.Server;
let url: string;
let handle: ReturnType<typeof attachDaemonSocket>;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  const events = new EventBus();
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

function connect(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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
      client.send({ type: "hello", token: TOKEN, version: "0", adapters: ["codex-direct"] });
      resolve(client);
    });
  });
}

async function hello(): Promise<Client> {
  const c = await connect();
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
