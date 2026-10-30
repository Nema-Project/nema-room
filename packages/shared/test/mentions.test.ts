import { describe, expect, test } from "vitest";
import {
  MENTION_LIMITS,
  MessageMention,
  UserMessageMeta,
  fuzzyScore,
  keepMentionsFor,
  mentionText,
  normalizeMentionPath,
  type MessageMention as Mention,
} from "../src/index.js";

const SHA = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const entry = (id: string, text = `[${id}]`): Mention => ({ type: "entry", id, text });
const file = (over: Partial<Extract<Mention, { type: "file" }>> = {}): Mention => ({
  type: "file", repoId: "r1", path: "apps/web/lib/slash.ts", commit: SHA, text: "`web:apps/web/lib/slash.ts`", ...over,
});

describe("MessageMention", () => {
  test("accepts the three kinds, each with its text", () => {
    expect(MessageMention.safeParse({ type: "entry", id: "W-3", text: "[W-3]" }).success).toBe(true);
    expect(MessageMention.safeParse(file()).success).toBe(true);
    expect(MessageMention.safeParse({ type: "thread", id: "t1", text: "[话题：发布]" }).success).toBe(true);
  });

  test("text is required and bounded", () => {
    expect(MessageMention.safeParse({ type: "entry", id: "W-3" }).success).toBe(false);
    expect(MessageMention.safeParse({ type: "entry", id: "W-3", text: "" }).success).toBe(false);
    expect(MessageMention.safeParse({ type: "entry", id: "W-3", text: "x".repeat(4097) }).success).toBe(false);
  });

  test("ids and commits with a trailing newline are refused", () => {
    expect(MessageMention.safeParse(entry("D-12\n")).success).toBe(false);
    expect(MessageMention.safeParse(file({ commit: `${SHA}\n` })).success).toBe(false);
  });

  test("entry ids follow the entry id rule", () => {
    for (const id of ["D-0", "X-1", "D-01", "d-1", "D1"]) expect(MessageMention.safeParse(entry(id)).success, id).toBe(false);
    for (const id of ["R-1", "D-12", "T-3", "Q-4", "S-5", "G-6", "W-7"]) expect(MessageMention.safeParse(entry(id)).success, id).toBe(true);
  });

  test("file commit is a full lowercase sha, commitSource is head or candidate or absent, path is bounded", () => {
    expect(MessageMention.safeParse(file({ commit: SHA.slice(0, 7) })).success).toBe(false);
    expect(MessageMention.safeParse(file({ commit: SHA.toUpperCase() })).success).toBe(false);
    expect(MessageMention.safeParse(file({ commitSource: "head" })).success).toBe(true);
    expect(MessageMention.safeParse(file({ commitSource: "candidate" })).success).toBe(true);
    expect(MessageMention.safeParse({ ...file(), commitSource: "web" }).success).toBe(false);
    expect(MessageMention.safeParse(file({ path: "a".repeat(1024) })).success).toBe(true);
    expect(MessageMention.safeParse(file({ path: "a".repeat(1025) })).success).toBe(false);
    expect(MessageMention.safeParse(file({ repoId: "" })).success).toBe(false);
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

describe("normalizeMentionPath", () => {
  test("keeps plain relative paths and tidies ./ and //", () => {
    expect(normalizeMentionPath("a/b.ts")).toBe("a/b.ts");
    expect(normalizeMentionPath("./a")).toBe("a");
    expect(normalizeMentionPath("a//b")).toBe("a/b");
    expect(normalizeMentionPath("a/./b")).toBe("a/b");
    expect(normalizeMentionPath("路径 有空格/文件.md")).toBe("路径 有空格/文件.md");
  });

  test("rejects parent segments, absolute paths, backslashes, NUL and empty paths", () => {
    for (const p of ["../a", "a/../b", "..", "/a", "a\\b", "a\u0000b", "", ".", "./", "a".repeat(1025)]) expect(normalizeMentionPath(p), JSON.stringify(p)).toBeNull();
  });

  test("rejects Windows drive-rooted paths but keeps a colon elsewhere", () => {
    for (const p of ["C:/outside/file", "c:", "./D:/x"]) expect(normalizeMentionPath(p), p).toBeNull();
    expect(normalizeMentionPath("docs/a:b.md")).toBe("docs/a:b.md");
  });
});

describe("fuzzyScore", () => {
  const rank = (q: string, paths: string[]) =>
    paths.map((p) => [p, fuzzyScore(q, p)] as const).filter(([, s]) => s !== null).sort((a, b) => b[1]! - a[1]!).map(([p]) => p);

  test("a file-name prefix beats a path-segment prefix", () => {
    expect(rank("slash", ["apps/web/lib/slashy/x.ts", "apps/web/lib/slash.ts"])).toEqual(["apps/web/lib/slash.ts", "apps/web/lib/slashy/x.ts"]);
  });

  test("a path-segment prefix beats a subsequence", () => {
    expect(rank("lib", ["apps/xlxixbx.ts", "apps/web/lib/a.ts"])).toEqual(["apps/web/lib/a.ts", "apps/xlxixbx.ts"]);
  });

  test("a query spanning segments matches from a segment start", () => {
    expect(fuzzyScore("lib/sla", "apps/web/lib/slash.ts")).not.toBeNull();
    expect(fuzzyScore("lib/sla", "apps/web/lib/slash.ts")!).toBeGreaterThan(fuzzyScore("lib/sla", "apps/lxixb/sxlxa.ts") ?? -Infinity);
  });

  test("is case-insensitive and prefers the shorter path on a tie", () => {
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
  test("entry, file and thread", () => {
    expect(mentionText(entry("D-12"), {})).toBe("[D-12]");
    expect(mentionText(file(), { repoLabel: "web" })).toBe("`web:apps/web/lib/slash.ts`");
    expect(mentionText({ type: "thread", id: "t1", text: "x" }, { threadTitle: "发布流程" })).toBe("[话题：发布流程]");
  });
});

describe("mentionText for any valid file", () => {
  test("the longest path with the longest label still passes the schema", () => {
    const m = file({ path: "p".repeat(1024) });
    const text = mentionText(m, { repoLabel: "长".repeat(40) });
    expect(MessageMention.safeParse({ ...m, text }).success).toBe(true);
  });

  test("a backtick in the label or path cannot close the code span early", () => {
    expect(mentionText(file({ path: "a`b.ts" }), { repoLabel: "web" })).toBe("``web:a`b.ts``");
    expect(mentionText(file({ path: "x``y" }), { repoLabel: "w`eb" })).toBe("```w`eb:x``y```");
    // CommonMark strips one space on each side, so content that starts or ends with a backtick is padded.
    expect(mentionText(file({ path: "b`" }), { repoLabel: "web" })).toBe("`` web:b` ``");
    const worst = file({ path: "`".repeat(1024) });
    expect(MessageMention.safeParse({ ...worst, text: mentionText(worst, { repoLabel: "长".repeat(40) }) }).success).toBe(true);
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

  test("a mention is kept by its stored text even if the label changed since", () => {
    const old = file({ text: "`old-label:apps/web/lib/slash.ts`" });
    expect(keepMentionsFor("看 `old-label:apps/web/lib/slash.ts`", [old])).toEqual([old]);
  });

  test("keeps the original order across different texts", () => {
    const d = entry("D-1");
    const f = file();
    expect(keepMentionsFor("`web:apps/web/lib/slash.ts` 和 [D-1]", [d, f])).toEqual([d, f]);
  });
});
