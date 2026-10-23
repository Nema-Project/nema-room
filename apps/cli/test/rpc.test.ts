import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { TaskAssign } from "@nema/shared";
import { connectDaemon } from "../src/daemon/connection.js";
import { RpcRouter } from "../src/daemon/rpc.js";
import { Runner, type AgentAdapter } from "../src/daemon/runner.js";

test("RpcRouter answers a registered method", async () => {
  const rpc = new RpcRouter();
  rpc.register("code__read", async (params) => ({ text: (params as { path: string }).path }));
  await expect(rpc.handle({ type: "rpc.request", id: "1", method: "code__read", params: { path: "a.ts" } })).resolves.toEqual({
    type: "rpc.response",
    id: "1",
    ok: true,
    result: { text: "a.ts" },
  });
});

test("unknown method returns 未知方法", async () => {
  const rpc = new RpcRouter();
  await expect(rpc.handle({ type: "rpc.request", id: "1", method: "nope", params: {} })).resolves.toEqual({
    type: "rpc.response",
    id: "1",
    ok: false,
    error: "未知方法 nope",
  });
});

test("a throwing handler returns ok:false with its message", async () => {
  const rpc = new RpcRouter();
  rpc.register("boom", async () => {
    throw new Error("kaboom");
  });
  await expect(rpc.handle({ type: "rpc.request", id: "2", method: "boom", params: {} })).resolves.toEqual({
    type: "rpc.response",
    id: "2",
    ok: false,
    error: "kaboom",
  });
});

const task = (id: string): TaskAssign => ({
  type: "task.assign",
  taskId: id,
  workspaceId: "w",
  adapter: "codex",
  confidential: false,
  prompt: "p",
  runToken: "rt",
  hubUrl: "h",
  pluginTools: [],
});

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;
let conns: WebSocket[] = [];
const closers: Array<() => void> = [];

async function start(): Promise<number> {
  const httpServer = http.createServer();
  server = httpServer;
  wss = new WebSocketServer({ server, path: "/daemon" });
  wss.on("connection", (ws) => conns.push(ws));
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  return (httpServer.address() as AddressInfo).port;
}
async function stop(): Promise<void> {
  if (!wss) return;
  for (const c of wss.clients) c.terminate();
  const httpServer = server;
  if (!httpServer) return;
  httpServer.closeAllConnections();
  await new Promise<void>((r) => httpServer.close(() => r()));
}
afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await stop().catch(() => {});
  conns = [];
});

function nextMsg(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout " + type)), 3000);
    const h = (d: WebSocket.RawData) => {
      const m = JSON.parse(String(d)) as Record<string, unknown>;
      if (m.type === type) {
        clearTimeout(t);
        ws.off("message", h);
        resolve(m);
      }
    };
    ws.on("message", h);
  });
}

test("an rpc.request is answered while a task is running", async () => {
  const port = await start();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let markStarted!: () => void;
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const adapter: AgentAdapter = {
    name: "codex-direct",
    async run() {
      markStarted();
      await gate;
      return { ok: true, reply: "done" };
    },
  };
  const rpc = new RpcRouter();
  rpc.register("code__read", async () => ({ text: "hi" }));
  const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([adapter]), rpc });
  closers.push(() => {
    release();
    d.close();
  });
  for (let i = 0; i < 100 && conns.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  const ws = conns[0]!;
  ws.send(JSON.stringify(task("t1")));
  await started;
  const res = nextMsg(ws, "rpc.response");
  ws.send(JSON.stringify({ type: "rpc.request", id: "r1", method: "code__read", params: { path: "a.ts" } }));
  await expect(res).resolves.toEqual({ type: "rpc.response", id: "r1", ok: true, result: { text: "hi" } });
});
