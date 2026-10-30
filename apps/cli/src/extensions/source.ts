import { bundledExtensions, type ExtensionRecord, type SkillProblem, type SkillSource } from "@nema/shared";

/**
 * The slice of `fetch` the resolver needs. Production passes the global `fetch`; tests pass a fake
 * GitHub, so no test depends on the network.
 */
export type SourceFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type { SkillProblem } from "@nema/shared";

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
export const RAW = "https://raw.githubusercontent.com";
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Skills listed for a whole-repository preview. */
const MAX_SKILLS = 50;
/** SKILL.md files read while looking for one named skill. */
const MAX_SCAN = 200;
/** Larger SKILL.md files are not downloaded just to read their front matter. */
export const MAX_SKILL_BYTES = 256 * 1024;
const BUNDLED_IDS = new Set(bundledExtensions().map((row) => row.id));

const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "nema-extension-resolver", "X-GitHub-Api-Version": "2022-11-28" };

export type Options = { fetch: SourceFetch; signal?: AbortSignal };

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

/** A plain or quoted YAML scalar on one line, without a trailing `# comment`. */
function scalar(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end > 0) return trimmed.slice(1, end);
  }
  // In YAML a comment starts at `#` preceded by whitespace; `a#b` stays one word.
  return trimmed.replace(/(^|\s+)#.*$/, "").trim();
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export type TreeEntry = { path: string; type: string; mode: string; sha: string; size: number | null };

/** Every entry of a repository at one commit, as GitHub's recursive tree listing reports it. */
export async function commitTree(owner: string, repo: string, commit: string, o: Options): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const slug = `${owner}/${repo}`;
  const body = await getJson(`${API}/repos/${owner}/${repo}/git/trees/${commit}?recursive=1`, slug, o, `commit not found in ${slug}: ${commit}`);
  const tree = field(body, "tree");
  if (!Array.isArray(tree)) throw new Error(`GitHub returned no file list for ${slug} at ${commit}`);
  const entries = tree
    .filter((entry) => typeof field(entry, "path") === "string" && typeof field(entry, "type") === "string" && typeof field(entry, "sha") === "string")
    .map((entry) => ({
      path: field(entry, "path") as string,
      type: field(entry, "type") as string,
      mode: typeof field(entry, "mode") === "string" ? (field(entry, "mode") as string) : "",
      sha: field(entry, "sha") as string,
      size: typeof field(entry, "size") === "number" ? (field(entry, "size") as number) : null,
    }));
  return { entries, truncated: field(body, "truncated") === true };
}

/** `name` and `description` from a SKILL.md front matter; plain and folded/literal scalars only. */
export function skillFrontMatter(text: string): { name: string; description: string } | null {
  // The whole accepted file may hold the front matter: callers already refuse anything over the cap.
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text.slice(0, MAX_SKILL_BYTES));
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
    } else values[key!] = scalar(rest!);
  }
  const name = values.name?.trim();
  const description = values.description?.trim();
  return name && description ? { name, description } : null;
}

export function skillId(name: string): string {
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

  // A link cannot say where a slashed branch name ends and the folder begins, so try the shortest
  // ref first and lengthen it while GitHub does not know it. Git refuses `a` and `a/b` as two branches,
  // so at most one split names a branch.
  const segments = source.refPath ? source.refPath.split("/") : [];
  const splits: Array<{ ref: string; path: string | null }> = segments.length
    ? segments.map((_, index) => ({ ref: segments.slice(0, index + 1).join("/"), path: segments.slice(index + 1).join("/") || null }))
    : [{ ref, path: source.path }];
  let commit: unknown;
  let chosenRef = ref;
  let folderPath = source.path;
  for (const split of splits) {
    const notFound = `ref not found in ${slug}: ${ref}`;
    try {
      const body = await getJson(`${API}/repos/${source.owner}/${source.repo}/commits/${encodePath(split.ref)}`, slug, o, notFound);
      commit = field(body, "sha");
      chosenRef = split.ref;
      folderPath = split.path;
      break;
    } catch (error) {
      if (!(error instanceof Error && error.message === notFound) || split === splits.at(-1)) throw error;
    }
  }
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error(`${chosenRef} in ${slug} did not resolve to a commit`);

  const treeBody = await getJson(`${API}/repos/${source.owner}/${source.repo}/git/trees/${commit}?recursive=1`, slug, o, `commit not found in ${slug}: ${commit}`);
  const tree = field(treeBody, "tree");
  if (!Array.isArray(tree)) throw new Error(`GitHub returned no file list for ${slug} at ${commit}`);
  const prefix = folderPath ? `${folderPath}/` : "";
  const exactFile = `${prefix}SKILL.md`;
  const files = tree
    .filter((entry): entry is { path: string; type: string; sha: string; size?: number } =>
      typeof field(entry, "path") === "string" && field(entry, "type") === "blob" && typeof field(entry, "sha") === "string")
    .filter((entry) => (source.exact ? entry.path === exactFile : (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")) && entry.path.startsWith(prefix)))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) throw new Error(`no SKILL.md under ${folderPath ?? "the repository root"} in ${slug} at ${commit}`);

  const read = async (file: (typeof files)[number]): Promise<SkillCandidate> => {
    const folder = file.path === "SKILL.md" ? "." : file.path.slice(0, -"/SKILL.md".length);
    const fallback = folder === "." ? repo! : folder.split("/").at(-1)!;
    if (typeof file.size === "number" && file.size > MAX_SKILL_BYTES) {
      return { id: null, name: fallback, description: "", path: folder, digest: file.sha, problem: "too-large" };
    }
    const response = await o.fetch(`${RAW}/${owner}/${repo}/${commit}/${encodePath(file.path)}`, { headers: { "User-Agent": HEADERS["User-Agent"] }, signal: o.signal });
    if (!response.ok) throw new Error(`could not read ${file.path} in ${slug} at ${commit} (${response.status})`);
    const meta = skillFrontMatter(await response.text());
    if (!meta) return { id: null, name: fallback, description: "", path: folder, digest: file.sha, problem: "missing-frontmatter" };
    const id = skillId(meta.name);
    const problem: SkillProblem | null = !ID.test(id) ? "invalid-id" : BUNDLED_IDS.has(id) ? "bundled-id" : null;
    return { id: problem ? null : id, name: meta.name, description: meta.description, path: folder, digest: file.sha, problem };
  };

  let chosen: SkillCandidate[] = [];
  const limit = source.skill ? MAX_SCAN : MAX_SKILLS;
  for (const file of files.slice(0, limit)) chosen.push(await read(file));
  if (source.skill) {
    // One skills.sh page is one skill: match by name, then by id, then by folder, and stop at the first
    // rank that matches anything. Two matches at that rank is a question, not a guess.
    const wanted = source.skill;
    const ranks = [
      (skill: SkillCandidate) => skill.name === wanted,
      (skill: SkillCandidate) => skill.id === wanted,
      (skill: SkillCandidate) => skill.path.split("/").at(-1) === wanted,
    ];
    const hits = ranks.map((rank) => chosen.filter(rank)).find((list) => list.length > 0) ?? [];
    if (hits.length === 0) throw new Error(`skill ${wanted} not found in ${slug} at ${commit}`);
    if (hits.length > 1) throw new Error(`skill ${wanted} is ambiguous in ${slug} at ${commit}: ${hits.map((skill) => skill.path).join(", ")}`);
    chosen = hits;
  }
  // Two skills that map to one id would install into one folder; neither is offered until renamed.
  const counts = new Map<string, number>();
  for (const skill of chosen) if (skill.id) counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1);
  chosen = chosen.map((skill) => (skill.id && counts.get(skill.id)! > 1 ? { ...skill, id: null, problem: "duplicate-id" } : skill));

  return {
    repository: `https://github.com/${owner}/${repo}`,
    owner: owner!,
    repo: repo!,
    ref: chosenRef,
    commit,
    license,
    path: folderPath,
    skills: chosen,
    truncated: field(treeBody, "truncated") === true || files.length > limit,
  };
}

/**
 * The record a chosen skill is installed under. `revision` is the commit and `source` links to that
 * commit, so the record keeps saying what was installed after the branch moves on.
 */
export function pinnedSkillRecord(resolution: SkillResolution, skill: SkillCandidate): ExtensionRecord {
  if (!skill.id || skill.problem) throw new Error(`skill ${skill.name} cannot be installed: ${skill.problem ?? "invalid-id"}`);
  if (!COMMIT.test(resolution.commit)) throw new Error("a skill record needs a 40-character commit");
  const folder = skill.path === "." ? "" : `/${encodePath(skill.path)}`;
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
    provenance: { repository: resolution.repository, commit: resolution.commit, path: skill.path, digest: skill.digest, license: resolution.license },
  };
}
