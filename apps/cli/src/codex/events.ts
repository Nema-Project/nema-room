// Codex `exec --json` event parsing.
// Observed in test/fixtures/codex-ok.jsonl (codex-cli 0.148.0), one JSON object per line:
//   {"type":"thread.started","thread_id":...}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
//   {"type":"turn.completed","usage":{...}}
// NOT observed in the 0.148 sample, nor in a 0.163 `exec --json` run that had a room MCP server
// configured (2026-10-22): the stream is only thread.started, turn.started, items, turn.completed.
// Codex's internal mcp_startup_complete / session_configured events are not printed by `exec --json`,
// so a run cannot confirm "only Room, no instruction files" from startup output. The shapes below follow
// the documented exec JSONL schema and must be re-verified if Codex changes:
//   MCP call:  {"type":"item.started"|"item.completed","item":{"type":"mcp_tool_call","server":"room","tool":"list_entries",...}}
//   errors:    {"type":"error","message":...}, {"type":"turn.failed","error":{"message":...}},
//              or an item of type "error" with a `message`.
// If a future Codex omits `server` on MCP items we cannot attribute the call; the guard then relies on
// preflight + the generated config.toml containing only `room`.
export type CodexEvent =
  | { kind: "agent_message"; text: string }
  | { kind: "mcp_call"; server: string; tool: string }
  | { kind: "turn_completed" }
  | { kind: "error"; message: string }
  | { kind: "other" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseCodexLine(line: string): CodexEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "turn.completed":
      return { kind: "turn_completed" };
    case "turn.failed": {
      const e = raw.error;
      return { kind: "error", message: isObj(e) && typeof e.message === "string" ? e.message : "turn failed" };
    }
    case "error":
      return { kind: "error", message: typeof raw.message === "string" ? raw.message : "error" };
    case "item.started":
    case "item.completed":
    case "item.updated": {
      const item = raw.item;
      if (!isObj(item)) return { kind: "other" };
      if (item.type === "agent_message" && raw.type === "item.completed" && typeof item.text === "string") {
        return { kind: "agent_message", text: item.text };
      }
      if (item.type === "mcp_tool_call") {
        return {
          kind: "mcp_call",
          server: typeof item.server === "string" ? item.server : "",
          tool: typeof item.tool === "string" ? item.tool : "",
        };
      }
      if (item.type === "error" && typeof item.message === "string") return { kind: "error", message: item.message };
      return { kind: "other" };
    }
    default:
      return { kind: "other" };
  }
}
