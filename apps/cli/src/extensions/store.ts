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
  if (/^https:\/\/(www\.)?github\.com\//i.test(record.source) && !COMMIT.test(record.revision)) {
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
function ownedDirectory(root: string, id: string): string {
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

export function openExtensionStore(root: string) {
  return {
    list(): ExtensionRecord[] {
      const rows = readExtra(root);
      // A bundled id keeps its seed and takes only the stored use state; everything else is a record.
      const overrides = new Map(rows.filter((row) => BUNDLED_IDS.has(row.id)).map((row) => [row.id, row]));
      const seeds = bundledExtensions().map((row) => {
        const override = overrides.get(row.id);
        return override ? { ...row, useState: override.useState } : row;
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
        const rows = readExtra(root).filter((row) => row.id !== id);
        const seed = bundledExtensions().find((row) => row.id === id)!;
        rows.push({ ...seed, useState });
        writeExtra(root, rows);
        return { ...seed, useState };
      }
      const current = readExtra(root).find((row) => row.id === id);
      if (!current) throw new Error("extension is not installed here");
      const next = { ...current, useState };
      writeExtra(root, readExtra(root).map((row) => (row.id === id ? next : row)));
      return next;
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
