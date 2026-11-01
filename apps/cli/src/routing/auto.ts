import type { RouteAttempt } from "@nema/shared";
import type { Account } from "../accounts/schema.js";
import type { Candidate } from "./candidates.js";
import { cooldownFor, type Cooldowns } from "./cooldown.js";
import type { RouteFailure } from "./errors.js";

/**
 * Automatic routing: which candidate the next model call runs on, and what happens when it fails
 * (spec 2026-10-31 §4.3, §4.4, D-3, D-4).
 *
 * The scope is deliberately narrow. It does not compute candidates — `computeCandidates` already did, with
 * the user's ordering, the declared capabilities and the cooldowns as they were when the task started. It
 * does not decide whether a failure is worth switching for — `shouldSwitch` does. It answers one question,
 * "who runs the next request", and remembers what was tried so the reply can say so.
 *
 * Two rules it exists to keep:
 *
 *   - a switch happens **between** model calls, never inside one. `next()` is called right before a request;
 *     returning null is how this class says "this task cannot continue on another account".
 *   - every account is offered once per task. A failure ends that account's turn even when the failure kind
 *     carries no cooldown, because a second try on the same account is the same request with the same limits.
 */

export type Attempt = {
  account: Account;
  model: string;
  /** Set once this account has failed; a live attempt has none. */
  failure?: RouteFailure;
};

export type AutoRouterOptions = {
  /** In the order the candidate set decided: the user's `order`, then cost tier, then id. */
  candidates: readonly Candidate[];
  cooldowns: Cooldowns;
  /**
   * Whether the user has already seen part of this answer. Read at each `next()` rather than captured, because
   * the answer is whether streaming has started *now*.
   */
  startedOutput: () => boolean;
  /** Called when a failure moves the task to another account. Not called when there is nowhere to move. */
  onSwitch: (from: Attempt, to: Attempt, failure: RouteFailure) => void;
};

export class AutoRouter {
  private readonly candidates: readonly Candidate[];
  private readonly cooldowns: Cooldowns;
  private readonly startedOutput: () => boolean;
  private readonly onSwitch: AutoRouterOptions["onSwitch"];
  /** Index of the candidate this router is on, or -1 before the first pick. */
  private index = -1;
  /** Every account that failed, in the order it failed. */
  private readonly tried: Attempt[] = [];

  constructor(o: AutoRouterOptions) {
    this.candidates = o.candidates;
    this.cooldowns = o.cooldowns;
    this.startedOutput = o.startedOutput;
    this.onSwitch = o.onSwitch;
  }

  /**
   * The candidate for the next model call, or null when there is none.
   *
   * Null means one of two things, and both are refusals to move: the candidates are used up, or the user has
   * already seen output from this answer and continuing it on another account would produce a different
   * model's sentence (spec §4.3, and OpenRouter's rule the design follows).
   */
  next(): Candidate | null {
    if (this.startedOutput()) return null;
    if (this.index + 1 >= this.candidates.length) return null;
    this.index++;
    return this.candidates[this.index]!;
  }

  /**
   * The candidate the next `next()` would return, without consuming it.
   *
   * `recordFailure` needs to know whether there is somewhere to go *before* the caller asks for it, so it can
   * decide whether to announce a switch. Asking with `next()` there would consume the candidate and the
   * adapter's own call would then land one further along, skipping an account.
   */
  peek(): Candidate | null {
    if (this.startedOutput()) return null;
    return this.candidates[this.index + 1] ?? null;
  }

  /**
   * Records that the current account failed, cools it down for as long as its failure kind implies, and moves
   * the pointer on. `retryAfterMs` is the provider's own `Retry-After` when it sent one, which always wins.
   *
   * `model` is what the request actually carried. A candidate whose model is resolved at run time (the first
   * of an endpoint's catalog) does not know its name when the candidate is built, so the adapter passes the
   * real one here; "which model failed" is the next question after "which account failed".
   */
  recordFailure(failure: RouteFailure, retryAfterMs?: number, model?: string): void {
    const current = this.current();
    if (current === null) return;
    const ms = cooldownFor(failure, retryAfterMs);
    // A failure kind with no cooldown (a context overflow, an unknown error) still ends this account's turn
    // for this task; it just does not bench the account for the next one.
    if (ms !== null) this.cooldowns.mark(current.account.id, ms);
    const attempt: Attempt = { account: current.account, model: model ?? current.model, failure };
    this.tried.push(attempt);
    // A switch is reported only when there is somewhere to go *and* moving is still allowed: announcing a move
    // that the next `next()` will refuse would contradict the progress line the user just read.
    const to = this.peek();
    if (to !== null) this.onSwitch(attempt, { account: to.account, model: to.model }, failure);
  }

  /**
   * The account the task is on right now: who is answering, or — after `recordFailure` and before the next
   * `next()` — who just failed. Null before the first pick.
   */
  current(): Candidate | null {
    return this.index >= 0 ? (this.candidates[this.index] ?? null) : null;
  }

  /** What was tried and why it did not answer, in order, for `meta.route.attempts`. */
  attempts(): RouteAttempt[] {
    return this.tried.map((a) => ({
      accountId: a.account.id,
      accountName: a.account.name,
      model: a.model,
      // A code, not a sentence: the UI localises it, and a sentence here would freeze one language into
      // every stored conversation.
      failure: a.failure ?? "unknown",
    }));
  }

  /** Whether the task has already moved at least once, for choosing between the two automatic reason codes. */
  hasSwitched(): boolean {
    return this.tried.length > 0;
  }
}

/**
 * Keeps reasoning items that were produced under an account the task has since left out of the request.
 *
 * The direct transport asks for `include: ["reasoning.encrypted_content"]` and replays it on the next call
 * (`store: false` has nothing to look up). That ciphertext is bound to the key that produced it: the second
 * account of a failover cannot decrypt the first one's, and LiteLLM documents this exact limit for its own
 * cross-key fallbacks (research §1.3). So after a switch the items produced before it are dropped, while the
 * conversation itself — user message, assistant text, function calls and their outputs — is kept.
 *
 * Items are tagged with the generation they were first seen in rather than with a timestamp or an id: the
 * reasoning items arriving after a switch belong to the new account and must keep being replayed, and a
 * generation counter is the smallest thing that tells the two groups apart without looking inside the payload.
 */
export class ReasoningGuard {
  private readonly born = new WeakMap<object, number>();
  private generation = 0;

  /** Called when the task moves to another account. Everything seen before this point is stale. */
  switched(): void {
    this.generation++;
  }

  /** The history to send: the same items, minus the reasoning produced before the last switch. */
  filter<T extends { type: string }>(history: readonly T[]): T[] {
    const out: T[] = [];
    for (const item of history) {
      if (item.type !== "reasoning") {
        out.push(item);
        continue;
      }
      const generation = this.born.get(item);
      if (generation === undefined) {
        // First sighting (usually the call right after the response that produced it). It belongs to the
        // account that is running now, so it is kept and pinned to this generation.
        this.born.set(item, this.generation);
        out.push(item);
        continue;
      }
      if (generation === this.generation) out.push(item);
    }
    return out;
  }
}
