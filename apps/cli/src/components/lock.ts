// The Graphify lock shipped with the app is the component's only trust root: every byte the installer
// assembles comes from an archive whose sha256 and size match it. Nothing else (a mirror, an offline
// pack's manifest, an existing directory) is taken on its word.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type LockFile = { file: string; url: string; sha256: string; size: number };
export type LockPython = LockFile & { format: "tar.gz" };
export type LockTarget = { python: LockPython; wheels: LockFile[] };
export type GraphifyLock = {
  schemaVersion: number;
  graphifyy: string;
  python: string;
  cpythonRelease: string;
  targets: Record<string, unknown>;
};

/**
 * Canonical JSON for the lock-hash: object keys sorted by UTF-16 code unit, arrays kept in order, no
 * whitespace, values as JSON.stringify writes them. Must stay byte-identical to `canonicalJson` in
 * scripts/desktop/fetch-graphify.mjs; both test suites assert scripts/desktop/fixtures/lock-hash.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  throw new Error(`Value cannot be part of a lock-hash: ${String(value)}`);
}

/** `<lock-hash>`: sha256 hex of the canonical JSON of one target's python entry and wheels array. */
export function lockHash(target: { python: unknown; wheels: unknown }): string {
  return createHash("sha256").update(canonicalJson({ python: target.python, wheels: target.wheels })).digest("hex");
}

export function totalBytes(target: LockTarget): number {
  return [target.python, ...target.wheels].reduce((sum, entry) => sum + entry.size, 0);
}

/** Hosts a download contacts when no mirror is set; shown before the user confirms. */
export function sourceHosts(target: LockTarget): string[] {
  return [...new Set([target.python, ...target.wheels].map((entry) => new URL(entry.url).host))];
}

/**
 * The lock beside the compiled CLI (`dist/resources`, copied there by the build and checked by desktop
 * staging and the npm stage). Run from source, the repository's own lock. Never a path from the
 * environment: the trust root is what shipped with this program.
 */
export function shippedLockPath(): string {
  const here = fileURLToPath(import.meta.url);
  if (here.endsWith(".ts")) return fileURLToPath(new URL("../../../../scripts/desktop/graphify-lock.json", import.meta.url));
  return fileURLToPath(new URL("../resources/graphify-lock.json", import.meta.url));
}

/**
 * The prebuilt Windows launcher's place next to the shipped lock. Builds that carry it put it there
 * (desktop payload and npm package wiring is a later task); when it is absent a Windows install fails
 * with a named reason instead of compiling anything on the user's machine.
 */
export function shippedWindowsLauncherPath(): string {
  return fileURLToPath(new URL("../resources/graphify-launcher.exe", import.meta.url));
}

export function parseLock(text: string): GraphifyLock {
  const lock = JSON.parse(text.replace(/^﻿/, "")) as Partial<GraphifyLock> | null;
  if (!lock || typeof lock !== "object" || typeof lock.targets !== "object" || lock.targets === null) throw new Error("Graphify lock has no targets");
  if (typeof lock.graphifyy !== "string" || typeof lock.python !== "string") throw new Error("Graphify lock has no versions");
  return lock as GraphifyLock;
}

const PYTHON_VERSION = /^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * The POSIX interpreter name for the lock's `python` version: `3.14.10` -> `python3.14`. The CPython
 * install_only layout names its interpreter (bin/python3.X) and stdlib (lib/python3.X) after the minor
 * line, so the installer derives both from the lock instead of naming a line itself. Anything but a
 * plain `3.<minor>.<patch>` throws; there is no fallback name. Must agree with `pythonInterpreterName`
 * in scripts/desktop/fetch-graphify.mjs; a test keeps them equal.
 */
export function pythonInterpreterName(version: string): string {
  const match = typeof version === "string" ? PYTHON_VERSION.exec(version) : null;
  if (!match) throw new Error(`Graphify lock has a malformed python version: ${JSON.stringify(version)}`);
  return `python3.${match[1]}`;
}

export function readLock(file: string = shippedLockPath()): GraphifyLock {
  return parseLock(readFileSync(file, "utf8"));
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function lockFile(raw: unknown, where: string): LockFile {
  const entry = raw as Partial<LockFile> | null;
  if (!entry || typeof entry !== "object") throw new Error(`${where} is not a lock entry`);
  if (typeof entry.file !== "string" || !SAFE_FILE.test(entry.file) || entry.file.includes("..")) throw new Error(`${where} has an unsafe file name`);
  if (typeof entry.url !== "string" || !/^https?:\/\//.test(entry.url)) throw new Error(`${where} has no http(s) url`);
  if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`${where} has no sha256`);
  if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size <= 0) throw new Error(`${where} has no size; the lock predates on-demand install`);
  return entry as LockFile;
}

/** One target, checked entry by entry. Throws on anything the installer could not pin bytes against. */
export function lockTarget(lock: GraphifyLock, key: string): LockTarget | null {
  const raw = lock.targets[key] as { python?: unknown; wheels?: unknown } | undefined;
  if (raw === undefined) return null;
  const python = lockFile(raw.python, `${key} python`) as LockPython;
  if ((raw.python as { format?: unknown }).format !== "tar.gz") throw new Error(`${key} python archive is not tar.gz`);
  if (!Array.isArray(raw.wheels) || raw.wheels.length === 0) throw new Error(`${key} has no wheels`);
  const wheels = raw.wheels.map((wheel, index) => lockFile(wheel, `${key} wheel ${index}`));
  const names = [python.file, ...wheels.map((wheel) => wheel.file)];
  if (new Set(names).size !== names.length) throw new Error(`${key} repeats a file name`);
  if (!wheels.every((wheel) => wheel.file.endsWith(".whl"))) throw new Error(`${key} lists a wheel that is not a .whl`);
  return { python, wheels };
}

export type PlatformInfo = { platform: NodeJS.Platform; arch: string; musl?: boolean };

let muslCache: boolean | undefined;

/** Linux without a glibc runtime version in Node's diagnostic report is musl (Alpine and friends). */
export function detectMusl(): boolean {
  if (process.platform !== "linux") return false;
  if (muslCache === undefined) {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    muslCache = typeof report?.header?.glibcVersionRuntime !== "string";
  }
  return muslCache;
}

export function currentPlatform(): PlatformInfo {
  return { platform: process.platform, arch: process.arch };
}

export type ResolvedTarget =
  | { ok: true; key: string; target: LockTarget; lockHash: string; totalBytes: number }
  | { ok: false; key: string; detail: string };

/** This machine's lock target, or why there is none. musl Linux is unsupported even though the key exists. */
export function resolveTarget(lock: GraphifyLock, info: PlatformInfo = currentPlatform()): ResolvedTarget {
  const key = `${info.platform}-${info.arch}`;
  if (info.platform === "linux" && (info.musl ?? detectMusl())) {
    return { ok: false, key, detail: "Linux without glibc (musl, e.g. Alpine) is not supported" };
  }
  const target = lockTarget(lock, key);
  if (!target) return { ok: false, key, detail: `No Graphify build is pinned for ${key}` };
  return { ok: true, key, target, lockHash: lockHash(target), totalBytes: totalBytes(target) };
}
