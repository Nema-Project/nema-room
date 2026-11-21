// Extraction for already-verified component archives. Ported from scripts/desktop/fetch-tools.mjs
// (the CLI package cannot import scripts/): the same refusals of traversal, absolute names, hard links,
// pax metadata and symlink parents, so a pinned archive lands only inside its destination.
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

function safeRelative(name: string): string {
  if (!name || name.includes("\\") || name.includes("\0") || name.includes(":") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  const parts = name.split("/").filter((part) => part && part !== ".");
  if (!parts.length || parts.some((part) => part === "..")) throw new Error(`Unsafe archive traversal path: ${name}`);
  return parts.join(path.sep);
}

function within(root: string, relative: string): string {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe archive path: ${relative}`);
  return target;
}

export async function extractZip(data: Buffer, destination: string): Promise<void> {
  const dest = path.resolve(destination);
  await mkdir(dest, { recursive: true });
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Invalid ZIP: end-of-central-directory not found");
  const count = data.readUInt16LE(eocd + 10);
  let cursor = data.readUInt32LE(eocd + 16);
  const writes: Array<{ rel: string; isDir: boolean; body: Buffer; mode: number }> = [];
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const compSize = data.readUInt32LE(cursor + 20);
    const nameLen = data.readUInt16LE(cursor + 28);
    const extraLen = data.readUInt16LE(cursor + 30);
    const commentLen = data.readUInt16LE(cursor + 32);
    const external = data.readUInt32LE(cursor + 38);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    cursor += 46 + nameLen + extraLen + commentLen;
    const isDir = name.endsWith("/");
    const rel = safeRelative(isDir ? name.slice(0, -1) : name);
    const unixMode = external >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`ZIP symlink entries are not supported: ${name}`);
    if (flags & 1) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid ZIP local header");
    const localNameLen = data.readUInt16LE(localOffset + 26);
    const localExtraLen = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = data.subarray(start, start + compSize);
    const body = isDir ? Buffer.alloc(0) : method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (body === null) throw new Error(`Unsupported ZIP compression method ${method}`);
    writes.push({ rel, isDir, body, mode: unixMode & 0o777 });
  }
  for (const { rel, isDir, body, mode } of writes) {
    const target = within(dest, rel);
    if (isDir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { flag: "wx", mode: mode || 0o644 });
    if (mode & 0o111) await chmod(target, mode & 0o777);
  }
}

function parseOctal(buf: Buffer): number {
  const text = buf.toString("ascii").replace(/\0.*$/, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function tarName(header: Buffer): string {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * The key under which the TAR symlink checks compare absolute paths. Case is folded only where the default
 * filesystem is case-insensitive (Windows, macOS); elsewhere `N/FOO` and `n/foo` are distinct paths, and
 * folding would mistake a case-differing symlink target for a chain.
 */
export function archivePathKey(absolutePath: string, platform: NodeJS.Platform): string {
  return platform === "win32" || platform === "darwin" ? absolutePath.toLowerCase() : absolutePath;
}

export async function extractTarGz(compressed: Buffer, destination: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const key = (absolutePath: string) => archivePathKey(absolutePath, platform);
  const dest = path.resolve(destination);
  await mkdir(dest, { recursive: true });
  const data = gunzipSync(compressed);
  let offset = 0;
  const entries: Array<{ rel: string; dir?: true; body?: Buffer; mode?: number }> = [];
  const links: Array<{ rel: string; link: string }> = [];
  while (offset + 512 <= data.length) {
    const h = data.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    const name = tarName(h);
    const size = parseOctal(h.subarray(124, 136));
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (checksum !== parseOctal(h.subarray(148, 156))) throw new Error(`Invalid TAR header checksum: ${name}`);
    const type = String.fromCharCode(h[156] || 48);
    const dataOffset = offset + 512;
    const body = data.subarray(dataOffset, dataOffset + size);
    if (body.length !== size) throw new Error(`Truncated TAR entry: ${name}`);
    offset = dataOffset + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g" || type === "L" || type === "K") throw new Error(`Unsupported extended TAR metadata entry: ${name}`);
    const normalizedName = name.replace(/\/$/, "");
    if ((normalizedName === "." || normalizedName === "./") && type === "5") continue;
    const rel = safeRelative(normalizedName);
    if (type === "5") entries.push({ rel, dir: true });
    else if (type === "0" || type === "\0" || type === "7") entries.push({ rel, body: Buffer.from(body), mode: parseOctal(h.subarray(100, 108)) });
    else if (type === "2") links.push({ rel, link: h.subarray(157, 257).toString("utf8").replace(/\0.*$/, "") });
    else if (type === "1") throw new Error(`TAR hard links are not supported: ${name}`);
    else throw new Error(`Unsupported TAR entry type ${type}: ${name}`);
  }
  const linkPaths = new Set(links.map(({ rel }) => key(path.resolve(dest, rel))));
  for (const rel of [...entries.map(({ rel }) => rel), ...links.map(({ rel }) => rel)]) {
    for (let parent = path.dirname(rel); parent !== "."; parent = path.dirname(parent)) {
      if (linkPaths.has(key(path.resolve(dest, parent)))) throw new Error(`TAR symlink parent is not supported: ${rel}`);
    }
  }
  // Regular files first, so no archive symlink can redirect a later write.
  for (const entry of entries) {
    const target = within(dest, entry.rel);
    if (entry.dir) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.body!, { flag: "wx", mode: entry.mode || 0o644 });
    if (entry.mode! & 0o111) await chmod(target, entry.mode! & 0o777);
  }
  for (const { rel, link } of links) {
    if (!link || path.isAbsolute(link) || /^[A-Za-z]:/.test(link) || link.includes("\\")) throw new Error(`Unsafe TAR symlink: ${rel}`);
    const target = path.resolve(dest, path.dirname(rel), link);
    if (target !== dest && !target.startsWith(`${dest}${path.sep}`)) throw new Error(`Unsafe TAR symlink traversal: ${rel}`);
    for (let parent = target; parent !== dest; parent = path.dirname(parent)) {
      if (linkPaths.has(key(parent))) throw new Error(`TAR symlink chain is not supported: ${rel}`);
    }
    await mkdir(path.dirname(within(dest, rel)), { recursive: true });
    await symlink(link, within(dest, rel));
  }
}
