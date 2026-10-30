import { describe, expect, test } from "vitest";
import { CLAUDE_ROOM_TOOLS } from "../../src/claude/launch.js";
import { parseClaudeLine, roomToolsOk, skillActivationFrom } from "../../src/claude/events.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOOL_FACE = "Claude 的工具面无法确认为只有 Room：";

function expectRejected(result: { ok: true } | { ok: false; error: string }) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.startsWith(TOOL_FACE)).toBe(true);
}

const roomConnected = [{ name: "room", status: "connected" }];

describe("Claude Code stream-json judgment", () => {
  test("accepts the Room tool names when the only MCP server is room and connected", () => {
    expect(roomToolsOk([...CLAUDE_ROOM_TOOLS], roomConnected)).toEqual({ ok: true });
  });

  test("rejects an empty tool list even when the room server is connected", () => {
    expectRejected(roomToolsOk([], roomConnected));
  });

  test("rejects a room server that is not connected", () => {
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], [{ name: "room", status: "failed" }]));
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], [{ name: "room", status: null }]));
  });

  test("rejects a tool list that is missing one Room tool", () => {
    expectRejected(roomToolsOk(CLAUDE_ROOM_TOOLS.slice(0, 3), roomConnected));
  });

  test("rejects a tool outside the Room set", () => {
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS, "Bash"], roomConnected));
  });

  test("rejects an MCP server list that is not exactly room", () => {
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], [{ name: "room", status: "connected" }, { name: "other", status: "connected" }]));
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], []));
  });

  test("rejects a missing tool list or a missing MCP server list", () => {
    expectRejected(roomToolsOk(null, roomConnected));
    expectRejected(roomToolsOk([...CLAUDE_ROOM_TOOLS], null));
  });

  test("passes init tool names through, including a tool outside Room", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: ["mcp__room__list_entries", "Bash"],
      mcp_servers: [{ name: "room", status: "connected" }, { name: "other" }],
    });

    expect(parseClaudeLine(line)).toMatchObject({
      kind: "init",
      tools: ["mcp__room__list_entries", "Bash"],
      mcpServers: [{ name: "room", status: "connected" }, { name: "other", status: null }],
    });
  });

  test("reads a missing tools field as null and keeps server names", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "room", status: "connected" }],
    });

    expect(parseClaudeLine(line)).toMatchObject({ kind: "init", tools: null, mcpServers: [{ name: "room", status: "connected" }] });
  });

  test("reads a missing mcp_servers field as null", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", tools: [] });

    expect(parseClaudeLine(line)).toMatchObject({ kind: "init", tools: [], mcpServers: null });
  });

  test("treats an MCP server entry without a name as unconfirmed", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: [],
      mcp_servers: [{ name: "room" }, { status: "connected" }],
    });

    expect(parseClaudeLine(line)).toMatchObject({ kind: "init", tools: [], mcpServers: null });
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

    expect(parseClaudeLine(line)).toMatchObject({ kind: "tools", names: [CLAUDE_ROOM_TOOLS[0], "Bash"] });
  });

  test("reads an assistant tool_use name", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: {} }] },
    });

    expect(parseClaudeLine(line)).toMatchObject({ kind: "tools", names: ["Bash"] });
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

    expect(parseClaudeLine(line)).toMatchObject({
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

    expect(parseClaudeLine(line)).toMatchObject({ kind: "tools", names: ["Bash"] });
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

describe("Skill lines", () => {
  const lines = readFileSync(join(import.meta.dirname, "..", "fixtures", "claude-skill-stream.jsonl"), "utf8").trim().split("\n");

  test("init carries the version and the Skill list", () => {
    expect(parseClaudeLine(lines[0]!)).toMatchObject({ kind: "init", version: "2.1.309", skills: ["tdd", "pdf"] });
    expect(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", tools: [] }))).toMatchObject({ version: null, skills: null });
  });

  test("Skill and Read calls keep their ids and inputs", () => {
    expect(parseClaudeLine(lines[1]!)).toEqual({ kind: "tools", names: ["Skill"], uses: [{ id: "toolu_1", name: "Skill", input: { skill: "tdd" } }] });
    expect(parseClaudeLine(lines[3]!)).toMatchObject({ uses: [{ id: "toolu_2", name: "Read", input: { file_path: "RUNDIR/work/.claude/skills/pdf/SKILL.md" } }] });
  });

  test("tool results say which call failed", () => {
    expect(parseClaudeLine(lines[2]!)).toEqual({ kind: "results", results: [{ toolUseId: "toolu_1", isError: false }] });
    expect(parseClaudeLine(lines[4]!)).toEqual({ kind: "results", results: [{ toolUseId: "toolu_2", isError: true }] });
  });

  test("skillActivationFrom matches ids, copy folders and SKILL.md reads, and guesses nothing", () => {
    const dirs = new Map([
      ["tdd", "/run/work/.claude/skills/tdd/SKILL.md"],
      ["web-abc123:deploy", "/run/repo-skills/web-abc123/.claude/skills/deploy/SKILL.md"],
    ]);
    expect(skillActivationFrom({ name: "Skill", input: { skill: "tdd" } }, dirs)).toBe("tdd");
    expect(skillActivationFrom({ name: "Skill", input: { command: "web-abc123:deploy" } }, dirs)).toBe("web-abc123:deploy");
    expect(skillActivationFrom({ name: "Skill", input: { skill: "deploy" } }, dirs)).toBe("web-abc123:deploy");
    expect(skillActivationFrom({ name: "Skill", input: { skill: "other" } }, dirs)).toBeNull();
    expect(skillActivationFrom({ name: "Skill", input: { skill: "tdd", args: "x" } }, dirs)).toBeNull();
    expect(skillActivationFrom({ name: "Skill", input: "tdd" }, dirs)).toBeNull();
    expect(skillActivationFrom({ name: "Read", input: { file_path: "/run/work/.claude/skills/tdd/SKILL.md" } }, dirs)).toBe("tdd");
    expect(skillActivationFrom({ name: "Read", input: { file_path: "/run/work/.claude/skills/tdd/notes.md" } }, dirs)).toBeNull();
  });
});
