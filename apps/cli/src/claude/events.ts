import { CLAUDE_ROOM_TOOLS } from "./launch.js";

const FAILURE = "Claude 的工具面无法确认为只有 Room：";
const roomOnly = new Set<string>(CLAUDE_ROOM_TOOLS);

export type McpServer = { name: string; status: string | null };

export type ClaudeLine =
  | { kind: "init"; tools: string[] | null; mcpServers: McpServer[] | null }
  | { kind: "text"; text: string }
  | { kind: "tools"; names: string[] }
  | { kind: "result"; text: string }
  | { kind: "failure" }
  | { kind: "ignore" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value;
}

function serverList(value: unknown): McpServer[] | null {
  if (!Array.isArray(value)) return null;
  const servers: McpServer[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") return null;
    servers.push({ name: item.name, status: typeof item.status === "string" ? item.status : null });
  }
  return servers;
}

// One event per line. Every tool_use block is returned so each one counts toward the limit.
// Text alongside tool_use is dropped.
export function parseClaudeLine(line: string): ClaudeLine {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "ignore" };
  }
  if (!isRecord(value)) return { kind: "ignore" };

  if (value.type === "system" && value.subtype === "init") {
    return { kind: "init", tools: strings(value.tools), mcpServers: serverList(value.mcp_servers) };
  }

  if (value.type === "assistant" && isRecord(value.message) && Array.isArray(value.message.content)) {
    let text: string | undefined;
    const names: string[] = [];
    for (const block of value.message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        names.push(block.name);
        continue;
      }
      if (text === undefined && block.type === "text" && typeof block.text === "string") text = block.text;
    }
    if (names.length > 0) return { kind: "tools", names };
    if (text !== undefined) return { kind: "text", text };
  }

  if (value.type === "result") {
    const subtype = value.subtype;
    if (value.is_error === true || (typeof subtype === "string" && subtype.startsWith("error_"))) {
      return { kind: "failure" };
    }
    if (typeof value.result === "string") return { kind: "result", text: value.result };
  }
  return { kind: "ignore" };
}

export function roomToolsOk(
  tools: string[] | null,
  mcpServers: McpServer[] | null,
  allowed: ReadonlySet<string> = roomOnly,
): { ok: true } | { ok: false; error: string } {
  const toolsOk = tools !== null
    && tools.every((name) => allowed.has(name))
    && CLAUDE_ROOM_TOOLS.every((name) => tools.includes(name));
  const room = mcpServers?.length === 1 ? mcpServers[0] : undefined;
  const mcpOk = room?.name === "room" && room.status === "connected";
  if (toolsOk && mcpOk) return { ok: true };
  return { ok: false, error: `${FAILURE}${JSON.stringify({ tools, mcpServers })}` };
}
