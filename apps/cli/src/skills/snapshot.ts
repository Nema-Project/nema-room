import { existsSync, lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { isReservedSlashName, type ExtensionRecord, type SkillUsage } from "@nema/shared";
import { MAX_SKILL_BYTES } from "../extensions/source.js";
import { openExtensionStore, ownedDirectory } from "../extensions/store.js";
import { parseSkillFile, type SkillMeta } from "./frontmatter.js";
import { skillUsage } from "./gaps.js";
import { gitBlobSha, loadManifest, revisionOf, type ManifestFile, type SkillManifest } from "./manifest.js";
import { normalizeSkillPath, readInsideRoot, type SafeReadFailure } from "./safeRead.js";

// One task's view of its Skills (spec §1): which ones, at which version, file by file. Reads later in
// the task go through `readSnapshotFile`, which re-checks the index and the manifest every time.

export type SnapshotSkill = {
  /** The id the model and the user see: the record id, or a repository Skill's name (prefixed on a clash). */
  id: string;
  source: "managed" | "external" | "repo";
  recordId: string | null;
  /** A repository Skill's place: the repository, its pinned commit, and the Skill's folder in it (e.g. `.agents/skills/tdd`). */
  repo: { repoId: string; label: string; slug: string; path: string; commit: string; dir: string } | null;
  /** The real directory of a managed or external Skill; `null` for a repository Skill (read through git). */
  root: string | null;
  meta: SkillMeta;
  manifest: SkillManifest;
  revision: string;
  usage: SkillUsage;
};

export type SkillSnapshot = { skills: SnapshotSkill[]; warnings: string[] };

/** Bytes of one file in a repository Skill at its pinned commit; supplied by the repository batch. */
export type RepoFileReader = (skill: SnapshotSkill, rel: string, maxBytes: number) => Promise<Buffer>;

export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

function extensionsRoot(nemaHome: string): string {
  return path.join(nemaHome, "extensions");
}

function usable(row: ExtensionRecord): boolean {
  return (
    row.kind === "skill" &&
    (row.provision === "managed" || row.provision === "external") &&
    row.installState === "installed" &&
    row.useState === "enabled" &&
    row.availability === "ready"
  );
}

/** The real directory a record's files live in now, or `null` when it is missing or points elsewhere. */
async function currentRoot(nemaHome: string, row: ExtensionRecord): Promise<string | null> {
  try {
    if (row.provision === "managed") {
      const dir = ownedDirectory(extensionsRoot(nemaHome), row.id);
      return existsSync(dir) && lstatSync(dir).isDirectory() ? dir : null;
    }
    const external = row.externalPath;
    if (!external || !path.isAbsolute(external)) return null;
    if (lstatSync(external).isSymbolicLink()) return null;
    const real = await realpath(external);
    return real === external && lstatSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** One record's Skill as it is on disk now, or the reason it cannot be used. */
async function inspectRow(nemaHome: string, row: ExtensionRecord, claudeCodeOk: boolean): Promise<SnapshotSkill | string> {
  const root = await currentRoot(nemaHome, row);
  if (root === null) return `${row.id}: folder missing or outside its place`;
  let manifest: SkillManifest;
  try {
    manifest = await loadManifest(root, row.provision === "managed" ? "managed" : "external");
  } catch (error) {
    return `${row.id}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const entry = manifest.files.find((file) => file.path === "SKILL.md");
  const read = entry ? await readInsideRoot(root, "SKILL.md", MAX_SKILL_BYTES) : null;
  if (!entry || !read?.ok || gitBlobSha(read.bytes) !== entry.blob) return `${row.id}: SKILL.md unreadable or changed`;
  const parsed = parseSkillFile(read.bytes.toString("utf8"), path.basename(root));
  if (!parsed.ok) return `${row.id}: SKILL.md ${parsed.reason}`;
  return {
    id: row.id,
    source: row.provision === "managed" ? "managed" : "external",
    recordId: row.id,
    repo: null,
    root,
    meta: parsed.meta,
    manifest,
    revision: revisionOf(row, manifest),
    usage: skillUsage({
      meta: parsed.meta,
      body: parsed.body,
      files: manifest.files,
      diagnostics: parsed.diagnostics,
      claudeCodeOk,
      reservedSlash: isReservedSlashName(row.id),
    }),
  };
}

/** The enabled Skills for one task, plus warnings for the ones that could not be read. */
export async function takeSnapshot(o: { nemaHome: string; claudeCodeOk: boolean; repoSkills?: SnapshotSkill[] }): Promise<SkillSnapshot> {
  const rows = openExtensionStore(extensionsRoot(o.nemaHome)).list().filter(usable);
  const skills: SnapshotSkill[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    // One unreadable folder costs only its own Skill.
    const inspected = await inspectRow(o.nemaHome, row, o.claudeCodeOk).catch((error: unknown) => `${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    if (typeof inspected === "string") warnings.push(inspected);
    else skills.push(inspected);
  }
  skills.push(...(o.repoSkills ?? []));
  skills.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { skills, warnings };
}

/**
 * `extensions.list` rows with `skill` filled in on every installed managed or external Skill, enabled or
 * not, so the page can say what works where. A Skill that cannot be read is listed without the field.
 */
export async function withSkillUsage(nemaHome: string, rows: ExtensionRecord[], claudeCodeOk: () => Promise<boolean>): Promise<ExtensionRecord[]> {
  const wanted = (row: ExtensionRecord) => row.kind === "skill" && row.installState === "installed" && (row.provision === "managed" || row.provision === "external");
  if (!rows.some(wanted)) return rows;
  const ok = await claudeCodeOk().catch(() => false);
  return Promise.all(
    rows.map(async (row) => {
      if (!wanted(row)) return row;
      const inspected = await inspectRow(nemaHome, row, ok).catch(() => "unreadable");
      return typeof inspected === "string" ? row : { ...row, skill: inspected.usage };
    }),
  );
}

/** True while the Skill is still installed, enabled and in the same place it was in when the task began. */
export async function stillReadable(nemaHome: string, skill: SnapshotSkill): Promise<boolean> {
  if (skill.source === "repo") return true;
  const row = openExtensionStore(extensionsRoot(nemaHome)).list().find((r) => r.id === skill.recordId);
  if (!row || !usable(row)) return false;
  return (await currentRoot(nemaHome, row)) === skill.root;
}

export type SnapshotReadFailure = SafeReadFailure | "gone" | "not-in-skill";
export type SnapshotRead = { ok: true; bytes: Buffer; file: ManifestFile } | { ok: false; reason: SnapshotReadFailure };

/**
 * One file of a snapshot Skill, checked against the index (still enabled), the folder (same place, no
 * links) and the manifest (same bytes as when the task began).
 */
export async function readSnapshotFile(
  nemaHome: string,
  skill: SnapshotSkill,
  rel: string,
  maxBytes: number,
  readRepoFile?: RepoFileReader,
): Promise<SnapshotRead> {
  const normal = normalizeSkillPath(rel);
  if (normal === null) return { ok: false, reason: "outside" };
  if (!(await stillReadable(nemaHome, skill))) return { ok: false, reason: "gone" };
  const file = skill.manifest.files.find((f) => f.path === normal);
  if (!file) return { ok: false, reason: "not-in-skill" };
  if (file.size > maxBytes) return { ok: false, reason: "too-large" };
  let bytes: Buffer;
  if (skill.source === "repo") {
    if (!readRepoFile) return { ok: false, reason: "gone" };
    try {
      bytes = await readRepoFile(skill, normal, maxBytes);
    } catch {
      return { ok: false, reason: "changed" };
    }
  } else {
    const read = await readInsideRoot(skill.root!, normal, maxBytes);
    if (!read.ok) return read.reason === "too-large" ? read : { ok: false, reason: read.reason === "missing" ? "changed" : read.reason };
    bytes = read.bytes;
  }
  if (gitBlobSha(bytes) !== file.blob) return { ok: false, reason: "changed" };
  return { ok: true, bytes, file };
}
