import { describe, expect, test } from "vitest";
import { Cooldowns, cooldownFor } from "../../src/routing/cooldown.js";

describe("Cooldowns", () => {
  test("marks an account until a moment, then reports nothing once that moment passes", () => {
    let now = 1_000;
    const c = new Cooldowns({ now: () => now });
    expect(c.until("acct_aaaaaaaaaa")).toBeNull();
    c.mark("acct_aaaaaaaaaa", 5_000);
    expect(c.until("acct_aaaaaaaaaa")).toBe(6_000);
    now = 5_999;
    expect(c.until("acct_aaaaaaaaaa")).toBe(6_000);
    now = 6_000;
    expect(c.until("acct_aaaaaaaaaa")).toBeNull();
  });

  test("keeps one account apart from another", () => {
    const c = new Cooldowns({ now: () => 0 });
    c.mark("acct_aaaaaaaaaa", 1_000);
    expect(c.until("acct_bbbbbbbbbb")).toBeNull();
  });

  test("a shorter mark does not cut a longer one short", () => {
    const c = new Cooldowns({ now: () => 0 });
    c.mark("acct_aaaaaaaaaa", 10_000);
    c.mark("acct_aaaaaaaaaa", 100);
    expect(c.until("acct_aaaaaaaaaa")).toBe(10_000);
  });

  test("clear and clearAll drop marks", () => {
    const c = new Cooldowns({ now: () => 0 });
    c.mark("acct_aaaaaaaaaa", 10_000);
    c.mark("acct_bbbbbbbbbb", 10_000);
    c.clear("acct_aaaaaaaaaa");
    expect(c.until("acct_aaaaaaaaaa")).toBeNull();
    expect(c.until("acct_bbbbbbbbbb")).toBe(10_000);
    c.clearAll();
    expect(c.until("acct_bbbbbbbbbb")).toBeNull();
  });

  test("forgets an expired mark rather than growing forever", () => {
    let now = 0;
    const c = new Cooldowns({ now: () => now });
    c.mark("acct_aaaaaaaaaa", 1);
    now = 10;
    expect(c.until("acct_aaaaaaaaaa")).toBeNull();
    expect(c.size).toBe(0);
  });
});

describe("cooldownFor", () => {
  test("uses the provider's Retry-After when it gave one", () => {
    expect(cooldownFor("rate_limit", 12_000)).toBe(12_000);
    expect(cooldownFor("quota", 90_000)).toBe(90_000);
  });

  test("falls back to a short window for a rate limit and a longer one for spent quota", () => {
    expect(cooldownFor("rate_limit")).toBe(60_000);
    expect(cooldownFor("quota")).toBe(15 * 60_000);
    expect(cooldownFor("server")).toBe(30_000);
  });

  test("does not cool an account down for a failure another account would not fix", () => {
    for (const failure of ["auth", "policy", "bad_request", "streaming_started", "unknown"] as const) {
      expect(cooldownFor(failure), failure).toBeNull();
    }
  });
});
