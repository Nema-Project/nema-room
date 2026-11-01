import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { materializeImplicit, retireLeftoverLegacy } from "../../src/accounts/implicit.js";
import { accountDir, writeAccounts } from "../../src/accounts/store.js";
import { DEFAULT_CONFIG, saveConfig, type NemaConfig } from "../../src/config.js";

/**
 * #206: a legacy credential whose removal gave up after the copy and the `accounts.json` write is retired by
 * a later call, but only when an account already holds exactly those bytes.
 */

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-leftover-legacy-"));
  home = join(root, "nema");
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
