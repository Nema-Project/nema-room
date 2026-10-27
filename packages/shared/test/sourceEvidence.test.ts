import { describe, expect, it } from "vitest";
import { canonicalJson, compareFreshness } from "../src/sourceEvidence.js";

describe("source evidence", () => {
  it("canonicalizes object keys without reordering arrays", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const value of [NaN, Infinity, 1n, Symbol("s"), () => 1, new Date(), new Map(), [undefined], Array(1), { missing: undefined }, cycle]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
    expect(canonicalJson({ z: null, a: [true, 2, "text"] })).toBe('{"a":[true,2,"text"],"z":null}');
    expect(canonicalJson({ "10": 10, "2": 2 })).toBe('{"10":10,"2":2}');
    const excerpt = [{ locator: "a", text: "first" }, { locator: "b", text: "second" }];
    expect(canonicalJson(excerpt)).not.toBe(canonicalJson([...excerpt].reverse()));
  });

  it("does not call missing revisions current", () => {
    expect(compareFreshness(null, { outcome: "ok", revision: null })).toEqual({ freshness: "unknown", reason: "incomparable" });
    expect(compareFreshness("r1", { outcome: "ok", revision: null })).toEqual({ freshness: "unknown", reason: "incomparable" });
  });

  it("maps provider outcomes", () => {
    expect(compareFreshness(null, { outcome: "ok", revision: "r1" })).toEqual({ freshness: "unknown", reason: "incomparable" });
    expect(compareFreshness("r1", { outcome: "incomparable" })).toEqual({ freshness: "unknown", reason: "incomparable" });
    expect(compareFreshness("r1", { outcome: "ok", revision: "r1" })).toEqual({ freshness: "current", reason: "match" });
    expect(compareFreshness("r1", { outcome: "ok", revision: "r2" })).toEqual({ freshness: "changed", reason: "mismatch" });
    for (const outcome of ["not_found", "forbidden"] as const) expect(compareFreshness("r1", { outcome })).toEqual({ freshness: "unavailable", reason: outcome });
    for (const outcome of ["offline", "timeout"] as const) expect(compareFreshness("r1", { outcome })).toEqual({ freshness: "unknown", reason: outcome });
  });
});
