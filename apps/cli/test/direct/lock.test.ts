import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("takes over a lock whose holder pid does not exist", async () => {
  writeFileSync(lock, JSON.stringify({ pid: deadPid(), at: Date.now() }));
  const t0 = Date.now();
  await expect(withFileLock(lock, async () => "ok", { timeoutMs: 2000 })).resolves.toBe("ok");
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(existsSync(lock)).toBe(false);
});

test("takes over a lock older than staleMs even if the holder is alive", async () => {
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
  await expect(withFileLock(lock, async () => "ok", { timeoutMs: 2000 })).resolves.toBe("ok");
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
