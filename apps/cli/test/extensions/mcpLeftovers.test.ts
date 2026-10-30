import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openMcpLeftovers } from "../../src/extensions/mcp/leftovers.js";

const posix = process.platform !== "win32";
let home: string;
const pids: number[] = [];
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nema-mcp-left-")); });
afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 25));
  return check();
}

/** A detached group leader with one child in its group, like a stdio server left by a crashed daemon. */
function orphan(): { leader: number; child: number } {
  const file = join(home, `child-${pids.length}.pid`);
  const leader = spawn(process.execPath, ["-e", `const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});require("fs").writeFileSync(${JSON.stringify(file)},String(c.pid));setInterval(()=>{},1000)`], { detached: true, stdio: "ignore" });
  leader.unref();
  pids.push(leader.pid!);
  const start = Date.now();
  while (!existsSync(file) && Date.now() - start < 5000) { /* wait for the child */ }
  return { leader: leader.pid!, child: Number(readFileSync(file, "utf8")) };
}

describe.skipIf(!posix)("MCP servers left running by a daemon that did not shut down", () => {
  test("sweep stops a recorded server's whole group and forgets it", async () => {
    const { leader, child } = orphan();
    await until(() => alive(child));
    openMcpLeftovers(home).record("search", leader);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(true);
    const swept = await openMcpLeftovers(home).sweep();
    expect(swept).toEqual(["search"]);
    expect(await until(() => !alive(leader) && !alive(child))).toBe(true);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(false);
  });

  test("a recorded pid that now belongs to another process is not signalled", async () => {
    const { leader } = orphan();
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

  test("clear removes only the record of that pid", () => {
    const left = openMcpLeftovers(home);
    left.record("search", 4242);
    left.clear("search", 4343);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(true);
    left.clear("search", 4242);
    expect(existsSync(join(home, "run", "mcp", "search", "server.json"))).toBe(false);
  });
});
