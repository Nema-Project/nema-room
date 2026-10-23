import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PluginToolSpec } from "@nema/shared";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { RoomClient, type RoomResult } from "../room/client.js";
import { roomTools } from "../direct/tools.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function toToolResult(r: RoomResult): ToolResult {
  if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
  return { content: [{ type: "text", text: typeof r.json === "string" ? r.json : JSON.stringify(r.json) }] };
}

function parsePluginTools(json: unknown): PluginToolSpec[] | null {
  if (!json || typeof json !== "object" || !Array.isArray((json as { tools?: unknown }).tools)) return null;
  const tools: PluginToolSpec[] = [];
  for (const item of (json as { tools: unknown[] }).tools) {
    if (!item || typeof item !== "object") return null;
    const tool = item as { name?: unknown; description?: unknown; parameters?: unknown };
    if (typeof tool.name !== "string" || typeof tool.description !== "string") return null;
    if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) return null;
    tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> });
  }
  return tools;
}

/** Hub listing, or the 3 Room tools alone when the list cannot be read. */
async function listedPluginTools(room: RoomClient): Promise<PluginToolSpec[]> {
  try {
    const listed = await room.listPluginTools();
    if (!listed.ok) {
      console.error(`无法列出插件函数：${listed.error}`);
      return [];
    }
    const tools = parsePluginTools(listed.json);
    if (!tools) {
      console.error("无法列出插件函数：响应缺少 tools");
      return [];
    }
    return tools;
  } catch (e) {
    console.error(`无法列出插件函数：${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

export async function startMcpServer(opts: { hubUrl: string; runToken: string }, transport?: Transport): Promise<void> {
  const room = new RoomClient(opts.hubUrl, opts.runToken);
  const pluginTools = await listedPluginTools(room);
  const tools = roomTools(pluginTools);
  const pluginNames = new Set(pluginTools.map((tool) => tool.name));

  // registerTool only accepts zod shapes. Plugin parameters are JSON Schema, so the room server
  // answers tools/list and tools/call itself. The declared functions are roomTools(), same as codex-direct.
  const server = new Server({ name: "room", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    if (pluginNames.has(name)) return toToolResult(await room.callPlugin(name, args));
    if (name === "list_entries") return toToolResult(await room.listEntries());
    if (name === "read_entry") {
      const id = args.id;
      if (typeof id !== "string" || id === "") {
        return { content: [{ type: "text", text: "read_entry 需要字符串参数 id" }], isError: true };
      }
      return toToolResult(await room.readEntry(id));
    }
    if (name === "upsert_entry") return toToolResult(await room.upsertEntry(args));
    return { content: [{ type: "text", text: `未知函数 ${name}` }], isError: true };
  });
  await server.connect(transport ?? new StdioServerTransport());
}
