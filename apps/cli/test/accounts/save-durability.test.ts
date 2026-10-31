import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

  test("a migration also syncs the new account directory and its parent", async () => {
    const { materializeImplicit } = await import("../../src/accounts/implicit.js");
    const { accountDir } = await import("../../src/accounts/store.js");
    const { DEFAULT_CONFIG } = await import("../../src/config.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");

    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });
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
