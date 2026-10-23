import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { afterAll, expect, test } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { EventBus } from "../src/events.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

let home = "";
afterAll(async () => {
  await cleanupHubDeps();
  if (home) await rm(home, { recursive: true, force: true });
});

/** Real node HTTP server wiring as in main.ts: Host guard on /api, daemon WebSocket on /daemon. */
test("over real HTTP: loopback Host passes, foreign Host is 403, /daemon WebSocket still connects", async () => {
  const { db, dataDir } = await makeHubDeps();
  home = await mkdtemp(path.join(tmpdir(), "nema-home-"));
  const events = new EventBus();
  let listener: http.RequestListener = (_q, s) => s.end();
  const server = http.createServer((q, s) => listener(q, s));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  listener = getRequestListener(createApp({ db, dataDir, nemaHome: home, events, daemonStatus: () => false, daemon: { call: () => Promise.reject(new Error("daemon 未连接")) }, port }).fetch);
  attachDaemonSocket(server, { db, dataDir, events, daemonToken: "tok", hubUrl: `http://127.0.0.1:${port}` });
  try {
    const get = (host: string) =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: "127.0.0.1", port, path: "/api/workspaces", headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        }).on("error", reject);
      });
    expect(await get(`127.0.0.1:${port}`)).toBe(200);
    expect(await get(`localhost:${port}`)).toBe(200);
    expect(await get(`evil.example:${port}`)).toBe(403);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
    const welcome = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: "tok", version: "0", adapters: ["codex-direct"] })));
      ws.on("message", (d) => resolve(JSON.parse(String(d)).type));
      ws.on("error", reject);
    });
    expect(welcome).toBe("welcome");
    ws.terminate();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
