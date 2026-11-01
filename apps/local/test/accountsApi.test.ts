import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { handleAccounts, resetAccountsJobs, type AccountView, type AccountsDeps } from "../src/accountsApi.js";
import { IMPLICIT_ACCOUNT_ID, accountsPath, readAccounts, writeAccounts } from "@nema/cli/localSettings";
import { loadConfig, saveConfig } from "@nema/cli/config";
import type { Account } from "@nema/cli/localSettings";

/**
 * The accounts settings API. Every test uses a temporary `nemaHome`; nothing touches the network, the real
 * `~/.nema`, `~/.codex` or `~/.claude`.
 */

const roots: string[] = [];
function tempHome(): string {
  const root = mkdtempSync(path.join(tmpdir(), "nema-accounts-api-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  resetAccountsJobs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const account = (over: Partial<Account> = {}): Account => ({
  id: "acct_abc1234567",
  name: "A",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://a.example.com/v1",
  costTier: "standard",
  order: 0,
  createdAt: "2026-10-31T00:00:00.000Z",
  ...over,
});

function deps(home: string, over: Partial<AccountsDeps> = {}): AccountsDeps {
  return {
    home,
    codexHome: path.join(home, "no-codex"),
    // The route that starts a browser login is injected, so no test opens a browser.
    login: async () => ({ ok: true }),
    ...over,
  };
}

const call = (home: string, method: string, pathname: string, body?: unknown, over: Partial<AccountsDeps> = {}) =>
  handleAccounts(method, pathname, body, deps(home, over));

describe("GET /_nema/accounts", () => {
  test("lists the synthesized account when accounts.json does not exist", () => {
    const home = tempHome();
    saveConfig(home, { adapter: "codex-direct", authMode: "byok", byokBaseUrl: "https://a.example.com/v1" });
    const reply = call(home, "GET", "/_nema/accounts");
    expect(reply?.status).toBe(200);
    const body = reply!.body as { accounts: AccountView[]; defaultAccountId: string; bindings: Record<string, string> };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({ id: IMPLICIT_ACCOUNT_ID, implicit: true, name: "默认账户" });
    expect(body.accounts[0]!.credential).toBe("missing");
    // Reading a synthesized account must not create the file (D-6).
    expect(readAccounts(home).status).toBe("missing");
  });

  test("never returns a credential value, even when one is stored", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const secret = "sk-not-in-any-response-0123456789";
    const saved = call(home, "POST", "/_nema/accounts/secret", { id: account().id, kind: "byok", value: secret });
    expect(saved?.status).toBe(200);
    const reply = call(home, "GET", "/_nema/accounts");
    expect(JSON.stringify(reply!.body)).not.toContain(secret);
    expect(JSON.stringify(reply!.body)).not.toContain("sk-");
  });

  test("reports the stored bindings so a picker can show the current choice", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: { "ws:ws_1": account().id } });
    const body = call(home, "GET", "/_nema/accounts")!.body as { bindings: Record<string, string> };
    expect(body.bindings).toEqual({ "ws:ws_1": account().id });
  });

  test("omits the list when the file is unusable, and says why", () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    // A world-readable file is not a file this store trusts.
    const file = accountsPath(home);
    writeFileSync(file, JSON.stringify({ version: 1, accounts: [], bindings: {} }), { mode: 0o644 });
    const body = call(home, "GET", "/_nema/accounts")!.body as { accounts?: unknown; unusableReason?: string };
    expect(body.accounts).toBeUndefined();
    expect(body.unusableReason).toBe("mode");
  });
});

describe("POST /_nema/accounts", () => {
  test("creates a second account and materializes the synthesized one", () => {
    const home = tempHome();
    saveConfig(home, { adapter: "codex-direct", authMode: "siwc" });
    const reply = call(home, "POST", "/_nema/accounts", {
      name: "Work",
      adapter: "codex-direct",
      authMode: "byok",
      baseUrl: "https://w.example.com/v1",
      costTier: "low",
    });
    expect(reply?.status).toBe(201);
    const created = (reply!.body as { account: AccountView }).account;
    expect(created).toMatchObject({ name: "Work", costTier: "low", enabled: true, implicit: false });
    const list = call(home, "GET", "/_nema/accounts")!.body as { accounts: AccountView[]; defaultAccountId: string };
    expect(list.accounts).toHaveLength(2);
    // The synthesized account becomes a real row so the user can edit it later.
    expect(list.accounts.some((a) => a.implicit)).toBe(false);
    expect(list.accounts.map((a) => a.name)).toContain("默认账户");
    expect(readAccounts(home).status).toBe("ok");
  });

  test("refuses a duplicate name regardless of case", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account({ name: "OpenAI" })], bindings: {} });
    const reply = call(home, "POST", "/_nema/accounts", { name: "openai", adapter: "codex-direct", authMode: "byok", baseUrl: "https://b.example.com/v1" });
    expect(reply?.status).toBe(409);
    expect(reply!.body).toEqual({ error: "account_exists" });
  });

  test.each([
    ["a byok account without a base URL", { name: "B", adapter: "codex-direct", authMode: "byok" }],
    ["a codex-direct account without an auth mode", { name: "B", adapter: "codex-direct" }],
    ["a claude-code account with an auth mode", { name: "B", adapter: "claude-code", authMode: "siwc" }],
    ["a name that looks like a key", { name: "sk-abcdefghijklmnopqrstuvwxyz", adapter: "claude-code" }],
    ["an unknown field", { name: "B", adapter: "claude-code", key: "x" }],
    ["a cost tier outside the three", { name: "B", adapter: "claude-code", costTier: "cheap" }],
  ])("refuses %s", (_label, payload) => {
    const home = tempHome();
    const reply = call(home, "POST", "/_nema/accounts", payload);
    expect(reply?.status).toBe(400);
    expect(reply!.body).toEqual({ error: "invalid_request" });
  });
});

describe("PATCH /_nema/accounts", () => {
  test("renames an account and keeps its id", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account({ name: "Old" })], bindings: {} });
    const reply = call(home, "PATCH", "/_nema/accounts", { id: account().id, name: "New name" });
    expect(reply?.status).toBe(200);
    expect((reply!.body as { account: AccountView }).account).toMatchObject({ id: account().id, name: "New name" });
  });

  test("refuses a rename that collides with another account", () => {
    const home = tempHome();
    writeAccounts(home, {
      version: 1,
      accounts: [account({ id: "acct_aaaaaaaaaa", name: "One" }), account({ id: "acct_bbbbbbbbbb", name: "Two" })],
      bindings: {},
    });
    const reply = call(home, "PATCH", "/_nema/accounts", { id: "acct_bbbbbbbbbb", name: "one" });
    expect(reply?.status).toBe(409);
    expect(reply!.body).toEqual({ error: "account_exists" });
  });

  test("refuses an edit that would leave an invalid combination", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    // byok without a base URL cannot be stored.
    const reply = call(home, "PATCH", "/_nema/accounts", { id: account().id, baseUrl: null });
    expect(reply?.status).toBe(400);
    expect(reply!.body).toEqual({ error: "invalid_request" });
  });

  test("refuses an edit that disables the last enabled account", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    // Deleting it is refused; disabling it reaches the same state (no default) by another route.
    const reply = call(home, "PATCH", "/_nema/accounts", { id: account().id, enabled: false });
    expect(reply?.status).toBe(400);
    expect(reply!.body).toEqual({ error: "invalid_request" });
    const after = readAccounts(home);
    expect(after.status === "ok" && after.file.accounts[0]!.enabled).toBe(true);
  });

  test("allows disabling an account while another one stays enabled", () => {
    const home = tempHome();
    writeAccounts(home, {
      version: 1,
      accounts: [account(), account({ id: "acct_bbbbbbbbbb", name: "Two", order: 1 })],
      bindings: {},
    });
    const reply = call(home, "PATCH", "/_nema/accounts", { id: account().id, enabled: false });
    expect(reply?.status).toBe(200);
    expect((reply!.body as { account: AccountView }).account.enabled).toBe(false);
  });

  test("refuses an edit on the synthesized account's id when no file exists", () => {
    const home = tempHome();
    const reply = call(home, "PATCH", "/_nema/accounts", { id: IMPLICIT_ACCOUNT_ID, name: "Mine" });
    // The synthesized row has no stored id to address; the UI renames it by materializing first.
    expect(reply?.status).toBe(404);
    expect(reply!.body).toEqual({ error: "not_found" });
  });
});

describe("DELETE /_nema/accounts", () => {
  test("refuses to delete an account a scope is bound to, and deletes nothing", () => {
    const home = tempHome();
    const other = account({ id: "acct_bbbbbbbbbb", name: "Two" });
    writeAccounts(home, {
      version: 1,
      accounts: [account(), other],
      bindings: { "ws:ws_1": account().id, "thread:th_1": account().id },
    });
    const reply = call(home, "DELETE", "/_nema/accounts", { id: account().id });
    expect(reply?.status).toBe(409);
    expect(reply!.body).toEqual({ error: "account_in_use", bindings: ["thread:th_1", "ws:ws_1"] });
    const after = readAccounts(home);
    expect(after.status).toBe("ok");
    expect(after.status === "ok" && after.file.accounts).toHaveLength(2);
  });

  test("deletes an unbound account together with its credential directory", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account(), account({ id: "acct_bbbbbbbbbb", name: "Two", order: 1 })], bindings: {} });
    const secretReply = call(home, "POST", "/_nema/accounts/secret", { id: account().id, kind: "byok", value: "sk-delete-me-0123456789" });
    expect(secretReply?.status).toBe(200);
    const dir = path.join(home, "secrets", "accounts", account().id);
    expect(statSync(dir).isDirectory()).toBe(true);

    const reply = call(home, "DELETE", "/_nema/accounts", { id: account().id });
    expect(reply?.status).toBe(200);
    expect(reply!.body).toEqual({ deleted: account().id });
    const after = readAccounts(home);
    expect(after.status === "ok" && after.file.accounts.map((a) => a.id)).toEqual(["acct_bbbbbbbbbb"]);
    expect(() => statSync(dir)).toThrow();
  });

  test("refuses to delete the last enabled account", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const reply = call(home, "DELETE", "/_nema/accounts", { id: account().id });
    expect(reply?.status).toBe(400);
    expect(reply!.body).toEqual({ error: "invalid_request" });
  });

  test("still allows deleting a disabled account when it is the only enabled one", () => {
    const home = tempHome();
    writeAccounts(home, {
      version: 1,
      accounts: [account(), account({ id: "acct_bbbbbbbbbb", name: "Two", enabled: false, order: 1 })],
      bindings: {},
    });
    const reply = call(home, "DELETE", "/_nema/accounts", { id: "acct_bbbbbbbbbb" });
    expect(reply?.status).toBe(200);
  });
});

describe("POST /_nema/accounts/secret", () => {
  test("writes the credential 0600 and returns only that it was saved", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const secret = "sk-write-only-0123456789";
    const reply = call(home, "POST", "/_nema/accounts/secret", { id: account().id, kind: "byok", value: secret });
    expect(reply).toEqual({ status: 200, body: { saved: true } });
    const file = path.join(home, "secrets", "accounts", account().id, "key");
    expect(readFileSync(file, "utf8").trim()).toBe(secret);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(reply!.body)).not.toContain(secret);
  });

  test("refuses a value spanning more than one line", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    for (const value of ["", "a\nb", "a\r\nb"]) {
      expect(call(home, "POST", "/_nema/accounts/secret", { id: account().id, kind: "byok", value })?.status).toBe(400);
    }
  });

  test("refuses a secret kind the account cannot hold", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    // A byok account holds a key, not a Claude token.
    const reply = call(home, "POST", "/_nema/accounts/secret", { id: account().id, kind: "claude", value: "tok-0123456789" });
    expect(reply?.status).toBe(400);
    expect(reply!.body).toEqual({ error: "invalid_request" });
  });

  test("refuses an unknown account", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const reply = call(home, "POST", "/_nema/accounts/secret", { id: "acct_zzzzzzzzzz", kind: "byok", value: "sk-0123456789" });
    expect(reply?.status).toBe(404);
  });
});

describe("POST /_nema/accounts/bind", () => {
  test("stores a binding and removes it when the account id is null", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    expect(call(home, "POST", "/_nema/accounts/bind", { scope: "thread:th_1", accountId: account().id })?.status).toBe(200);
    let stored = readAccounts(home);
    expect(stored.status === "ok" && stored.file.bindings).toEqual({ "thread:th_1": account().id });

    expect(call(home, "POST", "/_nema/accounts/bind", { scope: "thread:th_1", accountId: null })?.status).toBe(200);
    stored = readAccounts(home);
    expect(stored.status === "ok" && stored.file.bindings).toEqual({});
  });

  test("accepts \"auto\" and refuses a scope outside the two prefixes", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    expect(call(home, "POST", "/_nema/accounts/bind", { scope: "ws:ws_1", accountId: "auto" })?.status).toBe(200);
    expect(call(home, "POST", "/_nema/accounts/bind", { scope: "room:r_1", accountId: account().id })?.status).toBe(400);
    expect(call(home, "POST", "/_nema/accounts/bind", { scope: "ws:", accountId: account().id })?.status).toBe(400);
  });

  test("refuses a binding to an account that does not exist here", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const reply = call(home, "POST", "/_nema/accounts/bind", { scope: "ws:ws_1", accountId: "acct_zzzzzzzzzz" });
    expect(reply?.status).toBe(400);
    expect(reply!.body).toEqual({ error: "invalid_request" });
  });
});

describe("POST /_nema/accounts/login and /probe", () => {
  test("login is not applicable to a byok account", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const reply = call(home, "POST", "/_nema/accounts/login", { id: account().id });
    expect(reply?.status).toBe(409);
    expect(reply!.body).toEqual({ error: "login_not_applicable" });
  });

  test("login runs for a siwc account and is single-flight", async () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account({ authMode: "siwc", baseUrl: undefined })], bindings: {} });
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => { release = resolve; });
    const login = async () => {
      await started;
      return { ok: true };
    };
    const first = call(home, "POST", "/_nema/accounts/login", { id: account().id }, { login });
    expect(first?.status).toBe(202);
    const second = call(home, "POST", "/_nema/accounts/login", { id: account().id }, { login });
    expect(second?.status).toBe(409);
    expect(second!.body).toEqual({ error: "job_conflict" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("probe requires the quota confirmation, as the existing route does", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    expect(call(home, "POST", "/_nema/accounts/probe", { id: account().id })?.status).toBe(400);
    // Per-account probing needs a per-account transport, which this batch does not add.
    const reply = call(home, "POST", "/_nema/accounts/probe", { id: account().id, confirmQuotaUse: true });
    expect(reply?.status).toBe(409);
    expect(reply!.body).toEqual({ error: "probe_not_supported" });
  });
});

describe("dispatch contract", () => {
  test("returns null for a path this module does not own", () => {
    const home = tempHome();
    expect(call(home, "GET", "/_nema/settings")).toBeNull();
    expect(call(home, "GET", "/_nema/accounts/unknown")).toBeNull();
    expect(call(home, "PUT", "/_nema/accounts")).toBeNull();
  });

  test("never leaks an internal message through a 500", () => {
    const home = tempHome();
    writeAccounts(home, { version: 1, accounts: [account()], bindings: {} });
    const reply = call(home, "GET", "/_nema/accounts", undefined, {
      login: async () => ({ ok: true }),
      readAccounts: () => {
        throw new Error("raw-internal-marker");
      },
    });
    expect(reply?.status).toBe(500);
    expect(reply!.body).toEqual({ error: "internal_error" });
    expect(JSON.stringify(reply!.body)).not.toContain("raw-internal-marker");
  });
});
