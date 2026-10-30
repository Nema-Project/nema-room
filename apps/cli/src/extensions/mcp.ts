import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { mcpTargetChanged, parseMcpConfig, secretRefs, type ExtensionRecord, type McpConfig } from "@nema/shared";
import { openMcpSecretStore } from "../secrets/mcp.js";
import { openExtensionStore, ownedDirectory } from "./store.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const CONFIG = "mcp.json";
const DAMAGED = "mcp-config-damaged";

export type McpConfigView = { id: string; name: string; config: McpConfig; secrets: Array<{ name: string; configured: boolean }> };
export type McpReconcileResult = { damaged: string[]; removedSecrets: string[] };

function digest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

function assertName(name: unknown): string {
  if (typeof name !== "string" || name.trim() === "" || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error("MCP server name must be one line of 1 to 128 characters");
  }
  return name;
}

/** Same steps as the index: temp file, flush, rename. A crash leaves the old file or the new one. */
function writeAtomic(file: string, bytes: string): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * MCP server configs kept as managed extension records.
 *
 * The config lives in `extensions/<id>/mcp.json` and the record's `revision` is that file's digest.
 * Credentials are never in either file: credential slots hold `{ secret }` or `{ env }` references,
 * and `{ secret }` values live in `openMcpSecretStore`. Write order is recoverable: `mcp.json` first,
 * then the record; removal goes secrets, directory, record. `reconcile` repairs what a crash leaves.
 *
 * Only the daemon calls this; nothing else writes `index.json` or `mcp.json`.
 */
export function openMcpConfigs({ root, nemaHome }: { root: string; nemaHome: string }) {
  const store = openExtensionStore(root);
  const secrets = openMcpSecretStore(nemaHome);

  function find(id: string): ExtensionRecord | undefined {
    return store.list().find((row) => row.id === id);
  }

  /** The record for `id`, which has to be an MCP server Nema manages. */
  function mcpRecord(id: string): ExtensionRecord {
    const record = find(id);
    if (!record) throw new Error(`MCP server not found: ${id}`);
    if (record.kind !== "mcp" || record.provision !== "managed") throw new Error(`${id} is not an MCP server`);
    return record;
  }

  function fileOf(id: string): string {
    return path.join(ownedDirectory(root, id), CONFIG);
  }

  /** The config on disk when it still matches the record, or null. Never throws for a bad file. */
  function readIntact(record: ExtensionRecord): McpConfig | null {
    let bytes: string;
    try {
      bytes = readFileSync(fileOf(record.id), "utf8");
    } catch {
      return null;
    }
    if (digest(bytes) !== record.revision) return null;
    try {
      return parseMcpConfig(JSON.parse(bytes));
    } catch {
      return null;
    }
  }

  function setAvailability(record: ExtensionRecord, damaged: boolean): ExtensionRecord {
    const next: ExtensionRecord = damaged ? { ...record, availability: "damaged", error: DAMAGED } : { ...record, availability: "ready", error: null };
    if (next.availability !== record.availability || next.error !== record.error) store.putManaged(next);
    return next;
  }

  function readConfig(id: string): McpConfig {
    const record = mcpRecord(id);
    const config = readIntact(record);
    setAvailability(record, config === null);
    // Fixed text: a parse error could quote the file.
    if (!config) throw new Error(`${CONFIG} for ${id} is damaged or does not match the record; save the config again`);
    return config;
  }

  function referenced(id: string, name: string): void {
    if (!secretRefs(readConfig(id)).includes(name)) throw new Error(`secret ${name} is not referenced by the config of ${id}`);
  }

  return {
    save(id: string, name: string, input: unknown): ExtensionRecord {
      if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid extension id");
      const label = assertName(name);
      const config = parseMcpConfig(input);
      const previous = find(id);
      if (previous && (previous.kind !== "mcp" || previous.provision !== "managed")) throw new Error(`${id} is not an MCP server`);
      // D-4: stored credentials follow the program or address they were set for, not the id. A
      // previous file that cannot be read gives nothing to compare, so it counts as a change.
      // They go before the new target is written: a save cut off here loses credentials (enter
      // them again) rather than leaving old credentials next to a new target.
      if (previous) {
        const before = readIntact(previous);
        if (!before || mcpTargetChanged(before, config)) secrets.removeAll(id);
      }
      const bytes = JSON.stringify(config, null, 2) + "\n";
      const dir = ownedDirectory(root, id);
      if (!existsSync(dir)) mkdirSync(dir);
      writeAtomic(path.join(dir, CONFIG), bytes);
      const record: ExtensionRecord = {
        id,
        kind: "mcp",
        name: label,
        summary: "",
        source: `mcp:${config.transport}`,
        revision: digest(bytes),
        provision: "managed",
        installState: "installed",
        useState: previous?.useState ?? "enabled",
        availability: "ready",
        externalPath: null,
        error: null,
      };
      store.putManaged(record);
      // A slot the config no longer names loses its value, so bringing the name back later starts empty.
      const keep = new Set(secretRefs(config));
      for (const stored of secrets.names(id)) if (!keep.has(stored)) secrets.clear(id, stored);
      return record;
    },
    /** The config for an edit form: credential slots hold references, plus which secrets are set. */
    get(id: string): McpConfigView {
      const config = readConfig(id);
      const record = mcpRecord(id);
      return { id, name: record.name, config, secrets: secretRefs(config).map((ref) => ({ name: ref, configured: secrets.has(id, ref) })) };
    },
    /** The parsed config, for the supervisor. */
    config(id: string): McpConfig {
      return readConfig(id);
    },
    setSecret(id: string, name: string, value: string): void {
      referenced(id, name);
      secrets.set(id, name, value);
    },
    clearSecret(id: string, name: string): void {
      mcpRecord(id);
      secrets.clear(id, name);
    },
    remove(id: string): void {
      mcpRecord(id);
      secrets.removeAll(id);
      store.removeManaged(id);
    },
    /** Run once when the daemon starts, before any MCP operation. */
    reconcile(): McpReconcileResult {
      const records = store.list().filter((row) => row.kind === "mcp" && row.provision === "managed");
      const damaged: string[] = [];
      for (const record of records) {
        if (setAvailability(record, readIntact(record) === null).availability === "damaged") damaged.push(record.id);
      }
      const known = new Set(records.map((row) => row.id));
      const removedSecrets = secrets.ids().filter((id) => !known.has(id));
      for (const id of removedSecrets) secrets.removeAll(id);
      return { damaged: damaged.sort(), removedSecrets };
    },
  };
}
