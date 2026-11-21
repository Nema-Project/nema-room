// Installs a component from archives pinned by the shipped lock:
//   download (or, later, an offline pack) -> <lock-hash>.staging/.archives
//   -> every archive checked against the lock's sha256 and size, the set exactly the lock's
//   -> assembled into <lock-hash>.staging -> self-check -> moved to <lock-hash> -> current.json
// A directory that has not passed all of that is never named active. An existing <lock-hash> directory
// is compared file by file with the fresh staging tree before anything in it may be reused, and is
// never executed; the directory current.json points at is only removed once its replacement is in place.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, renameSync } from "node:fs";
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { windowsRuntimeEnv } from "../platform.js";
import { extractTarGz, extractZip } from "./archive.js";
import { downloadWithRetry, sourceUrl, sourceUrls } from "./download.js";
import { readLock, resolveTarget, shippedLockPath, shippedWindowsLauncherPath, type LockFile, type LockTarget, type PlatformInfo } from "./lock.js";
import {
  assertComponent,
  claimInstallGeneration,
  clearFailure,
  componentRoot,
  componentStatusSync,
  installLockHeldByLiveOwner,
  isOffline,
  launcherName,
  LOCK_HASH,
  OFFLINE_DETAIL,
  acquirePointerFence,
  acquireTreeLock,
  readFailure,
  readInstallGeneration,
  readPointer,
  readTreeLockToken,
  recoverReplacementsSync,
  setInstalling,
  verifyPointerFence,
  writeFailure,
  writePointer,
  type ComponentEnv,
  type FailureRecord,
  type Pointer,
  type PointerFence,
  type TreeLock,
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
  /** A pre-rename seam: runs before the production code performs the rename (tests pause or count here). A hook that throws aborts the move. The hook must not rename itself — the production code renames after it returns. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Removes a directory tree; activation uses it for the post-commit removal of the replaced copy. */
  rm?: (target: string) => Promise<void>;
  /** Removes the install lock file on release; tests use it to fail the release after a commit. */
  removeLockFile?: (file: string) => Promise<void>;
  /** Renames the install lock file during a stale-lock takeover; tests pause it to interleave another installer. */
  renameLockFile?: (from: string, to: string) => Promise<void>;
  /**
   * Runs between an attempt's entry snapshot (generation, live-lock, failure record) and
   * its lock acquisition; tests pause a refusal there so another installer can claim its
   * generation and commit before the refusal reaches its recheck.
   */
  beforeAcquire?: () => Promise<void>;
  /** Writes the generation counter and high-water files for a claim; tests fail the counter write through it to exercise a real partial claim. */
  writeGenerationFile?: (file: string, body: string) => Promise<void>;
  /** A pre-write seam: runs before the production code writes the pointer (tests pause or fail the write here). A hook that throws aborts the write. The hook must not write the pointer itself — the production code writes it after the hook returns, guarded by a re-check of both locks immediately before the rename. */
  writePointer?: (root: string, pointer: Pointer) => Promise<void>;
  /**
   * A pre-rename seam for the pointer write: runs after the guard and before the real
   * rename (tests pause here, after the guard, to let another installer publish). The
   * guard runs again after the seam, before the rename, so a publication that landed
   * during the pause is caught. The hook must not rename itself.
   */
  renamePointer?: (from: string, to: string) => Promise<void>;
  /**
   * A second pre-rename seam for the pointer write: runs after the final guard and
   * before the real rename (tests pause here, after the final guard, to let another
   * installer publish). The guard and the pointer-identity check run once more after
   * it, before the rename. The hook must not rename itself.
   */
  renamePointerFinal?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam after the pointer-write fence is acquired: runs after the last
   * guard and identity check, holding the fence, and before the real rename (tests
   * pause here, after the last check, to let another installer try to publish — it
   * blocks on the fence, so its pointer cannot land until this rename is done). The
   * hook must not rename itself.
   */
  renamePointerFence?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam before the pointer-write fence is acquired: runs after the last
   * guard and identity check and before fence acquisition (tests pause here, after
   * the last check and before the fence, to let another installer publish — the guard
   * and the identity check run once more after the fence is acquired, before the
   * rename, so a publication that landed while this write was waiting for the fence
   * is caught). The hook must not rename itself.
   */
  renameBeforeFence?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam after the final guard, identity, and fence-identity check:
   * runs after the last check and before the real rename (tests pause here, after the
   * final check, to let another installer publish — the guard, the identity check,
   * and the fence-identity check run once more after it, before the rename, so a
   * publication or a fence displacement that landed after the final check is caught).
   * The hook must not rename itself.
   */
  renamePointerAfterCheck?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam after the last check, delaying the actual rename: runs after
   * the final check and before the real rename (tests pause here, after the last
   * check, to let another installer publish — there is no re-check after it; the
   * rename is protected instead by saving the target's current content before it
   * and restoring it if the fence was lost after it, so the successor's pointer
   * stands even though no check runs between the seam and the rename). The rename
   * itself is synchronous, so the last check and the rename are in the same block
   * with no await between them. The hook must not rename itself.
   */
  renamePointerAfterFinalCheck?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam after the snapshot and before the rename: runs after the
   * target's current content is saved and before the real rename (tests pause here,
   * after the snapshot, to let another installer publish — the target is re-read
   * after it, immediately before the rename, in the same synchronous block, so a
   * publication during the seam is captured in the saved content and the restore
   * puts the successor's pointer back, not the old one). The hook must not rename
   * itself.
   */
  renamePointerAfterSnapshot?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam for a rollback's rename-aside: runs after the ownership re-check
   * and before the real rename (tests pause here, after the final check, to let another
   * installer publish). Ownership is re-checked after the seam, before the rename, so
   * a publication that landed during the pause leaves the tree in place.
   * The hook must not rename itself.
   */
  renamePlaced?: (from: string, to: string) => Promise<void>;
  /**
   * A second pre-rename seam for a rollback's rename-aside: runs after the final
   * ownership re-check and before the real rename (tests pause here, after the final
   * check, to let another installer publish). Ownership and the pointer/tree identity
   * are re-checked once more after it, before the rename. The hook must not rename
   * itself.
   */
  renamePlacedFinal?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam after the rollback's pointer-write fence is acquired: runs after
   * the final ownership and identity re-check, holding the fence, and before the real
   * rename-aside (tests pause here, after the last check, to let another installer try
   * to publish — it blocks on the fence, so its pointer cannot land until this
   * rename is done). The hook must not rename itself.
   */
  renameFence?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam after the rollback's last check, delaying the actual
   * rename-aside: runs after the final ownership and fence-identity check and before
   * the real rename (tests pause here, after the last check, to let another installer
   * publish — ownership and the fence identity are re-checked once more after it,
   * before the rename, so a displacement that landed after the last check leaves the
   * tree in place). The rename itself is synchronous, so the last check and the
   * rename are in the same block with no await between them. The hook must not
   * rename itself.
   */
  renameAfterCheck?: (from: string, to: string) => Promise<void>;
  /**
   * A pre-rename seam after the rollback's last ownership and fence-identity check,
   * delaying the actual rename-aside: runs after the final check and before the real
   * rename (tests pause here, after the check, to let another installer publish —
   * ownership and the fence identity are re-checked once more after it, before the
   * rename, so a publication that landed during the pause leaves the tree in place).
   * The re-check is what preserves a published tree during the rollback: it
   * distinguishes this attempt's own cancelled tree (which still holds its install
   * and tree locks) from a successor's published tree (which displaced those locks).
   * The rename itself is synchronous, so the last check and the rename are in the
   * same block with no await between them. The hook must not rename itself.
   */
  renameAfterFinalCheck?: (from: string, to: string) => Promise<void>;
  /**
   * A test-only pre-rename seam after the final re-check and before the real
   * rename-aside: runs after the last ownership and fence-identity re-check and
   * before the rename (tests pause here, after the re-check, to let another
   * installer publish — there is no re-check after it, so a publication that
   * landed during the pause is not caught before the rename: the rename-aside
   * runs, the post-rename re-verification finds the locks lost, and the tree is
   * renamed back. The hook must not rename itself.
   */
  renameAfterRecheck?: (from: string, to: string) => Promise<void>;
  /**
   * A test-only seam after the rollback's rename-aside and before its post-rename
   * re-verification and rename-back: runs after the tree was moved aside and before
   * the code decides whether to delete it or rename it back (tests pause here, with
   * the tree out of the way, to check what a reader observes during that window —
   * the launcher does not resolve while the tree is aside, because componentBin
   * requires the tree at its final path; the rename-back restores it. The hook must
   * not rename itself; if it throws, the re-verification and rename-back still run.
   */
  renameAfterAside?: (from: string, to: string) => Promise<void>;
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
  const verify = hooks.verifyLockHeld ?? (async () => {});
  // The rename hook is a pre-rename seam: tests pause or count here, and the
  // production code performs the rename after it returns. A hook that throws
  // aborts the move. The hook must not rename itself — a caller that needs a
  // check between the seam and the rename does it explicitly (removePlaced).
  const move = async (from: string, to: string): Promise<void> => {
    await hooks.rename?.(from, to);
    await rename(from, to);
  };
  // The writePointer hook is a pre-write seam: tests pause or fail the write
  // here. The production code performs the real write after it returns. The
  // install lock is re-checked (asynchronously) after the seam, before the write;
  // the tree mutex is re-checked by a synchronous guard that runs in the same
  // block as the rename, so no interleaving can be orchestrated between the guard
  // and the rename: a successor that published while this attempt was paused in the
  // seam, or during the temp write, is caught before its pointer can be overwritten.
  // The rename seams run after the guard, before the real rename, so a successor
  // that publishes while the rename itself is delayed is caught by the guard's
  // second run and by the pointer-identity check after the seams. The pointer-write
  // fence is acquired just before the rename and held only for it: a successor's
  // pointer write waits while this rename runs, so it cannot land its pointer
  // between the last check and the rename — and the guard, the identity check, and
  // the fence-identity check run once more after the fence is acquired, before the
  // rename, so a publication or a fence displacement that landed while this write
  // was waiting for the fence is caught there. There is no re-check after the
  // after-check seam: the rename is protected instead by saving the target's
  // current content before it and restoring it if the fence was lost after it, and
  // the target is re-read after the after-snapshot seam, immediately before the
  // rename, so a successor that published after the snapshot is captured in the
  // saved content and the restore puts the successor's pointer back, not the old
  // one. The rename itself is synchronous, so the last check and the rename are in
  // the same block with no await between them.
  const point = async (r: string, p: Pointer, treeLock: TreeLock): Promise<void> => {
    await hooks.writePointer?.(r, p);
    await verify();
    await writePointer(r, p, () => {
      if (readTreeLockToken(r) !== treeLock.token) {
        throw new Error("Lost the component tree lock to another installer; aborting the install");
      }
    }, hooks.renamePointer, hooks.renamePointerFinal, hooks.renamePointerFence, hooks.renameBeforeFence, hooks.renamePointerAfterCheck, hooks.renamePointerAfterFinalCheck, hooks.renamePointerAfterSnapshot);
  };
  // The holder re-validates before publishing: if another installer displaced its lock
  // (see takeOverStaleLock), it aborts here instead of activating alongside that installer.
  await verify();
  const checkedPoint = async (r: string, p: Pointer, treeLock: TreeLock): Promise<void> => {
    await verify();
    // The tree mutex proves no other installer is publishing or removing in between:
    // if this attempt's claim was displaced (a delayed stale-lock takeover moved it
    // aside and a third claim landed before the restore), abort the publication
    // instead of pointing at a tree another installer may have moved.
    if (readTreeLockToken(r) !== treeLock.token) {
      throw new Error("Lost the component tree lock to another installer; aborting the install");
    }
    await point(r, p, treeLock);
    // The write above is guarded right before its rename, so a displacement during
    // the write is refused there instead of landing. This re-check stays as defense
    // in depth for a displacement that lands after the guard but before the write
    // returns: the install fails (retryable) rather than reporting success.
    await verify();
    if (readTreeLockToken(r) !== treeLock.token) {
      throw new Error("Lost the component tree lock to another installer; aborting the install");
    }
  };
  // The tree mutex serializes this attempt's critical sections against another
  // installer's activation and against read-path recovery's restore/undo: the
  // sameTree check through the pointer write, and a rollback's removal/restore.
  // The placement move itself needs no mutex — a destination that appears meanwhile
  // is handled by the retry below. A caller that already holds the mutex (the
  // referenced branch) passes it to removePlaced instead of re-acquiring it.
  const withTreeLock = async <T>(fn: (lock: TreeLock) => Promise<T>): Promise<T> => {
    const lock = await acquireTreeLock(root);
    try {
      return await fn(lock);
    } finally {
      lock.release();
    }
  };
  // Rollback is ownership-bound. A tree this attempt placed may be taken back out (and a backup
  // restored) only while the attempt still owns the install: its own cancellation, or a failure
  // while the lock is still held. Once the lock is lost, a successor may already have published
  // the same directory — removing it, or moving the backup over it, would delete the live
  // runtime the pointer names. What an attempt leaves behind unpublished is recovery's job,
  // under the lock.
  const ownsTree = async (error: unknown): Promise<boolean> => {
    if (isAbort(error)) return true;
    return verify().then(
      () => true,
      () => false,
    );
  };
  // Re-verify immediately before mutating: ownsTree's read and the rollback are separated by
  // awaits a successor can use to displace this attempt (a delayed stale-lock takeover can
  // move the lock aside after the read). A re-read alone cannot close that window completely,
  // but a protocol takeover re-validates the judged owner after moving the record aside and
  // restores it when it changed (see takeOverStaleLock), so after a successful re-read no
  // protocol takeover can displace the attempt before the mutation. An AbortError from the
  // check still proves ownership: the composed check reads the lock before the signal.
  const stillOwnsTree = async (): Promise<boolean> => {
    try {
      await verify();
      return true;
    } catch (error) {
      return isAbort(error);
    }
  };
  // The staging directory's identity, captured before any move: a rename preserves the
  // inode, so a tree at `final` is provably the one this attempt placed only while its
  // inode still matches the staging directory's.
  const stagingStat = await lstat(staging).catch(() => null);
  // Removal of the tree this attempt placed at `final`. Even immediately after a
  // successful stillOwnsTree, a plain recursive removal is not safe: a successor can
  // publish in the gap between the check and the removal and lose its live tree. So
  // rename first — the rename takes whatever tree is at `final` at that instant — and
  // delete only the tree whose inode proves it is the staging directory this attempt
  // moved into place. A successor's tree is renamed back; if the path was claimed again
  // in between, the aside copy keeps its `.replaced-` name and recovery restores or
  // removes it under the lock.
  //
  // The tree mutex does not close the check-to-rename gap by itself: a delayed
  // stale-lock takeover can displace this attempt's claim after the pre-check, and a
  // successor can then publish before the rename-aside runs. So the rename-aside runs
  // the pre-rename seam first and re-checks ownership after it returns — a successor
  // that published during the seam is caught there, and its tree is left in place
  // instead of being moved aside, so componentBin stays available throughout the
  // rollback. The post-rename re-verification stays as defense in depth: a successor
  // that claimed the install lock (which needs no mutex) but has not yet acquired the
  // tree mutex is caught there, and its tree goes back.
  const removePlaced = async (heldTreeLock?: TreeLock): Promise<void> => {
    let ownLock: TreeLock | null = null;
    let treeLock = heldTreeLock ?? null;
    if (!treeLock) {
      try {
        treeLock = await acquireTreeLock(root);
        ownLock = treeLock;
      } catch {
        return; // Cannot prove exclusion: leave the tree for recovery under the lock.
      }
    }
    // The pointer-write fence is acquired just before the rename-aside (below, after
    // the last re-check) and held through the post-rename re-verification and the
    // rename-back or delete: a successor's pointer write — the step that makes its
    // tree published — waits while this removal's rename runs, so it cannot publish
    // between this removal's final check and its rename; and this removal waits while
    // a successor is writing its pointer, so it cannot move a tree that was just
    // published. The fence is not held during the seams, so a successor can still
    // publish during one (and the re-check after the seam catches it). Lock order is
    // tree mutex first, then the fence (a pointer write runs inside the tree mutex,
    // so no path acquires them in the opposite order).
    let fence: PointerFence | null = null;
    try {
      // Check ownership BEFORE the rename-aside: if the lock is already lost, the tree
      // at `final` may be a successor's published runtime — moving it aside would leave
      // the pointer naming a missing directory until the rename-back, and a process that
      // stops in between strands it there (read-path recovery skips a live owner).
      // The tree mutex itself is checked too: if this attempt's claim was displaced
      // (a delayed stale-lock takeover moved it aside), another installer may be
      // publishing, and the removal must not run.
      if (!(await stillOwnsTree())) return;
      if (readTreeLockToken(root) !== treeLock.token) return;
      const trash = path.join(root, `${lockHash}.replaced-${randomBytes(6).toString("hex")}`);
      // The pointer file's and the tree's identities at this instant, for a
      // compare-and-swap on both: a successor that publishes rewrites the pointer
      // file (a new inode) and, when it replaces the tree, the tree at `final` (a new
      // inode); a successor that reuses the tree still rewrites the pointer. The
      // identity is the file's inode and mtime — not the pointer's content, which
      // cannot tell this attempt's newly placed tree from a successor's published
      // one in a same-version reinstall (both share the lock-hash). This attempt's
      // failed activation never wrote the pointer, so a changed identity means a
      // successor published.
      const identity = async (target: string): Promise<string | null> => {
        const info = await lstat(target).catch(() => null);
        return info === null ? null : `${info.ino}:${info.mtimeMs}`;
      };
      const pointerBefore = await identity(path.join(root, "current.json"));
      const treeBefore = await identity(final);
      // Whether the tree at `final` is still this attempt's to remove: it owns the
      // install lock and the tree mutex, and neither the pointer file nor the tree
      // has been republished or replaced since the identities above were captured.
      // A successor that published it holds both locks, so this attempt's claim is
      // gone and the tree stays in place. Checked before the rename and again after
      // each rename seam below, so a publication that lands during a seam is caught
      // before the rename.
      const ownsPlaced = async (): Promise<boolean> => {
        if (!(await stillOwnsTree())) return false;
        if (readTreeLockToken(root) !== treeLock.token) return false;
        if ((await identity(path.join(root, "current.json"))) !== pointerBefore) return false;
        if ((await identity(final)) !== treeBefore) return false;
        return true;
      };
      // Run the pre-rename seam, then re-check ownership before the rename itself: a
      // successor can publish after the checks above (a delayed takeover displacing
      // both locks in between). If it did, leave its published tree in place instead
      // of moving it aside — the launcher stays available, and this attempt's own
      // tree is left as a backup for recovery. The seam must not rename itself; the
      // production code renames after it returns.
      try {
        await hooks.rename?.(final, trash);
      } catch {
        return; // The move failed: nothing of this attempt's to remove.
      }
      if (!(await ownsPlaced())) return;
      // A second pre-rename seam, after the re-check: a test can pause here, after
      // the final check, to let another installer publish. Ownership and the
      // identities are re-checked after it, before the real rename, so a publication
      // that landed during the pause leaves the tree in place. After this last check,
      // the rename runs in the same block — there is no seam left to pause on, so a
      // displacement landing in that final step cannot be orchestrated; the post-rename
      // re-verification below stays as defense in depth for it.
      try {
        await hooks.renamePlaced?.(final, trash);
      } catch {
        return; // The move failed: nothing of this attempt's to remove.
      }
      if (!(await ownsPlaced())) return;
      // A third pre-rename seam, after the final re-check: a test can pause here,
      // after the final check, to let another installer publish — and the ownership
      // and identity re-check after it is the last one before the rename. After it,
      // the rename runs in the same block, so a displacement landing in that final
      // step cannot be orchestrated by a test; the post-rename re-verification below
      // stays as defense in depth for it.
      try {
        await hooks.renamePlacedFinal?.(final, trash);
      } catch {
        return; // The move failed: nothing of this attempt's to remove.
      }
      if (!(await ownsPlaced())) return;
      // Fence the rename-aside itself against a successor: acquire the fence, then
      // re-check ownership and the identities once more — a successor that published
      // before the fence was acquired is caught here — and only then rename. A
      // successor's pointer write waits while this rename runs, so it cannot publish
      // between this final check and the rename; and this rename waits while a
      // successor is writing its pointer, so it cannot move a tree that was just
      // published. The fence is held through the post-rename re-verification and the
      // rename-back or delete below, and released in the finally.
      try {
        fence = await acquirePointerFence(root);
      } catch {
        return; // Cannot prove exclusion: leave the tree for recovery under the lock.
      }
      if (!(await ownsPlaced())) return;
      // Re-check the fence itself before the rename: a delayed stale-lock takeover
      // can move this attempt's live fence aside after it was acquired (the takeover
      // judged the fence stale before this attempt claimed it, and its rename lands
      // later), and a successor can then claim the fence and publish before this
      // rename moves the tree. If the fence file no longer carries this attempt's
      // token and inode, the fence is lost and the tree stays in place.
      if (!verifyPointerFence(root, fence)) return;
      // A pre-rename seam after the fence-identity check: a test can pause here,
      // after the last check, holding the fence, to let another installer try to
      // publish — it blocks on the fence, so its pointer cannot land until this
      // rename is done. Ownership and the fence identity are re-checked after the
      // seam, before the rename, so a displacement that landed during the pause —
      // including a delayed takeover that moved the fence aside after the last check
      // — leaves the tree in place.
      try {
        await hooks.renameFence?.(final, trash);
      } catch {
        return; // The move failed: nothing of this attempt's to remove.
      }
      if (!(await ownsPlaced())) return;
      if (!verifyPointerFence(root, fence)) return;
      // A pre-rename seam after the last check, delaying the actual rename-aside: a
      // test can pause here, after the final check, to let another installer publish
      // — ownership and the fence identity are re-checked once more after it, before
      // the rename, so a displacement that landed after the last check leaves the
      // tree in place. The rename itself is synchronous, so the last check and the
      // rename are in the same block with no await between them.
      try {
        await hooks.renameAfterCheck?.(final, trash);
      } catch {
        return; // The move failed: nothing of this attempt's to remove.
      }
      if (!(await ownsPlaced())) return;
      if (!verifyPointerFence(root, fence)) return;
      // A pre-rename seam after the last ownership and fence-identity check: a test
      // can pause here, after the check, to let another installer publish. Ownership
      // and the fence identity are re-checked once more after it, before the real
      // rename, so a publication that landed during the pause leaves the tree in
      // place. The re-check is what preserves a published tree during the rollback:
      // it distinguishes this attempt's own cancelled tree (which still holds its
      // install and tree locks, so the re-check passes and the rename-aside runs to
      // remove it and restore the old tree from backup) from a successor's published
      // tree (which displaced those locks, so the re-check fails and the tree stays
      // — a pointer-name check cannot tell them apart, because both name the same
      // lock-hash). The rename itself is synchronous, so the last check and the
      // rename are in the same block with no await between them.
      try {
        await hooks.renameAfterFinalCheck?.(final, trash);
      } catch {
        return; // The move failed: nothing of this attempt's to remove.
      }
      if (!(await ownsPlaced())) return;
      if (!verifyPointerFence(root, fence)) return;
      // A test-only pre-rename seam after the final re-check, before the real
      // rename-aside: a test can pause here, after the re-check, to let another
      // installer publish. There is no re-check after it: the rename-aside runs, the
      // post-rename re-verification finds the locks lost, and the tree is renamed
      // back. The rename itself is synchronous, so the last check and the rename are
      // in the same block with no await between them.
      try {
        await hooks.renameAfterRecheck?.(final, trash);
      } catch {
        return; // The move failed: nothing of this attempt's to remove.
      }
      try {
        renameSync(final, trash);
      } catch {
        return; // Nothing movable at `final`: nothing of this attempt's to remove.
      }
      // A test-only seam after the rename-aside and before the post-rename
      // re-verification and rename-back: a test can pause here, with the tree out of
      // the way, to check what a reader observes during that window. The launcher
      // does not resolve while the tree is aside (componentBin requires the tree at
      // its final path); the rename-back restores it. If the seam throws, the
      // re-verification and rename-back still run — the rename already happened, so
      // returning here would strand the tree aside.
      try {
        await hooks.renameAfterAside?.(final, trash);
      } catch {
        // Continue to the re-verification and rename-back below.
      }
      const aside = await lstat(trash).catch(() => null);
      const inodeMatches = aside !== null && stagingStat !== null && aside.dev === stagingStat.dev && aside.ino === stagingStat.ino;
      // The inode proves the tree is the staging directory this attempt placed — but not
      // that it is still this attempt's: a successor can reuse that same directory (its
      // staging is byte-identical) and publish a pointer to it after this attempt's last
      // ownership check. So re-verify the lock after the rename-aside, while the tree is
      // out of the way: if the lock is lost, the tree is the successor's published
      // runtime and goes back. The tree mutex is re-checked the same way: a claim
      // displaced after the rename-aside means another installer may have published.
      if (inodeMatches && (await stillOwnsTree()) && readTreeLockToken(root) === treeLock.token) {
        await rm(trash, { recursive: true, force: true });
      } else {
        await move(trash, final).catch(() => {
          // The path was claimed again in between: leave the aside copy for recovery.
        });
      }
    } finally {
      fence?.release();
      ownLock?.release();
    }
  };
  const final = path.join(root, lockHash);
  const pointer = readPointer(root);
  const next: Pointer = { active: lockHash, previous: pointer.active && pointer.active !== lockHash ? pointer.active : pointer.previous };
  let existing = await lstat(final).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!existing) {
    let placed = false;
    try {
      await move(staging, final);
      placed = true;
    } catch (error) {
      // The destination appeared between the read and the move: recovery restored a
      // backup there (or another installer published) while this attempt was placing.
      // Do not fail the install for a destination that is now occupied — re-read and
      // take the existing-tree path below, which reuses it, replaces an orphan, or
      // moves it aside as the referenced version's backup. A destination that is still
      // missing is a real placement failure, and the error stands.
      const now = await lstat(final).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (!now) throw error;
      existing = now;
    }
    if (placed) {
      try {
        await withTreeLock((treeLock) => checkedPoint(root, next, treeLock));
      } catch (error) {
        // Nothing has published this tree (no pointer names it). Take it back out only while this
        // attempt still owns it — after a lost lock it may be the successor's published runtime.
        // The ownership is re-checked right before the removal: the read behind ownsTree and
        // this mutation are separated by awaits a successor can use to displace the attempt.
        if ((await ownsTree(error)) && (await stillOwnsTree())) await removePlaced();
        throw error;
      }
      return "renamed";
    }
  }
  // Unreachable by construction: a missing destination either places (and returns
  // above) or the re-read finds nothing and the placement error is rethrown. The
  // guard is here so the compiler can see it.
  if (!existing) throw new Error("unreachable: the destination was checked immediately before the placement");
  if (existing.isDirectory() && !existing.isSymbolicLink()) {
    // The reuse decision and the pointer write run under the tree mutex: a successor
    // between this sameTree check and its pointer write holds the mutex, and read-path
    // recovery's post-move check waits for it — so the recovery cannot undo a restore
    // out from under an install that is about to commit the restored tree.
    const reused = await withTreeLock(async (treeLock) => {
      if (!(await sameTree(final, staging))) return false;
      await rm(staging, { recursive: true, force: true });
      await checkedPoint(root, next, treeLock);
      return true;
    });
    if (reused) return "reused";
  }
  if (pointer.active !== lockHash && pointer.previous !== lockHash) {
    await withTreeLock(async (treeLock) => {
      await rm(final, { recursive: true, force: true });
      await move(staging, final);
      try {
        await checkedPoint(root, next, treeLock);
      } catch (error) {
        // Same unpublished case as above: the replaced tree was an orphan no pointer named.
        // Remove the new one only while this attempt still owns it, re-checked before the removal.
        // The removal reuses the mutex this branch already holds.
        if ((await ownsTree(error)) && (await stillOwnsTree())) await removePlaced(treeLock);
        throw error;
      }
    });
    return "replaced-orphan";
  }
  const backup = path.join(root, `${lockHash}.replaced-${randomBytes(6).toString("hex")}`);
  // The replacement's moves and the pointer write run under the tree mutex: moving
  // the active tree aside while a successor publishes it would leave the pointer
  // naming a missing directory, and the rollback below reuses the same mutex.
  await withTreeLock(async (treeLock) => {
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
      await checkedPoint(root, next, treeLock);
    } catch (error) {
      // Restore the backup only while this attempt still owns the tree: after a lost lock the
      // placed tree may be the successor's published runtime, and the backup stays for recovery.
      // The ownership is re-checked right before the restore, for the same displacement window,
      // and again immediately before the restore move: the removal and the move are separated
      // by awaits a successor can use to displace the attempt and publish its own tree.
      if ((await ownsTree(error)) && (await stillOwnsTree())) {
        if (placed) await removePlaced(treeLock);
        if (await stillOwnsTree()) await move(backup, final);
      }
      throw error;
    }
  });
  // The pointer has committed: the replacement is the installed copy. Removing the replaced one
  // is cleanup — its failure is logged, never reported as the install's outcome.
  try {
    await (hooks.rm ?? ((target: string) => rm(target, { recursive: true, force: true })))(backup);
  } catch (cleanupError) {
    console.error("[nema] component activation committed, but removing the replaced copy failed", cleanupError);
  }
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
/**
 * Move a stale lock record aside so a fresh claim can take the path. The judged owner was
 * read when the lock was first inspected; re-validate it immediately before renaming, because
 * a live installer may have claimed the path since. Renaming a live holder's record aside
 * would let a successor claim the vacant path in the gap before the restore below, and the
 * restore cannot put the holder's record back once a successor's claim is in place (EEXIST).
 * Returns the moved record's path, or null when the takeover must not proceed.
 */
export async function takeOverStaleLock(
  file: string,
  judged: LockOwner,
  renameFile: (from: string, to: string) => Promise<void> = rename,
): Promise<string | null> {
  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== judged.content) return null;
  const stale = `${file}.stale-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await renameFile(file, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const content = await readFile(stale, "utf8").catch(() => null);
  if (content === null || content !== judged.content) {
    if (content !== null) {
      // Restore the moved record without replacing a claim made in the gap. If that
      // link fails (EEXIST — a third claim landed between the rename and the restore),
      // do NOT delete the aside file: it is the live holder's only copy of its claim,
      // and deleting it would destroy the lock it still holds. The holder detects the
      // displacement via its token check and aborts; the aside file stays as litter.
      const temp = `${file}.claim-${process.pid}-${randomBytes(6).toString("hex")}`;
      await writeFile(temp, content);
      let restored = false;
      try {
        await link(temp, file);
        restored = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await rm(temp, { force: true });
      }
      if (restored) await rm(stale, { force: true });
    }
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
export async function acquireInstallLock(root: string, seams: { removeLockFile?: (file: string) => Promise<void>; renameLockFile?: (from: string, to: string) => Promise<void> } = {}): Promise<{ release: () => Promise<void>; token: string }> {
  const file = path.join(root, LOCK_FILE);
  const token = claimToken();
  const removeLockFile = seams.removeLockFile ?? ((target: string) => rm(target, { force: true }));
  const release = async (): Promise<void> => {
    // Open the claim once, without truncating it: the token is verified through this handle
    // and, if removal fails, the tombstone is written through the same handle. A path-based
    // re-check and write could be fooled by a delayed stale-lock takeover moving the verified
    // file aside and a successor claiming the path in between — the write would land on the
    // successor's token and break its ownership checks.
    const handle = await open(file, "r+").catch(() => null);
    if (!handle) return;
    try {
      const current = await handle.readFile("utf8").catch(() => null);
      if (current !== token) return;
      try {
        await removeLockFile(file);
      } catch {
        // The claim must not outlive the install as a live lock held by this (possibly
        // long-lived) process: overwrite it, through the verified handle, with a record no
        // acquirer reads as a live owner, so the next installer takes it over through the
        // stale-lock protocol instead. Best effort — release never throws.
        await handle.truncate(0).catch(() => {});
        await handle.write("released\n", 0, "utf8").catch(() => {});
      }
    } finally {
      await handle.close().catch(() => {});
    }
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
    const stale = await takeOverStaleLock(file, owner, seams.renameLockFile);
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

/** Whether two failure records describe the same attempt outcome, field by field. The revision is stamped fresh on every write, so an identical rewrite — same lock, reason, detail and timestamp — still counts as a different record. */
function sameFailure(a: FailureRecord | null, b: FailureRecord | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.lockHash === b.lockHash &&
      a.reason === b.reason &&
      a.detail === b.detail &&
      a.at === b.at &&
      a.revision === b.revision)
  );
}

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
    return { state: "failed", name, lockHash: resolved.lockHash, reason: "offer-changed", detail: "the component offer changed; confirm again", at: null };
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
  assertComponent(name);
  // Snapshot the install generation before any status read below. The offline refusal records
  // its failure only if the generation is unchanged when it writes; a repair that commits after
  // this snapshot — even of the same version — bumps it, so the refusal cannot stamp a state it
  // never saw. Reading the generation after the status would reopen exactly that window.
  // A store whose counter is missing or unreadable cannot anchor the comparison: the snapshot
  // is then null, and the refusal is recorded only if the counter is still missing at the
  // recheck — a claim in the meantime makes it present and breaks the equality, and an
  // unreadable counter throws out of the recheck into the branch's catch instead of writing.
  // The generation alone cannot tell a repair already in progress from nothing happening: a
  // repair claims its generation before activation, so a refusal that begins while the repair
  // runs reads the claimed generation and would see it unchanged after the repair commits.
  // Snapshot whether a live installer holds the lock too, and never record when one did — the
  // repair's own outcome defines the shared status.
  // Snapshot the failure record as well: a refusal records only if the record is unchanged
  // when it writes. A later attempt that records its own failure — including one whose
  // generation claim failed, so the generation never advanced — changes the record, and the
  // older refusal must not stamp over it.
  let generationAtStart: number | null;
  let lockHeldAtStart: boolean;
  const failureAtStart: FailureRecord | null = readFailure(componentRoot(name, env));
  try {
    generationAtStart = readInstallGeneration(componentRoot(name, env));
  } catch {
    generationAtStart = null;
  }
  lockHeldAtStart = installLockHeldByLiveOwner(componentRoot(name, env));
  const prepared = prepare(name, env, o.allowOffline === true, o.expectedLockHash);
  if (!("root" in prepared)) {
    // Offline with a version installed, prepare answers the installed status: a plain install has
    // nothing to do, but a forced reinstall was asked to download and could not. Report that attempt
    // — and record it, so the installed status carries it — instead of reporting the old copy.
    if (o.force === true && prepared.state === "installed" && isOffline(env)) {
      const attemptFailure = { reason: "offline" as const, detail: OFFLINE_DETAIL, at: new Date().toISOString() };
      const root = componentRoot(prepared.name, env);
      // The record is written under the install lock, and only if no install has committed since
      // this attempt began: the generation snapshotted at entry (before the status read) changes
      // on every commit, so a repair that completed after this attempt began — even of the same
      // version, which the lock-hash recheck cannot tell apart — keeps its own cleared record
      // instead of being stamped with this attempt's failure. When the lock cannot be taken, the
      // running install's outcome stands and this attempt is only returned to its caller.
      try {
        await mkdir(root, { recursive: true });
        await o.hooks?.beforeAcquire?.();
        const { release } = await acquireInstallLock(root, { renameLockFile: o.hooks?.renameLockFile });
        try {
          const now = componentStatusSync(prepared.name, env);
          if (
            now.state === "installed" &&
            now.lockHash === prepared.lockHash &&
            !lockHeldAtStart &&
            readInstallGeneration(root) === generationAtStart &&
            sameFailure(failureAtStart, readFailure(root))
          ) {
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
    // A confirmation for a lock that has since changed is refused before any download. The refusal
    // is recorded like any other attempt outcome: daemon installs run in the background and their
    // returned status is discarded, so an unrecorded refusal would never reach status polling.
    if (prepared.state === "failed" && prepared.reason === "offer-changed" && prepared.lockHash) {
      const at = new Date().toISOString();
      const root = componentRoot(prepared.name, env);
      try {
        await mkdir(root, { recursive: true });
        await o.hooks?.beforeAcquire?.();
        const { release } = await acquireInstallLock(root, { renameLockFile: o.hooks?.renameLockFile });
        try {
          // Only while the refusal still describes the store: a copy installed under the current
          // lock in the meantime has resolved the situation, and its status stands. And only
          // while no install attempt intervened since this attempt began: the generation claimed
          // under the lock before every activation is strictly increasing, so any attempt that
          // started after this refusal's entry snapshot — even one that failed — makes the
          // comparison fail and the newer outcome stand. Wall-clock timestamps cannot order
          // this: two records can share one millisecond, and a clock adjustment can reorder them.
          const now = componentStatusSync(prepared.name, env);
          if (
            now.state !== "installed" &&
            now.lockHash === prepared.lockHash &&
            !lockHeldAtStart &&
            readInstallGeneration(root) === generationAtStart &&
            sameFailure(failureAtStart, readFailure(root))
          ) {
            await writeFailure(root, { lockHash: prepared.lockHash, reason: prepared.reason, detail: prepared.detail, at });
          }
        } finally {
          await release();
        }
      } catch {
        // Another installer holds the lock; its outcome defines the shared status.
      }
      return { ...prepared, at };
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
  const { release, token } = await acquireInstallLock(root, { removeLockFile: hooks.removeLockFile, renameLockFile: hooks.renameLockFile });
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
    // Recovery runs under the lock this install already holds, with its own token: the
    // installer that owns the backups is the one healing them, and no other installer can
    // take the lock in between and reach activation while recovery moves a backup. Running
    // it before the lock was taken let a waiting installer pass the lock check, pause, and
    // resume into another installer's activation.
    recoverReplacementsSync(root, { ownToken: token });
    // Claim this attempt's generation before any shared state changes — including the progress
    // callback, which can throw: the marker is recorded under the lock before activation, so a
    // refusal snapshotted before it can tell the attempt intervened even if this attempt later
    // fails. If the claim itself fails (an unreadable or unrecordable counter), the attempt
    // aborts here — before touching the store — instead of committing an install no later
    // refusal can detect. Claiming after the progress callback would leave a failure recorded
    // by the callback's throw, or by a failed claim, under an unchanged generation, which an
    // older refusal could then overwrite.
    await claimInstallGeneration(root, hooks.writeGenerationFile);
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
    // previous version back — the cancel never leaves a half-replaced tree behind. The lock is
    // read before the signal: an AbortError from this check then means the attempt still held
    // the lock when it was cancelled, which is what activation's ownership-bound rollback
    // relies on. A successor that claimed the lock first makes the lock read fail instead, so
    // a later cancellation cannot mistake the lost lock for ownership.
    await activate(root, lockHash, staging, {
      ...hooks,
      verifyLockHeld: async () => {
        await verifyLockHeld(root, token);
        throwIfAborted(o.signal);
      },
    });
    // The pointer has committed: the install has happened. Clearing the failure record and
    // pruning are cleanup — their failures are logged, never reported as the install's outcome.
    // The generation was already claimed before activation, so a refusal snapshotted before
    // this attempt cannot mistake the repaired store for the state it read.
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
    // Releasing the lock is post-commit bookkeeping: its failure must not replace the install's
    // outcome — least of all turn a committed install into an error, or into a cancellation
    // claiming nothing changed. release() already tombstones a lock file it cannot remove and
    // does not throw; this catch is the last resort, logged and swallowed either way.
    await release().catch((releaseError: unknown) => {
      console.error(`[nema] component ${prepared.name} install finished, but releasing the install lock failed`, releaseError);
    });
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
