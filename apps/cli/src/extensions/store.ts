import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ID = /^[a-z][a-z0-9-]{0,63}$/;

export type ExtensionKind = "skill" | "mcp" | "plugin";
export type Provision = "bundled" | "managed" | "external";
export type InstallState = "absent" | "installing" | "installed" | "updating" | "removing" | "failed";
export type UseState = "enabled" | "disabled";
export type Availability = "ready" | "missing-dependency" | "incompatible" | "damaged";

export type ExtensionRecord = {
  id: string;
  kind: ExtensionKind;
  name: string;
  summary: string;
  source: string;
  revision: string;
  provision: Provision;
  installState: InstallState;
  useState: UseState;
  availability: Availability;
  externalPath: string | null;
  error: string | null;
};

const BUNDLED_IDS = ["code", "diagram", "superpowers", "grill", "github"] as const;

function bundled(id: string, name: string, availability: Availability, error: string | null): ExtensionRecord {
  return {
    id,
    kind: "plugin",
    name,
    summary: "",
    source: "bundled",
    revision: "bundled",
    provision: "bundled",
    installState: "installed",
    useState: "enabled",
    availability,
    externalPath: null,
    error,
  };
}

export function bundledExtensions(): ExtensionRecord[] {
  return [
    bundled("code", "graphify", "missing-dependency", "bundled-runtime-missing"),
    bundled("diagram", "archify", "ready", null),
    bundled("superpowers", "superpowers", "ready", null),
    bundled("grill", "grill-me", "ready", null),
    bundled("github", "GitHub", "ready", null),
  ];
}

function assertId(id: string): void {
  if (!ID.test(id) || (BUNDLED_IDS as readonly string[]).includes(id)) throw new Error(`invalid extension id: ${id}`);
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

function writeExtra(root: string, rows: ExtensionRecord[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(indexPath(root), JSON.stringify(rows));
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
      const extra = readExtra(root).filter((row) => !(BUNDLED_IDS as readonly string[]).includes(row.id));
      return [...bundledExtensions(), ...extra];
    },
    putManaged(record: ExtensionRecord): void {
      assertId(record.id);
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
        if ((BUNDLED_IDS as readonly string[]).includes(id)) throw new Error("bundled extensions cannot be removed");
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
  };
}
