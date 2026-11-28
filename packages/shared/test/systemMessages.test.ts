import { describe, expect, test } from "vitest";
import { NOTICE, readSystemNotice } from "../src/index.js";

describe("system message notices (#299 batch 2)", () => {
  test("every notice code the hub writes reads back", () => {
    for (const code of Object.values(NOTICE)) expect(readSystemNotice({ notice: { code } })).toEqual({ code });
  });

  test("keeps string and number params and drops the rest", () => {
    expect(readSystemNotice({ changes: [], notice: { code: "question.followUp", params: { id: "Q-1", title: "t", n: 2, nested: { x: 1 } } } }))
      .toEqual({ code: "question.followUp", params: { id: "Q-1", title: "t", n: 2 } });
  });

  test("meta without a readable notice is no notice: the caller shows content", () => {
    for (const meta of [null, undefined, "legacy", [], {}, { changes: [], askedQuestion: null }, { notice: null }, { notice: [] }, { notice: "task.failed" },
      { notice: { code: 1 } }, { notice: { code: "" } }, { notice: { code: "Task.failed" } }, { notice: { code: "../x" } }, { notice: { code: "a b" } },
      { notice: { code: "a".repeat(81) } }]) {
      expect(readSystemNotice(meta)).toBeUndefined();
    }
  });
});
