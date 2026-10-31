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
  unlinkSync,
  writeSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { assertHomeNotSymlinked, assertNoSymlinkedComponent } from "./paths.js";
import { protectPrivatePath } from "../secrets/permissions.js";

/**
 * The cross-process lock that serializes writers of `accounts.json`.
 *
 * Three things make this harder than it looks:
 *
 * 1. A lock file is created and *then* filled in, so a peer can observe it empty. Treating an unreadable
 *    lock as stale would let two writers into the critical section at once. This lock therefore never
 *    judges a young unreadable lock stale, and the writer creates the file fully formed (one atomic
 *    `link`) so the window does not exist at all on filesystems that support hard links.
 * 2. Several waiters may decide the same lock is stale. Deleting it by path could delete a *newer* lock a
 *    peer created in the meantime, which would leave that peer believing it holds a lock nobody else
 *    honours.
 * 3. Two empty locks have identical contents, so content alone cannot tell one from the other.
 *
 * The takeover therefore works in a claim: one waiter at a time may enter it (an exclusively created
 * claim file), and inside it the lock is removed only if the file still has the identity (device and
 * inode) *and* the content that were judged stale. The lock path is never vacated by the taker before
 * that check, so a peer cannot acquire the lock mid-takeover, and a lock created after the judgement is
 * never displaced. Releasing a claim that cannot be acquired is a plain retry.
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
/** A takeover claim older than this was left by a taker that died mid-takeover. */
const LOCK_CLAIM_STALE_MS = 10_000;
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

type LockHolder = { pid: number; at: number; token: string; startedAt?: number };

/**
 * A lock record older than this whose holder cannot be verified (it predates `startedAt`) is treated as
 * abandoned. Long enough that no real critical section reaches it, short enough that a wedged file is
 * recoverable in one sitting.
 */
const LOCK_MAX_UNVERIFIED_AGE_MS = 10 * 60_000;

/**
 * What a waiter saw when it judged a lock stale: identity and content, both checked before removal.
 *
 * The inode alone is not enough on its own in the presence of delete + re-create, because a filesystem may
 * hand the same inode number back. The modification time closes that: a re-created file is a new file even
 * when its number and its (empty) contents happen to match.
 */
export type LockSnapshot = { dev: bigint; ino: bigint; mtimeNs: bigint; size: bigint; raw: string };

function parseLock(raw: string): LockHolder | null {
  try {
    const v = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof v.pid === "number" && Number.isInteger(v.pid) && v.pid > 0 && typeof v.token === "string" && v.token !== "") {
      return {
        pid: v.pid,
        at: typeof v.at === "number" ? v.at : 0,
        token: v.token,
        ...(typeof v.startedAt === "number" ? { startedAt: v.startedAt } : {}),
      };
    }
  } catch {
    /* empty, or the holder died before writing its record */
  }
  return null;
}

/**
 * True when the process currently running as `pid` is the one that wrote a holder record: a reused pid
 * belongs to a process started later than the record.
 *
 * The start time comes from the platform's own bookkeeping (`/proc/<pid>/stat` on Linux, `ps -o lstart` on
 * macOS); where it cannot be read the answer is "assume it is not the same process", which only makes the
 * lock reclaimable earlier, never later.
 */
function sameProcessStartedAt(pid: number, startedAt: number): boolean {
  const actual = processStartMs(pid);
  if (actual === null) return false;
  // Whole-second resolution on most platforms; allow for that and for clock rounding.
  return Math.abs(actual - startedAt) < 2_000;
}

function processStartMs(pid: number): number | null {
  try {
    if (process.platform === "linux") {
      // Field 22 of /proc/<pid>/stat is the start time in clock ticks since boot. Split after the last ")"
      // so a process name containing spaces or parentheses cannot shift the fields.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(fields[19]);
      if (!Number.isFinite(ticks)) return null;
      const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
      if (!Number.isFinite(uptime)) return null;
      const hz = 100; // USER_HZ: 100 on every Linux architecture Node supports
      return Date.now() - (uptime - ticks / hz) * 1000;
    }
    if (process.platform === "darwin") {
      const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim();
      const ms = Date.parse(out);
      return Number.isFinite(ms) ? ms : null;
    }
  } catch {
    /* the process is gone, or the platform does not expose this */
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

/** The lock as it is on disk right now, or null when it does not exist. Throws on an unreadable file. */
function snapshotLock(lockPath: string): LockSnapshot | null {
  let st;
  try {
    st = lstatSync(lockPath, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error("账户文件锁路径是符号链接，已拒绝使用账户功能。");
  let raw = "";
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Removed between the stat and the read: report "gone" rather than a half-observed lock.
    return null;
  }
  return { dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs, size: st.size, raw };
}

/**
 * Creates the lock file *with its metadata already in it*. A hard link gives exactly that: `link()` is
 * atomic, fails with EEXIST when the lock is taken, and the linked inode already carries the record.
 * Filesystems without hard links fall back to exclusive create + write, which is also atomic for
 * creation; only the metadata is briefly invisible there, and a young unreadable lock is never judged
 * stale (see `isStale`).
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

function ageMs(lockPath: string): number | null {
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs;
  } catch {
    return null; // gone already
  }
}

/**
 * True when this observed lock may be removed.
 *
 * A readable lock with a live holder is normally not stale, but pids are reused: after a crash the recorded
 * pid can belong to an unrelated process, and "the pid is alive" would then block every writer forever.
 * The holder record therefore carries the process start time (`startedAt`), and a lock whose pid is alive
 * *and* whose record belongs to that same process is the only one that counts as held. Records without it
 * (written by an older build) fall back to a max-age rule so they cannot wedge the file either.
 *
 * An unreadable lock is stale only once it is old enough that its creator cannot still be writing it: that
 * is what keeps a lock that is merely initializing from being taken over.
 */
function isStale(snapshot: LockSnapshot, lockPath: string): boolean {
  const holder = parseLock(snapshot.raw);
  if (holder === null) return (ageMs(lockPath) ?? 0) >= LOCK_PARTIAL_STALE_MS;
  if (holder.pid === process.pid) return !heldLocks.has(lockKey(lockPath)); // an earlier process with our pid
  if (!pidAlive(holder.pid)) return true;
  if (holder.startedAt !== undefined) return !sameProcessStartedAt(holder.pid, holder.startedAt);
  return Date.now() - holder.at >= LOCK_MAX_UNVERIFIED_AGE_MS;
}

/** Our own takeover claim: its token, so a claim that was expired and taken over is not ours any more. */
type Claim = { path: string; token: string };

/**
 * Enters the one-at-a-time takeover claim. `O_EXCL` makes this exclusive across processes, so at most one
 * waiter can be inside a takeover of this lock at any moment. A claim left behind by a taker that died is
 * removed once it is old enough, so a crashed takeover cannot wedge the file forever.
 *
 * The claim carries a token because it can be expired under us: a taker that pauses longer than
 * `LOCK_CLAIM_STALE_MS` (a stopped process, a suspended laptop) loses the claim, and must then not act on
 * the decision it made while it thought it was alone. `stillOwnsClaim` is the check for that.
 */
function enterTakeoverClaim(claimPath: string): Claim | null {
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(claimPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { path: claimPath, token };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (!claimIsStale(claimPath)) return null;
    try {
      unlinkSync(claimPath);
    } catch {
      /* a peer removed the abandoned claim first */
    }
  }
  return null;
}

/** True when the claim file is old enough that its owner cannot still be working, or has exited. */
function claimIsStale(claimPath: string): boolean {
  if ((ageMs(claimPath) ?? 0) >= LOCK_CLAIM_STALE_MS) return true;
  try {
    const holder = parseLock(readFileSync(claimPath, "utf8"));
    // A claim whose process is gone is abandoned no matter how young it is.
    return holder !== null && !pidAlive(holder.pid);
  } catch {
    return false;
  }
}

/** True while the claim file still holds our token: a claim we lost is not one we may act under. */
function stillOwnsClaim(claim: Claim): boolean {
  try {
    return parseLock(readFileSync(claim.path, "utf8"))?.token === claim.token;
  } catch {
    return false;
  }
}

/**
 * Removes a lock judged stale, but only while the path still names the exact file that was judged: same
 * device and inode (two empty locks look identical by content alone) and the same bytes (a lock that has
 * since been filled in belongs to a live holder).
 *
 * Returns true when a stale lock was actually removed. A live lock is never displaced: the check runs
 * before anything is removed, and while the claim is held no peer can vacate and re-create the path.
 */
export function takeOverStaleLock(lockPath: string, observed: LockSnapshot): boolean {
  const claim = enterTakeoverClaim(`${lockPath}.takeover`);
  if (claim === null) return false;
  try {
    let current: LockSnapshot | null;
    try {
      current = snapshotLock(lockPath);
    } catch {
      return false; // unreadable now for a new reason: leave it to the next waiter
    }
    if (current === null) return true; // already gone: nothing to remove, and the caller will retry
    if (current.dev !== observed.dev || current.ino !== observed.ino) return false; // replaced: not ours
    if (current.mtimeNs !== observed.mtimeNs || current.size !== observed.size) return false; // re-created
    if (current.raw !== observed.raw) return false; // filled in since the judgement: a live holder
    // The claim can be expired and taken over by another waiter while we were paused. Acting under a claim
    // we no longer hold is exactly how a lock created by that waiter would be deleted.
    if (!stillOwnsClaim(claim)) return false;
    try {
      unlinkSync(lockPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw e;
    }
    return true;
  } finally {
    // Only remove the claim if it is still ours: deleting a peer's live claim would let a third waiter in.
    if (stillOwnsClaim(claim)) {
      try {
        unlinkSync(claim.path);
      } catch {
        /* a claim we cannot remove expires: it is only an age-limited gate */
      }
    }
  }
}

/** True while `lockPath` still holds our token: the takeover above never displaces a live holder. */
function stillOwns(lockPath: string, token: string): boolean {
  try {
    return parseLock(readFileSync(lockPath, "utf8"))?.token === token;
  } catch {
    return false;
  }
}

/** Test seam: the same observation the lock makes before judging a lock stale. */
export function snapshotLockForTest(lockPath: string): LockSnapshot | null {
  return snapshotLock(lockPath);
}

/** This process's start time, cached: it is asked for on every lock record written. */
let ownStartCache: number | null | undefined;
function ownStartMs(): number | undefined {
  if (ownStartCache === undefined) ownStartCache = processStartMs(process.pid);
  return ownStartCache ?? undefined;
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
  const body = JSON.stringify({ pid: process.pid, at: Date.now(), token, startedAt: ownStartMs() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (createLockFile(lockPath, body)) {
      heldLocks.add(lockKey(lockPath));
      return { lockPath, token };
    }
    const observed = snapshotLock(lockPath);
    if (observed === null) continue;
    const holder = parseLock(observed.raw);
    // Ours, and we know it: waiting would only wait for ourselves until the deadline.
    if (holder !== null && holder.pid === process.pid && heldLocks.has(lockKey(lockPath))) {
      throw new Error("账户文件锁已在当前进程内持有，不能重入");
    }
    if (isStale(observed, lockPath)) {
      takeOverStaleLock(lockPath, observed);
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
  if (!stillOwns(lockPath, token)) return; // a lock we no longer hold is not ours to delete
  try {
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
    // The critical section only runs while the file still names us: if a taker could not restore our lock
    // (or one ever did), running anyway is exactly the lost update this lock exists to prevent.
    if (!stillOwns(lockPath, token)) throw new Error("账户文件锁已被其他进程接管，请重试");
    return fn();
  } finally {
    releaseAccountsLock(lockPath, token);
  }
}
