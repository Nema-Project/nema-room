import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { accountsLockPath, accountsPath, readAccounts, updateAccounts, withAccountsLock, writeAccounts } from "../../src/accounts/store.js";
import { snapshotLockForTest, takeOverStaleLock } from "../../src/accounts/lock.js";
import type { AccountsFile } from "../../src/accounts/schema.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-accounts-lock-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const row = (id: string, name: string) => ({
  id, name, enabled: true, adapter: "claude-code" as const, costTier: "standard" as const, order: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
});
const file = (...rows: ReturnType<typeof row>[]): AccountsFile => ({ version: 1, accounts: rows, bindings: {} });

describe("an unreadable lock is not stale while it may still be initializing (review 2)", () => {
  test("an empty lock belonging to a live pid-less creator is waited on, not removed", () => {
    mkdirSync(home, { recursive: true });
    // A peer that created the file a moment ago and has not written its record yet.
    writeFileSync(accountsLockPath(home), "", { mode: 0o600 });

    let ran = false;
    expect(() => withAccountsLock(home, () => { ran = true; }, { waitMs: 150 })).toThrow(/超时/);
    expect(ran).toBe(false);
    // The lock the peer is about to fill in is untouched.
    expect(existsSync(accountsLockPath(home))).toBe(true);
    expect(readFileSync(accountsLockPath(home), "utf8")).toBe("");
  });

  test("an old unreadable lock is taken over, so a crashed initializer cannot wedge the file", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsLockPath(home), "", { mode: 0o600 });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(accountsLockPath(home), old, old);

    expect(withAccountsLock(home, () => "ran")).toBe("ran");
    expect(existsSync(accountsLockPath(home))).toBe(false);
  });
});

describe("takeover removes only the lock that was judged (review 2, 4)", () => {
  const staleRaw = JSON.stringify({ pid: 999_999, at: 1, token: "stale-token" });

  function plantLock(raw = staleRaw, ageMs = 60_000): ReturnType<typeof snapshotLockForTest> {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsLockPath(home), raw, { mode: 0o600 });
    const old = new Date(Date.now() - ageMs);
    utimesSync(accountsLockPath(home), old, old);
    return snapshotLockForTest(accountsLockPath(home));
  }

  test("a lock replaced by a peer in the meantime is left in place", () => {
    const observed = plantLock()!;
    // A peer replaces the lock between the judgement and the takeover.
    rmSync(accountsLockPath(home));
    writeFileSync(accountsLockPath(home), JSON.stringify({ pid: process.pid, at: Date.now(), token: "peer-token" }), { mode: 0o600 });

    expect(takeOverStaleLock(accountsLockPath(home), observed)).toBe(false);
    expect(JSON.parse(readFileSync(accountsLockPath(home), "utf8")).token).toBe("peer-token");
  });

  test("a different empty lock is not mistaken for the judged one", () => {
    // Two empty locks have identical contents: only the inode tells them apart.
    const observed = plantLock("")!;
    rmSync(accountsLockPath(home));
    writeFileSync(accountsLockPath(home), "", { mode: 0o600 });

    expect(takeOverStaleLock(accountsLockPath(home), observed)).toBe(false);
    expect(existsSync(accountsLockPath(home))).toBe(true);
  });

  test("a lock that was filled in after the judgement is left alone", () => {
    const observed = plantLock("")!;
    writeFileSync(accountsLockPath(home), JSON.stringify({ pid: process.pid, at: Date.now(), token: "live" }), { mode: 0o600 });

    expect(takeOverStaleLock(accountsLockPath(home), observed)).toBe(false);
    expect(JSON.parse(readFileSync(accountsLockPath(home), "utf8")).token).toBe("live");
  });

  test("the lock that was judged is removed", () => {
    const observed = plantLock()!;
    expect(takeOverStaleLock(accountsLockPath(home), observed)).toBe(true);
    expect(existsSync(accountsLockPath(home))).toBe(false);
  });

  test("the lock path is never vacated for a peer during a takeover", () => {
    // A peer that acquires the lock while the takeover runs must still find it gone afterwards only if it
    // was the judged lock; a takeover must not remove a lock that exists at any later moment.
    const observed = plantLock()!;
    expect(takeOverStaleLock(accountsLockPath(home), observed)).toBe(true);
    // Immediately after, a live writer can take the path and is not removed by anything.
    writeAccounts(home, file(row("acct_aaaaaaaaaa", "one")));
    expect(existsSync(accountsLockPath(home))).toBe(false);
    expect(readAccounts(home).status).toBe("ok");
  });

  test("a peer that removed the lock first is harmless", () => {
    mkdirSync(home, { recursive: true });
    expect(takeOverStaleLock(accountsLockPath(home), { dev: 0n, ino: 0n, mtimeNs: 0n, size: 0n, raw: "whatever" })).toBe(true);
  });

  test("an abandoned takeover claim does not wedge the file", () => {
    mkdirSync(home, { recursive: true });
    const claim = `${accountsLockPath(home)}.takeover`;
    writeFileSync(claim, JSON.stringify({ pid: 999_999, at: 1 }), { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(claim, old, old);
    plantLock();

    expect(withAccountsLock(home, () => "ran")).toBe("ran");
  });

  test("a live takeover claim makes the waiter retry instead of displacing anything", () => {
    const observed = plantLock()!;
    const claim = `${accountsLockPath(home)}.takeover`;
    writeFileSync(claim, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });

    expect(takeOverStaleLock(accountsLockPath(home), observed)).toBe(false);
    expect(existsSync(accountsLockPath(home))).toBe(true);
    rmSync(claim);
  });
});

describe("the lock and nemaHome (review 7)", () => {
  test("a symlinked accounts.lock is refused before anything is written", () => {
    mkdirSync(home, { recursive: true });
    const target = join(root, "elsewhere.lock");
    writeFileSync(target, JSON.stringify({ pid: 1, at: 1, token: "t" }), { mode: 0o600 });
    try {
      symlinkSync(target, accountsLockPath(home));
    } catch {
      return; // no file symlinks on this host
    }

    expect(() => withAccountsLock(home, () => "ran", { waitMs: 100 })).toThrow(/符号链接/);
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ pid: 1, at: 1, token: "t" }));
  });
});

describe("writeAccounts participates in the lock (review 14)", () => {
  test("a write from inside the lock does not deadlock, and the file is written", () => {
    const result = withAccountsLock(home, () => {
      writeAccounts(home, file(row("acct_aaaaaaaaaa", "one")));
      return readAccounts(home).status;
    });

    expect(result).toBe("ok");
    expect(existsSync(accountsLockPath(home))).toBe(false);
  });

  test("a nested withAccountsLock is refused instead of hanging", () => {
    expect(() => withAccountsLock(home, () => withAccountsLock(home, () => "inner", { waitMs: 100 }))).toThrow(/重入/);
  });

  test("updateAccounts sees the file under the lock and refuses an unusable one", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), "{ broken", { mode: 0o600 });

    expect(() => updateAccounts(home, () => ({ version: 1, accounts: [], bindings: {} }))).toThrow(/不可用/);
    expect(readFileSync(accountsPath(home), "utf8")).toBe("{ broken");
  });

  test("updateAccounts can decline to write by returning null", () => {
    writeAccounts(home, file(row("acct_aaaaaaaaaa", "one")));
    const before = readFileSync(accountsPath(home), "utf8");

    expect(updateAccounts(home, () => null)).toBeNull();
    expect(readFileSync(accountsPath(home), "utf8")).toBe(before);
  });
});

/* ------------------------------------------------------------ child processes */

const cliDir = fileURLToPath(new URL("../..", import.meta.url));
const worker = fileURLToPath(new URL("../fixtures/accounts-writer.mjs", import.meta.url));

type Writer = { child: ChildProcess; done: Promise<Record<string, unknown>> };

function startWriter(args: string[]): Writer {
  const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], { cwd: cliDir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr!.on("data", (d) => (err += d));
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    child.stdout!.on("data", (d) => {
      out += d;
      const nl = out.indexOf("\n");
      if (nl >= 0) {
        try {
          resolve(JSON.parse(out.slice(0, nl)));
        } catch (e) {
          reject(new Error(`bad child output ${out}: ${String(e)}`));
        }
      }
    });
    child.on("exit", (code) => {
      if (!out.includes("\n")) reject(new Error(`child exited ${code}; stderr: ${err}`));
    });
  });
  return { child, done };
}

async function waitForFile(file: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("two real processes write accounts.json at once (review 15)", () => {
  test("the second writer waits and both rows survive", async () => {
    const holdA = join(root, "a.holding");
    const releaseA = join(root, "a.release");
    const holdB = join(root, "b.holding");

    // A first, with no barrier: the parent waits until A is inside the critical section, holding the lock
    // and already past the read. Then B starts, so the overlap is caused by the lock, not by luck.
    const a = startWriter(["update", home, "one", "aaaaaaaaaa", "", holdA, releaseA]);
    await waitForFile(holdA);
    expect(JSON.parse(readFileSync(holdA, "utf8")).rows).toBe(0); // A read an empty (missing) file
    expect(existsSync(accountsPath(home))).toBe(false); // and has not committed while holding the lock

    const b = startWriter(["update", home, "two", "bbbbbbbbbb", "", holdB, ""]);
    await waitForFile(`${holdB}.pre`); // B is now asking for the lock
    expect(existsSync(holdB)).toBe(false); // …and cannot get in while A holds it

    writeFileSync(releaseA, "go");
    expect(await a.done).toMatchObject({ ok: true });
    expect(await b.done).toMatchObject({ ok: true });

    // The proof of serialization: B's snapshot was taken under the lock, so it saw A's committed row.
    expect(JSON.parse(readFileSync(holdB, "utf8")).rows).toBe(1);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts.map((x) => x.name).sort()).toEqual(["one", "two"]);
  }, 60_000);

  test("two materializations overlap at the lock and produce two accounts", async () => {
    // Both children are released together past a two-way barrier, so they are in flight at the same time;
    // without a working lock each would read the same (missing) file and one row would be lost.
    const gateA = join(root, "m.a");
    const gateB = join(root, "m.b");
    const holdA = join(root, "ma.holding");
    const holdB = join(root, "mb.holding");
    const a = startWriter(["materialize", home, "one", "aaaaaaaaaa", gateA, holdA, ""]);
    const b = startWriter(["materialize", home, "two", "bbbbbbbbbb", gateB, holdB, ""]);
    await waitForFile(gateA);
    await waitForFile(gateB);

    expect(await a.done).toMatchObject({ ok: true });
    expect(await b.done).toMatchObject({ ok: true });
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts).toHaveLength(2);
    // The two accounts are the two the children reported: neither writer's row replaced the other's.
    const ids = stored.status === "ok" ? stored.file.accounts.map((x) => x.id).sort() : [];
    const reported = [JSON.parse(readFileSync(holdA, "utf8")).id, JSON.parse(readFileSync(holdB, "utf8")).id].sort();
    expect(ids).toEqual(reported);
  }, 60_000);
});
