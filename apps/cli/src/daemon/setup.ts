import { ClaudeCodeAdapter } from "../claude/adapter.js";
import { loadConfig, type NemaConfig } from "../config.js";
import { CodexDirectAdapter } from "../direct/adapter.js";
import { GithubGh, type GithubReader } from "../github/gh.js";
import type { GraphifyOpts } from "../repos/graphify.js";
import { registerExtensionHandlers } from "../extensions/handlers.js";
import { registerRepoHandlers } from "../repos/handlers.js";
import { parseReposSync, RepoWatcher } from "../repos/watcher.js";
import { connectDaemon } from "./connection.js";
import { RpcRouter } from "./rpc.js";
import { Runner } from "./runner.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export type RunnerSetup = {
  nemaHome: string;
  userCodexHome: string;
  version: string;
  getConfig?: () => NemaConfig;
  cliEntry: string;
  execPath?: string;
  ownedHelpers?: OwnedHelperScope;
};

/** The daemon's runner. Codex stays on the direct adapter; Claude Code is selected only when config.adapter is claude-code. */
export function createRunner(o: RunnerSetup): Runner {
  if (!o.cliEntry) throw new Error("cliEntry is required");
  const direct = new CodexDirectAdapter({ nemaHome: o.nemaHome, version: o.version, codexHome: o.userCodexHome });
  const claude = new ClaudeCodeAdapter({ nemaHome: o.nemaHome, cliEntry: o.cliEntry, execPath: o.execPath ?? process.execPath, ownedHelpers: o.ownedHelpers });
  return new Runner([direct, claude], o.getConfig ?? (() => loadConfig(o.nemaHome)));
}

export type DaemonStart = {
  hubUrl: string;
  token: string;
  nemaHome: string;
  userCodexHome: string;
  version: string;
  getConfig?: () => NemaConfig;
  cliEntry: string;
  execPath?: string;
  /** For tests: production passes the packaged `tools/graphify` binary, not a PATH lookup. */
  graphify?: GraphifyOpts;
  /** Explicit provider injection for tests or callers; production uses the signed-in `gh` CLI. */
  github?: GithubReader;
  /** Where the report token the hub should accept lives; defaults to `nemaHome`. */
  reportTokenHome?: string;
  ownedHelpers?: OwnedHelperScope;
};

/** Connects the daemon and answers repo RPC plus `plugin.call` and `plugins.status`. */
export function startDaemon(o: DaemonStart): { close(): Promise<void>; watcher: RepoWatcher } {
  const runner = createRunner(o);
  const rpc = new RpcRouter();
  const graphify = { ...o.graphify, ownedHelpers: o.ownedHelpers };
  const github = o.github ?? new GithubGh({ ownedHelpers: o.ownedHelpers });
  registerExtensionHandlers(rpc, o.nemaHome);
  let sendMessage: ((message: unknown) => boolean) | null = null;
  const watcher = new RepoWatcher({
    nemaHome: o.nemaHome,
    graphify,
    onMoved: (move) => {
      if (!sendMessage) return false;
      return sendMessage({ type: "repo.moved", repoId: move.repoId, mainRef: move.mainRef, from: move.from, to: move.to });
    },
    onFetch: (report) => {
      const message: { type: "repo.fetched"; repoId: string; ok: boolean; error?: string; at: string } = {
        type: "repo.fetched",
        repoId: report.repoId,
        ok: report.ok,
        at: report.at,
      };
      if (report.error !== undefined) message.error = report.error;
      sendMessage?.(message);
    },
  });
  registerRepoHandlers(rpc, {
    nemaHome: o.nemaHome,
    graphify,
    github,
    ownedHelpers: o.ownedHelpers,
    prepareRepo: (repoId, taskId) => watcher.prepare(repoId, taskId),
  });
  rpc.register("repos.sync", async (params) => {
    watcher.setRepos(parseReposSync(params));
    return { ok: true };
  });
  // A coding agent's hook fired for this repo: look at its main now. Answered at once; the tick runs on.
  rpc.register("repo.tick", async (params) => {
    const repoId = (params as { repoId?: unknown } | null)?.repoId;
    if (typeof repoId !== "string" || repoId === "") throw new Error("invalid repo params");
    void watcher.tickRepo(repoId).catch((error) => {
      console.error("[nema] repo tick failed", error);
    });
    return { ok: true };
  });
  watcher.start();
  const connection = connectDaemon({
    hubUrl: o.hubUrl,
    token: o.token,
    runner,
    nemaHome: o.nemaHome,
    ...(o.reportTokenHome ? { reportTokenHome: o.reportTokenHome } : {}),
    version: o.version,
    rpc,
    bindSend: (send) => {
      sendMessage = send;
    },
  });
  let closing: Promise<void> | undefined;
  return {
    watcher,
    close() {
      if (closing) return closing;
      const tasks = [runner.stop(), watcher.stop(), connection.close(), github.close()];
      closing = Promise.all(tasks).then(() => {});
      return closing;
    },
  };
}
