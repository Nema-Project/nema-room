import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { lstat, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionRecord } from "@nema/shared";
import { listResources, readInsideRoot } from "./safeRead.js";

// A per-file list of one Skill folder: every read is checked against it, so a task never mixes files from
// two versions of the same Skill (spec §1). Blob hashes are Git's, so a managed install can reuse the tree.

export type ManifestFile = { path: string; size: number; blob: string; executable: boolean; binary: boolean };
export type SkillManifest = { files: ManifestFile[] };

export const MANIFEST_FILE = ".nema-manifest.json";
/** The install limits (`extensions/install.ts`): a folder over them is not hashed. */
const MAX_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/** Git's own heuristic: a NUL byte in the first 8000 bytes. */
export function isBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8000).includes(0);
}

function validManifest(value: unknown): value is SkillManifest {
  if (!value || typeof value !== "object" || !Array.isArray((value as SkillManifest).files)) return false;
  return (value as SkillManifest).files.every(
    (f) =>
      f && typeof f.path === "string" && typeof f.size === "number" && typeof f.blob === "string" && /^[0-9a-f]{40}$/.test(f.blob) &&
      typeof f.executable === "boolean" && typeof f.binary === "boolean",
  );
}

/** Hashes every regular file under `root`, without following links. */
export async function computeManifest(root: string): Promise<SkillManifest> {
  const { items, truncated } = await listResources(root, { maxItems: MAX_FILES, maxDepth: 16 });
  if (truncated) throw new Error(`more than ${MAX_FILES} files, or folders deeper than 16 levels`);
  const files: ManifestFile[] = [];
  let total = 0;
  for (const rel of items) {
    if (rel === MANIFEST_FILE) continue;
    const read = await readInsideRoot(root, rel, MAX_FILE_BYTES);
    if (!read.ok) throw new Error(`${rel}: ${read.reason}`);
    total += read.bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("larger than 20 MiB in total");
    const stat = await lstat(path.join(root, ...rel.split("/")));
    files.push({
      path: rel,
      size: read.bytes.length,
      blob: gitBlobSha(read.bytes),
      executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0,
      binary: isBinary(read.bytes),
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}

/** Writes a managed folder's manifest in one step; the folder belongs to Nema. */
export async function saveManifest(root: string, manifest: SkillManifest): Promise<void> {
  // Random, so two snapshots saving the same folder at once never pick the same name.
  const temp = path.join(root, `${MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  await rename(temp, path.join(root, MANIFEST_FILE));
}

/**
 * A managed folder's saved manifest, computed and saved the first time (installs before the manifest
 * existed). An external folder belongs to someone else, so it is hashed on every call and never written.
 */
export async function loadManifest(root: string, kind: "managed" | "external"): Promise<SkillManifest> {
  if (kind === "managed") {
    const saved = await readInsideRoot(root, MANIFEST_FILE, 1024 * 1024);
    if (saved.ok) {
      try {
        const parsed = JSON.parse(saved.bytes.toString("utf8")) as unknown;
        if (validManifest(parsed)) return parsed;
      } catch {
        // Recompute below.
      }
    }
    const manifest = await computeManifest(root);
    await saveManifest(root, manifest);
    return manifest;
  }
  return computeManifest(root);
}

/** The version a task reports: the pinned commit for an install, a content hash for an attached folder. */
export function revisionOf(record: ExtensionRecord, manifest: SkillManifest): string {
  if (record.provision !== "external") return record.revision;
  const skill = manifest.files.find((file) => file.path === "SKILL.md");
  return `local@${(skill?.blob ?? "0000000").slice(0, 7)}`;
}
