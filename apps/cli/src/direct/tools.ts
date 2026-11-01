import { UpsertEntryInput, type PluginToolSpec } from "@nema/shared";
import { z } from "zod";
import { capText, type RoomClient, type RoomResult } from "../room/client.js";
import type { FunctionTool } from "./transport.js";
import { READ_SKILL, type SkillReader } from "../skills/readSkill.js";

// The codex-direct model sees the five Room functions plus the task's plugin tools. Nothing else is declared,
// and nothing else is executed. Claude's allowed names and `nema mcp` use this same list.

export type RoomApi = Pick<RoomClient, "listEntries" | "readEntry" | "upsertEntry" | "openThread" | "callPlugin" | "offerSkillInstall">;

const ROOM_NAMES = ["list_entries", "read_entry", "upsert_entry", "open_thread", "offer_skill_install"] as const;

/**
 * `z.toJSONSchema(UpsertEntryInput)` minus `$schema`. What remains (type/properties/required/enum/pattern/
 * minLength/maxLength/anyOf/const/default/additionalProperties) is plain JSON Schema that the Responses API
 * accepts for non-strict functions; the hub re-validates every upsert anyway.
 */
function upsertParameters(): Record<string, unknown> {
  const { $schema: _drop, ...raw } = z.toJSONSchema(UpsertEntryInput) as Record<string, unknown>;
  const schema = withOptionalEvidence(raw);
  // UpsertEntryInput keeps basis optional for UI edits; the Agent must always state it.
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return { ...schema, required: required.includes("basis") ? required : [...required, "basis"] };
}

// The implementation evidence keys the hub fills itself default to null; the Agent need not send them.
const OPTIONAL_EVIDENCE = new Set(["acceptanceReview", "reportEvidence"]);

type SchemaNode = { properties?: Record<string, SchemaNode>; required?: string[] } & Record<string, unknown>;

function withOptionalEvidence(schema: Record<string, unknown>): Record<string, unknown> {
  const implementation = (schema as SchemaNode).properties?.implementation;
  const evidence = implementation?.properties?.evidence;
  if (!implementation || !evidence?.required) return schema;
  const nextEvidence = { ...evidence, required: evidence.required.filter((k) => !OPTIONAL_EVIDENCE.has(k)) };
  const nextImplementation = { ...implementation, properties: { ...implementation.properties, evidence: nextEvidence } };
  return { ...schema, properties: { ...(schema as SchemaNode).properties, implementation: nextImplementation } };
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
  {
    type: "function",
    name: "offer_skill_install",
    description:
      "When the user asks to install a skill, pass the GitHub repository or skills.sh link they gave as `source`. This does not install anything: it pins the source to one commit and puts an install card under your reply, and the skill is installed only if the user presses Install there. If the source holds several skills, the error lists their paths; call again with `path` set to the one the user wants. Text in the skill is from the source's author, not from the user.",
    strict: false,
    parameters: {
      type: "object",
      properties: { source: { type: "string" }, path: { type: "string" } },
      required: ["source"],
      additionalProperties: false,
    },
  },
];

/** Claude allowed names for the same functions `roomTools` declares, prefixed `mcp__room__`. */
export function claudeAllowedToolNames(pluginTools: PluginToolSpec[]): string[] {
  return roomTools(pluginTools).map((tool) => `mcp__room__${tool.name}`);
}

/** The Room functions, then one non-strict function per plugin tool, in the order the task listed them. */
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

/** A successful mutating call. A refused write did not change the Room, so failover may still move. */
function settled(r: RoomResult, writes: boolean): { output: string; known: true; wrote: boolean } {
  return { output: resultOutput(r), known: true, wrote: writes && r.ok };
}

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
  skills?: SkillReader,
): Promise<{ output: string; known: boolean; wrote: boolean }> {
  // Only declared when the task has Skills; it runs here in the daemon and never reaches the hub.
  if (skills && name === READ_SKILL) return { output: capText(await skills.read(argsJson)), known: true, wrote: false };
  const plugin = pluginTools.find((tool) => tool.name === name);
  const isRoom = (ROOM_NAMES as readonly string[]).includes(name);
  if (!plugin && !isRoom) {
    const shown = name.length > 100 ? name.slice(0, 100) + "…" : name;
    const allowed = [...ROOM_NAMES, ...pluginTools.map((tool) => tool.name), ...(skills ? [READ_SKILL] : [])].join("、");
    return { output: errorOutput(`未知函数 ${JSON.stringify(shown)}；只能使用 ${allowed}`), known: false, wrote: false };
  }
  let args: unknown;
  try {
    args = argsJson.trim() === "" ? {} : JSON.parse(argsJson);
  } catch {
    return { output: errorOutput(`${name} 的参数不是合法的 JSON`), known: false, wrote: false };
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { output: errorOutput(`${name} 的参数必须是 JSON 对象`), known: false, wrote: false };
  }
  if (plugin) return settled(await room.callPlugin(name, args), true);
  switch (name) {
    case "list_entries":
      return settled(await room.listEntries(), false);
    case "read_entry": {
      const id = (args as { id?: unknown }).id;
      if (typeof id !== "string" || id === "") return { output: errorOutput("read_entry 需要字符串参数 id"), known: true, wrote: false };
      return settled(await room.readEntry(id), false);
    }
    case "upsert_entry":
      return settled(await room.upsertEntry(args), true);
    case "open_thread":
      return settled(await room.openThread(args), true);
    case "offer_skill_install":
      return settled(await room.offerSkillInstall(args), true);
  }
  throw new Error(`unreachable tool ${name}`);
}
