import { expect, test } from "vitest";
import { LOGIN_THROTTLE, LoginThrottle, SWEEP_BATCH, SWEEP_INTERVAL_MS } from "../src/loginThrottle.js";

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

test("the window rolls: failures at 0, 12, 13, 14, 16 and 17 minutes lock the account at 17", () => {
  // A fixed window starting at 0 would reset at 15 and count only 16 and 17.
  const { throttle, advance } = clocked();
  let at = 0;
  const failAt = (minute: number) => {
    advance((minute - at) * MIN);
    at = minute;
    return throttle.recordFailure("usr_a", "10.0.0.1");
  };
  for (const minute of [0, 12, 13, 14, 16]) expect(failAt(minute), `minute ${minute}`).toEqual([]);
  expect(failAt(17)).toEqual(["account"]);
  expect(throttle.check("usr_a", "10.0.0.1")).toEqual({ scope: "account", retryAfterMs: 15 * MIN });
});

test("the source window rolls the same way", () => {
  const { throttle, advance } = clocked();
  for (let i = 0; i < 10; i++) throttle.recordFailure(`usr_early${i}`, "10.0.0.9");
  advance(10 * MIN);
  for (let i = 0; i < 9; i++) expect(throttle.recordFailure(`usr_late${i}`, "10.0.0.9")).toEqual([]);
  advance(4 * MIN); // the first ten are 14 minutes old: still inside the window
  expect(throttle.recordFailure("usr_last", "10.0.0.9")).toEqual(["source"]);
});

test("after a lock expires the count starts from zero, even with failures that would still be in the window", () => {
  // lockMs is independent of windowMs; with a 5-minute lock the failure that locked is still in the window.
  let t = 1_000_000;
  const throttle = new LoginThrottle(() => t, { ...LOGIN_THROTTLE, lockMs: 5 * MIN });
  fail(throttle, 4);
  t += 14 * MIN;
  expect(fail(throttle, 1)).toEqual(["account"]); // 4 at minute 0, 1 at minute 14
  expect(throttle.check("usr_a", "10.0.0.1")).toEqual({ scope: "account", retryAfterMs: 5 * MIN });
  t += 5 * MIN;
  expect(throttle.check("usr_a", "10.0.0.1")).toBeNull();
  expect(fail(throttle, 4)).toEqual([]);
  expect(fail(throttle, 1)).toEqual(["account"]);
});

test("expired entries are swept on a timer, in bounded batches, without any lock being triggered", () => {
  const { throttle, advance } = clocked();
  const names = SWEEP_BATCH * 2 + 100;
  for (let i = 0; i < names; i++) throttle.recordFailure(`guess-${i}`, `10.1.${i >> 8}.${i & 255}`);
  const tracked = throttle.trackedKeys;
  expect(tracked).toBe(names * 2);

  // Inside the window and before the sweep interval nothing is dropped.
  advance(SWEEP_INTERVAL_MS - 1);
  throttle.check("someone", "10.2.0.1");
  expect(throttle.trackedKeys).toBe(tracked);

  // Once the failures are out of the window, each sweep (at most once a minute) drops at most one batch per map.
  advance(15 * MIN);
  throttle.check("someone", "10.2.0.1");
  expect(throttle.trackedKeys).toBe(tracked - 2 * SWEEP_BATCH);
  throttle.check("someone", "10.2.0.1"); // same minute: no second sweep
  expect(throttle.trackedKeys).toBe(tracked - 2 * SWEEP_BATCH);
  for (let i = 0; i < 3; i++) {
    advance(SWEEP_INTERVAL_MS);
    throttle.check("someone", "10.2.0.1");
  }
  expect(throttle.trackedKeys).toBe(0);
});

test("with both locks in force the scope is the account's and Retry-After is the longer lock", () => {
  const { throttle, advance } = clocked();
  fail(throttle, 5, "usr_a", "10.0.0.9"); // account locked until minute 15
  advance(10 * MIN);
  for (let i = 0; i < 15; i++) throttle.recordFailure(`usr_spray${i}`, "10.0.0.9"); // source: 20 failures, locked until minute 25
  expect(throttle.check("usr_a", "10.0.0.9")).toEqual({ scope: "account", retryAfterMs: 15 * MIN });
  expect(throttle.check("usr_a", "10.0.0.1")).toEqual({ scope: "account", retryAfterMs: 5 * MIN });
  expect(throttle.check("usr_b", "10.0.0.9")).toEqual({ scope: "source", retryAfterMs: 15 * MIN });
  // And the other way round: a longer account lock wins over a shorter source lock.
  advance(10 * MIN); // usr_a's lock expired; the source has 5 minutes left
  fail(throttle, 5, "usr_c", "10.0.0.8");
  expect(throttle.check("usr_c", "10.0.0.9")).toEqual({ scope: "account", retryAfterMs: 15 * MIN });
});

test("begin reserves the source's last failure: with 19 recorded, a second concurrent attempt is refused", () => {
  const { throttle } = clocked();
  for (let i = 0; i < 19; i++) throttle.recordFailure(`usr_${i}`, "10.0.0.9");
  const first = throttle.begin("usr_x", "10.0.0.9");
  if (!("attempt" in first)) throw new Error("expected admission");
  expect(throttle.begin("usr_y", "10.0.0.9")).toMatchObject({ lock: { scope: "source" } });
  expect(throttle.begin("usr_y", "10.0.0.2")).toHaveProperty("attempt"); // other sources are unaffected

  // The reservation turns into the twentieth failure and locks the source.
  expect(first.attempt.fail()).toEqual(["source"]);
  expect(first.attempt.fail()).toEqual([]); // settles once
  first.attempt.release();
  expect(throttle.begin("usr_z", "10.0.0.9")).toEqual({ lock: { scope: "source", retryAfterMs: 15 * MIN } });
});

test("a successful or aborted attempt releases its reservation without counting a failure", () => {
  const { throttle } = clocked();
  for (let i = 0; i < 19; i++) throttle.recordFailure(`usr_${i}`, "10.0.0.9");
  fail(throttle, 4, "usr_ok", "10.0.0.1");

  const ok = throttle.begin("usr_ok", "10.0.0.9");
  if (!("attempt" in ok)) throw new Error("expected admission");
  ok.attempt.succeed();
  ok.attempt.release();
  // The account's failures are cleared; the source keeps its 19 and admits exactly one attempt again.
  expect(fail(throttle, 4, "usr_ok", "10.0.0.1")).toEqual([]);

  const aborted = throttle.begin("usr_q", "10.0.0.9");
  if (!("attempt" in aborted)) throw new Error("expected admission");
  aborted.attempt.release();
  aborted.attempt.release();
  expect(throttle.begin("usr_r", "10.0.0.9")).toHaveProperty("attempt");
  expect(throttle.begin("usr_s", "10.0.0.9")).toHaveProperty("lock");
});
