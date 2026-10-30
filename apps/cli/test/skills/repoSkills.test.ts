import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readRepoSkillFile, repoSlugs, resetRepoFetchTimes, scanProjectSkills, scanRepoSkills, takeTaskSnapshot, type ProjectSkillRepo } from "../../src/skills/repoSkills.js";
import { readSnapshotFile } from "../../src/skills/snapshot.js";
import { managedSkill, skillText } from "./helpers.js";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "nema-repo-skills-")));
  resetRepoFetchTimes();
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env: ENV }).toString().trim();

function put(dir: string, files: Record<string, string | Buffer>) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, ...rel.split("/")), content);
  }
}

function repo(name: string, files: Record<string, string | Buffer>): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  put(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init", "--allow-empty");
  return dir;
}
const commit = (dir: string, files: Record<string, string | Buffer>) => {
  put(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "more");
};
const bound = (path: string, label = "web", repoId = "repo_abcdef123"): ProjectSkillRepo => ({ repoId, label, path, mainBranch: "main" });
const scan = (r: ProjectSkillRepo, now?: number) => scanRepoSkills(r, { slug: "web", claudeCodeOk: true, ...(now !== undefined ? { now } : {}) });

test("Skills under both roots at the main commit; uncommitted ones do not count", async () => {
  const dir = repo("a", {
    ".agents/skills/tdd/SKILL.md": skillText("tdd"),
    ".agents/skills/tdd/references/a.md": "A",
    ".claude/skills/deploy/SKILL.md": skillText("deploy"),
    "skills/other/SKILL.md": skillText("other"),
  });
  put(dir, { ".agents/skills/draft/SKILL.md": skillText("draft"), ".agents/skills/tdd/references/a.md": "changed, not committed" });
  const head = git(dir, "rev-parse", "HEAD");
  const out = await scan(bound(dir));
  expect(out.skills.map((s) => [s.id, s.repo!.dir, s.revision])).toEqual([
    ["tdd", ".agents/skills/tdd", `web@${head.slice(0, 7)}`],
    ["deploy", ".claude/skills/deploy", `web@${head.slice(0, 7)}`],
  ]);
  const tdd = out.skills[0]!;
  expect(tdd.manifest.files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md"]);
  expect((await readRepoSkillFile(tdd, "references/a.md", 1024)).toString()).toBe("A");
  expect(await readSnapshotFile("/nonexistent", tdd, "references/a.md", 1024, readRepoSkillFile)).toMatchObject({ ok: true });
  await expect(readRepoSkillFile(tdd, "../deploy/SKILL.md", 1024)).rejects.toThrow();
});

test("the same name in both roots: .agents/skills wins, with a warning", async () => {
  const dir = repo("a", { ".agents/skills/tdd/SKILL.md": skillText("tdd", "agents"), ".claude/skills/tdd/SKILL.md": skillText("tdd", "claude") });
  const out = await scan(bound(dir));
  expect(out.skills.map((s) => s.meta.description)).toEqual(["agents"]);
  expect(out.warnings.join("\n")).toContain(".claude/skills/tdd 被同仓库的同名 Skill 覆盖");
});

test("links, submodules and more than 500 files are refused", async () => {
  const dir = repo("a", { ".agents/skills/ok/SKILL.md": skillText("ok"), ".agents/skills/linky/SKILL.md": skillText("linky") });
  symlinkSync("/etc/passwd", join(dir, ".agents/skills/linky/pw"));
  const many: Record<string, string> = { ".agents/skills/many/SKILL.md": skillText("many") };
  for (let i = 0; i < 500; i++) many[`.agents/skills/many/f/${i}.md`] = "x";
  commit(dir, many);
  const sub = git(dir, "rev-parse", "HEAD");
  commit(dir, { ".agents/skills/subby/SKILL.md": skillText("subby") });
  git(dir, "update-index", "--add", "--cacheinfo", `160000,${sub},.agents/skills/subby/vendor`);
  git(dir, "commit", "-q", "-m", "submodule");
  const out = await scan(bound(dir));
  expect(out.skills.map((s) => s.id)).toEqual(["ok"]);
  const warnings = out.warnings.join("\n");
  expect(warnings).toContain("linky pw 是符号链接");
  expect(warnings).toContain("超过 500 个文件");
  expect(warnings).toContain("vendor 是子模块");
});

test("binary and 2 MiB files come back byte for byte; over 5 MiB is refused", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff]);
  const big = Buffer.alloc(2 * 1024 * 1024, 7);
  const dir = repo("a", { ".agents/skills/art/SKILL.md": skillText("art"), ".agents/skills/art/logo.png": png, ".agents/skills/art/big.bin": big });
  commit(dir, { ".agents/skills/huge/SKILL.md": skillText("huge"), ".agents/skills/huge/h.bin": Buffer.alloc(5 * 1024 * 1024 + 1) });
  const out = await scan(bound(dir));
  const art = out.skills.find((s) => s.id === "art")!;
  expect(art.manifest.files.find((f) => f.path === "logo.png")!.binary).toBe(true);
  expect((await readRepoSkillFile(art, "logo.png", 1024)).equals(png)).toBe(true);
  expect((await readRepoSkillFile(art, "big.bin", 3 * 1024 * 1024)).equals(big)).toBe(true);
  await expect(readRepoSkillFile(art, "big.bin", 1024 * 1024)).rejects.toThrow();
  expect(out.skills.map((s) => s.id)).not.toContain("huge");
  expect(out.warnings.join("\n")).toContain("超过 5 MiB");
});

test("slugs: label form, reserved names renamed, clashes get the repo id", () => {
  const slugs = repoSlugs([
    { repoId: "repo_aaaaaa1", label: "Web" },
    { repoId: "repo_bbbbbb2", label: "web" },
    { repoId: "repo_c", label: "Diagram" },
    { repoId: "repo_d", label: "skill" },
    { repoId: "repo_e", label: "!!!" },
  ]);
  expect([...slugs.values()]).toEqual(["web-aaaaaa", "web-bbbbbb", "repo-diagram", "repo-skill", "repo"]);
});

test("a name a user Skill or another repository also has gets the slug prefix", async () => {
  const a = repo("a", { ".agents/skills/tdd/SKILL.md": skillText("tdd"), ".agents/skills/solo/SKILL.md": skillText("solo") });
  const b = repo("b", { ".agents/skills/tdd/SKILL.md": skillText("tdd"), ".agents/skills/pdf/SKILL.md": skillText("pdf") });
  const out = await scanProjectSkills([bound(a, "web", "repo_1"), bound(b, "api", "repo_2")], { userIds: new Set(["pdf"]), claudeCodeOk: true });
  expect(out.skills.map((s) => s.id).sort()).toEqual(["api:pdf", "api:tdd", "solo", "web:tdd"]);

  const nemaHome = join(base, "nema");
  managedSkill(nemaHome, "pdf", { "SKILL.md": skillText("pdf") });
  const snapshot = await takeTaskSnapshot({ nemaHome, claudeCodeOk: true, projectSkills: [bound(b, "Diagram", "repo_2")] });
  expect(snapshot.skills.map((s) => s.id)).toEqual(["pdf", "repo-diagram:pdf", "tdd"]);
});

test("origin's new commit is fetched; not again within 5 minutes; a failed fetch keeps the old ref with a warning", async () => {
  const origin = repo("origin", { ".agents/skills/tdd/SKILL.md": skillText("tdd", "v1") });
  const clone = join(base, "clone");
  execFileSync("git", ["clone", "-q", origin, clone], { env: ENV });
  const r = bound(clone);
  expect((await scan(r, 0)).skills[0]!.meta.description).toBe("v1");
  commit(origin, { ".agents/skills/tdd/SKILL.md": skillText("tdd", "v2") });
  expect((await scan(r, 60_000)).skills[0]!.meta.description).toBe("v1");
  expect((await scan(r, 5 * 60_000)).skills[0]!.meta.description).toBe("v2");
  rmSync(origin, { recursive: true, force: true });
  const failed = await scan(r, 20 * 60_000);
  expect(failed.skills[0]!.meta.description).toBe("v2");
  expect(failed.warnings.join("\n")).toContain("取主分支失败");
});

test("a path that no longer holds the bound repository is skipped", async () => {
  const dir = repo("a", { ".agents/skills/tdd/SKILL.md": skillText("tdd") });
  const out = await scan({ ...bound(dir), gitCommonDir: join(base, "elsewhere", ".git") });
  expect(out.skills).toEqual([]);
  expect(out.warnings.join("\n")).toContain("已不是绑定时的那个仓库");
  expect((await scan({ ...bound(dir), gitCommonDir: join(dir, ".git") })).skills).toHaveLength(1);
});
