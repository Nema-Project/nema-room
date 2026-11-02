import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { materializeImplicit, retireLeftoverLegacy } from "../../src/accounts/implicit.js";
import { accountDir, readAccounts, writeAccounts } from "../../src/accounts/store.js";
import { writePrivateFile } from "../nativePermissions.js";
import { DEFAULT_CONFIG, saveConfig, type NemaConfig } from "../../src/config.js";

/**
 * #206: a legacy credential whose removal gave up after the copy and the `accounts.json` write is retired by
 * a later call, but only when an account already holds exactly those bytes.
 */

/** Runs once just before the next `renameSync`: the moment a writer can replace the legacy file. */
const beforeRename: Array<() => void> = [];
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    renameSync: ((from: Parameters<typeof real.renameSync>[0], to: Parameters<typeof real.renameSync>[1]) => {
      beforeRename.shift()?.();
      return real.renameSync(from, to);
    }) as typeof real.renameSync,
  };
});

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-leftover-legacy-"));
  home = join(root, "nema");
  beforeRename.length = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const config: NemaConfig = { ...DEFAULT_CONFIG, authMode: "byok", byokBaseUrl: "https://openrouter.ai/api/v1", model: "vendor/model" };
const legacyKey = () => join(home, "byok-key");
// Obviously fake: shaped nothing like a real provider credential.
const FAKE_KEY = "test-not-a-real-key-0000";
const OTHER_KEY = "test-not-a-real-key-1111";
const plant = (value: string) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(legacyKey(), value, { mode: 0o600 });
};

/** A finished move, then the legacy file put back as a removal that gave up would have left it. */
function interruptedMove(leftover: string) {
  plant(FAKE_KEY);
  const { account } = materializeImplicit({ nemaHome: home, config, codexHome: "", name: "账户" });
  expect(existsSync(legacyKey())).toBe(false);
  plant(leftover);
  return account;
}

describe("retireLeftoverLegacy (#206)", () => {
  test("removes a legacy file whose bytes an account already holds", () => {
    const account = interruptedMove(FAKE_KEY);
    expect(retireLeftoverLegacy(home)).toEqual([legacyKey()]);
    expect(existsSync(legacyKey())).toBe(false);
    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe(FAKE_KEY);
  });

  test("keeps a legacy file that differs from every account's credential", () => {
    const account = interruptedMove(OTHER_KEY);
    expect(retireLeftoverLegacy(home)).toEqual([]);
    expect(readFileSync(legacyKey(), "utf8")).toBe(OTHER_KEY);
    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe(FAKE_KEY);
  });

  test("checks a legacy kind that config.json no longer names", () => {
    const account = interruptedMove(FAKE_KEY);
    // config.json follows the default account; after a switch it names another kind than the one migrated.
    saveConfig(home, { adapter: "codex-direct", authMode: "siwc" });
    expect(retireLeftoverLegacy(home)).toEqual([legacyKey()]);
    expect(existsSync(legacyKey())).toBe(false);
    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe(FAKE_KEY);
  });

  test("keeps the legacy file while several accounts of its kind could own it", () => {
    const first = interruptedMove(FAKE_KEY);
    const read = readAccounts(home);
    if (read.status !== "ok") throw new Error("accounts.json should be ok");
    const second = { ...first, id: "acct_second0001", name: "账户 2", order: 1 };
    writeAccounts(home, { ...read.file, accounts: [...read.file.accounts, second] });
    expect(retireLeftoverLegacy(home)).toEqual([]);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });

  test("does not wait for a busy auth.lock", () => {
    const siwc: NemaConfig = { ...DEFAULT_CONFIG, authMode: "siwc" };
    const login = JSON.stringify({
      version: 1, mode: "siwc", clientId: "oaiapp_test",
      tokens: { access_token: "fake-access", refresh_token: "rt-1" },
      lastRefresh: "2026-10-01T00:00:00.000Z",
    });
    const legacy = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    writePrivateFile(legacy, login);
    materializeImplicit({ nemaHome: home, config: siwc, codexHome: "", name: "订阅" });
    writePrivateFile(legacy, login);
    // A live process other than this one holds the lock, as a daemon mid-refresh would.
    writeFileSync(join(home, "auth.lock"), JSON.stringify({ pid: process.ppid, at: Date.now(), token: "held" }), { mode: 0o600 });
    const started = Date.now();
    expect(retireLeftoverLegacy(home)).toEqual([]);
    // Well under the 20 s wait a blocking retirement takes; Windows ACL checks alone cost a few seconds here.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(readFileSync(legacy, "utf8")).toBe(login);
  });

  test("a legacy file replaced during the cleanup is kept, and the account is not rewritten", () => {
    const account = interruptedMove(FAKE_KEY);
    beforeRename.push(() => writeFileSync(legacyKey(), OTHER_KEY, { mode: 0o600 }));
    expect(retireLeftoverLegacy(home)).toEqual([]);
    expect(readFileSync(legacyKey(), "utf8")).toBe(OTHER_KEY);
    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe(FAKE_KEY);
  });

  test("does nothing before the first migration", () => {
    plant(FAKE_KEY);
    expect(retireLeftoverLegacy(home)).toEqual([]);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });

  test("keeps the legacy file when no account of its kind exists", () => {
    plant(FAKE_KEY);
    writeAccounts(home, { version: 1, accounts: [], bindings: {} });
    expect(retireLeftoverLegacy(home)).toEqual([]);
    expect(readFileSync(legacyKey(), "utf8")).toBe(FAKE_KEY);
  });
});
