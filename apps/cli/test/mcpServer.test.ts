import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../src/mcp/server.js";

let hub: Server, hubUrl: string, status = 200, seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
let plugins: { name: string; description: string; parameters: Record<string, unknown> }[] = [];
let pluginListStatus = 200;
beforeEach(async () => {
  status = 200;
  seen = [];
  plugins = [];
  pluginListStatus = 200;
  hub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.method === "GET" && req.url === "/room/plugins") {
        res.writeHead(pluginListStatus, { "content-type": "application/json" });
        res.end(pluginListStatus === 200 ? JSON.stringify({ tools: plugins }) : '{"error":"plugin list failed"}');
        return;
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? '{"entries":[]}' : '{"error":"missing or invalid run token"}');
    });
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => hub.close(() => r())));

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await startMcpServer({ hubUrl, runToken: "tok123" }, b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return client;
}

describe("room mcp server", () => {
  test("exposes exactly three tools", async () => {
    const c = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["list_entries", "read_entry", "upsert_entry"]);
  });
  test("upsert_entry parameters list basis as required", async () => {
    const c = await connect();
    const upsert = (await c.listTools()).tools.find((t) => t.name === "upsert_entry");
    expect((upsert?.inputSchema as { required?: string[] }).required).toContain("basis");
  });
  test("sends bearer token and maps to hub routes", async () => {
    const c = await connect();
    const r = await c.callTool({ name: "list_entries", arguments: {} });
    expect(r.isError).toBeFalsy();
    await c.callTool({ name: "read_entry", arguments: { id: "R-1" } });
    await c.callTool({ name: "upsert_entry", arguments: { kind: "requirement", title: "t", body: "b", reason: "r", sourceMessages: ["m1"] } });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "GET /room/plugins",
      "GET /room/entries",
      "GET /room/entries/R-1",
      "POST /room/entries",
    ]);
    expect(seen.every((s) => s.auth === "Bearer tok123")).toBe(true);
    expect(JSON.parse(seen[3]!.body)).toMatchObject({ kind: "requirement", title: "t" });
  });
  test("nema mcp lists the plugin tools from GET /room/plugins and forwards calls to POST /room/plugins/<name>", async () => {
    plugins = [
      {
        name: "code__read",
        description: "Read a file from the repository.",
        parameters: {
          type: "object",
          properties: { repo: { type: "string" }, path: { type: "string" } },
          required: ["repo", "path"],
          additionalProperties: false,
        },
      },
    ];
    const c = await connect();
    const listed = await c.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(["code__read", "list_entries", "read_entry", "upsert_entry"]);
    expect(listed.tools.find((t) => t.name === "code__read")?.inputSchema).toMatchObject({
      type: "object",
      required: ["repo", "path"],
    });
    seen.length = 0;
    const r = await c.callTool({ name: "code__read", arguments: { repo: "repo_demo", path: "a.ts" } });
    expect(r.isError).toBeFalsy();
    const post = seen.find((s) => s.method === "POST" && s.url === "/room/plugins/code__read");
    expect(post?.auth).toBe("Bearer tok123");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ repo: "repo_demo", path: "a.ts" });
  });

  test("a failed plugin list keeps the 3 room tools and logs to stderr", async () => {
    pluginListStatus = 500;
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args);
    });
    try {
      const c = await connect();
      expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["list_entries", "read_entry", "upsert_entry"]);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("hub 401 -> isError with hub message", async () => {
    status = 401;
    const c = await connect();
    const r = await c.callTool({ name: "list_entries", arguments: {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("missing or invalid run token");
  });
});
