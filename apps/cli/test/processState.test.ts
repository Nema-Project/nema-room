import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isStopped, waitForPid } from "./processState.js";

const posix = process.platform !== "win32";

/** The old liveness rule, kept here so a regression in isStopped shows up as a difference between them. */
const killAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The children of `pid` with their state, from one full process-table read. */
const childrenOf = (pid: number): Array<{ pid: number; stat: string }> => {
  // `ps -o ... --ppid` is GNU-only: macOS's ps rejects long options, and has no parent-selection
  // flag at all (`-P` is not one there; on GNU `-P` means something else entirely). `-axo` with a
  // ppid column is the form both document, and is the documented way to list zombies on macOS.
  const ps = ["/bin/ps", "/usr/bin/ps"].find((candidate) => existsSync(candidate));
  if (!ps) throw new Error("ps not found");
  const out = spawnSync(ps, ["-axo", "pid=,stat=,ppid="], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`ps exited ${out.status}: ${out.stderr}`);
  return out.stdout.trim().split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, , ppid]) => ppid === String(pid))
    .map(([id, stat]) => ({ pid: Number(id), stat: stat ?? "" }));
};

const stateOf = (pid: number): string | null => {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? null;
    } catch { return null; }
  }
  const ps = ["/bin/ps", "/usr/bin/ps"].find((candidate) => existsSync(candidate));
  if (!ps) return null;
  try {
    return spawnSync(ps, ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()[0] ?? null;
  } catch { return null; }
};

describe("isStopped", () => {
  test("a running process is not stopped", () => {
    expect(isStopped(process.pid)).toBe(false);
  });

  test("a pid that cannot name a process we started is stopped, not mistaken for our own group", () => {
    // kill(0, 0) signals this process's group and succeeds, so a bare kill() call would call pid 0 alive
    // forever. Number("") is 0: that is how an empty pid file used to hang the mcpLeftovers poll.
    for (const pid of [0, -1, 1.5, Number.NaN, Number("")]) {
      expect(isStopped(pid)).toBe(true);
    }
  });

  test.skipIf(!posix)("an exited process that was never reaped counts as stopped", () => {
    // A shell execs into a long sleep after starting a child, so the exited child stays a zombie:
    // its parent never waits for it. This is the state a SIGKILLed server's children reach when the
    // reaper above the test does not collect them.
    const holder = spawn("/bin/sh", ["-c", "sleep 0.05 & exec sleep 30"], { stdio: "ignore" });
    // The parent to look under: without a pid there is nothing to query, so say so instead of
    // passing undefined on as a child filter.
    const holderPid = holder.pid;
    if (holderPid === undefined) throw new Error("the holder process did not start");
    try {
      const deadline = Date.now() + 5000;
      let zombie = 0;
      while (Date.now() < deadline && zombie === 0) {
        const found = childrenOf(holderPid).find((child) => child.stat.startsWith("Z"));
        if (found) zombie = found.pid;
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
      expect(zombie).toBeGreaterThan(0);
      expect(stateOf(zombie)).toBe("Z");
      // The old rule calls this corpse alive forever; that is the flake this test pins down.
      expect(killAlive(zombie)).toBe(true);
      expect(isStopped(zombie)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  }, 20_000);
});

describe("waitForPid", () => {
  test("skips the empty window of a file that is created before it is written", async () => {
    // writeFileSync creates then writes; a reader that trusts existsSync can see "". Number("") is 0,
    // and pid 0 is this process's own group, which kill(0, 0) always accepts.
    const dir = mkdtempSync(join(tmpdir(), "nema-wait-for-pid-"));
    const file = join(dir, "late.pid");
    try {
      writeFileSync(file, "");
      setTimeout(() => writeFileSync(file, "4242"), 50);
      await expect(waitForPid(file)).resolves.toBe(4242);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails instead of returning a pid when nothing usable is ever written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nema-wait-for-pid-"));
    const file = join(dir, "never.pid");
    try {
      writeFileSync(file, "");
      await expect(waitForPid(file, 100)).rejects.toThrow(/no pid was written/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
