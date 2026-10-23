import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LockTimeoutError, withFileLock } from "../../src/direct/lock.js";

let dir: string;
let lock: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nema-lock-test-"));
  lock = join(dir, "auth.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function deadPid(): number {
  for (let pid = 999_999; pid > 900_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no free pid found");
}

test("runs fn, returns its value, and removes the lock afterwards", async () => {
  await expect(withFileLock(lock, async () => (existsSync(lock) ? "held" : "missing"))).resolves.toBe("held");
  expect(existsSync(lock)).toBe(false);
});

test("releases the lock when fn throws", async () => {
  await expect(withFileLock(lock, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(existsSync(lock)).toBe(false);
});

test("serialises concurrent holders", async () => {
  let inside = 0;
  let maxInside = 0;
  const work = () =>
    withFileLock(lock, async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 30));
      inside--;
    }, { pollMs: 5 });
  await Promise.all([work(), work(), work()]);
  expect(maxInside).toBe(1);
});

test("takes over an old lock whose holder pid does not exist", async () => {
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: Date.now() - 60_000 }));
  const t0 = Date.now();
  await expect(withFileLock(lock, async () => "ok", { timeoutMs: 2000 })).resolves.toBe("ok");
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(existsSync(lock)).toBe(false);
});

test("does not take over an old lock while its holder pid is alive", async () => {
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  let ran = false;
  const err = await withFileLock(lock, async () => { ran = true; }, { timeoutMs: 100, pollMs: 10, staleMs: 20 }).catch((e) => e);
  expect(err).toBeInstanceOf(LockTimeoutError);
  expect(ran).toBe(false);
  expect(existsSync(lock)).toBe(true);
});

test("does not steal a subprocess lock while its event loop is stalled past staleMs", async () => {
  const fixture = fileURLToPath(new URL("../fixtures/lock-stall-worker.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", fixture, lock, "300"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  const lines: string[] = [];
  const waiters: Array<() => void> = [];
  child.stdout!.on("data", (data) => {
    output += data;
    let i: number;
    while ((i = output.indexOf("\n")) >= 0) {
      lines.push(output.slice(0, i));
      output = output.slice(i + 1);
      waiters.splice(0).forEach((wake) => wake());
    }
  });
  child.stderr!.on("data", (data) => { stderr += data; });
  const nextLine = (index: number) => new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`subprocess timed out; stderr: ${stderr}`)), 5_000);
    const check = () => {
      if (lines.length > index) { clearTimeout(timer); resolve(lines[index]!); }
      else if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(`subprocess exited ${child.exitCode}; stderr: ${stderr}`)); }
      else waiters.push(check);
    };
    child.on("exit", () => waiters.splice(0).forEach((wake) => wake()));
    check();
  });

  try {
    expect(await nextLine(0)).toBe("holder-start");
    let contenderEntered = false;
    const contender = withFileLock(lock, async () => { contenderEntered = true; }, { staleMs: 100, pollMs: 10, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 180));
    expect(contenderEntered).toBe(false);
    expect(await nextLine(1)).toBe("holder-end");
    await contender;
    expect(contenderEntered).toBe(true);
    if (child.exitCode === null) await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`subprocess exited ${code}; stderr: ${stderr}`)));
    });
    expect(child.exitCode).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise<void>((resolve) => child.exitCode !== null ? resolve() : child.once("exit", () => resolve()));
  }
});

test("times out with LockTimeoutError while a live, fresh holder keeps the lock", async () => {
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  let ran = false;
  const err = await withFileLock(lock, async () => { ran = true; }, { timeoutMs: 200, pollMs: 20 }).catch((e) => e);
  expect(err).toBeInstanceOf(LockTimeoutError);
  expect(ran).toBe(false);
  expect(existsSync(lock)).toBe(true); // a foreign lock is never removed on timeout
});

test("a heartbeat keeps a slow live holder from being taken over by age, and stops on release", async () => {
  const staleMs = 150;
  const events: string[] = [];
  const holder = withFileLock(lock, async () => {
    events.push("holder-start");
    await new Promise((r) => setTimeout(r, staleMs * 3));
    events.push("holder-end");
  }, { staleMs, pollMs: 10 });
  await new Promise((r) => setTimeout(r, 30));
  const contender = withFileLock(lock, async () => { events.push("contender"); }, { staleMs, pollMs: 10, timeoutMs: 5000 });
  await Promise.all([holder, contender]);
  expect(events).toEqual(["holder-start", "holder-end", "contender"]);
  await new Promise((r) => setTimeout(r, staleMs));
  expect(existsSync(lock)).toBe(false); // the stopped heartbeat never recreates the lock
});
