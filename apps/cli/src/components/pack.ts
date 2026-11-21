// Offline component packs (`.nema-component`): a plain tar of the lock's original archives, byte for byte as
// downloaded, under `archives/`, plus `manifest.json`. The manifest is an untrusted index: its claims are
// checked against the shipped lock and its contents never vouch for a byte. Import takes only the archives,
// verifies them against the shipped lock, and assembles them through the same installer path as an online
// install. Anything else in a pack (a prebuilt directory, a script, a link) is ignored and never executed.
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { downloadArchives, installFromSource, verifyArchives, type ArchiveSource, type InstallHooks, type InstallOptions } from "./install.js";
import { readLock, resolveTarget, shippedLockPath, type LockFile, type LockTarget } from "./lock.js";
import { assertComponent, isOffline, type ComponentEnv } from "./store.js";
import { ComponentInstallError, type ComponentName, type ComponentStatus, type InstallProgress } from "./types.js";

export const PACK_EXTENSION = ".nema-component";
export const PACK_FORMAT = "nema-component-pack/1";
const MANIFEST = "manifest.json";
const ARCHIVES = "archives";
const BLOCK = 512;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PAX_BYTES = 64 * 1024;

/** Everything a manifest may say. None of it is trusted; import checks each claim against the shipped lock. */
export type PackManifest = {
  format: typeof PACK_FORMAT;
  component: ComponentName;
  /** Lock target key, e.g. linux-x64. */
  target: string;
  /** The lock-hash the maker computed. Import recomputes it from the shipped lock and compares. */
  lockHash: string;
  tool: { name: "nema"; version: string };
  /** File names and sizes, for display only: import compares the pack's archives with the lock, not with this. */
  archives: Array<{ file: string; size: number }>;
};

/** A pack that does not match the shipped lock or is not a readable pack. Nothing was changed. */
export class PackRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackRejectedError";
  }
}

const lockEntries = (target: LockTarget): LockFile[] => [target.python, ...target.wheels];

const exists = (file: string) => lstat(file).then(() => true, () => false);

// --- tar writing -------------------------------------------------------------------------------------------

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, size: number, type: "0" | "x"): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, "utf8");
  h.write(octal(0o644, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(size, 12), 124, "ascii");
  h.write(octal(0, 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write(type, 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return h;
}

/** A pax `path` record, for names longer than the 100-byte ustar field. */
function paxPath(name: string): Buffer {
  const body = ` path=${name}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
  return Buffer.from(`${length}${body}`);
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

async function writeEntryHeader(fh: FileHandle, name: string, size: number): Promise<void> {
  if (Buffer.byteLength(name) > 100) {
    const record = paxPath(name);
    await fh.write(Buffer.concat([header("PaxHeader", record.length, "x"), record, padding(record.length)]));
    await fh.write(header(`${ARCHIVES}/long-name`, size, "0"));
    return;
  }
  await fh.write(header(name, size, "0"));
}

async function writePack(file: string, manifest: PackManifest, archivesDir: string): Promise<void> {
  const fh = await open(file, "wx");
  try {
    const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeEntryHeader(fh, MANIFEST, body.length);
    await fh.write(Buffer.concat([body, padding(body.length)]));
    for (const { file: name, size } of manifest.archives) {
      await writeEntryHeader(fh, `${ARCHIVES}/${name}`, size);
      let written = 0;
      for await (const chunk of createReadStream(path.join(archivesDir, name))) {
        await fh.write(chunk as Buffer);
        written += (chunk as Buffer).length;
      }
      if (written !== size) throw new Error(`${name} changed while it was packed`);
      await fh.write(padding(size));
    }
    await fh.write(Buffer.alloc(BLOCK * 2));
  } finally {
    await fh.close();
  }
}

// --- tar reading -------------------------------------------------------------------------------------------

type TarEntry = { name: string; type: string; size: number; offset: number };

function parseOctal(field: Buffer, what: string): number {
  if (field[0]! & 0x80) throw new PackRejectedError(`The pack uses a binary ${what} field this reader does not accept`);
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new PackRejectedError(`The pack has an invalid ${what} field`);
  return Number.parseInt(text, 8);
}

function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(body.subarray(at, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= 0 || at + length > body.length) throw new PackRejectedError("The pack has a malformed pax header");
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

/** Headers of every entry, without reading bodies. Pax and GNU long names apply to the entry after them. */
async function readEntries(fh: FileHandle): Promise<TarEntry[]> {
  const total = (await fh.stat()).size;
  const entries: TarEntry[] = [];
  const block = Buffer.alloc(BLOCK);
  let pos = 0;
  let pending: { path?: string; size?: number } = {};
  const readBody = async (offset: number, size: number): Promise<Buffer> => {
    if (size > MAX_PAX_BYTES) throw new PackRejectedError("The pack has an oversized metadata entry");
    if (offset + size > total) throw new PackRejectedError("The pack is truncated");
    const body = Buffer.alloc(size);
    await fh.read(body, 0, size, offset);
    return body;
  };
  for (;;) {
    if (pos + BLOCK > total) throw new PackRejectedError("The pack is truncated (no end-of-archive marker)");
    await fh.read(block, 0, BLOCK, pos);
    if (block.every((byte) => byte === 0)) return entries;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (sum !== parseOctal(block.subarray(148, 156), "checksum")) throw new PackRejectedError("The pack is not a valid tar file (header checksum)");
    const name = block.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = block.subarray(257, 263).toString("ascii") === "ustar\0" ? block.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "") : "";
    const type = String.fromCharCode(block[156] || 48);
    let size = parseOctal(block.subarray(124, 136), "size");
    const offset = pos + BLOCK;
    if (type === "x") {
      const pax = parsePax(await readBody(offset, size));
      pending = {
        ...(pax.path !== undefined ? { path: pax.path } : {}),
        ...(pax.size !== undefined && /^\d+$/.test(pax.size) ? { size: Number(pax.size) } : {}),
      };
    } else if (type === "L") {
      pending = { ...pending, path: (await readBody(offset, size)).toString("utf8").replace(/\0.*$/s, "") };
    } else if (type === "g") {
      // Global pax defaults carry nothing this reader uses.
    } else {
      if (pending.size !== undefined) size = pending.size;
      entries.push({ name: pending.path ?? (prefix ? `${prefix}/${name}` : name), type, size, offset });
      pending = {};
    }
    if (offset + size > total) throw new PackRejectedError("The pack is truncated");
    pos = offset + Math.ceil(size / BLOCK) * BLOCK;
  }
}

const isRegular = (entry: TarEntry) => entry.type === "0" || entry.type === "\0" || entry.type === "7";

type PackContents = { manifest: unknown; archives: Map<string, TarEntry>; ignored: string[] };

/**
 * Sort a pack's entries: `manifest.json`, regular files directly under `archives/`, and everything else,
 * which is listed as ignored and never written anywhere. A repeated archive or manifest is refused.
 */
async function readPackContents(fh: FileHandle): Promise<PackContents> {
  const archives = new Map<string, TarEntry>();
  const ignored: string[] = [];
  let manifestEntry: TarEntry | null = null;
  for (const entry of await readEntries(fh)) {
    const name = entry.name.replace(/^(\.\/)+/, "");
    if (name === MANIFEST && isRegular(entry)) {
      if (manifestEntry) throw new PackRejectedError("The pack has more than one manifest.json");
      manifestEntry = entry;
      continue;
    }
    const parts = name.split("/");
    if (parts.length === 2 && parts[0] === ARCHIVES && parts[1] && isRegular(entry)) {
      if (archives.has(parts[1])) throw new PackRejectedError(`The pack has ${parts[1]} more than once`);
      archives.set(parts[1], entry);
      continue;
    }
    const directoryOfArchives = (name === ARCHIVES || name === `${ARCHIVES}/`) && entry.type === "5";
    if (name !== "" && name !== "." && !directoryOfArchives) ignored.push(name);
  }
  if (!manifestEntry) throw new PackRejectedError("The pack has no manifest.json");
  if (manifestEntry.size > MAX_MANIFEST_BYTES) throw new PackRejectedError("The pack's manifest.json is too large");
  const body = Buffer.alloc(manifestEntry.size);
  await fh.read(body, 0, body.length, manifestEntry.offset);
  let manifest: unknown;
  try {
    manifest = JSON.parse(body.toString("utf8"));
  } catch {
    throw new PackRejectedError("The pack's manifest.json is not valid JSON");
  }
  return { manifest, archives, ignored };
}

// --- pack ----------------------------------------------------------------------------------------------------

export type PackOptions = {
  /** The pack file to write. Defaults to `<name>-<target>-<lock-hash prefix>.nema-component` in `dir`. */
  output?: string;
  /** Directory for the default file name; defaults to the working directory. */
  dir?: string;
  env?: ComponentEnv;
  hooks?: InstallHooks;
  signal?: AbortSignal;
  onProgress?: (progress: InstallProgress) => void;
  /** The maker's version, recorded in the manifest. */
  toolVersion: string;
};

export type PackResult = { file: string; manifest: PackManifest; bytes: number };

/** Where `packComponent` writes by default, for the confirmation line. */
export function defaultPackName(name: ComponentName, key: string, lockHash: string): string {
  return `${name}-${key}-${lockHash.slice(0, 12)}${PACK_EXTENSION}`;
}

/**
 * Download this platform's archives as the lock pins them (mirrors, proxy and CA as for an install), check
 * each against the lock's sha256 and size, and write them unchanged into a pack. Nothing is assembled here.
 */
export async function packComponent(name: string, o: PackOptions): Promise<PackResult> {
  assertComponent(name);
  const env = o.env ?? {};
  const resolved = resolveTarget(readLock(env.lockPath ?? shippedLockPath()), env.platform);
  if (!resolved.ok) throw new ComponentInstallError("unsupported-platform", resolved.detail);
  if (isOffline(env)) throw new ComponentInstallError("offline", "Downloads are turned off (NEMA_GRAPHIFY_OFFLINE or components.offline); make the pack on a machine that may download");
  const { target, lockHash, key, totalBytes } = resolved;
  const output = path.resolve(o.output ?? path.join(o.dir ?? process.cwd(), defaultPackName(name, key, lockHash)));
  if (await exists(output)) throw new Error(`${output} already exists; choose another --output`);
  const work = await mkdtemp(path.join(os.tmpdir(), "nema-component-pack-"));
  const partial = `${output}.partial-${randomBytes(4).toString("hex")}`;
  try {
    const archivesDir = path.join(work, ARCHIVES);
    await mkdir(archivesDir);
    const progress: InstallProgress = { phase: "download", downloadedBytes: 0, totalBytes, file: null };
    const emit = (update: Partial<InstallProgress>) => {
      Object.assign(progress, update);
      o.onProgress?.({ ...progress });
    };
    await downloadArchives({
      archivesDir,
      target,
      env: env.env ?? process.env,
      signal: o.signal,
      hooks: o.hooks ?? {},
      progress: emit,
      addBytes: (bytes) => emit({ downloadedBytes: progress.downloadedBytes + bytes }),
    });
    await verifyArchives(archivesDir, target, (file) => emit({ phase: "verify", file }));
    const manifest: PackManifest = {
      format: PACK_FORMAT,
      component: name,
      target: key,
      lockHash,
      tool: { name: "nema", version: o.toolVersion },
      archives: lockEntries(target).map(({ file, size }) => ({ file, size })),
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writePack(partial, manifest, archivesDir);
    if (await exists(output)) throw new Error(`${output} already exists; choose another --output`);
    await rename(partial, output);
    return { file: output, manifest, bytes: (await lstat(output)).size };
  } finally {
    await rm(partial, { force: true });
    await rm(work, { recursive: true, force: true });
  }
}

// --- import --------------------------------------------------------------------------------------------------

export type ImportOptions = Omit<InstallOptions, "confirm"> & {
  /** Called once the pack passed the manifest and archive-set checks, before anything is written. */
  onAccepted?: (info: { lockHash: string; target: string; ignored: string[] }) => void;
};

export type ImportResult = { status: ComponentStatus; ignored: string[] };

/** Check every manifest claim against the shipped lock. The manifest's hashes, if any, are never read. */
function checkManifest(raw: unknown, name: ComponentName, key: string, lockHash: string): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PackRejectedError("The pack's manifest.json is not an object");
  const manifest = raw as Record<string, unknown>;
  if (manifest.format !== PACK_FORMAT) throw new PackRejectedError(`The pack's format is ${JSON.stringify(manifest.format)}, not ${PACK_FORMAT}`);
  if (manifest.component !== name) throw new PackRejectedError(`The pack is for component ${JSON.stringify(manifest.component)}, not ${name}`);
  if (manifest.target !== key) throw new PackRejectedError(`The pack is for target ${JSON.stringify(manifest.target)}; this machine needs ${key}`);
  if (manifest.lockHash !== lockHash) {
    throw new PackRejectedError(`The pack's lock-hash ${JSON.stringify(manifest.lockHash)} is not this Nema build's ${lockHash}; make the pack with the same Nema version`);
  }
}

/** The pack's archive set must be exactly the lock target's, each with the pinned size. sha256 is checked during the install. */
function checkArchiveSet(archives: Map<string, TarEntry>, target: LockTarget): void {
  const wanted = lockEntries(target);
  const names = new Set(wanted.map((entry) => entry.file));
  const missing = wanted.filter((entry) => !archives.has(entry.file)).map((entry) => entry.file);
  const extra = [...archives.keys()].filter((file) => !names.has(file));
  if (missing.length || extra.length) {
    throw new PackRejectedError(`The pack's archives differ from the lock (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`);
  }
  for (const entry of wanted) {
    const size = archives.get(entry.file)!.size;
    if (size !== entry.size) throw new PackRejectedError(`${entry.file} is ${size} bytes in the pack; the lock says ${entry.size}`);
  }
}

/**
 * Import an offline pack. The shipped lock decides: the manifest's component, target and lock-hash must
 * equal what this build computes, and the pack's archives must be exactly the lock target's. The archives
 * are then copied into staging and go through the online install's own verify, assemble, self-check and
 * activate path, offline. A rejected pack changes nothing; a pack whose archive bytes do not match the
 * lock fails inside the install like a bad download (`hash-mismatch`) and never becomes active.
 */
export async function importComponent(name: string, file: string, o: ImportOptions = {}): Promise<ImportResult> {
  assertComponent(name);
  const env = o.env ?? {};
  const resolved = resolveTarget(readLock(env.lockPath ?? shippedLockPath()), env.platform);
  if (!resolved.ok) throw new ComponentInstallError("unsupported-platform", resolved.detail);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) throw new PackRejectedError(`${file} is not a file`);
  const fh = await open(file, "r");
  try {
    const { manifest, archives, ignored } = await readPackContents(fh);
    checkManifest(manifest, name, resolved.key, resolved.lockHash);
    checkArchiveSet(archives, resolved.target);
    o.onAccepted?.({ lockHash: resolved.lockHash, target: resolved.key, ignored });
    // Copies only the archive members the lock names; nothing else in the pack is ever written out.
    const source: ArchiveSource = async ({ archivesDir, target, signal, progress, addBytes }) => {
      for (const entry of lockEntries(target)) {
        const member = archives.get(entry.file)!;
        progress({ phase: "download", file: entry.file });
        await pipeline(
          createReadStream("", { fd: fh, start: member.offset, end: member.offset + member.size - 1, autoClose: false }),
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              addBytes(chunk.length);
              yield chunk;
            }
          },
          createWriteStream(path.join(archivesDir, entry.file), { flags: "wx" }),
          { signal },
        );
      }
    };
    // Importing a pack is an explicit install of its contents: `force` makes it repair an installed
    // copy of the same version (a damaged tree is replaced; an intact one is reused by activation),
    // which is also the only repair path while downloads are off.
    const status = await installFromSource(name, source, { ...o, env, allowOffline: true, force: true });
    return { status, ignored };
  } finally {
    await fh.close();
  }
}
