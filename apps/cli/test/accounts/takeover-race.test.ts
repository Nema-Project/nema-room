import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The two compare-and-remove decisions in the account layer, with the race injected at the exact moment it
 * happens in reality.
 *
 * A lock and a legacy credential are both removed "if still the file we looked at", and Node has no
 * conditional unlink. The implementations move the file to a private claim name first and decide on what
 * lands there. That is only correct if the decision is made on the claim *after* the move, so these tests
 * replace the file immediately before each rename and assert that:
 *
 *   - the replacement survives (it is never the file that gets deleted), and
 *   - the lock path is never vacated (a peer must not be able to acquire it mid-takeover).
 */

const beforeRename: Array<() => void> = [];
const lockPathRenames: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: ((from: Parameters<typeof real.renameSync>[0], to: Parameters<typeof real.renameSync>[1]) => {
      // Run the queued interference exactly once, right before the rename that this call performs.
      const hook = beforeRename.shift();
      if (hook) hook();
      lockPathRenames.push(String(from));
      return real.renameSync(from, to);
    }) as typeof real.renameSync,
  };
});

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-takeover-"));
  home = join(root, "nema");
  beforeRename.length = 0;
  lockPathRenames.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const OLD = "fake-credential-old-0000";
const NEW = "fake-credential-new-1111";

describe("retiring the legacy credential (review 2)", () => {
  test("a credential replaced at the moment of retirement is the one that survives", async () => {
    const { readLegacyCredential, removeLegacyIfUnchanged } = await import("../../src/accounts/legacy.js");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), OLD, { mode: 0o600 });
    // The copy step read the old bytes; the writer then replaces the file before the retirement runs.
    const source = readLegacyCredential(home, join(home, "byok-key"));
    beforeRename.push(() => writeFileSync(join(home, "byok-key"), NEW, { mode: 0o600 }));

    const removed = removeLegacyIfUnchanged(home, source);

    expect(removed).toBe(false);
    // The newer credential is back where the writer put it, byte for byte.
    expect(readFileSync(join(home, "byok-key"), "utf8")).toBe(NEW);
  });

  test("an unchanged credential is retired", async () => {
    const { readLegacyCredential, removeLegacyIfUnchanged } = await import("../../src/accounts/legacy.js");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), OLD, { mode: 0o600 });
    const source = readLegacyCredential(home, join(home, "byok-key"));

    expect(removeLegacyIfUnchanged(home, source)).toBe(true);
    expect(existsSync(join(home, "byok-key"))).toBe(false);
    // No claim file left behind either: the claim is deleted once its contents are known.
    expect(readdirSync(home).filter((n) => n.includes(".retire-"))).toEqual([]);
  });

  test("a credential re-saved while the retirement is in flight is not overwritten by the restore", async () => {
    const { readLegacyCredential, removeLegacyIfUnchanged } = await import("../../src/accounts/legacy.js");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), OLD, { mode: 0o600 });
    const source = readLegacyCredential(home, join(home, "byok-key"));
    // Two writes land: one before the move (what lands in the claim) and one after it (a new save).
    beforeRename.push(() => writeFileSync(join(home, "byok-key"), NEW, { mode: 0o600 }));

    removeLegacyIfUnchanged(home, source);
    // Whatever the second writer did, the path never ends up holding the stale copy we meant to retire.
    expect(readFileSync(join(home, "byok-key"), "utf8")).not.toBe(OLD);
  });
});

describe("taking over a stale lock (review 1, 4)", () => {
  test("a displaced live lock is never moved off the path", async () => {
    const { snapshotLockForTest, takeOverStaleLock } = await import("../../src/accounts/lock.js");
    const lock = join(home, "accounts.lock");
    mkdirSync(home, { recursive: true });
    const stale = JSON.stringify({ pid: 999_999, at: 1, token: "stale" });
    writeFileSync(lock, stale, { mode: 0o600 });
    const observed = snapshotLockForTest(lock)!;
    // A peer replaces the lock with its own live one before the takeover runs.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: "live" }), { mode: 0o600 });
    lockPathRenames.length = 0;

    expect(takeOverStaleLock(lock, observed)).toBe(false);
    // The decision was made without touching the path: a vacant path is what lets two holders in.
    expect(lockPathRenames).toEqual([]);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("live");
  });

  test("the judged stale lock is removed", async () => {
    const { snapshotLockForTest, takeOverStaleLock } = await import("../../src/accounts/lock.js");
    const lock = join(home, "accounts.lock");
    mkdirSync(home, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999_999, at: 1, token: "stale" }), { mode: 0o600 });
    const observed = snapshotLockForTest(lock)!;

    expect(takeOverStaleLock(lock, observed)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(lockPathRenames).toEqual([]);
  });

  test("a live peer that appears while the claim is being taken keeps its lock", async () => {
    const { snapshotLockForTest, takeOverStaleLock } = await import("../../src/accounts/lock.js");
    const lock = join(home, "accounts.lock");
    mkdirSync(home, { recursive: true });
    writeFileSync(lock, JSON.stringify({ pid: 999_999, at: 1, token: "stale" }), { mode: 0o600 });
    const observed = snapshotLockForTest(lock)!;

    // The takeover must not delete a lock that changed identity under it. The replacement carries the
    // same holder record and the same age, so content and mtime alone would call it the same lock.
    const again = JSON.stringify({ pid: 999_999, at: 1, token: "stale" });
    writeFileSync(join(root, "swap"), again, { mode: 0o600 });
    rmSync(lock);
    renameSync(join(root, "swap"), lock);
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    // A distinct inode number is what is left to tell them apart.
    expect(statSync(lock).ino).not.toBe(Number(observed.ino));

    expect(takeOverStaleLock(lock, observed)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });
});
