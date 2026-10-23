import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseCodexLine } from "../src/codex/events.js";

describe("parseCodexLine", () => {
  const events = readFileSync(new URL("./fixtures/codex-ok.jsonl", import.meta.url), "utf8")
    .split("\n").filter(Boolean).map((l) => parseCodexLine(l));
  test("real sample yields agent_message and turn_completed", () => {
    expect(events).toContainEqual({ kind: "agent_message", text: "ok" });
    expect(events).toContainEqual({ kind: "turn_completed" });
  });
  test("non-json is null", () => {
    expect(parseCodexLine("not json")).toBeNull();
    expect(parseCodexLine("42")).toBeNull();
  });
  test("mcp call carries server and tool", () => {
    const line = JSON.stringify({ type: "item.started", item: { type: "mcp_tool_call", server: "github", tool: "search" } });
    expect(parseCodexLine(line)).toEqual({ kind: "mcp_call", server: "github", tool: "search" });
  });
  test("errors and unknown types", () => {
    expect(parseCodexLine('{"type":"error","message":"bad"}')).toEqual({ kind: "error", message: "bad" });
    expect(parseCodexLine('{"type":"turn.failed","error":{"message":"x"}}')).toEqual({ kind: "error", message: "x" });
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual({ kind: "other" });
  });
});
