/**
 * Where a skill comes from, before anything is fetched.
 *
 * Two spellings are accepted: a GitHub repository (bare, `owner/repo`, or a `tree`/`blob` link into
 * it) and a skills.sh page, which is only an index over GitHub repositories. Both end up as the same
 * GitHub coordinates; `via` keeps which one the person pasted. Anything else is refused here rather
 * than guessed at, so the daemon never fetches a URL the person did not mean.
 */
export type SkillSource = {
  via: "github" | "skills.sh";
  owner: string;
  repo: string;
  /** Branch, tag or commit from a `tree`/`blob` link; null means the repository's default branch. */
  ref: string | null;
  /** Folder inside the repository to look under; null means the whole repository. */
  path: string | null;
  /** Skill named by a skills.sh page; null means every skill found. */
  skill: string | null;
};

const MAX_INPUT = 2048;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function refuse(input: string): never {
  throw new Error(`unsupported extension source: ${input.length > 200 ? `${input.slice(0, 200)}…` : input}`);
}

function plainSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

function repoName(segment: string): string | null {
  const name = segment.endsWith(".git") ? segment.slice(0, -4) : segment;
  return REPO.test(name) && name !== "." && name !== ".." ? name : null;
}

export function parseSkillSource(raw: string): SkillSource {
  const input = raw.trim();
  if (!input || input.length > MAX_INPUT) refuse(input);

  // `owner/repo` with nothing else is the shorthand the skills CLI accepts.
  if (!input.includes(":") && !input.startsWith("github.com/") && /^[^/]+\/[^/]+$/.test(input)) {
    const [owner, repo] = input.split("/");
    const name = repoName(repo!);
    if (!OWNER.test(owner!) || !name) refuse(input);
    return { via: "github", owner: owner!, repo: name, ref: null, path: null, skill: null };
  }

  let url: URL;
  try {
    url = new URL(input.startsWith("github.com/") ? `https://${input}` : input);
  } catch {
    refuse(input);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) refuse(input);
  // URL normalises `..` away, so compare the path the person typed, not the parsed one.
  const typedPath = input.replace(/^https:\/\/[^/]+/, "").replace(/^github\.com/, "");
  if (typedPath !== url.pathname) refuse(input);
  const segments = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (segments.some((part) => part === "")) refuse(input);
  const host = url.hostname.toLowerCase();

  if (host === "skills.sh" || host === "www.skills.sh") {
    if (segments.length < 2 || segments.length > 3 || !segments.every(plainSegment)) refuse(input);
    const name = repoName(segments[1]!);
    if (!OWNER.test(segments[0]!) || !name) refuse(input);
    return { via: "skills.sh", owner: segments[0]!, repo: name, ref: null, path: null, skill: segments[2] ?? null };
  }

  if (host !== "github.com" && host !== "www.github.com") refuse(input);
  if (segments.length < 2) refuse(input);
  const [owner, repoSegment, kind, ref, ...rest] = segments;
  const repo = repoName(repoSegment!);
  if (!OWNER.test(owner!) || !repo) refuse(input);
  if (kind === undefined) return { via: "github", owner: owner!, repo, ref: null, path: null, skill: null };
  if ((kind !== "tree" && kind !== "blob") || ref === undefined || !REF.test(ref) || ref.includes("..")) refuse(input);
  if (!rest.every(plainSegment)) refuse(input);
  let folder = rest;
  if (kind === "blob") {
    // A blob link only makes sense pointing at the skill's own SKILL.md; its folder is the skill.
    if (rest.at(-1) !== "SKILL.md") refuse(input);
    folder = rest.slice(0, -1);
  }
  return { via: "github", owner: owner!, repo, ref, path: folder.length ? folder.join("/") : null, skill: null };
}
