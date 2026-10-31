import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadAccounts, materializeImplicit, syncDefaultAccountProjection } from "../../src/accounts/implicit.js";
import { accountsPath, accountDir, readAccounts, writeAccounts } from "../../src/accounts/store.js";
import { accountCredentialState } from "../../src/accounts/credentials.js";
import { IMPLICIT_ACCOUNT_ID } from "../../src/accounts/schema.js";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";

let root: string;
let home: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-accounts-implicit-"));
  home = join(root, "nema");
  codexHome = join(root, "codex");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const byokConfig = (over: Partial<NemaConfig> = {}): NemaConfig => ({
  ...DEFAULT_CONFIG,
  authMode: "byok",
  byokBaseUrl: "https://openrouter.ai/api/v1",
  model: "vendor/model",
  ...over,
});

describe("loadAccounts without accounts.json", () => {
  test("synthesizes one account from config and writes nothing to disk", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "sk-legacy", { mode: 0o600 });

    const loaded = loadAccounts(home, byokConfig(), codexHome);

    expect(loaded.implicit).toBe(true);
    expect(loaded.accounts).toHaveLength(1);
    const [account] = loaded.accounts;
    expect(account!.id).toBe(IMPLICIT_ACCOUNT_ID);
    expect(account!.name).toBe("默认账户");
    expect(account!.adapter).toBe("codex-direct");
    expect(account!.authMode).toBe("byok");
    expect(account!.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(account!.model).toBe("vendor/model");
    expect(account!.enabled).toBe(true);
    expect(account!.costTier).toBe("standard");
    expect(account!.order).toBe(0);
    expect(accountCredentialState(home, account!, codexHome).state).toBe("connected");

    // D-6: nothing new lands on disk until the user edits an account.
    expect(existsSync(accountsPath(home))).toBe(false);
    expect(existsSync(join(home, "secrets"))).toBe(false);
  });

  test("carries the unusable reason through when the file cannot be trusted", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), "{ broken", { mode: 0o600 });

    const loaded = loadAccounts(home, byokConfig(), codexHome);

    expect(loaded.implicit).toBe(true);
    expect(loaded.unusableReason).toBe("corrupt");
    expect(loaded.accounts[0]!.id).toBe(IMPLICIT_ACCOUNT_ID);
  });

  test("returns the stored accounts when the file is usable", () => {
    writeAccounts(home, {
      version: 1,
      accounts: [{
        id: "acct_abc1234567", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
        baseUrl: "https://a.example.com/v1", costTier: "low", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
      }],
      bindings: { "ws:w1": "acct_abc1234567" },
    });

    const loaded = loadAccounts(home, byokConfig(), codexHome);

    expect(loaded.implicit).toBe(false);
    expect(loaded.accounts.map((a) => a.id)).toEqual(["acct_abc1234567"]);
  });
});

describe("materializeImplicit", () => {
  test("moves the byok key into the new account directory and stops using the old path", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "sk-legacy", { mode: 0o600 });

    const { account, movedFrom } = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "我的账户" });

    expect(account.id).not.toBe(IMPLICIT_ACCOUNT_ID);
    expect(movedFrom).toBe(join(home, "byok-key"));
    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe("sk-legacy");
    expect(existsSync(join(home, "byok-key"))).toBe(false);
    expect(account.name).toBe("我的账户");

    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts.map((a) => a.id)).toEqual([account.id]);
  });

  test("moves a siwc login and the new AuthStore reads it back", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      version: 1, mode: "siwc", clientId: "oaiapp_test",
      tokens: { access_token: "a", refresh_token: "r" },
      lastRefresh: "2026-10-01T00:00:00.000Z",
    }), { mode: 0o600 });

    const { account, movedFrom } = materializeImplicit({
      nemaHome: home, config: { ...byokConfig(), authMode: "siwc", byokBaseUrl: undefined, model: undefined }, codexHome, name: "订阅",
    });

    expect(movedFrom).toBe(join(home, "auth.json"));
    expect(existsSync(join(accountDir(home, account.id), "auth.json"))).toBe(true);
    expect(accountCredentialState(home, account, codexHome).state).toBe("connected");
  });

  test("leaves the Codex login alone for compat", () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "a", refresh_token: "r", account_id: "x" }, last_refresh: new Date().toISOString(),
    }), { mode: 0o600 });
    const config: NemaConfig = { ...DEFAULT_CONFIG, authMode: "compat" };

    const { account, movedFrom } = materializeImplicit({ nemaHome: home, config, codexHome, name: "Codex" });

    expect(movedFrom).toBeNull();
    expect(account.authMode).toBe("compat");
    expect(existsSync(join(codexHome, "auth.json"))).toBe(true);
    expect(accountCredentialState(home, account, codexHome).state).toBe("connected");
  });

  test("does not fail when the old credential is not there", () => {
    const { account, movedFrom } = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "空" });

    expect(movedFrom).toBeNull();
    expect(account.id).toMatch(/^acct_[a-z0-9]{10}$/);
    expect(accountCredentialState(home, account, codexHome).state).toBe("missing");
  });
});

describe("syncDefaultAccountProjection", () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: "acct_abc1234567", name: "A", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const,
    baseUrl: "https://openrouter.ai/api/v1", model: "m-1", costTier: "standard" as const, order: 0,
    createdAt: "2026-10-31T00:00:00.000Z", ...over,
  });

  test("an old version's model change wins over the stored account", () => {
    // D-6: after a rollback the projection is what the user last chose, so the account follows it.
    expect(syncDefaultAccountProjection([stored()], byokConfig({ model: "m-2" })))
      .toEqual({ accountId: "acct_abc1234567", patch: { model: "m-2" } });
  });

  test("null when the projection already matches", () => {
    expect(syncDefaultAccountProjection([stored()], byokConfig({ model: "m-1" }))).toBeNull();
  });

  test("a changed base URL travels with the model", () => {
    expect(syncDefaultAccountProjection([stored()], byokConfig({ model: "m-1", byokBaseUrl: "https://b.example.com/v1" })))
      .toEqual({ accountId: "acct_abc1234567", patch: { baseUrl: "https://b.example.com/v1" } });
  });

  test("uses the lowest enabled account, not the first row", () => {
    const accounts = [stored({ order: 5, model: "late" }), stored({ id: "acct_def1234567", name: "B", order: 1, model: "early" })];
    // The patch targets the lowest-order account and carries the projection's value, not the reverse.
    expect(syncDefaultAccountProjection(accounts, byokConfig({ model: "from-config" })))
      .toEqual({ accountId: "acct_def1234567", patch: { model: "from-config" } });
  });

  test("skips disabled accounts and reports nothing when all are disabled", () => {
    expect(syncDefaultAccountProjection([stored({ enabled: false })], byokConfig({ model: "m-2" }))).toBeNull();
  });

  test("mirrors adapter and authMode too", () => {
    const patch = syncDefaultAccountProjection([stored({ authMode: "siwc", baseUrl: undefined })], byokConfig());
    expect(patch).toEqual({
      accountId: "acct_abc1234567",
      patch: { authMode: "byok", baseUrl: "https://openrouter.ai/api/v1", model: "vendor/model" },
    });
  });
});
