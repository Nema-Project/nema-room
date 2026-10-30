import { describe, expect, test } from "vitest";
import * as shared from "../src/index.js";
import {
  MENTION_LIMITS,
  MessageMention,
  UserMessageMeta,
  fuzzyScore,
  keepMentionsFor,
  mentionText,
  type MessageMention as Mention,
} from "../src/index.js";

const entry = (id: string, text = `[${id}]`): Mention => ({ type: "entry", id, text });
const attachment = (over: Partial<Extract<Mention, { type: "attachment" }>> = {}): Mention => ({
  type: "attachment", id: "att_abcdefghijklmnop", text: "`附件：截图 1.png`", ...over,
});

describe("MessageMention", () => {
  test("accepts the three workspace kinds, each with its text", () => {
    expect(MessageMention.safeParse({ type: "entry", id: "W-3", text: "[W-3]" }).success).toBe(true);
    expect(MessageMention.safeParse(attachment()).success).toBe(true);
    expect(MessageMention.safeParse({ type: "thread", id: "t1", text: "[话题：发布]" }).success).toBe(true);
  });

  test("a repository file mention is no longer a valid kind", () => {
    expect(MessageMention.safeParse({ type: "file", repoId: "r1", path: "a.ts", commit: "a".repeat(40), text: "`web:a.ts`" }).success).toBe(false);
  });

  test("text is required and bounded", () => {
    expect(MessageMention.safeParse({ type: "attachment", id: "att_abcdefghijklmnop" }).success).toBe(false);
    expect(MessageMention.safeParse({ type: "entry", id: "W-3", text: "" }).success).toBe(false);
    expect(MessageMention.safeParse({ type: "entry", id: "W-3", text: "x".repeat(4097) }).success).toBe(false);
  });

  test("an entry id with a trailing newline is refused", () => {
    expect(MessageMention.safeParse(entry("D-12\n")).success).toBe(false);
  });

  test("entry ids follow the entry id rule", () => {
    for (const id of ["D-0", "X-1", "D-01", "d-1", "D1"]) expect(MessageMention.safeParse(entry(id)).success, id).toBe(false);
    for (const id of ["R-1", "D-12", "T-3", "Q-4", "S-5", "G-6", "W-7"]) expect(MessageMention.safeParse(entry(id)).success, id).toBe(true);
  });

  test("an attachment id is a non-empty bounded string", () => {
    expect(MessageMention.safeParse(attachment({ id: "" })).success).toBe(false);
    expect(MessageMention.safeParse(attachment({ id: "a".repeat(65) })).success).toBe(false);
  });

  test("a thread id is a non-empty string", () => {
    expect(MessageMention.safeParse({ type: "thread", id: "", text: "[话题：x]" }).success).toBe(false);
  });
});

describe("MENTION_LIMITS", () => {
  test("counts attachment candidates and no longer names repository files", () => {
    expect(MENTION_LIMITS.attachmentCandidates).toBe(50);
    expect(MENTION_LIMITS).not.toHaveProperty("fileCandidates");
    expect(MENTION_LIMITS.perMessage).toBe(20);
    expect(MENTION_LIMITS.entryBytes).toBe(4096);
    expect(MENTION_LIMITS.entriesTotalBytes).toBe(16384);
    expect(MENTION_LIMITS.menuPerGroup).toBe(8);
    expect(MENTION_LIMITS.threadAnchorBytes).toBe(1024);
  });
});

describe("UserMessageMeta.mentions", () => {
  test("holds at most 20 mentions", () => {
    const twenty = Array.from({ length: MENTION_LIMITS.perMessage }, (_, i) => entry(`D-${i + 1}`));
    expect(UserMessageMeta.safeParse({ mentions: twenty }).success).toBe(true);
    expect(UserMessageMeta.safeParse({ mentions: [...twenty, entry("D-21")] }).success).toBe(false);
  });

  test("old meta without mentions still parses", () => {
    expect(UserMessageMeta.parse({ quote: { messageId: "m1", role: "agent", excerpt: "x" } })).toEqual({ quote: { messageId: "m1", role: "agent", excerpt: "x" } });
    expect(UserMessageMeta.parse({})).toEqual({});
  });
});

describe("no repository path helper is exported any more", () => {
  test("normalizeMentionPath is gone", () => {
    expect("normalizeMentionPath" in shared).toBe(false);
  });
});

describe("fuzzyScore", () => {
  const rank = (q: string, candidates: string[]) =>
    candidates.map((p) => [p, fuzzyScore(q, p)] as const).filter(([, s]) => s !== null).sort((a, b) => b[1]! - a[1]!).map(([p]) => p);

  test("a last-segment prefix beats a segment prefix", () => {
    expect(rank("slash", ["apps/web/lib/slashy/x.ts", "apps/web/lib/slash.ts"])).toEqual(["apps/web/lib/slash.ts", "apps/web/lib/slashy/x.ts"]);
  });

  test("a segment prefix beats a subsequence", () => {
    expect(rank("lib", ["apps/xlxixbx.ts", "apps/web/lib/a.ts"])).toEqual(["apps/web/lib/a.ts", "apps/xlxixbx.ts"]);
  });

  test("a plain title is matched as a whole name: prefix first", () => {
    expect(rank("发布", ["旧发布流程", "发布流程 v2", "部署"])).toEqual(["发布流程 v2", "旧发布流程"]);
  });

  test("is case-insensitive and prefers the shorter candidate on a tie", () => {
    expect(fuzzyScore("SLASH", "apps/web/lib/slash.ts")).toBe(fuzzyScore("slash", "apps/web/lib/slash.ts"));
    expect(rank("slash", ["apps/web/lib/slash.ts", "a/slash.ts"])).toEqual(["a/slash.ts", "apps/web/lib/slash.ts"]);
  });

  test("a query with characters outside the BMP still matches as a subsequence", () => {
    expect(fuzzyScore("😀z", "docs/😀-x/z.md")).not.toBeNull();
    expect(fuzzyScore("𠮷野", "src/𠮷a野.ts")).not.toBeNull();
  });

  test("no match is null", () => {
    expect(fuzzyScore("zzz", "apps/web/lib/slash.ts")).toBeNull();
    expect(fuzzyScore("hsals", "apps/web/lib/slash.ts")).toBeNull();
  });
});

describe("mentionText", () => {
  test("entry, attachment and thread", () => {
    expect(mentionText(entry("D-12"), {})).toBe("[D-12]");
    expect(mentionText(attachment(), { attachmentName: "截图 1.png" })).toBe("`附件：截图 1.png`");
    expect(mentionText({ type: "thread", id: "t1", text: "x" }, { threadTitle: "发布流程" })).toBe("[话题：发布流程]");
  });

  test("the longest attachment name still passes the schema", () => {
    const name = "长".repeat(200);
    const m = attachment();
    expect(MessageMention.safeParse({ ...m, text: mentionText(m, { attachmentName: name }) }).success).toBe(true);
  });

  test("a backtick in the attachment name cannot close the code span early", () => {
    expect(mentionText(attachment(), { attachmentName: "a`b.png" })).toBe("``附件：a`b.png``");
    // CommonMark strips one space on each side, so content ending with a backtick is padded (the `附件：` prefix
    // means it can never begin with one).
    expect(mentionText(attachment(), { attachmentName: "b.png`" })).toBe("`` 附件：b.png` ``");
    const worst = attachment();
    expect(MessageMention.safeParse({ ...worst, text: mentionText(worst, { attachmentName: "`".repeat(200) }) }).success).toBe(true);
  });

  test("without a name the attachment id is used", () => {
    expect(mentionText(attachment(), {})).toBe("`附件：att_abcdefghijklmnop`");
  });
});

describe("keepMentionsFor", () => {
  test("two [D-12] in the body and two mentions: removing one occurrence keeps only the first mention", () => {
    const a = entry("D-12");
    const b = { ...entry("D-12") };
    expect(keepMentionsFor("按 [D-12] 和 [D-12]", [a, b])).toEqual([a, b]);
    const kept = keepMentionsFor("按 [D-12] 来", [a, b]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toBe(a);
  });

  test("removing every occurrence keeps none", () => {
    expect(keepMentionsFor("没有引用了", [entry("D-12"), entry("D-12")])).toEqual([]);
  });

  test("a mention is kept by its stored text even if the name changed since", () => {
    const old = attachment({ text: "`附件：旧名字.png`" });
    expect(keepMentionsFor("看 `附件：旧名字.png`", [old])).toEqual([old]);
  });

  test("keeps the original order across different texts", () => {
    const d = entry("D-1");
    const a = attachment();
    expect(keepMentionsFor("`附件：截图 1.png` 和 [D-1]", [d, a])).toEqual([d, a]);
  });
});
