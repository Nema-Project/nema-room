import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { Hono } from "hono";
import { PLUGINS, bundledExtensions } from "@nema/shared";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { DaemonRpcError, type DaemonRpc } from "../src/daemonRpc.js";
import { EventBus } from "../src/events.js";
import { createApp } from "../src/app.js";
import { enabledPluginTools, setPluginState } from "../src/plugins.js";
import { createWorkspace } from "../src/workspaces.js";

const MARK = "nema-test-secret-7f3a";
const HUB = "http://127.0.0.1:4400";

let db: Db;
let dataDir: string;
let app: Hono<any>;
const calls: Array<{ method: string; params: any }> = [];
let answer: (method: string, params: any) => unknown;

const daemon: DaemonRpc = {
  async call(method, params) {
    calls.push({ method, params });
    return answer(method, params);
  },
};

const status = (id: string, connection = "connected") => ({ id, connection, server: { name: "fake", version: "1" }, tools: [{ name: "t", schemaDigest: "a".repeat(64) }], lastError: null });
const mcpRecord = (id: string) => ({
  id, kind: "mcp", name: "Search", summary: "", source: "mcp:stdio", revision: "abcdef123456", provision: "managed",
  installState: "installed", useState: "enabled", availability: "ready", externalPath: null, error: null,
});
const config = { transport: "stdio", command: "node", args: ["server.mjs"], env: { API_TOKEN: { secret: "API_TOKEN" } } };

beforeEach(async () => {
  calls.length = 0;
  answer = (method, params) => {
    if (method === "extensions.mcp.get") return { id: params.id, name: "Search", config, secrets: [{ name: "API_TOKEN", configured: true }] };
    if (method === "extensions.mcp.save") return mcpRecord(params.id);
    if (method === "extensions.mcp.start" || method === "extensions.mcp.status") return status(params.id);
    if (method === "extensions.mcp.stop") return status(params.id, "disconnected");
    if (method === "extensions.mcp.setSecret") return { id: params.id, name: params.name, configured: true, status: status(params.id) };
    if (method === "extensions.mcp.clearSecret") return { id: params.id, name: params.name, configured: false, status: status(params.id) };
    if (method === "extensions.list") return bundledExtensions();
    throw new DaemonRpcError("daemon 未连接");
  };
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  app = createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon });
});
afterAll(cleanupHubDeps);

const req = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response = await app.request(`${HUB}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  expect(text).not.toContain(MARK);
  return { status: response.status, json: text ? JSON.parse(text) : null };
};

describe("MCP routes", () => {
  test("GET /api/extensions/:id/mcp returns the config with references only", async () => {
    const r = await req("GET", "/api/extensions/search/mcp");
    expect(r.status).toBe(200);
    expect(r.json.config.env.API_TOKEN).toEqual({ secret: "API_TOKEN" });
    expect(calls).toEqual([{ method: "extensions.mcp.get", params: { id: "search" } }]);
  });

  test("POST /api/extensions/mcp checks the config before the daemon sees it", async () => {
    const good = await req("POST", "/api/extensions/mcp", { id: "search", name: "Search", config });
    expect(good.status).toBe(200);
    expect(good.json.kind).toBe("mcp");
    calls.length = 0;
    for (const body of [
      { id: "search", name: "Search", config: { ...config, env: { API_TOKEN: { value: MARK } } } },
      { id: "search", name: "Search", config: { transport: "http", url: "http://mcp.example.com/mcp", headers: {} } },
      { id: "search", name: "Search" },
      { id: "search", name: "Search", config, extra: true },
    ]) {
      expect((await req("POST", "/api/extensions/mcp", body)).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("start and stop take an id only: a command or URL in the body is refused", async () => {
    expect((await req("POST", "/api/extensions/search/mcp/start", {})).json).toMatchObject({ connection: "connected" });
    expect((await req("POST", "/api/extensions/search/mcp/stop", {})).json).toMatchObject({ connection: "disconnected" });
    expect((await req("GET", "/api/extensions/search/mcp/status")).json).toMatchObject({ connection: "connected" });
    calls.length = 0;
    expect((await req("POST", "/api/extensions/search/mcp/start", { command: "evil" })).status).toBe(400);
    expect((await req("POST", "/api/extensions/search/mcp/start", { url: "https://evil.example" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("PUT and DELETE a secret; the response never carries the value", async () => {
    const put = await req("PUT", "/api/extensions/search/mcp/secrets/API_TOKEN", { value: MARK });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ id: "search", name: "API_TOKEN", configured: true });
    expect(calls.at(-1)).toEqual({ method: "extensions.mcp.setSecret", params: { id: "search", name: "API_TOKEN", value: MARK } });
    const del = await req("DELETE", "/api/extensions/search/mcp/secrets/API_TOKEN");
    expect(del.json).toMatchObject({ configured: false });
    expect((await req("PUT", "/api/extensions/search/mcp/secrets/API_TOKEN", { value: 7 })).status).toBe(400);
    expect((await req("PUT", "/api/extensions/search/mcp/secrets/API_TOKEN", { value: MARK, extra: MARK })).status).toBe(400);
  });

  test("a daemon error that quotes the request is not passed through", async () => {
    answer = () => {
      throw new DaemonRpcError(`boom ${MARK}`);
    };
    const r = await app.request(`${HUB}/api/extensions/search/mcp/secrets/API_TOKEN`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: MARK }),
    });
    expect(r.status).toBe(502);
    expect(await r.text()).not.toContain(MARK);
  });

  test("daemon refusals map to 4xx, offline to 503, malformed replies to 502", async () => {
    answer = () => {
      throw new DaemonRpcError("search is disabled; enable it first");
    };
    expect((await req("POST", "/api/extensions/search/mcp/start", {})).status).toBe(409);
    answer = () => {
      throw new DaemonRpcError("MCP server not found: search");
    };
    expect((await req("POST", "/api/extensions/search/mcp/start", {})).status).toBe(404);
    answer = () => {
      throw new DaemonRpcError("daemon 未连接");
    };
    expect((await req("POST", "/api/extensions/search/mcp/start", {})).status).toBe(503);
    answer = () => ({ id: "other", connection: "connected" });
    expect((await req("POST", "/api/extensions/search/mcp/start", {})).status).toBe(502);
    answer = () => ({ id: "search", name: "Search", config: { transport: "stdio", command: "node", args: [], env: { API_TOKEN: { value: MARK } } }, secrets: [] });
    expect((await req("GET", "/api/extensions/search/mcp")).status).toBe(502);
  });

  test("with uiAuth on, MCP writes without the credential are refused before the daemon", async () => {
    app = createApp({
      db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon,
      uiAuth: async (c, next) => {
        if (c.req.header("x-nema-gateway-credential") !== "fake-gateway") return c.json({ error: "Unauthorized" }, 401);
        await next();
      },
    });
    calls.length = 0;
    expect((await req("POST", "/api/extensions/mcp", { id: "search", name: "Search", config })).status).toBe(401);
    expect((await req("PUT", "/api/extensions/search/mcp/secrets/API_TOKEN", { value: MARK })).status).toBe(401);
    expect((await req("POST", "/api/extensions/search/mcp/start", {})).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await req("POST", "/api/extensions/search/mcp/start", {}, { "x-nema-gateway-credential": "fake-gateway" })).status).toBe(200);
  });
});

test("D-3: MCP records never add tools to an agent", async () => {
  const ws = (await createWorkspace(db, dataDir, "A")).id;
  for (const plugin of PLUGINS) await setPluginState(db, ws, plugin.id, { enabled: true });
  answer = (method) => (method === "extensions.list" ? [...bundledExtensions(), { ...mcpRecord("search"), mcp: { transport: "stdio", connection: "connected", server: null, tools: [{ name: "search_web", schemaDigest: "a".repeat(64) }], secrets: [], lastError: null } }] : null);
  const names = (await enabledPluginTools(db, ws)).map((tool) => tool.name);
  const known = new Set(PLUGINS.flatMap((plugin) => plugin.functions.map((fn) => fn.name)));
  expect(names.every((name) => known.has(name))).toBe(true);
  expect(names.some((name) => name.includes("search_web"))).toBe(false);

});

describe("MCP save checks", () => {
  test("a create-only save is forwarded, and the daemon's refusal is a 409", async () => {
    answer = (method) => {
      if (method === "extensions.mcp.save") throw new DaemonRpcError("MCP server search already exists");
      throw new DaemonRpcError("daemon 未连接");
    };
    const r = await req("POST", "/api/extensions/mcp", { id: "search", name: "Search", config, create: true });
    expect(r.status).toBe(409);
    expect(calls[0].params.create).toBe(true);
    expect((await req("POST", "/api/extensions/mcp", { id: "search", name: "Search", config, create: "yes" })).status).toBe(400);
  });

  test("a save row or secret slots that do not fit the config are a 502, not passed on", async () => {
    for (const bad of [
      { ...mcpRecord("search"), useState: "sideways" },
      { ...mcpRecord("search"), source: "mcp:http" },
      { ...mcpRecord("search"), extra: MARK },
      (() => { const { revision: _r, ...rest } = mcpRecord("search"); return rest; })(),
    ]) {
      answer = (method) => (method === "extensions.mcp.save" ? bad : null);
      const r = await req("POST", "/api/extensions/mcp", { id: "search", name: "Search", config });
      expect(r.status).toBe(502);
    }
    for (const secrets of [[], [{ name: "OTHER", configured: true }], [{ name: "API_TOKEN", configured: true }, { name: "API_TOKEN", configured: false }]]) {
      answer = (method, params) => (method === "extensions.mcp.get" ? { id: params.id, name: "Search", config, secrets } : null);
      expect((await req("GET", "/api/extensions/search/mcp")).status).toBe(502);
    }
  });

  test("an edit save forwards create: false, and a missing server is a 404", async () => {
    answer = (method) => {
      if (method === "extensions.mcp.save") throw new DaemonRpcError("MCP server not found: search");
      throw new DaemonRpcError("daemon 未连接");
    };
    const r = await req("POST", "/api/extensions/mcp", { id: "search", name: "Search", config, create: false });
    expect(r.status).toBe(404);
    expect(calls[0].params.create).toBe(false);
  });
});

