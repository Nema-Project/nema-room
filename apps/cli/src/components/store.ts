// The component store under ~/.nema/runtime/<name>/: one `<lock-hash>/` directory per installed
// version, `current.json` naming the active and previous ones, and the last failed attempt.
import { randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readLock, resolveTarget, shippedLockPath, type PlatformInfo } from "./lock.js";
import { COMPONENT_NAMES, type ComponentName, type ComponentStatus, type FailureReason, type InstallProgress } from "./types.js";

/** Where and against what the component is resolved. Every field defaults to this machine and this program. */
export type ComponentEnv = {
  /** Variables read for mirrors, proxies, CA and the offline switch. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Parent of `<name>/`. Defaults to ~/.nema/runtime, shared by desktop, npm and Compose daemons. */
  runtimeRoot?: string;
  /** The trusted lock. Defaults to the one shipped with this program; tests pass a fixture. */
  lockPath?: string;
  platform?: PlatformInfo;
  /** `components.offline` from the config; NEMA_GRAPHIFY_OFFLINE=1 also turns it on. */
  offline?: boolean;
};

export const LOCK_HASH = /^[a-f0-9]{64}$/;

export const defaultRuntimeRoot = (): string => path.join(os.homedir(), ".nema", "runtime");

export function assertComponent(name: string): asserts name is ComponentName {
  if (!(COMPONENT_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown component: ${name}`);
}

export function componentRoot(name: ComponentName, env: ComponentEnv = {}): string {
  return path.join(env.runtimeRoot ?? defaultRuntimeRoot(), name);
}

export function isOffline(env: ComponentEnv = {}): boolean {
  const raw = (env.env ?? process.env).NEMA_GRAPHIFY_OFFLINE;
  return env.offline === true || (typeof raw === "string" && ["1", "true", "yes"].includes(raw.trim().toLowerCase()));
}

/** Why a download cannot happen while the offline switch is on; shared by the status and the installer. */
export const OFFLINE_DETAIL = "Downloads are turned off (NEMA_GRAPHIFY_OFFLINE or components.offline); import an offline component pack instead";

export function launcherName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "graphify.exe" : "graphify";
}

const REPLACED_DIR = /^([a-f0-9]{64})\.replaced-[a-f0-9]+$/;

/**
 * Whether the component directory's install lock is held by a live installer, in this
 * process or another. The lock is held for the whole install (see installFromSource), so
 * a live owner means an installer may be between the two moves of `activate`.
 */
export function installLockHeldByLiveOwner(root: string): boolean {
  let content: string;
  try {
    content = readFileSync(path.join(root, ".install.lock"), "utf8");
  } catch (error) {
    // Only a missing file proves no installer is running. A permission or I/O error is
    // inconclusive: the store directory may still permit renames, so recovery must not
    // treat the store as free.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : true;
  }
  // The exact tombstone a release writes when it cannot remove its claim: the installer is
  // gone, so recovery must not be stalled by it. It has to be recognized before the PID
  // parse — "released" parses as no pid, which the fallback below reads as a live owner.
  if (content === "released\n") return false;
  const pid = Number(content.split(":")[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) return true; // Unparseable: cannot prove no installer is running.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (probe) {
    return (probe as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The install lock's current token, or null when the lock file is missing or unreadable.
 * Recovery uses it to tell its own lock from another installer's: a live owner other than
 * the caller means an installer is running, while the caller's own token means recovery
 * runs under the lock it already holds.
 */
export function readInstallLockToken(root: string): string | null {
  try {
    const content = readFileSync(path.join(root, ".install.lock"), "utf8").trim();
    return content === "" ? null : content;
  } catch {
    return null;
  }
}

/**
 * The synchronous form of the install lock, for the synchronous recovery path below:
 * claim it (link a temp file onto the lock path — exactly one claimant wins), taking over
 * a dead owner's record with the same pre-rename re-validation and post-rename content
 * check as the async claim, and release only the caller's own token (writing the
 * "released" tombstone through the verified handle when removal fails). Returns null when
 * a live owner holds the lock. Recovery holds the lock while it moves backups, so no
 * installer can take the lock in between and reach activation while recovery restores one.
 */
export function acquireInstallLockSync(root: string): { release: () => void; token: string } | null {
  const file = path.join(root, ".install.lock");
  const token = `${process.pid}:${randomBytes(6).toString("hex")}`;
  const release = (): void => {
    let handle: number;
    try {
      handle = openSync(file, "r+");
    } catch {
      return;
    }
    try {
      let current: string | null = null;
      try {
        current = readFileSync(handle, "utf8");
      } catch {
        current = null;
      }
      if (current !== token) return;
      try {
        rmSync(file, { force: true });
      } catch {
        try {
          ftruncateSync(handle, 0);
          writeSync(handle, "released\n", 0, "utf8");
        } catch {
          // Best effort — release never throws.
        }
      }
    } finally {
      try {
        closeSync(handle);
      } catch {
        // Best effort.
      }
    }
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (linkClaimSync(file, token)) return { release, token };
    const owner = readLockOwnerSync(file);
    if (!owner) continue; // Vanished between the claim attempt and the read; retry the claim.
    const pid = ownerPidSync(owner.content);
    if (pid !== null && (pid === process.pid || pidAliveSync(pid))) return null;
    const stale = takeOverStaleLockSync(file, owner);
    if (!stale) continue; // Lost the rename race, or the record revived; re-loop and re-judge.
    if (linkClaimSync(file, token)) {
      rmSync(stale, { force: true });
      return { release, token };
    }
    rmSync(stale, { force: true });
    return null; // A fresh installer claimed the path in the gap.
  }
  return null;
}

function ownerPidSync(content: string): number | null {
  const pid = Number(content.split(":")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidAliveSync(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (probe) {
    return (probe as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Publish `token` as the lock owner. Returns true when this call won the atomic link. */
function linkClaimSync(file: string, token: string): boolean {
  const temp = `${file}.claim-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, token, { flag: "wx" });
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}

type LockOwnerSync = { content: string; ino: number; mtimeMs: number };

function readLockOwnerSync(file: string): LockOwnerSync | null {
  try {
    const info = lstatSync(file);
    const content = readFileSync(file, "utf8");
    return { content, ino: info.ino, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Move the judged-stale lock aside synchronously, with the same re-validation and
 * non-replacing restore as the async takeover: returns the aside path when the moved
 * record is still the one judged stale, otherwise restores it and returns null.
 *
 * The re-check read and the rename are separate operations, so a live claim can replace
 * the stale record in between and be moved aside by the delayed rename. The restore
 * (a non-replacing link) puts it back — unless a third claim landed in the gap between
 * the rename and the restore, in which case the link fails and the moved record must
 * NOT be deleted: it is the live holder's only copy of its claim, and deleting it would
 * destroy the lock it still holds. The holder detects the displacement via its token
 * check and aborts; the aside file stays as litter (a later cleanup can remove
 * `.stale-*` files whose owners are dead).
 */
export type TakeoverSeams = {
  /** Called after the re-check read, before the rename — a test can pause here. */
  beforeRename?: () => void;
  /** Called after the rename, before the restore-link attempt — a test can pause here. */
  afterRename?: () => void;
};

function takeOverStaleLockSync(file: string, judged: LockOwnerSync, seams: TakeoverSeams = {}): string | null {
  let current: string | null;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = null;
  }
  if (current !== judged.content) return null;
  const stale = `${file}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  seams.beforeRename?.();
  try {
    renameSync(file, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  seams.afterRename?.();
  let content: string | null;
  try {
    content = readFileSync(stale, "utf8");
  } catch {
    content = null;
  }
  if (content === null || content !== judged.content) {
    if (content !== null) {
      const temp = `${file}.claim-${process.pid}-${randomBytes(6).toString("hex")}`;
      writeFileSync(temp, content);
      let restored = false;
      try {
        linkSync(temp, file);
        restored = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        rmSync(temp, { force: true });
      }
      // Only remove the aside file when the restore landed (the same inode is now at
      // the lock path, so the aside name is redundant). When it failed, the aside
      // file is the live holder's only copy of its claim: leave it in place.
      if (restored) rmSync(stale, { force: true });
    }
    // When the moved record could not be read, leave the aside file too: it may be a
    // live claim whose read failed, and deleting it could destroy that holder's lock.
    return null;
  }
  return stale;
}

/**
 * Cross-process tree mutex, held only for the tree's critical sections: an activation's
 * sameTree check through its pointer write, a rollback's removal/restore, and read-path
 * recovery's post-move check and undo. It is a second lock file because the install lock
 * cannot do this job: a successor can displace the install lock (a delayed stale-lock
 * takeover moves the record aside) and then publish, so an ownership re-check alone can
 * never close the gap between the check and the rename-aside — a successor that publishes
 * in that gap has its live tree moved aside, and if the rollback stops before the
 * rename-back, read-path recovery skips the successor's live lock and the pointer dangles.
 * The mutex serializes the publication against the removal instead: a successor's pointer
 * write waits while a rollback holds it, and a rollback's removal waits while a successor
 * is between its sameTree check and its pointer write, so a published tree is never moved
 * and an in-progress reuse is never undone.
 *
 * Ownership is a `<pid>:<random>` token published with the same atomic link as the
 * install lock, with the same stale-takeover protocol for a dead holder. A live holder
 * releases it in milliseconds (the critical sections are a few file operations), so the
 * wait is bounded (5s): the async acquisition throws on timeout, the sync one returns
 * null, and callers treat that as "leave the tree alone" rather than proceeding
 * unprotected. The mutex is never held across a placement move or a download, so a
 * recovery that needs it is never blocked behind an installer waiting for a restore.
 */
const TREE_LOCK_FILE = ".tree.lock";
const TREE_LOCK_TIMEOUT_MS = 5_000;

export type TreeLock = { release: () => void; token: string };

function treeLockFile(root: string): string {
  return path.join(root, TREE_LOCK_FILE);
}

function releaseLockFileSync(file: string, token: string): void {
  let handle: number;
  try {
    handle = openSync(file, "r+");
  } catch {
    return;
  }
  try {
    let current: string | null = null;
    try {
      current = readFileSync(handle, "utf8");
    } catch {
      current = null;
    }
    if (current !== token) return;
    try {
      rmSync(file, { force: true });
    } catch {
      try {
        ftruncateSync(handle, 0);
        writeSync(handle, "released\n", 0, "utf8");
      } catch {
        // Best effort — release never throws.
      }
    }
  } finally {
    try {
      closeSync(handle);
    } catch {
      // Best effort.
    }
  }
}

/** One claim attempt: "won" when the link landed, "live" when a live owner holds it. */
function tryClaimTreeLockSync(file: string, token: string, seams: TakeoverSeams = {}): "won" | "live" {
  if (linkClaimSync(file, token)) return "won";
  const owner = readLockOwnerSync(file);
  if (!owner) return "live"; // Vanished between the claim attempt and the read; retry.
  const pid = ownerPidSync(owner.content);
  if (pid !== null && (pid === process.pid || pidAliveSync(pid))) return "live";
  const stale = takeOverStaleLockSync(file, owner, seams);
  if (!stale) return "live"; // Lost the rename race, or the record revived; retry.
  if (linkClaimSync(file, token)) {
    rmSync(stale, { force: true });
    return "won";
  }
  return "live";
}

const treeLockWaitCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Acquire the tree mutex synchronously, waiting up to `timeoutMs` for a live holder.
 * Returns null on timeout: the caller leaves the tree alone instead of proceeding
 * unprotected. The wait blocks this thread, so callers hold it only briefly.
 */
export function acquireTreeLockSync(root: string, timeoutMs = TREE_LOCK_TIMEOUT_MS, seams: TakeoverSeams = {}): TreeLock | null {
  const file = treeLockFile(root);
  const token = `${process.pid}:${randomBytes(6).toString("hex")}`;
  const release = (): void => releaseLockFileSync(file, token);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryClaimTreeLockSync(file, token, seams) === "won") return { release, token };
    if (Date.now() >= deadline) return null;
    Atomics.wait(treeLockWaitCell, 0, 0, 10);
  }
}

/** The tree mutex's current token, or null when the file is missing or unreadable. */
export function readTreeLockToken(root: string): string | null {
  try {
    const content = readFileSync(treeLockFile(root), "utf8").trim();
    return content === "" ? null : content;
  } catch {
    return null;
  }
}

/**
 * Acquire the tree mutex, waiting up to `timeoutMs` for a live holder. Throws on
 * timeout: the caller fails the install rather than proceeding unprotected.
 */
export async function acquireTreeLock(root: string, timeoutMs = TREE_LOCK_TIMEOUT_MS): Promise<TreeLock> {
  const file = treeLockFile(root);
  const token = `${process.pid}:${randomBytes(6).toString("hex")}`;
  const release = (): void => releaseLockFileSync(file, token);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryClaimTreeLockSync(file, token) === "won") return { release, token };
    if (Date.now() >= deadline) throw new Error(`Timed out acquiring the component tree lock in ${root}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Undo a replacement cut off midway (a crash between moving the old directory aside and
 * publishing its replacement): a backup whose `<lock-hash>` is gone goes back into place;
 * a backup beside a present `<lock-hash>` is stale (that directory is the self-checked
 * replacement) and is removed. Best effort and synchronous, so every reader — status,
 * bin resolution, install — heals the store before answering instead of reporting the
 * component missing until the next install happens to run.
 *
 * Recovery is skipped while a live installer holds the install lock: the installer owns
 * the backups between its two moves, and a reader restoring or deleting one would break
 * its rollback. A lock whose owner is dead means the installer is gone, so recovery
 * proceeds; a missing or dead lock is the crash case this exists for. When the caller
 * already holds the lock (`ownToken`), recovery runs under it instead of skipping itself:
 * the installer that owns the backups is the one healing them, and no other installer can
 * take the lock in between. Every other caller claims the lock synchronously here — the
 * read path cannot await the async lock — and releases it when the recovery is done, so a
 * recovery that pauses after its final check still holds the lock while it moves a backup
 * and no installer can take the lock in between and reach activation. The lock is
 * re-checked immediately before each move, so a claim that lands after the listing still
 * stops the move.
 */
export function recoverReplacementsSync(root: string, opts: { ownToken?: string; beforeMove?: () => void; afterCheck?: () => void; afterMove?: () => void; afterUndo?: () => void } = {}): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const backups = names.filter((name) => REPLACED_DIR.test(name));
  if (backups.length === 0) return;
  // Claim the lock, or recognize the caller's own: a live owner other than the caller
  // means an installer is running — skip, and let it heal the store itself.
  let held: { release: () => void; token: string } | null = null;
  let myToken: string | undefined = opts.ownToken;
  if (readInstallLockToken(root) !== opts.ownToken && installLockHeldByLiveOwner(root)) return;
  if (opts.ownToken === undefined) {
    held = acquireInstallLockSync(root);
    if (!held) return;
    myToken = held.token;
  }
  try {
    for (const name of backups) {
      const match = REPLACED_DIR.exec(name);
      if (!match) continue;
      const original = path.join(root, match[1]!);
      try {
        // Re-check immediately before moving: an installer can claim the lock after the
        // listing (taking over a tombstone) and own the backup by the time this runs.
        // Moving it back would occupy the path its activation is about to place staging at.
        opts.beforeMove?.();
        if (installLockHeldByLiveOwner(root) && readInstallLockToken(root) !== myToken) return;
        opts.afterCheck?.();
        if (existsSync(original)) {
          rmSync(path.join(root, name), { recursive: true, force: true });
          if (readInstallLockToken(root) !== myToken) return;
        } else {
          const backupPath = path.join(root, name);
          const backupStat = lstatSync(backupPath);
          const pointerBefore = statSync(path.join(root, "current.json"), { throwIfNoEntry: false });
          renameSync(backupPath, original);
          // Test seam: a test can pause here, between the restore move and the
          // post-move token re-check, and let another installer displace this
          // recovery's lock and claim the gap while the restored tree is in place.
          opts.afterMove?.();
          // The lock can still be displaced between the re-check and the move: a delayed
          // takeover's rename landing late moves this recovery's lock aside, and a third
          // installer claims the gap. If the token at the path is no longer this
          // recovery's, the restore landed inside that installer's activation window —
          // undo it (the tree at the destination is still the backup tree; its inode
          // proves it, and a placement against the occupied path would have failed) and
          // stop: the backup is this recovery's to restore only while it holds the lock.
          // One exception: if the installer reused the restored tree and published it,
          // the destination still holds the backup tree by inode — but it is now a live
          // runtime, and the undo would move it away from under the pointer. The pointer
          // file is replaced on every write, so a changed inode or mtime after the
          // restore, with the pointer still naming this version, means it was published.
          //
          // A second exception the pointer check cannot see: a successor between its
          // sameTree check and its pointer write. Its staging is already deleted and it
          // is about to publish the restored tree, but the pointer has not changed yet —
          // so the undo would move the tree out from under the install that is about to
          // commit it. The tree mutex closes that interval: the successor holds it from
          // its sameTree check through its pointer write, and this post-move check waits
          // for it before deciding. If the mutex cannot be acquired, skip the undo: the
          // restored tree stays in place, which is the safe direction — a later recovery
          // or install sorts out a tree that was never published.
          if (readInstallLockToken(root) !== myToken) {
            const treeLock = acquireTreeLockSync(root);
            if (!treeLock) continue;
            try {
              // The mutex claim itself can be displaced by a delayed stale-lock
              // takeover (its record moved aside, a third claim landing before the
              // restore): if this recovery's token is no longer at the path, another
              // installer may be publishing — skip the undo and stop, leaving the
              // restored tree in place.
              if (readTreeLockToken(root) !== treeLock.token) return;
              let placed: ReturnType<typeof lstatSync> | null = null;
            try {
              placed = lstatSync(original);
            } catch {
              placed = null;
            }
            const pointerAfter = statSync(path.join(root, "current.json"), { throwIfNoEntry: false });
            const pointerChanged =
              pointerAfter !== undefined &&
              (pointerBefore === undefined || pointerAfter.ino !== pointerBefore.ino || pointerAfter.mtimeMs !== pointerBefore.mtimeMs);
            const republished = pointerChanged && readPointer(root).active === match[1];
            if (!republished && placed && placed.dev === backupStat.dev && placed.ino === backupStat.ino) renameSync(original, backupPath);
            // Test seam: a test can pause here, after the undo decision and while
            // this recovery still holds the tree mutex, and let another installer
            // attempt a takeover in the gap.
            opts.afterUndo?.();
            return;
            } finally {
              treeLock.release();
            }
          }
        }
      } catch {
        // A later read or install runs the same recovery.
      }
    }
  } finally {
    held?.release();
  }
}

export type Pointer = { active: string | null; previous: string | null };

/** `current.json`. Missing or unreadable means nothing is active: a damaged pointer never activates a directory. */
export function readPointer(root: string): Pointer {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "current.json"), "utf8")) as Partial<Pointer> | null;
    const valid = (value: unknown) => (typeof value === "string" && LOCK_HASH.test(value) ? value : null);
    return { active: valid(raw?.active), previous: valid(raw?.previous) };
  } catch {
    return { active: null, previous: null };
  }
}

/** Write a sibling temp file, then rename it over `path`: readers see the old or the new file, never half of one.
 * The write is a compare-and-swap on the target's identity: the target's inode and
 * mtime are captured before the temp write, and re-checked before the rename, so a
 * successor that republished the target in between is caught and the write is refused
 * instead of overwriting it. This detects a publication directly — not only through
 * the locks — so it also catches a writer that published without displacing this
 * attempt's locks. `beforeRename` is synchronous and runs immediately before the
 * rename, in the same block: no await separates the guard from the rename, so no
 * interleaving can be orchestrated between them — a guard that throws aborts the write
 * (the temp file is removed by the finally). A caller that needs an asynchronous check
 * runs it before calling this function. `renameSeam` is a pre-rename seam: a test can
 * pause there, after the guard, to let another installer publish. The guard and the
 * identity check run again after the seam, before the real rename. `finalSeam` is a
 * second pre-rename seam, after that re-check: a test can pause there, after the final
 * guard, to let another installer publish, and the guard and the identity check run
 * once more after it, before the rename. After that last check, the rename runs in the
 * same block — there is no seam left to pause on, so a displacement landing in that
 * final step cannot be orchestrated; the post-write re-check in the caller stays as
 * defense in depth for it. The seams must not rename themselves; the production code
 * renames after they return. */
export async function writeFileAtomic(
  file: string,
  body: string,
  beforeRename?: () => void,
  renameSeam?: (from: string, to: string) => Promise<void>,
  finalSeam?: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const identity = (path: string): string | null => {
    const info = statSync(path, { throwIfNoEntry: false });
    return info === undefined ? null : `${info.ino}:${info.mtimeMs}`;
  };
  const before = identity(file);
  const check = (): void => {
    beforeRename?.();
    if (identity(file) !== before) {
      throw new Error(`The target changed while writing ${file}; refusing to overwrite it`);
    }
  };
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, body, { flag: "wx" });
    check();
    await renameSeam?.(temp, file);
    check();
    await finalSeam?.(temp, file);
    check();
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function writePointer(
  root: string,
  pointer: Pointer,
  beforeRename?: () => void,
  renameSeam?: (from: string, to: string) => Promise<void>,
  finalSeam?: (from: string, to: string) => Promise<void>,
): Promise<void> {
  await writeFileAtomic(path.join(root, "current.json"), `${JSON.stringify(pointer, null, 2)}\n`, beforeRename, renameSeam, finalSeam);
}

/**
 * How many installs have committed in this store, or null when no install has committed yet.
 * A same-version repair rewrites the pointer with identical content, so the pointer alone
 * cannot tell "repaired since you looked" from "untouched"; this counter can. It is claimed
 * under the install lock before activation, so it advances whenever an install starts — not
 * only when one commits — and a refusal can tell an intervening attempt happened even when
 * that attempt failed.
 *
 * Only a missing counter reads as uninitialized. An existing counter that cannot be read or
 * validated throws: treating it as 0 could let a later claim rewrite the generation a repair
 * already used, and callers comparing generations would see "unchanged" after a commit.
 */
export function readInstallGeneration(root: string): number | null {
  const file = path.join(root, "install-generation");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const text = raw.trim();
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== text) {
    throw new Error(`Invalid install generation in ${file}: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Records a new generation under the install lock, before activation. The value is strictly
 * increasing across successful claims, so it can never be reused by a later attempt — the
 * case that let a delayed refusal write a stale failure after a failed update and a repair.
 * If the counter cannot be read or written, the claim throws and the caller aborts the
 * attempt before touching the store.
 *
 * A counter missing from a store with an active copy (its file was lost, never removed by
 * this code) reseeds from a high-water file this claim maintains on every successful claim:
 * the reseed is one past the highest generation ever claimed, so two losses can never
 * restore the same value. A random 48-bit draw is only the last resort when the high-water
 * file is gone too. A store with no active copy starts at 1 as before.
 *
 * The high-water file is written first: a claim that fails after it still leaves the
 * high-water ahead of the counter, so a later reseed cannot reuse the failed claim's
 * generation. Writing the counter first would let a failed high-water write leave a counter
 * a later reseed could repeat.
 */
/**
 * Claim the generation this attempt will commit under, or throw when it cannot be
 * recorded. The high-water file is written first: a claim that fails after it still
 * leaves the high-water ahead of the counter, so a later reseed cannot reuse the failed
 * claim's generation, and a high-water write failure aborts the attempt before the
 * counter is touched. `write` is the file writer (tests fail the counter write through
 * it to exercise a real partial claim); it defaults to the atomic writer.
 */
export async function claimInstallGeneration(
  root: string,
  write: (file: string, body: string) => Promise<void> = writeFileAtomic,
): Promise<number> {
  const current = readInstallGeneration(root);
  const base = current ?? (readPointer(root).active === null ? 0 : (readInstallGenerationHighWater(root) ?? randomInt(2, 2 ** 48)));
  const next = base + 1;
  await write(path.join(root, "install-generation-high-water"), `${next}\n`);
  await write(path.join(root, "install-generation"), `${next}\n`);
  return next;
}

/** The highest generation ever claimed in this store, or null when no claim recorded one. */
function readInstallGenerationHighWater(root: string): number | null {
  try {
    const text = readFileSync(path.join(root, "install-generation-high-water"), "utf8").trim();
    const parsed = Number.parseInt(text, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== text) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type FailureRecord = { lockHash: string; reason: FailureReason; detail: string; at: string; revision?: string };

export function readFailure(root: string): FailureRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "last-failure.json"), "utf8")) as Partial<FailureRecord> | null;
    if (!raw || typeof raw.lockHash !== "string" || typeof raw.reason !== "string" || typeof raw.detail !== "string" || typeof raw.at !== "string") return null;
    return raw as FailureRecord;
  } catch {
    return null;
  }
}

/**
 * Records the last failed attempt. Every record carries a fresh revision, so two records
 * with identical lock, reason, detail and timestamp are still distinguishable: a refusal
 * that snapshots the record can tell a rewrite apart from the record it read, even when
 * the newer attempt's generation claim failed and the generation is unchanged.
 */
export async function writeFailure(root: string, record: FailureRecord): Promise<void> {
  await writeFileAtomic(path.join(root, "last-failure.json"), `${JSON.stringify({ ...record, revision: randomBytes(8).toString("hex") }, null, 2)}\n`);
}

export async function clearFailure(root: string): Promise<void> {
  await rm(path.join(root, "last-failure.json"), { force: true });
}

const installing = new Map<string, { lockHash: string; progress: InstallProgress }>();

/** Progress of an install running in this process, keyed by component root. */
export function setInstalling(root: string, lockHash: string, progress: InstallProgress | null): void {
  if (progress) installing.set(root, { lockHash, progress: { ...progress } });
  else installing.delete(root);
}

function regularFile(file: string): boolean {
  try {
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The launcher of the active version when that version's lock-hash is the current lock's; otherwise null.
 * A version installed for another lock is never returned.
 */
export function componentBin(name: string, env: ComponentEnv = {}): string | null {
  assertComponent(name);
  try {
    const resolved = resolveTarget(readLock(env.lockPath ?? shippedLockPath()), env.platform);
    if (!resolved.ok) return null;
    const root = componentRoot(name, env);
    recoverReplacementsSync(root);
    if (readPointer(root).active !== resolved.lockHash) return null;
    const launcher = path.join(root, resolved.lockHash, launcherName(env.platform?.platform ?? process.platform));
    return regularFile(launcher) ? launcher : null;
  } catch {
    return null;
  }
}

/** Synchronous status; `componentStatus` is the public async form. Throws only when the shipped lock is unreadable. */
export function componentStatusSync(name: ComponentName = "graphify", env: ComponentEnv = {}): ComponentStatus {
  assertComponent(name);
  const lock = readLock(env.lockPath ?? shippedLockPath());
  const resolved = resolveTarget(lock, env.platform);
  if (!resolved.ok) {
    return { state: "failed", name, lockHash: null, reason: "unsupported-platform", detail: resolved.detail, at: null };
  }
  const root = componentRoot(name, env);
  recoverReplacementsSync(root);
  const running = installing.get(root);
  if (running && running.lockHash === resolved.lockHash) return { state: "installing", name, lockHash: resolved.lockHash, progress: { ...running.progress } };
  const pointer = readPointer(root);
  const launcher = path.join(root, resolved.lockHash, launcherName(env.platform?.platform ?? process.platform));
  if (pointer.active === resolved.lockHash && regularFile(launcher)) {
    // The installed copy serves, but a repair attempt for this same version may have failed after it:
    // carry that failure so callers can show it instead of reporting the repair as a success.
    const failure = readFailure(root);
    return {
      state: "installed",
      name,
      lockHash: resolved.lockHash,
      version: { graphifyy: lock.graphifyy, python: lock.python },
      path: path.join(root, resolved.lockHash),
      launcher,
      ...(failure && failure.lockHash === resolved.lockHash ? { lastFailure: { reason: failure.reason, detail: failure.detail, at: failure.at } } : {}),
    };
  }
  const stale = pointer.active && pointer.active !== resolved.lockHash ? pointer.active : undefined;
  const failure = readFailure(root);
  if (failure && failure.lockHash === resolved.lockHash) {
    return { state: "failed", name, lockHash: resolved.lockHash, reason: failure.reason, detail: failure.detail, at: failure.at, ...(stale ? { installedLockHash: stale } : {}) };
  }
  if (isOffline(env)) {
    return {
      state: "failed",
      name,
      lockHash: resolved.lockHash,
      reason: "offline",
      detail: OFFLINE_DETAIL,
      at: null,
      ...(stale ? { installedLockHash: stale } : {}),
    };
  }
  if (stale) return { state: "lock-mismatch", name, lockHash: resolved.lockHash, installedLockHash: stale };
  return { state: "not-installed", name, lockHash: resolved.lockHash };
}

export async function componentStatus(env: ComponentEnv = {}, name: ComponentName = "graphify"): Promise<ComponentStatus> {
  return componentStatusSync(name, env);
}
