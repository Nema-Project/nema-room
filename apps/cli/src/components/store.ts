// The component store under ~/.nema/runtime/<name>/: one `<lock-hash>/` directory per installed
// version, `current.json` naming the active and previous ones, and the last failed attempt.
import { randomBytes } from "node:crypto";
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

export function launcherName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "graphify.exe" : "graphify";
}

const REPLACED_DIR = /^([a-f0-9]{64})\.replaced-[a-f0-9]+$/;

/**
 * Undo a replacement cut off midway (a crash between moving the old directory aside and
 * publishing its replacement): a backup whose `<lock-hash>` is gone goes back into place;
 * a backup beside a present `<lock-hash>` is stale (that directory is the self-checked
 * replacement) and is removed. Best effort and synchronous, so every reader — status,
 * bin resolution, install — heals the store before answering instead of reporting the
 * component missing until the next install happens to run.
 */
export function recoverReplacementsSync(root: string): void {
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

export type FailureRecord = { lockHash: string; reason: FailureReason; detail: string; at: string };

export function readFailure(root: string): FailureRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, "last-failure.json"), "utf8")) as Partial<FailureRecord> | null;
    if (!raw || typeof raw.lockHash !== "string" || typeof raw.reason !== "string" || typeof raw.detail !== "string" || typeof raw.at !== "string") return null;
    return raw as FailureRecord;
  } catch {
    return null;
  }
}

export async function writeFailure(root: string, record: FailureRecord): Promise<void> {
  await writeFileAtomic(path.join(root, "last-failure.json"), `${JSON.stringify(record, null, 2)}\n`);
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
    return {
      state: "installed",
      name,
      lockHash: resolved.lockHash,
      version: { graphifyy: lock.graphifyy, python: lock.python },
      path: path.join(root, resolved.lockHash),
      launcher,
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
      detail: "Downloads are turned off (NEMA_GRAPHIFY_OFFLINE or components.offline); import an offline component pack instead",
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
