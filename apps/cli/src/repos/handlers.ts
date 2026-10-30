import { lstat, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { RpcRouter } from "../daemon/rpc.js";
import { GH_COMMAND_TOOLS } from "@nema/shared";
import { GITHUB_TOOLS } from "../github/client.js";
import { GithubGh, type GithubReader } from "../github/gh.js";
import { changedFiles, exportSnapshot, fetchMain, inspectRepo, mainRef, missingAtRef, readFileAtRef, revParse } from "./git.js";
import { graphifyInstallStatus, queryIndex, type GraphifyOpts } from "./graphify.js";
import { readIndexedSha, syncIndex, withIndexLock } from "./indexState.js";
import { pickDirectory as openDirectoryDialog } from "./pickDirectory.js";
import { checkReport, readAuthors, uncoveredCommits } from "./reportCheck.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

const WS_RE = /^ws_[A-Za-z0-9_-]{1,32}$/;
const REPO_RE = /^repo_[A-Za-z0-9_-]{1,32}$/;

type RepoCall = { workspaceId: string; repoId: string; path: string; mainBranch: string };

function repoCall(params: unknown): RepoCall {
  if (!params || typeof params !== "object") throw new Error("invalid repo params");
  const row = params as Record<string, unknown>;
  const workspaceId = row.workspaceId;
  const repoId = row.repoId;
  const repoPath = row.path;
  const mainBranch = row.mainBranch;
  if (typeof workspaceId !== "string" || typeof repoId !== "string" || typeof repoPath !== "string" || typeof mainBranch !== "string") {
    throw new Error("invalid repo params");
  }
  if (!workspaceId || !repoId || !repoPath || !mainBranch) throw new Error("invalid repo params");
  return { workspaceId, repoId, path: repoPath, mainBranch };
}

export function snapshotDir(nemaHome: string, workspaceId: string, repoId: string): string {
  if (!WS_RE.test(workspaceId)) throw new Error("invalid workspace id");
  if (!REPO_RE.test(repoId)) throw new Error("invalid repo id");
  const root = path.join(nemaHome, "ws");
  const dir = path.join(root, workspaceId, "graphify", repoId);
  const rel = path.relative(root, dir);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("invalid workspace id");
  return dir;
}

/** Removes the snapshot. A symlink is unlinked and its target is left untouched. */
export async function removeSnapshot(dir: string): Promise<void> {
  let st;
  try {
    st = await lstat(dir);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    await unlink(dir);
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

const CODE_FUNCTIONS = new Set(["code__search", "code__explain", "code__path", "code__read", "code__changes"]);

type PluginCall =
  | { name: "code__search"; repo: RepoCall; query: string }
  | { name: "code__explain"; repo: RepoCall; symbol: string }
  | { name: "code__path"; repo: RepoCall; from: string; to: string }
  | { name: "code__read"; repo: RepoCall; path: string; startLine?: number; endLine?: number }
  | { name: "code__changes"; repo: RepoCall; from: string; to?: string }
  | { name: `github__${string}`; tool: string; args: Record<string, unknown> };

function invalidArg(name: string, field: string): Error {
  return new Error(`${name} 参数无效：${field}`);
}

function firstField(name: string): string {
  switch (name) {
    case "code__search":
      return "query";
    case "code__explain":
      return "symbol";
    case "code__read":
      return "path";
    default:
      return "from";
  }
}

function argRecord(name: string, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw invalidArg(name, firstField(name));
  return args as Record<string, unknown>;
}

function needString(name: string, args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string") throw invalidArg(name, field);
  return value;
}

function optString(name: string, args: Record<string, unknown>, field: string): string | undefined {
  if (args[field] === undefined) return undefined;
  return needString(name, args, field);
}

function optLine(name: string, args: Record<string, unknown>, field: string): number | undefined {
  if (args[field] === undefined) return undefined;
  const value = args[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalidArg(name, field);
  return value;
}

function pluginParams(params: unknown): PluginCall {
  if (!params || typeof params !== "object") throw new Error("未知函数");
  const row = params as Record<string, unknown>;
  const name = row.name;
  if (typeof name !== "string" || name === "") throw new Error("未知函数");
  // GitHub calls carry no repo: the hub already checked owner/repo against the bound remotes.
  if (name.startsWith("github__")) {
    const tool = name.slice("github__".length);
    if (!GITHUB_TOOLS.includes(tool) && !(GH_COMMAND_TOOLS as readonly string[]).includes(tool)) throw new Error(`未知函数 ${name}`);
    const args = row.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`${name} 参数无效：args`);
    return { name: name as `github__${string}`, tool, args: args as Record<string, unknown> };
  }
  if (!CODE_FUNCTIONS.has(name)) throw new Error(`未知函数 ${name}`);
  const args = argRecord(name, row.args);
  switch (name) {
    case "code__search": {
      const query = needString(name, args, "query");
      return { name, repo: repoCall(row.repo), query };
    }
    case "code__explain": {
      const symbol = needString(name, args, "symbol");
      return { name, repo: repoCall(row.repo), symbol };
    }
    case "code__path": {
      const from = needString(name, args, "from");
      const to = needString(name, args, "to");
      return { name, repo: repoCall(row.repo), from, to };
    }
    case "code__read": {
      const relPath = needString(name, args, "path");
      const startLine = optLine(name, args, "startLine");
      const endLine = optLine(name, args, "endLine");
      return { name, repo: repoCall(row.repo), path: relPath, startLine, endLine };
    }
    case "code__changes": {
      const from = needString(name, args, "from");
      const to = optString(name, args, "to");
      return { name, repo: repoCall(row.repo), from, to };
    }
    default:
      throw new Error(`未知函数 ${name}`);
  }
}

function stringList(params: unknown, field: string, max: number): string[] {
  const value = (params as Record<string, unknown>)[field];
  if (!Array.isArray(value) || value.length > max || !value.every((v) => typeof v === "string")) throw new Error("invalid repo params");
  return value as string[];
}

/** Fetches, then brings the snapshot index to the main ref. Call it inside `withIndexLock`. */
async function indexLocked(root: string, repo: RepoCall, graphify?: GraphifyOpts): Promise<{ sha: string }> {
  const helpers = graphify?.ownedHelpers;
  // A failed fetch, including "没有 origin", still indexes mainRef (the local branch, or the remote ref already present).
  await fetchMain(repo.path, repo.mainBranch, helpers);
  const sha = await revParse(repo.path, await mainRef(repo.path, repo.mainBranch, helpers), helpers);
  await syncIndex(root, repo.path, sha, graphify);
  return { sha };
}

function indexRepo(nemaHome: string, repo: RepoCall, graphify?: GraphifyOpts): Promise<{ sha: string }> {
  const root = snapshotDir(nemaHome, repo.workspaceId, repo.repoId);
  return withIndexLock(root, () => indexLocked(root, repo, graphify));
}

/** Returns the snapshot root once a completed index exists, building one first if needed. */
async function ensureIndex(nemaHome: string, repo: RepoCall, graphify?: GraphifyOpts): Promise<string> {
  const root = snapshotDir(nemaHome, repo.workspaceId, repo.repoId);
  await withIndexLock(root, async () => {
    if ((await readIndexedSha(root)) === null) await indexLocked(root, repo, graphify);
  });
  return root;
}

async function runPluginCall(nemaHome: string, call: PluginCall, github: GithubReader, graphify?: GraphifyOpts): Promise<unknown> {
  const helpers = graphify?.ownedHelpers;
  if ("tool" in call) return github.call(call.tool, call.args);
  switch (call.name) {
    case "code__search":
      return queryIndex(await ensureIndex(nemaHome, call.repo, graphify), "query", [call.query], graphify);
    case "code__explain":
      return queryIndex(await ensureIndex(nemaHome, call.repo, graphify), "explain", [call.symbol], graphify);
    case "code__path":
      return queryIndex(await ensureIndex(nemaHome, call.repo, graphify), "path", [call.from, call.to], graphify);
    case "code__read": {
      const ref = await mainRef(call.repo.path, call.repo.mainBranch, helpers);
      const range =
        call.startLine !== undefined || call.endLine !== undefined
          ? { startLine: call.startLine, endLine: call.endLine }
          : undefined;
      return readFileAtRef(call.repo.path, ref, call.path, range, helpers);
    }
    case "code__changes": {
      // An omitted `to` is the bound main ref itself, which changedFiles always accepts.
      const to = call.to ?? (await mainRef(call.repo.path, call.repo.mainBranch, helpers));
      return changedFiles(call.repo.path, call.from, to, call.repo.mainBranch, helpers);
    }
  }
}

/**
 * `graphify` is for tests: production passes the packaged binary, not a PATH lookup.
 * `github` is the daemon's GitHub provider; the authenticated `gh` CLI is the production default.
 * `prepareRepo` refreshes that repo before a code call. The daemon passes the watcher.
 */
export function registerRepoHandlers(router: RpcRouter, opts: { nemaHome: string; graphify?: GraphifyOpts; github?: GithubReader; ownedHelpers?: OwnedHelperScope; pickDirectory?: () => Promise<string | null>; prepareRepo?: (repoId: string, taskId?: string) => Promise<void> }): void {
  const github = opts.github ?? new GithubGh({ ownedHelpers: opts.ownedHelpers });
  router.register("dialog.pickDirectory", async () => ({ path: await (opts.pickDirectory ?? openDirectoryDialog)() }));

  router.register("repo.inspect", async (params) => {
    if (!params || typeof params !== "object" || typeof (params as { path?: unknown }).path !== "string") {
      throw new Error("invalid repo params");
    }
    const repoPath = (params as { path: string }).path;
    if (!repoPath) throw new Error("invalid repo params");
    return inspectRepo(repoPath, opts.nemaHome, opts.ownedHelpers);
  });

  router.register("repo.index", async (params) => indexRepo(opts.nemaHome, repoCall(params), opts.graphify));

  // The hub asks this after main moves, to flag diagrams whose code changed. Both shas must be on main.
  router.register("repo.changes", async (params) => {
    const repo = repoCall(params);
    const { from, to } = params as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) throw new Error("invalid repo params");
    return changedFiles(repo.path, from, to, repo.mainBranch, opts.ownedHelpers);
  });

  // A report's check: fetch main first, then compare the reported commits and files against the bound main ref.
  router.register("report.check", async (params) => {
    const repo = repoCall(params);
    const commits = stringList(params, "commits", 50);
    const files = stringList(params, "files", 500);
    await fetchMain(repo.path, repo.mainBranch, opts.ownedHelpers);
    return checkReport(repo.path, await mainRef(repo.path, repo.mainBranch, opts.ownedHelpers), commits, files, opts.ownedHelpers);
  });

  // Commit metadata of a report's commits, read after its check. Evidence only: never part of the check.
  router.register("report.authors", async (params) => {
    const repo = repoCall(params);
    return readAuthors(repo.path, stringList(params, "commits", 50), opts.ownedHelpers);
  });

  // One read of a claimed pull request for a report's evidence: its head and one page of check runs. The hub
  // already chose the one bound target; this never picks another repository.
  router.register("github.observe", async (params) => {
    const row = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const { owner, repo, pr } = row;
    if (typeof owner !== "string" || typeof repo !== "string" || typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) throw new Error("invalid github params");
    if (!github.observePullRequest) throw new Error("GitHub call failed");
    return github.observePullRequest({ owner, repo, pr, perPage: 100 });
  });

  // The fallback: main commits in from..to that no report covers. Both shas must be on main.
  router.register("repo.uncovered", async (params) => {
    const repo = repoCall(params);
    const { from, to } = params as { from?: unknown; to?: unknown };
    if (typeof from !== "string" || typeof to !== "string" || !from || !to) throw new Error("invalid repo params");
    const covered = stringList(params, "covered", 10_000);
    return uncoveredCommits(repo.path, await mainRef(repo.path, repo.mainBranch, opts.ownedHelpers), from, to, covered, opts.ownedHelpers);
  });

  // Work package plans: which of these paths are not on the bound main ref. A `..` or absolute path is an error.
  router.register("repo.exists", async (params) => {
    const repo = repoCall(params);
    const paths = stringList(params, "paths", 500);
    return { missing: await missingAtRef(repo.path, await mainRef(repo.path, repo.mainBranch, opts.ownedHelpers), paths, opts.ownedHelpers) };
  });

  router.register("repo.forget", async (params) => {
    const repo = repoCall(params);
    const root = snapshotDir(opts.nemaHome, repo.workspaceId, repo.repoId);
    await withIndexLock(root, () => removeSnapshot(root));
    return { ok: true };
  });

  router.register("plugin.call", async (params) => {
    const call = pluginParams(params);
    if (opts.prepareRepo && "repo" in call) {
      const taskId = params && typeof params === "object" && typeof (params as { taskId?: unknown }).taskId === "string"
        ? (params as { taskId: string }).taskId
        : "";
      await opts.prepareRepo(call.repo.repoId, taskId === "" ? undefined : taskId);
    }
    return runPluginCall(opts.nemaHome, call, github, opts.graphify);
  });

  router.register("plugins.status", async () => {
    const [code, gh] = await Promise.all([graphifyInstallStatus(opts.graphify), github.status()]);
    return { code, github: { installed: gh.installed, loggedIn: gh.loggedIn, detail: gh.detail } };
  });
}
