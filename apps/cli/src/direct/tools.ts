import { UpsertEntryInput, type PluginToolSpec } from "@nema/shared";
import { z } from "zod";
import { capText, type RoomClient, type RoomResult } from "../room/client.js";
import type { FunctionTool } from "./transport.js";

// The codex-direct model sees the four Room functions plus the task's plugin tools. Nothing else is declared,
// and nothing else is executed. Claude's allowed names and `nema mcp` use this same list.

export type RoomApi = Pick<RoomClient, "listEntries" | "readEntry" | "upsertEntry" | "openThread" | "callPlugin">;

/**
 * `z.toJSONSchema(UpsertEntryInput)` minus `$schema`. What remains (type/properties/required/enum/pattern/
 * minLength/maxLength/anyOf/const/default/additionalProperties) is plain JSON Schema that the Responses API
 * accepts for non-strict functions; the hub re-validates every upsert anyway.
 */
function upsertParameters(): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(UpsertEntryInput) as Record<string, unknown>;
  // UpsertEntryInput keeps basis optional for UI edits; the Agent must always state it.
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return { ...schema, required: required.includes("basis") ? required : [...required, "basis"] };
}

export const ROOM_TOOLS: FunctionTool[] = [
  {
    type: "function",
    name: "list_entries",
    description: "List all entries in the Room knowledge base.",
    strict: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "read_entry",
    description: "Read one Room entry by id.",
    strict: false,
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    type: "function",
    name: "upsert_entry",
    description: "Create an entry, or update one when `id` is given. sourceMessages and reason are required.",
    strict: false,
    parameters: upsertParameters(),
  },
  {
    type: "function",
    name: "open_thread",
    description: "Move this conversation into a thread anchored on the current message. When the user asks to compare options or weigh tradeoffs and has not decided, call this first and discuss inside the thread. Your reply will be posted in the thread.",
    strict: false,
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
  },
];

/** Claude allowed names for the same functions `roomTools` declares, prefixed `mcp__room__`. */
export function claudeAllowedToolNames(pluginTools: PluginToolSpec[]): string[] {
  return roomTools(pluginTools).map((tool) => `mcp__room__${tool.name}`);
}

/** The 4 Room functions, then one non-strict function per plugin tool, in the order the task listed them. */
export function roomTools(pluginTools: PluginToolSpec[]): FunctionTool[] {
  return [
    ...ROOM_TOOLS,
    ...pluginTools.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      strict: false,
      parameters: tool.parameters,
    })),
  ];
}

const errorOutput = (error: string, extra: Record<string, unknown> = {}) => JSON.stringify({ error, ...extra });

/** Every output handed to the model is capped at 64 KB of UTF-8 (a truncated JSON output carries the marker). */
function resultOutput(r: RoomResult): string {
  if (!r.ok) return capText(errorOutput(r.error, { status: r.status }));
  return capText(typeof r.json === "string" ? r.json : JSON.stringify(r.json));
}

/**
 * Runs one model function call against the Room API. Unknown names and arguments that are not a JSON object
 * return an error output with `known: false` (the loop counts these) and never reach the hub.
 */
export async function dispatchTool(
  name: string,
  argsJson: string,
  room: RoomApi,
  pluginTools: PluginToolSpec[] = [],
): Promise<{ output: string; known: boolean }> {
  const plugin = pluginTools.find((tool) => tool.name === name);
  const isRoom = name === "list_entries" || name === "read_entry" || name === "upsert_entry" || name === "open_thread";
  if (!plugin && !isRoom) {
    const shown = name.length > 100 ? name.slice(0, 100) + "…" : name;
    const allowed = ["list_entries", "read_entry", "upsert_entry", "open_thread", ...pluginTools.map((tool) => tool.name)].join("、");
    return { output: errorOutput(`未知函数 ${JSON.stringify(shown)}；只能使用 ${allowed}`), known: false };
  }
  let args: unknown;
  try {
    args = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
  } catch {
    return { output: errorOutput(`${name} 的参数不是合法的 JSON`), known: false };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { output: errorOutput(`${name} 的参数必须是 JSON 对象`), known: false };
  }
  if (plugin) return { output: resultOutput(await room.callPlugin(name, args)), known: true };
  switch (name) {
    case "list_entries":
      return { output: resultOutput(await room.listEntries()), known: true };
    case "read_entry": {
      const id = (args as { id?: unknown }).id;
      if (typeof id !== "string" || id === "") return { output: errorOutput("read_entry 需要字符串参数 id"), known: true };
      return { output: resultOutput(await room.readEntry(id)), known: true };
    }
    case "upsert_entry":
      return { output: resultOutput(await room.upsertEntry(args)), known: true };
    case "open_thread":
      return { output: resultOutput(await room.openThread(args)), known: true };
  }
  throw new Error(`unreachable tool ${name}`);
}
