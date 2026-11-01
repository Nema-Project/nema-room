import { describe, expect, test, vi } from "vitest";
import type { Account } from "../../src/accounts/schema.js";
import { AutoRouter, ReasoningGuard, type AutoRouterOptions } from "../../src/routing/auto.js";
import type { Candidate } from "../../src/routing/candidates.js";
import { Cooldowns } from "../../src/routing/cooldown.js";

/**
 * The automatic router (spec 2026-10-31 §4.3, §4.4). It owns one question: given the candidates that could
 * take this task, which one does the next model call go to, and what happens when that one fails.
 *
 * The rule it must never break is "switch between model calls only". Every answer it gives is consumed by an
 * adapter right before a request, so `next()` returning null is the same fact as "this task cannot continue
 * on another account": either the candidates are used up, or output has already started.
 */

const account = (p: Partial<Account> & { id: string }): Account => ({
  name: p.id,
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://api.example.test/v1",
  model: "model-a",
  costTier: "standard",
  order: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
  ...p,
});

const candidate = (id: string, order: number, model = "model-a"): Candidate => ({
  account: account({ id, name: id, order }),
  model,
  capabilities: { image: "yes", pdf: "yes" },
});

const ONE = candidate("acct_aaaaaaaaaa", 0);
const TWO = candidate("acct_bbbbbbbbbb", 1, "model-b");
const THREE = candidate("acct_cccccccccc", 2);

const clock = (start = 1_000_000) => {
  let now = start;
  const cooldowns = new Cooldowns({ now: () => now });
  return { cooldowns, advance: (ms: number) => { now += ms; }, at: () => now };
};

const router = (o: Partial<AutoRouterOptions> = {}) =>
  new AutoRouter({
    candidates: o.candidates ?? [ONE, TWO, THREE],
    cooldowns: o.cooldowns ?? clock().cooldowns,
    startedOutput: o.startedOutput ?? (() => false),
    onSwitch: o.onSwitch ?? (() => {}),
  });

describe("AutoRouter selection", () => {
  test("hands out the candidates in the order the candidate set decided", () => {
    // The order is the user's `order`, then the cost tier, then the id (spec §4.1 step 4). It is computed
    // once, in `computeCandidates`, and this must not re-sort: two orderings in one decision is a decision
    // nobody can explain afterwards.
    const r = router();
    expect(r.next()?.account.id).toBe(ONE.account.id);
    expect(r.next()?.account.id).toBe(TWO.account.id);
    expect(r.next()?.account.id).toBe(THREE.account.id);
  });

  test("each candidate is offered once; the end of the list is null", () => {
    const r = router();
    const seen = [r.next()?.account.id, r.next()?.account.id, r.next()?.account.id, r.next()];
    expect(seen).toEqual([ONE.account.id, TWO.account.id, THREE.account.id, null]);
    // And it stays null: a caller that asks again does not get a repeat of an account that already failed.
    expect(r.next()).toBeNull();
  });

  test("carries the model the candidate set resolved for that account", () => {
    const r = router();
    r.next();
    expect(r.next()?.model).toBe("model-b");
  });

  test("no candidates at all is null immediately, not an exception", () => {
    // "Nothing can take this task" is an answer the caller turns into a refusal with an explicit sentence;
    // throwing here would make every caller wrap this in a try.
    expect(router({ candidates: [] }).next()).toBeNull();
  });
});

describe("AutoRouter failure handling", () => {
  test("a failure cools the account down and the next call moves past it", () => {
    const { cooldowns, advance } = clock();
    const r = router({ cooldowns });
    expect(r.next()?.account.id).toBe(ONE.account.id);
    r.recordFailure("rate_limit");
    // The account that just failed is out of the rotation, not merely "not the first one".
    expect(cooldowns.until(ONE.account.id)).not.toBeNull();
    expect(r.next()?.account.id).toBe(TWO.account.id);
  });

  test("the cooldown is the one the failure kind implies, and Retry-After wins when given", () => {
    const { cooldowns, at } = clock();
    const r = router({ cooldowns });
    r.next();
    r.recordFailure("rate_limit", 5_000);
    expect(cooldowns.until(ONE.account.id)).toBe(at() + 5_000);

    const second = clock();
    const s = router({ cooldowns: second.cooldowns });
    s.next();
    s.recordFailure("quota");
    // Fifteen minutes is the documented rule of thumb for a spent quota (cooldown.ts), not a reset time.
    expect(second.cooldowns.until(ONE.account.id)).toBe(second.at() + 15 * 60_000);
  });

  test("a failure that implies no cooldown still ends that account's turn", () => {
    // `context` is worth switching for but has no cooldown of its own: the account is fine, this task just
    // does not fit it. It must not be offered again for this task, and it must not be benched either.
    const { cooldowns } = clock();
    const r = router({ cooldowns });
    r.next();
    r.recordFailure("context");
    expect(cooldowns.until(ONE.account.id)).toBeNull();
    expect(r.next()?.account.id).toBe(TWO.account.id);
  });

  test("an account already cooling down is still offered by this run, and skipped by the next", () => {
    // The candidate set was computed before this task started. An account that was cooling then cannot be in
    // it, so any account here is fair game for this task; the cooldown this run records is what the *next*
    // task's candidate set reads.
    const { cooldowns } = clock();
    cooldowns.mark(TWO.account.id, 60_000);
    const r = router({ cooldowns });
    expect(r.next()?.account.id).toBe(ONE.account.id);
    expect(r.next()?.account.id).toBe(TWO.account.id);
  });

  test("the switch callback reports both sides and the reason", () => {
    const onSwitch = vi.fn();
    const r = router({ onSwitch });
    r.next();
    r.recordFailure("rate_limit");
    expect(onSwitch).toHaveBeenCalledTimes(1);
    const [from, to, failure] = onSwitch.mock.calls[0]!;
    // Both sides name a real account and its model, so the adapter can put the two names in one sentence.
    expect(from.account.id).toBe(ONE.account.id);
    expect(from.model).toBe("model-a");
    expect(from.failure).toBe("rate_limit");
    expect(to.account.id).toBe(TWO.account.id);
    expect(to.model).toBe("model-b");
    expect(failure).toBe("rate_limit");
    // The switch is announced when it is decided, before the caller asks for the next candidate: the progress
    // line has to appear even if the run then fails before making another request.
    expect(r.next()?.account.id).toBe(TWO.account.id);
  });

  test("no switch callback when the failed account had nowhere to go", () => {
    const onSwitch = vi.fn();
    const r = router({ candidates: [ONE], onSwitch });
    r.next();
    r.recordFailure("rate_limit");
    expect(r.next()).toBeNull();
    // Nothing moved, so nothing is reported as a move. The failure itself is the caller's to report.
    expect(onSwitch).not.toHaveBeenCalled();
  });

  test("recording a failure with no current account is a no-op, not a crash", () => {
    // A failure can arrive before the first `next()` if a caller misorders its calls; refusing to crash on it
    // keeps a bug in the caller from replacing the real error the user needs to see.
    const { cooldowns } = clock();
    const r = router({ cooldowns });
    expect(() => r.recordFailure("rate_limit")).not.toThrow();
    expect(cooldowns.size).toBe(0);
    expect(r.next()?.account.id).toBe(ONE.account.id);
  });
});

describe("AutoRouter and output that has already started", () => {
  test("once output has started nothing more is offered", () => {
    // The highest rule in the design (spec §4.3): half an answer from one account must never be continued by
    // another. This is checked here as well as in `classifyFailure` because here it is the thing that decides
    // whether a request happens at all.
    let started = false;
    const r = router({ startedOutput: () => started });
    expect(r.next()?.account.id).toBe(ONE.account.id);
    started = true;
    expect(r.next()).toBeNull();
    expect(r.next()).toBeNull();
  });

  test("a failure recorded after output started does not re-open the rotation", () => {
    let started = false;
    const { cooldowns } = clock();
    const r = router({ cooldowns, startedOutput: () => started });
    r.next();
    started = true;
    r.recordFailure("streaming_started");
    expect(r.next()).toBeNull();
    // It also must not bench the account for every later task: nothing was wrong with it.
    expect(cooldowns.until(ONE.account.id)).toBeNull();
  });
});

describe("AutoRouter attempts", () => {
  test("lists what was tried, in order, with the failure kind", () => {
    const r = router();
    r.next();
    r.recordFailure("rate_limit");
    r.next();
    r.recordFailure("server");
    const attempts = r.attempts();
    expect(attempts.map((a) => a.failure)).toEqual(["rate_limit", "server"]);
    expect(attempts[0]!.accountId).toBe(ONE.account.id);
    expect(attempts[0]!.model).toBe("model-a");
    // The account that is still trying is not an attempt: it has not failed.
    expect(attempts).toHaveLength(2);
  });

  test("the current account is readable, so the reply can name who is answering", () => {
    const r = router();
    expect(r.current()).toBeNull();
    expect(r.next()?.account.id).toBe(ONE.account.id);
    expect(r.current()?.account.id).toBe(ONE.account.id);
    r.recordFailure("quota");
    // After a failure the failed account is still `current()` until the next pick: that is who failed.
    expect(r.current()?.account.id).toBe(ONE.account.id);
    expect(r.next()?.account.id).toBe(TWO.account.id);
    expect(r.current()?.account.id).toBe(TWO.account.id);
  });

  test("an attempt names the model that was actually sent, if one was resolved", () => {
    // A candidate whose model is picked at run time carries the placeholder until the adapter says what it
    // sent. The attempt must record the real name, because "which model failed" is what the user asks next.
    const r = router();
    r.next();
    r.recordFailure("rate_limit", undefined, "gpt-actual");
    expect(r.attempts()[0]!.model).toBe("gpt-actual");
  });
});

describe("ReasoningGuard", () => {
  /** The shape the tool loop keeps for a reasoning item; only `type` matters to the guard. */
  const reasoning = (id: string) => ({ type: "reasoning", encrypted_content: id });
  const user = { type: "message", role: "user" };
  const call = { type: "function_call", call_id: "c1" };

  test("keeps everything while the task stays on one account", () => {
    const guard = new ReasoningGuard();
    const history = [user, reasoning("r1")];
    expect(guard.filter(history)).toEqual(history);
    // Pinned on first sighting, so the next call keeps it too.
    expect(guard.filter(history)).toEqual(history);
  });

  test("drops the reasoning produced before the switch, and only that", () => {
    const guard = new ReasoningGuard();
    const first = reasoning("r1");
    guard.filter([user, first]);
    guard.switched();
    const second = reasoning("r2");
    // r1 belongs to the account that just failed; r2 arrives afterwards and belongs to the new one.
    expect(guard.filter([user, first, second])).toEqual([user, second]);
    // And the drop is permanent: the loop's own history still holds r1 on every later call.
    expect(guard.filter([user, first, second])).toEqual([user, second]);
  });

  test("keeps the conversation: messages, function calls and their outputs all survive", () => {
    const guard = new ReasoningGuard();
    guard.switched();
    const history = [user, call, { type: "function_call_output", call_id: "c1" }, { type: "message", role: "assistant" }];
    expect(guard.filter(history)).toEqual(history);
  });

  test("a second switch drops the reasoning from the first one's account as well", () => {
    const guard = new ReasoningGuard();
    const a = reasoning("a");
    guard.filter([a]);
    guard.switched();
    const b = reasoning("b");
    guard.filter([a, b]);
    guard.switched();
    expect(guard.filter([a, b, reasoning("c")]).map((i) => (i as { encrypted_content?: string }).encrypted_content))
      .toEqual(["c"]);
  });
});
