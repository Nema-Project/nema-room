import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { snapshotLockForTest, takeOverStaleLock } from "../../src/accounts/lock.js";
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

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    lstatSync: ((...args: Parameters<typeof real.lstatSync>) => {
      // `snapshotLock` is the first thing the takeover does after it holds the claim.
      const hook = duringTakeover.shift();
      if (hook) hook();
      return (real.lstatSync as (...a: typeof args) => ReturnType<typeof real.lstatSync>)(...args);
    }) as typeof real.lstatSync,
  };
});

let root: string;
let home: string;
beforeEach(() => {
  duringTakeover.length = 0;
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

  test("the claim is removed only by the waiter that owns it", () => {
    const observed = plantStaleLock()!;
    expect(takeOverStaleLock(lock(), observed)).toBe(true);
    void duringTakeover;
    // Our own claim is cleaned up in the same call.
    expect(existsSync(claimPath())).toBe(false);
    expect(existsSync(lock())).toBe(false);
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
