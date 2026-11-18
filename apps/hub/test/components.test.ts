// The hub passes component status, a confirmed install, cancel and settings through to the daemon, and keeps
// nothing itself. The daemon here is a fake that records every call.
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { componentHttpStatus, componentRoutes } from "../src/components.js";
import { COMPONENT_RPC_TIMEOUT_MS, DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { createApp } from "../src/app.js";
import { EventBus } from "../src/events.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
const LOCK_HASH = "a".repeat(64);

const calls: { method: string; params: unknown; timeoutMs?: number }[] = [];
let answer: (method: string, params: unknown) => Promise<unknown>;
const daemon: DaemonRpc = {
  call(method, params, timeoutMs) {
    calls.push({ method, params, timeoutMs });
    return answer(method, params);
  },
};

const view = (state: string, progress?: unknown) => ({
  components: [
    {
      name: "graphify",
      status: { state, name: "graphify", lockHash: LOCK_HASH, ...(progress ? { progress } : {}) },
      offer: { lockHash: LOCK_HASH, totalBytes: 123_456, location: "/home/u/.nema/runtime/graphify", hosts: ["github.com", "files.pythonhosted.org"] },
      settings: {},
    },
  ],
});

let app: Hono;
beforeEach(() => {
  calls.length = 0;
  answer = async () => view("not-installed");
  app = new Hono().route("/api", componentRoutes({ daemon }));
});
afterAll(cleanupHubDeps);

const req = (target: Hono, method: string, path: string, body?: unknown) =>
  target.request(`${HUB}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("component routes", () => {
  test("GET /api/components passes the daemon's status, offer and progress through unchanged", async () => {
    const installing = view("installing", { phase: "download", downloadedBytes: 1000, totalBytes: 123_456, file: "cpython.tar.gz" });
    answer = async () => installing;
    const response = await req(app, "GET", "/api/components");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(installing);
    expect(calls).toEqual([{ method: "components.status", params: {}, timeoutMs: COMPONENT_RPC_TIMEOUT_MS }]);
  });

  test("a repair install forwards force: true to the daemon; a plain install sends no force flag", async () => {
    answer = async () => view("installed");
    const plain = await req(app, "POST", "/api/components/graphify/install", { confirmed: true, lockHash: LOCK_HASH });
    expect(plain.status).toBe(200);
    expect(calls).toEqual([{ method: "components.install", params: { name: "graphify", confirmed: true, lockHash: LOCK_HASH }, timeoutMs: COMPONENT_RPC_TIMEOUT_MS }]);

    calls.length = 0;
    const repair = await req(app, "POST", "/api/components/graphify/install", { confirmed: true, lockHash: LOCK_HASH, force: true });
    expect(repair.status).toBe(200);
    expect(calls).toEqual([{ method: "components.install", params: { name: "graphify", confirmed: true, lockHash: LOCK_HASH, force: true }, timeoutMs: COMPONENT_RPC_TIMEOUT_MS }]);
  });

  test("an install reaches the daemon only with confirmed: true and the offered lock-hash", async () => {
    expect((await req(app, "POST", "/api/components/graphify/install", {})).status).toBe(400);
    expect((await req(app, "POST", "/api/components/graphify/install", { confirmed: false, lockHash: LOCK_HASH })).status).toBe(400);
    expect((await req(app, "POST", "/api/components/graphify/install", { confirmed: true })).status).toBe(400);
    expect((await req(app, "POST", "/api/components/graphify/install", { confirmed: true, lockHash: "nope" })).status).toBe(400);
    expect((await req(app, "POST", "/api/components/other/install", { confirmed: true, lockHash: LOCK_HASH })).status).toBe(404);
    expect(calls).toEqual([]);
    answer = async () => view("installing", { phase: "download", downloadedBytes: 0, totalBytes: 123_456, file: null });
    const response = await req(app, "POST", "/api/components/graphify/install", { confirmed: true, lockHash: LOCK_HASH });
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ method: "components.install", params: { name: "graphify", confirmed: true, lockHash: LOCK_HASH }, timeoutMs: COMPONENT_RPC_TIMEOUT_MS }]);
  });

  test("cancel and settings pass through; unknown settings fields are refused", async () => {
    expect((await req(app, "POST", "/api/components/graphify/cancel", {})).status).toBe(200);
    expect((await req(app, "PATCH", "/api/components/graphify/settings", { pythonMirror: "https://m.example", pypiBase: null, offline: true })).status).toBe(200);
    expect((await req(app, "PATCH", "/api/components/graphify/settings", { proxy: "http://p" })).status).toBe(400);
    expect(calls.map((call) => [call.method, call.params])).toEqual([
      ["components.cancel", { name: "graphify" }],
      ["components.configure", { name: "graphify", pythonMirror: "https://m.example", pypiBase: null, offline: true }],
    ]);
  });

  test("GET /api/agent-clis passes the detection result through", async () => {
    answer = async () => ({ agents: [{ id: "codex", installed: false, version: null, installUrl: "https://developers.openai.com/codex/cli" }] });
    const response = await req(app, "GET", "/api/agent-clis");
    expect(await response.json()).toEqual({ agents: [{ id: "codex", installed: false, version: null, installUrl: "https://developers.openai.com/codex/cli" }] });
    expect(calls[0]?.method).toBe("agents.detect");
  });

  test("daemon refusals map to 4xx, an offline daemon to 503", async () => {
    answer = async () => {
      throw new DaemonRpcError("the component offer changed; confirm again");
    };
    expect((await req(app, "POST", "/api/components/graphify/install", { confirmed: true, lockHash: LOCK_HASH })).status).toBe(409);
    answer = async () => {
      throw new DaemonRpcError("daemon 未连接");
    };
    const offline = await req(app, "GET", "/api/components");
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: "daemon 未连接" });
    expect(componentHttpStatus("镜像地址只允许 http(s) URL，且不能带账号、查询串或片段")).toBe(400);
    expect(componentHttpStatus("component install needs the user's confirmation")).toBe(400);
    expect(componentHttpStatus("something else")).toBe(502);
  });

  test("the routes are mounted under /api behind the hub's JSON guard", async () => {
    const deps = await makeHubDeps();
    const hub = createApp({ db: deps.db, dataDir: deps.dataDir, events: new EventBus(), daemonStatus: () => true, daemon });
    expect((await req(hub, "GET", "/api/components")).status).toBe(200);
    const plain = await hub.request(`${HUB}/api/components/graphify/install`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    expect(calls.map((call) => call.method)).toEqual(["components.status"]);
  });
});
