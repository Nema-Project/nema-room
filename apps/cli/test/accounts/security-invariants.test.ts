import { linkDir } from "../links.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { writePrivateFile } from "../nativePermissions.js";
import { materializeImplicit, syncDefaultAccountProjection, applyProjection } from "../../src/accounts/implicit.js";
import { accountCredentialFiles, accountCredentialState } from "../../src/accounts/credentials.js";
import { accountDir, accountsPath, readAccounts, updateAccounts, writeAccounts } from "../../src/accounts/store.js";
import { AccountsFileSchema, validateAccountsFile, type Account } from "../../src/accounts/schema.js";
import { readAccountSecret, removeAccountSecrets, saveAccountSecret } from "../../src/secrets/accounts.js";
import { DEFAULT_CONFIG, type NemaConfig } from "../../src/config.js";

/**
 * The invariants the account layer must keep no matter which entry point is called. These are written as
 * one file so a future change that only fixes one caller is caught here.
 */

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-accounts-sec-"));
  home = join(root, "nema");
});
afterEach(() => {
  try { chmodSync(home, 0o700); } catch { /* may not exist */ }
  rmSync(root, { recursive: true, force: true });
});

const byokConfig = (over: Partial<NemaConfig> = {}): NemaConfig => ({
  ...DEFAULT_CONFIG, authMode: "byok", byokBaseUrl: "https://openrouter.ai/api/v1", model: "vendor/model", ...over,
});
// Obviously fake, and not shaped like any provider's credential.
const FAKE = "fake-credential-value-0000";

describe("a credential never reaches a message, a log line or a stored record", () => {
  test("no error thrown by the account layer contains the credential", () => {
    const failures: string[] = [];
    const capture = (fn: () => unknown) => {
      try { fn(); } catch (e) { failures.push(String((e as Error).message)); }
    };
    // A migration that has to fail: the name is invalid, so the commit is refused after the copy.
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "byok-key"), FAKE);
    capture(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "x".repeat(41) }));
    // A second migration with a credential that is not a valid key.
    writePrivateFile(join(home, "byok-key"), `${FAKE}\n${FAKE}`);
    capture(() => materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户" }));
    // Reading and writing through the secret helpers.
    capture(() => readAccountSecret(home, "acct_aaaaaaaaaa", "key"));
    capture(() => saveAccountSecret(home, "acct_aaaaaaaaaa", "key", `${FAKE}\n${FAKE}`));
    // Validation of a record that a user pasted a key into.
    const problems = validateAccountsFile({
      version: 1,
      accounts: [{
        id: "acct_aaaaaaaaaa", name: FAKE, enabled: true, adapter: "codex-direct", authMode: "byok",
        baseUrl: "http://unsafe.example/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
      }],
      bindings: { "ws:w1": FAKE },
    } as never);
    failures.push(...problems);

    expect(failures.length).toBeGreaterThan(0);
    for (const message of failures) expect(message).not.toContain(FAKE);
  });

  test("accounts.json holds no credential field, and refuses one", () => {
    const withSecret = {
      version: 1,
      accounts: [{
        id: "acct_aaaaaaaaaa", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
        baseUrl: "https://a.example.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
        key: FAKE,
      }],
      bindings: {},
    };
    // The schema stays strict: a field that would hold a credential is not silently dropped either.
    expect(AccountsFileSchema.safeParse(withSecret).success).toBe(false);
    expect(() => writeAccounts(home, withSecret as never)).toThrow();
    expect(existsSync(accountsPath(home))).toBe(false);
  });

  test("a written accounts.json contains only metadata", () => {
    writeAccounts(home, {
      version: 1,
      accounts: [{
        id: "acct_aaaaaaaaaa", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
        baseUrl: "https://a.example.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
      }],
      bindings: {},
    });
    const raw = readFileSync(accountsPath(home), "utf8");
    expect(raw).not.toMatch(/key|token|secret|password/i);
  });
});

describe("symlinks are refused on every account path", () => {
  test("credentials read, write and delete refuse a linked home", () => {
    const realHome = join(root, "real");
    mkdirSync(join(realHome, "secrets", "accounts", "acct_aaaaaaaaaa"), { recursive: true, mode: 0o700 });
    writePrivateFile(join(realHome, "secrets", "accounts", "acct_aaaaaaaaaa", "key"), FAKE);
    const linked = join(root, "linked");
    linkDir(realHome, linked);

    expect(() => saveAccountSecret(linked, "acct_aaaaaaaaaa", "key", FAKE)).toThrow();
    expect(() => readAccountSecret(linked, "acct_aaaaaaaaaa", "key")).toThrow();
    expect(() => removeAccountSecrets(linked, "acct_aaaaaaaaaa")).toThrow();
    expect(() => accountDir(linked, "acct_aaaaaaaaaa")).toThrow();
    // The real tree is untouched.
    expect(readFileSync(join(realHome, "secrets", "accounts", "acct_aaaaaaaaaa", "key"), "utf8")).toBe(FAKE);
  });

  test("metadata read, write and update refuse a linked home", () => {
    const realHome = join(root, "real-2");
    mkdirSync(realHome, { recursive: true, mode: 0o700 });
    const linked = join(root, "linked-2");
    linkDir(realHome, linked);

    expect(readAccounts(linked)).toMatchObject({ status: "unusable", reason: "symlink" });
    expect(() => writeAccounts(linked, { version: 1, accounts: [], bindings: {} })).toThrow(/符号链接/);
    expect(() => updateAccounts(linked, () => ({ version: 1, accounts: [], bindings: {} }))).toThrow(/符号链接/);
    expect(existsSync(join(realHome, "accounts.json"))).toBe(false);
  });

  test("credential inspection refuses a linked home instead of reporting connected", () => {
    const realHome = join(root, "real-3");
    mkdirSync(realHome, { recursive: true, mode: 0o700 });
    writePrivateFile(join(realHome, "byok-key"), FAKE);
    const linked = join(root, "linked-3");
    linkDir(realHome, linked);
    const implicit: Account = {
      id: "acct_0000000000", name: "默认账户", enabled: true, adapter: "codex-direct", authMode: "byok",
      baseUrl: "https://a.example.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
    };

    expect(accountCredentialState(linked, implicit, "").state).toBe("unusable");
    expect(() => accountCredentialFiles(linked, implicit)).toThrow();
  });
});

describe("BYOK endpoints cannot be an exfiltration route", () => {
  test("a projection never writes a base URL the config would refuse", () => {
    // The projection comes from a parsed config, so it can only carry an accepted URL; assert the
    // combination of projection + validation stays consistent even for the local HTTP form.
    const account: Account = {
      id: "acct_aaaaaaaaaa", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
      baseUrl: "https://a.example.com/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
    };
    const sync = syncDefaultAccountProjection([account], byokConfig({ byokBaseUrl: "http://127.0.0.1:8080/v1" }))!;
    const merged = applyProjection(account, sync.patch);
    expect(validateAccountsFile({ version: 1, accounts: [merged], bindings: {} })).toEqual([]);
  });

  test("a stored unsafe endpoint makes the whole file unusable rather than being used", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(accountsPath(home), JSON.stringify({
      version: 1,
      accounts: [{
        id: "acct_aaaaaaaaaa", name: "A", enabled: true, adapter: "codex-direct", authMode: "byok",
        baseUrl: "http://evil.example/v1", costTier: "standard", order: 0, createdAt: "2026-10-31T00:00:00.000Z",
      }],
      bindings: {},
    }), { mode: 0o600 });

    expect(readAccounts(home)).toMatchObject({ status: "unusable", reason: "corrupt" });
  });
});

describe("a migration leaves no copy behind that nothing refers to", () => {
  test("a successful migration leaves exactly one credential copy, under the account", () => {
    mkdirSync(home, { recursive: true });
    writePrivateFile(join(home, "byok-key"), FAKE);

    const { account } = materializeImplicit({ nemaHome: home, config: byokConfig(), codexHome: "", name: "账户", random: () => "aaaaaaaaaa" });

    expect(readFileSync(join(accountDir(home, account.id), "key"), "utf8")).toBe(FAKE);
    expect(existsSync(join(home, "byok-key"))).toBe(false);
    const dirs = readdirSync(join(home, "secrets", "accounts"));
    expect(dirs).toEqual([account.id]);
    // No temp files left in the account directory or beside accounts.json.
    expect(readdirSync(join(accountDir(home, account.id)))).toEqual(["key"]);
    expect(readdirSync(home).sort()).toEqual(["accounts.json", "secrets"]);
  });
});
