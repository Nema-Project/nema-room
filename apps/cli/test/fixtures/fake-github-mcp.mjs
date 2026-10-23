// A fake github-mcp-server for tests. A test writes a small launcher that sets
// globalThis.__FAKE_GITHUB_CONFIG to a config path and imports this file, so argv and env stay exactly
// what the client passed. The config sets the tools it lists, where it records argv/env, and when it crashes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const configPath = globalThis.__FAKE_GITHUB_CONFIG;
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8"));

if (args.includes("--version")) {
  process.stdout.write(`${config.version ?? "github-mcp-server fake 0.0.1"}\n`);
  process.exit(0);
}

if (config.record) writeFileSync(config.record, JSON.stringify({ args, env: process.env, cwd: process.cwd() }));
if (config.starts) appendFileSync(config.starts, "start\n");
if (config.exitOnStart) process.exit(3);

const server = new Server({ name: "fake-github", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: (config.tools ?? []).map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: "object", properties: {} } })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  if (config.crashOnce && !existsSync(config.crashOnce)) {
    writeFileSync(config.crashOnce, "crashed\n");
    process.exit(1);
  }
  if (config.crashAlways) process.exit(1);
  if (config.hang) return new Promise(() => {});
  if (config.bigText) return { content: [{ type: "text", text: "x".repeat(config.bigText) }] };
  return { content: [{ type: "text", text: `${name} ${JSON.stringify(request.params.arguments ?? {})}` }] };
});

await server.connect(new StdioServerTransport());
