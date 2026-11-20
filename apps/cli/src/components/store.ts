// The component store under ~/.nema/runtime/<name>/: one `<lock-hash>/` directory per installed
// version, `current.json` naming the active and previous ones, and the last failed attempt.
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
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
 * take the lock in between. The lock is re-checked immediately before each move, so a
 * claim that lands after the listing still stops the move — but that check alone does not
 * serialize recovery with activation across processes: a recovery that pauses after it can
 * still resume into another installer's activation. Callers that hold the lock must pass
 * their token; callers that do not hold it keep the re-check as their only guard.
 */
export function recoverReplacementsSync(root: string, opts: { ownToken?: string; beforeMove?: () => void } = {}): void {
  if (installLockHeldByLiveOwner(root) && readInstallLockToken(root) !== opts.ownToken) return;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const match = REPLACED_DIR.exec(name);
    if (!match) continue;
    const original = path.join(root, match[1]!);
    try {
      // Re-check immediately before moving: an installer can claim the lock after the
      // listing (taking over a tombstone) and own the backup by the time this runs.
      // Moving it back would occupy the path its activation is about to place staging at.
      opts.beforeMove?.();
      if (installLockHeldByLiveOwner(root) && readInstallLockToken(root) !== opts.ownToken) return;
      if (existsSync(original)) rmSync(path.join(root, name), { recursive: true, force: true });
      else renameSync(path.join(root, name), original);
    } catch {
      // A later read or install runs the same recovery.
    }
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

/** Write a sibling temp file, then rename it over `path`: readers see the old or the new file, never half of one. */
export async function writeFileAtomic(file: string, body: string): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, body, { flag: "wx" });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function writePointer(root: string, pointer: Pointer): Promise<void> {
  await writeFileAtomic(path.join(root, "current.json"), `${JSON.stringify(pointer, null, 2)}\n`);
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
export async function claimInstallGeneration(root: string): Promise<number> {
  const current = readInstallGeneration(root);
  const base = current ?? (readPointer(root).active === null ? 0 : (readInstallGenerationHighWater(root) ?? randomInt(2, 2 ** 48)));
  const next = base + 1;
  await writeFileAtomic(path.join(root, "install-generation-high-water"), `${next}\n`);
  await writeFileAtomic(path.join(root, "install-generation"), `${next}\n`);
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
