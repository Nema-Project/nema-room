import type { GraphifyOpts } from "./graphify.js";
import { removeSnapshot, snapshotDir } from "./handlers.js";
import { fetchMain, mainRef, revParse } from "./git.js";
import { syncIndex, withIndexLock } from "./indexState.js";

const DEFAULT_INTERVAL_MS = 300_000;

export type WatchedRepo = {
  workspaceId: string;
  repoId: string;
  path: string;
  mainBranch: string;
  lastMainSha: string | null;
};

export type RepoMoved = { repoId: string; mainRef: string; from: string | null; to: string };
export type RepoFetched = { repoId: string; ok: boolean; error?: string; at: string };

export class RepoWatcher {
  private readonly nemaHome: string;
  private readonly intervalMs: number;
  private readonly onMoved: (move: RepoMoved) => boolean | void;
  private readonly onFetch: (report: RepoFetched) => void;
  private readonly graphify: GraphifyOpts | undefined;
  private repos: WatchedRepo[] = [];
  /** Last sha this process has recorded. `null` means the first tick still has to baseline. */
  private readonly known = new Map<string, string | null>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  /** Full ticks and single-repo ticks run one at a time, so one move is never reported twice. */
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: {
    nemaHome: string;
    intervalMs?: number;
    /** `false` means the move was not sent. The sha stays put and the next tick retries. */
    onMoved: (move: RepoMoved) => boolean | void;
    onFetch: (report: RepoFetched) => void;
    /** For tests: production passes nothing and runs `graphify` from PATH. */
    graphify?: GraphifyOpts;
  }) {
    this.graphify = opts.graphify;
    this.nemaHome = opts.nemaHome;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onMoved = opts.onMoved;
    this.onFetch = opts.onFetch;
  }

  setRepos(list: WatchedRepo[]): void {
    const keep = new Set(list.map((repo) => repo.repoId));
    for (const id of this.known.keys()) {
      if (!keep.has(id)) this.known.delete(id);
    }
    for (const repo of list) {
      const recorded = this.known.get(repo.repoId);
      // A null lastMainSha means the hub has never stored one. Keep a sha this process
      // already recorded so a later sync does not turn the next change into another baseline.
      this.known.set(repo.repoId, repo.lastMainSha === null && recorded !== undefined ? recorded : repo.lastMainSha);
    }
    this.repos = list;
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  tick(): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = this.serial(() => this.runTick()).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  /** Ticks one watched repo now (a coding agent's hook fired). An unknown repo id is a no-op. */
  tickRepo(repoId: string): Promise<void> {
    return this.serial(async () => {
      const repo = this.repos.find((row) => row.repoId === repoId);
      if (!repo) return;
      try {
        await this.tickOne(repo);
      } catch (error) {
        console.error(`[nema] repo watch failed for ${repo.repoId}`, error);
      }
    });
  }

  private async runTick(): Promise<void> {
    for (const repo of this.repos) {
      try {
        await this.tickOne(repo);
      } catch (error) {
        // The sha is only stored after a successful step, so this repo retries next tick.
        console.error(`[nema] repo watch failed for ${repo.repoId}`, error);
      }
    }
  }

  /** False once `setRepos` dropped this repo, for example after an unbind while its tick ran. */
  private isWatched(repo: WatchedRepo): boolean {
    return this.repos.some((row) => row.repoId === repo.repoId && row.workspaceId === repo.workspaceId);
  }

  private async tickOne(repo: WatchedRepo): Promise<void> {
    if (!this.isWatched(repo)) return;
    const fetched = await fetchMain(repo.path, repo.mainBranch);
    if (!this.isWatched(repo)) return;
    const at = new Date().toISOString();
    if (fetched.ok) this.onFetch({ repoId: repo.repoId, ok: true, at });
    else this.onFetch({ repoId: repo.repoId, ok: false, error: fetched.error, at });

    const ref = await mainRef(repo.path, repo.mainBranch);
    const sha = await revParse(repo.path, ref);
    const root = snapshotDir(this.nemaHome, repo.workspaceId, repo.repoId);
    try {
      // Every tick brings the index to main, so a failed update or build is retried next tick.
      await withIndexLock(root, () => syncIndex(root, repo.path, sha, this.graphify));
    } catch (error) {
      // A broken or missing graphify must not stop main-branch tracking.
      console.error(`[nema] repo index failed for ${repo.repoId}`, error);
    }
    if (!this.isWatched(repo)) {
      // Unbound while this tick ran: repo.forget may already have run, so drop what syncIndex just wrote.
      await withIndexLock(root, () => removeSnapshot(root));
      return;
    }
    const last = this.known.get(repo.repoId) ?? null;
    if (last === null) {
      this.known.set(repo.repoId, sha);
      return;
    }
    if (sha === last) return;
    if (this.onMoved({ repoId: repo.repoId, mainRef: ref, from: last, to: sha }) === false) return;
    this.known.set(repo.repoId, sha);
  }

  start(): void {
    this.stop();
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        console.error("[nema] repo watch failed", error);
      });
    }, this.intervalMs);
    timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function parseReposSync(params: unknown): WatchedRepo[] {
  if (!params || typeof params !== "object" || !Array.isArray((params as { repos?: unknown }).repos)) {
    throw new Error("invalid repo params");
  }
  return (params as { repos: unknown[] }).repos.map((row) => {
    if (!row || typeof row !== "object") throw new Error("invalid repo params");
    const repo = row as Record<string, unknown>;
    const workspaceId = repo.workspaceId;
    const repoId = repo.repoId;
    const repoPath = repo.path;
    const mainBranch = repo.mainBranch;
    const lastMainSha = repo.lastMainSha;
    if (
      typeof workspaceId !== "string" ||
      typeof repoId !== "string" ||
      typeof repoPath !== "string" ||
      typeof mainBranch !== "string" ||
      !workspaceId ||
      !repoId ||
      !repoPath ||
      !mainBranch
    ) {
      throw new Error("invalid repo params");
    }
    if (!(lastMainSha === null || (typeof lastMainSha === "string" && lastMainSha !== ""))) {
      throw new Error("invalid repo params");
    }
    return { workspaceId, repoId, path: repoPath, mainBranch, lastMainSha };
  });
}
