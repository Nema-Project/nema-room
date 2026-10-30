import path from "node:path";
import type { McpRecordState } from "@nema/shared";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import type { RpcRouter } from "../daemon/rpc.js";
import { openMcpSecretStore } from "../secrets/mcp.js";
import { openMcpConfigs } from "./mcp.js";
import { openMcpLeftovers } from "./mcp/leftovers.js";
import { McpSupervisor, type McpStatus } from "./mcp/supervisor.js";
import type { ExtensionRecord } from "./store.js";

export type McpHandlerOptions = { ownedHelpers?: OwnedHelperScope; timeoutMs?: number };

type Params = Record<string, unknown>;

function params(raw: unknown, method: string, allowed: string[]): Params {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${method} needs an object`);
  const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
  // D-4: `start` and the others take an id, never a command or an address of their own.
  if (extra.length > 0) throw new Error(`${method} does not take ${extra.map((key) => key.slice(0, 32)).join(", ")}`);
  return raw as Params;
}

function text(p: Params, key: string, method: string): string {
  const value = p[key];
  if (typeof value !== "string" || value === "") throw new Error(`${method} needs a string ${key}`);
  return value;
}

/**
 * The MCP side of the extension handlers: configs, credentials and the servers' lifecycle.
 *
 * Every write for one id runs on one chain, and a running server is stopped before its config
 * changes or goes away; a credential change restarts a running server so it never keeps the old
 * value. Nothing here offers an MCP tool to the Agent (D-3).
 */
export function createMcpHandlers(nemaHome: string, options: McpHandlerOptions = {}) {
  const root = path.join(nemaHome, "extensions");
  const configs = openMcpConfigs({ root, nemaHome });
  const secrets = openMcpSecretStore(nemaHome);
  // The daemon is starting: nothing can be running yet, so whatever a crash left is repaired now.
  configs.reconcile();
  const leftovers = process.platform === "win32" || options.ownedHelpers ? undefined : openMcpLeftovers(nemaHome);
  const supervisor = new McpSupervisor({ nemaHome, configs, secrets, ownedHelpers: options.ownedHelpers, timeoutMs: options.timeoutMs, leftovers });
  // A daemon that was killed never ran its close: its stdio servers may still be running. They are
  // stopped before anything else runs on a server's chain, and the row says so; none is restarted.
  // If that fails, no start runs in this daemon: a second copy would run beside an untracked one.
  const ready: Promise<void> = leftovers
    ? leftovers.sweep().then(
        (ids) => {
          for (const id of ids) supervisor.note(id, "stopped a copy left running by the previous daemon; start it again");
        },
        (error: unknown) => {
          throw new Error(`could not stop the MCP servers left running by the previous daemon (${error instanceof Error ? error.message : String(error)}); fix it and restart the daemon`);
        },
      )
    : Promise.resolve();
  /** Settles when the recovery is over, either way. */
  const recovered: Promise<void> = ready.catch(() => {});
  const chains = new Map<string, Promise<unknown>>();
  // Bumped by every stop: a start queued before a stop sees a newer number and does not launch.
  const stops = new Map<string, number>();
  const stopCount = (id: string) => stops.get(id) ?? 0;
  async function stopAll(id: string): Promise<void> {
    stops.set(id, stopCount(id) + 1);
    await supervisor.stop(id);
  }

  function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (chains.get(id) ?? recovered).catch(() => {}).then(run);
    chains.set(id, next);
    void next.catch(() => {}).finally(() => {
      if (chains.get(id) === next) chains.delete(id);
    });
    return next;
  }

  function running(id: string): boolean {
    const connection = supervisor.status(id).connection;
    return connection === "connected" || connection === "connecting";
  }

  /** What `extensions.list` shows for an MCP record: state and slot names, never a command line or value. */
  function state(record: ExtensionRecord): McpRecordState {
    const status = supervisor.status(record.id);
    let slots: McpRecordState["secrets"] = [];
    try {
      slots = configs.get(record.id).secrets;
    } catch {
      // A damaged config has no slots to show; the record's availability already says so.
    }
    return {
      transport: record.source === "mcp:http" ? "http" : "stdio",
      connection: status.connection,
      server: status.server,
      tools: status.tools,
      secrets: slots,
      lastError: status.lastError,
    };
  }

  return {
    state,
    /**
     * Stop the server and write `disabled` on its chain, so no start can run between the two: a
     * start queued behind this one reads the record after the write and is refused.
     */
    async disable<T>(id: string, write: () => T | Promise<T>): Promise<T> {
      // The direct stop ends a start still waiting on the chain; the chained one waits for it to unwind.
      await stopAll(id);
      return serial(id, async () => {
        await supervisor.stop(id);
        return write();
      });
    },
    async remove(id: string): Promise<void> {
      await stopAll(id);
      await serial(id, async () => {
        await supervisor.stop(id);
        configs.remove(id);
      });
    },
    /** Settles once servers left by a previous daemon are dealt with, so a listing carries the note. */
    recovered,
    close(): Promise<void> {
      // A recovery still stopping an old group finishes first, so its record is not lost half-way.
      return recovered.then(() => supervisor.closeAll());
    },
    register(router: RpcRouter, record: (id: string) => ExtensionRecord | undefined): void {
      const managed = (id: string): ExtensionRecord => {
        const row = record(id);
        if (!row) throw new Error(`MCP server not found: ${id}`);
        if (row.kind !== "mcp" || row.provision !== "managed") throw new Error(`${id} is not an MCP server`);
        return row;
      };
      router.register("extensions.mcp.get", async (raw) => {
        const p = params(raw, "extensions.mcp.get", ["id"]);
        return configs.get(text(p, "id", "extensions.mcp.get"));
      });
      router.register("extensions.mcp.save", async (raw) => {
        const p = params(raw, "extensions.mcp.save", ["id", "name", "config", "create"]);
        const id = text(p, "id", "extensions.mcp.save");
        const name = text(p, "name", "extensions.mcp.save");
        if (p.config === undefined) throw new Error("extensions.mcp.save needs a config");
        if (p.create !== undefined && typeof p.create !== "boolean") throw new Error("extensions.mcp.save needs a boolean create");
        const create = p.create === true;
        return serial(id, async () => {
          const existing = record(id);
          // Checked on the chain, so of two adds racing for one id the second is refused, not merged.
          if (create && existing) throw new Error(`MCP server ${id} already exists`);
          // `create: false` is an edit: a server removed meanwhile is not brought back.
          if (p.create === false && !existing) throw new Error(`MCP server not found: ${id}`);
          if (existing && (existing.kind !== "mcp" || existing.provision !== "managed")) throw new Error(`${id} is not an MCP server`);
          // A running server keeps the old config in memory: stop it before the file changes.
          if (running(id)) await supervisor.stop(id);
          return configs.save(id, name, p.config);
        });
      });
      router.register("extensions.mcp.start", async (raw): Promise<McpStatus> => {
        const p = params(raw, "extensions.mcp.start", ["id"]);
        const id = text(p, "id", "extensions.mcp.start");
        const queuedAt = stopCount(id);
        return serial(id, async () => {
          const row = managed(id);
          if (row.useState === "disabled") throw new Error(`${id} is disabled; enable it first`);
          // A stop that came after this start was sent wins, even if the start was still waiting.
          if (stopCount(id) !== queuedAt) return supervisor.status(id);
          await ready;
          configs.config(id);
          return supervisor.start(id);
        });
      });
      router.register("extensions.mcp.stop", async (raw): Promise<McpStatus> => {
        const p = params(raw, "extensions.mcp.stop", ["id"]);
        const id = text(p, "id", "extensions.mcp.stop");
        managed(id);
        // Not on the chain: a stop has to be able to end a start that is still waiting for its server,
        // and the count makes any start queued before it a no-op.
        await stopAll(id);
        return supervisor.status(id);
      });
      router.register("extensions.mcp.status", async (raw): Promise<McpStatus> => {
        const p = params(raw, "extensions.mcp.status", ["id"]);
        const id = text(p, "id", "extensions.mcp.status");
        managed(id);
        return supervisor.status(id);
      });
      router.register("extensions.mcp.setSecret", async (raw) => {
        const p = params(raw, "extensions.mcp.setSecret", ["id", "name", "value"]);
        const id = text(p, "id", "extensions.mcp.setSecret");
        const name = text(p, "name", "extensions.mcp.setSecret");
        if (typeof p.value !== "string") throw new Error("extensions.mcp.setSecret needs a string value");
        const value = p.value;
        return serial(id, async () => {
          configs.setSecret(id, name, value);
          const status = running(id) ? await supervisor.restart(id) : supervisor.status(id);
          return { id, name, configured: true, status };
        });
      });
      router.register("extensions.mcp.clearSecret", async (raw) => {
        const p = params(raw, "extensions.mcp.clearSecret", ["id", "name"]);
        const id = text(p, "id", "extensions.mcp.clearSecret");
        const name = text(p, "name", "extensions.mcp.clearSecret");
        return serial(id, async () => {
          configs.clearSecret(id, name);
          const status = running(id) ? await supervisor.restart(id) : supervisor.status(id);
          return { id, name, configured: false, status };
        });
      });
    },
  };
}
