import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
    writeFileSync(join(home, "byok-key"), "test-not-a-real-key-0000", { mode: 0o600 });

    const { account } = materializeImplicit({ nemaHome: home, config: config(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });
    const dir = join(home, "secrets", "accounts", account.id);

    const fileSync = fsyncs.findIndex((p) => p.startsWith(join(dir, "key.")) || p === join(dir, "key"));
    const dirSync = fsyncs.findIndex((p) => p === dir);
    const recordSync = fsyncs.findIndex((p) => p.startsWith(`${accountsPath(home)}.`));

    expect(fileSync).toBeGreaterThanOrEqual(0);
    expect(dirSync).toBeGreaterThanOrEqual(0);
    expect(recordSync).toBeGreaterThanOrEqual(0);
    // Order is the guarantee: file bytes, then the directory entry, then the record that points at them.
    expect(fileSync).toBeLessThan(dirSync);
    expect(dirSync).toBeLessThan(recordSync);
    // Nothing was lost either way.
    expect(readFileSync(join(dir, "key"), "utf8")).toBe("test-not-a-real-key-0000");
  });
});
