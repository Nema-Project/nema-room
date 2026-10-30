import { homedir } from "node:os";
import path from "node:path";
import type { RpcRouter } from "../daemon/rpc.js";
import { parseSkillSource } from "@nema/shared";
import { SkillInstaller, type InstallJob } from "./install.js";
import { resolveSkillSource, type SkillCandidate, type SkillResolution, type SourceFetch } from "./source.js";
import { bundledExtensions, openExtensionStore, type ExtensionRecord } from "./store.js";
import { discoverSkills, inspectSkillFolder, placeSkill } from "./discover.js";
import { graphifyInstallStatus } from "../repos/graphify.js";
import { GithubGh } from "../github/gh.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { createMcpHandlers } from "./mcpHandlers.js";

/** Hub waits 60 s for this RPC; stop GitHub reads first so the daemon's own error reaches the page. */
const RESOLVE_TIMEOUT_MS = 45_000;

function requireId(params: unknown, method: string): string {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !id) throw new Error(`${method} needs a string id`);
  return id;
}

function requireUseState(params: unknown): "enabled" | "disabled" {
  const useState = (params as { useState?: unknown } | undefined)?.useState;
  if (useState !== "enabled" && useState !== "disabled") throw new Error("extensions.setUse needs useState enabled or disabled");
  return useState;
}

export type ExtensionRemoval = { id: string; removed: "managed" | "external" };

/** A resolved source as the install preview shows it: where each skill would land, and whether it is already there. */
export type SourcePreview = SkillResolution & { skills: Array<SkillCandidate & { target: string | null; installed: boolean }> };

export type ExtensionHandlerOptions = {
  fetch?: SourceFetch;
  /** Home directory the known skill locations are read from; the user's home in production. */
  home?: string;
  /** Runs the packaged Graphify version check; production passes the daemon's packaged binary. */
  checkGraphify?: () => Promise<{ installed: boolean; detail: string }>;
  /** Asks the GitHub CLI whether it is installed and signed in; production passes the daemon's reader. */
  checkGithub?: () => Promise<{ installed: boolean; loggedIn: boolean; detail: string; inconclusive?: boolean }>;
  now?: () => Date;
  /** Desktop runtime: MCP stdio servers run under the guardian. */
  ownedHelpers?: OwnedHelperScope;
  /** Connect plus `listTools` for an MCP server; for tests. */
  mcpTimeoutMs?: number;
};

export type ExtensionHandlers = {
  /** Stops every MCP server this daemon started. */
  close(): Promise<void>;
};

const BUNDLED_IDS = new Set(bundledExtensions().map((row) => row.id));

export function registerExtensionHandlers(router: RpcRouter, nemaHome: string, options: ExtensionHandlerOptions = {}): ExtensionHandlers {
  const root = path.join(nemaHome, "extensions");
  const store = openExtensionStore(root);
  const fetch = options.fetch ?? (globalThis.fetch as unknown as SourceFetch);
  const installer = new SkillInstaller({ root, store, fetch });
  const home = options.home ?? homedir();
  const checkGraphify = options.checkGraphify ?? (() => graphifyInstallStatus());
  const checkGithub = options.checkGithub ?? (() => new GithubGh().status());
  const now = options.now ?? (() => new Date());
  // No install can be running before the router answers, so anything still `installing` was cut off.
  installer.recover();
  const mcp = createMcpHandlers(nemaHome, { ownedHelpers: options.ownedHelpers, timeoutMs: options.mcpTimeoutMs });
  mcp.register(router, (id) => store.list().find((row) => row.id === id));
  router.register("extensions.list", async () => store.list().map((row) => (row.kind === "mcp" && row.provision === "managed" ? { ...row, mcp: mcp.state(row) } : row)));
  // Three operations, three sets of rules, and the page may only reach two of them.
  //
  // Use state: flip one record's switch; every provision can be turned off and on again.
  // Install: stage a directory and activate it; a separate path with its own staging rules.
  // Remove: only an extension Nema provisioned can be deleted outright, which means its own
  // `extensions/<id>` directory goes with the record. An external one is only detached from the
  // index: the files stay exactly where the person put them. A bundled extension ships inside the
  // app, so there is nothing here to delete and the request is refused.
  router.register("extensions.setUse", async (params) => {
    const id = requireId(params, "extensions.setUse");
    const useState = requireUseState(params);
    const current = store.list().find((row) => row.id === id);
    // A switched-off MCP server does not keep running, and no start slips in before the write.
    if (useState === "disabled" && current?.kind === "mcp") return mcp.disable(id, () => store.setUseState(id, useState));
    return store.setUseState(id, useState);
  });
  router.register("extensions.remove", async (params): Promise<ExtensionRemoval> => {
    const id = requireId(params, "extensions.remove");
    const record = store.list().find((row) => row.id === id);
    if (!record) throw new Error(`extension not found: ${id}`);
    if (installer.running(id)) throw new Error(`${id} is installing; cancel the install and wait for it to stop first`);
    if (record.provision === "bundled") throw new Error("bundled extensions cannot be removed");
    if (record.provision === "managed" && record.kind === "mcp") {
      // Stop, then secrets, directory and record, in that order.
      await mcp.remove(id);
      return { id, removed: "managed" };
    }
    if (record.provision === "managed") {
      store.removeManaged(id);
      installer.forget(id);
      return { id, removed: "managed" };
    }
    store.detach(id);
    return { id, removed: "external" };
  });
  // Read-only: parse the pasted source, pin it to one commit, and list the skills at that commit. No
  // record or directory is written, so an abandoned preview leaves nothing behind.
  router.register("extensions.resolveSource", async (params): Promise<SourcePreview> => {
    const raw = (params as { source?: unknown } | undefined)?.source;
    if (typeof raw !== "string") throw new Error("extensions.resolveSource needs a string source");
    const source = parseSkillSource(raw);
    let resolved: SkillResolution;
    try {
      resolved = await resolveSkillSource(source, { fetch, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new Error(`GitHub did not answer within ${RESOLVE_TIMEOUT_MS / 1000} s`);
      }
      throw error;
    }
    // Only a finished install counts; a cancelled or failed one leaves a record but no usable copy.
    const present = new Set(store.list().filter((row) => row.installState === "installed").map((row) => row.id));
    return {
      ...resolved,
      skills: resolved.skills.map((skill) => ({
        ...skill,
        target: skill.id ? path.join(root, "extensions", skill.id) : null,
        installed: skill.id ? present.has(skill.id) : false,
      })),
    };
  });
  // Install one previewed skill: the page sends back the source, the commit and the folder it showed,
  // and the daemon installs exactly that. The call returns once the record is written; the download
  // continues and `extensions.installStatus` reports it.
  router.register("extensions.install", async (params): Promise<InstallJob> => {
    const p = (params ?? {}) as { source?: unknown; commit?: unknown; path?: unknown };
    if (typeof p.source !== "string" || typeof p.commit !== "string" || typeof p.path !== "string") {
      throw new Error("extensions.install needs string source, commit and path");
    }
    return installer.start({ source: p.source, commit: p.commit, path: p.path });
  });
  router.register("extensions.installStatus", async (params) => installer.status(requireId(params, "extensions.installStatus")));
  router.register("extensions.cancelInstall", async (params) => installer.cancel(requireId(params, "extensions.cancelInstall")));
  router.register("extensions.retryInstall", async (params) => installer.retry(requireId(params, "extensions.retryInstall")));
  // Read-only: what skill folders other agents keep in the known locations, and which are attached.
  router.register("extensions.discover", async () => discoverSkills(home, store.list()));
  // Attach a folder by reference. Nothing is copied, and Remove later only drops the record.
  router.register("extensions.attach", async (params): Promise<ExtensionRecord> => {
    const raw = (params as { path?: unknown } | undefined)?.path;
    if (typeof raw !== "string" || !path.isAbsolute(raw)) throw new Error("extensions.attach needs an absolute folder path");
    const inspected = inspectSkillFolder(raw);
    const placed = placeSkill(inspected, store.list());
    if (placed.attached) throw new Error(`already attached: ${inspected.path}`);
    if (placed.problem || !placed.id) throw new Error(`cannot attach ${inspected.path}: ${placed.problem ?? "invalid-id"}`);
    return store.attachExternal({
      id: placed.id,
      kind: "skill",
      name: inspected.name!,
      summary: inspected.description!,
      source: inspected.path,
      revision: "local",
      provision: "external",
      installState: "installed",
      useState: "enabled",
      availability: "ready",
      externalPath: inspected.path,
      error: null,
    });
  });
  // Check a bundled item again and keep the result. Graphify has a packaged runtime of its own and
  // GitHub needs the `gh` CLI signed in; the others are code inside the app and are ready whenever
  // the app runs. The check time is taken before the check.
  // One check per item at a time: a Repair asked for while one of the same item runs shares that
  // check's result instead of queueing another, so checks never overlap and no caller waits for
  // more than one check.
  const repairs = new Map<string, Promise<ExtensionRecord>>();
  router.register("extensions.repair", async (params): Promise<ExtensionRecord> => {
    const id = requireId(params, "extensions.repair");
    if (!BUNDLED_IDS.has(id)) throw new Error("only a bundled extension can be repaired");
    const running = repairs.get(id);
    if (running) return running;
    const run = repair(id);
    repairs.set(id, run);
    try {
      return await run;
    } finally {
      if (repairs.get(id) === run) repairs.delete(id);
    }
  });
  const repair = async (id: string): Promise<ExtensionRecord> => {
    const checkedAt = now().toISOString();
    let availability: ExtensionRecord["availability"] = "ready";
    let error: string | null = null;
    if (id === "github") {
      try {
        const status = await checkGithub();
        if (status.inconclusive) {
          availability = "damaged";
          error = "github-cli-damaged";
        } else if (!status.installed) {
          availability = "missing-dependency";
          error = "github-cli-missing";
        } else if (!status.loggedIn) {
          availability = "missing-dependency";
          error = "github-cli-signed-out";
        }
      } catch {
        availability = "damaged";
        error = "github-cli-damaged";
      }
    }
    if (id === "code") {
      try {
        if (!(await checkGraphify()).installed) {
          availability = "missing-dependency";
          error = "bundled-runtime-missing";
        }
      } catch {
        availability = "damaged";
        error = "bundled-runtime-damaged";
      }
    }
    return store.recordCheck(id, { availability, error, checkedAt });
  };
  return { close: () => mcp.close() };
}
