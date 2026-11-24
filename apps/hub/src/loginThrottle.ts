// #167 remote form, spec D-8: login rate limiting and lockout after repeated failures.
// Counters live in process memory: phase one runs one hub process (spec topology), and a restart
// clearing them is acceptable because each lock is short. One counter per account and one per source
// address; either one being locked refuses the attempt before the password is checked.

/**
 * Limits. Account: 5 failures in 15 minutes lock that account for 15 minutes, which stops online
 * guessing at roughly 480 tries a day while a person who mistypes a few times is not locked out.
 * Source: 20 failures in 15 minutes lock that address for 15 minutes, which stops one client from
 * spraying many accounts while leaving room for several people behind one NAT to mistype.
 * Counters key on the account string as typed, whether or not the account exists, so a lock reveals
 * nothing about which accounts exist.
 */
export const LOGIN_THROTTLE = {
  accountMaxFailures: 5,
  sourceMaxFailures: 20,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
} as const;

export type LoginThrottleLimits = { accountMaxFailures: number; sourceMaxFailures: number; windowMs: number; lockMs: number };
export type LockScope = "account" | "source";
export type Lock = { scope: LockScope; retryAfterMs: number };

type Counter = { failures: number; windowStart: number; lockedUntil: number };

/** Entries are pruned of expired windows and locks once the map grows past this many keys. */
const PRUNE_AT = 10_000;

class Counters {
  private readonly map = new Map<string, Counter>();
  constructor(private readonly limits: LoginThrottleLimits) {}

  lockedFor(key: string, now: number): number {
    const entry = this.map.get(key);
    if (!entry) return 0;
    if (entry.lockedUntil > now) return entry.lockedUntil - now;
    if (entry.lockedUntil > 0) this.map.delete(key); // an expired lock starts the next window fresh
    return 0;
  }

  /** Counts one failure; returns true when this failure locks the key. */
  fail(key: string, max: number, now: number): boolean {
    let entry = this.map.get(key);
    if (!entry || now - entry.windowStart >= this.limits.windowMs || (entry.lockedUntil > 0 && entry.lockedUntil <= now)) {
      entry = { failures: 0, windowStart: now, lockedUntil: 0 };
      this.map.set(key, entry);
    }
    entry.failures += 1;
    if (entry.failures < max || entry.lockedUntil > now) return false;
    entry.lockedUntil = now + this.limits.lockMs;
    this.prune(now);
    return true;
  }

  clear(key: string): void {
    this.map.delete(key);
  }

  private prune(now: number): void {
    if (this.map.size <= PRUNE_AT) return;
    for (const [key, entry] of this.map) {
      if (entry.lockedUntil <= now && now - entry.windowStart >= this.limits.windowMs) this.map.delete(key);
    }
  }
}

export class LoginThrottle {
  private readonly accounts: Counters;
  private readonly sources: Counters;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = Date.now, private readonly limits: LoginThrottleLimits = LOGIN_THROTTLE) {
    this.accounts = new Counters(limits);
    this.sources = new Counters(limits);
  }

  /** The lock that refuses this attempt, or null. The account lock wins when both apply. */
  check(account: string, source: string): Lock | null {
    const now = this.now();
    const accountMs = this.accounts.lockedFor(account, now);
    if (accountMs > 0) return { scope: "account", retryAfterMs: accountMs };
    const sourceMs = this.sources.lockedFor(source, now);
    if (sourceMs > 0) return { scope: "source", retryAfterMs: sourceMs };
    return null;
  }

  /** Records a failed attempt and returns the scopes this failure newly locked. */
  recordFailure(account: string, source: string): LockScope[] {
    const now = this.now();
    const locked: LockScope[] = [];
    if (this.accounts.fail(account, this.limits.accountMaxFailures, now)) locked.push("account");
    if (this.sources.fail(source, this.limits.sourceMaxFailures, now)) locked.push("source");
    return locked;
  }

  /** A successful login clears that account's failures. The source counter is left alone. */
  recordSuccess(account: string): void {
    this.accounts.clear(account);
  }

  /**
   * Runs one login attempt for `account` after any earlier attempt for it has finished. Password checks
   * are async, so without this a burst of concurrent attempts would all pass `check` before any failure
   * was recorded, and the account limit would not hold. Attempts on different accounts still run in
   * parallel, so the source limit can be overshot by the attempts already in flight.
   */
  async serialize<T>(account: string, attempt: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(account) ?? Promise.resolve();
    const run = previous.then(attempt);
    const tail = run.catch(() => undefined);
    this.queues.set(account, tail);
    try {
      return await run;
    } finally {
      if (this.queues.get(account) === tail) this.queues.delete(account);
    }
  }
}
