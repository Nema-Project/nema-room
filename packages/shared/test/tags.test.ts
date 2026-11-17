import { expect, test } from "vitest";
import { normalizeTag, normalizeTagList, TagSchema, tagError, TAG_LIMITS } from "../src/tags.js";
import { UpsertEntryInput } from "../src/entry.js";

test("normalizes Unicode, whitespace and case", () => {
  for (const [raw, folded] of [[" ＡＰＩ ", "api"], ["Payment Flow", "payment-flow"], ["支付", "支付"], ["नमस्ते", "नमस्ते"]]) {
    expect(normalizeTag(raw)).toBe(folded);
    expect(TagSchema.parse(raw)).toBe(folded);
  }
  expect(normalizeTag("𐐨".repeat(32))).toBe("𐐨".repeat(32));
});
test("rejects invalid tags with a reason naming the input", () => {
  for (const raw of ["d-12", "a[b]", "#x", "a,b", "a/b", "@x", "-x", "", "𐐨".repeat(33)]) {
    expect(normalizeTag(raw)).toBeNull();
    expect(tagError(raw)).toBeTruthy();
    expect(TagSchema.safeParse(raw).success).toBe(false);
  }
  expect(TAG_LIMITS).toEqual({ tagChars: 32, perEntry: 8, perWorkspace: 200 });
});
test("lenient lists drop invalid values and deduplicate in order", () => {
  expect(normalizeTagList(["API", "api", "#x", 1, "支付"])).toEqual({ tags: ["api", "支付"], dropped: ["#x", 1] });
  expect(normalizeTagList("hello")).toEqual({ tags: [], dropped: ["hello"] });
  expect(normalizeTagList(undefined)).toEqual({ tags: [], dropped: [] });
});
test("write limit applies after normalization and deduplication", () => {
  const input = { kind: "decision", title: "t", body: "b", reason: "r" };
  expect(UpsertEntryInput.parse({ ...input, tags: Array(9).fill("API") }).tags).toEqual(["api"]);
  expect(UpsertEntryInput.safeParse({ ...input, tags: Array.from({ length: 9 }, (_, i) => `tag${i}`) }).success).toBe(false);
});

test("the write schema remains representable by existing tool schema consumers", async () => {
  const { z } = await import("zod");
  expect(() => z.toJSONSchema(UpsertEntryInput)).not.toThrow();
});
