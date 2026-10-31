import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { writePrivateFile } from "../nativePermissions.js";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";

/**
 * Review 10: the copied credential has to be durable before the account record is committed and the
 * legacy file is removed. fsync cannot be observed from the outside, so `node:fs` is wrapped here to
 * record which path each fsync belonged to.
 *
 * The wrapper must be installed before the modules under test are imported, hence `vi.mock` + a dynamic
 * import inside the tests.
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
  root = mkdtempSync(join(tmpdir(), "nema-mig-durable-"));
  home = join(root, "nema");
  fsyncs.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config = (): NemaConfig => ({ ...DEFAULT_CONFIG, authMode: "byok", byokBaseUrl: "https://openrouter.ai/api/v1" });

describe("a copied credential is durable before the legacy file goes", () => {
  test("the credential file and its directory are fsynced before the account record is written", async () => {
    const { materializeImplicit } = await import("../../src/accounts/implicit.js");
    const { accountsPath } = await import("../../src/accounts/store.js");
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "byok-key"), "test-not-a-real-key-0000");

    const { account } = materializeImplicit({ nemaHome: home, config: config(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });
    const dir = join(home, "secrets", "accounts", account.id);

    const fileSync = fsyncs.findIndex((p) => p.startsWith(join(dir, "key.")) || p === join(dir, "key"));
    // The account directory itself is created before the copy lands, so its own entry has to be durable
    // before the record can point into it; the copy's entry is synced again after the rename.
    const firstDirSync = fsyncs.indexOf(dir);
    const lastDirSync = fsyncs.lastIndexOf(dir);
    const recordSync = fsyncs.findIndex((p) => p.startsWith(`${accountsPath(home)}.`));

    expect(fileSync).toBeGreaterThanOrEqual(0);
    expect(firstDirSync).toBeGreaterThanOrEqual(0);
    expect(recordSync).toBeGreaterThanOrEqual(0);
    // Order is the guarantee: the directory exists durably, then the bytes, then the entry, then the record
    // that points at them. Nothing after the record may depend on a rename that is still only in cache.
    expect(firstDirSync).toBeLessThan(fileSync);
    expect(lastDirSync).toBeGreaterThan(fileSync);
    expect(lastDirSync).toBeLessThan(recordSync);
    // Nothing was lost either way.
    expect(readFileSync(join(dir, "key"), "utf8")).toBe("test-not-a-real-key-0000");
  });
});

describe("the retirement is durable too (review 6)", () => {
  test("retiring the legacy file syncs nemaHome", async () => {
    const { retireLegacyFile } = await import("../../src/accounts/implicit.js");
    const { readLegacyCredential } = await import("../../src/accounts/legacy.js");
    const { accountDir } = await import("../../src/accounts/store.js");
    // Driven directly, not through `materializeImplicit`: that path also writes `accounts.json`, which syncs
    // the home for its own reasons and would make this assertion pass without the retirement sync existing.
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "byok-key"), "test-not-a-real-key-0001");
    const account = {
      id: "acct_aaaaaaaaaa", name: "账户", enabled: true, adapter: "codex-direct" as const,
      authMode: "byok" as const, baseUrl: "https://a.example.com/v1", costTier: "standard" as const,
      order: 0, createdAt: "2026-10-31T00:00:00.000Z",
    };
    // The copy is already in place, so this pass does no copying: the only directory change is the retirement.
    mkdirSync(accountDir(home, account.id), { recursive: true, mode: 0o700 });
    writePrivateFile(join(accountDir(home, account.id), "key"), "test-not-a-real-key-0001");
    const source = readLegacyCredential(home, join(home, "byok-key"));
    fsyncs.length = 0;

    const movedFrom = retireLegacyFile(home, account, source, { alreadyCopied: true });

    // The retirement renames the legacy name to a claim, then unlinks the claim: two directory changes in
    // nemaHome. Without the sync, a power cut can put the retired credential back at the legacy path, where
    // a rollback would then find it a second time.
    expect(movedFrom).toBe(join(home, "byok-key"));
    expect(fsyncs).toContain(home);
    expect(existsSync(join(home, "byok-key"))).toBe(false);
  });
});
