import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openMcpConfigs } from "../../src/extensions/mcp.js";
import { parseValueFlag, registerMcpCommands, type McpCommandDeps } from "../../src/extensions/mcpCommands.js";
import { openMcpSecretStore } from "../../src/secrets/mcp.js";

const MARK = "nema-test-secret-7f3a";
let home: string;
let logs: string[];
let errors: string[];
let requests: Array<{ method: string; url: string; body: unknown }>;
let reply: (method: string, url: string) => { status: number; body: unknown };
let server: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nema-mcp-cli-"));
  logs = [];
  errors = [];
  requests = [];
  server = [];
  reply = () => ({ status: 200, body: { id: "search", kind: "mcp", provision: "managed" } });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function deps(stdin = ""): McpCommandDeps {
  return {
    nemaHome: home,
    hubUrl: async () => "http://127.0.0.1:4400",
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    stdin: () => Readable.from([stdin]),
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const { status, body } = reply(method, String(url));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  };
}

async function run(argv: string[], stdin = ""): Promise<number> {
  const program = new Command().exitOverride();
  const mcp = program.command("mcp").action(() => { server.push("server"); });
  let code = 0;
  registerMcpCommands(mcp, deps(stdin), (c) => { code = c; });
  await program.parseAsync(argv, { from: "user" });
  for (const line of [...logs, ...errors]) expect(line).not.toContain(MARK);
  return code;
}

test("bare `nema mcp` still runs the Room MCP server for agents", async () => {
  await run(["mcp"]);
  expect(server).toEqual(["server"]);
  expect(requests).toEqual([]);
});

test("parseValueFlag reads value, secret and env references", () => {
  expect(parseValueFlag("LOG=debug")).toEqual(["LOG", { value: "debug" }]);
  expect(parseValueFlag("API_TOKEN=secret:API_TOKEN")).toEqual(["API_TOKEN", { secret: "API_TOKEN" }]);
  expect(parseValueFlag("API_TOKEN=env:MY_TOKEN")).toEqual(["API_TOKEN", { env: "MY_TOKEN" }]);
  expect(parseValueFlag("NOTE=value:secret:x")).toEqual(["NOTE", { value: "secret:x" }]);
  expect(() => parseValueFlag("novalue")).toThrow(/NAME=VALUE/);
});

test("add posts a stdio config through the hub", async () => {
  reply = (method) => (method === "GET" ? { status: 404, body: { error: "MCP server not found: search" } } : { status: 200, body: { id: "search", kind: "mcp", provision: "managed" } });
  const code = await run(["mcp", "add", "search", "--name", "Search", "--command", "node", "--arg", "server.mjs", "--arg", "--port=0", "--env", "API_TOKEN=secret:API_TOKEN"]);
  expect(code).toBe(0);
  expect(requests).toEqual([
    { method: "GET", url: "http://127.0.0.1:4400/api/extensions/search/mcp", body: undefined },
    { method: "POST", url: "http://127.0.0.1:4400/api/extensions/mcp", body: {
      id: "search", name: "Search",
      config: { transport: "stdio", command: "node", args: ["server.mjs", "--port=0"], env: { API_TOKEN: { secret: "API_TOKEN" } } },
    } },
  ]);
});

test("add refuses an id that exists, edit requires one", async () => {
  expect(await run(["mcp", "add", "search", "--name", "S", "--url", "https://a.example/mcp"])).toBe(1);
  expect(errors.join("\n")).toMatch(/already exists/);
  reply = (method) => (method === "GET" ? { status: 404, body: { error: "MCP server not found: search" } } : { status: 200, body: {} });
  errors = [];
  expect(await run(["mcp", "edit", "search", "--url", "https://a.example/mcp"])).toBe(1);
  expect(errors.join("\n")).toMatch(/not found/);
});

test("a credential written as a plain value is refused locally, without echoing it", async () => {
  reply = (method) => (method === "GET" ? { status: 404, body: { error: "MCP server not found: search" } } : { status: 200, body: {} });
  expect(await run(["mcp", "add", "search", "--name", "S", "--url", "https://a.example/mcp", "--header", `Authorization=Bearer ${MARK}`])).toBe(1);
  expect(requests.some((r) => r.method === "POST")).toBe(false);
});

test("a hub behind the desktop gateway explains where to go instead", async () => {
  reply = () => ({ status: 401, body: { error: "Unauthorized" } });
  expect(await run(["mcp", "start", "search"])).toBe(1);
  expect(errors.join("\n")).toMatch(/Plugins page/);
});

test("start and stop send an empty body and print the connection", async () => {
  reply = (method, url) => ({ status: 200, body: { id: "search", connection: url.endsWith("/start") ? "connected" : "disconnected", server: null, tools: [], lastError: null } });
  expect(await run(["mcp", "start", "search"])).toBe(0);
  expect(requests[0]).toEqual({ method: "POST", url: "http://127.0.0.1:4400/api/extensions/search/mcp/start", body: {} });
  expect(logs.join("\n")).toMatch(/connected/);
  expect(await run(["mcp", "stop", "search"])).toBe(0);
});

test("secret set writes the private file directly from stdin, only for a referenced name", async () => {
  openMcpConfigs({ root: join(home, "extensions"), nemaHome: home }).save("search", "Search", {
    transport: "stdio", command: "node", args: [], env: { API_TOKEN: { secret: "API_TOKEN" } },
  });
  expect(await run(["mcp", "secret", "set", "search", "API_TOKEN"], `${MARK}\n`)).toBe(0);
  expect(openMcpSecretStore(home).resolve("search", "API_TOKEN")).toBe(MARK);
  expect(requests).toEqual([]);
  expect(logs.join("\n")).toMatch(/restart/i);
  expect(await run(["mcp", "secret", "set", "search", "OTHER"], `${MARK}\n`)).toBe(1);
  expect(await run(["mcp", "secret", "set", "missing", "API_TOKEN"], `${MARK}\n`)).toBe(1);
  expect(await run(["mcp", "secret", "clear", "search", "API_TOKEN"])).toBe(0);
  expect(openMcpSecretStore(home).has("search", "API_TOKEN")).toBe(false);
});
