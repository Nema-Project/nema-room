import { describe, expect, test } from "vitest";
import { groupCandidates, mentionToken, syncMentions, type MentionContextResponse } from "@/lib/mentions";

const context = (over: Partial<MentionContextResponse> = {}): MentionContextResponse => ({
  status: "ok",
  entries: [
    { id: "D-12", kind: "decision", title: "发布流程", status: "active" },
    { id: "R-3", kind: "requirement", title: "支持导出", status: "active" },
  ],
  attachments: [{ id: "att_1", name: "发布会截图.png", kind: "image", size: 100, messageId: "m_1", createdAt: "2026-10-30T00:00:00.000Z" }],
  threads: [{ id: "m_2", title: "发布流程讨论", lastReplyAt: null }],
  truncated: false,
  ...over,
});

describe("mentionToken", () => {
  test("opens at the start of a line, after a space, and after an opening bracket or comma", () => {
    for (const text of ["@d", "看 @d", "（@d", "，@d", "「@d", "『@d", "。@d", "、@d", "：@d"]) {
      expect(mentionToken(text, text.length), text).toEqual({ query: "d", start: text.length - 2, end: text.length });
    }
  });

  test("does not open inside a word, an email, across a space, or in a code block", () => {
    expect(mentionToken("a@b", 3)).toBeNull();
    expect(mentionToken("看 @d 再说", 8)).toBeNull();
    expect(mentionToken("```\n@d\n```", 6)).toBeNull();
    expect(mentionToken("@", 1)).toMatchObject({ query: "" });
    // A caret placed before the @ is outside the token.
    expect(mentionToken("看 @d", 1)).toBeNull();
  });

  test("stops at 100 characters after the @", () => {
    const ok = `@${"x".repeat(99)}`;
    expect(mentionToken(ok, ok.length)).not.toBeNull();
    const long = `@${"x".repeat(100)}`;
    expect(mentionToken(long, long.length)).toBeNull();
  });

  test("a line break before the caret ends the token", () => {
    expect(mentionToken("看 @d\n第二行", 7)).toBeNull();
  });
});

describe("groupCandidates", () => {
  test("groups are entries, attachments, threads, at most 8 each", () => {
    const many = context({
      entries: Array.from({ length: 12 }, (_, i) => ({ id: `D-${i + 1}`, kind: "decision", title: `条目 ${i + 1}`, status: "active" })),
      attachments: Array.from({ length: 12 }, (_, i) => ({ id: `att_${i}`, name: `文件 ${i}.png`, kind: "image", size: 1, messageId: "m", createdAt: "" })),
      threads: Array.from({ length: 12 }, (_, i) => ({ id: `m_${i}`, title: `话题 ${i}`, lastReplyAt: null })),
    });
    const groups = groupCandidates("", many);
    expect(groups.map((g) => g.kind)).toEqual(["entry", "attachment", "thread"]);
    for (const g of groups) expect(g.items.length).toBeLessThanOrEqual(8);
  });

  test("an exactly typed id comes first", () => {
    const groups = groupCandidates("d-12", context());
    expect(groups[0]!.items[0]).toMatchObject({ type: "entry", id: "D-12" });
  });

  test("filters by title and name", () => {
    expect(groupCandidates("导出", context()).find((g) => g.kind === "entry")!.items.map((i) => i.id)).toEqual(["R-3"]);
    expect(groupCandidates("截图", context()).find((g) => g.kind === "attachment")!.items.map((i) => i.id)).toEqual(["att_1"]);
    expect(groupCandidates("zzz", context()).every((g) => g.items.length === 0)).toBe(true);
  });

  test("gives each row the text it will write into the body", () => {
    const groups = groupCandidates("", context());
    expect(groups.find((g) => g.kind === "entry")!.items[0]).toMatchObject({ text: "[D-12]" });
    expect(groups.find((g) => g.kind === "attachment")!.items[0]).toMatchObject({ text: "`附件：发布会截图.png`" });
    expect(groups.find((g) => g.kind === "thread")!.items[0]).toMatchObject({ text: "[话题：发布流程讨论]" });
  });

  test("an empty query keeps entries newest-first and threads by last reply", () => {
    const groups = groupCandidates("", context({
      entries: [
        { id: "D-1", kind: "decision", title: "旧", status: "active" },
        { id: "D-2", kind: "decision", title: "新", status: "active" },
      ],
      threads: [
        { id: "m_1", title: "久未回复", lastReplyAt: "2026-10-01T00:00:00.000Z" },
        { id: "m_2", title: "刚回复", lastReplyAt: "2026-10-30T00:00:00.000Z" },
      ],
    }));
    expect(groups.find((g) => g.kind === "thread")!.items.map((i) => i.id)).toEqual(["m_2", "m_1"]);
    expect(groups.find((g) => g.kind === "entry")!.items.map((i) => i.id)).toEqual(["D-1", "D-2"]);
  });
});

describe("syncMentions", () => {
  const entry = { type: "entry", id: "D-12", text: "[D-12]" } as const;
  const att = { type: "attachment", id: "att_1", text: "`附件：发布会截图.png`" } as const;

  test("drops a mention whose text left the body", () => {
    expect(syncMentions("没有引用了", [entry])).toEqual([]);
  });

  test("two identical texts lose one mention when one occurrence goes", () => {
    expect(syncMentions("按 [D-12] 和 [D-12]", [entry, { ...entry }])).toHaveLength(2);
    expect(syncMentions("按 [D-12] 来", [entry, { ...entry }])).toHaveLength(1);
  });

  test("keeps a mention whose stored text survives even if the file was renamed", () => {
    expect(syncMentions("看 `附件：旧名字.png`", [{ ...att, text: "`附件：旧名字.png`" }])).toHaveLength(1);
  });
});
