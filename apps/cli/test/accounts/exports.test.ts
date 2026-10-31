import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as localSettings from "../../src/localSettings.js";
import { projectedAccounts, projectionDiffers } from "../../src/accounts/reconcile.js";
import { reconcileAccountProjection } from "../../src/accounts/implicit.js";
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
      "accountsPath", "accountDir", "readAccounts", "writeAccounts", "updateAccounts", "withAccountsLock",
      "loadAccounts", "materializeImplicit", "syncDefaultAccountProjection", "applyProjection", "reconcileAccountProjection",
      "projectedAccounts", "projectionDiffers",
      "accountCredentialState", "accountCredentialFiles",
      "saveAccountSecret", "readAccountSecret", "removeAccountSecrets",
    ] as const) {
      expect(localSettings).toHaveProperty(name);
    }
  });
});

describe("projection is read-only until the user edits", () => {
  test("projectedAccounts returns the reconciled rows without writing anything", () => {
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const before = readFileSync(accountsPath(home), "utf8");

    const rows = projectedAccounts([account()], { ...DEFAULT_CONFIG, authMode: "byok", model: "from-0.2.0" });

    expect(rows[0]!.model).toBe("from-0.2.0");
    // D-6: reading never writes; the file is byte-identical afterwards.
    expect(readFileSync(accountsPath(home), "utf8")).toBe(before);
  });

  test("projectionDiffers reports whether the settings page would need to save", () => {
    // The stored row must already match the projection's endpoint too, or it differs for that reason.
    writeAccounts(home, { version: 1, accounts: [account({ model: "m-1", baseUrl: "https://a.example.com/v1" })], bindings: {} });

    expect(projectionDiffers(home, { ...DEFAULT_CONFIG, authMode: "byok", model: "m-1", byokBaseUrl: "https://a.example.com/v1" })).toBe(false);
    expect(projectionDiffers(home, { ...DEFAULT_CONFIG, authMode: "byok", model: "m-2" })).toBe(true);
  });

  test("projectionDiffers is false when there is no accounts file", () => {
    expect(projectionDiffers(home, { ...DEFAULT_CONFIG, model: "m" })).toBe(false);
  });

  test("reconcileAccountProjection is the explicit save: only it writes", () => {
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });

    expect(reconcileAccountProjection(home, { ...DEFAULT_CONFIG, authMode: "byok", model: "saved" })).toBe(true);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts[0]!.model).toBe("saved");
    // A second call has nothing left to do.
    expect(reconcileAccountProjection(home, { ...DEFAULT_CONFIG, authMode: "byok", model: "saved" })).toBe(false);
  });

  test("a claude-code projection drops the fields of the byok combination", () => {
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });

    expect(reconcileAccountProjection(home, { ...DEFAULT_CONFIG, adapter: "claude-code" })).toBe(true);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") {
      expect(stored.file.accounts[0]!.adapter).toBe("claude-code");
      expect(stored.file.accounts[0]!.authMode).toBeUndefined();
      expect(stored.file.accounts[0]!.baseUrl).toBeUndefined();
    }
  });
});
