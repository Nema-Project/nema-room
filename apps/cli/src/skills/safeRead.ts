import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

// Reads inside one Skill directory without following links (spec §2, items 5 and 6). Every check is done
// again after the file is open, so a swap between the check and the open is caught: the bytes come only
// from a descriptor whose device and inode match what the walk saw, under parents that did not change.

export type SafeReadFailure = "outside" | "link" | "not-file" | "too-large" | "changed" | "missing";
export type SafeReadResult = { ok: true; bytes: Buffer } | { ok: false; reason: SafeReadFailure };

/** A relative path inside a Skill, with `/` separators; `null` for anything that could point elsewhere. */
export function normalizeSkillPath(raw: string): string | null {
  if (raw.includes("\0")) return null;
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) return null;
  const parts: string[] = [];
  for (const part of slashed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length === 0 ? null : parts.join("/");
}

type Seen = { path: string; dev: number; ino: number };

const same = (a: Seen, b: Stats) => a.dev === b.dev && a.ino === b.ino;

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

const NOFOLLOW = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/**
 * The bytes of `rel` under `root`, at most `maxBytes`. `root` must be a real path the caller already
 * trusts. `hooks.afterCheck` runs between the walk and the open; only tests use it.
 */
export async function readInsideRoot(
  root: string,
  rel: string,
  maxBytes: number,
  hooks?: { afterCheck?: () => void | Promise<void> },
): Promise<SafeReadResult> {
  const normal = normalizeSkillPath(rel);
  if (normal === null) return { ok: false, reason: "outside" };
  const segments = normal.split("/");

  const rootStat = await lstatOrNull(root);
  if (!rootStat) return { ok: false, reason: "missing" };
  if (rootStat.isSymbolicLink()) return { ok: false, reason: "link" };
  if (!rootStat.isDirectory()) return { ok: false, reason: "not-file" };
  const chain: Seen[] = [{ path: root, dev: rootStat.dev, ino: rootStat.ino }];

  let current = root;
  let last: Stats = rootStat;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]!);
    const stat = await lstatOrNull(current);
    if (!stat) return { ok: false, reason: "missing" };
    if (stat.isSymbolicLink()) return { ok: false, reason: "link" };
    const isLast = i === segments.length - 1;
    if (isLast ? !stat.isFile() : !stat.isDirectory()) return { ok: false, reason: isLast ? "not-file" : "missing" };
    if (!isLast) chain.push({ path: current, dev: stat.dev, ino: stat.ino });
    last = stat;
  }
  if (last.size > maxBytes) return { ok: false, reason: "too-large" };
  const target: Seen = { path: current, dev: last.dev, ino: last.ino };

  await hooks?.afterCheck?.();

  let handle;
  try {
    handle = await open(current, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return { ok: false, reason: "link" };
    if (code === "ENOENT") return { ok: false, reason: "changed" };
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !same(target, opened)) return { ok: false, reason: "changed" };
    for (const seen of chain) {
      const now = await lstatOrNull(seen.path);
      if (!now || now.isSymbolicLink() || !same(seen, now)) return { ok: false, reason: "changed" };
    }
    let real: string;
    try {
      real = await realpath(current);
    } catch {
      return { ok: false, reason: "changed" };
    }
    if (real !== path.join(await realpath(root), ...segments)) return { ok: false, reason: "changed" };
    if (opened.size > maxBytes) return { ok: false, reason: "too-large" };

    const buffer = Buffer.alloc(Math.min(opened.size, maxBytes) + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    if (filled > maxBytes) return { ok: false, reason: "too-large" };
    return { ok: true, bytes: buffer.subarray(0, filled) };
  } finally {
    await handle.close();
  }
}

const SKIPPED = new Set([".git", "node_modules"]);

/** Files under `root`, depth-first in name order, without following links; `.git` and `node_modules` are skipped. */
export async function listResources(root: string, opts: { maxItems: number; maxDepth: number }): Promise<{ items: string[]; truncated: boolean }> {
  const items: string[] = [];
  let truncated = false;
  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIPPED.has(entry.name) || depth >= opts.maxDepth) continue;
        await walk(path.join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile()) {
        if (items.length >= opts.maxItems) {
          truncated = true;
          return;
        }
        items.push(rel);
      }
    }
  }
  await walk(root, "", 0);
  return { items, truncated };
}
