import { describe, expect, it } from "vitest";
import { applyFormat } from "@/lib/markdownFormat";

describe("applyFormat", () => {
  it("wraps a selection in bold", () => {
    expect(applyFormat("hello", 0, 5, "bold")).toEqual({ text: "**hello**", selStart: 2, selEnd: 7 });
  });
  it("inserts a marker pair with the caret between when nothing is selected", () => {
    expect(applyFormat("ab", 1, 1, "italic")).toEqual({ text: "a**b", selStart: 2, selEnd: 2 });
  });
  it("wraps in code", () => {
    expect(applyFormat("x", 0, 1, "code")).toEqual({ text: "`x`", selStart: 1, selEnd: 2 });
  });
  it("prefixes every line touched by the selection for lists", () => {
    const r = applyFormat("one\ntwo\nthree", 2, 6, "list");
    expect(r.text).toBe("- one\n- two\nthree");
  });
  it("makes a link and selects the url placeholder", () => {
    const r = applyFormat("hello", 0, 5, "link");
    expect(r.text).toBe("[hello](https://)");
    expect(r.text.slice(r.selStart, r.selEnd)).toBe("https://");
  });
});
