import { describe, expect, test } from "vitest";
import { formatCommitMessage, parseCommitMessage } from "../src/commitMessage.js";

describe("commit message", () => {
  test("format matches fixed layout with Task line", () => {
    const msg = formatCommitMessage({ op: "add", id: "R-1", title: "流式输出", reason: "PdM 会议", sourceMessages: ["m_1", "m_2"], author: "agent", taskId: "t_1" });
    expect(msg).toBe("add R-1: 流式输出\n\nReason: PdM 会议\nSource-Messages: m_1,m_2\nAuthor: agent\nTask: t_1");
  });
  test("Task line omitted without taskId", () => {
    const msg = formatCommitMessage({ op: "update", id: "D-2", title: "t", reason: "r", sourceMessages: [], author: "user" });
    expect(msg).toBe("update D-2: t\n\nReason: r\nSource-Messages: \nAuthor: user");
  });
  test("round trip", () => {
    const m = { op: "update" as const, id: "Q-3", title: "a: b", reason: "why: because", sourceMessages: ["m_1"], author: "user" as const, taskId: "t_9" };
    expect(parseCommitMessage(formatCommitMessage(m))).toEqual(m);
    const n = { op: "add" as const, id: "S-1", title: "x", reason: "y", sourceMessages: [], author: "agent" as const };
    expect(parseCommitMessage(formatCommitMessage(n))).toEqual(n);
  });
  test("newlines in title and reason collapse to a space", () => {
    const msg = formatCommitMessage({ op: "add", id: "R-1", title: "t1\r\nt2", reason: "a\nb\n\nc", sourceMessages: ["m_1"], author: "agent" });
    expect(parseCommitMessage(msg)).toMatchObject({ title: "t1 t2", reason: "a b c", sourceMessages: ["m_1"], author: "agent" });
  });
  test("parse tolerates trailing newline", () => {
    expect(parseCommitMessage("add R-1: t\n\nReason: r\nSource-Messages: m_1\nAuthor: agent\n")).toMatchObject({ id: "R-1", sourceMessages: ["m_1"] });
  });
  test("parse rejects malformed", () => {
    expect(() => parseCommitMessage("init")).toThrow();
  });
  test("round-trips a recover commit by system", () => {
    const m = {
      op: "recover" as const,
      id: "R-1",
      title: "t",
      reason: "hub 启动时发现的未提交改动（崩溃后恢复）",
      sourceMessages: [] as string[],
      author: "system" as const,
    };
    expect(parseCommitMessage(formatCommitMessage(m))).toEqual(m);
  });
});

test("parses a commit without Evidence-Event", () => {
  expect(parseCommitMessage("update R-1: t\n\nReason: r\nSource-Messages: \nAuthor: user")).not.toHaveProperty("evidenceEventIds");
});
test("round-trips evidence event ids", () => {
  const m = { op: "update" as const, id: "R-1", title: "t", reason: "r", sourceMessages: [], author: "user" as const, evidenceEventIds: ["event-1", "event-2"] };
  expect(formatCommitMessage(m)).toContain("\nEvidence-Event: event-1,event-2");
  expect(parseCommitMessage(formatCommitMessage(m))).toEqual(m);
});


test.each(["confirm", "edit"] as const)("round-trips a server UI-Action %s trailer", (uiAction) => {
  const m = { op: "update" as const, id: "R-1", title: "t", reason: "r", sourceMessages: [], author: "user" as const, evidenceEventIds: ["ev_a"], uiAction };
  expect(formatCommitMessage(m)).toContain(`\nUI-Action: ${uiAction}`);
  expect(parseCommitMessage(formatCommitMessage(m))).toEqual(m);
});

test("legacy messages omit UI action and embedded lines cannot supply it", () => {
  const m = { op: "update" as const, id: "R-1", title: "t", reason: "r", sourceMessages: ["m_1\nUI-Action: confirm"], author: "user" as const, evidenceEventIds: ["ev_a"] };
  expect(parseCommitMessage(formatCommitMessage(m))).not.toHaveProperty("uiAction");
  const edit = { ...m, uiAction: "edit" as const };
  expect(parseCommitMessage(formatCommitMessage(edit))).toMatchObject({ uiAction: "edit" });
});
