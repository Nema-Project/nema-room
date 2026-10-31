import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openMcpLeftovers } from "../../src/extensions/mcp/leftovers.js";
import { isStopped, waitForPid } from "../processState.js";

const posix = process.platform !== "win32";
let home: string;
const pids: number[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nema-mcp-left-")); });
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
});

// Not `kill(pid, 0)`: that calls a SIGKILLed server's unreaped child alive, and calls pid 0 (an
// empty pid file) alive forever. isStopped folds a zombie into "stopped" and stays conservative
// when the state cannot be read.
const alive = (pid: number) => !isStopped(pid);
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 25));
  return check();
}

/** A detached group leader with one child in its group, like a stdio server left by a crashed daemon. */
async function orphan(): Promise<{ leader: number; child: number }> {
  const file = join(home, `child-${pids.length}.pid`);
  const leader = spawn(process.execPath, ["-e", `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000)`], { detached: true, stdio: "ignore" });
  leader.unref();
  pids.push(leader.pid!);
  return { leader: leader.pid!, child: await waitForPid(file) };
}

describe.skipIf(!posix)("MCP servers left running by a daemon that did not shut down", () => {
  test("sweep stops a recorded server's whole group and forgets it", async () => {
    const { leader, child } = await orphan();
    await until(() => alive(child));
    openMcpLeftovers(home).record("search", leader);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(true);
    const swept = await openMcpLeftovers(home).sweep();
    expect(swept).toEqual(["search"]);
    expect(await until(() => !alive(leader) && !alive(child))).toBe(true);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(false);
  });

  test("a recorded pid that now belongs to another process is not signalled", async () => {
    const { leader } = await orphan();
    openMcpLeftovers(home).record("search", leader);
    const file = join(home, "run", "mcp", "search", "server.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, startedAt: "Thu Jan  1 00:00:00 1970" }));
    expect(await openMcpLeftovers(home).sweep()).toEqual([]);
    expect(alive(leader)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("a record for a process that is gone, or a damaged record, is just removed", async () => {
    openMcpLeftovers(home).record("gone", 2 ** 22 + 12345);
    const broken = join(home, "run", "mcp", "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "server.json"), "{not json");
    expect(await openMcpLeftovers(home).sweep()).toEqual([]);
    expect(existsSync(join(home, "run", "mcp", "gone", "server.json"))).toBe(false);
    expect(existsSync(join(broken, "server.json"))).toBe(false);
  });

  test("a server whose daemon is still running is left alone, record and all", async () => {
    const { leader } = await orphan();
    const owner = (await orphan()).leader;
    openMcpLeftovers(home).record("search", leader);
    const file = join(home, "run", "mcp", "search", "server.json");
    // Written by another daemon on the same home that is still running.
    writeFileSync(file, JSON.stringify(openMcpLeftovers(home, { self: owner }).entry(leader)));
    expect(await openMcpLeftovers(home).sweep()).toEqual([]);
    expect(alive(leader)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  test("a group whose leader exited is still stopped, so its descendants do not stay behind", async () => {
    const { leader, child } = await orphan();
    await until(() => alive(child));
    openMcpLeftovers(home).record("search", leader);
    process.kill(leader, "SIGKILL");
    expect(await until(() => !alive(leader))).toBe(true);
    expect(alive(child)).toBe(true);
    expect(await openMcpLeftovers(home).sweep()).toEqual(["search"]);
    expect(await until(() => !alive(child))).toBe(true);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(false);
  });

  test("when the start time cannot be read now, the record is kept and nothing is signalled", async () => {
    const { leader } = await orphan();
    openMcpLeftovers(home).record("search", leader);
    const file = join(home, "run", "mcp", "search", "server.json");
    expect(await openMcpLeftovers(home, { identity: () => null }).sweep()).toEqual([]);
    expect(alive(leader)).toBe(true);
    expect(existsSync(file)).toBe(true);
    // A later start that can read it stops the server.
    expect(await openMcpLeftovers(home).sweep()).toEqual(["search"]);
  });

  test("a child pid is read only once the writer has written it, never as an empty pid 0", async () => {
    // writeFileSync creates the file before writing the bytes, so a bare existsSync-then-read can see
    // an empty file. Number("") is 0 and kill(0, 0) targets this process's own group, which succeeds
    // forever: that is what hung test 5 on main CI. waitForPid must skip the empty read.
    const file = join(home, "empty-then-written.pid");
    writeFileSync(file, "");
    const child = spawn(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, String(process.pid))`], { stdio: "ignore" });
    try {
      const pid = await waitForPid(file);
      expect(pid).toBe(child.pid);
      expect(pid).toBeGreaterThan(1);
      expect(isStopped(0)).toBe(true);
    } finally {
      child.unref();
    }
  });

  test("clear removes only the record of that pid", () => {
    const left = openMcpLeftovers(home);
    left.record("search", 4242);
    left.clear("search", 4343);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(true);
    left.clear("search", 4242);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(false);
  });
});
