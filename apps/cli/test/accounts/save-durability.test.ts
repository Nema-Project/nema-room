import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writePrivateFile } from "../nativePermissions.js";

/**
 * Round four, finding 4: a saved credential has to be durable before `saveAccountSecret` returns, which
 * means the directory entry the rename created has to be synced, not just the file's bytes.
 *
 * fsync cannot be observed from outside, so `node:fs` is wrapped to record which path each fsync was for.
 * The wrapper is installed before the modules under test are imported, hence the dynamic imports.
 */
const fsyncs: string[] = [];
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const openPaths = new Map<number, string>();
  return {
    ...real,
    openSync: ((...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args) as number;
      openPaths.set(fd, String(args[0]));
      return fd;
    }) as typeof real.openSync,
    closeSync: ((fd: number) => {
      openPaths.delete(fd);
      return real.closeSync(fd);
    }) as typeof real.closeSync,
    fsyncSync: ((fd: number) => {
      const path = openPaths.get(fd);
      if (path !== undefined) fsyncs.push(path);
      return real.fsyncSync(fd);
    }) as typeof real.fsyncSync,
  };
});

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-save-durable-"));
  home = join(root, "nema");
  fsyncs.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("a saved credential is durable before the save returns (review 4)", () => {
  test("the file, then its directory entry, are synced", async () => {
    const { saveAccountSecret, accountSecretPath } = await import("../../src/secrets/accounts.js");
    const { accountDir } = await import("../../src/accounts/store.js");

    saveAccountSecret(home, "acct_aaaaaaaaaa", "key", "fake-key-0000");

    const dir = accountDir(home, "acct_aaaaaaaaaa");
    const fileSync = fsyncs.findIndex((p) => p.startsWith(join(dir, "key.")));
    const dirSync = fsyncs.indexOf(dir);

    expect(fileSync).toBeGreaterThanOrEqual(0);
    expect(dirSync).toBeGreaterThanOrEqual(0);
    // The bytes are durable first, then the name the rename created.
    expect(fileSync).toBeLessThan(dirSync);
    expect(readFileSync(accountSecretPath(home, "acct_aaaaaaaaaa", "key"), "utf8")).toBe("fake-key-0000");
  });

  test("a newly created account directory chain is synced level by level (review 6)", async () => {
    const { saveAccountSecret } = await import("../../src/secrets/accounts.js");
    const { accountDir } = await import("../../src/accounts/store.js");

    // Nothing exists yet, so this one save creates `nemaHome`, `secrets`, `accounts` and the account
    // directory. Syncing only the deepest one persists the leaf's name inside its parent, not the parent's
    // own name: a power cut can then drop `secrets/` or `accounts/` and take the credential with it.
    saveAccountSecret(home, "acct_aaaaaaaaaa", "key", "fake-key-0000");

    const dir = accountDir(home, "acct_aaaaaaaaaa");
    const chain = [home, join(home, "secrets"), join(home, "secrets", "accounts"), dir];
    for (const level of chain) expect(fsyncs).toContain(level);
    // And in order, from the top down, so every name is durable before the one below it is created.
    expect(chain.map((level) => fsyncs.indexOf(level))).toEqual([...chain.map((level) => fsyncs.indexOf(level))].sort((a, b) => a - b));
  });

  test("re-saving into an existing directory does not re-walk the chain", async () => {
    const { saveAccountSecret } = await import("../../src/secrets/accounts.js");
    const { accountDir } = await import("../../src/accounts/store.js");

    saveAccountSecret(home, "acct_aaaaaaaaaa", "key", "fake-key-0000");
    fsyncs.length = 0;
    saveAccountSecret(home, "acct_aaaaaaaaaa", "key", "fake-key-1111");

    // Nothing was created this time, so only the directory whose entry the rename changed is synced. The
    // lock file and the temp file are file fsyncs, not directory ones; that distinction is the assertion.
    const dir = accountDir(home, "acct_aaaaaaaaaa");
    const directorySyncs = fsyncs.filter((p) => p === home || p === join(home, "secrets") || p === join(home, "secrets", "accounts") || p === dir);
    expect(directorySyncs).toEqual([dir]);
  });

  test("deleting an account's secrets syncs the parent (review 6)", async () => {
    const { removeAccountSecrets, saveAccountSecret } = await import("../../src/secrets/accounts.js");
    const { accountDir } = await import("../../src/accounts/store.js");

    saveAccountSecret(home, "acct_aaaaaaaaaa", "key", "fake-key-0000");
    const dir = accountDir(home, "acct_aaaaaaaaaa");
    fsyncs.length = 0;
    removeAccountSecrets(home, "acct_aaaaaaaaaa");

    // The removal is an entry in the parent: without the sync, a power cut can bring the credential's name
    // back even though the account is gone. Only the lock file is synced besides it.
    const accountsRoot = join(home, "secrets", "accounts");
    expect(fsyncs.filter((p) => p === accountsRoot)).toEqual([accountsRoot]);
    expect(fsyncs.filter((p) => p === dir || p === home || p === join(home, "secrets"))).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  test("an AuthStore save under an account directory syncs the whole chain (review 6)", async () => {
    const { AuthStore } = await import("../../src/direct/authStore.js");
    const { accountDir } = await import("../../src/accounts/store.js");

    // The login is written into `secrets/accounts/<id>/`, which this first save creates. Syncing only the
    // leaf persists the login's name inside the account directory while the name of that directory can still
    // be lost, so a power cut would take the credential with it.
    const dir = accountDir(home, "acct_aaaaaaaaaa");
    const store = new AuthStore(home, async () => ({ access_token: "a" }), Date.now, { baseDir: dir });
    store.save({
      version: 1, mode: "siwc", clientId: "c", tokens: { access_token: "a", refresh_token: "r" },
      lastRefresh: "2026-10-01T00:00:00.000Z",
    });

    const chain = [home, join(home, "secrets"), join(home, "secrets", "accounts"), dir];
    for (const level of chain) expect(fsyncs).toContain(level);
    expect(chain.map((level) => fsyncs.indexOf(level))).toEqual([...chain.map((level) => fsyncs.indexOf(level))].sort((a, b) => a - b));
    expect(readFileSync(join(dir, "auth.json"), "utf8")).toContain('"refresh_token": "r"');
  });

  test("a migration also syncs the new account directory and its parent", async () => {
    const { materializeImplicit } = await import("../../src/accounts/implicit.js");
    const { accountDir } = await import("../../src/accounts/store.js");
    const { DEFAULT_CONFIG } = await import("../../src/config.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");

    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "byok-key"), "fake-legacy-key");
    const { account } = materializeImplicit({
      nemaHome: home,
      config: { ...DEFAULT_CONFIG, authMode: "byok", byokBaseUrl: "https://a.example.com/v1" },
      codexHome: "", name: "账户", random: () => "aaaaaaaaaa",
    });

    const dir = accountDir(home, account.id);
    const accountsRoot = join(home, "secrets", "accounts");
    // The new directory's own entry is synced in its parent before the credential is committed.
    expect(fsyncs).toContain(dir);
    expect(fsyncs).toContain(accountsRoot);
    expect(fsyncs.indexOf(accountsRoot)).toBeLessThan(fsyncs.lastIndexOf(dir));
  });
});
