// A fake MCP server for the supervisor tests.
//
// stdio: run as a program. Options come from its own environment, which the supervisor builds exactly:
//   FAKE_TOOLS=<n>          list n tools (default 2)
//   FAKE_HANG=1             never answer initialize
//   FAKE_RECORD=<file>      write { keys, env, pid } at start
//   FAKE_STARTS=<file>      append one line per start
//   FAKE_GRANDCHILD=<file>  start a long-lived grandchild in the same process group and write its pid
// HTTP: import `startHttpFake({ status, location })` from a test; it serves one stateless MCP server
// per request, or answers every request with `status` when that is set.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

function makeServer(count) {
  const server = new Server({ name: "fake-mcp", version: "1.2.3" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Array.from({ length: count }, (_, i) => ({
      name: `tool_${i + 1}`,
      description: `fake tool ${i + 1}`,
      inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, n: { type: "number" } } },
    })),
  }));
  return server;
}

/** Start an HTTP MCP endpoint on 127.0.0.1. Resolves to { url, requests, close }. */
export async function startHttpFake({ status, location, tools = 2 } = {}) {
  const requests = [];
  const http = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    if (status) {
      res.writeHead(status, location ? { location } : {});
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = makeServer(tools);
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise((resolve) => { http.closeAllConnections?.(); http.close(() => resolve()); }),
  };
}

async function main() {
  const env = process.env;
  if (env.FAKE_STARTS) appendFileSync(env.FAKE_STARTS, "start\n");
  if (env.FAKE_RECORD) writeFileSync(env.FAKE_RECORD, JSON.stringify({ keys: Object.keys(env).sort(), env, pid: process.pid }));
  if (env.FAKE_GRANDCHILD) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(env.FAKE_GRANDCHILD, String(child.pid));
  }
  if (env.FAKE_HANG) {
    // Read stdin so the pipe stays open, never answer.
    process.stdin.resume();
    await new Promise(() => {});
  }
  await makeServer(Number(env.FAKE_TOOLS ?? 2)).connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
