import { canSymlinkFiles } from "../links.js";
import { expectPrivate } from "../nativePermissions.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { accountCredentialFiles, accountCredentialState } from "../../src/accounts/credentials.js";
import { accountDir } from "../../src/accounts/store.js";
import { linkDir } from "../links.js";
import { IMPLICIT_ACCOUNT_ID, type Account } from "../../src/accounts/schema.js";
import { accountSecretPath, readAccountSecret, removeAccountSecrets, saveAccountSecret } from "../../src/secrets/accounts.js";

let root: string;
let home: string;
let codexHome: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-accounts-cred-"));
  home = join(root, "nema");
  codexHome = join(root, "codex");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const byok = (over: Partial<Account> = {}): Account => ({
  id: "acct_abc1234567", name: "API", enabled: true, adapter: "codex-direct", authMode: "byok",
  baseUrl: "https://api.openai.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z", ...over,
});
const siwc = (over: Partial<Account> = {}): Account => byok({ id: "acct_def1234567", name: "订阅", authMode: "siwc", baseUrl: undefined, ...over });
const compat = (over: Partial<Account> = {}): Account => byok({ id: "acct_ghi1234567", name: "Codex", authMode: "compat", baseUrl: undefined, ...over });
const claude = (over: Partial<Account> = {}): Account => byok({ id: "acct_jkl1234567", name: "Claude", adapter: "claude-code", authMode: undefined, baseUrl: undefined, ...over });
const implicit = (over: Partial<Account> = {}): Account => byok({ id: IMPLICIT_ACCOUNT_ID, name: "默认账户", ...over });

function writeCodexAuth(valid: boolean): void {
  mkdirSync(codexHome, { recursive: true });
  const body = valid
    ? JSON.stringify({ tokens: { access_token: "fake.codex.access.token", refresh_token: "r", account_id: "a" }, last_refresh: new Date().toISOString() })
    : "{}";
  writeFileSync(join(codexHome, "auth.json"), body, { mode: 0o600 });
}

describe("per-account credential files", () => {
  test("saves one line with a private directory and file", () => {
    saveAccountSecret(home, "acct_abc1234567", "key", "fake-account-key");

    expect(readAccountSecret(home, "acct_abc1234567", "key")).toBe("fake-account-key");
    expectPrivate(accountSecretPath(home, "acct_abc1234567", "key"), 0o600);
    expectPrivate(accountDir(home, "acct_abc1234567"), 0o700);
  });

  test("refuses a multi-line value and an id that is not ours", () => {
    expect(() => saveAccountSecret(home, "acct_abc1234567", "key", "a\nb")).toThrow();
    expect(() => saveAccountSecret(home, "../x", "key", "fake")).toThrow();
  });

  test("removes the whole directory, and is happy when there is nothing to remove", () => {
    saveAccountSecret(home, "acct_abc1234567", "key", "fake-account-key");
    removeAccountSecrets(home, "acct_abc1234567");
    expect(existsSync(accountDir(home, "acct_abc1234567"))).toBe(false);
    expect(() => removeAccountSecrets(home, "acct_abc1234567")).not.toThrow();
  });
});

describe("credential state per account kind", () => {
  test("byok reads its key", () => {
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("missing");
    saveAccountSecret(home, "acct_abc1234567", "key", "fake-account-key");
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("connected");
  });

  test("a file anyone can read is unusable, not missing", () => {
    if (process.platform === "win32") return;
    saveAccountSecret(home, "acct_abc1234567", "key", "fake-account-key");
    chmodSync(accountSecretPath(home, "acct_abc1234567", "key"), 0o644);
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");
  });

  test.runIf(canSymlinkFiles)("a symlinked key is unusable", () => {
    mkdirSync(accountDir(home, "acct_abc1234567"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "target"), "fake");
    symlinkSync(join(root, "target"), accountSecretPath(home, "acct_abc1234567", "key"));
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");
  });

  test("claude-code accounts read a token, not a key", () => {
    // The key file alone is not a Claude Code login, and having both kinds is ambiguous (spec §3.2).
    saveAccountSecret(home, "acct_jkl1234567", "key", "not-used");
    expect(accountCredentialState(home, claude(), codexHome).state).toBe("unusable");

    removeAccountSecrets(home, "acct_jkl1234567");
    expect(accountCredentialState(home, claude(), codexHome).state).toBe("missing");
    saveAccountSecret(home, "acct_jkl1234567", "token", "tok");
    expect(accountCredentialState(home, claude(), codexHome).state).toBe("connected");
  });

  test("two kinds of credential in one directory is unusable", () => {
    saveAccountSecret(home, "acct_abc1234567", "key", "fake");
    saveAccountSecret(home, "acct_abc1234567", "token", "tok");
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");
  });

  test("compat owns no files and reads the Codex login instead", () => {
    expect(accountCredentialFiles(home, compat())).toEqual([]);
    expect(accountCredentialState(home, compat(), codexHome).state).toBe("missing");
    writeCodexAuth(true);
    expect(accountCredentialState(home, compat(), codexHome).state).toBe("connected");
    expect(existsSync(accountDir(home, "acct_ghi1234567"))).toBe(false);
  });

  test("the implicit account reads the old single-key paths", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "byok-key"), "fake-legacy-key", { mode: 0o600 });

    expect(accountCredentialFiles(home, implicit())).toEqual([join(home, "byok-key")]);
    expect(accountCredentialState(home, implicit(), codexHome).state).toBe("connected");
    // The reserved id has no credential directory at all: it only ever names the legacy paths.
    expect(() => accountDir(home, IMPLICIT_ACCOUNT_ID)).toThrow(/保留/);
  });

  test("the implicit siwc account reads the old auth.json", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), "{}", { mode: 0o600 });
    expect(accountCredentialFiles(home, implicit({ authMode: "siwc", baseUrl: undefined }))).toEqual([join(home, "auth.json")]);
    // "{}" is not a stored login, so it reads unusable rather than connected.
    expect(accountCredentialState(home, implicit({ authMode: "siwc", baseUrl: undefined }), codexHome).state).toBe("unusable");
  });

  test("an empty or malformed key file is unusable, not connected", () => {
    mkdirSync(accountDir(home, "acct_abc1234567"), { recursive: true, mode: 0o700 });
    const file = accountSecretPath(home, "acct_abc1234567", "key");
    writeFileSync(file, "", { mode: 0o600 });
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");

    // Two lines is not a key either: readAccountSecret would reject it when used.
    writeFileSync(file, "first\nsecond", { mode: 0o600 });
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");

    // Control characters leak into HTTP headers, so they are invalid too.
    writeFileSync(file, "fake\u0000x", { mode: 0o600 });
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");

    writeFileSync(file, "fake-valid-key", { mode: 0o600 });
    expect(accountCredentialState(home, byok(), codexHome).state).toBe("connected");
  });

  test("a credential file owned by another user is unusable", () => {
    if (process.platform === "win32") return;
    saveAccountSecret(home, "acct_abc1234567", "key", "fake-account-key");
    const real = process.getuid?.() ?? 0;
    const spy = vi.spyOn(process, "getuid").mockReturnValue(real + 1);
    try {
      expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");
    } finally {
      spy.mockRestore();
    }
  });

  test("compat reports a conflicting local credential instead of connected", () => {
    writeCodexAuth(true);
    // A leftover key file in the account's directory means the account cannot be trusted as compat.
    saveAccountSecret(home, "acct_ghi1234567", "key", "fake-leftover");
    expect(accountCredentialState(home, compat(), codexHome).state).toBe("unusable");
  });

  test("compat distinguishes an unusable Codex login from a missing one", () => {
    expect(accountCredentialState(home, compat(), codexHome).state).toBe("missing");

    // Present but unreadable: the file exists, so this is not "missing".
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), "{ broken", { mode: 0o600 });
    expect(accountCredentialState(home, compat(), codexHome).state).toBe("unusable");

    // Present but with no tokens.
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }), { mode: 0o600 });
    expect(accountCredentialState(home, compat(), codexHome).state).toBe("unusable");

    writeCodexAuth(true);
    expect(accountCredentialState(home, compat(), codexHome).state).toBe("connected");
  });

  test("a symlinked account directory is unusable rather than followed", () => {
    const target = join(root, "redirect");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, "key"), "fake-elsewhere", { mode: 0o600 });
    mkdirSync(join(home, "secrets", "accounts"), { recursive: true, mode: 0o700 });
    linkDir(target, join(home, "secrets", "accounts", "acct_abc1234567"));

    expect(accountCredentialState(home, byok(), codexHome).state).toBe("unusable");
  });

  test.runIf(canSymlinkFiles)("an implicit account under a symlinked home is unusable, not connected", () => {
    // The account store refuses a linked home; reporting "connected" through it would claim a credential
    // the rest of the account code will never use.
    const realHome = join(root, "real-home");
    mkdirSync(realHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(realHome, "byok-key"), "fake-legacy-key", { mode: 0o600 });
    const linkedHome = join(root, "linked-home");
    linkDir(realHome, linkedHome);

    expect(() => accountCredentialFiles(linkedHome, implicit())).toThrow(/符号链接/);
    const state = accountCredentialState(linkedHome, implicit(), codexHome);
    expect(state.state).toBe("unusable");
    expect(state.files).toEqual([]);
  });

  test.runIf(canSymlinkFiles)("an implicit siwc account under a linked home is unusable too", () => {
    const realHome = join(root, "real-home-2");
    mkdirSync(realHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(realHome, "auth.json"), "{}", { mode: 0o600 });
    const linkedHome = join(root, "linked-home-2");
    linkDir(realHome, linkedHome);

    const account = implicit({ authMode: "siwc", baseUrl: undefined });
    expect(() => accountCredentialFiles(linkedHome, account)).toThrow(/符号链接/);
    expect(accountCredentialState(linkedHome, account, codexHome).state).toBe("unusable");
  });

  test("states never carry a credential value", () => {
    saveAccountSecret(home, "acct_abc1234567", "key", "fake-super-secret");
    const result = accountCredentialState(home, byok(), codexHome);
    expect(JSON.stringify(result)).not.toContain("fake-super-secret");
    expect(readFileSync(accountSecretPath(home, "acct_abc1234567", "key"), "utf8")).toBe("fake-super-secret");
  });
});
