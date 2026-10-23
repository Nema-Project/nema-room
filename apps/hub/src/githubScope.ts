// Which GitHub repositories a workspace's GitHub plugin calls may touch: the GitHub remotes of its bound repos.

export type GithubTarget = { owner: string; repo: string };

export type GithubCheck = { ok: true } | { ok: false; error: string };

const NAME = /^[A-Za-z0-9._-]+$/;
const SEARCH_ERROR = "搜索必须且只能限定为本 workspace 绑定的仓库（repo:owner/name）";
const UNSUPPORTED = "不支持的 GitHub 调用";

/** Tools whose target is their `owner` and `repo` arguments. */
const OWNER_REPO_TOOLS = new Set(["pull_request_read", "list_pull_requests", "issue_read", "list_issues"]);
/** Tools whose target is the one `repo:` qualifier in their `query`. */
const SEARCH_TOOLS = new Set(["search_issues", "search_pull_requests"]);

function ownerRepo(owner: string, repo: string): GithubTarget | null {
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

function fromPath(path: string): GithubTarget | null {
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return null;
  const repo = parts[1]!.endsWith(".git") ? parts[1]!.slice(0, -4) : parts[1]!;
  return ownerRepo(parts[0]!, repo);
}

/**
 * The lowercased `owner/repo` of a github.com remote, for the https, `git@host:`, `ssh://` and `.git`-suffix
 * forms. Any other host, or anything that is not a remote URL, gives null.
 */
export function githubTarget(remoteUrl: string | null): GithubTarget | null {
  if (!remoteUrl) return null;
  const url = remoteUrl.trim();
  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(url);
  if (scp) return scp[1]!.toLowerCase() === "github.com" ? fromPath(scp[2]!) : null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  if (parsed.hostname.toLowerCase() !== "github.com" || parsed.search || parsed.hash) return null;
  return fromPath(decodeURIComponent(parsed.pathname));
}

function isAllowed(target: GithubTarget, allowed: GithubTarget[]): boolean {
  return allowed.some((item) => item.owner === target.owner && item.repo === target.repo);
}

/** The one allowed `repo:` target of a search query, or null when the query could reach anything else. */
function searchTarget(query: unknown, allowed: GithubTarget[]): GithubTarget | null {
  if (typeof query !== "string") return null;
  // Boolean operators could widen the search past the repo: qualifier.
  if (/(^|[^A-Za-z0-9_])(OR|NOT)([^A-Za-z0-9_]|$)/.test(query)) return null;
  const qualifiers = [...query.matchAll(/(^|[^A-Za-z0-9_])(repo|org|user|owner)\s*:(\S*)/gi)];
  if (qualifiers.length !== 1) return null;
  const [match] = qualifiers;
  const [, before, key, value] = match!;
  if (key!.toLowerCase() !== "repo" || before === "-") return null;
  const slash = value!.split("/");
  if (slash.length !== 2) return null;
  const target = ownerRepo(slash[0]!, slash[1]!);
  return target && isAllowed(target, allowed) ? target : null;
}

/** Whether a `github__*` call stays inside the allowed remotes. `tool` may carry the `github__` prefix. */
export function checkGithubCall(tool: string, args: Record<string, unknown>, allowed: GithubTarget[]): GithubCheck {
  const name = tool.startsWith("github__") ? tool.slice("github__".length) : tool;
  if (OWNER_REPO_TOOLS.has(name)) {
    const owner = args.owner;
    const repo = args.repo;
    const target = typeof owner === "string" && typeof repo === "string" ? ownerRepo(owner, repo) : null;
    if (target && isAllowed(target, allowed)) return { ok: true };
    return { ok: false, error: `只能访问本 workspace 绑定仓库的 GitHub：${String(owner ?? "")}/${String(repo ?? "")}` };
  }
  if (SEARCH_TOOLS.has(name)) {
    const target = searchTarget(args.query, allowed);
    if (!target) return { ok: false, error: SEARCH_ERROR };
    // The server appends owner/repo arguments to the query, so they must name the same repo.
    if ("owner" in args || "repo" in args) {
      const extra = typeof args.owner === "string" && typeof args.repo === "string" ? ownerRepo(args.owner, args.repo) : null;
      if (!extra || extra.owner !== target.owner || extra.repo !== target.repo) return { ok: false, error: SEARCH_ERROR };
    }
    return { ok: true };
  }
  return { ok: false, error: UNSUPPORTED };
}

/** The distinct GitHub targets of a workspace's bound repos, in binding order. */
export function githubTargets(repos: { remoteUrl: string | null }[]): GithubTarget[] {
  const seen = new Set<string>();
  const out: GithubTarget[] = [];
  for (const repo of repos) {
    const target = githubTarget(repo.remoteUrl);
    if (!target) continue;
    const key = `${target.owner}/${target.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}
