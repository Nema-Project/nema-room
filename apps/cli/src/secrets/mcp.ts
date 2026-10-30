import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { readSecretLine, saveSecretLine } from "./file.js";
import { protectPrivatePath } from "./permissions.js";

/** Same rule as a managed extension id: the secret directory is named after the record. */
const ID = /^[a-z][a-z0-9-]{0,63}$/;
/** Same rule as a `{ secret }` reference in an MCP config. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function assertId(id: string): void {
  if (!ID.test(id)) throw new Error("invalid MCP id");
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error("invalid secret name");
}

export type McpSecretStore = ReturnType<typeof openMcpSecretStore>;

/**
 * Credentials for MCP servers, one private file per value at `<nemaHome>/secrets/mcp/<id>/<NAME>`.
 *
 * `saveSecretLine` and `readSecretLine` check the value file itself. This store adds the directories
 * above it: `secrets`, `secrets/mcp` and `secrets/mcp/<id>` must each be a real directory, and the
 * resolved id directory must stay inside `secrets/mcp`, before anything is written, read or removed.
 * Errors name the id or the slot, never a value.
 */
export function openMcpSecretStore(nemaHome: string) {
  const secrets = path.join(nemaHome, "secrets");
  const mcp = path.join(secrets, "mcp");

  function refuseLink(dir: string): boolean {
    let stat;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`MCP secret directory ${path.relative(nemaHome, dir)} is a symbolic link; refused`);
    if (!stat.isDirectory()) throw new Error(`MCP secret path ${path.relative(nemaHome, dir)} is not a directory`);
    return true;
  }

  /** Check every level below `nemaHome`; create missing ones when asked. Returns the id directory, or null when it does not exist. */
  function idDirectory(id: string, create: boolean): string | null {
    assertId(id);
    const dir = path.join(mcp, id);
    for (const level of [secrets, mcp, dir]) {
      if (refuseLink(level)) continue;
      if (!create) return null;
      mkdirSync(level, { mode: 0o700 });
      protectPrivatePath(level, 0o700);
    }
    const relative = path.relative(realpathSync(mcp), realpathSync(dir));
    if (relative !== id) throw new Error("MCP secret directory resolves outside secrets/mcp; refused");
    return dir;
  }

  return {
    set(id: string, name: string, value: string): void {
      assertName(name);
      saveSecretLine(path.join(idDirectory(id, true)!, name), value);
    },
    has(id: string, name: string): boolean {
      assertName(name);
      const dir = idDirectory(id, false);
      return dir !== null && existsSync(path.join(dir, name));
    },
    names(id: string): string[] {
      const dir = idDirectory(id, false);
      if (!dir) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && NAME.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    },
    /** Only the supervisor calls this, to hand the value to the server it starts. */
    resolve(id: string, name: string): string {
      assertName(name);
      const dir = idDirectory(id, false);
      const missing = `MCP secret ${name} is not set for ${id}`;
      if (!dir) throw new Error(missing);
      return readSecretLine(path.join(dir, name), missing, `MCP secret ${name} for ${id} is not one line of text`);
    },
    clear(id: string, name: string): void {
      assertName(name);
      const dir = idDirectory(id, false);
      // unlink removes a link itself, never what it points at.
      if (dir) rmSync(path.join(dir, name), { force: true });
    },
    removeAll(id: string): void {
      const dir = idDirectory(id, false);
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
    /** Ids that have a secret directory, for start-up reconciliation. */
    ids(): string[] {
      if (!refuseLink(secrets) || !refuseLink(mcp)) return [];
      return readdirSync(mcp, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    },
  };
}
