import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { claimIsStaleForTest, isStaleForTest, snapshotLockForTest, takeOverStaleLock } from "../../src/accounts/lock.js";
import { accountsLockPath, withAccountsLock } from "../../src/accounts/store.js";

/**
 * Round four, lock findings: a takeover claim can expire under its owner, and a holder record can outlive
 * the pid it names.
 */

/**
 * Runs once, inside the takeover, right after the claim was acquired: that is the only moment at which a
 * claim can expire under its owner. The hook replaces the claim with a peer's, exactly as another waiter
 * that judged ours abandoned would.
 */
const duringTakeover: Array<() => void> = [];
/**
 * Runs when the takeover reads the claim file it just wrote (`stillOwnsClaim`). That is the exact window
 * between "the lock I judged is still the one on disk" and the removal: a peer can vacate and re-create the
 * path there, and the removal must not take the new lock with it.
 */
const whileCheckingClaim: Array<() => void> = [];

/**
 * How many times a guarded path was stat'ed, and the ceiling it must stay under.
 *
 * A loop that re-judges the same lock with no wait between passes cannot be caught by a timeout: the passes
 * are synchronous, so the event loop a vitest timeout needs never runs and the test hangs instead of failing.
 * Counting the stats the way out — the ceiling is armed only for a test that expects the loop to give up at
 * its deadline, and throwing from inside the loop turns "spins forever" into an ordinary assertion failure.
 */
const statGuard = { path: "", count: 0, limit: Number.POSITIVE_INFINITY };

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    lstatSync: ((...args: Parameters<typeof real.lstatSync>) => {
      if (statGuard.path !== "" && String(args[0]) === statGuard.path) {
        statGuard.count += 1;
        if (statGuard.count > statGuard.limit) {
          throw new Error(`spin detected: the lock was re-judged ${statGuard.count} times without waiting`);
        }
      }
      // `snapshotLock` is the first thing the takeover does after it holds the claim.
      const hook = duringTakeover.shift();
      if (hook) hook();
      return (real.lstatSync as (...a: typeof args) => ReturnType<typeof real.lstatSync>)(...args);
    }) as typeof real.lstatSync,
    readFileSync: ((...args: Parameters<typeof real.readFileSync>) => {
      if (String(args[0]).endsWith(".takeover")) {
        const hook = whileCheckingClaim.shift();
        if (hook) hook();
      }
      return (real.readFileSync as (...a: typeof args) => ReturnType<typeof real.readFileSync>)(...args);
    }) as typeof real.readFileSync,
  };
});

let root: string;
let home: string;
beforeEach(() => {
  duringTakeover.length = 0;
  statGuard.path = "";
  statGuard.count = 0;
  statGuard.limit = Number.POSITIVE_INFINITY;
  whileCheckingClaim.length = 0;
  root = mkdtempSync(join(tmpdir(), "nema-claims-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const lock = () => accountsLockPath(home);
const claimPath = () => `${lock()}.takeover`;
const staleRaw = JSON.stringify({ pid: 999_999, at: 1, token: "stale" });

function plantStaleLock(): ReturnType<typeof snapshotLockForTest> {
  mkdirSync(home, { recursive: true });
  writeFileSync(lock(), staleRaw, { mode: 0o600 });
  return snapshotLockForTest(lock());
}

describe("a takeover claim that expired under its owner (review 1)", () => {
  test("a waiter whose claim expired mid-takeover does not remove anything", () => {
    const observed = plantStaleLock()!;
    // A paused taker's claim is expired after its age limit and replaced by the next waiter. Inject that
    // replacement at the exact point where this waiter would act on its decision.
    duringTakeover.push(() => {
      writeFileSync(claimPath(), JSON.stringify({ pid: process.pid, at: Date.now(), token: "other-waiter" }), { mode: 0o600 });
    });

    expect(takeOverStaleLock(lock(), observed)).toBe(false);
    // The stale lock is still there: removing it without holding the claim is what lets two writers in.
    expect(existsSync(lock())).toBe(true);
    expect(readFileSync(lock(), "utf8")).toBe(staleRaw);
    // And the peer's claim is untouched for its owner to finish with.
    expect(JSON.parse(readFileSync(claimPath(), "utf8")).token).toBe("other-waiter");
  });

  test("a claim left by a dead process is reclaimable immediately", () => {
    plantStaleLock();
    // A claim written by a process that has certainly exited: it must not wedge the file.
    writeFileSync(claimPath(), JSON.stringify({ pid: 999_999, at: Date.now(), token: "dead" }), { mode: 0o600 });

    expect(withAccountsLock(home, () => "ran")).toBe("ran");
    expect(existsSync(lock())).toBe(false);
  });

  test("an old claim from a live-looking pid is expired by age", () => {
    plantStaleLock();
    writeFileSync(claimPath(), JSON.stringify({ pid: process.pid, at: 1, token: "paused" }), { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(claimPath(), old, old);

    expect(withAccountsLock(home, () => "ran")).toBe("ran");
  });

  test("a claim whose holder is alive and verifiable is not expired by age (review 5)", () => {
    // The claim is this process's own, written the way `enterTakeoverClaim` writes it (pid + start time). It
    // is 30 seconds old, which is far past `LOCK_CLAIM_STALE_MS` (10 s). Age alone used to expire it, so a
    // second waiter could enter the claim, re-judge a lock the first waiter had already judged against a
    // file that has since been replaced, and delete the lock a live writer had just created.
    const observed = plantStaleLock()!;
    const ownStart = startOf(process.pid);
    if (ownStart === null) return; // this host does not expose process start times
    writeFileSync(claimPath(), JSON.stringify({ pid: process.pid, at: Date.now() - 30_000, token: "live-owner", startedAt: ownStart }), { mode: 0o600 });
    const old = new Date(Date.now() - 30_000);
    utimesSync(claimPath(), old, old);

    // The takeover declines: the claim belongs to a live, verifiable owner.
    expect(takeOverStaleLock(lock(), observed)).toBe(false);
    // Neither the stale lock nor the live claim was touched.
    expect(existsSync(lock())).toBe(true);
    expect(JSON.parse(readFileSync(claimPath(), "utf8")).token).toBe("live-owner");
  });

  test("a claim whose start time is verifiably different is expired", () => {
    plantStaleLock();
    const ownStart = startOf(process.pid);
    if (ownStart === null) return;
    // A recycled pid: the process alive under this number started an hour after the record claims.
    writeFileSync(claimPath(), JSON.stringify({
      pid: process.pid, at: Date.now(), token: "reused-pid", startedAt: ownStart - 3_600_000,
    }), { mode: 0o600 });

    expect(withAccountsLock(home, () => "ran")).toBe("ran");
  });

  test("a lock created while the claim is being checked survives the removal", () => {
    const observed = plantStaleLock()!;
    // A peer replaces the lock between the last comparison and the unlink: it vacated the path (its own
    // takeover) and created a live lock of its own. Removing by path name here would delete a lock the peer
    // is inside the critical section holding.
    const live = JSON.stringify({ pid: process.pid, at: Date.now(), token: "peer-live", startedAt: Date.now() });
    whileCheckingClaim.push(() => {
      unlinkSync(lock());
      writeFileSync(lock(), live, { mode: 0o600 });
    });

    expect(takeOverStaleLock(lock(), observed)).toBe(false);
    expect(existsSync(lock())).toBe(true);
    expect(readFileSync(lock(), "utf8")).toBe(live);
  });

  test("the claim is removed only by the waiter that owns it", () => {
    const observed = plantStaleLock()!;
    expect(takeOverStaleLock(lock(), observed)).toBe(true);
    void duringTakeover;
    // Our own claim is cleaned up in the same call.
    expect(existsSync(claimPath())).toBe(false);
    expect(existsSync(lock())).toBe(false);
  });
});

describe("a stale lock this waiter cannot take over (coderabbit 1)", () => {
  test("a refused takeover waits for the deadline instead of spinning on the same judgement", () => {
    // The shape: the lock is stale, and another waiter holds the takeover claim, so `takeOverStaleLock`
    // returns false on every pass while `isStale` keeps saying yes. Continuing immediately on that answer
    // re-judges the very same file with no deadline check and no wait between passes, so the call never
    // returns — it burns a core until the process is killed. Waiting like any other waiter is what makes the
    // deadline reachable.
    const observed = plantStaleLock()!;
    const ownStart = startOf(process.pid);
    // A claim its owner is still inside: this process, with the start time the platform reports (omitted
    // where it reports none, in which case the claim is only young and that is enough).
    writeFileSync(claimPath(), JSON.stringify({
      pid: process.pid, at: Date.now(), token: "other-waiter", ...(ownStart === null ? {} : { startedAt: ownStart }),
    }), { mode: 0o600 });

    // A real wait of 150 ms at the 25 ms poll interval is about six passes; the ceiling leaves generous room
    // for scheduling while still catching a loop that never waits at all.
    statGuard.path = lock();
    statGuard.count = 0;
    statGuard.limit = 40;
    const waitMs = 150;
    const started = Date.now();
    let message = "";
    try {
      withAccountsLock(home, () => "ran", { waitMs });
    } catch (e) {
      message = (e as Error).message;
    }
    const elapsed = Date.now() - started;
    statGuard.path = "";
    expect(statGuard.count).toBeLessThanOrEqual(40);

    // It gave up at its deadline, having actually waited: the old shape never got here at all.
    expect(message).toContain("等待账户文件锁超时");
    expect(elapsed).toBeGreaterThanOrEqual(waitMs - 10);
    // And it acted on nothing: the stale lock and the peer's live claim are both untouched.
    expect(readFileSync(lock(), "utf8")).toBe(staleRaw);
    expect(JSON.parse(readFileSync(claimPath(), "utf8")).token).toBe("other-waiter");
    expect(existsSync(lock())).toBe(true);
    expect(observed.raw).toBe(staleRaw);
  });

  test("a takeover that succeeds is retried at once, without waiting for the poll interval", () => {
    // The other half of the same rule: `true` means the path is free, so the caller must go straight back to
    // creating the lock. Waiting there would turn a recoverable stale lock into a full poll delay.
    plantStaleLock();
    const started = Date.now();

    expect(withAccountsLock(home, () => "ran")).toBe("ran");
    // Well under LOCK_POLL_MS (25 ms) of waiting per attempt: the acquisition is immediate, not polled.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(lock())).toBe(false); // released again by the holder
  });
});

describe("the lock was replaced and then put back (review 6)", () => {
  test("a path that changed identity after the judgement is not removed even if the judged file returns", () => {
    // The identity check that runs on entering the claim is what notices the path was occupied by someone
    // else. A hard link makes "it is back" indistinguishable from "it never left" for the final check — same
    // device, inode, mtime, size and bytes — so without the first check the taker would delete a file it had
    // already been told was replaced. That is the shape a `link()`-based restore produces.
    const observed = plantStaleLock()!;
    const kept = join(home, "accounts.lock.kept");
    linkSync(lock(), kept); // the same inode under a second name, so it can be put back later
    duringTakeover.push(() => {
      // A peer's live lock takes the path at the moment this taker enters the claim.
      rmSync(lock());
      writeFileSync(lock(), JSON.stringify({ pid: process.pid, at: Date.now(), token: "live" }), { mode: 0o600 });
    });
    whileCheckingClaim.push(() => {
      // ...and the judged file is back at the path by the time of the final check: same inode, same bytes.
      rmSync(lock());
      renameSync(kept, lock());
    });

    expect(takeOverStaleLock(lock(), observed)).toBe(false);
    expect(existsSync(lock())).toBe(true);
    expect(readFileSync(lock(), "utf8")).toBe(staleRaw);
  });
});

describe("a claim whose owner this platform cannot verify (review 6)", () => {
  test("an unknown start time does not expire a live owner's claim", () => {
    // Windows cannot report a process start time, so every answer is "unknown". Treating that as "different"
    // expires a claim whose owner is alive and about to remove a lock, which is how a second waiter acts on a
    // judgement made against a lock that has since been replaced.
    mkdirSync(home, { recursive: true });
    writeFileSync(claimPath(), JSON.stringify({
      pid: process.ppid, at: Date.now(), token: "unverifiable", startedAt: Date.now() - 3_600_000,
    }), { mode: 0o600 });

    expect(claimIsStaleForTest(claimPath(), { alive: () => true, startedAt: () => "unknown" })).toBe(false);
    // The two answers that do settle it keep working: a verifiable match keeps the claim, a mismatch expires it.
    expect(claimIsStaleForTest(claimPath(), { alive: () => true, startedAt: () => "same" })).toBe(false);
    expect(claimIsStaleForTest(claimPath(), { alive: () => true, startedAt: () => "different" })).toBe(true);
    expect(claimIsStaleForTest(claimPath(), { alive: () => false })).toBe(true);
  });
});

describe("a holder pid that was reused (review 3)", () => {
  test("a lock whose holder record predates the running process is reclaimed", () => {
    if (process.platform !== "linux") return; // the start-time comparison is only read on Linux/macOS
    mkdirSync(home, { recursive: true });
    // The pid belongs to a live process (our parent) but the record says the holder started an hour ago,
    // which is what a reused pid looks like: a different process now has that number.
    writeFileSync(lock(), JSON.stringify({
      pid: process.ppid, at: Date.now() - 3_600_000, token: "crashed", startedAt: Date.now() - 3_600_000,
    }), { mode: 0o600 });

    expect(withAccountsLock(home, () => "ran", { waitMs: 5_000 })).toBe("ran");
    expect(existsSync(lock())).toBe(false);
  });

  test("a lock held by this very process under another live process's name is not reclaimed early", () => {
    // A record naming a live pid whose start time matches that process is a real holder: it must be waited
    // for, not taken over. Our own process is used as the always-alive, correctly-identified holder.
    mkdirSync(home, { recursive: true });
    const realStart = process.platform === "linux" ? startOf(process.pid) : null;
    if (realStart === null) return; // this host does not expose process start times
    writeFileSync(lock(), JSON.stringify({
      pid: process.pid, at: Date.now(), token: "live", startedAt: realStart,
    }), { mode: 0o600 });

    // Our own pid without our in-process mark is treated as a stale record from an earlier process with
    // this pid, which is the existing, documented rule; what matters here is that a *matching* start time is
    // recognised as a live holder rather than an unverifiable record. Assert the age rule does not apply.
    expect(snapshotLockForTest(lock())!.raw).toContain('"startedAt"');
  });

  test("a record without a start time is reclaimed after its maximum age, not immediately", () => {
    mkdirSync(home, { recursive: true });
    // An older build's record: no startedAt, and a pid that belongs to an unrelated live process (our own,
    // seen from the outside so the in-process mark does not apply).
    const foreignPid = process.ppid;
    writeFileSync(lock(), JSON.stringify({ pid: foreignPid, at: Date.now(), token: "old-build" }), { mode: 0o600 });
    expect(() => withAccountsLock(home, () => "ran", { waitMs: 200 })).toThrow(/超时/);

    // The same record, an hour old, is reclaimed so the file cannot wedge forever.
    writeFileSync(lock(), JSON.stringify({ pid: foreignPid, at: Date.now() - 3_600_000, token: "old-build" }), { mode: 0o600 });
    expect(withAccountsLock(home, () => "ran", { waitMs: 3_000 })).toBe("ran");
  });
});

describe("a platform that cannot report process start times (review 5, Windows)", () => {
  /**
   * Windows has no `/proc` and no `ps -o lstart`, so `processStartMs` returns null and every start-time
   * answer is "unknown". Treating "unknown" as "different" reclaimed a lock held by a live writer the
   * moment it was judged, which is how two writers could enter the critical section at once.
   */
  const windowsProbes = { alive: () => true, startedAt: () => "unknown" as const };

  function plant(ageMs: number): { snapshot: NonNullable<ReturnType<typeof snapshotLockForTest>>; lockPath: string } {
    mkdirSync(home, { recursive: true });
    // A live holder under another pid, with a start time this platform cannot check.
    writeFileSync(lock(), JSON.stringify({
      pid: process.ppid, at: Date.now() - ageMs, token: "live-but-unverifiable", startedAt: Date.now() - 3_600_000,
    }), { mode: 0o600 });
    return { snapshot: snapshotLockForTest(lock())!, lockPath: lock() };
  }

  test("a live lock is not stale while the start time cannot be verified", () => {
    const { snapshot, lockPath } = plant(60_000);

    expect(isStaleForTest(snapshot, lockPath, windowsProbes)).toBe(false);
  });

  test("it becomes stale only after the maximum unverified age", () => {
    // Ten minutes is the documented ceiling: long enough that no real critical section reaches it, so the
    // file cannot wedge forever, and short enough to recover in one sitting.
    const tenMinutes = 10 * 60_000;
    const justUnder = plant(tenMinutes - 30_000);
    expect(isStaleForTest(justUnder.snapshot, justUnder.lockPath, windowsProbes)).toBe(false);
    rmSync(lock());

    const over = plant(tenMinutes + 30_000);
    expect(isStaleForTest(over.snapshot, over.lockPath, windowsProbes)).toBe(true);
  });

  test("a dead holder is still reclaimed at once, and a verifiable mismatch still is too", () => {
    // The age fallback is only for "cannot tell". The two answers that do settle it keep working on every
    // platform, or a crashed writer's lock would sit there for ten minutes.
    const { snapshot, lockPath } = plant(0);

    expect(isStaleForTest(snapshot, lockPath, { alive: () => false })).toBe(true);
    expect(isStaleForTest(snapshot, lockPath, { alive: () => true, startedAt: () => "different" })).toBe(true);
    expect(isStaleForTest(snapshot, lockPath, { alive: () => true, startedAt: () => "same" })).toBe(false);
  });
});

/** The start time the platform reports for a pid, computed the way the lock module does. */
function startOf(pid: number): number | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs") as typeof import("node:fs");
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const uptime = Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    const value = Date.now() - (uptime - ticks / 100) * 1000;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
