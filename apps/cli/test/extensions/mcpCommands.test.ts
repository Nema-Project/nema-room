import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  hubBase = "http://127.0.0.1:4400";
  stdinStream = null;
  secretStore = undefined;
  reply = () => ({ status: 200, body: { id: "search", kind: "mcp", provision: "managed" } });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

let hubBase = "http://127.0.0.1:4400";
let stdinStream: (() => NodeJS.ReadableStream) | null = null;
let secretStore: McpCommandDeps["secretStore"];

function deps(stdin = ""): McpCommandDeps {
  return {
    nemaHome: home,
    desktopHome: join(home, "desktop"),
    hubUrl: async () => hubBase,
    out: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    stdin: () => (stdinStream ? stdinStream() : Readable.from([stdin])),
    ...(secretStore ? { secretStore } : {}),
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
      id: "search", name: "Search", create: true,
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

const saveSearch = (home_: string, env: Record<string, unknown> = { API_TOKEN: { secret: "API_TOKEN" } }) =>
  openMcpConfigs({ root: join(home_, "extensions"), nemaHome: home_ }).save("search", "Search", { transport: "stdio", command: "node", args: [], env });

test("secret set keeps the value exactly, spaces included, and refuses an empty one", async () => {
  saveSearch(home);
  expect(await run(["mcp", "secret", "set", "search", "API_TOKEN"], `  ${MARK} \r\n`)).toBe(0);
  expect(openMcpSecretStore(home).resolve("search", "API_TOKEN")).toBe(`  ${MARK} `);
  expect(await run(["mcp", "secret", "set", "search", "API_TOKEN"], "\n")).toBe(1);
  expect(errors.join("\n")).toMatch(/no value/);
});

test("secret set checks the config again after reading stdin, so a new target never gets the old value", async () => {
  saveSearch(home);
  stdinStream = () =>
    new Readable({
      read() {
        // The config is edited to a new command, which drops the reference, while the value is typed.
        openMcpConfigs({ root: join(home, "extensions"), nemaHome: home }).save("search", "Search", { transport: "stdio", command: "other", args: [], env: {} });
        this.push(`${MARK}\n`);
        this.push(null);
      },
    });
  expect(await run(["mcp", "secret", "set", "search", "API_TOKEN"])).toBe(1);
  expect(openMcpSecretStore(home).has("search", "API_TOKEN")).toBe(false);
});

test("secret set refuses a config file that no longer matches its record", async () => {
  saveSearch(home);
  const file = join(home, "extensions", "extensions", "search", "mcp.json");
  writeFileSync(file, readFileSync(file, "utf8") + " ");
  expect(await run(["mcp", "secret", "set", "search", "API_TOKEN"], `${MARK}\n`)).toBe(1);
  expect(errors.join("\n")).toMatch(/damaged|save it again/);
  expect(openMcpSecretStore(home).has("search", "API_TOKEN")).toBe(false);
});

test("--desktop writes and clears the desktop app's credentials", async () => {
  const desktop = join(home, "desktop");
  saveSearch(desktop);
  expect(await run(["mcp", "secret", "set", "search", "API_TOKEN", "--desktop"], `${MARK}\n`)).toBe(0);
  expect(openMcpSecretStore(desktop).resolve("search", "API_TOKEN")).toBe(MARK);
  expect(openMcpSecretStore(home).has("search", "API_TOKEN")).toBe(false);
  expect(await run(["mcp", "secret", "clear", "search", "API_TOKEN", "--desktop"])).toBe(0);
  expect(openMcpSecretStore(desktop).has("search", "API_TOKEN")).toBe(false);
});

test("a hub URL with a trailing slash still reaches /api", async () => {
  hubBase = "http://127.0.0.1:4400/";
  reply = () => ({ status: 200, body: { id: "search", connection: "connected", server: null, tools: [], lastError: null } });
  expect(await run(["mcp", "status", "search"])).toBe(0);
  expect(requests[0].url).toBe("http://127.0.0.1:4400/api/extensions/search/mcp/status");
});

test("add maps the daemon's create-only refusal to the edit hint", async () => {
  reply = (method) => (method === "GET" ? { status: 404, body: { error: "MCP server not found: search" } } : { status: 409, body: { error: "MCP server search already exists" } });
  expect(await run(["mcp", "add", "search", "--name", "S", "--url", "https://a.example/mcp"])).toBe(1);
  expect(errors.join("\n")).toMatch(/nema mcp edit/);
});

test("a save that lands between the last check and the write still keeps the value away from the new target", async () => {
  saveSearch(home);
  secretStore = (h) => {
    const real = openMcpSecretStore(h);
    return {
      ...real,
      set(id: string, name: string, value: string) {
        // The daemon saves a new target, and prunes the slot, just before this write lands.
        openMcpConfigs({ root: join(home, "extensions"), nemaHome: home }).save("search", "Search", { transport: "stdio", command: "other", args: [], env: { API_TOKEN: { secret: "API_TOKEN" } } });
        real.set(id, name, value);
      },
    };
  };
  expect(await run(["mcp", "secret", "set", "search", "API_TOKEN"], `${MARK}\n`)).toBe(1);
  expect(openMcpSecretStore(home).has("search", "API_TOKEN")).toBe(false);
  expect(errors.join("\n")).toMatch(/changed/);
});

test("start exits non-zero when the server did not connect", async () => {
  reply = () => ({ status: 200, body: { id: "search", connection: "needs-login", server: null, tools: [], lastError: "the server asked for a login (HTTP 401)" } });
  expect(await run(["mcp", "start", "search"])).toBe(1);
  expect(errors.join("\n")).toMatch(/needs-login/);
});

test("edit saves with create: false, so a server removed meanwhile is not recreated", async () => {
  reply = (method) => (method === "GET" ? { status: 200, body: { id: "search", name: "Search" } } : { status: 404, body: { error: "MCP server not found: search" } });
  expect(await run(["mcp", "edit", "search", "--url", "https://a.example/mcp"])).toBe(1);
  expect(requests[1]).toMatchObject({ method: "POST", body: { id: "search", name: "Search", create: false } });
  expect(errors.join("\n")).toMatch(/not found/);
});
