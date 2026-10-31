import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { assertHomeNotSymlinked, assertNoSymlinkedComponent } from "./paths.js";
import { protectPrivatePath } from "../secrets/permissions.js";

/**
 * The cross-process lock that serializes writers of `accounts.json`.
 *
 * Two things make this harder than it looks:
 *
 * 1. A lock file is created and *then* filled in, so a peer can observe it empty. Treating an unreadable
 *    lock as stale would let two writers into the critical section at once and let one drop the other's
 *    account. This lock therefore never judges a young unreadable lock stale, and the writer tries to
 *    create the file fully formed (one atomic `link`) so the window does not exist at all.
 * 2. Several waiters may decide the same lock is stale. Deleting it by path can delete a *newer* lock a
 *    peer created in the meantime, so the removal is a rename to a unique name: whatever is now in the
 *    tomb is exactly the inode that was judged, and if its content does not match what was judged the
 *    lock is put back instead of deleted.
 */

export const accountsLockPath = (nemaHome: string): string => path.join(nemaHome, "accounts.lock");

/** How long a writer waits for a live holder before giving up. */
const LOCK_WAIT_MS = 15_000;
/**
 * A lock this old whose metadata still cannot be read is not "just being created": its creator died
 * between creating the file and writing its record. Kept well above any plausible scheduling gap, so a
 * live holder is never mistaken for a dead one.
 */
const LOCK_PARTIAL_STALE_MS = 30_000;
const LOCK_POLL_MS = 25;

/**
 * Lock files this process holds. A lock cannot be re-entered: `writeAccounts` called from inside
 * `withAccountsLock` must not wait for the lock it already holds, and a nested `withAccountsLock` is a
 * bug we report instead of deadlocking on it.
 */
const heldLocks = new Set<string>();
const lockKey = (lockPath: string): string => path.resolve(lockPath);

export function holdsAccountsLock(nemaHome: string): boolean {
  return heldLocks.has(lockKey(accountsLockPath(nemaHome)));
}

type LockHolder = { pid: number; at: number; token: string };

function parseLock(raw: string): LockHolder | null {
  try {
    const v = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && typeof v.token === "string" && v.token !== "") {
      return { pid: v.pid, at: typeof v.at === "number" ? v.at : 0, token: v.token };
    }
  } catch {
    /* empty, or the holder died before writing its record */
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH"; // EPERM: exists, owned by someone else
  }
}

/**
 * Creates the lock file *with its metadata already in it*. A hard link gives exactly that: `link()` is
 * atomic, fails with EEXIST when the lock is taken, and the linked inode already carries the record.
 * Filesystems without hard links fall back to exclusive create + write, which is also atomic for
 * creation; only the metadata is briefly invisible there, and the reader tolerates that.
 */
function createLockFile(lockPath: string, body: string): boolean {
  const tmp = `${lockPath}.init-${process.pid}-${randomUUID()}`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, lockPath);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // EPERM/ENOTSUP/EXDEV/EMLINK: this filesystem cannot hard-link. Exclusive create is still atomic.
      return createLockFileExclusive(lockPath, body);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* the lock itself is the link; the temp name is disposable */
    }
  }
}

function createLockFileExclusive(lockPath: string, body: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

function readLockFile(lockPath: string): { raw: string; holder: LockHolder | null } | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    return { raw, holder: parseLock(raw) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; // released between our attempt and the read
    throw e;
  }
}

function lockAgeMs(lockPath: string): number | null {
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs;
  } catch {
    return null; // gone already
  }
}

/**
 * Removes a lock judged stale, but only while it is still the one judged. The rename is the
 * compare-and-delete Node does not offer: whatever is in the tomb is exactly one file, and if its
 * content is not what was judged stale, a peer replaced the lock meanwhile and we put it back.
 *
 * Returns true when a stale lock was actually removed.
 */
export function takeOverStaleLock(lockPath: string, staleRaw: string): boolean {
  const tomb = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, tomb);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // someone else took it over
    throw e;
  }
  let removed = false;
  try {
    let moved: string | null = null;
    try {
      moved = readFileSync(tomb, "utf8");
    } catch {
      moved = null;
    }
    if (moved === staleRaw) {
      removed = true;
    } else {
      // A newer lock was in place; give it back rather than deleting somebody's live lock.
      restoreLock(tomb, lockPath);
    }
  } finally {
    try {
      unlinkSync(tomb);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/**
 * Puts a lock we took over by mistake back. `link` fails if a newer lock already exists, which is the
 * right outcome: the peer's lock wins and ours is dropped (its owner notices on release).
 */
function restoreLock(tomb: string, lockPath: string): void {
  try {
    linkSync(tomb, lockPath);
    return;
  } catch {
    /* no hard links here, or the path is taken again: try a plain exclusive copy */
  }
  try {
    copyFileSync(tomb, lockPath, constants.COPYFILE_EXCL);
  } catch {
    /* a newer lock is in place, or this platform cannot restore it */
  }
}

function acquireAccountsLock(nemaHome: string, waitMs: number): { lockPath: string; token: string } {
  // Before any mkdir/chmod/write: a linked home would redirect all of them onto someone else's tree.
  assertHomeNotSymlinked(nemaHome);
  const lockPath = accountsLockPath(nemaHome);
  // Covers the home directory itself, every level below it, and the lock file name itself.
  assertNoSymlinkedComponent(nemaHome, lockPath);
  mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
  protectPrivatePath(nemaHome, 0o700);
  // Re-check after creating: a home that did not exist a moment ago could have been created as a link.
  assertHomeNotSymlinked(nemaHome);
  assertNoSymlinkedComponent(nemaHome, lockPath);

  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, at: Date.now(), token });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (createLockFile(lockPath, body)) {
      heldLocks.add(lockKey(lockPath));
      return { lockPath, token };
    }
    try {
      if (lstatSync(lockPath).isSymbolicLink()) throw new Error("账户文件锁路径是符号链接，已拒绝使用账户功能。");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released between attempt and read
      throw e;
    }
    const seen = readLockFile(lockPath);
    if (seen === null) continue;
    if (seen.holder === null) {
      // Either its creator is between creating the file and writing its record, or it died there. Only
      // age separates the two, so a fresh unreadable lock is waited on, never removed.
      if ((lockAgeMs(lockPath) ?? 0) >= LOCK_PARTIAL_STALE_MS) {
        takeOverStaleLock(lockPath, seen.raw);
        continue;
      }
    } else if (seen.holder.pid === process.pid) {
      if (!heldLocks.has(lockKey(lockPath))) {
        // Our own pid without our mark: a lock left by a previous process that happened to have this pid.
        takeOverStaleLock(lockPath, seen.raw);
        continue;
      }
      throw new Error("账户文件锁已在当前进程内持有，不能重入");
    } else if (!pidAlive(seen.holder.pid)) {
      takeOverStaleLock(lockPath, seen.raw);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待账户文件锁超时，请稍后重试（若占用者已退出，可删除 ${lockPath}）`);
    }
    // Materializing is a short synchronous step; blocking here keeps the API synchronous like the rest
    // of the account helpers, which the settings service calls without an event loop turn.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
  }
}

function releaseAccountsLock(lockPath: string, token: string): void {
  heldLocks.delete(lockKey(lockPath));
  try {
    const raw = readFileSync(lockPath, "utf8");
    // A lock we no longer hold (taken over as stale) is not ours to delete.
    if (parseLock(raw)?.token !== token) return;
    unlinkSync(lockPath);
  } catch {
    /* a lock we cannot remove goes stale once this process exits */
  }
}

/**
 * Serializes writers of `accounts.json` across processes. The store's own write is atomic, but
 * "read, decide, write" is not: two daemons editing accounts at once would each write their own snapshot
 * and the later one would drop the earlier one's account. A caller that only reads needs no lock.
 *
 * `waitMs` is only interesting to callers that must fail fast (tests, a settings request under a
 * deadline); the default is longer than any real critical section.
 */
export function withAccountsLock<T>(nemaHome: string, fn: () => T, opts: { waitMs?: number } = {}): T {
  const { lockPath, token } = acquireAccountsLock(nemaHome, opts.waitMs ?? LOCK_WAIT_MS);
  try {
    return fn();
  } finally {
    releaseAccountsLock(lockPath, token);
  }
}
