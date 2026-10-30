import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { bundledExtensions, type ExtensionRecord } from "@nema/shared";

export type { Availability, ExtensionKind, ExtensionRecord, InstallState, Provision, UseState } from "@nema/shared";
export { bundledExtensions } from "@nema/shared";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const BUNDLED_IDS = new Set(bundledExtensions().map((row) => row.id));

function assertId(id: string): void {
  if (!ID.test(id) || BUNDLED_IDS.has(id)) throw new Error(`invalid extension id: ${id}`);
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Nema's own copy of a GitHub extension is a snapshot of one commit. A branch or tag as the revision
 * would make the record claim something that can move after the bytes were copied.
 */
function assertPinned(record: ExtensionRecord): void {
  if (record.provision !== "managed") return;
  if (!/^https:\/\/(www\.)?github\.com\//i.test(record.source)) return;
  // The revision and the source link have to agree on the same commit, or the record names two versions.
  const linked = /^https:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/tree\/([0-9a-f]{40})(?:\/|$)/i.exec(record.source)?.[1];
  if (!COMMIT.test(record.revision) || linked !== record.revision) {
    throw new Error("a GitHub source must be pinned to a 40-character commit");
  }
}

function indexPath(root: string): string {
  return path.join(root, "index.json");
}

function readExtra(root: string): ExtensionRecord[] {
  const file = indexPath(root);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed as ExtensionRecord[];
}

/**
 * Replace the index in one step: write a sibling temp file, flush it to disk, then rename over the
 * index. A crash or a full disk leaves either the old index or the new one, never a half-written
 * file that `readExtra` would fail to parse on the next start.
 */
function writeExtra(root: string, rows: ExtensionRecord[]): void {
  mkdirSync(root, { recursive: true });
  const target = indexPath(root);
  const temp = path.join(root, `index.json.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(rows));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function managedPath(root: string, id: string): { extensions: string; target: string } {
  const extensions = path.resolve(root, "extensions");
  const target = path.resolve(extensions, id);
  if (path.dirname(target) !== extensions) throw new Error("invalid extension id");
  return { extensions, target };
}

/** Real directory for a managed id, or throw when it points outside extensions/. */
export function ownedDirectory(root: string, id: string): string {
  const { extensions, target } = managedPath(root, id);
  mkdirSync(extensions, { recursive: true });
  // mkdirSync accepts an existing symlink that points at a directory, so this check has to run here:
  // a linked root would make the outside directory the trusted root below and `rmSync` would delete
  // files that are not Nema's.
  if (lstatSync(extensions).isSymbolicLink()) throw new Error("managed extensions root is a symbolic link");
  const realExtensions = realpathSync(extensions);
  if (!existsSync(target)) return target;
  const stat = lstatSync(target);
  const real = realpathSync(target);
  const relative = path.relative(realExtensions, real);
  const inside = relative === id || relative.startsWith(id + path.sep);
  if (stat.isSymbolicLink() || !inside) throw new Error("extension directory points outside the managed root");
  return real;
}

const AVAILABILITY: ReadonlySet<string> = new Set(["ready", "missing-dependency", "incompatible", "damaged"]);

/**
 * The result of a Repair check on a bundled override row, or nothing when it was never checked or
 * the stored values are not a valid result. Same rule as the hub's offline read of the index.
 */
function checked(row: ExtensionRecord): Partial<ExtensionRecord> {
  if (typeof row.checkedAt !== "string" || !AVAILABILITY.has(row.availability)) return {};
  if (row.error !== null && typeof row.error !== "string") return {};
  return { availability: row.availability, error: row.error, checkedAt: row.checkedAt };
}

export function openExtensionStore(root: string) {
  return {
    list(): ExtensionRecord[] {
      const rows = readExtra(root);
      // A bundled id keeps its seed and takes only the stored use state; everything else is a record.
      const overrides = new Map(rows.filter((row) => BUNDLED_IDS.has(row.id)).map((row) => [row.id, row]));
      const seeds = bundledExtensions().map((row) => {
        const override = overrides.get(row.id);
        return override ? { ...row, useState: override.useState, ...checked(override) } : row;
      });
      return [...seeds, ...rows.filter((row) => !BUNDLED_IDS.has(row.id))];
    },
    putManaged(record: ExtensionRecord): void {
      assertId(record.id);
      assertPinned(record);
      if (record.provision === "managed") {
        const target = ownedDirectory(root, record.id);
        if (!existsSync(target)) mkdirSync(target);
      }
      else if (record.provision !== "external") throw new Error("bundled extensions are not installed here");
      const rows = readExtra(root).filter((row) => row.id !== record.id);
      rows.push(record);
      writeExtra(root, rows);
    },
    removeManaged(id: string): void {
      const current = readExtra(root).find((row) => row.id === id);
      if (!current) {
        if (BUNDLED_IDS.has(id)) throw new Error("bundled extensions cannot be removed");
        throw new Error("extension is not managed");
      }
      if (current.provision === "bundled") throw new Error("bundled extensions cannot be removed");
      if (current.provision !== "managed") throw new Error("extension is not managed");
      const target = ownedDirectory(root, id);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      writeExtra(root, readExtra(root).filter((row) => row.id !== id));
    },
    detach(id: string): void {
      const current = readExtra(root).find((row) => row.id === id);
      if (!current || current.provision !== "external") throw new Error("extension is not external");
      writeExtra(root, readExtra(root).filter((row) => row.id !== id));
    },
    installManaged(record: ExtensionRecord, stagedDir: string): void {
      assertId(record.id);
      if (record.provision !== "managed") throw new Error("only a managed extension can be installed");
      assertPinned(record);
      if (!existsSync(stagedDir) || !lstatSync(stagedDir).isDirectory()) {
        throw new Error("staged extension directory is missing");
      }
      const { extensions, target } = managedPath(root, record.id);
      mkdirSync(extensions, { recursive: true });
      const incoming = path.join(extensions, `.${record.id}.incoming`);
      rmSync(incoming, { recursive: true, force: true });
      try {
        cpSync(stagedDir, incoming, { recursive: true });
        if (existsSync(target)) {
          // ponytail: delete-then-rename. A crash between them loses the previous bytes.
          // Upgrade path: rename the live dir aside, rename incoming in, then delete the aside copy.
          ownedDirectory(root, record.id);
          rmSync(target, { recursive: true, force: true });
        }
        renameSync(incoming, target);
      } catch (error) {
        rmSync(incoming, { recursive: true, force: true });
        throw error;
      }
      const rows = readExtra(root).filter((row) => row.id !== record.id);
      rows.push({ ...record, provision: "managed", installState: "installed", error: null });
      writeExtra(root, rows);
    },
    /**
     * Flip the use state of a record. Bundled extensions live in `bundledExtensions()`, so their
     * choice is stored as an override row rather than by editing the seed.
     */
    setUseState(id: string, useState: ExtensionRecord["useState"]): ExtensionRecord {
      if (useState !== "enabled" && useState !== "disabled") throw new Error(`invalid use state: ${useState}`);
      if (BUNDLED_IDS.has(id)) {
        const stored = readExtra(root);
        const previous = stored.find((row) => row.id === id);
        const seed = bundledExtensions().find((row) => row.id === id)!;
        // A stored Repair result outlives the switch; only the use state changes here.
        const next = { ...seed, ...(previous ? checked(previous) : {}), useState };
        writeExtra(root, [...stored.filter((row) => row.id !== id), next]);
        return next;
      }
      const current = readExtra(root).find((row) => row.id === id);
      if (!current) throw new Error("extension is not installed here");
      const next = { ...current, useState };
      writeExtra(root, readExtra(root).map((row) => (row.id === id ? next : row)));
      return next;
    },
    /**
     * Point at a skill folder someone else keeps. The record names the folder's real path and nothing
     * is copied. The id check and the write happen with no await between them, so two attaches of the
     * same id cannot both land.
     */
    attachExternal(record: ExtensionRecord): ExtensionRecord {
      assertId(record.id);
      if (record.provision !== "external" || !record.externalPath || !path.isAbsolute(record.externalPath)) {
        throw new Error("an attached extension needs an absolute external path");
      }
      const rows = readExtra(root);
      if (rows.some((row) => row.provision === "external" && row.externalPath === record.externalPath)) {
        throw new Error(`already attached: ${record.externalPath}`);
      }
      if (rows.some((row) => row.id === record.id)) throw new Error(`cannot attach ${record.externalPath}: id-taken`);
      writeExtra(root, [...rows, record]);
      return record;
    },
    /**
     * Store what a Repair check found for a bundled item. The seed stays the shipped default; the
     * override row carries the result and when it was taken, and keeps the use state as it was.
     * `checkedAt` is when the check started; a result older than the stored one is not written, and
     * the stored record comes back instead, so a slow check cannot replace a newer answer.
     */
    recordCheck(id: string, result: { availability: ExtensionRecord["availability"]; error: string | null; checkedAt: string }): ExtensionRecord {
      if (!BUNDLED_IDS.has(id)) throw new Error("only a bundled extension can be repaired");
      const stored = readExtra(root);
      const previous = stored.find((row) => row.id === id);
      const seed = bundledExtensions().find((row) => row.id === id)!;
      const kept = previous ? checked(previous) : {};
      if (typeof kept.checkedAt === "string" && kept.checkedAt > result.checkedAt) {
        return { ...seed, useState: previous!.useState ?? seed.useState, ...kept };
      }
      const next: ExtensionRecord = { ...seed, useState: previous?.useState ?? seed.useState, ...result };
      writeExtra(root, [...stored.filter((row) => row.id !== id), next]);
      return next;
    },
    /** End an install that did not finish: drop whatever reached the managed folder and keep the reason. */
    failInstall(id: string, error: string): void {
      assertId(id);
      const current = readExtra(root).find((row) => row.id === id);
      if (!current || current.provision !== "managed" || current.installState !== "installing") throw new Error("extension is not installing");
      const target = ownedDirectory(root, id);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      // A crash inside installManaged can leave its half-copied sibling behind.
      rmSync(path.join(managedPath(root, id).extensions, `.${id}.incoming`), { recursive: true, force: true });
      writeExtra(
        root,
        readExtra(root).map((row) => (row.id === id ? { ...row, installState: "failed", error } : row)),
      );
    },
    cancelInstall(id: string): void {
      assertId(id);
      const current = readExtra(root).find((row) => row.id === id);
      if (!current || current.installState !== "installing") throw new Error("extension is not installing");
      const target = ownedDirectory(root, id);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      writeExtra(
        root,
        readExtra(root).map((row) => (row.id === id ? { ...row, installState: "absent", error: null } : row)),
      );
    },
  };
}
