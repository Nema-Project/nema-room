import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// Absolute, so a writable directory early in PATH cannot stand in for it (same rule as leftovers.ts).
const PS = ["/bin/ps", "/usr/bin/ps"].find((candidate) => existsSync(candidate));

/**
 * Whether `pid` has stopped running, told apart from "already exited but not yet reaped".
 *
 * `process.kill(pid, 0)` answers for a zombie exactly as for a live process, and it treats pid 0 as
 * this process's own group, so it succeeds forever. A test that polls it after a SIGKILL can wait
 * out its whole budget against a corpse the parent never waits for. Here a zombie counts as
 * stopped, because it runs no more code.
 *
 * Conservative on purpose: when the state cannot be read, fall back to `process.kill(pid, 0)`, so an
 * unreadable process still counts as running and a real leak cannot hide behind a failed read.
 */
export function isStopped(pid: number): boolean {
  // Nothing to wait for: a pid that is not a positive integer never names a process we started,
  // while kill(0, 0) targets our own group and always succeeds.
  if (!Number.isInteger(pid) || pid <= 1) return true;
  const state = processState(pid);
  if (state === null) {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "EPERM";
    }
  }
  // Z: exited, waiting to be reaped; X/x: dead. Neither runs any more code.
  return state === "Z" || state === "X" || state === "x";
}

/**
 * The single-letter process state from /proc (Linux) or `ps` (other POSIX systems), or null when it
 * cannot be read now. Undefined means "no state letter in the output", also treated as unreadable.
 */
function processState(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name (field 2) is in parentheses and may hold spaces; the state follows it.
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return state && /^[A-Za-z]$/.test(state) ? state : null;
    } catch {
      return null;
    }
  }
  if (!PS) return null;
  try {
    const out = execFileSync(PS, ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    // `ps` prints flags before the state letter; on Linux the first character is the state.
    const state = out[0];
    return state && /^[A-Za-z]$/.test(state) ? state : null;
  } catch {
    return null;
  }
}

/**
 * The pid written to `file`, once the writer has actually written it.
 *
 * `writeFileSync` creates the file before it writes the bytes, so polling `existsSync` and then
 * reading can see an empty file. `Number("")` is 0, and pid 0 means "this process's own group" to
 * `process.kill`, so every liveness check on it succeeds forever: that is what made the mcpLeftovers
 * descendant test wait out its whole budget on main CI. Wait for a real pid instead of the file.
 *
 * Async so that a writer in this process can still run between polls.
 */
export async function waitForPid(file: string, ms = 5000): Promise<number> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      if (/^\d+$/.test(raw) && Number(raw) > 1) return Number(raw);
    } catch {
      // Not created yet.
    }
    if (Date.now() >= end) throw new Error(`no pid was written to ${file} within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
