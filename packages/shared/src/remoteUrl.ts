/**
 * Normalized identity of a git remote URL: `<host>[:port]/<path>`, all lowercased.
 *
 * The hub and the CLI share this one function (D-6): a daemon reports the remotes it holds, the hub stores
 * the bound repos' `remote_url`, and routing compares the two normalized. `githubTarget` cannot serve here:
 * it only answers for github.com, while a held repo may live on any host.
 *
 * Rules: host lowercased; a `.git` suffix stripped; `git@host:path` and `https://host/path` (and the
 * `ssh://`/`git://` forms) unified; trailing slashes stripped; userinfo stripped; a port kept when present
 * (a different port is a different server). Anything that is not a remote URL gives null.
 *
 * The path is lowercased too, beyond the plan's "host 小写": git hosts treat the owner/repo path
 * case-insensitively, and a clone-time case difference (`Nema-Project` vs `nema-project`) must not break
 * routing. A host that distinguished two repos by path case alone is not a supported distinction.
 */
export function normalizeRemoteUrl(remoteUrl: string | null | undefined): string | null {
  if (remoteUrl === null || remoteUrl === undefined) return null;
  let url = remoteUrl.trim();
  if (url === "") return null;
  // A query or fragment names no repository.
  const hash = url.indexOf("#");
  if (hash >= 0) url = url.slice(0, hash);
  const query = url.indexOf("?");
  if (query >= 0) url = url.slice(0, query);

  const scp = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(url);
  if (scp) {
    const host = scp[1]!.toLowerCase();
    const path = normalizePath(scp[2]!);
    if (!path) return null;
    return `${host}/${path}`.toLowerCase();
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed) {
    const fromScheme = fromParsed(parsed);
    if (fromScheme !== null) return fromScheme;
  }
  // No usable scheme: it may already be a normalized `host/path` value (what a daemon reports), so try it
  // as one. Normalization must be idempotent on its own output. A `://` means a real scheme was present
  // and already refused above, so it is not retried bare.
  if (!url.includes("/") || url.includes("://") || url.startsWith("/")) return null;
  try {
    return fromParsed(new URL(`https://${url}`));
  } catch {
    return null;
  }
}

/** The normalized form of a parsed URL, or null when it names no repository. */
function fromParsed(parsed: URL): string | null {
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  if (parsed.hostname === "") return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  const path = normalizePath(pathname);
  if (!path) return null;
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${host}${port}/${path}`.toLowerCase();
}

/** Strips leading/trailing slashes and one trailing `.git`. Empty after stripping means "no repo path". */
function normalizePath(raw: string): string {
  let path = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (/\.git$/i.test(path)) path = path.slice(0, -4).replace(/\/+$/, "");
  return path;
}

/** The distinct normalized remotes of a list, in first-seen order; unparseable entries are dropped. */
export function normalizeRemoteUrls(remoteUrls: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of remoteUrls) {
    const normalized = normalizeRemoteUrl(raw);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
