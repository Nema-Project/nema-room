// #167 remote form, spec D-8: login rate limiting and lockout after repeated failures.
// Counters live in process memory: phase one runs one hub process (spec topology), and a restart
// clearing them is acceptable because each lock is short. One counter per account and one per source
// address; either one being locked refuses the attempt before the password is checked.

/**
 * Limits. Account: 5 failures within any 15 minutes lock that account for 15 minutes, which stops online
 * guessing at roughly 480 tries a day while a person who mistypes a few times is not locked out.
 * Source: 20 failures within any 15 minutes lock that address for 15 minutes, which stops one client from
 * spraying many accounts while leaving room for several people behind one NAT to mistype.
 * The window is rolling: each failure counts for `windowMs` after it happened, so failures cannot be
 * spread across a fixed window boundary to double the rate. Counters key on the account string as typed,
 * whether or not the account exists, so a lock reveals nothing about which accounts exist.
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

/** Expired entries are swept at most this often, from whichever operation runs first after the interval. */
export const SWEEP_INTERVAL_MS = 60 * 1000;
/** At most this many entries are inspected per sweep; a larger map is finished by later sweeps. */
export const SWEEP_BATCH = 5_000;
/** Retry-After for a source whose remaining budget is held by attempts still in flight. */
export const IN_FLIGHT_RETRY_MS = 1000;

/** Failure times inside the window (oldest first, at most `max` kept), the lock, and in-flight reservations. */
type Entry = { failures: number[]; lockedUntil: number; reserved: number };

class Counters {
  private readonly map = new Map<string, Entry>();
  private cursor: Iterator<[string, Entry]> | undefined;

  constructor(private readonly windowMs: number, private readonly lockMs: number, private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  /** The entry with failures outside the window dropped. An expired lock starts the count from zero. */
  private live(key: string, now: number): Entry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.lockedUntil > 0 && entry.lockedUntil <= now) {
      entry.lockedUntil = 0;
      entry.failures = [];
    }
    while (entry.failures.length > 0 && now - entry.failures[0]! >= this.windowMs) entry.failures.shift();
    if (this.idle(entry)) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  private idle(entry: Entry): boolean {
    return entry.failures.length === 0 && entry.lockedUntil === 0 && entry.reserved === 0;
  }

  lockedFor(key: string, now: number): number {
    const entry = this.live(key, now);
    return entry && entry.lockedUntil > now ? entry.lockedUntil - now : 0;
  }

  /**
   * Whether one more attempt may start: the failures already in the window plus the attempts in flight
   * stay below the threshold. 0 means yes; otherwise IN_FLIGHT_RETRY_MS. An unlocked key always has fewer
   * than `max` failures (the max-th failure locks it), so a full unlocked key is full only because of
   * attempts in flight, and those settle within about a second: the client is told to retry that soon,
   * not when the oldest failure leaves the window. A locked key is answered by `lockedFor` instead.
   */
  fullFor(key: string, now: number): number {
    const entry = this.live(key, now);
    return entry && entry.failures.length + entry.reserved >= this.max ? IN_FLIGHT_RETRY_MS : 0;
  }

  reserve(key: string, now: number): void {
    const entry = this.live(key, now) ?? { failures: [], lockedUntil: 0, reserved: 0 };
    entry.reserved += 1;
    this.map.set(key, entry);
  }

  unreserve(key: string, now: number): void {
    const entry = this.map.get(key);
    if (!entry) return;
    entry.reserved = Math.max(0, entry.reserved - 1);
    this.live(key, now); // drops the entry if nothing else is left in it
  }

  /** Counts one failure; returns true when this failure locks the key. */
  fail(key: string, now: number): boolean {
    const entry = this.live(key, now) ?? { failures: [], lockedUntil: 0, reserved: 0 };
    this.map.set(key, entry);
    if (entry.lockedUntil > now) return false;
    entry.failures.push(now);
    if (entry.failures.length > this.max) entry.failures.shift();
    if (entry.failures.length < this.max) return false;
    entry.lockedUntil = now + this.lockMs;
    return true;
  }

  clear(key: string): void {
    const entry = this.map.get(key);
    if (!entry) return;
    entry.failures = [];
    entry.lockedUntil = 0;
    if (this.idle(entry)) this.map.delete(key);
  }

  /** Inspects up to SWEEP_BATCH entries, resuming where the previous sweep stopped, and drops idle ones. */
  sweep(now: number): void {
    for (let i = 0; i < SWEEP_BATCH; i++) {
      this.cursor ??= this.map.entries();
      const next = this.cursor.next();
      if (next.done) {
        this.cursor = undefined;
        return;
      }
      this.live(next.value[0], now);
    }
  }
}

/** One login attempt that passed the gate. Settle it exactly once; later calls are no-ops. */
export type LoginAttempt = {
  /** The password was wrong: the source reservation becomes a recorded failure. Returns newly locked scopes. */
  fail(): LockScope[];
  /** The login succeeded: the reservation is released and the account's failures are cleared. */
  succeed(): void;
  /** Neither (the check threw): the reservation is released and nothing is recorded. Safe in `finally`. */
  release(): void;
};

export type LoginGate = { lock: Lock } | { attempt: LoginAttempt };

export class LoginThrottle {
  private readonly accounts: Counters;
  private readonly sources: Counters;
  private readonly queues = new Map<string, Promise<unknown>>();
  private lastSweep: number;

  constructor(private readonly now: () => number = Date.now, private readonly limits: LoginThrottleLimits = LOGIN_THROTTLE) {
    this.accounts = new Counters(limits.windowMs, limits.lockMs, limits.accountMaxFailures);
    this.sources = new Counters(limits.windowMs, limits.lockMs, limits.sourceMaxFailures);
    this.lastSweep = now();
  }

  /** Number of accounts and sources currently tracked (tests and diagnostics). */
  get trackedKeys(): number {
    return this.accounts.size + this.sources.size;
  }

  private tick(): number {
    const now = this.now();
    if (now - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.lastSweep = now;
      this.accounts.sweep(now);
      this.sources.sweep(now);
    }
    return now;
  }

  /**
   * The lock that refuses this attempt, or null. When both apply the scope is the account's, and the
   * retry time is the longer of the two, so a client that waits as told is not refused again at once.
   */
  check(account: string, source: string): Lock | null {
    const now = this.tick();
    return this.lockAt(account, source, now);
  }

  private lockAt(account: string, source: string, now: number): Lock | null {
    const accountMs = this.accounts.lockedFor(account, now);
    // A locked source reports its remaining lock; an unlocked one is refused only while its budget is in flight.
    const sourceMs = this.sources.lockedFor(source, now) || this.sources.fullFor(source, now);
    if (accountMs === 0 && sourceMs === 0) return null;
    return { scope: accountMs > 0 ? "account" : "source", retryAfterMs: Math.max(accountMs, sourceMs) };
  }

  /**
   * Admits one attempt or refuses it. Admission reserves one of the source's remaining failures before the
   * password is checked, synchronously, so attempts on different accounts from one source cannot all pass
   * the gate while their checks are in flight: with 19 failures recorded, one attempt is admitted and the
   * next is refused until the first settles. Attempts on one account are already ordered by `serialize`.
   */
  begin(account: string, source: string): LoginGate {
    const now = this.tick();
    const lock = this.lockAt(account, source, now);
    if (lock) return { lock };
    this.sources.reserve(source, now);
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      this.sources.unreserve(source, this.now());
      return true;
    };
    return {
      attempt: {
        fail: () => (settle() ? this.recordFailure(account, source) : []),
        succeed: () => {
          if (settle()) this.recordSuccess(account);
        },
        release: () => {
          settle();
        },
      },
    };
  }

  /** Records a failed attempt and returns the scopes this failure newly locked. */
  recordFailure(account: string, source: string): LockScope[] {
    const now = this.tick();
    const locked: LockScope[] = [];
    if (this.accounts.fail(account, now)) locked.push("account");
    if (this.sources.fail(source, now)) locked.push("source");
    return locked;
  }

  /** A successful login clears that account's failures. The source counter is left alone. */
  recordSuccess(account: string): void {
    this.tick();
    this.accounts.clear(account);
  }

  /**
   * Runs one login attempt for `account` after any earlier attempt for it has finished. Password checks
   * are async, so without this a burst of concurrent attempts would all pass the gate before any failure
   * was recorded, and the account limit would not hold. Attempts on different accounts still run in
   * parallel; the source limit holds for them through `begin`'s reservations.
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
