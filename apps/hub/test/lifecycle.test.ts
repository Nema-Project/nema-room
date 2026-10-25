import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { createLocalDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace } from "../src/workspaces.js";

const roots: string[] = [];
const running: Array<{ close(): Promise<void> }> = [];
const databases: Array<{ close(): Promise<void> }> = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "nema-lifecycle-"));
  roots.push(root);
  const db = await createLocalDb(path.join(root, "db"));
  databases.push(db);
  return { root, db };
}
afterEach(async () => {
  await Promise.all(running.splice(0).map((hub) => hub.close().catch(() => {})));
  await Promise.all(databases.splice(0).map((db) => db.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("import does not listen", async () => {
  const listen = vi.spyOn(net.Server.prototype, "listen");
  const module = await import("../src/lifecycle.js");
  expect(typeof module.startHub).toBe("function");
  expect(listen).not.toHaveBeenCalled();
  listen.mockRestore();
});

test("port zero advertises the real bound loopback port", async () => {
  const { root, db } = await fixture();
  const { startHub } = await import("../src/lifecycle.js");
  const hub = await startHub({ db, dataDir: path.join(root, "data"), nemaHome: path.join(root, "home"), daemonToken: "test-token", port: 0, webOrigin: "http://localhost:3000" });
  running.push(hub);
  const address = new URL(hub.url);
  expect(Number(address.port)).toBeGreaterThan(0);
  const response = await fetch(`${hub.url}/api/workspaces`, { headers: { host: `127.0.0.1:${address.port}` } });
  expect(response.status).toBe(200);
  await hub.close();
  expect(await db.query("select 1 as alive")).toEqual([{ alive: 1 }]);
});

test("close releases HTTP, WebSocket and fallback timer resources", async () => {
  const { root, db } = await fixture();
  const { startHub } = await import("../src/lifecycle.js");
  const hub = await startHub({ db, dataDir: path.join(root, "data"), nemaHome: path.join(root, "home"), daemonToken: "test-token", port: 0, webOrigin: "http://localhost:3000" });
  running.push(hub);
  const ws = new WebSocket(`${hub.url.replace(/^http/, "ws")}/daemon`);
  const welcome = new Promise<void>((resolve, reject) => {
    ws.once("open", () => ws.send(JSON.stringify({ type: "hello", token: "test-token", version: "test", adapters: ["codex-direct"] })));
    ws.on("message", (message) => {
      if (JSON.parse(String(message)).type === "welcome") resolve();
    });
    ws.once("error", reject);
  });
  await welcome;
  const workspace = await createWorkspace(db, path.join(root, "data"), "Lifecycle");
  const sse = await fetch(`${hub.url}/api/workspaces/${workspace.id}/events`);
  expect(sse.status).toBe(200);
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  await hub.close();
  await closed;
  await expect(fetch(hub.url)).rejects.toThrow();
  const stream = sse.body?.getReader();
  expect(await Promise.race([
    stream!.closed.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ])).toBe(true);
  await hub.close();
  expect(await db.query("select 1 as alive")).toEqual([{ alive: 1 }]);
});

test("failed startup cleans resources and leaves injected database open", async () => {
  const { root, db } = await fixture();
  const { startHub } = await import("../src/lifecycle.js");
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as net.AddressInfo).port;
  try {
    await expect(startHub({ db, dataDir: path.join(root, "data"), nemaHome: path.join(root, "home"), daemonToken: "test-token", port, webOrigin: "http://localhost:3000" })).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
  }
  expect(await db.query("select 1 as alive")).toEqual([{ alive: 1 }]);
});

test("close waits for an in-flight HTTP handler before returning", async () => {
  const { root, db } = await fixture();
  const { startHub } = await import("../src/lifecycle.js");
  let armed = false;
  let entered!: () => void;
  let release!: () => void;
  const queryEntered = new Promise<void>((resolve) => { entered = resolve; });
  const queryRelease = new Promise<void>((resolve) => { release = resolve; });
  const gatedDb: Db = {
    async query<T>(sql: string, params?: unknown[]) {
      if (armed && sql.includes("from workspaces order by created_at")) {
        armed = false;
        entered();
        await queryRelease;
      }
      return db.query<T>(sql, params);
    },
    tx: (fn) => db.tx(fn),
  };
  const hub = await startHub({ db: gatedDb, dataDir: path.join(root, "data"), nemaHome: path.join(root, "home"), daemonToken: "test-token", port: 0, webOrigin: "http://localhost:3000" });
  running.push(hub);
  armed = true;
  const request = fetch(`${hub.url}/api/workspaces`).catch(() => undefined);
  let closing: Promise<void> | undefined;
  try {
    await queryEntered;
    let closed = false;
    closing = hub.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);
  } finally {
    release();
    closing ??= hub.close();
    await closing;
    await request;
  }
  expect(await db.query("select 1 as alive")).toEqual([{ alive: 1 }]);
});

test("close waits for asynchronous cancellation of a response returned after shutdown starts", async () => {
  const { root, db } = await fixture();
  const { startHub } = await import("../src/lifecycle.js");
  let enterHandler!: () => void;
  let releaseHandler!: () => void;
  let enterCancellation!: () => void;
  let releaseCancellation!: () => void;
  const handlerEntered = new Promise<void>((resolve) => { enterHandler = resolve; });
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const cancellationEntered = new Promise<void>((resolve) => { enterCancellation = resolve; });
  const cancellationGate = new Promise<void>((resolve) => { releaseCancellation = resolve; });
  const hub = await startHub({
    db,
    dataDir: path.join(root, "data"),
    nemaHome: path.join(root, "home"),
    daemonToken: "test-token",
    port: 0,
    webOrigin: "http://localhost:3000",
    uiAuth: async () => {
      enterHandler();
      await handlerGate;
      return new Response(new ReadableStream<Uint8Array>({
        cancel: async () => {
          enterCancellation();
          await cancellationGate;
        },
      }));
    },
  });
  running.push(hub);
  const request = fetch(`${hub.url}/api/workspaces`).catch(() => undefined);
  let closing: Promise<void> | undefined;
  try {
    await handlerEntered;
    let closed = false;
    closing = hub.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(closed).toBe(false);

    releaseHandler();
    await cancellationEntered;
    expect(closed).toBe(false);
    releaseCancellation();
    await closing;
  } finally {
    releaseHandler();
    releaseCancellation();
    closing ??= hub.close();
    await closing;
    await request;
  }
  expect(await db.query("select 1 as alive")).toEqual([{ alive: 1 }]);
});
