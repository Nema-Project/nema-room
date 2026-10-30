import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { bundledExtensions, type AttachProblem, type DiscoveredSkill, type ExtensionRecord, type SkillDiscovery } from "@nema/shared";
import { MAX_SKILL_BYTES, skillFrontMatter, skillId } from "./source.js";

/** Folders other agents keep their skills in, relative to the home directory. Nema only reads them. */
export const SKILL_LOCATIONS: ReadonlyArray<{ label: string; dir: string }> = [
  { label: "claude", dir: path.join(".claude", "skills") },
  { label: "codex", dir: path.join(".codex", "skills") },
  { label: "agents", dir: path.join(".agents", "skills") },
];

/** Enough for any real collection; a location holding more is listed up to here and marked truncated. */
export const MAX_DISCOVERED_SKILLS = 200;

/**
 * How many entries of one location are read at most. Hidden entries and plain files count too, so a
 * location stuffed with other things cannot make the daemon list and sort all of it.
 */
export const MAX_SCANNED_ENTRIES = 2000;

/** Same cap the GitHub preview uses for one SKILL.md. */
const MAX_SKILL_MD_BYTES = MAX_SKILL_BYTES;

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const BUNDLED_IDS = new Set(bundledExtensions().map((row) => row.id));

export type InspectedSkill = { path: string; name: string | null; description: string | null; id: string | null; problem: AttachProblem | null };

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  // Compare whole components: `..notes` is a folder inside, only `..` itself climbs out.
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function failed(folder: string, problem: AttachProblem): InspectedSkill {
  return { path: folder, name: null, description: null, id: null, problem };
}

/** Read at most the cap plus one byte, so an oversized file is detected without loading it. */
function readCapped(file: string): string | null {
  const fd = openSync(file, "r");
  try {
    if (fstatSync(fd).size > MAX_SKILL_MD_BYTES) return null;
    const buffer = Buffer.alloc(MAX_SKILL_MD_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > MAX_SKILL_MD_BYTES ? null : buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Name, description and id of one skill folder, taken from its `SKILL.md` front matter. Only that
 * file is opened, read up to the size cap, and nothing past the front matter is kept or returned.
 * The path comes back resolved to the folder's real path. A `SKILL.md` that is a link out of
 * the folder is not read.
 */
export function inspectSkillFolder(folder: string): InspectedSkill {
  let real: string;
  try {
    if (!statSync(folder).isDirectory()) return failed(folder, "not-a-folder");
    real = realpathSync(folder);
  } catch {
    return failed(folder, "not-a-folder");
  }
  const file = path.join(real, "SKILL.md");
  try {
    lstatSync(file);
  } catch (error) {
    // Only "no such file" means it is missing; a folder that cannot be entered is unreadable.
    const code = (error as NodeJS.ErrnoException).code;
    return failed(real, code === "ENOENT" || code === "ENOTDIR" ? "missing-frontmatter" : "unreadable");
  }
  try {
    if (lstatSync(file).isSymbolicLink() && !inside(real, realpathSync(file))) return failed(real, "outside-location");
    if (!statSync(file).isFile()) return failed(real, "missing-frontmatter");
  } catch (error) {
    // A dangling link is a missing file; a target that exists but cannot be reached is unreadable.
    const code = (error as NodeJS.ErrnoException).code;
    return failed(real, code === "ENOENT" || code === "ENOTDIR" ? "missing-frontmatter" : "unreadable");
  }
  let text: string | null;
  try {
    text = readCapped(file);
  } catch {
    // One folder whose SKILL.md cannot be opened is that folder's problem, not the whole list's.
    return failed(real, "unreadable");
  }
  if (text === null) return failed(real, "too-large");
  const meta = skillFrontMatter(text);
  if (!meta) return failed(real, "missing-frontmatter");
  const id = skillId(meta.name);
  const problem: AttachProblem | null = !ID.test(id) ? "invalid-id" : BUNDLED_IDS.has(id) ? "bundled-id" : null;
  return { path: real, name: meta.name, description: meta.description, id: problem ? null : id, problem };
}

/**
 * Where an inspected folder stands against the records Nema already has: attached when an external
 * record names this real path (whatever its SKILL.md says now), taken when another record already
 * holds the id.
 */
export function placeSkill(skill: InspectedSkill, records: ExtensionRecord[]): { attached: boolean; problem: AttachProblem | null; id: string | null } {
  // An attached folder stays attached even if its SKILL.md changed since; the problem is still reported.
  const record = records.find((row) => row.provision === "external" && row.externalPath === skill.path);
  if (record) return { attached: true, problem: skill.problem, id: record.id };
  if (skill.problem || !skill.id) return { attached: false, problem: skill.problem, id: null };
  if (records.some((row) => row.id === skill.id)) return { attached: false, problem: "id-taken", id: null };
  return { attached: false, problem: null, id: skill.id };
}

/** Up to `limit` entries of one folder, read one at a time; `more` says the folder held others. */
export function readEntries(folder: string, limit: number): { entries: Dirent[]; more: boolean } {
  const dir = opendirSync(folder);
  const entries: Dirent[] = [];
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (entries.length >= limit) return { entries, more: true };
      entries.push(entry);
    }
    return { entries, more: false };
  } finally {
    dir.closeSync();
  }
}

/**
 * The skill folders directly under each known location in `home`. Only the location listings and
 * each folder's `SKILL.md` are read. A link that leaves its location is listed with a problem and
 * not followed; one that stays inside resolves to its folder and that folder is listed once.
 */
export function discoverSkills(home: string, records: ExtensionRecord[]): SkillDiscovery {
  const locations: SkillDiscovery["locations"] = [];
  const skills: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const location of SKILL_LOCATIONS) {
    const base = path.join(home, location.dir);
    let root: string;
    try {
      if (!statSync(base).isDirectory()) throw Object.assign(new Error("not a folder"), { code: "ENOTDIR" });
      root = realpathSync(base);
    } catch (error) {
      // Only "nothing there" is not found; a location behind a folder that cannot be entered is there
      // but unreadable.
      const code = (error as NodeJS.ErrnoException).code;
      const missing = code === "ENOENT" || code === "ENOTDIR";
      locations.push(missing ? { label: location.label, path: base, found: false } : { label: location.label, path: base, found: true, unreadable: true });
      continue;
    }
    let entries: Dirent[];
    try {
      const read = readEntries(root, MAX_SCANNED_ENTRIES);
      if (read.more) truncated = true;
      entries = read.entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      // It is there but cannot be listed: say so, so the page does not report an empty folder.
      locations.push({ label: location.label, path: base, found: true, unreadable: true });
      continue;
    }
    locations.push({ label: location.label, path: base, found: true });
    for (const entry of entries) {
      // Hidden folders hold an agent's own system skills or tooling, not something to attach.
      if (entry.name.startsWith(".")) continue;
      const full = path.join(root, entry.name);
      let folder = full;
      if (entry.isSymbolicLink()) {
        try {
          folder = realpathSync(full);
        } catch (error) {
          // A dangling link is nothing to list; one whose target cannot be reached is listed, unread.
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          if (skills.length >= MAX_DISCOVERED_SKILLS) { truncated = true; break; }
          skills.push({ path: full, location: location.label, name: null, description: null, id: null, attached: false, problem: "unreadable" });
          continue;
        }
        if (!inside(root, folder)) {
          if (skills.length >= MAX_DISCOVERED_SKILLS) { truncated = true; break; }
          skills.push({ path: full, location: location.label, name: null, description: null, id: null, attached: false, problem: "outside-location" });
          continue;
        }
        try {
          if (!statSync(folder).isDirectory()) continue;
        } catch {
          continue;
        }
      } else if (!entry.isDirectory()) continue;
      if (seen.has(folder)) continue;
      if (skills.length >= MAX_DISCOVERED_SKILLS) { truncated = true; break; }
      seen.add(folder);
      const inspected = inspectSkillFolder(folder);
      const placed = placeSkill(inspected, records);
      skills.push({ path: inspected.path, location: location.label, name: inspected.name, description: inspected.description, ...placed });
    }
  }
  return { locations, skills, truncated };
}
