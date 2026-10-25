import { isBranchName } from "@nema/shared";
import { nanoid } from "nanoid";
import type { Db } from "./db/db.js";
import { DaemonRpcError, INDEX_RPC_TIMEOUT_MS, type DaemonRpc } from "./daemonRpc.js";
import type { EventBus } from "./events.js";
import { githubTarget } from "./githubScope.js";
import { postSystemTask } from "./messages.js";
import { toUiTask } from "./tasks.js";

export class RepoError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

export type Repo = {
  id: string;
  workspaceId: string;
  path: string;
  gitCommonDir: string;
  label: string;
  mainBranch: string;
  hasOrigin: boolean;
  remoteUrl: string | null;
  /** The lowercased `owner/repo` of a github.com remote, or null. */
  githubTarget: string | null;
  lastMainSha: string | null;
  lastFetchAt: string | null;
  lastFetchError: string | null;
};

type Row = {
  id: string;
  workspace_id: string;
  path: string;
  git_common_dir: string;
  label: string;
  main_branch: string;
  has_origin: boolean;
  remote_url: string | null;
  last_main_sha: string | null;
  last_fetch_at: Date | string | null;
  last_fetch_error: string | null;
};

const COLS =
  "id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url, last_main_sha, last_fetch_at, last_fetch_error";

function timestamp(value: Date | string | null): string | null {
  if (value == null) return null;
  return new Date(value).toISOString();
}

function githubTargetText(remoteUrl: string | null): string | null {
  const target = githubTarget(remoteUrl);
  return target ? `${target.owner}/${target.repo}` : null;
}

function toRepo(row: Row): Repo {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    path: row.path,
    gitCommonDir: row.git_common_dir,
    label: row.label,
    mainBranch: row.main_branch,
    hasOrigin: row.has_origin,
    remoteUrl: row.remote_url,
    githubTarget: githubTargetText(row.remote_url),
    lastMainSha: row.last_main_sha,
    lastFetchAt: timestamp(row.last_fetch_at),
    lastFetchError: row.last_fetch_error,
  };
}

export async function listRepos(db: Db, workspaceId: string): Promise<Repo[]> {
  const rows = await db.query<Row>(`select ${COLS} from workspace_repos where workspace_id = $1 order by created_at, id`, [workspaceId]);
  return rows.map(toRepo);
}

export async function getRepo(db: Db, repoId: string): Promise<Repo | null> {
  const rows = await db.query<Row>(`select ${COLS} from workspace_repos where id = $1`, [repoId]);
  return rows[0] ? toRepo(rows[0]) : null;
}

/** `ref` is the repo id or its label, case-sensitive, and only within this workspace. */
export async function findRepoForWorkspace(db: Db, workspaceId: string, ref: string): Promise<Repo | null> {
  const rows = await db.query<Row>(
    `select ${COLS} from workspace_repos
     where workspace_id = $1 and (id = $2 or label = $2)
     order by case when id = $2 then 0 else 1 end
     limit 1`,
    [workspaceId, ref],
  );
  return rows[0] ? toRepo(rows[0]) : null;
}

type Inspected = {
  root: string;
  gitCommonDir: string;
  defaultBranch: string;
  hasOrigin: boolean;
  remoteUrl: string | null;
};

function asInspected(value: unknown): Inspected {
  if (!value || typeof value !== "object") throw new Error("invalid inspect result");
  const row = value as Record<string, unknown>;
  if (typeof row.root !== "string" || typeof row.gitCommonDir !== "string" || typeof row.defaultBranch !== "string" || typeof row.hasOrigin !== "boolean") {
    throw new Error("invalid inspect result");
  }
  if (!(row.remoteUrl === null || typeof row.remoteUrl === "string")) throw new Error("invalid inspect result");
  return {
    root: row.root,
    gitCommonDir: row.gitCommonDir,
    defaultBranch: row.defaultBranch,
    hasOrigin: row.hasOrigin,
    remoteUrl: row.remoteUrl,
  };
}

const LABEL_INDEX = "workspace_repos_label_unique";

/** Which unique rule an insert or update broke: the per-workspace label, the repo itself, or none. */
function uniqueViolation(error: unknown): "label" | "repo" | null {
  if (!error || typeof error !== "object") return null;
  const row = error as { code?: unknown; message?: unknown; constraint?: unknown; cause?: unknown };
  const text = `${typeof row.constraint === "string" ? row.constraint : ""} ${typeof row.message === "string" ? row.message : ""}`;
  if (text.includes(LABEL_INDEX)) return "label";
  if (row.code === "23505" || text.includes("git_common_dir")) return "repo";
  return uniqueViolation(row.cause);
}

function duplicateLabel(label: string): RepoError {
  return new RepoError(409, `本 workspace 已有用途为 ${label} 的仓库`);
}

/** 1–40 characters (code points), no control characters. */
function checkLabel(label: string): void {
  const length = [...label].length;
  if (length < 1 || length > 40 || /\p{Cc}/u.test(label)) throw new RepoError(400, "用途说明需为 1–40 个字符");
}

const DAEMON_UNAVAILABLE = new Set(["daemon 未连接", "daemon 已断开", "daemon 响应超时"]);

function missingRepo(repoId: string): RepoError {
  return new RepoError(404, `找不到仓库：${repoId}`);
}

function rpcRepo(repo: Repo): { workspaceId: string; repoId: string; path: string; mainBranch: string } {
  return { workspaceId: repo.workspaceId, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch };
}

function syncRow(repo: Repo): { workspaceId: string; repoId: string; path: string; mainBranch: string; lastMainSha: string | null } {
  return { workspaceId: repo.workspaceId, repoId: repo.id, path: repo.path, mainBranch: repo.mainBranch, lastMainSha: repo.lastMainSha };
}

/**
 * Pushes every repo the daemon should watch: archived workspaces' repos are left out, so they are not
 * fetched. The daemon call is not awaited, so a slow reply cannot block bind or welcome.
 */
export async function syncBoundRepos(db: Db, daemon: DaemonRpc): Promise<void> {
  const rows = await db.query<Row>(
    `select ${COLS.split(", ").map((c) => `r.${c}`).join(", ")} from workspace_repos r
     join workspaces w on w.id = r.workspace_id
     where w.archived_at is null
     order by r.created_at, r.id`,
  );
  void daemon.call("repos.sync", { repos: rows.map((row) => syncRow(toRepo(row))) }).catch((error) => {
    console.error("repos.sync failed", error);
  });
}

/** Records the move. Returns whether it applied; the caller then runs the after-move hooks (diagram staleness, report re-checks). */
export async function applyRepoMoved(
  db: Db,
  events: EventBus,
  message: { repoId: string; mainRef: string; from: string | null; to: string },
): Promise<boolean> {
  // A repo unbound while the daemon's tick ran is ignored: nothing to update, nothing to broadcast.
  const rows = await db.query(`update workspace_repos set last_main_sha = $2 where id = $1 returning id`, [message.repoId, message.to]);
  if (rows.length === 0) return false;
  // The no-report fallback looks at each move once it is old enough.
  await db.query(`insert into main_moves(repo_id, from_sha, to_sha) values ($1, $2, $3)`, [message.repoId, message.from, message.to]);
  events.emitGlobal({ type: "repo.moved", repoId: message.repoId, mainRef: message.mainRef, from: message.from, to: message.to });
  return true;
}

export async function applyRepoFetched(
  db: Db,
  message: { repoId: string; ok: boolean; error?: string; at: string },
): Promise<void> {
  // A failure keeps last_fetch_at, so it stays the time of the last successful fetch.
  if (message.ok) {
    await db.query(`update workspace_repos set last_fetch_at = $2, last_fetch_error = null where id = $1`, [message.repoId, message.at]);
  } else {
    await db.query(`update workspace_repos set last_fetch_error = $2 where id = $1`, [message.repoId, message.error ?? null]);
  }
}

const INVALID_BRANCH = "主分支名称无效";

export type RepoPreview = {
  root: string;
  defaultBranch: string;
  hasOrigin: boolean;
  remoteUrl: string | null;
  label: string;
  labelTaken: boolean;
};

function suggestedLabel(root: string): string {
  const segment = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const label = [...segment].slice(0, 40).join("");
  checkLabel(label);
  return label;
}

export async function previewRepo(db: Db, daemon: DaemonRpc, workspaceId: string, path: string): Promise<RepoPreview> {
  const ws = await db.query<{ archived_at: Date | string | null }>(`select archived_at from workspaces where id = $1`, [workspaceId]);
  if (!ws[0]) throw new RepoError(404, `找不到 workspace：${workspaceId}`);
  if (ws[0].archived_at) throw new RepoError(409, "workspace 已归档，取消归档后才能绑定仓库");
  let inspected: Inspected;
  try {
    inspected = asInspected(await daemon.call("repo.inspect", { path }));
  } catch (error) {
    if (error instanceof DaemonRpcError) {
      if (DAEMON_UNAVAILABLE.has(error.message)) throw new RepoError(503, error.message);
      throw new RepoError(400, error.message);
    }
    throw error;
  }
  const label = suggestedLabel(inspected.root);
  const taken = await db.query(`select 1 as ok from workspace_repos where workspace_id = $1 and label = $2`, [workspaceId, label]);
  return {
    root: inspected.root,
    defaultBranch: isBranchName(inspected.defaultBranch) ? inspected.defaultBranch : "main",
    hasOrigin: inspected.hasOrigin,
    remoteUrl: inspected.remoteUrl,
    label,
    labelTaken: taken.length > 0,
  };
}

export async function bindRepo(
  db: Db,
  daemon: DaemonRpc,
  workspaceId: string,
  input: { path: string; label: string; mainBranch?: string },
  events?: EventBus,
): Promise<Repo> {
  checkLabel(input.label);
  if (input.mainBranch !== undefined && !isBranchName(input.mainBranch)) throw new RepoError(400, INVALID_BRANCH);
  const ws = await db.query<{ archived_at: Date | string | null }>(`select archived_at from workspaces where id = $1`, [workspaceId]);
  if (!ws[0]) throw new RepoError(404, `找不到 workspace：${workspaceId}`);
  if (ws[0].archived_at) throw new RepoError(409, "workspace 已归档，取消归档后才能绑定仓库");
  let inspected: Inspected;
  try {
    inspected = asInspected(await daemon.call("repo.inspect", { path: input.path }));
  } catch (error) {
    if (error instanceof DaemonRpcError) {
      if (DAEMON_UNAVAILABLE.has(error.message)) throw new RepoError(503, error.message);
      throw new RepoError(400, error.message);
    }
    throw error;
  }
  const id = `repo_${nanoid(12)}`;
  // The daemon's answer is checked too: a branch name it got from origin/HEAD is still outside data.
  const mainBranch = input.mainBranch ?? (isBranchName(inspected.defaultBranch) ? inspected.defaultBranch : "main");
  let repo: Repo;
  try {
    const rows = await db.query<Row>(
      `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning ${COLS}`,
      [id, workspaceId, inspected.root, inspected.gitCommonDir, input.label, mainBranch, inspected.hasOrigin, inspected.remoteUrl],
    );
    repo = toRepo(rows[0]!);
  } catch (error) {
    const kind = uniqueViolation(error);
    if (kind === "label") throw duplicateLabel(input.label);
    if (kind !== "repo") throw error;
    const existing = await db.query<{ name: string }>(
      `select w.name as name from workspace_repos r join workspaces w on w.id = r.workspace_id where r.git_common_dir = $1`,
      [inspected.gitCommonDir],
    );
    throw new RepoError(409, `该仓库已绑定到 workspace ${existing[0]?.name ?? ""}`);
  }
  void daemon
    .call("repo.index", rpcRepo(repo), INDEX_RPC_TIMEOUT_MS)
    .then(async (result) => {
      const sha = (result as { sha?: unknown } | null)?.sha;
      if (typeof sha !== "string" || sha === "") return;
      // The indexed snapshot is the watcher's baseline, not a move. Skip it if the branch
      // changed or a repo.moved already stored a sha while indexing ran.
      const rows = await db.query(
        `update workspace_repos set last_main_sha = $2 where id = $1 and main_branch = $3 and last_main_sha is null returning id`,
        [repo.id, sha, repo.mainBranch],
      );
      if (rows.length > 0) await syncBoundRepos(db, daemon);
    })
    .catch((error) => {
      console.error(`repo.index failed for ${repo.id}`, error);
    });
  await syncBoundRepos(db, daemon);
  await queueArchitectureDiagram(db, events, repo);
  return repo;
}

/** A newly bound repo gets one architecture diagram, drawn by a system-started task. */
async function queueArchitectureDiagram(db: Db, events: EventBus | undefined, repo: Repo): Promise<void> {
  try {
    const { message, task } = await postSystemTask(
      db,
      repo.workspaceId,
      `为仓库 ${repo.label}（${repo.id}）画架构图：用 code__ 函数读代码，用 diagram__save 保存，type 为 architecture。`,
    );
    events?.emit(repo.workspaceId, { type: "message.created", message });
    events?.emit(repo.workspaceId, { type: "task.updated", task: toUiTask(task) });
  } catch (error) {
    // The bind itself succeeded; a missing diagram can still be asked for in chat.
    console.error(`queueing the architecture diagram failed for ${repo.id}`, error);
  }
}

export async function updateRepo(db: Db, repoId: string, patch: { label?: string; mainBranch?: string }, daemon: DaemonRpc): Promise<Repo> {
  const sets: string[] = [];
  const params: unknown[] = [repoId];
  if (patch.label !== undefined) {
    checkLabel(patch.label);
    params.push(patch.label);
    sets.push(`label = $${params.length}`);
  }
  if (patch.mainBranch !== undefined) {
    if (!isBranchName(patch.mainBranch)) throw new RepoError(400, INVALID_BRANCH);
    params.push(patch.mainBranch);
    sets.push(`main_branch = $${params.length}`);
  }
  if (sets.length === 0) {
    const current = await getRepo(db, repoId);
    if (!current) throw missingRepo(repoId);
    return current;
  }
  let rows: Row[];
  try {
    rows = await db.query<Row>(`update workspace_repos set ${sets.join(", ")} where id = $1 returning ${COLS}`, params);
  } catch (error) {
    if (patch.label !== undefined && uniqueViolation(error) === "label") throw duplicateLabel(patch.label);
    throw error;
  }
  if (!rows[0]) throw missingRepo(repoId);
  const repo = toRepo(rows[0]);
  await syncBoundRepos(db, daemon);
  return repo;
}

export async function unbindRepo(db: Db, daemon: DaemonRpc, repoId: string): Promise<void> {
  const repo = await getRepo(db, repoId);
  if (!repo) throw missingRepo(repoId);
  await db.query("delete from workspace_repos where id = $1", [repoId]);
  void daemon.call("repo.forget", rpcRepo(repo)).catch((error) => {
    console.error(`repo.forget failed for ${repo.id}`, error);
  });
  await syncBoundRepos(db, daemon);
}
