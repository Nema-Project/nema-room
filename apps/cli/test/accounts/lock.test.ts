import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { accountsLockPath, accountsPath, readAccounts, updateAccounts, withAccountsLock, writeAccounts } from "../../src/accounts/store.js";
import { takeOverStaleLock } from "../../src/accounts/lock.js";
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

describe("taking over a stale lock removes only the lock that was judged (review 2)", () => {
  test("a lock replaced by a peer in the meantime is put back, not deleted", () => {
    mkdirSync(home, { recursive: true });
    const lock = accountsLockPath(home);
    const stale = JSON.stringify({ pid: 999_999, at: 1, token: "stale-token" });
    // The lock judged stale…
    writeFileSync(lock, stale, { mode: 0o600 });
    // …and a peer replaces it between the judgement and the takeover.
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token: "peer-token" }), { mode: 0o600 });
    // Simulate the race by judging the old content while the new one is in place.
    const removed = takeOverStaleLock(lock, stale);

    // The file it moved was not the one it judged, so it put it back and removed nothing.
    expect(removed).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("peer-token");
  });

  test("a lock that is still the stale one is removed", () => {
    mkdirSync(home, { recursive: true });
    const lock = accountsLockPath(home);
    const stale = JSON.stringify({ pid: 999_999, at: 1, token: "stale-token" });
    writeFileSync(lock, stale, { mode: 0o600 });
    // The judgement and the removal see the same content, and the caller gets the lock on retry.
    expect(takeOverStaleLock(lock, stale)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  test("a peer that removed the lock first is harmless", () => {
    mkdirSync(home, { recursive: true });
    const lock = accountsLockPath(home);
    expect(takeOverStaleLock(lock, "whatever")).toBe(false);
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

    expect(() => updateAccounts(home, (current) => ({ version: 1, accounts: [], bindings: {} }))).toThrow(/不可用/);
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

function startWriter(args: string[]): { child: ChildProcess; done: Promise<Record<string, unknown>> } {
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

async function waitForFile(file: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("two real processes write accounts.json at once (review 15)", () => {
  test("both rows survive because the second writer waits for the first", async () => {
    // The first writer holds the lock open inside its critical section; the second starts only after that,
    // so without a working lock it would read the empty snapshot and write its row alone.
    const startedA = join(root, "a.started");
    const holdingA = join(root, "a.holding");
    const releaseA = join(root, "a.release");
    const a = startWriter(["update", home, "one", "aaaaaaaaaa", startedA, holdingA, releaseA]);
    await waitForFile(startedA);
    await waitForFile(holdingA);
    // A is inside the critical section; it has already read the (missing) file.
    const b = startWriter(["update", home, "two", "bbbbbbbbbb", join(root, "b.started"), join(root, "b.hold"), join(root, "b.rel")]);
    await waitForFile(join(root, "b.started"));
    // Give B time to be blocked on the lock, then let A commit.
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(accountsPath(home))).toBe(false); // neither has committed yet
    writeFileSync(releaseA, "go");

    expect(await a.done).toMatchObject({ ok: true });
    expect(await b.done).toMatchObject({ ok: true });
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") {
      expect(stored.file.accounts.map((x) => x.name).sort()).toEqual(["one", "two"]);
    }
  }, 60_000);

  test("two materializations at once produce two accounts, never one", async () => {
    const a = startWriter(["materialize", home, "one", "aaaaaaaaaa", join(root, "1"), join(root, "1h"), join(root, "1r")]);
    const b = startWriter(["materialize", home, "two", "bbbbbbbbbb", join(root, "2"), join(root, "2h"), join(root, "2r")]);

    expect(await a.done).toMatchObject({ ok: true });
    expect(await b.done).toMatchObject({ ok: true });
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts).toHaveLength(2);
  }, 60_000);
});
