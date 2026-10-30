import { bundledExtensions, type ExtensionRecord, type SkillSource } from "@nema/shared";

/**
 * The slice of `fetch` the resolver needs. Production passes the global `fetch`; tests pass a fake
 * GitHub, so no test depends on the network.
 */
export type SourceFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }>;

export type SkillProblem = "missing-frontmatter" | "invalid-id" | "bundled-id";

export type SkillCandidate = {
  /** Managed id the skill would install under; null when it cannot be installed (see `problem`). */
  id: string | null;
  name: string;
  description: string;
  /** Folder of the skill inside the repository; `.` is the repository root. */
  path: string;
  /** Git blob SHA-1 of the SKILL.md at the pinned commit. */
  digest: string;
  problem: SkillProblem | null;
};

export type SkillResolution = {
  repository: string;
  owner: string;
  repo: string;
  /** The ref that was asked for: the link's ref, or the repository's default branch. */
  ref: string;
  /** What that ref pointed to when it was resolved. Every later read uses this, never the ref. */
  commit: string;
  /** SPDX id GitHub reports for the repository, or null when it reports none. */
  license: string | null;
  path: string | null;
  skills: SkillCandidate[];
  /** GitHub cut the tree listing short, so skills deeper in a very large repository may be missing. */
  truncated: boolean;
};

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_SKILLS = 50;
const BUNDLED_IDS = new Set(bundledExtensions().map((row) => row.id));

const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "nema-extension-resolver", "X-GitHub-Api-Version": "2022-11-28" };

type Options = { fetch: SourceFetch; signal?: AbortSignal };

async function getJson(url: string, slug: string, o: Options, notFound: string): Promise<unknown> {
  const response = await o.fetch(url, { headers: HEADERS, signal: o.signal });
  if (response.ok) return response.json();
  if ((response.status === 403 || response.status === 429) && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("GitHub API rate limit reached; try again later");
  }
  if (response.status === 404 || response.status === 422) throw new Error(notFound);
  throw new Error(`GitHub returned ${response.status} for ${slug}`);
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) return trimmed.slice(1, -1);
  return trimmed;
}

/** `name` and `description` from a SKILL.md front matter; plain and folded/literal scalars only. */
export function skillFrontMatter(text: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(0, 64 * 1024));
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/);
  const values: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const top = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!top) continue;
    const [, key, rest] = top;
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      values[key!] = block.join(rest!.startsWith(">") ? " " : "\n");
    } else values[key!] = unquote(rest!);
  }
  const name = values.name?.trim();
  const description = values.description?.trim();
  return name && description ? { name, description } : null;
}

function skillId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

/**
 * Resolve a parsed source to one commit and the skills it contains.
 *
 * The ref is read once, turned into a 40-character commit, and every later read (tree listing,
 * SKILL.md contents) names that commit. A branch that moves while this runs, or between preview and
 * install, cannot change what was previewed.
 */
export async function resolveSkillSource(source: SkillSource, o: Options): Promise<SkillResolution> {
  const slug = `${source.owner}/${source.repo}`;
  const meta = await getJson(`${API}/repos/${source.owner}/${source.repo}`, slug, o, `GitHub repository not found: ${slug}`);
  const fullName = field(meta, "full_name");
  const [owner, repo] = typeof fullName === "string" && fullName.includes("/") ? fullName.split("/") : [source.owner, source.repo];
  const defaultBranch = field(meta, "default_branch");
  const ref = source.ref ?? (typeof defaultBranch === "string" && defaultBranch ? defaultBranch : null);
  if (!ref) throw new Error(`GitHub reported no default branch for ${slug}`);
  const spdx = field(field(meta, "license"), "spdx_id");
  const license = typeof spdx === "string" && spdx && spdx !== "NOASSERTION" ? spdx : null;

  const commitBody = await getJson(`${API}/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(ref)}`, slug, o, `ref not found in ${slug}: ${ref}`);
  const commit = field(commitBody, "sha");
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error(`${ref} in ${slug} did not resolve to a commit`);

  const treeBody = await getJson(`${API}/repos/${source.owner}/${source.repo}/git/trees/${commit}?recursive=1`, slug, o, `commit not found in ${slug}: ${commit}`);
  const tree = field(treeBody, "tree");
  if (!Array.isArray(tree)) throw new Error(`GitHub returned no file list for ${slug} at ${commit}`);
  const prefix = source.path ? `${source.path}/` : "";
  const files = tree
    .filter((entry): entry is { path: string; type: string; sha: string } =>
      typeof field(entry, "path") === "string" && field(entry, "type") === "blob" && typeof field(entry, "sha") === "string")
    .filter((entry) => (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")) && entry.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) throw new Error(`no SKILL.md under ${source.path ?? "the repository root"} in ${slug} at ${commit}`);

  const skills: SkillCandidate[] = [];
  for (const file of files.slice(0, MAX_SKILLS)) {
    const folder = file.path === "SKILL.md" ? "." : file.path.slice(0, -"/SKILL.md".length);
    const response = await o.fetch(`${RAW}/${owner}/${repo}/${commit}/${file.path}`, { headers: { "User-Agent": HEADERS["User-Agent"] }, signal: o.signal });
    if (!response.ok) throw new Error(`could not read ${file.path} in ${slug} at ${commit} (${response.status})`);
    const meta = skillFrontMatter(await response.text());
    const fallback = folder === "." ? repo! : folder.split("/").at(-1)!;
    if (!meta) {
      skills.push({ id: null, name: fallback, description: "", path: folder, digest: file.sha, problem: "missing-frontmatter" });
      continue;
    }
    const id = skillId(meta.name);
    const problem: SkillProblem | null = !ID.test(id) ? "invalid-id" : BUNDLED_IDS.has(id) ? "bundled-id" : null;
    skills.push({ id: problem ? null : id, name: meta.name, description: meta.description, path: folder, digest: file.sha, problem });
  }

  const chosen = source.skill
    ? skills.filter((skill) => skill.name === source.skill || skill.id === source.skill || skill.path.split("/").at(-1) === source.skill)
    : skills;
  if (source.skill && chosen.length === 0) throw new Error(`skill ${source.skill} not found in ${slug} at ${commit}`);

  return {
    repository: `https://github.com/${owner}/${repo}`,
    owner: owner!,
    repo: repo!,
    ref,
    commit,
    license,
    path: source.path,
    skills: chosen,
    truncated: field(treeBody, "truncated") === true || files.length > MAX_SKILLS,
  };
}

/**
 * The record a chosen skill is installed under. `revision` is the commit and `source` links to that
 * commit, so the record keeps saying what was installed after the branch moves on.
 */
export function pinnedSkillRecord(resolution: SkillResolution, skill: SkillCandidate): ExtensionRecord {
  if (!skill.id || skill.problem) throw new Error(`skill ${skill.name} cannot be installed: ${skill.problem ?? "invalid-id"}`);
  if (!COMMIT.test(resolution.commit)) throw new Error("a skill record needs a 40-character commit");
  const folder = skill.path === "." ? "" : `/${skill.path}`;
  return {
    id: skill.id,
    kind: "skill",
    name: skill.name,
    summary: skill.description,
    source: `${resolution.repository}/tree/${resolution.commit}${folder}`,
    revision: resolution.commit,
    provision: "managed",
    installState: "installing",
    useState: "enabled",
    availability: "ready",
    externalPath: null,
    error: null,
  };
}
