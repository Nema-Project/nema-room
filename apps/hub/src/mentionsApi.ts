import { Hono } from "hono";
import { MENTION_LIMITS, fuzzyScore } from "@nema/shared";
import type { DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import { listRepos, type Repo } from "./repos.js";
import { getWorkspace } from "./workspaces.js";

export type MentionRouteDeps = { db: Db; daemon: DaemonRpc; daemonStatus: () => boolean };

/** Each bound repository gets this long to list its files before it is left out of the answer. */
export const MENTION_FILES_TIMEOUT_MS = 5_000;
const MAX_QUERY_LENGTH = 200;
const SHA40 = /^[0-9a-f]{40}$/;
const OFFLINE = new Set(["daemon 未连接", "daemon 已断开"]);

type Listing = { repo: Repo; commit: string; paths: string[]; truncated: boolean };
type Outcome = Listing | "unsupported" | "offline" | "skipped";

export type MentionFile = { repoId: string; label: string; path: string; commit: string };
export type MentionFilesResult = { status: "ok" | "unsupported" | "offline"; files: MentionFile[]; truncated: boolean };

async function listRepo(deps: MentionRouteDeps, repo: Repo): Promise<Outcome> {
  let result: unknown;
  try {
    result = await deps.daemon.call(
      "repo.files",
      { workspaceId: repo.workspaceId, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch },
      MENTION_FILES_TIMEOUT_MS,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("未知方法 ")) return "unsupported";
    if (OFFLINE.has(message)) return "offline";
    // A slow or failing repository (timeout, git error) is left out; the others still answer.
    return "skipped";
  }
  const row = (result && typeof result === "object" ? result : {}) as { commit?: unknown; paths?: unknown; truncated?: unknown };
  if (typeof row.commit !== "string" || !SHA40.test(row.commit) || !Array.isArray(row.paths) || !row.paths.every((p) => typeof p === "string")) return "skipped";
  return { repo, commit: row.commit, paths: row.paths as string[], truncated: row.truncated === true };
}

/**
 * Mention candidates: file paths on each bound repository's main branch that match `q`. Paths only — the hub
 * never reads or stores file contents. An empty query lists nothing, so a whole repository is never sent.
 */
export async function searchMentionFiles(deps: MentionRouteDeps, workspaceId: string, q: string): Promise<MentionFilesResult> {
  const none = (status: MentionFilesResult["status"]): MentionFilesResult => ({ status, files: [], truncated: false });
  if (q === "") return none("ok");
  const repos = await listRepos(deps.db, workspaceId);
  if (repos.length === 0) return none("ok");
  if (!deps.daemonStatus()) return none("offline");
  const outcomes = await Promise.all(repos.map((repo) => listRepo(deps, repo)));
  const listings = outcomes.filter((o): o is Listing => typeof o === "object");
  if (listings.length === 0) {
    if (outcomes.includes("offline")) return none("offline");
    if (outcomes.includes("unsupported")) return none("unsupported");
  }
  const ranked: Array<MentionFile & { score: number }> = [];
  for (const l of listings) {
    for (const path of l.paths) {
      const score = fuzzyScore(q, path);
      if (score !== null) ranked.push({ repoId: l.repo.id, label: l.repo.label, path, commit: l.commit, score });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
  const files = ranked.slice(0, MENTION_LIMITS.fileCandidates).map(({ score: _score, ...file }) => file);
  return { status: "ok", files, truncated: ranked.length > files.length || listings.some((l) => l.truncated) };
}

export function mentionRoutes(deps: MentionRouteDeps): Hono {
  const app = new Hono();
  app.get("/workspaces/:id/mention-files", async (c) => {
    const workspaceId = c.req.param("id");
    const q = (c.req.query("q") ?? "").trim();
    if (q.length > MAX_QUERY_LENGTH) return c.json({ error: `q is longer than ${MAX_QUERY_LENGTH} characters` }, 400);
    // Archived workspaces can still be searched: their messages stay readable.
    if (!(await getWorkspace(deps.db, workspaceId))) return c.json({ error: "workspace not found" }, 404);
    return c.json(await searchMentionFiles(deps, workspaceId, q));
  });
  return app;
}
