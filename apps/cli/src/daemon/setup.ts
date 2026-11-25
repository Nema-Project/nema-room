import { homedir } from "node:os";
import { registerAttachmentHandlers } from "../attachments/handlers.js";
import { registerComponentHandlers, type ComponentRpcOptions } from "../components/rpc.js";
import { ClaudeCodeAdapter } from "../claude/adapter.js";
import { loadConfig, type NemaConfig } from "../config.js";
import { CodexDirectAdapter } from "../direct/adapter.js";
import { GithubGh, type GithubReader } from "../github/gh.js";
import { registerExtensionHandlers } from "../extensions/handlers.js";
import { registerSkillHandlers } from "../skills/rpc.js";
import { graphifyInstallStatus, type GraphifyOpts } from "../repos/graphify.js";
import { registerRepoHandlers } from "../repos/handlers.js";
import { parseReposSync, RepoWatcher } from "../repos/watcher.js";
import { computeHeldRepos } from "../repos/heldRepos.js";
import { electronRunAsNode } from "../platform.js";
import { migrateReportHooks } from "../report/install.js";
import { parseDaemonHubUrl, resolveDaemonToken } from "./register.js";
import { connectDaemon } from "./connection.js";
import { Cooldowns } from "../routing/cooldown.js";
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

/**
 * The daemon's runner. Codex stays on the direct adapter; Claude Code is selected only when config.adapter is
 * claude-code.
 *
 * Both adapters share one cooldown table: spec §4.4 keeps it per process, and a rate limit learned by one of
 * them is about the same account. Neither adapter is given an account getter here, so each reads
 * `accounts.json` when a task starts — a change made in the settings page applies to the next task without a
 * daemon restart.
 */
export function createRunner(o: RunnerSetup): Runner {
  if (!o.cliEntry) throw new Error("cliEntry is required");
  const cooldowns = new Cooldowns();
  const direct = new CodexDirectAdapter({ nemaHome: o.nemaHome, version: o.version, codexHome: o.userCodexHome, cooldowns });
  const claude = new ClaudeCodeAdapter({ nemaHome: o.nemaHome, cliEntry: o.cliEntry, execPath: o.execPath ?? process.execPath, ownedHelpers: o.ownedHelpers, codexHome: o.userCodexHome, cooldowns });
  return new Runner([direct, claude], o.getConfig ?? (() => loadConfig(o.nemaHome)));
}

export type DaemonStart = {
  hubUrl: string;
  nemaHome: string;
  userCodexHome: string;
  version: string;
  getConfig?: () => NemaConfig;
  cliEntry: string;
  execPath?: string;
  /**
   * Graphify resolution. Tests pass a fake `bin`; desktop passes its `payloadRoot` (older payloads may still
   * carry tools/graphify); otherwise the component store is used. Never a PATH lookup.
   */
  graphify?: GraphifyOpts;
  /** Explicit provider injection for tests or callers; production uses the signed-in `gh` CLI. */
  github?: GithubReader;
  /** Component RPC seams (store root, lock, installer, agent CLI detection); production uses the defaults. */
  components?: Omit<ComponentRpcOptions, "nemaHome" | "getConfig">;
  /** Where the report token the hub should accept lives; defaults to `nemaHome`. */
  reportTokenHome?: string;
  ownedHelpers?: OwnedHelperScope;
} & ({ token: string } | { tokenFile: string });

/** Connects the daemon and answers repo RPC plus `plugin.call` and `plugins.status`. */
export function startDaemon(o: DaemonStart): { close(): Promise<void>; watcher: RepoWatcher } {
  const hubUrl = parseDaemonHubUrl(o.hubUrl).origin;
  const token = resolveDaemonToken(o.nemaHome, hubUrl, o);
  // Hooks installed against the removed payload Node keep that absolute path. Rewrite them once Electron is the Node.
  if (electronRunAsNode()) {
    try {
      migrateReportHooks({ home: homedir(), nodeBin: o.execPath ?? process.execPath, cliEntry: o.cliEntry });
    } catch (error) {
      console.error("[nema] report hook migration failed", error);
    }
  }
  const runner = createRunner(o);
  const rpc = new RpcRouter();
  const graphify = { ...o.graphify, ownedHelpers: o.ownedHelpers };
  const github = o.github ?? new GithubGh({ ownedHelpers: o.ownedHelpers });
  const extensions = registerExtensionHandlers(rpc, o.nemaHome, {
    checkGraphify: () => graphifyInstallStatus(graphify),
    checkGithub: () => github.status(),
    ownedHelpers: o.ownedHelpers,
  });
  let sendMessage: ((message: unknown) => boolean) | null = null;
  /** Normalized remotes this daemon holds (D-6); empty until the first `repos.sync` reports them. */
  let heldRepos: string[] = [];
  /** Generation of the latest `repos.sync`; an older sync's result is discarded, never applied. */
  let syncGeneration = 0;
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
  // Status and a confirmed install only: nothing here runs at start-up or when a workspace opens.
  const components = registerComponentHandlers(rpc, { ...o.components, nemaHome: o.nemaHome, getConfig: o.getConfig });
  registerAttachmentHandlers(rpc, o.nemaHome, o.getConfig);
  registerSkillHandlers(rpc, o.nemaHome);
  rpc.register("repos.sync", async (params) => {
    watcher.setRepos(parseReposSync(params));
    const generation = ++syncGeneration;
    // What this daemon watches just changed: re-inspect the watched paths and report the new held set.
    // A failed inspect never fails the sync; the stale path is simply not reported held.
    // Syncs run concurrently (the connection does not await each RPC), so a newer sync can land while
    // this one still inspects: only the latest generation may apply and report its holdings.
    try {
      const next = await computeHeldRepos(watcher, o.nemaHome, o.ownedHelpers);
      if (generation !== syncGeneration) return { ok: true };
      heldRepos = next;
    } catch (error) {
      console.error("[nema] held repos refresh failed", error);
      return { ok: true };
    }
    sendMessage?.({ type: "holdings", heldRepos });
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
    hubUrl,
    token,
    runner,
    nemaHome: o.nemaHome,
    ...(o.reportTokenHome ? { reportTokenHome: o.reportTokenHome } : {}),
    version: o.version,
    heldRepos: () => heldRepos,
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
      // MCP servers are stopped with the daemon; none is started again on the next start.
      const tasks = [runner.stop(), watcher.stop(), connection.close(), github.close(), extensions.close(), components.close()];
      closing = Promise.all(tasks).then(() => {});
      return closing;
    },
  };
}
