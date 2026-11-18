// Installs a component from archives pinned by the shipped lock:
//   download (or, later, an offline pack) -> <lock-hash>.staging/.archives
//   -> every archive checked against the lock's sha256 and size, the set exactly the lock's
//   -> assembled into <lock-hash>.staging -> self-check -> moved to <lock-hash> -> current.json
// A directory that has not passed all of that is never named active. An existing <lock-hash> directory
// is compared file by file with the fresh staging tree before anything in it may be reused, and is
// never executed; the directory current.json points at is only removed once its replacement is in place.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { windowsRuntimeEnv } from "../platform.js";
import { extractTarGz, extractZip } from "./archive.js";
import { downloadWithRetry, sourceUrl, sourceUrls } from "./download.js";
import { readLock, resolveTarget, shippedLockPath, shippedWindowsLauncherPath, type LockFile, type LockTarget, type PlatformInfo } from "./lock.js";
import {
  assertComponent,
  clearFailure,
  componentRoot,
  componentStatusSync,
  isOffline,
  launcherName,
  LOCK_HASH,
  readPointer,
  setInstalling,
  writeFailure,
  writePointer,
  type ComponentEnv,
  type Pointer,
} from "./store.js";
import { ComponentInstallError, type ComponentName, type ComponentStatus, type FailureReason, type InstallProgress } from "./types.js";

/** Same text as POSIX_GRAPHIFY_LAUNCHER in scripts/desktop/fetch-graphify.mjs; a test keeps them equal. */
export const POSIX_LAUNCHER = `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec "$root/python/bin/python3.11" -m graphify "$@"
`;

/**
 * Unpacked size estimate: the lock pins only archive sizes. CPython install_only tarballs and the wheels
 * here expand to roughly three times their download size, so an install needs the download plus 3x free.
 */
export const EXTRACT_RATIO = 3;

export type InstallOffer = {
  name: ComponentName;
  lockHash: string;
  /** Sum of the lock's sizes for this platform: what the download costs. */
  totalBytes: number;
  /** The component directory, e.g. ~/.nema/runtime/graphify. */
  location: string;
  /** Hosts the download contacts, after mirror variables. */
  hosts: string[];
};

/** Seams for tests and for the offline importer; production leaves them unset. */
export type InstallHooks = {
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
  freeBytes?: (dir: string) => Promise<number>;
  /** Runs the staged launcher and returns its version text. */
  selfCheck?: (launcher: string) => Promise<string>;
  rename?: (from: string, to: string) => Promise<void>;
  writePointer?: (root: string, pointer: Pointer) => Promise<void>;
  /** The prebuilt Windows launcher shipped with the program. */
  windowsLauncher?: string;
};

export type InstallOptions = {
  /** Asked once the platform and offline checks pass and before any download; false leaves everything as it was. */
  confirm?: (offer: InstallOffer) => boolean | Promise<boolean>;
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
  env?: ComponentEnv;
  hooks?: InstallHooks;
  /** Run even when the current lock's version is already active: a repair that re-checks it against fresh archives. */
  force?: boolean;
};

/** Puts the archives of `target` into `archivesDir`. Whatever it writes is verified against the lock afterwards. */
export type ArchiveSource = (o: {
  archivesDir: string;
  target: LockTarget;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  hooks: InstallHooks;
  progress: (update: Partial<InstallProgress>) => void;
  addBytes: (bytes: number) => void;
}) => Promise<void>;

function abortError(): Error {
  const error = new Error("Install cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const lockEntries = (target: LockTarget): Array<{ entry: LockFile; kind: "python" | "wheel" }> => [
  { entry: target.python, kind: "python" },
  ...target.wheels.map((entry) => ({ entry, kind: "wheel" as const })),
];

/** The online source: each pinned URL (or its mirror), checked against the lock as it arrives. */
export const downloadArchives: ArchiveSource = async ({ archivesDir, target, env, signal, hooks, progress, addBytes }) => {
  for (const { entry, kind } of lockEntries(target)) {
    throwIfAborted(signal);
    progress({ phase: "download", file: entry.file });
    const got = await downloadWithRetry(sourceUrl(entry, kind, env), path.join(archivesDir, entry.file), {
      env,
      signal,
      timeoutMs: hooks.timeoutMs,
      delaysMs: hooks.retryDelaysMs,
      maxBytes: entry.size,
      onBytes: addBytes,
      onRestart: (lost) => addBytes(-lost),
    });
    if (got.size !== entry.size || got.sha256 !== entry.sha256) {
      throw new ComponentInstallError("hash-mismatch", `${entry.file} does not match the lock (sha256 or size differs)`);
    }
  }
};

/** Every archive the lock names, and nothing else, with the pinned sha256 and size. Run before any extraction. */
export async function verifyArchives(archivesDir: string, target: LockTarget, onFile?: (file: string) => void): Promise<void> {
  const expected = lockEntries(target).map(({ entry }) => entry);
  const present = (await readdir(archivesDir)).sort();
  const wanted = expected.map((entry) => entry.file).sort();
  const extra = present.filter((name) => !wanted.includes(name));
  const missing = wanted.filter((name) => !present.includes(name));
  if (extra.length || missing.length) {
    throw new ComponentInstallError("hash-mismatch", `Archives differ from the lock (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`);
  }
  for (const entry of expected) {
    onFile?.(entry.file);
    const file = path.join(archivesDir, entry.file);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new ComponentInstallError("hash-mismatch", `${entry.file} is not a regular file`);
    if (info.size !== entry.size) throw new ComponentInstallError("hash-mismatch", `${entry.file} is ${info.size} bytes, the lock says ${entry.size}`);
    if ((await sha256File(file)) !== entry.sha256) throw new ComponentInstallError("hash-mismatch", `${entry.file} does not match the lock's sha256`);
  }
}

const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

/** Replace in-tree file symlinks with copies; the component stays relocatable and link-free. */
async function materializeSymlinks(root: string): Promise<void> {
  async function resolveLink(linkPath: string): Promise<string> {
    let current = linkPath;
    for (let hop = 0; hop < 8; hop++) {
      if (!(await lstat(current)).isSymbolicLink()) return current;
      const link = await readlink(current);
      if (!link || path.isAbsolute(link) || link.includes("\\") || /^[A-Za-z]:/.test(link)) throw new Error(`Unsafe archive symlink: ${current}`);
      const next = path.resolve(path.dirname(current), link);
      if (!inside(root, next)) throw new Error(`Archive symlink escapes the component: ${current}`);
      current = next;
    }
    throw new Error(`Archive symlink chain is too long: ${linkPath}`);
  }
  async function walk(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
      const current = path.join(dir, name);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        const target = await resolveLink(current);
        const targetInfo = await lstat(target);
        if (targetInfo.isDirectory()) throw new Error(`Archive directory symlink is not supported: ${current}`);
        await rm(current);
        await copyFile(target, current);
        if (process.platform !== "win32") await chmod(current, targetInfo.mode & 0o777);
      } else if (info.isDirectory()) await walk(current);
      else if (!info.isFile()) throw new Error(`Archive contains an unsupported entry: ${current}`);
    }
  }
  await walk(root);
}

/** python/python3 that are byte copies of python3.11 are dropped, as the desktop build does. */
async function dedupePython(pythonRoot: string): Promise<void> {
  const canonical = path.join(pythonRoot, "bin", "python3.11");
  const bytes = await readFile(canonical).catch(() => null);
  if (!bytes) return;
  for (const name of ["python", "python3"]) {
    const file = path.join(pythonRoot, "bin", name);
    const other = await readFile(file).catch(() => null);
    if (other && other.equals(bytes)) await rm(file);
  }
}

async function sitePackages(pythonRoot: string, platform: NodeJS.Platform): Promise<string> {
  if (platform === "win32") {
    const dir = path.join(pythonRoot, "Lib", "site-packages");
    await mkdir(dir, { recursive: true });
    return dir;
  }
  const version = (await readdir(path.join(pythonRoot, "lib")).catch(() => [] as string[])).find((name) => /^python3\.\d+$/.test(name));
  if (!version) throw new Error("The CPython archive has no lib/python3.x directory");
  const dir = path.join(pythonRoot, "lib", version, "site-packages");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** What running graphify never loads: installers, Tcl/Tk, debug symbols. Mirrors prunePythonRuntime in the desktop build. */
async function prunePython(pythonRoot: string, platform: NodeJS.Platform): Promise<void> {
  const remove = (target: string) => rm(target, { recursive: true, force: true });
  const removeMatching = async (dir: string, pattern: RegExp) => {
    for (const name of await readdir(dir).catch(() => [] as string[])) if (pattern.test(name)) await remove(path.join(dir, name));
  };
  const windows = platform === "win32";
  const lib = windows
    ? path.join(pythonRoot, "Lib")
    : path.join(pythonRoot, "lib", (await readdir(path.join(pythonRoot, "lib")).catch(() => [] as string[])).find((name) => /^python3\.\d+$/.test(name)) ?? "python3");
  for (const name of ["ensurepip", "idlelib", "tkinter", "turtledemo", "turtle.py"]) await remove(path.join(lib, name));
  await removeMatching(path.join(lib, "site-packages"), /^(pip|setuptools)(-[^/]+\.dist-info)?$|^_distutils_hack$|^distutils-precedence\.pth$/);
  if (windows) {
    const walk = async (dir: string): Promise<void> => {
      for (const name of await readdir(dir)) {
        const current = path.join(dir, name);
        if ((await lstat(current)).isDirectory()) await walk(current);
        else if (name.toLowerCase().endsWith(".pdb")) await remove(current);
      }
    };
    await walk(pythonRoot);
    await remove(path.join(pythonRoot, "tcl"));
    await removeMatching(path.join(pythonRoot, "DLLs"), /^(_tkinter\.pyd|tcl\d+t\.dll|tk\d+t\.dll)$/i);
  } else {
    await removeMatching(path.join(pythonRoot, "lib"), /^(tcl\d.*|tk\d.*|itcl\d.*|thread\d.*|libtcl.*\.dylib|libtk.*\.dylib)$/);
    await removeMatching(path.join(lib, "lib-dynload"), /^_tkinter\./);
  }
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
}

/**
 * Build the component in `staging` from verified archives only. The launcher is the installer's own:
 * the shell text above, or the Windows launcher shipped with the program. Nothing from an archive or a
 * pack decides what the launcher is.
 */
export async function assembleComponent(staging: string, archivesDir: string, target: LockTarget, platform: NodeJS.Platform, hooks: InstallHooks = {}): Promise<void> {
  await extractTarGz(await readFile(path.join(archivesDir, target.python.file)), staging);
  const pythonRoot = path.join(staging, "python");
  if (!(await exists(pythonRoot))) throw new Error("The CPython archive has no python/ directory");
  await materializeSymlinks(pythonRoot);
  if (platform !== "win32") await dedupePython(pythonRoot);
  const pythonExe = platform === "win32" ? path.join(pythonRoot, "python.exe") : path.join(pythonRoot, "bin", "python3.11");
  const exeInfo = await lstat(pythonExe).catch(() => null);
  if (!exeInfo?.isFile()) throw new Error("The CPython archive is missing its Python executable");
  const packages = await sitePackages(pythonRoot, platform);
  const scratch = path.join(staging, ".wheels");
  try {
    for (const wheel of target.wheels) {
      const extracted = path.join(scratch, wheel.file);
      await extractZip(await readFile(path.join(archivesDir, wheel.file)), extracted);
      for (const entry of await readdir(extracted)) {
        if (entry.endsWith(".data")) throw new Error(`Wheel ${wheel.file} uses a .data layout the installer does not unpack`);
        const destination = path.join(packages, entry);
        if (await exists(destination)) throw new Error(`Wheel ${wheel.file} overwrites ${entry}`);
        await rename(path.join(extracted, entry), destination);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await prunePython(pythonRoot, platform);
  const distInfo = (await readdir(packages)).find((name) => name.startsWith("graphifyy-") && name.endsWith(".dist-info"));
  if (distInfo && (await exists(path.join(packages, distInfo, "licenses")))) {
    await cp(path.join(packages, distInfo, "licenses"), path.join(staging, "licenses", "graphify"), { recursive: true });
  }
  for (const candidate of [path.join(pythonRoot, "LICENSE.txt"), path.join(pythonRoot, "lib", "python3.11", "LICENSE.txt")]) {
    if (await exists(candidate)) {
      await mkdir(path.join(staging, "licenses", "python"), { recursive: true });
      await copyFile(candidate, path.join(staging, "licenses", "python", "LICENSE.txt"));
      break;
    }
  }
  const launcher = path.join(staging, launcherName(platform));
  if (platform === "win32") {
    const source = hooks.windowsLauncher ?? shippedWindowsLauncherPath();
    const bytes = await readFile(source).catch(() => {
      throw new ComponentInstallError("self-check", "This Nema build does not carry the Windows Graphify launcher");
    });
    await writeFile(launcher, bytes, { flag: "wx" });
  } else {
    await writeFile(launcher, POSIX_LAUNCHER, { flag: "wx", mode: 0o755 });
    await chmod(launcher, 0o755);
  }
}

/** `<launcher> --version` with a minimal environment and no bytecode writes, so the staged tree stays as assembled. */
export async function defaultSelfCheck(launcher: string): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "nema-component-check-"));
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        launcher,
        ["--version"],
        {
          cwd: home,
          timeout: 120_000,
          windowsHide: true,
          env: {
            ...windowsRuntimeEnv(process.env),
            PATH: process.env.PATH ?? "",
            LANG: process.env.LANG ?? "",
            HOME: home,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONNOUSERSITE: "1",
            GRAPHIFY_BACKEND: "none",
            GRAPHIFY_QUERY_LOG_DISABLE: "1",
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const text = `${stderr ?? ""}`.trim() || error.message;
            reject(new ComponentInstallError("self-check", `graphify --version failed: ${text.slice(0, 500)}`));
            return;
          }
          resolve(`${stdout}`.trim());
        },
      );
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

type TreeEntry = { size: number; sha256: string; executable: boolean };

/**
 * Relative path -> size, sha256 and (POSIX) executable bit of every regular file. Null when the tree holds
 * anything else (a symlink, a device): such a directory is never something the installer assembled.
 * Reads bytes only; nothing under `root` is executed.
 */
async function treeManifest(root: string): Promise<Map<string, TreeEntry> | null> {
  const files = new Map<string, TreeEntry>();
  async function walk(dir: string, prefix: string): Promise<boolean> {
    for (const name of (await readdir(dir)).sort()) {
      const current = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(current);
      if (info.isSymbolicLink()) return false;
      if (info.isDirectory()) {
        if (!(await walk(current, rel))) return false;
      } else if (info.isFile()) {
        files.set(rel, { size: info.size, sha256: await sha256File(current), executable: process.platform !== "win32" && (info.mode & 0o111) !== 0 });
      } else return false;
    }
    return true;
  }
  return (await walk(root, "")) ? files : null;
}

/** Exactly the same files, each with the same size, sha256 and executable bit. */
export async function sameTree(existing: string, staged: string): Promise<boolean> {
  const [a, b] = await Promise.all([treeManifest(existing).catch(() => null), treeManifest(staged)]);
  if (!a || !b || a.size !== b.size) return false;
  for (const [rel, entry] of b) {
    const other = a.get(rel);
    if (!other || other.size !== entry.size || other.sha256 !== entry.sha256 || other.executable !== entry.executable) return false;
  }
  return true;
}

const REPLACED = /^([a-f0-9]{64})\.replaced-[a-f0-9]+$/;

/**
 * Undo a replacement cut off midway. A backup whose `<lock-hash>` is gone goes back into place; a backup
 * beside a present `<lock-hash>` is stale (that directory is the self-checked replacement) and is removed.
 */
async function recoverReplacements(root: string): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const match = REPLACED.exec(name);
    if (!match) continue;
    const original = path.join(root, match[1]!);
    if (await exists(original)) await rm(path.join(root, name), { recursive: true, force: true });
    else await rename(path.join(root, name), original);
  }
}

export type ActivationOutcome = "renamed" | "reused" | "replaced-orphan" | "replaced-referenced";

/**
 * Put the self-checked `staging` tree in place as `<lockHash>` and point current.json at it.
 * An existing `<lockHash>` is reused only when it equals staging file for file; otherwise it is replaced.
 * When current.json names it (active or previous), it is moved aside first and restored on any failure,
 * so the pointer always names a usable directory.
 */
export async function activate(root: string, lockHash: string, staging: string, hooks: InstallHooks = {}): Promise<ActivationOutcome> {
  if (!LOCK_HASH.test(lockHash)) throw new Error(`Not a lock-hash: ${lockHash}`);
  const move = hooks.rename ?? rename;
  const point = hooks.writePointer ?? writePointer;
  const final = path.join(root, lockHash);
  const pointer = readPointer(root);
  const next: Pointer = { active: lockHash, previous: pointer.active && pointer.active !== lockHash ? pointer.active : pointer.previous };
  const existing = await lstat(final).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    await move(staging, final);
    await point(root, next);
    return "renamed";
  }
  if (existing.isDirectory() && !existing.isSymbolicLink() && (await sameTree(final, staging))) {
    await rm(staging, { recursive: true, force: true });
    await point(root, next);
    return "reused";
  }
  if (pointer.active !== lockHash && pointer.previous !== lockHash) {
    await rm(final, { recursive: true, force: true });
    await move(staging, final);
    await point(root, next);
    return "replaced-orphan";
  }
  const backup = path.join(root, `${lockHash}.replaced-${randomBytes(6).toString("hex")}`);
  await move(final, backup);
  let placed = false;
  try {
    await move(staging, final);
    placed = true;
    await point(root, next);
  } catch (error) {
    if (placed) await rm(final, { recursive: true, force: true });
    await move(backup, final);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
  return "replaced-referenced";
}

/** Keep the active and previous versions; remove every other version and any leftover staging. */
async function prune(root: string, keep: Pointer): Promise<void> {
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const version = LOCK_HASH.test(name) ? name : /^([a-f0-9]{64})\.staging$/.exec(name)?.[1];
    if (!version) continue;
    if (name === version && (version === keep.active || version === keep.previous)) continue;
    await rm(path.join(root, name), { recursive: true, force: true });
  }
}

const MiB = 1024 * 1024;
const mib = (bytes: number) => `${Math.ceil(bytes / MiB)} MiB`;

async function defaultFreeBytes(dir: string): Promise<number> {
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}

async function checkDiskSpace(root: string, downloadBytes: number, hooks: InstallHooks): Promise<void> {
  const needed = downloadBytes * (1 + EXTRACT_RATIO);
  const free = await (hooks.freeBytes ?? defaultFreeBytes)(root);
  if (free < needed) {
    throw new ComponentInstallError("disk-space", `Needs about ${mib(needed)} free under ${root}; ${mib(free)} is available (short by ${mib(needed - free)})`);
  }
}

/** One install at a time per component directory, across processes. A lock left by a dead process is taken over. */
async function acquireInstallLock(root: string): Promise<() => Promise<void>> {
  const file = path.join(root, ".install.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx" });
      return () => rm(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number((await readFile(file, "utf8").catch(() => "")).trim());
      let alive = false;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (probe) {
          alive = (probe as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      if (alive || pid === process.pid) throw new Error("Another Graphify install is already running");
      await rm(file, { force: true });
    }
  }
  throw new Error("Could not take the component install lock");
}

function classify(error: unknown): { reason: FailureReason; detail: string } {
  if (error instanceof ComponentInstallError) return { reason: error.reason, detail: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC") return { reason: "disk-space", detail: "The disk filled up during the install" };
  return { reason: "self-check", detail: error instanceof Error ? error.message : String(error) };
}

type Prepared = { name: ComponentName; env: ComponentEnv; root: string; target: LockTarget; lockHash: string; totalBytes: number; platform: PlatformInfo };

/** Platform and offline checks. Returns the status to answer with when no install can start. */
function prepare(name: string, env: ComponentEnv, allowOffline: boolean): Prepared | ComponentStatus {
  assertComponent(name);
  const lock = readLock(env.lockPath ?? shippedLockPath());
  const platform = env.platform ?? { platform: process.platform, arch: process.arch };
  const resolved = resolveTarget(lock, platform);
  if (!resolved.ok) return { state: "failed", name, lockHash: null, reason: "unsupported-platform", detail: resolved.detail, at: null };
  if (!allowOffline && isOffline(env)) return componentStatusSync(name, env);
  return { name, env, root: componentRoot(name, env), target: resolved.target, lockHash: resolved.lockHash, totalBytes: resolved.totalBytes, platform };
}

/**
 * The one assembly path shared by online install and offline import: archives from `source`, verified
 * against the lock, assembled, self-checked and activated. Failures leave the previous state untouched
 * and are recorded; a cancel leaves no record.
 */
export async function installFromSource(name: string, source: ArchiveSource, o: InstallOptions & { allowOffline?: boolean } = {}): Promise<ComponentStatus> {
  const env = o.env ?? {};
  const prepared = prepare(name, env, o.allowOffline === true);
  if (!("root" in prepared)) return prepared;
  const { root, target, lockHash, totalBytes, platform } = prepared;
  const hooks = o.hooks ?? {};
  const before = componentStatusSync(prepared.name, env);
  if (before.state === "installing" || (before.state === "installed" && !o.force)) return before;
  if (o.confirm) {
    const offer: InstallOffer = { name: prepared.name, lockHash, totalBytes, location: root, hosts: [...new Set(sourceUrls(target, env.env ?? process.env).map((url) => new URL(url).host))] };
    if (!(await o.confirm(offer))) return before;
  }
  await mkdir(root, { recursive: true });
  const release = await acquireInstallLock(root);
  const progress: InstallProgress = { phase: "download", downloadedBytes: 0, totalBytes, file: null };
  const emit = (update: Partial<InstallProgress> = {}) => {
    Object.assign(progress, update);
    setInstalling(root, lockHash, progress);
    o.onProgress?.({ ...progress });
  };
  const staging = path.join(root, `${lockHash}.staging`);
  try {
    emit();
    await recoverReplacements(root);
    await rm(staging, { recursive: true, force: true });
    await checkDiskSpace(root, totalBytes, hooks);
    const archivesDir = path.join(staging, ".archives");
    await mkdir(archivesDir, { recursive: true });
    await source({
      archivesDir,
      target,
      env: env.env ?? process.env,
      signal: o.signal,
      hooks,
      progress: (update) => emit(update),
      addBytes: (bytes) => emit({ downloadedBytes: progress.downloadedBytes + bytes }),
    });
    throwIfAborted(o.signal);
    await verifyArchives(archivesDir, target, (file) => emit({ phase: "verify", file }));
    throwIfAborted(o.signal);
    emit({ phase: "extract", file: null });
    await assembleComponent(staging, archivesDir, target, platform.platform, hooks);
    await rm(archivesDir, { recursive: true, force: true });
    throwIfAborted(o.signal);
    emit({ phase: "self-check" });
    await (hooks.selfCheck ?? defaultSelfCheck)(path.join(staging, launcherName(platform.platform)));
    throwIfAborted(o.signal);
    emit({ phase: "activate" });
    await activate(root, lockHash, staging, hooks);
    await clearFailure(root);
    await prune(root, readPointer(root));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (!isAbort(error) && !o.signal?.aborted) {
      const { reason, detail } = classify(error);
      await writeFailure(root, { lockHash, reason, detail, at: new Date().toISOString() });
    }
  } finally {
    setInstalling(root, lockHash, null);
    await release();
  }
  return componentStatusSync(prepared.name, env);
}

/**
 * Download, verify, assemble and activate `name` for this platform. Only `graphify` exists; any other
 * name throws. Resolves with the resulting status: `installed`, `failed` with a reason, or (after a
 * decline or a cancel) the status from before.
 */
export async function installComponent(name: string, o: InstallOptions = {}): Promise<ComponentStatus> {
  return installFromSource(name, downloadArchives, o);
}
