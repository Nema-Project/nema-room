import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { MAX_DISCOVERED_SKILLS, MAX_SCANNED_ENTRIES, discoverSkills, inspectSkillFolder } from "../../src/extensions/discover.js";
import { bundledExtensions, type ExtensionRecord } from "../../src/extensions/store.js";

let home: string | undefined;
// Permission bits do not stop root, and Windows ignores them.
const canDenyReads = process.platform !== "win32" && process.getuid?.() !== 0;
const denied: string[] = [];

afterEach(() => {
  for (const target of denied.splice(0)) chmodSync(target, 0o700);
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function skill(folder: string, name: string | null, description = "Does a thing"): string {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), name === null ? "# no front matter\n" : `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
  return folder;
}

function external(id: string, externalPath: string): ExtensionRecord {
  return {
    id, kind: "skill", name: id, summary: "s", source: externalPath, revision: "local", provision: "external",
    installState: "installed", useState: "enabled", availability: "ready", externalPath, error: null,
  };
}

test("lists skill folders under the three known locations with their front matter", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  skill(join(home, ".claude", "skills", "tidy"), "Tidy Up", "Keeps things tidy");
  skill(join(home, ".codex", "skills", "lint"), "lint");
  skill(join(home, ".agents", "skills", "notes"), "notes");
  const found = discoverSkills(home, bundledExtensions());
  expect(found.locations.map((location) => [location.label, location.found])).toEqual([["claude", true], ["codex", true], ["agents", true]]);
  expect(found.skills).toEqual([
    { path: join(home, ".claude", "skills", "tidy"), location: "claude", name: "Tidy Up", description: "Keeps things tidy", id: "tidy-up", attached: false, problem: null },
    { path: join(home, ".codex", "skills", "lint"), location: "codex", name: "lint", description: "Does a thing", id: "lint", attached: false, problem: null },
    { path: join(home, ".agents", "skills", "notes"), location: "agents", name: "notes", description: "Does a thing", id: "notes", attached: false, problem: null },
  ]);
  expect(found.truncated).toBe(false);
});

test("a missing location is reported as not found, not as an error", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const found = discoverSkills(home, bundledExtensions());
  expect(found.locations.every((location) => !location.found)).toBe(true);
  expect(found.skills).toEqual([]);
});

test("each folder that cannot be attached says why", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const base = join(home, ".claude", "skills");
  skill(join(base, "a-plain"), null);
  skill(join(base, "b-bad"), "123");
  skill(join(base, "c-bundled"), "grill");
  skill(join(base, "d-taken"), "notes");
  mkdirSync(join(base, "e-empty"));
  writeFileSync(join(base, "f-file.md"), "not a folder");
  const rows = [...bundledExtensions(), external("notes", "/somewhere/else")];
  const problems = discoverSkills(home, rows).skills.map((row) => [basename(row.path), row.problem, row.id]);
  expect(problems).toEqual([
    ["a-plain", "missing-frontmatter", null],
    ["b-bad", "invalid-id", null],
    ["c-bundled", "bundled-id", null],
    ["d-taken", "id-taken", null],
    ["e-empty", "missing-frontmatter", null],
  ]);
});

test("a folder already attached at the same real path is marked attached", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const folder = skill(join(home, ".claude", "skills", "notes"), "notes");
  const [row] = discoverSkills(home, [...bundledExtensions(), external("notes", folder)]).skills;
  expect(row).toMatchObject({ id: "notes", attached: true, problem: null });
});

test("a link that leaves its location is listed with a problem and its SKILL.md is not read", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const outside = skill(join(home, "elsewhere", "secret"), "secret");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(outside, join(home, ".claude", "skills", "secret"), "dir");
  const inside = skill(join(home, ".claude", "skills", "real"), "real");
  symlinkSync(inside, join(home, ".claude", "skills", "alias"), "dir");
  const rows = discoverSkills(home, bundledExtensions()).skills;
  expect(rows.find((row) => row.path.endsWith("secret"))).toMatchObject({ name: null, description: null, id: null, problem: "outside-location" });
  // A link to a folder in the same location resolves to that folder's real path and is listed once.
  expect(rows.filter((row) => row.path === inside)).toEqual([expect.objectContaining({ name: "real", problem: null })]);
});

test("a SKILL.md that is a link out of its folder is not read", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const target = join(home, "private.md");
  writeFileSync(target, "---\nname: leaked\ndescription: x\n---\n");
  const folder = join(home, ".claude", "skills", "leak");
  mkdirSync(folder, { recursive: true });
  symlinkSync(target, join(folder, "SKILL.md"), "file");
  const [row] = discoverSkills(home, bundledExtensions()).skills;
  expect(row).toMatchObject({ name: null, problem: "outside-location" });
});

test("stops after the cap and says the list is truncated", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  for (let i = 0; i < MAX_DISCOVERED_SKILLS + 3; i++) skill(join(home, ".claude", "skills", `s${String(i).padStart(4, "0")}`), `s${i}`);
  const found = discoverSkills(home, bundledExtensions());
  expect(found.skills).toHaveLength(MAX_DISCOVERED_SKILLS);
  expect(found.truncated).toBe(true);
});

test("inspectSkillFolder reads one folder a person typed", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const folder = skill(join(home, "mine"), "Mine");
  expect(inspectSkillFolder(folder)).toEqual({ path: folder, name: "Mine", description: "Does a thing", id: "mine", problem: null });
  expect(inspectSkillFolder(join(home, "nope")).problem).toBe("not-a-folder");
});

test.skipIf(!canDenyReads)("a SKILL.md that cannot be read marks only its folder, and the others are still listed", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const locked = skill(join(home, ".claude", "skills", "a-locked"), "locked");
  skill(join(home, ".claude", "skills", "b-open"), "open");
  chmodSync(join(locked, "SKILL.md"), 0o000);
  denied.push(join(locked, "SKILL.md"));
  const rows = discoverSkills(home, bundledExtensions()).skills;
  expect(rows.map((row) => [basename(row.path), row.problem, row.id])).toEqual([
    ["a-locked", "unreadable", null],
    ["b-open", null, "open"],
  ]);
  expect(inspectSkillFolder(locked).problem).toBe("unreadable");
});

test.skipIf(!canDenyReads)("a location that exists but cannot be listed says so instead of looking empty", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const base = join(home, ".claude", "skills");
  skill(join(base, "notes"), "notes");
  chmodSync(base, 0o000);
  denied.push(base);
  const found = discoverSkills(home, bundledExtensions());
  expect(found.locations[0]).toEqual({ label: "claude", path: base, found: true, unreadable: true });
  expect(found.locations.slice(1).every((location) => location.unreadable === undefined)).toBe(true);
  expect(found.skills).toEqual([]);
});

test("reads at most a bounded number of entries per location and marks the list truncated", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const base = join(home, ".claude", "skills");
  mkdirSync(base, { recursive: true });
  // Plain hidden files: none of them is a skill, so only the scan bound can mark the list truncated.
  for (let i = 0; i <= MAX_SCANNED_ENTRIES; i++) writeFileSync(join(base, `.x${i}`), "");
  const found = discoverSkills(home, bundledExtensions());
  expect(found.skills).toEqual([]);
  expect(found.truncated).toBe(true);
});

test("an attached folder stays attached when its SKILL.md later has a problem", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const folder = join(home, ".claude", "skills", "notes");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), "# front matter removed after attaching\n");
  const [row] = discoverSkills(home, [...bundledExtensions(), external("notes", folder)]).skills;
  expect(row).toMatchObject({ path: folder, attached: true, id: "notes", problem: "missing-frontmatter" });
});

test("a link to a folder whose name starts with two dots stays inside its location", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const base = join(home, ".claude", "skills");
  const target = skill(join(base, "..notes"), "notes");
  symlinkSync(target, join(base, "notes-link"), "dir");
  const rows = discoverSkills(home, bundledExtensions()).skills;
  expect(rows).toEqual([expect.objectContaining({ path: target, name: "notes", problem: null })]);
});

test.skipIf(!canDenyReads)("a location behind a folder that cannot be entered is unreadable, not missing", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  skill(join(home, ".claude", "skills", "notes"), "notes");
  chmodSync(join(home, ".claude"), 0o000);
  denied.push(join(home, ".claude"));
  const found = discoverSkills(home, bundledExtensions());
  expect(found.locations[0]).toEqual({ label: "claude", path: join(home, ".claude", "skills"), found: true, unreadable: true });
  // A location that is simply not there is still reported as not found.
  expect(found.locations[1]).toEqual({ label: "codex", path: join(home, ".codex", "skills"), found: false });
});

test.skipIf(!canDenyReads)("a skill folder that cannot be entered is unreadable, not missing its SKILL.md", () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "nema-discover-")));
  const locked = skill(join(home, ".claude", "skills", "locked"), "locked");
  chmodSync(locked, 0o000);
  denied.push(locked);
  expect(discoverSkills(home, bundledExtensions()).skills).toEqual([expect.objectContaining({ path: locked, problem: "unreadable" })]);
  expect(inspectSkillFolder(locked).problem).toBe("unreadable");
});
