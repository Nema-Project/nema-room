// The daemon's component RPC: what the settings page and the graph entry points ask and start. Nothing here
// downloads on its own: `components.install` runs only when the caller says the person confirmed the offer,
// and the offer it confirmed (size, location, hosts) is the one `components.status` reported.
import { loadConfig, saveConfig, normalizeMirrorUrl, type NemaConfig } from "../config.js";
import { sourceUrls } from "./download.js";
import { installComponent, type InstallOptions } from "./install.js";
import { readLock, resolveTarget, shippedLockPath } from "./lock.js";
import { assertComponent, componentRoot, componentStatusSync, isOffline, type ComponentEnv } from "./store.js";
import type { ComponentName, ComponentStatus } from "./types.js";
import type { RpcRouter } from "../daemon/rpc.js";

export const PYTHON_MIRROR_ENV = "NEMA_GRAPHIFY_PYTHON_MIRROR";
export const PYPI_BASE_ENV = "NEMA_GRAPHIFY_PYPI_BASE";

type Setting<T> = {
  /** What an install uses: the environment variable when set, otherwise the saved setting. */
  value: T;
  /** Where `value` came from; null when neither is set. */
  source: "env" | "config" | null;
  /** The saved setting, shown in the field even while an environment variable overrides it. */
  config: T;
};

export type ComponentOffer = {
  lockHash: string;
  /** Sum of the lock's `size` fields for this platform. */
  totalBytes: number;
  /** The component directory, e.g. ~/.nema/runtime/graphify. */
  location: string;
  /** Hosts the download contacts, after mirrors. */
  hosts: string[];
};

export type ComponentView = {
  name: ComponentName;
  status: ComponentStatus;
  /** What a confirmed install would download; null when this platform has no build or the lock is unreadable. */
  offer: ComponentOffer | null;
  /** Why no offer could be made (an unusable mirror address, an unreadable lock). */
  offerError?: string;
  settings: {
    pythonMirror: Setting<string | null>;
    pypiBase: Setting<string | null>;
    offline: Setting<boolean>;
  };
};

const nonEmpty = (value: string | undefined): value is string => typeof value === "string" && value.trim() !== "";

/** process.env with the saved mirrors filled in where the variable is unset: an environment variable always wins. */
export function componentProcessEnv(config: Pick<NemaConfig, "components">, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const saved = config.components;
  if (!nonEmpty(env[PYTHON_MIRROR_ENV]) && saved?.pythonMirror) out[PYTHON_MIRROR_ENV] = saved.pythonMirror;
  if (!nonEmpty(env[PYPI_BASE_ENV]) && saved?.pypiBase) out[PYPI_BASE_ENV] = saved.pypiBase;
  return out;
}

function stringSetting(env: NodeJS.ProcessEnv, name: string, saved: string | undefined): Setting<string | null> {
  if (nonEmpty(env[name])) return { value: env[name]!.trim(), source: "env", config: saved ?? null };
  return { value: saved ?? null, source: saved ? "config" : null, config: saved ?? null };
}

function offlineSetting(env: NodeJS.ProcessEnv, saved: boolean | undefined): Setting<boolean> {
  if (isOffline({ env })) return { value: true, source: "env", config: saved === true };
  return { value: saved === true, source: saved === true ? "config" : null, config: saved === true };
}

export type ComponentRpcOptions = {
  nemaHome: string;
  getConfig?: () => NemaConfig;
  /** Store root, lock and platform; tests pass temp directories and a fixture lock. */
  components?: Omit<ComponentEnv, "env" | "offline">;
  /** The daemon's environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** The installer; tests pass a fake. */
  install?: (name: string, o: InstallOptions) => Promise<ComponentStatus>;
  /** Agent CLI detection for the settings page (detection and guidance only). */
  detectAgents?: () => Promise<unknown>;
};

function nameParam(params: unknown): ComponentName {
  const name = (params as { name?: unknown } | null)?.name ?? "graphify";
  if (typeof name !== "string") throw new Error("invalid component params");
  assertComponent(name);
  return name;
}

/**
 * Registers `components.status`, `components.install`, `components.cancel`, `components.configure` and
 * `agents.detect`. An install runs in the background and is followed through `components.status`, whose
 * `installing` state carries its progress; the RPC that starts it answers at once.
 */
export function registerComponentHandlers(rpc: RpcRouter, o: ComponentRpcOptions): { close(): Promise<void> } {
  const config = () => (o.getConfig ?? (() => loadConfig(o.nemaHome)))();
  const running = new Map<ComponentName, { controller: AbortController; done: Promise<unknown> }>();

  const componentEnv = (cfg: NemaConfig): ComponentEnv => ({
    ...o.components,
    env: componentProcessEnv(cfg, o.env ?? process.env),
    offline: cfg.components?.offline === true,
  });

  function view(name: ComponentName): ComponentView {
    const cfg = config();
    const env = componentEnv(cfg);
    const processEnv = o.env ?? process.env;
    const settings = {
      pythonMirror: stringSetting(processEnv, PYTHON_MIRROR_ENV, cfg.components?.pythonMirror),
      pypiBase: stringSetting(processEnv, PYPI_BASE_ENV, cfg.components?.pypiBase),
      offline: offlineSetting(processEnv, cfg.components?.offline),
    };
    let status: ComponentStatus;
    let offer: ComponentOffer | null = null;
    let offerError: string | undefined;
    try {
      status = componentStatusSync(name, env);
      const resolved = resolveTarget(readLock(env.lockPath ?? shippedLockPath()), env.platform);
      if (resolved.ok) {
        try {
          const hosts = [...new Set(sourceUrls(resolved.target, env.env ?? {}).map((url) => new URL(url).host))];
          offer = { lockHash: resolved.lockHash, totalBytes: resolved.totalBytes, location: componentRoot(name, env), hosts };
        } catch (error) {
          offerError = error instanceof Error ? error.message : String(error);
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      status = { state: "failed", name, lockHash: null, reason: "lock-unreadable", detail, at: null };
      offerError = detail;
    }
    // Between the request and the installer taking its lock, the store does not know yet; this process does.
    if (running.has(name) && status.state !== "installing" && offer) {
      status = { state: "installing", name, lockHash: offer.lockHash, progress: { phase: "download", downloadedBytes: 0, totalBytes: offer.totalBytes, file: null } };
    }
    return { name, status, offer, ...(offerError !== undefined ? { offerError } : {}), settings };
  }

  rpc.register("components.status", async () => ({ components: [view("graphify")] }));

  rpc.register("components.install", async (params) => {
    const name = nameParam(params);
    // The page shows the offer and asks; only its yes reaches here. Anything else is refused, never a silent download.
    if ((params as { confirmed?: unknown } | null)?.confirmed !== true) throw new Error("component install needs the user's confirmation");
    if (running.has(name)) return view(name);
    const current = view(name);
    if (current.status.state === "installed" || current.status.state === "installing") return current;
    if (!current.offer) throw new Error(current.offerError ?? (current.status.state === "failed" ? current.status.detail : "component cannot be installed here"));
    // The yes was for one lock's download; a different one (the program was upgraded meanwhile) is asked again.
    const expected = (params as { lockHash?: unknown }).lockHash;
    if (expected !== undefined && expected !== current.offer.lockHash) throw new Error("the component offer changed; confirm again");
    const controller = new AbortController();
    const install = o.install ?? installComponent;
    const done = Promise.resolve()
      .then(() => install(name, { env: componentEnv(config()), signal: controller.signal }))
      .catch((error) => {
        // The installer records named failures itself; this is what slipped past it (an unreadable lock, a bad mirror).
        console.error(`[nema] component install ${name} failed`, error);
      })
      .finally(() => {
        running.delete(name);
      });
    running.set(name, { controller, done });
    return view(name);
  });

  rpc.register("components.cancel", async (params) => {
    const name = nameParam(params);
    const job = running.get(name);
    if (job) {
      job.controller.abort();
      await job.done;
    }
    return view(name);
  });

  rpc.register("components.configure", async (params) => {
    const name = nameParam(params);
    const row = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const next: NonNullable<NemaConfig["components"]> = { ...(config().components ?? {}) };
    for (const key of ["pythonMirror", "pypiBase"] as const) {
      if (!(key in row)) continue;
      const value = row[key];
      if (value === null || (typeof value === "string" && value.trim() === "")) delete next[key];
      else if (typeof value === "string") next[key] = normalizeMirrorUrl(value.trim());
      else throw new Error(`invalid ${key}`);
    }
    if ("offline" in row) {
      if (typeof row.offline !== "boolean") throw new Error("invalid offline");
      if (row.offline) next.offline = true;
      else delete next.offline;
    }
    saveConfig(o.nemaHome, { components: Object.keys(next).length > 0 ? next : undefined });
    return view(name);
  });

  rpc.register("agents.detect", async () => {
    const detect = o.detectAgents ?? (async () => (await import("../agentClis.js")).detectAgentClis());
    return { agents: await detect() };
  });

  return {
    async close() {
      const jobs = [...running.values()];
      for (const job of jobs) job.controller.abort();
      await Promise.all(jobs.map((job) => job.done));
    },
  };
}
