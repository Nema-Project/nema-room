import type { RouteFailure } from "./errors.js";

/**
 * In-process cooldowns: which accounts just failed and until when (spec 2026-10-31 §4.4). Not persisted —
 * the daemon runs one task at a time and a restart has no state worth keeping, while a stale file would.
 *
 * A cooling account is left out of the candidate set, and the settings text says when it comes back, so a
 * limit shows up as "not right now" rather than as an account that silently stopped working.
 */
export class Cooldowns {
  private readonly marks = new Map<string, number>();
  private readonly clock: () => number;

  constructor(o: { now?: () => number } = {}) {
    this.clock = o.now ?? Date.now;
  }

  /** When this account may be tried again, or null. An expired mark is forgotten while asking. */
  until(accountId: string): number | null {
    const at = this.marks.get(accountId);
    if (at === undefined) return null;
    if (at <= this.clock()) {
      this.marks.delete(accountId);
      return null;
    }
    return at;
  }

  /** Cools an account down for `ms` from now. A later mark is never shortened by an earlier one. */
  mark(accountId: string, ms: number): void {
    const at = this.clock() + Math.max(0, ms);
    const current = this.marks.get(accountId);
    this.marks.set(accountId, current !== undefined && current > at ? current : at);
  }

  clear(accountId: string): void {
    this.marks.delete(accountId);
  }

  clearAll(): void {
    this.marks.clear();
  }

  /** How many live marks are held; used by tests to show expired ones are dropped. */
  get size(): number {
    for (const id of [...this.marks.keys()]) this.until(id);
    return this.marks.size;
  }
}

/**
 * How long a failure keeps an account out of the rotation.
 *
 * These durations are rules of thumb, not numbers from any provider's documentation; the only figure a
 * provider actually states is `Retry-After`, and that always wins. Fifteen minutes for a spent quota is a
 * pause, not a claim about when the plan resets — that time is only ever shown when the provider says it.
 */
export function cooldownFor(failure: RouteFailure, retryAfterMs?: number): number | null {
  switch (failure) {
    case "rate_limit":
      return retryAfterMs ?? 60_000;
    case "quota":
      return retryAfterMs ?? 15 * 60_000;
    case "server":
      return 30_000;
    default:
      return null;
  }
}
