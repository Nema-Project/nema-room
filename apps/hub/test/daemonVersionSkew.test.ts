import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { EventBus } from "../src/events.js";
import { readHubReleaseVersion } from "../src/hubVersion.js";
import { startHub } from "../src/lifecycle.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

let server: http.Server | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  if (!server) return;
  server.closeAllConnections();
  const closing = server;
  server = undefined;
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});
afterAll(cleanupHubDeps);

async function listen(releaseVersion?: string): Promise<number> {
  const { db, dataDir } = await makeHubDeps();
  server = http.createServer();
  attachDaemonSocket(server, {
    db,
    dataDir,
    events: new EventBus(),
    daemonToken: "tok",
    hubUrl: "http://hub.test",
    ...(releaseVersion ? { releaseVersion } : {}),
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const clients: WebSocket[] = [];

function hello(port: number, version: string): Promise<{ message: Record<string, unknown>; closed: Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
  clients.push(ws);
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  const message = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 3000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
  return new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "hello", token: "tok", version, adapters: ["codex-direct"] }));
      resolve({ message, closed });
    });
  });
}

describe("daemon version skew", () => {
  test("readHubReleaseVersion matches the CLI package version", () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "apps/cli/package.json"), "utf8")) as { version: string };
    expect(readHubReleaseVersion()).toBe(pkg.version);
  });

  test("a mismatched hello is rejected with the hub version", async () => {
    const port = await listen("1.2.3");
    const { message, closed } = await hello(port, "9.9.9");
    const error = await message;
    expect(error.type).toBe("error");
    expect(error.message).toContain("版本不一致");
    expect(error.message).toContain("hub 1.2.3");
    expect(error.message).toContain("nema@1.2.3");
    await closed;
  });

  test("a matching hello is welcomed", async () => {
    const port = await listen("1.2.3");
    const { message } = await hello(port, "1.2.3");
    expect(await message).toMatchObject({ type: "welcome" });
  });

  test("without a release version, existing hello versions are still accepted", async () => {
    const port = await listen();
    const { message } = await hello(port, "0");
    expect(await message).toMatchObject({ type: "welcome" });
  });

  test("GET /api/version returns the release version the hub enforces", async () => {
    const { db, dataDir } = await makeHubDeps();
    const hub = await startHub({
      db,
      dataDir,
      nemaHome: dataDir,
      daemonToken: "tok",
      port: 0,
      webOrigin: "http://127.0.0.1:3000",
      releaseVersion: "1.2.3",
    });
    try {
      const res = await fetch(`${hub.url}/api/version`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ version: "1.2.3" });
    } finally {
      await hub.close();
    }
  });
});
