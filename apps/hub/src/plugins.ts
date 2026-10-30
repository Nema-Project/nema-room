import { z } from "zod";
import { DEFAULT_GRILL_SETTINGS, GRILL_EXTRA_RULES_MAX, PLUGINS, bundledExtensions, isCheckTime, pluginFunction, type ExtensionRecord, type GrillSettings, type PluginManifest, type PluginToolSpec } from "@nema/shared";
import { DaemonRpcError, type DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import { githubTargets } from "./githubScope.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listRepos, type Repo } from "./repos.js";

const DAEMON_OFFLINE = new Set(["daemon 未连接", "daemon 已断开", "daemon 响应超时"]);

export class PluginError extends Error {
  constructor(
    public status: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

export type WorkspacePluginState = {
  plugin: PluginManifest;
  enabled: boolean;
  disabledFunctions: string[];
  settings: Record<string, unknown>;
};

type StateRow = {
  plugin_id: string;
  enabled: boolean;
  disabled_functions: unknown;
  settings: unknown;
};

const GrillSettingsSchema = z.object({
  strictness: z.enum(["strict", "lenient"]).default("strict"),
  extraRules: z.string().default(""),
});

const GithubSettingsSchema = z.object({ allowWrites: z.boolean().default(false) });

function settingsObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return settingsObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The stored settings of a plugin with defaults filled in. Only grill-me and GitHub (allowWrites) have settings. */
function resolveSettings(pluginId: string, raw: unknown): Record<string, unknown> {
  if (pluginId === "github") {
    const parsed = GithubSettingsSchema.safeParse(settingsObject(raw));
    return parsed.success ? parsed.data : { allowWrites: false };
  }
  if (pluginId !== "grill") return {};
  const parsed = GrillSettingsSchema.safeParse(settingsObject(raw));
  return parsed.success ? parsed.data : { ...DEFAULT_GRILL_SETTINGS };
}

export type GrillState = GrillSettings & { enabled: boolean };

export async function grillState(db: Db, workspaceId: string): Promise<GrillState> {
  const state = (await workspacePluginState(db, workspaceId)).find((item) => item.plugin.id === "grill")!;
  return { enabled: state.enabled, ...(state.settings as GrillSettings) };
}

/** `daemon 未连接` / `daemon 已断开` / `daemon 响应超时` are 503. Any other daemon error is 502. */
export function daemonHttpStatus(message: string): 502 | 503 {
  return DAEMON_OFFLINE.has(message) ? 503 : 502;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string" || value.length < 2 || value === "{}") return [];
  const inner = value.startsWith("{") && value.endsWith("}") ? value.slice(1, -1) : value;
  return inner ? inner.split(",") : [];
}

export async function workspacePluginState(db: Db, workspaceId: string): Promise<WorkspacePluginState[]> {
  const rows = await db.query<StateRow>(
    `select plugin_id, enabled, disabled_functions, settings from workspace_plugins where workspace_id = $1`,
    [workspaceId],
  );
  const byId = new Map(rows.map((row) => [row.plugin_id, row]));
  return PLUGINS.map((plugin) => {
    const row = byId.get(plugin.id);
    if (!row) return { plugin, enabled: plugin.dataFlow === "local", disabledFunctions: [], settings: resolveSettings(plugin.id, {}) };
    return { plugin, enabled: row.enabled, disabledFunctions: stringArray(row.disabled_functions), settings: resolveSettings(plugin.id, row.settings) };
  });
}

function withRepoList(parameters: Record<string, unknown>, repos: Repo[]): Record<string, unknown> {
  const cloned = structuredClone(parameters);
  const properties = cloned.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties) || !("repo" in properties)) return cloned;
  const props = properties as Record<string, unknown>;
  const repo = props.repo;
  const schema = repo && typeof repo === "object" && !Array.isArray(repo) ? { ...(repo as Record<string, unknown>) } : { type: "string" };
  props.repo = { ...schema, description: repos.map((item) => `${item.id} (${item.label})`).join(", ") };
  return cloned;
}

/**
 * Which extensions the daemon has turned off for this install.
 *
 * The switch lives in the daemon's extension index, one record per install rather than per
 * workspace, so the hub has to ask for it. A failure is not swallowed: an unreadable switch would
 * make every offer a guess, and a disabled extension that still answers is worse than one that is
 * briefly missing.
 */
export async function disabledExtensionIds(daemon: DaemonRpc): Promise<Set<string>> {
  const rows = await daemon.call("extensions.list", {});
  if (!Array.isArray(rows)) throw new DaemonRpcError("extensions.list returned an invalid result");
  return new Set(
    (rows as ExtensionRecord[]).filter((row) => row?.useState === "disabled").map((row) => row.id),
  );
}

/**
 * Drop the tools of every extension the install turned off.
 *
 * The switch is install-wide, not per workspace, so it lives in the daemon's extension index rather
 * than in `workspace_plugins`; every path that offers or accepts a tool has to subtract it. Called
 * separately from `enabledPluginTools` so the pure workspace decision stays free of network calls.
 */
export function withoutDisabledExtensions(tools: PluginToolSpec[], disabled: Set<string>): PluginToolSpec[] {
  if (disabled.size === 0) return tools;
  return tools.filter((tool) => !disabled.has(pluginFunction(tool.name)?.plugin.id ?? ""));
}

export async function enabledPluginTools(db: Db, workspaceId: string): Promise<PluginToolSpec[]> {
  const [states, repos] = await Promise.all([workspacePluginState(db, workspaceId), listRepos(db, workspaceId)]);
  const targets = githubTargets(repos).map((target) => `${target.owner}/${target.repo}`);
  const tools: PluginToolSpec[] = [];
  for (const state of states) {
    if (!state.enabled) continue;
    // graphify and archify only have something to read or draw once this workspace has bound a repo.
    if (repos.length === 0 && state.plugin.scope !== "none") continue;
    // GitHub only has something to read once a bound repo has a github.com remote.
    if (state.plugin.scope === "github" && targets.length === 0) continue;
    const disabled = new Set(state.disabledFunctions);
    for (const fn of state.plugin.functions) {
      // A write function is offered only when the workspace opted in (GitHub: allowWrites, off by default).
      if (disabled.has(fn.name) || (!fn.readOnly && !(state.plugin.id === "github" && state.settings.allowWrites === true))) continue;
      if (state.plugin.scope === "github") {
        tools.push({
          name: fn.name,
          description: `${fn.description} Allowed repositories (owner/repo): ${targets.join(", ")}.`,
          parameters: structuredClone(fn.parameters),
        });
        continue;
      }
      tools.push({ name: fn.name, description: fn.description, parameters: withRepoList(fn.parameters, repos) });
    }
  }
  return tools;
}

export async function setPluginState(
  db: Db,
  workspaceId: string,
  pluginId: string,
  patch: { enabled?: boolean; disabledFunctions?: string[]; settings?: Record<string, unknown> },
): Promise<WorkspacePluginState> {
  const ws = await db.query(`select 1 from workspaces where id = $1`, [workspaceId]);
  if (ws.length === 0) throw new PluginError(404, `找不到 workspace：${workspaceId}`);
  const plugin = PLUGINS.find((item) => item.id === pluginId);
  if (!plugin) throw new PluginError(404, `找不到插件：${pluginId}`);
  const known = new Set(plugin.functions.map((fn) => fn.name));
  for (const name of patch.disabledFunctions ?? []) {
    if (!known.has(name)) throw new PluginError(400, `未知函数 ${name}`);
  }
  let settings: Record<string, unknown> | undefined;
  if (patch.settings !== undefined) {
    if (plugin.id === "github") {
      const parsedGithub = GithubSettingsSchema.safeParse(patch.settings);
      if (!parsedGithub.success) throw new PluginError(400, "无效的 GitHub 设置");
      settings = parsedGithub.data;
    } else {
      if (plugin.id !== "grill") throw new PluginError(400, `插件 ${pluginId} 没有设置项`);
      const extra = patch.settings.extraRules;
      if (typeof extra === "string" && extra.length > GRILL_EXTRA_RULES_MAX) throw new PluginError(400, "补充追问规则最多 2000 字");
      const parsed = GrillSettingsSchema.safeParse(patch.settings);
      if (!parsed.success) throw new PluginError(400, "无效的追问设置");
      settings = parsed.data;
    }
  }
  const rows = await db.query<StateRow>(
    `select plugin_id, enabled, disabled_functions, settings from workspace_plugins where workspace_id = $1 and plugin_id = $2`,
    [workspaceId, pluginId],
  );
  const current = rows[0];
  const enabled = patch.enabled ?? current?.enabled ?? plugin.dataFlow === "local";
  const disabledFunctions = patch.disabledFunctions ?? stringArray(current?.disabled_functions);
  const stored = settings ?? resolveSettings(plugin.id, current?.settings);
  if (patch.enabled !== undefined || patch.disabledFunctions !== undefined || settings !== undefined) {
    await db.query(
      `insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions, settings)
       values ($1, $2, $3, $4, $5)
       on conflict (workspace_id, plugin_id) do update
         set enabled = excluded.enabled, disabled_functions = excluded.disabled_functions, settings = excluded.settings`,
      [workspaceId, pluginId, enabled, disabledFunctions, JSON.stringify(stored)],
    );
  }
  return { plugin, enabled, disabledFunctions, settings: stored };
}

type InstallStatus = { installed: boolean; detail: string; loggedIn?: boolean };

export function pluginsForUi(status: unknown): Array<PluginManifest & InstallStatus> {
  const installed = new Map<string, InstallStatus>();
  if (status && typeof status === "object" && !Array.isArray(status)) {
    for (const [id, raw] of Object.entries(status as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      if (typeof row.installed === "boolean" && typeof row.detail === "string") {
        // Only plugins that need a token (GitHub) report a login state.
        installed.set(id, { installed: row.installed, detail: row.detail, ...(typeof row.loggedIn === "boolean" ? { loggedIn: row.loggedIn } : {}) });
      }
    }
  }
  return PLUGINS.map((plugin) => {
    // A hub-side plugin ships with the hub; the daemon does not report it.
    if (plugin.runsOn === "hub") return { ...plugin, installed: true, detail: "" };
    const row = installed.get(plugin.id);
    return { ...plugin, ...(row ?? { installed: false, detail: "" }) };
  });
}

/**
 * The last state the daemon wrote to its extension index, read straight from disk.
 *
 * Only for the offline fallback. The daemon is the owner of these records, but when it is not
 * running the page still has to show what the person chose rather than the shipped defaults, or
 * every extension they turned off looks enabled again. A missing or damaged index means the seeds;
 * a read here never throws, because it runs on a page that is already reporting a disconnected daemon.
 */
const AVAILABILITY = new Set(["ready", "missing-dependency", "incompatible", "damaged"]);

export function extensionIndexFromDisk(nemaHome: string | undefined): ExtensionRecord[] {
  const seeds = bundledExtensions();
  if (!nemaHome) return seeds;
  let rows: unknown;
  try {
    rows = JSON.parse(readFileSync(path.join(nemaHome, "extensions", "index.json"), "utf8")) as unknown;
  } catch {
    return seeds;
  }
  if (!Array.isArray(rows)) return seeds;
  const stored = new Map<string, ExtensionRecord>();
  for (const row of rows) {
    const record = row as Partial<ExtensionRecord> | null;
    if (record && typeof record.id === "string") stored.set(record.id, record as ExtensionRecord);
  }
  const merged = seeds.map((seed) => {
    const override = stored.get(seed.id);
    stored.delete(seed.id);
    // A seed's choice is the only thing an override may change; everything else is what shipped.
    const useState = override?.useState === "enabled" || override?.useState === "disabled" ? override.useState : seed.useState;
    // A Repair result counts only with the time it was taken, the same rule the daemon applies.
    // Same rule as the daemon's store: a string check time, a known availability, and an error that
    // is a string or null; anything else leaves the seed's values.
    const checked = override && isCheckTime(override.checkedAt) && AVAILABILITY.has(override.availability) &&
      (override.error === null || typeof override.error === "string")
      ? { availability: override.availability, error: override.error, checkedAt: override.checkedAt }
      : {};
    return { ...seed, useState, ...checked };
  });
  // Managed and external extensions exist only on disk, so the index is their only record.
  return [...merged, ...[...stored.values()]];
}

/** Daemon records when it is up. Its own index on disk when it is down, so the page can still open. */
export async function listExtensions(daemon: DaemonRpc, nemaHome?: string): Promise<ExtensionRecord[]> {
  try {
    const rows = await daemon.call("extensions.list", {});
    if (!Array.isArray(rows)) throw new DaemonRpcError("extensions.list returned an invalid result");
    return rows as ExtensionRecord[];
  } catch (error) {
    if (error instanceof DaemonRpcError && DAEMON_OFFLINE.has(error.message)) return extensionIndexFromDisk(nemaHome);
    throw error;
  }
}

/** Flip one record's use state through the daemon, which owns the installed directory and index. */
export async function setExtensionUse(daemon: DaemonRpc, id: string, useState: "enabled" | "disabled"): Promise<ExtensionRecord> {
  const row = await daemon.call("extensions.setUse", { id, useState });
  if (!row || typeof row !== "object") throw new DaemonRpcError("extensions.setUse returned an invalid result");
  return row as ExtensionRecord;
}

/**
 * Delete a managed extension, or detach an external one from the index.
 *
 * The daemon owns both the directory and the record, so it also owns the decision of which removal
 * applies; the hub only carries the answer back. `removed` says which one happened, because the page
 * shows a different outcome for a deleted extension than for one that was only taken off the list.
 */
export async function removeExtension(daemon: DaemonRpc, id: string): Promise<{ id: string; removed: "managed" | "external" }> {
  const result = await daemon.call("extensions.remove", { id });
  // A dropped or partial reply must not pass as a removal: the page drops the row on this answer, so
  // an array, a record without a verdict, or a verdict about another id has to fail here.
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new DaemonRpcError("extensions.remove returned an invalid result");
  }
  const row = result as Record<string, unknown>;
  const removed = row.removed;
  if (typeof row.id !== "string" || row.id.length === 0 || row.id !== id || (removed !== "managed" && removed !== "external")) {
    throw new DaemonRpcError("extensions.remove returned an invalid result");
  }
  return { id: row.id, removed };
}

/** GitHub reads take several requests; an ordinary daemon call gets 30 s, this one gets 60 s. */
export const RESOLVE_SOURCE_TIMEOUT_MS = 60_000;

/**
 * Pin a pasted skill source to one commit and list what it contains, without installing anything.
 *
 * The daemon does the GitHub reads, since it is the side that will later copy the files. The hub only
 * checks the answer is a preview pinned to a 40-character commit before the page shows it: a preview
 * that names a branch would let the page promise one version and the install copy another.
 */
export async function resolveExtensionSource(daemon: DaemonRpc, source: string): Promise<Record<string, unknown>> {
  const result = await daemon.call("extensions.resolveSource", { source }, RESOLVE_SOURCE_TIMEOUT_MS);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new DaemonRpcError("extensions.resolveSource returned an invalid result");
  }
  const row = result as Record<string, unknown>;
  if (typeof row.repository !== "string" || typeof row.commit !== "string" || !/^[0-9a-f]{40}$/.test(row.commit) || !Array.isArray(row.skills)) {
    throw new DaemonRpcError("extensions.resolveSource returned an invalid result");
  }
  return row;
}

const INSTALL_STATES = new Set(["running", "installed", "failed", "cancelled"]);

/** An install job as the daemon reports it; anything else, or a job for another id, is not passed on. */
function installJob(result: unknown, method: string, id?: string): Record<string, unknown> {
  const row = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
  if (
    !row ||
    typeof row.id !== "string" ||
    (id !== undefined && row.id !== id) ||
    typeof row.state !== "string" ||
    !INSTALL_STATES.has(row.state) ||
    typeof row.done !== "number" ||
    typeof row.total !== "number" ||
    !(row.error === null || typeof row.error === "string") ||
    !(row.commit === null || (typeof row.commit === "string" && /^[0-9a-f]{40}$/.test(row.commit))) ||
    !(row.path === null || typeof row.path === "string")
  ) {
    throw new DaemonRpcError(`${method} returned an invalid result`);
  }
  return row;
}

/**
 * Start installing one previewed skill. The daemon re-reads that exact commit and folder, writes the
 * `installing` record and answers; the download carries on and is followed with `installStatus`.
 */
export async function installExtension(daemon: DaemonRpc, request: { source: string; commit: string; path: string }): Promise<Record<string, unknown>> {
  return installJob(await daemon.call("extensions.install", request, RESOLVE_SOURCE_TIMEOUT_MS), "extensions.install");
}

export async function extensionInstallStatus(daemon: DaemonRpc, id: string): Promise<Record<string, unknown>> {
  return installJob(await daemon.call("extensions.installStatus", { id }), "extensions.installStatus", id);
}

export async function cancelExtensionInstall(daemon: DaemonRpc, id: string): Promise<Record<string, unknown>> {
  return installJob(await daemon.call("extensions.cancelInstall", { id }), "extensions.cancelInstall", id);
}

/** Retry re-resolves the recorded commit before it answers, so it gets the same budget as a start. */
export async function retryExtensionInstall(daemon: DaemonRpc, id: string): Promise<Record<string, unknown>> {
  return installJob(await daemon.call("extensions.retryInstall", { id }, RESOLVE_SOURCE_TIMEOUT_MS), "extensions.retryInstall", id);
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const nullableString = (value: unknown) => value === null || typeof value === "string";

/** Skill folders the daemon found in the known locations on its computer. Read-only. */
export async function discoverExtensions(daemon: DaemonRpc): Promise<Record<string, unknown>> {
  const row = plainObject(await daemon.call("extensions.discover", {}));
  const valid =
    row &&
    Array.isArray(row.locations) &&
    row.locations.every((item) => {
      const location = plainObject(item);
      return (
        location &&
        typeof location.label === "string" &&
        typeof location.path === "string" &&
        typeof location.found === "boolean" &&
        (location.unreadable === undefined || typeof location.unreadable === "boolean")
      );
    }) &&
    typeof row.truncated === "boolean" &&
    Array.isArray(row.skills) &&
    row.skills.every((item) => {
      const skill = plainObject(item);
      return (
        skill &&
        typeof skill.path === "string" &&
        typeof skill.location === "string" &&
        typeof skill.attached === "boolean" &&
        nullableString(skill.id) &&
        nullableString(skill.name) &&
        nullableString(skill.description) &&
        nullableString(skill.problem)
      );
    });
  if (!valid) throw new DaemonRpcError("extensions.discover returned an invalid result");
  return row;
}

/** Attach a skill folder by reference: the daemon answers with the external record it wrote. */
export async function attachExtension(daemon: DaemonRpc, folder: string): Promise<Record<string, unknown>> {
  const row = plainObject(await daemon.call("extensions.attach", { path: folder }));
  if (!row || typeof row.id !== "string" || row.provision !== "external" || row.installState !== "installed" || typeof row.externalPath !== "string") {
    throw new DaemonRpcError("extensions.attach returned an invalid result");
  }
  return row;
}

/** Check a bundled item again; the daemon answers with the record carrying the stored result. */
export async function repairExtension(daemon: DaemonRpc, id: string): Promise<Record<string, unknown>> {
  const row = plainObject(await daemon.call("extensions.repair", { id }));
  if (
    !row ||
    row.id !== id ||
    row.provision !== "bundled" ||
    typeof row.availability !== "string" ||
    !AVAILABILITY.has(row.availability) ||
    !nullableString(row.error) ||
    typeof row.checkedAt !== "string"
  ) {
    throw new DaemonRpcError("extensions.repair returned an invalid result");
  }
  return row;
}

/** One row per call that passed the "function is enabled" check, success or failure. */
export async function recordPluginCall(
  db: Db,
  row: { taskId: string; name: string; argsSummary: string; ok: boolean; resultBytes: number; ms: number },
): Promise<void> {
  await db.query(
    `insert into plugin_calls (task_id, name, args_summary, ok, result_bytes, ms) values ($1, $2, $3, $4, $5, $6)`,
    [row.taskId, row.name, row.argsSummary.slice(0, 200), row.ok, row.resultBytes, row.ms],
  );
}
