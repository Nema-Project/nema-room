import path from "node:path";
import { CLAUDE_ROOM_TOOLS } from "./launch.js";

const FAILURE = "Claude 的工具面无法确认为只有 Room：";
const roomOnly = new Set<string>(CLAUDE_ROOM_TOOLS);

export type McpServer = { name: string; status: string | null };

export type ToolUse = { id: string; name: string; input: unknown };
export type ToolResult = { toolUseId: string; isError: boolean };

export type ClaudeLine =
  | { kind: "init"; tools: string[] | null; mcpServers: McpServer[] | null; version: string | null; skills: string[] | null }
  | { kind: "text"; text: string }
  | { kind: "tools"; names: string[]; uses: ToolUse[] }
  | { kind: "results"; results: ToolResult[] }
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

// Names only; a later version may send objects with a `name`.
function skillList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === "string") names.push(item);
    else if (isRecord(item) && typeof item.name === "string") names.push(item.name);
    else return null;
  }
  return names;
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
    return {
      kind: "init",
      tools: strings(value.tools),
      mcpServers: serverList(value.mcp_servers),
      version: typeof value.claude_code_version === "string" ? value.claude_code_version : null,
      skills: skillList(value.skills),
    };
  }

  if (value.type === "assistant" && isRecord(value.message) && Array.isArray(value.message.content)) {
    let text: string | undefined;
    const names: string[] = [];
    const uses: ToolUse[] = [];
    for (const block of value.message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "tool_use" && typeof block.name === "string") {
        names.push(block.name);
        uses.push({ id: typeof block.id === "string" ? block.id : "", name: block.name, input: block.input });
        continue;
      }
      if (text === undefined && block.type === "text" && typeof block.text === "string") text = block.text;
    }
    if (names.length > 0) return { kind: "tools", names, uses };
    if (text !== undefined) return { kind: "text", text };
  }

  // Tool results come back in a user message, one block per tool_use.
  if (value.type === "user" && isRecord(value.message) && Array.isArray(value.message.content)) {
    const results: ToolResult[] = [];
    for (const block of value.message.content) {
      if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        results.push({ toolUseId: block.tool_use_id, isError: block.is_error === true });
      }
    }
    if (results.length > 0) return { kind: "results", results };
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

/**
 * Which Skill a `Skill` or `Read` call loads, or null. The `Skill` tool's input field is not documented, so
 * each string value is matched against the task's ids and copy folder names (spec §3), and the call counts
 * when exactly one Skill is named; anything else is not guessed at. A `Read` of a copy's SKILL.md counts too.
 */
export function skillActivationFrom(use: { name: string; input: unknown }, skillDirs: ReadonlyMap<string, string>): string | null {
  if (!isRecord(use.input)) return null;
  if (use.name === "Read") {
    const file = use.input.file_path;
    // Claude Code passes absolute paths; a relative one would resolve against this process, not Claude's.
    if (typeof file !== "string" || !path.isAbsolute(file)) return null;
    for (const [id, skillFile] of skillDirs) if (path.resolve(file) === skillFile) return id;
    return null;
  }
  if (use.name !== "Skill") return null;
  // Arguments may ride along as other strings; the call counts when exactly one Skill is named among them.
  const named = new Set<string>();
  for (const value of Object.values(use.input)) {
    if (typeof value !== "string") continue;
    const id = skillNamed(value, skillDirs);
    if (id) named.add(id);
  }
  return named.size === 1 ? [...named][0]! : null;
}

function skillNamed(value: string, skillDirs: ReadonlyMap<string, string>): string | null {
  const wanted = value.trim().replace(/^\//, "");
  if (skillDirs.has(wanted)) return wanted;
  const byFolder = [...skillDirs].filter(([, skillFile]) => path.basename(path.dirname(skillFile)) === wanted);
  return byFolder.length === 1 ? byFolder[0]![0] : null;
}
