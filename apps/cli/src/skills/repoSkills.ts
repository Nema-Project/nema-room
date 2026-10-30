import { realpath } from "node:fs/promises";
import { isReservedSlashName, isSkillName } from "@nema/shared";
import { skillId } from "../extensions/source.js";
import { fetchMain, gitRaw, gitText, mainRef } from "../repos/git.js";
import { parseSkillFile } from "./frontmatter.js";
import { skillUsage } from "./gaps.js";
import { isBinary, type ManifestFile } from "./manifest.js";
import { normalizeSkillPath } from "./safeRead.js";
import { takeSnapshot, type SkillSnapshot, type SnapshotSkill } from "./snapshot.js";

// Project Skills from trusted repositories (spec §7, D-4). Everything is read from git objects at the
// main branch's commit, pinned for the task; the working tree is never read.

export type ProjectSkillRepo = { repoId: string; label: string; path: string; mainBranch: string; gitCommonDir?: string };

const SKILL_ROOTS = [".agents/skills", ".claude/skills"] as const;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_MD_BYTES = 256 * 1024;
export const FETCH_INTERVAL_MS = 5 * 60 * 1000;

const LINK = "120000";
const SUBMODULE = "160000";

type TreeRow = { mode: string; type: string; sha: string; size: number | null; path: string };

/** `git ls-tree -z [-l]` rows. */
function parseTree(buf: Buffer): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const entry of buf.toString("utf8").split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", type = "", sha = "", size] = entry.slice(0, tab).split(/ +/);
    rows.push({ mode, type, sha, size: size === undefined || size === "-" ? null : Number(size), path: entry.slice(tab + 1) });
  }
  return rows;
}

/**
 * One slug per repository for this task: the label in Skill-name form, `repo-diagram` instead of
 * `diagram` and `repo-skill` instead of `skill` (both are reserved `/` prefixes), `repo` when empty, and
 * `-<first 6 of the repo id>` on both when two repositories end up with the same one.
 */
export function repoSlugs(repos: Array<{ repoId: string; label: string }>): Map<string, string> {
  const base = new Map<string, string>();
  for (const repo of repos) {
    let slug = skillId(repo.label).slice(0, 50).replace(/-+$/, "");
    if (slug === "diagram" || slug === "skill") slug = `repo-${slug}`;
    if (!slug) slug = "repo";
    base.set(repo.repoId, slug);
  }
  const counts = new Map<string, number>();
  for (const slug of base.values()) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const [repoId, slug] of base) {
    const suffix = skillId(repoId.replace(/^repo_/, "")).slice(0, 6).replace(/-+$/, "") || "x";
    out.set(repoId, (counts.get(slug) ?? 0) > 1 ? `${slug}-${suffix}` : slug);
  }
  return out;
}

const lastFetch = new Map<string, number>();

/** For tests: forget when each repository was last fetched. */
export function resetRepoFetchTimes(): void {
  lastFetch.clear();
}

async function sameRepository(repo: ProjectSkillRepo): Promise<boolean> {
  if (!repo.gitCommonDir) return true;
  try {
    const raw = await gitText(repo.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const [now, then] = await Promise.all([realpath(raw), realpath(repo.gitCommonDir).catch(() => repo.gitCommonDir!)]);
    return now === then;
  } catch {
    return false;
  }
}

/** Where a Skill lives in the tree; the first root wins a name both have. */
type Found = { name: string; dir: string; files: TreeRow[] } | { name: string; dir: string; problem: string };

async function listSkillDirs(repo: ProjectSkillRepo, commit: string): Promise<{ found: Found[]; warnings: string[] }> {
  const found: Found[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const root of SKILL_ROOTS) {
    let top: TreeRow[];
    try {
      top = parseTree(await gitRaw(repo.path, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", `${root}/`]));
    } catch {
      continue;
    }
    for (const row of top) {
      const name = row.path.slice(root.length + 1);
      if (row.type !== "tree") continue;
      const dir = `${root}/${name}`;
      if (seen.has(name)) {
        warnings.push(`${repo.label}：${dir} 被同仓库的同名 Skill 覆盖`);
        continue;
      }
      seen.add(name);
      if (!isSkillName(name)) {
        found.push({ name, dir, problem: "名字不符合 Skill 命名规则" });
        continue;
      }
      const files = parseTree(await gitRaw(repo.path, ["--literal-pathspecs", "ls-tree", "-r", "-z", "-l", commit, "--", `${dir}/`]));
      found.push({ name, dir, files });
    }
  }
  return { found, warnings };
}

const binaryByBlob = new Map<string, boolean>();

async function manifestOf(repo: ProjectSkillRepo, dir: string, rows: TreeRow[]): Promise<ManifestFile[] | string> {
  if (rows.length > MAX_FILES) return `超过 ${MAX_FILES} 个文件`;
  const files: ManifestFile[] = [];
  let total = 0;
  for (const row of rows) {
    const rel = row.path.slice(dir.length + 1);
    if (row.mode === LINK) return `${rel} 是符号链接`;
    if (row.mode === SUBMODULE || row.type === "commit") return `${rel} 是子模块`;
    if (row.type !== "blob" || row.size === null || normalizeSkillPath(rel) !== rel) return `${rel} 无法读取`;
    if (row.size > MAX_FILE_BYTES) return `${rel} 超过 5 MiB`;
    total += row.size;
    if (total > MAX_TOTAL_BYTES) return "合计超过 20 MiB";
    let binary = binaryByBlob.get(row.sha);
    if (binary === undefined) {
      binary = isBinary(await gitRaw(repo.path, ["cat-file", "blob", row.sha]));
      binaryByBlob.set(row.sha, binary);
    }
    files.push({ path: rel, size: row.size, blob: row.sha, executable: row.mode === "100755", binary });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

/** One repository's Skills at its main commit, ids not yet prefixed. */
export async function scanRepoSkills(
  repo: ProjectSkillRepo,
  o: { slug: string; claudeCodeOk: boolean; now?: number },
): Promise<{ skills: SnapshotSkill[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (!(await sameRepository(repo))) return { skills: [], warnings: [`${repo.label}：仓库位置已不是绑定时的那个仓库，跳过它的 Skills`] };
  const now = o.now ?? Date.now();
  const last = lastFetch.get(repo.path);
  if (last === undefined || now - last >= FETCH_INTERVAL_MS) {
    lastFetch.set(repo.path, now);
    const fetched = await fetchMain(repo.path, repo.mainBranch);
    if (!fetched.ok) warnings.push(`${repo.label}：取主分支失败，使用已有的提交（${fetched.error}）`);
  }
  let commit: string;
  try {
    commit = await gitText(repo.path, ["rev-parse", "--verify", `${await mainRef(repo.path, repo.mainBranch)}^{commit}`]);
  } catch {
    return { skills: [], warnings: [...warnings, `${repo.label}：找不到主分支 ${repo.mainBranch}`] };
  }
  const listed = await listSkillDirs(repo, commit);
  warnings.push(...listed.warnings);
  const skills: SnapshotSkill[] = [];
  for (const entry of listed.found) {
    if ("problem" in entry) {
      warnings.push(`${repo.label}：${entry.dir} ${entry.problem}`);
      continue;
    }
    const manifest = await manifestOf(repo, entry.dir, entry.files);
    if (typeof manifest === "string") {
      warnings.push(`${repo.label}：${entry.dir} ${manifest}，已拒绝`);
      continue;
    }
    const skillMd = manifest.find((f) => f.path === "SKILL.md");
    if (!skillMd || skillMd.size > MAX_SKILL_MD_BYTES) {
      warnings.push(`${repo.label}：${entry.dir} 没有可读的 SKILL.md`);
      continue;
    }
    const parsed = parseSkillFile((await gitRaw(repo.path, ["cat-file", "blob", skillMd.blob])).toString("utf8"), entry.name);
    if (!parsed.ok) {
      warnings.push(`${repo.label}：${entry.dir}/SKILL.md ${parsed.reason}`);
      continue;
    }
    skills.push({
      id: entry.name,
      source: "repo",
      recordId: null,
      repo: { repoId: repo.repoId, label: repo.label, slug: o.slug, path: repo.path, commit, dir: entry.dir },
      root: null,
      meta: parsed.meta,
      manifest: { files: manifest },
      revision: `${repo.label}@${commit.slice(0, 7)}`,
      usage: skillUsage({ meta: parsed.meta, body: parsed.body, files: manifest, diagnostics: parsed.diagnostics, claudeCodeOk: o.claudeCodeOk, reservedSlash: false }),
    });
  }
  return { skills, warnings };
}

/**
 * All trusted repositories' Skills for one task. A name that a user-level Skill or another repository
 * also has becomes `<slug>:<name>` (for every repository that has it); otherwise the plain name.
 */
export async function scanProjectSkills(
  repos: ProjectSkillRepo[],
  o: { userIds: ReadonlySet<string>; claudeCodeOk: boolean; now?: number },
): Promise<{ skills: SnapshotSkill[]; warnings: string[] }> {
  const slugs = repoSlugs(repos);
  const all: SnapshotSkill[] = [];
  const warnings: string[] = [];
  for (const repo of repos) {
    try {
      const scanned = await scanRepoSkills(repo, { slug: slugs.get(repo.repoId)!, claudeCodeOk: o.claudeCodeOk, ...(o.now !== undefined ? { now: o.now } : {}) });
      all.push(...scanned.skills);
      warnings.push(...scanned.warnings);
    } catch (error) {
      warnings.push(`${repo.label}：读取 Skills 失败（${error instanceof Error ? error.message : String(error)}）`);
    }
  }
  const owners = new Map<string, number>();
  for (const skill of all) owners.set(skill.id, (owners.get(skill.id) ?? 0) + 1);
  return {
    skills: all.map((skill) => {
      const id = o.userIds.has(skill.id) || owners.get(skill.id)! > 1 ? `${skill.repo!.slug}:${skill.id}` : skill.id;
      if (!isReservedSlashName(id)) return { ...skill, id };
      // Same note a user-level Skill with a reserved name gets.
      const runtimes = skill.usage.runtimes.map((r) => (r.adapter === "claude-code" && r.support !== "none" ? { ...r, notes: [...r.notes, "reserved-slash-name" as const] } : r));
      return { ...skill, id, usage: { ...skill.usage, runtimes } };
    }),
    warnings,
  };
}

/**
 * One file of a repository Skill at its pinned commit, as raw bytes. Links and submodules are refused,
 * and the size is checked before the blob is read.
 */
export async function readRepoSkillFile(skill: SnapshotSkill, rel: string, maxBytes: number): Promise<Buffer> {
  if (!skill.repo) throw new Error("not a repository Skill");
  const normal = normalizeSkillPath(rel);
  if (normal === null) throw new Error("outside the Skill");
  const full = `${skill.repo.dir}/${normal}`;
  const rows = parseTree(await gitRaw(skill.repo.path, ["--literal-pathspecs", "ls-tree", "-z", "-l", skill.repo.commit, "--", full]));
  const row = rows.length === 1 && rows[0]!.path === full ? rows[0]! : undefined;
  if (!row || row.type !== "blob" || row.mode === LINK || row.mode === SUBMODULE) throw new Error(`${normal}: not a file at ${skill.repo.commit}`);
  if (row.size === null || row.size > maxBytes) throw new Error(`${normal}: larger than ${maxBytes} bytes`);
  return gitRaw(skill.repo.path, ["cat-file", "blob", row.sha], undefined);
}


/** The task's snapshot: the enabled user-level Skills plus the trusted repositories' Skills. */
export async function takeTaskSnapshot(o: { nemaHome: string; claudeCodeOk: boolean; projectSkills?: ProjectSkillRepo[] }): Promise<SkillSnapshot> {
  const user = await takeSnapshot({ nemaHome: o.nemaHome, claudeCodeOk: o.claudeCodeOk });
  if (!o.projectSkills || o.projectSkills.length === 0) return user;
  const project = await scanProjectSkills(o.projectSkills, { userIds: new Set(user.skills.map((s) => s.id)), claudeCodeOk: o.claudeCodeOk });
  const skills = [...user.skills, ...project.skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { skills, warnings: [...user.warnings, ...project.warnings] };
}
