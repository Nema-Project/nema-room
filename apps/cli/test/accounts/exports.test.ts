import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as localSettings from "../../src/localSettings.js";
import { reconcileDefaultAccount } from "../../src/accounts/reconcile.js";
import { accountsPath, readAccounts, writeAccounts } from "../../src/accounts/store.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { Account } from "../../src/accounts/schema.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-accounts-exports-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const account = (over: Partial<Account> = {}): Account => ({
  id: "acct_abc1234567", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
  baseUrl: "https://a.example.com/v1", model: "m-1", costTier: "standard", order: 0,
  createdAt: "2026-10-31T00:00:00.000Z", ...over,
});

describe("localSettings exports", () => {
  test("exposes every accounts helper the settings service needs", () => {
    for (const name of [
      "IMPLICIT_ACCOUNT_ID", "COST_TIERS", "newAccountId", "accountNameProblem", "validateAccountsFile",
      "accountsPath", "accountDir", "readAccounts", "writeAccounts",
      "loadAccounts", "materializeImplicit", "syncDefaultAccountProjection",
      "accountCredentialState", "accountCredentialFiles",
      "saveAccountSecret", "readAccountSecret", "removeAccountSecrets",
    ] as const) {
      expect(localSettings).toHaveProperty(name);
    }
  });
});

describe("reconcileDefaultAccount", () => {
  test("writes the projection into the default account and never into config.json", () => {
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const configPath = join(home, "config.json");
    writeFileSync(configPath, JSON.stringify({ ...DEFAULT_CONFIG, authMode: "byok", model: "from-0.2.0" }), { mode: 0o600 });
    const configBefore = readFileSync(configPath, "utf8");

    const changed = reconcileDefaultAccount(home, { ...DEFAULT_CONFIG, authMode: "byok", model: "from-0.2.0" });

    expect(changed).toBe(true);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts[0]!.model).toBe("from-0.2.0");
    // D-6: config.json is never rewritten by this path.
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
  });

  test("is a no-op when there is nothing to reconcile", () => {
    writeAccounts(home, { version: 1, accounts: [account({ model: "m-1" })], bindings: {} });
    const before = readFileSync(accountsPath(home), "utf8");

    expect(reconcileDefaultAccount(home, { ...DEFAULT_CONFIG, authMode: "byok", model: "m-1" })).toBe(false);
    expect(readFileSync(accountsPath(home), "utf8")).toBe(before);
  });

  test("does nothing when accounts.json does not exist", () => {
    expect(reconcileDefaultAccount(home, { ...DEFAULT_CONFIG, model: "m" })).toBe(false);
  });
});
