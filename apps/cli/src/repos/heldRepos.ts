import { normalizeRemoteUrl } from "@nema/shared";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { inspectRepo } from "./git.js";
import type { RepoWatcher } from "./watcher.js";

/**
 * The normalized remote URLs of the repos this daemon watches (D-6): each watched path is inspected —
 * `git.ts` is the authority on what a repo's remote is — and the result normalized. A path that no longer
 * inspects is skipped, never fatal: a stale watcher entry must not block the holdings report.
 */
export async function computeHeldRepos(watcher: RepoWatcher, nemaHome: string, ownedHelpers?: OwnedHelperScope): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const repo of watcher.listRepos()) {
    let remote: string | null;
    try {
      remote = (await inspectRepo(repo.path, nemaHome, ownedHelpers)).remoteUrl;
    } catch {
      continue;
    }
    const normalized = normalizeRemoteUrl(remote);
    if (normalized === null || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
