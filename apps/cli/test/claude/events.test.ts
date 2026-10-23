import { describe, expect, test } from "vitest";
import { CLAUDE_ROOM_TOOLS } from "../../src/claude/launch.js";
import { parseClaudeLine, roomToolsOk } from "../../src/claude/events.js";

const TOOL_FACE = "Claude 的工具面无法确认为只有 Room：";

function expectRejected(result: { ok: true } | { ok: false; error: string }) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.startsWith(TOOL_FACE)).toBe(true);
}

describe("Claude Code stream-json judgment", () => {
  test("accepts the Room tool names when the only MCP server is room", () => {
    expect(roomToolsOk([...CLAUDE_ROOM_TOOLS], ["room"])).toEqual({ ok: true });
  });

  test("accepts an empty tool list when the only MCP server is room", () => {
    expect(roomToolsOk([], ["room"])).toEqual({ ok: true });
  });

  test("rejects a tool outside the Room set", () => {
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS, "Bash"], ["room"]));
  });

  test("rejects an MCP server list that is not exactly room", () => {
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], ["room", "other"]));
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], []));
  });

  test("rejects a missing tool list or a missing MCP server list", () => {
    expectRejected(roomToolsOk(null, ["room"]));
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], null));
  });

  test("passes init tool names through, including a tool outside Room", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: ["mcp__room__list_entries", "Bash"],
      mcp_servers: [{ name: "room", status: "connected" }, { name: "other" }],
    });

    expect(parseClaudeLine(line)).toEqual({
      kind: "init",
      tools: ["mcp__room__list_entries", "Bash"],
      mcpServers: ["room", "other"],
    });
  });

  test("reads a missing tools field as null and keeps server names", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "room", status: "connected" }],
    });

    expect(parseClaudeLine(line)).toEqual({ kind: "init", tools: null, mcpServers: ["room"] });
  });

  test("reads a missing mcp_servers field as null", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", tools: [] });

    expect(parseClaudeLine(line)).toEqual({ kind: "init", tools: [], mcpServers: null });
  });

  test("treats an MCP server entry without a name as unconfirmed", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: [],
      mcp_servers: [{ name: "room" }, { status: "connected" }],
    });

    expect(parseClaudeLine(line)).toEqual({ kind: "init", tools: [], mcpServers: null });
  });

  test("surfaces a disallowed tool that follows a Room tool in the same message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: CLAUDE_ROOM_TOOLS[0], input: {} },
          { type: "tool_use", name: "Bash", input: {} },
        ],
      },
    });

    expect(parseClaudeLine(line)).toEqual({ kind: "tools", names: [CLAUDE_ROOM_TOOLS[0], "Bash"] });
  });

  test("reads an assistant tool_use name", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });

    expect(parseClaudeLine(line)).toEqual({ kind: "tools", names: ["Bash"] });
  });

  test("returns every parallel tool_use name in one message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: CLAUDE_ROOM_TOOLS[2], input: {} },
          { type: "tool_use", name: CLAUDE_ROOM_TOOLS[2], input: {} },
          { type: "tool_use", name: CLAUDE_ROOM_TOOLS[1], input: {} },
        ],
      },
    });

    expect(parseClaudeLine(line)).toEqual({
      kind: "tools",
      names: [CLAUDE_ROOM_TOOLS[2], CLAUDE_ROOM_TOOLS[2], CLAUDE_ROOM_TOOLS[1]],
    });
  });

  test("reads assistant text when the message has no tool_use", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "checking the room" }] },
    });

    expect(parseClaudeLine(line)).toEqual({ kind: "text", text: "checking the room" });
  });

  test("reports tool_use when the assistant message also has text", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "checking the room" },
          { type: "tool_use", name: "Bash", input: {} },
        ],
      },
    });

    expect(parseClaudeLine(line)).toEqual({ kind: "tools", names: ["Bash"] });
  });

  test("reads the final result string", () => {
    const line = JSON.stringify({ type: "result", result: "整理好了" });

    expect(parseClaudeLine(line)).toEqual({ kind: "result", text: "整理好了" });
  });

  test("drops an error result instead of keeping its text", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "should-not-stick",
    });

    expect(parseClaudeLine(line)).toEqual({ kind: "failure" });
  });

  test("ignores a line that is not JSON", () => {
    expect(parseClaudeLine("not-json{")).toEqual({ kind: "ignore" });
  });

  test("ignores events other than init, assistant text or tool, and result", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: { content: [] } }))).toEqual({ kind: "ignore" });
  });
});
