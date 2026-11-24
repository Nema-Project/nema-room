import { expect, test } from "vitest";
import { LOGIN_THROTTLE, LoginThrottle } from "../src/loginThrottle.js";

const MIN = 60 * 1000;

function clocked() {
  let t = 1_000_000;
  const throttle = new LoginThrottle(() => t);
  return { throttle, advance: (ms: number) => { t += ms; } };
}

function fail(throttle: LoginThrottle, n: number, account = "usr_a", source = "10.0.0.1") {
  const locked: string[] = [];
  for (let i = 0; i < n; i++) locked.push(...throttle.recordFailure(account, source));
  return locked;
}

test("the limits are 5 account failures or 20 source failures in 15 minutes, locking for 15 minutes", () => {
  expect(LOGIN_THROTTLE).toEqual({ accountMaxFailures: 5, sourceMaxFailures: 20, windowMs: 15 * MIN, lockMs: 15 * MIN });
});

test("below the threshold attempts continue; the fifth failure locks the account", () => {
  const { throttle } = clocked();
  expect(fail(throttle, 4)).toEqual([]);
  expect(throttle.check("usr_a", "10.0.0.1")).toBeNull();
  expect(fail(throttle, 1)).toEqual(["account"]);
  expect(throttle.check("usr_a", "10.0.0.1")).toEqual({ scope: "account", retryAfterMs: 15 * MIN });
  // The lock follows the account, not the address.
  expect(throttle.check("usr_a", "10.0.0.2")).toEqual({ scope: "account", retryAfterMs: 15 * MIN });
});

test("a lock expires after 15 minutes and the account starts a fresh window", () => {
  const { throttle, advance } = clocked();
  fail(throttle, 5);
  advance(15 * MIN - 1);
  expect(throttle.check("usr_a", "10.0.0.1")).toEqual({ scope: "account", retryAfterMs: 1 });
  advance(1);
  expect(throttle.check("usr_a", "10.0.0.1")).toBeNull();
  expect(fail(throttle, 4)).toEqual([]);
  expect(throttle.check("usr_a", "10.0.0.1")).toBeNull();
});

test("failures older than the window no longer count", () => {
  const { throttle, advance } = clocked();
  fail(throttle, 4);
  advance(15 * MIN);
  expect(fail(throttle, 4)).toEqual([]);
  expect(throttle.check("usr_a", "10.0.0.1")).toBeNull();
  expect(fail(throttle, 1)).toEqual(["account"]);
});

test("a successful login clears the account's failures", () => {
  const { throttle } = clocked();
  fail(throttle, 4);
  throttle.recordSuccess("usr_a");
  expect(fail(throttle, 4)).toEqual([]);
  expect(throttle.check("usr_a", "10.0.0.1")).toBeNull();
});

test("one account's failures do not affect another account", () => {
  const { throttle } = clocked();
  fail(throttle, 5, "usr_a");
  expect(throttle.check("usr_a", "10.0.0.1")?.scope).toBe("account");
  expect(throttle.check("usr_b", "10.0.0.2")).toBeNull();
  expect(fail(throttle, 4, "usr_b", "10.0.0.2")).toEqual([]);
});

test("one source spraying many accounts is locked on its twentieth failure; other sources are not", () => {
  const { throttle } = clocked();
  for (let i = 0; i < 19; i++) expect(throttle.recordFailure(`usr_${i}`, "10.0.0.9")).toEqual([]);
  expect(throttle.recordFailure("usr_19", "10.0.0.9")).toEqual(["source"]);
  expect(throttle.check("usr_fresh", "10.0.0.9")).toEqual({ scope: "source", retryAfterMs: 15 * MIN });
  expect(throttle.check("usr_fresh", "10.0.0.10")).toBeNull();
  // Success clears the account counter only; the source stays locked.
  throttle.recordSuccess("usr_fresh");
  expect(throttle.check("usr_fresh", "10.0.0.9")?.scope).toBe("source");
});

test("serialize runs one account's attempts one at a time, other accounts in parallel, and survives a throwing attempt", async () => {
  const { throttle } = clocked();
  const order: string[] = [];
  const slow = (label: string, ms: number) => async () => {
    order.push(`start ${label}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end ${label}`);
    return label;
  };
  const results = await Promise.all([
    throttle.serialize("usr_a", slow("a1", 30)),
    throttle.serialize("usr_a", slow("a2", 1)),
    throttle.serialize("usr_b", slow("b1", 1)),
  ]);
  expect(results).toEqual(["a1", "a2", "b1"]);
  // b1 started while a1 was still running; a2 waited for a1.
  expect(order.indexOf("start b1")).toBeLessThan(order.indexOf("end a1"));
  expect(order.indexOf("start a2")).toBeGreaterThan(order.indexOf("end a1"));

  await expect(throttle.serialize("usr_a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(await throttle.serialize("usr_a", async () => "after")).toBe("after");
});

test("unknown accounts are counted and locked exactly like real ones", () => {
  const { throttle } = clocked();
  expect(fail(throttle, 5, "nobody-by-this-name")).toEqual(["account"]);
  expect(throttle.check("nobody-by-this-name", "10.0.0.1")).toEqual({ scope: "account", retryAfterMs: 15 * MIN });
});
