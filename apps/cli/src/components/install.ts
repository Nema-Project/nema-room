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
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, statfs, writeFile } from "node:fs/promises";
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
  OFFLINE_DETAIL,
  readPointer,
  recoverReplacementsSync,
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
  /** Abort unless the install lock still carries this install's token (holder re-validation). */
  verifyLockHeld?: () => Promise<void>;
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
  /** The lock-hash the caller confirmed (the daemon's install RPC): prepare refuses a lock that resolves differently. */
  expectedLockHash?: string;
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
  const verify = hooks.verifyLockHeld ?? (async () => {});
  // The holder re-validates before publishing: if another installer displaced its lock
  // (see takeOverStaleLock), it aborts here instead of activating alongside that installer.
  await verify();
  const checkedPoint = async (r: string, p: Pointer): Promise<void> => {
    await verify();
    await point(r, p);
  };
  const final = path.join(root, lockHash);
  const pointer = readPointer(root);
  const next: Pointer = { active: lockHash, previous: pointer.active && pointer.active !== lockHash ? pointer.active : pointer.previous };
  const existing = await lstat(final).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    await move(staging, final);
    try {
      await checkedPoint(root, next);
    } catch (error) {
      // Nothing has published this tree (no pointer names it) and this attempt still owns it:
      // take it back out rather than leaving a full runtime behind as an orphan.
      await rm(final, { recursive: true, force: true });
      throw error;
    }
    return "renamed";
  }
  if (existing.isDirectory() && !existing.isSymbolicLink() && (await sameTree(final, staging))) {
    await rm(staging, { recursive: true, force: true });
    await checkedPoint(root, next);
    return "reused";
  }
  if (pointer.active !== lockHash && pointer.previous !== lockHash) {
    await rm(final, { recursive: true, force: true });
    await move(staging, final);
    try {
      await checkedPoint(root, next);
    } catch (error) {
      // Same unpublished case: the replaced tree was an orphan no pointer named, and this attempt
      // still owns the new one — remove it rather than leaving it behind.
      await rm(final, { recursive: true, force: true });
      throw error;
    }
    return "replaced-orphan";
  }
  const backup = path.join(root, `${lockHash}.replaced-${randomBytes(6).toString("hex")}`);
  await move(final, backup);
  let placed = false;
  try {
    // Re-validate between the two moves, inside the try: a displaced holder must stop
    // before placing its staging, and the catch below restores the backup. Checked here
    // rather than before the try, a failed check would leave the active directory missing
    // with only a later recovery to restore it — and that recovery is skipped while a
    // live installer holds the lock.
    await verify();
    await move(staging, final);
    placed = true;
    await checkedPoint(root, next);
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

/**
 * Cross-process install lock, held for the whole install. Ownership is a token of the form
 * `<pid>:<random>`, published atomically: the record is written to a unique temp file and
 * then `link(2)`ed onto the lock path, so a reader never observes a half-written record
 * (the old create-then-write gap is what let a contender delete a live lock).
 *
 * A stale lock is taken over only through an atomic rename: exactly one contender wins
 * `rename(lock, lock.stale-*)`; the winner re-reads the renamed record and claims only if
 * it is still the record it judged stale — a record that changed under it is restored and
 * left alone. The release removes the lock only when it still carries the holder's token,
 * so a successor's lock is never deleted. All of this holds among current-code installers;
 * a pre-change binary caught in its own create/write window cannot participate in the
 * protocol and is the only residual race.
 */
const LOCK_FILE = ".install.lock";

function claimToken(): string {
  return `${process.pid}:${randomBytes(6).toString("hex")}`;
}

type LockOwner = { content: string; ino: number; mtimeMs: number };

async function readLockOwner(file: string): Promise<LockOwner | null> {
  try {
    const [info, content] = await Promise.all([lstat(file), readFile(file, "utf8")]);
    return { content, ino: info.ino, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function ownerPid(content: string): number | null {
  const pid = Number(content.split(":")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (probe) {
    return (probe as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Publish `token` as the lock owner. Returns true when this call won the atomic link. */
async function linkClaim(file: string, token: string): Promise<boolean> {
  const temp = `${file}.claim-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temp, token);
  try {
    await link(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Move the judged-stale lock aside atomically. Returns the aside path when the moved record
 * is still the one judged stale; otherwise restores it and returns null (a live installer
 * owns it after all, or another contender won the rename).
 *
 * The restore is a non-replacing link: if a fresh installer claimed the path in the gap,
 * the link fails with EEXIST instead of clobbering its claim. The moved record is then
 * stranded and inert — its holder notices at its next ownership check and aborts — so it
 * is dropped rather than restored over the new claim.
 */
async function takeOverStaleLock(file: string, judged: LockOwner): Promise<string | null> {
  const stale = `${file}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await rename(file, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const content = await readFile(stale, "utf8").catch(() => null);
  if (content === null || content !== judged.content) {
    if (content !== null) {
      // Restore the moved record without replacing a claim made in the gap.
      const temp = `${file}.claim-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(temp, content);
      try {
        await link(temp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await rm(temp, { force: true });
      }
    }
    await rm(stale, { force: true });
    return null;
  }
  return stale;
}

/**
 * Fail unless the lock file still carries `token`. The holder calls this before every
 * mutation that another installer could corrupt (staging removal, activation) so a holder
 * whose lock was displaced by the takeover race above aborts instead of installing
 * alongside the installer that displaced it.
 */
export async function verifyLockHeld(root: string, token: string): Promise<void> {
  const current = await readFile(path.join(root, LOCK_FILE), "utf8").catch(() => null);
  if (current !== token) {
    throw new Error("Lost the component install lock to another installer; aborting the install");
  }
}

/** One install at a time per component directory, across processes. Exported for tests. */
export async function acquireInstallLock(root: string): Promise<{ release: () => Promise<void>; token: string }> {
  const file = path.join(root, LOCK_FILE);
  const token = claimToken();
  const release = async (): Promise<void> => {
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === token) await rm(file, { force: true });
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await linkClaim(file, token)) return { release, token };
    const owner = await readLockOwner(file);
    if (!owner) continue; // Vanished between the claim attempt and the read; retry the claim.
    const pid = ownerPid(owner.content);
    if (pid !== null && (pid === process.pid || pidAlive(pid))) {
      throw new Error("Another Graphify install is already running");
    }
    // Dead owner, or a legacy record with no live writer (current code never writes one):
    // take it over through the atomic rename protocol, never by remove-then-create.
    const stale = await takeOverStaleLock(file, owner);
    if (!stale) continue; // Lost the rename race, or the record revived; re-loop and re-judge.
    if (await linkClaim(file, token)) {
      await rm(stale, { force: true });
      return { release, token };
    }
    // A fresh installer claimed the path in the gap; drop the dead record we moved aside.
    await rm(stale, { force: true });
    throw new Error("Another Graphify install is already running");
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
function prepare(name: string, env: ComponentEnv, allowOffline: boolean, expectedLockHash?: string): Prepared | ComponentStatus {
  assertComponent(name);
  const lock = readLock(env.lockPath ?? shippedLockPath());
  const platform = env.platform ?? { platform: process.platform, arch: process.arch };
  const resolved = resolveTarget(lock, platform);
  if (!resolved.ok) return { state: "failed", name, lockHash: null, reason: "unsupported-platform", detail: resolved.detail, at: null };
  // The confirmation was for one lock's download; a lock that resolves differently since (the
  // program was upgraded in between) is not what was confirmed and must be confirmed again.
  if (expectedLockHash !== undefined && resolved.lockHash !== expectedLockHash) {
    return { state: "failed", name, lockHash: null, reason: "offer-changed", detail: "the component offer changed; confirm again", at: null };
  }
  if (!allowOffline && isOffline(env)) return componentStatusSync(name, env);
  return { name, env, root: componentRoot(name, env), target: resolved.target, lockHash: resolved.lockHash, totalBytes: resolved.totalBytes, platform };
}

/**
 * The one assembly path shared by online install and offline import: archives from `source`, verified
 * against the lock, assembled, self-checked and activated. Failures leave the previous state untouched
 * and are recorded; a cancel leaves no record and throws the abort error instead of resolving.
 */
export async function installFromSource(name: string, source: ArchiveSource, o: InstallOptions & { allowOffline?: boolean } = {}): Promise<ComponentStatus> {
  const env = o.env ?? {};
  const prepared = prepare(name, env, o.allowOffline === true, o.expectedLockHash);
  if (!("root" in prepared)) {
    // Offline with a version installed, prepare answers the installed status: a plain install has
    // nothing to do, but a forced reinstall was asked to download and could not. Report that attempt
    // — and record it, so the installed status carries it — instead of reporting the old copy.
    if (o.force === true && prepared.state === "installed" && isOffline(env)) {
      const attemptFailure = { reason: "offline" as const, detail: OFFLINE_DETAIL, at: new Date().toISOString() };
      const root = componentRoot(prepared.name, env);
      // The record is written under the install lock, with the state rechecked there: a repair
      // running in another process owns the status while it runs, and one that already finished
      // must not be handed this attempt's failure. When the lock cannot be taken, the running
      // install's outcome stands and this attempt is only returned to its caller.
      try {
        const { release } = await acquireInstallLock(root);
        try {
          const now = componentStatusSync(prepared.name, env);
          if (now.state === "installed" && now.lockHash === prepared.lockHash) {
            await writeFailure(root, { lockHash: prepared.lockHash, ...attemptFailure });
          }
        } finally {
          await release();
        }
      } catch {
        // Another installer holds the lock; its outcome defines the shared status.
      }
      return { state: "failed", name: prepared.name, lockHash: prepared.lockHash, ...attemptFailure };
    }
    return prepared;
  }
  const { root, target, lockHash, totalBytes, platform } = prepared;
  const hooks = o.hooks ?? {};
  const before = componentStatusSync(prepared.name, env);
  if (before.state === "installing" || (before.state === "installed" && !o.force)) return before;
  if (o.confirm) {
    const offer: InstallOffer = { name: prepared.name, lockHash, totalBytes, location: root, hosts: [...new Set(sourceUrls(target, env.env ?? process.env).map((url) => new URL(url).host))] };
    if (!(await o.confirm(offer))) return before;
  }
  await mkdir(root, { recursive: true });
  // Recovery runs before the lock is taken: once this install holds the lock, readers skip
  // recovery (see recoverReplacementsSync), and so would this call.
  recoverReplacementsSync(root);
  const { release, token } = await acquireInstallLock(root);
  const progress: InstallProgress = { phase: "download", downloadedBytes: 0, totalBytes, file: null };
  const emit = (update: Partial<InstallProgress> = {}) => {
    Object.assign(progress, update);
    setInstalling(root, lockHash, progress);
    o.onProgress?.({ ...progress });
  };
  const staging = path.join(root, `${lockHash}.staging`);
  // The attempt's own outcome, reported separately from the store status: a failed reinstall over an
  // intact version must read as a failure, not as the still-serving old version.
  let attemptFailure: { reason: FailureReason; detail: string; at: string } | null = null;
  try {
    emit();
    // Re-validate before the first mutation of shared state: a takeover that displaced
    // this install's lock must abort here, not after wiping another installer's staging.
    await verifyLockHeld(root, token);
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
    // The abort signal is part of activation's ownership check: a cancel that lands before the
    // pointer write stops activation at its verify points, and activation's own rollback puts the
    // previous version back — the cancel never leaves a half-replaced tree behind. The signal is
    // checked again after the lock read, so a cancel that arrives during that read still stops
    // the pointer write instead of being reported as a completed install.
    await activate(root, lockHash, staging, {
      ...hooks,
      verifyLockHeld: async () => {
        throwIfAborted(o.signal);
        await verifyLockHeld(root, token);
        throwIfAborted(o.signal);
      },
    });
    // The pointer has committed: the install has happened. Cleanup errors from here are reported
    // separately and never turn the result into a failure or a cancel.
    try {
      await clearFailure(root);
      await prune(root, readPointer(root));
    } catch (cleanupError) {
      console.error(`[nema] component ${prepared.name} installed, but post-install cleanup failed`, cleanupError);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // A cancel is the caller's outcome, not a failed attempt: no record, and the abort propagates
    // instead of resolving with the previous status — resolving would let a caller report a
    // cancelled repair as a success. An abort that lands after activation has completed never
    // reaches this catch (nothing past the pointer write checks the signal), so a finished
    // install still resolves as installed.
    if (isAbort(error) || o.signal?.aborted) throw abortError();
    const { reason, detail } = classify(error);
    attemptFailure = { reason, detail, at: new Date().toISOString() };
    await writeFailure(root, { lockHash, ...attemptFailure });
  } finally {
    setInstalling(root, lockHash, null);
    await release();
  }
  const status = componentStatusSync(prepared.name, env);
  if (attemptFailure) {
    const pointer = readPointer(root);
    return {
      state: "failed",
      name: prepared.name,
      lockHash,
      reason: attemptFailure.reason,
      detail: attemptFailure.detail,
      at: attemptFailure.at,
      ...(pointer.active && pointer.active !== lockHash ? { installedLockHash: pointer.active } : {}),
    };
  }
  return status;
}

/**
 * Download, verify, assemble and activate `name` for this platform. Only `graphify` exists; any other
 * name throws. Resolves with the resulting status: `installed`, `failed` with a reason, or (after a
 * decline) the status from before. A cancel throws the abort error: the previous state is unchanged
 * and nothing is recorded.
 */
export async function installComponent(name: string, o: InstallOptions = {}): Promise<ComponentStatus> {
  return installFromSource(name, downloadArchives, o);
}
