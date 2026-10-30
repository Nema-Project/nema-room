import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareClaudeLaunch } from "../../src/claude/launch.js";
import { CLAUDE_SKILL_SETTINGS, prepareClaudeSkills } from "../../src/skills/claudeSkills.js";
import { takeSnapshot, type SnapshotSkill } from "../../src/skills/snapshot.js";
import { COMMIT, managedSkill, skillText } from "./helpers.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "nema-claude-skills-")));
  const nemaHome = join(root, "nema");
  const runDir = join(root, "run");
  mkdirSync(runDir, { recursive: true });
  return { nemaHome, runDir };
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split("\\").join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

test("enabled Skills are copied under work/.claude/skills, plugin folders and links left out", async () => {
  const { nemaHome, runDir } = setup();
  const tdd = managedSkill(nemaHome, "tdd", {
    "SKILL.md": skillText("tdd"),
    "references/a.md": "A",
    ".claude-plugin/plugin.json": "{}",
  });
  symlinkSync(join(root, "secret"), join(tdd, "linked.md"));
  writeFileSync(join(root, "secret"), "do not copy");
  managedSkill(nemaHome, "pdf", { "SKILL.md": skillText("pdf") });
  const snapshot = await takeSnapshot({ nemaHome, claudeCodeOk: true });

  const prep = await prepareClaudeSkills({ nemaHome, runDir, snapshot });

  expect(prep.copied).toEqual(["pdf", "tdd"]);
  expect(prep.skipped).toEqual([]);
  expect(prep.addDirs).toEqual([]);
  expect(tree(join(runDir, "work"))).toEqual([".claude/skills/pdf/SKILL.md", ".claude/skills/tdd/SKILL.md", ".claude/skills/tdd/references/a.md"]);
  expect(readFileSync(join(runDir, "work", ".claude", "skills", "tdd", "references", "a.md"), "utf8")).toBe("A");
  expect(prep.skillDirs.get("tdd")).toBe(join(runDir, "work", ".claude", "skills", "tdd", "SKILL.md"));
  expect(readFileSync(prep.settingsPath, "utf8")).toBe(JSON.stringify(CLAUDE_SKILL_SETTINGS));
  expect(prep.settingsPath).toBe(join(runDir, "claude-settings.json"));
  if (process.platform !== "win32") {
    expect(statSync(prep.settingsPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(runDir, "work", ".claude", "skills", "tdd", "SKILL.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(runDir, "work", ".claude", "skills", "tdd", "references")).mode & 0o777).toBe(0o700);
  }
});

test("the settings are the fixed ones from the spec", () => {
  expect(JSON.stringify(CLAUDE_SKILL_SETTINGS)).toBe(
    '{"permissions":{"blockReadsOutsideWorkingDirectories":true,"deny":["Read(//**/.git/**)"]},"disableSkillShellExecution":true,"disableAllHooks":true}',
  );
});

test("a Skill over the budget, or changed since the snapshot, is skipped whole", async () => {
  const { nemaHome, runDir } = setup();
  managedSkill(nemaHome, "big", { "SKILL.md": skillText("big"), "data.txt": "x".repeat(4000) });
  const changed = managedSkill(nemaHome, "moved", { "SKILL.md": skillText("moved"), "notes.md": "before" });
  managedSkill(nemaHome, "small", { "SKILL.md": skillText("small") });
  const snapshot = await takeSnapshot({ nemaHome, claudeCodeOk: true });
  writeFileSync(join(changed, "notes.md"), "after");

  const prep = await prepareClaudeSkills({ nemaHome, runDir, snapshot, budgetBytes: 1000 });

  expect(prep.copied).toEqual(["small"]);
  expect(prep.skipped).toEqual([
    { id: "big", reason: "budget" },
    { id: "moved", reason: "changed" },
  ]);
  expect(tree(join(runDir, "work"))).toEqual([".claude/skills/small/SKILL.md"]);
});

test("repository Skills go under repo-skills/<slug>; a bad slug writes nothing outside the run dir", async () => {
  const { nemaHome, runDir } = setup();
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const base = (await takeSnapshot({ nemaHome, claudeCodeOk: true })).skills[0]!;
  const repoSkill = (slug: string, id: string): SnapshotSkill => ({
    ...base,
    id,
    source: "repo",
    root: null,
    repo: { repoId: "r1", label: "web", slug, path: "/src/web", commit: COMMIT },
  });
  const files: Record<string, string> = { "SKILL.md": skillText("tdd") };
  const readRepoFile = async (_skill: SnapshotSkill, rel: string) => Buffer.from(files[rel]!);

  const prep = await prepareClaudeSkills({
    nemaHome,
    runDir,
    snapshot: { skills: [repoSkill("web-abc123", "web-abc123:tdd"), repoSkill("../x", "x:tdd")], warnings: [] },
    readRepoFile,
  });

  expect(prep.copied).toEqual(["web-abc123:tdd"]);
  expect(prep.skipped).toEqual([{ id: "x:tdd", reason: "unreadable" }]);
  expect(prep.addDirs).toEqual([join(runDir, "repo-skills", "web-abc123")]);
  expect(tree(join(runDir, "repo-skills"))).toEqual(["web-abc123/.claude/skills/tdd/SKILL.md"]);
  expect(tree(root).filter((p) => !p.startsWith("run/") && !p.startsWith("nema/"))).toEqual([]);
});

test("after prepareClaudeLaunch the copies and settings stay; a missing run dir throws", async () => {
  const { nemaHome } = setup();
  managedSkill(nemaHome, "tdd", { "SKILL.md": skillText("tdd") });
  const snapshot = await takeSnapshot({ nemaHome, claudeCodeOk: true });
  await expect(prepareClaudeSkills({ nemaHome, runDir: join(nemaHome, "run", "t1"), snapshot })).rejects.toThrow(/run dir/);

  const launch = prepareClaudeLaunch({
    nemaHome, taskId: "t1", hubUrl: "http://hub", runToken: "rt", token: "tok", cliEntry: "/cli.js", execPath: "/node", parentEnv: {},
  });
  const prep = await prepareClaudeSkills({ nemaHome, runDir: launch.runDir, snapshot });
  expect(existsSync(join(launch.runDir, "work", ".claude", "skills", "tdd", "SKILL.md"))).toBe(true);
  expect(existsSync(prep.settingsPath)).toBe(true);
  expect(existsSync(launch.mcpPath)).toBe(true);
});
