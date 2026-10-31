import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { materializeImplicit } from "../../src/accounts/implicit.js";
import { accountCredentialState } from "../../src/accounts/credentials.js";
import { accountDir, readAccounts } from "../../src/accounts/store.js";
import { saveAccountSecret } from "../../src/secrets/accounts.js";
import { AuthStore } from "../../src/direct/authStore.js";
import { withFileLockSync } from "../../src/direct/lock.js";
import { readCodexCliTokens } from "../../src/direct/codexLogin.js";
import { linkDir } from "../links.js";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";
import type { Account } from "../../src/accounts/schema.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-durable-paths-"));
  home = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const byokConfig = (over: Partial<NemaConfig> = {}): NemaConfig => ({
  ...DEFAULT_CONFIG, authMode: "byok", byokBaseUrl: "https://openrouter.ai/api/v1", ...over,
});
const account = (over: Partial<Account> = {}): Account => ({
  id: "acct_aaaaaaaaaa", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
  baseUrl: "https://a.example.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z", ...over,
});

describe("a Codex login is read only when it is private (review 5)", () => {
  test("a symlinked Codex auth.json is refused", () => {
    const codexHome = join(root, "codex");
    mkdirSync(codexHome, { recursive: true });
    const real = join(root, "elsewhere.json");
    writeFileSync(real, JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }), { mode: 0o600 });
    try {
      const { symlinkSync } = require("node:fs") as typeof import("node:fs");
      symlinkSync(real, join(codexHome, "auth.json"));
    } catch {
      return; // no file symlinks on this host
    }

    expect(() => readCodexCliTokens(codexHome)).toThrow(/符号链接|无法读取/);
  });

  test("a valid Codex login still reads", () => {
    const codexHome = join(root, "codex-ok");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "fake.access.token", refresh_token: "fake-refresh", account_id: "x" },
      last_refresh: new Date().toISOString(),
    }), { mode: 0o600 });

    expect(readCodexCliTokens(codexHome).refreshToken).toBe("fake-refresh");
  });
});

describe("AuthStore refuses a linked baseDir (review 6)", () => {
  test("constructing a store over a symlinked account directory throws", () => {
    const realAccount = join(root, "real-account");
    mkdirSync(realAccount, { recursive: true, mode: 0o700 });
    const linked = join(root, "linked-account");
    linkDir(realAccount, linked);

    expect(() => new AuthStore(home, async () => ({ access_token: "a" }), Date.now, { baseDir: linked }))
      .toThrow(/符号链接/);
    // The link target was not touched.
    expect(existsSync(join(realAccount, "auth.json"))).toBe(false);
  });

  test("a real account directory is still accepted", () => {
    const dir = join(root, "plain");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    expect(() => new AuthStore(home, async () => ({ access_token: "a" }), Date.now, { baseDir: dir })).not.toThrow();
  });
});

describe("another legacy credential kind makes the synthesized account unusable (review 7)", () => {
  test("byok-key beside auth.json is a conflict", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({
      version: 1, mode: "siwc", clientId: "c", tokens: { access_token: "a", refresh_token: "rt" },
      lastRefresh: "2026-10-01T00:00:00.000Z",
    }), { mode: 0o600 });
    const siwc = account({ id: "acct_0000000000", authMode: "siwc", baseUrl: undefined, name: "默认账户" });
    expect(accountCredentialState(home, siwc, "").state).toBe("connected");

    // A leftover key from the mode the user switched away from: ambiguous, so neither is trusted.
    writeFileSync(join(home, "byok-key"), "fake-leftover-key", { mode: 0o600 });
    expect(accountCredentialState(home, siwc, "").state).toBe("unusable");
  });

  test("the account's own kind alone is not a conflict", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-key", { mode: 0o600 });
    const byok = account({ id: "acct_0000000000", name: "默认账户" });
    expect(accountCredentialState(home, byok, "").state).toBe("connected");
  });
});
