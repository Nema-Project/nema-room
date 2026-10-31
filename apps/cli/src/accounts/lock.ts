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
 *
 * Liveness is never relaxed to make a lock reclaimable sooner. A holder record names a pid and the process
 * start time that belonged to it, and the record counts as live while that pid is alive and its start time
 * is either the same or *cannot be checked*: on platforms that do not expose a start time (Windows) the
 * answer is "unknown", and treating unknown as "dead" is what let a live holder's lock be taken over.
 * "Unknown" therefore falls back to an age rule (`LOCK_MAX_UNVERIFIED_AGE_MS`), which is slow but never
 * lets two writers into the critical section.
 *
 * The claim follows the same rule, for the same reason: a taker that is alive and whose start time can be
 * verified keeps its claim however old the claim file is, because expiring it by age is what lets a second
 * waiter act on a judgement made against a lock that has since been replaced — and then delete a lock
 * somebody else just created. A claim is expired only when its holder is gone, or when the holder's start
 * time is verifiably different (a recycled pid), or when there is no way to check and the file is old.
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

/** How the platform answered "is the live pid that wrote a holder record this process or another one". */
export type ProcessStartComparison = "same" | "different" | "unknown";

/**
 * Whether the process currently running as `pid` is the one that wrote a holder record: a reused pid
 * belongs to a process started later than the record.
 *
 * The start time comes from the platform's own bookkeeping (`/proc/<pid>/stat` on Linux, `ps -o lstart` on
 * macOS). Where it cannot be read (Windows) the answer is `"unknown"`, not "different": the caller must not
 * treat a holder it cannot check as one that died, or a live holder's lock is reclaimed underneath it.
 */
export function compareProcessStart(pid: number, startedAt: number): ProcessStartComparison {
  const actual = processStartMs(pid);
  if (actual === null) return "unknown";
  // Whole-second resolution on most platforms; allow for that and for clock rounding.
  return Math.abs(actual - startedAt) < 2_000 ? "same" : "different";
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
function isStale(snapshot: LockSnapshot, lockPath: string, probes: LockProbes = {}): boolean {
  const alive = probes.alive ?? pidAlive;
  const startComparison = probes.startedAt ?? compareProcessStart;
  const holder = parseLock(snapshot.raw);
  if (holder === null) return (ageMs(lockPath) ?? 0) >= LOCK_PARTIAL_STALE_MS;
  if (holder.pid === process.pid) return !heldLocks.has(lockKey(lockPath)); // an earlier process with our pid
  if (!alive(holder.pid)) return true;
  if (holder.startedAt !== undefined) {
    const verdict = startComparison(holder.pid, holder.startedAt);
    if (verdict === "same") return false; // the very process that wrote the record is running
    if (verdict === "different") return true; // a recycled pid: the writer is gone
    // The platform cannot tell which process has this pid. A live holder must never be mistaken for a dead
    // one, so only age decides — and the age rule is long enough that no live critical section reaches it.
  }
  return Date.now() - holder.at >= LOCK_MAX_UNVERIFIED_AGE_MS;
}

/**
 * The platform answers `isStale` needs, injectable so a test can ask about a machine that cannot report
 * process start times (Windows) without changing what the production path uses. Nothing global is mutated.
 */
export type LockProbes = {
  alive?: (pid: number) => boolean;
  startedAt?: (pid: number, startedAt: number) => ProcessStartComparison;
};

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
        // `startedAt` is what lets a later waiter tell this claim from one left behind by an older process
        // that happened to get the same pid. It is omitted when the platform cannot report it.
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token, startedAt: ownStartMs() }));
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

/**
 * True when the claim may be taken from its owner.
 *
 * The owner is the only waiter allowed to act on a stale judgement, so expiring a claim that a live waiter
 * still holds is what lets a second waiter delete a lock the first one has not yet seen replaced. Age is
 * therefore only the fallback for a claim whose owner cannot be checked: a claim is expired when its holder
 * has exited, when the holder's start time is verifiably different (a recycled pid), or when there is no
 * start time to check and the file is old enough that a working taker cannot be inside it.
 */
function claimIsStale(claimPath: string, probes: LockProbes = {}): boolean {
  const alive = probes.alive ?? pidAlive;
  const startComparison = probes.startedAt ?? compareProcessStart;
  let holder: LockHolder | null;
  try {
    holder = parseLock(readFileSync(claimPath, "utf8"));
  } catch {
    // Gone, or never written: there is no owner to protect, and an unreadable claim is only a gate.
    return (ageMs(claimPath) ?? 0) >= LOCK_CLAIM_STALE_MS;
  }
  if (holder === null) return (ageMs(claimPath) ?? 0) >= LOCK_CLAIM_STALE_MS;
  // A claim whose process is gone is abandoned no matter how young it is.
  if (!alive(holder.pid)) return true;
  if (holder.startedAt !== undefined) {
    const verdict = startComparison(holder.pid, holder.startedAt);
    // Only a *verified* mismatch expires the claim. "Unknown" (Windows cannot report a process start time)
    // must not: the owner may well be alive and about to remove a lock, and expiring its claim is what lets a
    // second waiter act on a judgement made against a lock that has since been replaced.
    if (verdict === "different") return true;
    if (verdict === "same") return false;
  }
  // Written by a build that had no start time, by a platform that cannot report one, or with an answer this
  // machine could not settle: age decides, and the limit is long enough that no live taker reaches it.
  return (ageMs(claimPath) ?? 0) >= LOCK_CLAIM_STALE_MS;
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
 * Returns true when a stale lock was actually removed. A live lock is never displaced: the comparison runs
 * twice — once when the claim is entered and once immediately before the removal — and while the claim is
 * held no peer can vacate and re-create the path.
 */
function sameLockAsJudged(current: LockSnapshot, observed: LockSnapshot): boolean {
  // Device and inode: two empty locks look identical by content alone. Timestamp and size: a re-created file
  // is a new file even when its number and its bytes happen to match. Raw bytes: a lock filled in since the
  // judgement belongs to a live holder.
  return (
    current.dev === observed.dev &&
    current.ino === observed.ino &&
    current.mtimeNs === observed.mtimeNs &&
    current.size === observed.size &&
    current.raw === observed.raw
  );
}

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
    if (!sameLockAsJudged(current, observed)) return false; // replaced: not ours to remove
    // The claim can be expired and taken over by another waiter while we were paused. Acting under a claim
    // we no longer hold is exactly how a lock created by that waiter would be deleted.
    if (!stillOwnsClaim(claim)) return false;
    // Everything above can be interrupted (a stopped process, a suspended laptop), and a lock that changed
    // identity or content meanwhile belongs to a live holder. The comparison is therefore repeated as the
    // last thing before the removal, so what gets deleted is the file that was judged, not the path name.
    let final: LockSnapshot | null;
    try {
      final = snapshotLock(lockPath);
    } catch {
      return false;
    }
    if (final === null) return true;
    if (!sameLockAsJudged(final, observed)) return false;
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

/**
 * Test seam: the stale decision with the platform's answers injected, so a test can describe a machine whose
 * process start times cannot be read. Production reaches `isStale` through `acquireAccountsLock`, which
 * passes no probes and therefore uses the real ones.
 */
export function isStaleForTest(snapshot: LockSnapshot, lockPath: string, probes: LockProbes): boolean {
  return isStale(snapshot, lockPath, probes);
}

/**
 * Test seam: the claim's stale decision with the platform's answers injected. `claimIsStale` runs inside a
 * takeover, so this is the only way to ask it about a machine whose process start times cannot be read
 * without replacing the real platform answers for the whole module.
 */
export function claimIsStaleForTest(claimPath: string, probes: LockProbes): boolean {
  return claimIsStale(claimPath, probes);
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
