import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { TaskAssign } from "@nema/shared";
import { DAEMON_FEATURES } from "../src/attachments/capabilities.js";
import { connectDaemon, VERSION_SKEW_ERROR } from "../src/daemon/connection.js";
import { Runner, type AgentAdapter } from "../src/daemon/runner.js";

let server: http.Server;
let wss: WebSocketServer;
let conns: WebSocket[] = [];
let closers: Array<() => Promise<void>> = [];

async function start(port = 0): Promise<number> {
  server = http.createServer();
  wss = new WebSocketServer({ server, path: "/daemon" });
  wss.on("connection", (ws) => conns.push(ws));
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}
async function stop(): Promise<void> {
  for (const c of wss.clients) c.terminate();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await stop().catch(() => {});
  conns = [];
});

const task = (id: string): TaskAssign => ({ type: "task.assign", taskId: id, workspaceId: "w", adapter: "codex", confidential: false, prompt: "p", runToken: "rt", hubUrl: "h", pluginTools: [] });

function nextMsg(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout " + type)), 3000);
    const h = (d: WebSocket.RawData) => {
      const m = JSON.parse(String(d));
      if (m.type === type) {
        clearTimeout(t);
        ws.off("message", h);
        resolve(m);
      }
    };
    ws.on("message", h);
  });
}
const waitConn = async (n: number) => {
  for (let i = 0; i < 100 && conns.length < n; i++) await new Promise((r) => setTimeout(r, 20));
  expect(conns.length).toBeGreaterThanOrEqual(n);
  return conns[n - 1]!;
};

describe("daemon connection", () => {
  test("hello, assign -> events + finished", async () => {
    const port = await start();
    const adapter: AgentAdapter = {
      name: "codex-direct",
      async run(_t, onEvent) {
        onEvent({ type: "progress", text: "hi" });
        return { ok: true, reply: "ok!" };
      },
    };
    const hello = new Promise<any>((resolve) => wss.on("connection", (ws) => nextMsg(ws, "hello").then(resolve)));
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([adapter]) });
    closers.push(() => d.close());
    expect(await hello).toMatchObject({ type: "hello", token: "tk", adapters: ["codex-direct"] });
    const ws = await waitConn(1);
    const ev = nextMsg(ws, "task.event");
    const fin = nextMsg(ws, "task.finished");
    ws.send(JSON.stringify(task("t1")));
    expect(await ev).toMatchObject({ taskId: "t1", event: { type: "progress", text: "hi" } });
    expect(await fin).toMatchObject({ taskId: "t1", ok: true, reply: "ok!" });
  });

  test("hello advertises exactly the daemon's features", async () => {
    const port = await start();
    const hello = new Promise<any>((resolve) => wss.on("connection", (ws) => nextMsg(ws, "hello").then(resolve)));
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([]) });
    closers.push(() => d.close());
    const features = (await hello).features;
    expect(features).toEqual([...DAEMON_FEATURES]);
    // Until the adapters deliver attachments, advertising them would let the hub send what gets dropped.
    expect(features).not.toContain("attachments");
  });

  test("hello carries the real CLI version, not 0.0.0", async () => {
    const port = await start();
    const hello = new Promise<any>((resolve) => wss.on("connection", (ws) => nextMsg(ws, "hello").then(resolve)));
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([{ name: "codex-direct", run: async () => ({ ok: true, reply: "" }) }]) });
    closers.push(() => d.close());
    const v = (await hello).version;
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
    expect(v).not.toBe("0.0.0");
  });

  test("a task.assign that fails schema parsing finishes ok:false instead of vanishing; other junk is logged", async () => {
    const port = await start();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([{ name: "codex-direct", run: async () => ({ ok: true, reply: "" }) }]) });
      closers.push(() => d.close());
      const ws = await waitConn(1);
      const fin = nextMsg(ws, "task.finished");
      const { adapter: _drop, ...old } = task("t9"); // a hub whose assign this daemon cannot parse
      ws.send(JSON.stringify({ ...old, adapter: 42 }));
      expect(await fin).toEqual({ type: "task.finished", taskId: "t9", ok: false, error: "hub 与 nema CLI 版本不一致，请同时更新（重新构建 compose 并重启 nema daemon）" });
      ws.send(JSON.stringify({ type: "mystery" }));
      for (let i = 0; i < 50 && err.mock.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(err.mock.calls.some((c) => String(c[0]).includes("unparseable"))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  test("adapter throw becomes ok:false", async () => {
    const port = await start();
    const adapter: AgentAdapter = { name: "codex-direct", run: async () => { throw new Error("kaboom"); } };
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([adapter]) });
    closers.push(() => d.close());
    const ws = await waitConn(1);
    const fin = nextMsg(ws, "task.finished");
    ws.send(JSON.stringify(task("t1")));
    expect(await fin).toMatchObject({ ok: false, error: expect.stringContaining("kaboom") });
  });

  test("reconnects after server closes and says hello again", async () => {
    const port = await start();
    const runner = new Runner([{ name: "codex-direct", run: async () => ({ ok: true, reply: "" }) }]);
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner, reconnectMs: 50 });
    closers.push(() => d.close());
    const first = await waitConn(1);
    await nextMsg(first, "hello").catch(() => null);
    await stop();
    conns = [];
    const hello = new Promise<any>((resolve) => {
      server = http.createServer();
      wss = new WebSocketServer({ server, path: "/daemon" });
      wss.on("connection", (ws) => {
        conns.push(ws);
        nextMsg(ws, "hello").then(resolve);
      });
    });
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
    expect(await hello).toMatchObject({ type: "hello", token: "tk" });
    expect(conns).toHaveLength(1);
  });

  test("intentional close never reconnects", async () => {
    const port = await start();
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([]), reconnectMs: 20 });
    await waitConn(1);
    await d.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(conns).toHaveLength(1);
  });

  test("welcome reconciles and workspace.deleted removes isolation dirs, after a running task", async () => {
    const port = await start();
    const nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
    const dir = (id: string) => path.join(nemaHome, "ws", id);
    for (const id of ["ws_live", "ws_stale", "ws_later"]) mkdirSync(path.join(dir(id), "codex-home"), { recursive: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sawStaleWhileRunning: boolean | null = null;
    const adapter: AgentAdapter = {
      name: "codex-direct",
      async run() {
        await gate;
        sawStaleWhileRunning = existsSync(dir("ws_stale"));
        return { ok: true, reply: "" };
      },
    };
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([adapter]), nemaHome });
    closers.push(() => d.close());
    const ws = await waitConn(1);
    const fin = nextMsg(ws, "task.finished");
    ws.send(JSON.stringify(task("t1"))); // occupies the runner: cleanup must wait for it
    ws.send(JSON.stringify({ type: "welcome", workspaceIds: ["ws_live", "ws_later"] }));
    ws.send(JSON.stringify({ type: "workspace.deleted", workspaceId: "ws_later" }));
    ws.send(JSON.stringify({ type: "workspace.deleted", workspaceId: "../../etc" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(dir("ws_stale"))).toBe(true);
    release();
    await fin;
    expect(sawStaleWhileRunning).toBe(true);
    for (let i = 0; i < 100 && existsSync(dir("ws_later")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(dir("ws_stale"))).toBe(false);
    expect(existsSync(dir("ws_later"))).toBe(false);
    expect(existsSync(dir("ws_live"))).toBe(true);
  });

  test("without nemaHome the daemon leaves isolation dirs alone", async () => {
    const port = await start();
    const nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
    mkdirSync(path.join(nemaHome, "ws", "ws_stale"), { recursive: true });
    const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([{ name: "codex-direct", run: async () => ({ ok: true, reply: "" }) }]) });
    closers.push(() => d.close());
    const ws = await waitConn(1);
    ws.send(JSON.stringify({ type: "welcome", workspaceIds: [] }));
    ws.send(JSON.stringify({ type: "workspace.deleted", workspaceId: "ws_stale" }));
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(path.join(nemaHome, "ws", "ws_stale"))).toBe(true);
  });

  test("runner executes tasks serially", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const adapter: AgentAdapter = {
      name: "codex-direct",
      async run(t) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        order.push(t.taskId);
        return { ok: true, reply: t.taskId };
      },
    };
    const runner = new Runner([adapter]);
    const done: string[] = [];
    await new Promise<void>((resolve) => {
      for (const id of ["a", "b"]) runner.enqueue(task(id), () => {}, (r) => { done.push(id); if (done.length === 2) resolve(); void r; });
    });
    expect(maxActive).toBe(1);
    expect(order).toEqual(["a", "b"]);
  });

  test("welcome prints an observable connection signal", async () => {
    const port = await start();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([{ name: "codex-direct", run: async () => ({ ok: true, reply: "" }) }]) });
      closers.push(() => d.close());
      const ws = await waitConn(1);
      ws.send(JSON.stringify({ type: "welcome", workspaceIds: [] }));
      const line = `[nema] daemon connected to http://127.0.0.1:${port}`;
      for (let i = 0; i < 50 && !log.mock.calls.some((c) => c[0] === line); i++) await new Promise((r) => setTimeout(r, 20));
      expect(log.mock.calls.some((c) => c[0] === line)).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test("a skew rejection prints install guidance and does not reconnect", async () => {
    const port = await start();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([]), reconnectMs: 30 });
      closers.push(() => d.close());
      const ws = await waitConn(1);
      ws.send(JSON.stringify({ type: "error", message: "hub 与 nema CLI 版本不一致（hub 1.2.3），请安装 @nema-project/nema@1.2.3" }));
      ws.close();
      await new Promise((r) => setTimeout(r, 120));
      expect(conns).toHaveLength(1);
      const text = err.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("hub 与 nema CLI 版本不一致（hub 1.2.3），请安装 @nema-project/nema@1.2.3");
      expect(text).toContain("run: npm i -g @nema-project/nema@1.2.3");
      expect(text).not.toMatch(/run: npm i -g nema@/);
    } finally {
      err.mockRestore();
    }
  });

  test("a skew rejection without a hub version tells the user to look it up", async () => {
    const port = await start();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const d = connectDaemon({ hubUrl: `http://127.0.0.1:${port}`, token: "tk", runner: new Runner([]) });
      closers.push(() => d.close());
      const ws = await waitConn(1);
      ws.send(JSON.stringify({ type: "error", message: VERSION_SKEW_ERROR }));
      const text = () => err.mock.calls.map((c) => String(c[0])).join("\n");
      for (let i = 0; i < 50 && !text().includes("@nema-project/nema@<hub 版本>"); i++) await new Promise((r) => setTimeout(r, 20));
      expect(text()).toContain(VERSION_SKEW_ERROR);
      expect(text()).toContain("run: npm i -g @nema-project/nema@<hub 版本>");
      expect(text()).toContain("请先查看正在运行的 hub 的版本");
    } finally {
      err.mockRestore();
    }
  });
});
