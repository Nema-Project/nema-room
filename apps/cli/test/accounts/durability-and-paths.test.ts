import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { materializeImplicit } from "../../src/accounts/implicit.js";
import { accountCredentialState } from "../../src/accounts/credentials.js";
import { accountDir, readAccounts } from "../../src/accounts/store.js";
import { saveAccountSecret } from "../../src/secrets/accounts.js";
import { AuthStore } from "../../src/direct/authStore.js";
import { withFileLockSync } from "../../src/direct/lock.js";
import { CodexLoginError, readCodexCliTokens } from "../../src/direct/codexLogin.js";
import { hasSymlinkedComponent } from "../../src/accounts/paths.js";
import { linkDir } from "../links.js";
import { writePrivateFile } from "../nativePermissions.js";
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

  test("a world-readable Codex auth.json is refused on POSIX", () => {
    if (process.platform === "win32") return; // Windows has no POSIX mode bits to assert on
    const codexHome = join(root, "codex-loose");
    mkdirSync(codexHome, { recursive: true });
    const file = join(codexHome, "auth.json");
    writePrivateFile(file, JSON.stringify({
      tokens: { access_token: "fake.access.token", refresh_token: "fake-refresh" },
      last_refresh: new Date().toISOString(),
    }));
    chmodSync(file, 0o644);

    // The bytes are readable, and that is exactly the problem: another user could read this login too.
    expect(() => readCodexCliTokens(codexHome)).toThrow(CodexLoginError);
    expect(() => readCodexCliTokens(codexHome)).toThrow(/私有|权限/);
  });

  test("a valid Codex login still reads", () => {
    const codexHome = join(root, "codex-ok");
    mkdirSync(codexHome, { recursive: true });
    writePrivateFile(join(codexHome, "auth.json"), JSON.stringify({
      tokens: { access_token: "fake.access.token", refresh_token: "fake-refresh", account_id: "x" },
      last_refresh: new Date().toISOString(),
    }));

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

  test("a linked directory between nemaHome and the account directory is refused (review 5)", () => {
    // The link is not the account directory itself but an ancestor of it: `nema/secrets` -> `target`. A
    // check anchored at the baseDir compares that path with itself, so the relative part is empty and only
    // the last component is looked at: this shape passed the check, and the save then created and chmod'ed
    // directories inside the link target, outside the account layout.
    const target = join(root, "target");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const nemaHome = join(root, "nema");
    mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
    linkDir(target, join(nemaHome, "secrets"));

    const baseDir = join(nemaHome, "secrets", "accounts", "acct_aaaaaaaaaa");
    expect(() => new AuthStore(nemaHome, async () => ({ access_token: "a" }), Date.now, { baseDir }))
      .toThrow(/符号链接/);
    // The link target was not touched: no account directory, no login.
    expect(existsSync(join(target, "accounts"))).toBe(false);
    expect(existsSync(join(target, "accounts", "acct_aaaaaaaaaa", "auth.json"))).toBe(false);
  });

  test("a linked accounts directory itself is refused too", () => {
    const target = join(root, "target-2");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const nemaHome = join(root, "nema-2");
    mkdirSync(join(nemaHome, "secrets"), { recursive: true, mode: 0o700 });
    linkDir(target, join(nemaHome, "secrets", "accounts"));

    const baseDir = join(nemaHome, "secrets", "accounts", "acct_aaaaaaaaaa");
    expect(() => new AuthStore(nemaHome, async () => ({ access_token: "a" }), Date.now, { baseDir }))
      .toThrow(/符号链接/);
    expect(existsSync(join(target, "acct_aaaaaaaaaa", "auth.json"))).toBe(false);
  });

  test("a directory whose name starts with two dots is still inside the home (review 6)", () => {
    // `path.relative(home, home/..foo/acct_x)` is `"..foo/acct_x"`, and a plain `startsWith("..")` test reads
    // that as "outside the home". That is a real directory name, not a parent traversal: the walk was then
    // anchored at the baseDir itself, only the last component was checked, and a linked `..foo` above the
    // account directory went unseen while the save wrote the login through the link.
    const outside = join(root, "outside-dotdot");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    const nemaHome = join(root, "nema-dotdot");
    mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
    linkDir(outside, join(nemaHome, "..foo"));

    const baseDir = join(nemaHome, "..foo", "acct_aaaaaaaaaa");
    expect(() => new AuthStore(nemaHome, async () => ({ access_token: "a" }), Date.now, { baseDir }))
      .toThrow(/符号链接/);
    // Nothing was written through the link.
    expect(existsSync(join(outside, "acct_aaaaaaaaaa"))).toBe(false);
    expect(existsSync(join(outside, "acct_aaaaaaaaaa", "auth.json"))).toBe(false);
    expect(existsSync(join(outside, "auth.json"))).toBe(false);
  });

  test("a plain directory named with a leading dots prefix is accepted, not refused", () => {
    // The containment fix above must not turn a legitimate name into an error: `..foo` is an ordinary
    // directory, and refusing it would break a home that happens to have one.
    const nemaHome = join(root, "nema-dotdot-plain");
    mkdirSync(join(nemaHome, "..foo", "acct_aaaaaaaaaa"), { recursive: true, mode: 0o700 });
    const baseDir = join(nemaHome, "..foo", "acct_aaaaaaaaaa");

    expect(hasSymlinkedComponent(nemaHome, baseDir)).toBe(false);
    expect(() => new AuthStore(nemaHome, async () => ({ access_token: "a" }), Date.now, { baseDir })).not.toThrow();
  });

  test("a linked ancestor above nemaHome is outside the walk: the home is the trust root", () => {
    // `nemaHome` itself is reached through `root/linked`, and `lstat` follows intermediate components, so the
    // home stats as a real directory. That is deliberate and matches `assertHomeNotSymlinked`: the account
    // layout is *defined relative to* nemaHome, so a linked path above it moves the whole layout rather
    // than redirecting a part of it out of the tree. Walking above the home to catch it would also refuse
    // every macOS home under `/var`, which is itself a link to `/private/var`.
    //
    // This test exists so the boundary is stated rather than assumed: what is refused is a link at or below
    // the home.
    const target = join(root, "target-3");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const linked = join(root, "linked-3");
    linkDir(target, linked);
    const nemaHome = join(linked, "nema");

    const baseDir = join(nemaHome, "secrets", "accounts", "acct_aaaaaaaaaa");
    expect(() => new AuthStore(nemaHome, async () => ({ access_token: "a" }), Date.now, { baseDir })).not.toThrow();
    // And the link below the home is still what decides: a linked `secrets/` under it is refused.
    mkdirSync(nemaHome, { recursive: true, mode: 0o700 });
    linkDir(join(target, "elsewhere"), join(nemaHome, "secrets"));
    expect(() => new AuthStore(nemaHome, async () => ({ access_token: "a" }), Date.now, { baseDir }))
      .toThrow(/符号链接/);
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
    writePrivateFile(join(home, "byok-key"), "fake-leftover-key");
    expect(accountCredentialState(home, siwc, "").state).toBe("unusable");
  });

  test("the account's own kind alone is not a conflict", () => {
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "byok-key"), "fake-key");
    const byok = account({ id: "acct_0000000000", name: "默认账户" });
    expect(accountCredentialState(home, byok, "").state).toBe("connected");
  });
});
