import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { materializeImplicit, reconcileAccountProjection, retireLegacyFile } from "../../src/accounts/implicit.js";
import { accountDir, accountsPath, readAccounts, writeAccounts } from "../../src/accounts/store.js";
import { readLegacyCredential } from "../../src/accounts/legacy.js";
import { accountCredentialState } from "../../src/accounts/credentials.js";
import { parseStoredAuth, usableSiwcLogin } from "../../src/direct/authStore.js";
import { saveAccountSecret } from "../../src/secrets/accounts.js";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";
import type { Account } from "../../src/accounts/schema.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-cred-race-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const byokConfig = (over: Partial<NemaConfig> = {}): NemaConfig => ({
  ...DEFAULT_CONFIG, authMode: "byok", byokBaseUrl: "https://openrouter.ai/api/v1", model: "vendor/model", ...over,
});
const LEGACY = "fake-legacy-credential-0000";
const SAVED = "fake-saved-credential-1111";
const legacyKey = () => join(home, "byok-key");

function plantLegacy(value = LEGACY): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(legacyKey(), value, { mode: 0o600 });
}

const account = (over: Partial<Account> = {}): Account => ({
  id: "acct_aaaaaaaaaa", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
  baseUrl: "https://a.example.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z", ...over,
});

describe("a credential saved while the migration runs is not overwritten (review 3)", () => {
  test("the saved credential wins and the legacy file is kept", () => {
    plantLegacy();
    const created = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });
    const target = join(accountDir(home, created.account.id), "key");
    // A settings save lands after the first copy: the user typed a newer key for this account.
    saveAccountSecret(home, created.account.id, "key", SAVED);
    // A peer re-plants the legacy file, which is the situation that triggers a second retirement pass.
    plantLegacy();
    const source = readLegacyCredential(home, legacyKey());

    const movedFrom = retireLegacyFile(home, created.account, source);

    // The copy must not replace the newer credential, so the move does not complete and nothing is lost.
    expect(movedFrom).toBeNull();
    expect(readFileSync(target, "utf8")).toBe(SAVED);
    expect(readFileSync(legacyKey(), "utf8")).toBe(LEGACY);
  });

  test("the copy still succeeds when the account has no credential yet", () => {
    plantLegacy();
    const created = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });
    expect(readFileSync(join(accountDir(home, created.account.id), "key"), "utf8")).toBe(LEGACY);
    expect(existsSync(legacyKey())).toBe(false);
  });

  test("saving a credential takes the accounts lock, so it cannot interleave with a migration", () => {
    // While the lock is held (as during a migration), a save waits and then still writes its own value.
    const order: string[] = [];
    const created = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });
    order.push("migrated");
    saveAccountSecret(home, created.account.id, "key", SAVED);
    order.push("saved");
    expect(order).toEqual(["migrated", "saved"]);
    expect(readFileSync(join(accountDir(home, created.account.id), "key"), "utf8")).toBe(SAVED);
    // No lock is left behind by either operation.
    expect(existsSync(join(home, "accounts.lock"))).toBe(false);
  });
});

describe("an exposed or foreign copy is not a completed move (review 7)", () => {
  test("a world-readable copy does not retire the private legacy file", () => {
    if (process.platform === "win32") return; // synthetic mode bits
    plantLegacy();
    const created = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });
    const target = join(accountDir(home, created.account.id), "key");
    writeFileSync(target, LEGACY, { mode: 0o600 });
    // The copy is the same bytes but no longer private.
    // eslint-disable-next-line no-bitwise
    writeFileSync(target, LEGACY);
    rmSync(target);
    writeFileSync(target, LEGACY, { mode: 0o644 });
    plantLegacy();

    expect(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户" })).toThrow(/内容不同|不可用/);
    // The private legacy copy is still the only trustworthy one, so it stays.
    expect(readFileSync(legacyKey(), "utf8")).toBe(LEGACY);
  });

  test("a private owned copy is recognised as the completed move", () => {
    plantLegacy();
    const created = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });
    plantLegacy();

    const again = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户" });
    expect(again.account.id).toBe(created.account.id);
    expect(again.movedFrom).toBe(legacyKey());
    expect(existsSync(legacyKey())).toBe(false);
  });
});

describe("an unusable accounts file is an error, not 'nothing to save' (review 8)", () => {
  test("reconcileAccountProjection throws with the file path and the reason", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), "{ broken", { mode: 0o600 });

    let message = "";
    try {
      reconcileAccountProjection(home, byokConfig({ model: "m-2" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(accountsPath(home));
    expect(message).toContain("corrupt");
    // The file is untouched.
    expect(readFileSync(accountsPath(home), "utf8")).toBe("{ broken");
  });

  test("a missing file is still just 'nothing to save'", () => {
    expect(reconcileAccountProjection(home, byokConfig())).toBe(false);
  });

  test("a projection that already matches is still 'nothing to save'", () => {
    // The row must match the projection in every field it mirrors, not just the model.
    writeAccounts(home, {
      version: 1,
      accounts: [account({ model: "m-1", baseUrl: "https://openrouter.ai/api/v1" })],
      bindings: {},
    });
    expect(reconcileAccountProjection(home, byokConfig({ model: "m-1" }))).toBe(false);
  });
});

describe("a SIWC record that cannot authenticate is not 'connected' (review 5)", () => {
  const siwc = (over: Partial<Account> = {}) => account({ authMode: "siwc", baseUrl: undefined, ...over });

  test("compat mode or an empty refresh token is unusable", () => {
    mkdirSync(join(home, "secrets", "accounts", "acct_aaaaaaaaaa"), { recursive: true, mode: 0o700 });
    const file = join(accountDir(home, "acct_aaaaaaaaaa"), "auth.json");
    const record = (over: Record<string, unknown>) => JSON.stringify({
      version: 1, mode: "siwc", clientId: "oaiapp_test", tokens: { access_token: "a", refresh_token: "r" },
      lastRefresh: "2026-10-01T00:00:00.000Z", ...over,
    });

    // A valid SIWC login.
    writeFileSync(file, record({}), { mode: 0o600 });
    expect(accountCredentialState(home, siwc(), "").state).toBe("connected");

    // compat mode parses, but SIWC rejects it.
    writeFileSync(file, record({ mode: "compat" }), { mode: 0o600 });
    expect(accountCredentialState(home, siwc(), "").state).toBe("unusable");

    // No refresh token: the record cannot be refreshed.
    writeFileSync(file, record({ tokens: { access_token: "a", refresh_token: "" } }), { mode: 0o600 });
    expect(accountCredentialState(home, siwc(), "").state).toBe("unusable");
  });

  test("the shared rule is the one the migration applies", () => {
    const compat = parseStoredAuth(JSON.stringify({
      version: 1, mode: "compat", clientId: "c", tokens: { access_token: "a", refresh_token: "r" },
      lastRefresh: "2026-10-01T00:00:00.000Z",
    }))!;
    expect(usableSiwcLogin(compat)).toBe(false);
    expect(usableSiwcLogin({ ...compat, mode: "siwc" })).toBe(true);
    expect(usableSiwcLogin({ ...compat, mode: "siwc", tokens: { access_token: "a", refresh_token: "" } })).toBe(false);
  });

  test("an unusable siwc legacy login is refused by the migration", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      version: 1, mode: "compat", clientId: "c", tokens: { access_token: "a", refresh_token: "r" },
      lastRefresh: "2026-10-01T00:00:00.000Z",
    }), { mode: 0o600 });

    expect(() => materializeImplicit({
      nemaHome: home, config: { ...byokConfig(), authMode: "siwc", byokBaseUrl: undefined }, codexHome: "", name: "订阅",
    })).toThrow(/不可用|登录/);
    expect(existsSync(accountsPath(home))).toBe(false);
  });
});

describe("an inspectable-but-unreadable directory is unusable, not empty (review 6)", () => {
  test("a compat account with an unreadable home reports unusable instead of connected", async () => {
    if (process.platform === "win32") return; // permissions work differently here
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "a", refresh_token: "r", account_id: "x" }, last_refresh: new Date().toISOString(),
    }), { mode: 0o600 });
    mkdirSync(join(home, "secrets", "accounts", "acct_aaaaaaaaaa"), { recursive: true, mode: 0o700 });
    // The account directory cannot be listed or stat'ed.
    const { chmodSync } = await import("node:fs");
    chmodSync(join(home, "secrets", "accounts", "acct_aaaaaaaaaa"), 0o000);
    try {
      const compat = account({ authMode: "compat", baseUrl: undefined });
      expect(accountCredentialState(home, compat, codexHome).state).toBe("unusable");
    } finally {
      chmodSync(join(home, "secrets", "accounts", "acct_aaaaaaaaaa"), 0o700);
    }
  });
});
