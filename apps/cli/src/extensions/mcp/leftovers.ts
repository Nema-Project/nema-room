import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = "server.json";
const GRACE_MS = 2000;
// Absolute, so a writable directory early in the daemon's PATH cannot stand in for it.
const PS = ["/bin/ps", "/usr/bin/ps"].find((candidate) => existsSync(candidate));

/**
 * Who `pid` is, precisely enough to tell it from a later process that got the same pid, or null
 * when that cannot be read now. Linux: the start time in clock ticks since boot from /proc. Elsewhere
 * (macOS): `ps`'s start time, which has one-second precision, together with the full command line.
 */
export function processIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name (field 2) is in parentheses and may hold spaces; field 22 is starttime.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = fields[19];
      return ticks && /^\d+$/.test(ticks) ? `linux:${ticks}` : null;
    } catch {
      return null;
    }
  }
  if (!PS) return null;
  try {
    const out = execFileSync(PS, ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : `ps:${out}`;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Anything left in the group `pgid` leads, even after the leader itself exited. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

type Entry = { pid: number; startedAt: string | null; owner: { pid: number; startedAt: string | null } | null };

export type McpLeftoverOptions = {
  /** For tests: the daemon that writes the records (default: this process). */
  self?: number;
  /** For tests: how a process is identified. */
  identity?: (pid: number) => string | null;
};

/**
 * Records of the stdio MCP servers this daemon has running, one per id in
 * `<nema home>/run/mcp/<id>/server.json`, so a daemon that was killed (and never ran its close) is
 * cleaned up by the next one. POSIX only: on Windows stdio servers run only under the desktop app's
 * owned-process scope, which ends the tree itself.
 */
export function openMcpLeftovers(nemaHome: string, options: McpLeftoverOptions = {}) {
  const root = path.join(nemaHome, "run", "mcp");
  const fileOf = (id: string) => path.join(root, id, FILE);
  const identity = options.identity ?? processIdentity;
  const self = options.self ?? process.pid;

  function read(id: string): Entry | null {
    try {
      const raw = JSON.parse(readFileSync(fileOf(id), "utf8")) as { pid?: unknown; startedAt?: unknown; owner?: unknown };
      if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 1) return null;
      const owner = raw.owner as { pid?: unknown; startedAt?: unknown } | null | undefined;
      return {
        pid: raw.pid,
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null,
        owner:
          owner && typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 1
            ? { pid: owner.pid, startedAt: typeof owner.startedAt === "string" ? owner.startedAt : null }
            : null,
      };
    } catch {
      return null;
    }
  }

  /** The daemon that recorded `entry` is still running (and is not this one). */
  function ownerRunning(entry: Entry): boolean {
    const owner = entry.owner;
    if (!owner || owner.pid === self || !alive(owner.pid)) return false;
    // Its start time cannot be read, or it matches: either way it may well be that daemon.
    const now = identity(owner.pid);
    return now === null || owner.startedAt === null || now === owner.startedAt;
  }

  async function stopGroup(pgid: number): Promise<void> {
    signalGroup(pgid, "SIGTERM");
    const end = Date.now() + GRACE_MS;
    while (groupAlive(pgid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
    // The leader and anything still in its group.
    signalGroup(pgid, "SIGKILL");
  }

  /** What `record` writes for `pid`. */
  const entry = (pid: number): Entry => ({ pid, startedAt: identity(pid), owner: { pid: self, startedAt: identity(self) } });

  return {
    entry,
    record(id: string, pid: number): void {
      mkdirSync(path.join(root, id), { recursive: true, mode: 0o700 });
      writeFileSync(fileOf(id), JSON.stringify(entry(pid)) + "\n", { mode: 0o600 });
    },
    /** Forget `id`'s record, but only if it is still the one for `pid`. */
    clear(id: string, pid: number): void {
      if (read(id)?.pid === pid) rmSync(fileOf(id), { force: true });
    },
    /**
     * At daemon start, before any MCP operation: stop every recorded server whose daemon is gone and
     * that is still the same process (or whose leader exited but left its group behind), with its
     * whole group. A record is removed only once that is done, or once it is clear there is nothing
     * of it left; one that cannot be checked now is kept for the next start. Returns the ids stopped.
     */
    async sweep(): Promise<string[]> {
      let ids: string[];
      try {
        ids = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const stopped: string[] = [];
      for (const id of ids.sort()) {
        if (!existsSync(fileOf(id))) continue;
        const entry = read(id);
        if (!entry) {
          rmSync(fileOf(id), { force: true });
          continue;
        }
        // Another daemon on this home is running it: not a leftover.
        if (ownerRunning(entry)) continue;
        if (alive(entry.pid)) {
          const now = identity(entry.pid);
          // Cannot be told apart right now: kept, and checked again on the next start.
          if (now === null) continue;
          // Without a start time recorded, or with another one, the pid is someone else's now.
          if (entry.startedAt === null || now !== entry.startedAt) {
            rmSync(fileOf(id), { force: true });
            continue;
          }
          await stopGroup(entry.pid);
          stopped.push(id);
        } else if (groupAlive(entry.pid)) {
          // The leader exited but its group lives on. A pid stays reserved while a group carries its
          // number, so this is still that server's group.
          await stopGroup(entry.pid);
          stopped.push(id);
        }
        rmSync(fileOf(id), { force: true });
      }
      return stopped;
    },
  };
}

export type McpLeftovers = ReturnType<typeof openMcpLeftovers>;
