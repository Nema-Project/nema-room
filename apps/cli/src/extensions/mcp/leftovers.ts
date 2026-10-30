import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = "server.json";
const GRACE_MS = 2000;

/**
 * The start time `ps` reports for `pid`, or null. Paired with the pid it tells a server this daemon
 * started from an unrelated process that later got the same pid.
 */
function startedAt(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

/**
 * Records of the stdio MCP servers this daemon has running, one per id in
 * `<nema home>/run/mcp/<id>/server.json`, so a daemon that was killed (and never ran its close) is
 * cleaned up by the next one. POSIX only: on Windows stdio servers run only under the desktop app's
 * owned-process scope, which ends the tree itself.
 */
export function openMcpLeftovers(nemaHome: string) {
  const root = path.join(nemaHome, "run", "mcp");
  const fileOf = (id: string) => path.join(root, id, FILE);

  function read(id: string): { pid: number; startedAt: string | null } | null {
    try {
      const raw = JSON.parse(readFileSync(fileOf(id), "utf8")) as { pid?: unknown; startedAt?: unknown };
      if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 1) return null;
      return { pid: raw.pid, startedAt: typeof raw.startedAt === "string" ? raw.startedAt : null };
    } catch {
      return null;
    }
  }

  return {
    record(id: string, pid: number): void {
      mkdirSync(path.join(root, id), { recursive: true, mode: 0o700 });
      writeFileSync(fileOf(id), JSON.stringify({ pid, startedAt: startedAt(pid) }) + "\n", { mode: 0o600 });
    },
    /** Forget `id`'s record, but only if it is still the one for `pid`. */
    clear(id: string, pid: number): void {
      if (read(id)?.pid === pid) rmSync(fileOf(id), { force: true });
    },
    /**
     * At daemon start, before any MCP operation: stop every recorded server that is still the same
     * process (pid and start time match), with its whole group, and drop every record. Returns the
     * ids that were stopped.
     */
    async sweep(): Promise<string[]> {
      let ids: string[];
      try {
        ids = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      } catch {
        return [];
      }
      const stopped: string[] = [];
      for (const id of ids.sort()) {
        const entry = read(id);
        rmSync(fileOf(id), { force: true });
        // Without a start time to compare, the pid could be anyone's; it is left alone.
        if (!entry || entry.startedAt === null || !alive(entry.pid) || startedAt(entry.pid) !== entry.startedAt) continue;
        signalGroup(entry.pid, "SIGTERM");
        const end = Date.now() + GRACE_MS;
        while (alive(entry.pid) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
        // The leader and anything still in its group.
        signalGroup(entry.pid, "SIGKILL");
        stopped.push(id);
      }
      return stopped;
    },
  };
}

export type McpLeftovers = ReturnType<typeof openMcpLeftovers>;
