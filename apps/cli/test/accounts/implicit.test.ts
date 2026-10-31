import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadAccounts, materializeImplicit, syncDefaultAccountProjection } from "../../src/accounts/implicit.js";
import { projectedAccounts } from "../../src/accounts/reconcile.js";
import { accountsPath, accountDir, readAccounts, writeAccounts } from "../../src/accounts/store.js";
import { accountCredentialState } from "../../src/accounts/credentials.js";
import { readAccountSecret } from "../../src/secrets/accounts.js";
import { IMPLICIT_ACCOUNT_ID, validateAccountsFile } from "../../src/accounts/schema.js";
import { DEFAULT_BYOK_BASE_URL, DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";

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
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });

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
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });

    const { account, movedFrom } = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "我的账户" });

    expect(account.id).not.toBe(IMPLICIT_ACCOUNT_ID);
    expect(movedFrom).toBe(join(home, "byok-key"));
    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe("fake-legacy-key");
    expect(existsSync(join(home, "byok-key"))).toBe(false);
    expect(account.name).toBe("我的账户");

    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts.map((a) => a.id)).toEqual([account.id]);
  });

  test("moves a siwc login byte for byte and the new AuthStore reads it back", () => {
    mkdirSync(home, { recursive: true });
    const stored = {
      version: 1, mode: "siwc", clientId: "oaiapp_test",
      tokens: { access_token: "access-one", refresh_token: "refresh-one" },
      lastRefresh: "2026-10-01T00:00:00.000Z",
    };
    const original = JSON.stringify(stored);
    writeFileSync(join(home, "auth.json"), original, { mode: 0o600 });

    const { account, movedFrom } = materializeImplicit({
      nemaHome: home, config: { ...byokConfig(), authMode: "siwc", byokBaseUrl: undefined, model: undefined }, codexHome, name: "订阅",
    });

    expect(movedFrom).toBe(join(home, "auth.json"));
    // The login itself must not be replaced by a different (even valid-looking) one.
    expect(readFileSync(join(accountDir(home, account.id), "auth.json"), "utf8")).toBe(original);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(accountCredentialState(home, account, codexHome).state).toBe("connected");
  });

  test("the moved key still resolves to the same account token the daemon will send", () => {
    // A migration that swapped in a different key would still look connected; compare the bytes.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-original-key", { mode: 0o600 });

    const { account } = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });

    expect(readAccountSecret(home, account.id, "key")).toBe("fake-original-key");
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

  test("a removed config model clears the stored override", () => {
    // When 0.2.0 drops `model`, the stored copy must stop applying: otherwise it keeps overriding
    // the new choice made in config.json.
    const config = { ...byokConfig(), model: undefined };
    expect(syncDefaultAccountProjection([stored()], config)).toEqual({
      accountId: "acct_abc1234567",
      patch: { model: undefined },
    });
    // Nothing left to patch once the stored value is gone.
    expect(syncDefaultAccountProjection([stored({ model: undefined })], config)).toBeNull();
  });

  test("clearing the model is visible in projectedAccounts", () => {
    const rows = projectedAccounts([stored()], { ...byokConfig(), model: undefined });
    expect(rows[0]!.model).toBeUndefined();
  });

  test("mirrors adapter and authMode too", () => {
    const patch = syncDefaultAccountProjection([stored({ authMode: "siwc", baseUrl: undefined })], byokConfig());
    expect(patch).toEqual({
      accountId: "acct_abc1234567",
      patch: { authMode: "byok", baseUrl: "https://openrouter.ai/api/v1", model: "vendor/model" },
    });
  });
});

describe("materializeImplicit hardening", () => {
  test("a failure after the move leaves no dangling state: the account file is written first", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });

    // A credential directory that cannot be created must fail the whole operation, leaving the legacy
    // file exactly where it was: the copy happens before anything is committed or removed.
    const badHome = join(root, "readonly");
    mkdirSync(join(badHome, "secrets", "accounts"), { recursive: true, mode: 0o700 });
    writeFileSync(join(badHome, "byok-key"), "fake-legacy-key", { mode: 0o600 });
    chmodSync(join(badHome, "secrets", "accounts"), 0o500);
    try {
      expect(() => materializeImplicit({ nemaHome: badHome, config: byokConfig(), codexHome, name: "x" })).toThrow();
      expect(readFileSync(join(badHome, "byok-key"), "utf8")).toBe("fake-legacy-key");
      expect(existsSync(accountsPath(badHome))).toBe(false);
    } finally {
      chmodSync(join(badHome, "secrets", "accounts"), 0o700);
    }
  });

  test("a crash between the account write and the move recovers on the next run", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });
    const now = new Date("2026-10-31T00:00:00.000Z");
    const random = () => "abcdefghij";

    // Simulate the crash: the account record is written and the credential is copied, never removed.
    const first = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户", now, random });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 }); // the "unmoved" legacy file is back
    expect(existsSync(join(accountDir(home, first.account.id), "key"))).toBe(true);

    // The next materialize sees the stored account and finishes the move instead of creating a second one.
    const second = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户", now, random });
    expect(second.account.id).toBe(first.account.id);
    expect(existsSync(join(home, "byok-key"))).toBe(false);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts).toHaveLength(1);
  });

  test("the credential is copied from the legacy path, so no cross-filesystem rename can fail", () => {
    // The move used to be a rename with an EXDEV fallback that read the wrong path. It is now always a
    // copy of the legacy file followed by a delete, which cannot raise EXDEV.
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });

    const { account, movedFrom } = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "账户" });

    expect(movedFrom).toBe(join(home, "byok-key"));
    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe("fake-legacy-key");
    expect(existsSync(join(home, "byok-key"))).toBe(false);
  });

  test("a second materialize reuses the account that already owns the legacy key", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });

    const a = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "first", random: () => "aaaaaaaaaa" });
    // A peer that raced us re-plants nothing but starts from the same legacy file; here we replay that.
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });
    const b = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "second", random: () => "bbbbbbbbbb" });

    // One credential, one account: the key is never duplicated into a second account.
    expect(b.account.id).toBe(a.account.id);
    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts.map((x) => x.id)).toEqual([a.account.id]);
  });

  test("materializing merges with accounts a peer already committed", () => {
    // No legacy file this time, so this is a plain new account: it must not replace the peer's row.
    const peer = {
      id: "acct_peer123456", name: "peer", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const,
      baseUrl: "https://peer.example.com/v1", costTier: "standard" as const, order: 0,
      createdAt: "2026-10-31T00:00:00.000Z",
    };
    writeAccounts(home, { version: 1, accounts: [peer], bindings: { "ws:w1": peer.id } });

    const { account } = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "mine", random: () => "cccccccccc" });

    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") {
      expect(stored.file.accounts.map((x) => x.id)).toEqual([peer.id, account.id]);
      // The peer's binding survives the merge.
      expect(stored.file.bindings["ws:w1"]).toBe(peer.id);
    }
  });

  test("two writers cannot drop each other's account", () => {
    // Two overlapping writers are exercised for real in accounts/lock.test.ts (two child processes, one
    // holding the lock open). This case covers the sequential path: both rows are kept and neither
    // writer's account replaces the other.
    const one = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "one", random: () => "dddddddddd" });
    const two = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "two", random: () => "eeeeeeeeee" });

    const stored = readAccounts(home);
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.file.accounts.map((a) => a.id)).toEqual([one.account.id, two.account.id]);
  });

  test("the accounts lock is released after a failed write", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });
    // A name that fails the account rules makes writeAccounts refuse; the lock must still be released so
    // the next attempt is not blocked.
    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "x".repeat(41) })).toThrow();
    expect(existsSync(join(home, "accounts.lock"))).toBe(false);

    const again = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome, name: "again" });
    expect(again.account.name).toBe("again");
  });

  test("a BYOK account without an explicit base URL still materializes", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });
    const config: NemaConfig = { ...DEFAULT_CONFIG, authMode: "byok" }; // no byokBaseUrl: the default applies

    const { account } = materializeImplicit({ nemaHome: home, config, codexHome, name: "默认地址" });

    expect(account.baseUrl).toBe(DEFAULT_BYOK_BASE_URL);
    expect(readAccounts(home).status).toBe("ok");
  });

  test("a projection that changes adapter drops the fields of the old combination", () => {
    const byokRow = {
      id: "acct_abc1234567", name: "A", enabled: true, adapter: "codex-direct" as const, authMode: "byok" as const,
      baseUrl: "https://a.example.com/v1", model: "m", costTier: "standard" as const, order: 0,
      createdAt: "2026-10-31T00:00:00.000Z",
    };
    const sync = syncDefaultAccountProjection([byokRow], { ...DEFAULT_CONFIG, adapter: "claude-code" });

    expect(sync).not.toBeNull();
    const merged = { ...byokRow, ...sync!.patch };
    // The result must satisfy the same validation a stored row does.
    expect(validateAccountsFile({ version: 1, accounts: [merged as never], bindings: {} })).toEqual([]);
    expect(merged.authMode).toBeUndefined();
    expect(merged.baseUrl).toBeUndefined();
  });
});
