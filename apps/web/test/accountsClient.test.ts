import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountsUnsupportedError, accountsApi, type AccountView } from "@/lib/accounts";
import { ModelSettingsError } from "@/lib/modelSettings";

/**
 * The accounts client. It has one job beyond fetching: tell "this daemon is older than the feature" (404)
 * apart from "this request was wrong" (4xx with a code), so the settings page can hide the block instead of
 * showing an error a single-account user cannot act on.
 */

const view = (over: Partial<AccountView> = {}): AccountView => ({
  id: "acct_abc1234567",
  name: "Work",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://a.example.com/v1",
  capabilities: {},
  costTier: "standard",
  order: 0,
  credential: "connected",
  implicit: false,
  ...over,
});

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const calls: Array<{ path: string; method: string; body?: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
});

function stub(handler: (path: string, method: string, body?: unknown) => Response) {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    return Promise.resolve(handler(path, init?.method ?? "GET", body));
  }));
}

describe("accountsApi", () => {
  it("reads the list from /_nema/accounts", async () => {
    stub(() => reply({ accounts: [view()], defaultAccountId: view().id, bindings: {} }));
    const list = await accountsApi.list();
    expect(list.accounts).toHaveLength(1);
    expect(calls).toEqual([{ path: "/_nema/accounts", method: "GET", body: undefined }]);
  });

  it("raises AccountsUnsupportedError on a 404, and ModelSettingsError on a coded failure", async () => {
    stub(() => reply({ error: "not_found" }, 404));
    await expect(accountsApi.list()).rejects.toBeInstanceOf(AccountsUnsupportedError);

    stub(() => reply({ error: "account_exists" }, 409));
    await expect(accountsApi.create({ name: "x", adapter: "claude-code" })).rejects.toMatchObject({ code: "account_exists" });
    await expect(accountsApi.create({ name: "x", adapter: "claude-code" })).rejects.toBeInstanceOf(ModelSettingsError);
  });

  it("treats a network failure as service_unavailable rather than as unsupported", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")));
    const failure = await accountsApi.list().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ModelSettingsError);
    expect(failure).not.toBeInstanceOf(AccountsUnsupportedError);
  });

  it("sends the documented bodies for each mutation", async () => {
    stub((path) => path.endsWith("/secret") ? reply({ saved: true }) : reply({ account: view() }, path.endsWith("/accounts") ? 201 : 200));
    await accountsApi.create({ name: "Work", adapter: "codex-direct", authMode: "byok", baseUrl: "https://a.example.com/v1" });
    await accountsApi.update({ id: view().id, name: "Renamed" });
    await accountsApi.saveSecret(view().id, "byok", "sk-0123456789");
    await accountsApi.bind("thread:th_1", view().id);
    await accountsApi.bind("thread:th_1", null);

    expect(calls[0]).toMatchObject({ path: "/_nema/accounts", method: "POST" });
    expect(calls[1]).toMatchObject({ path: "/_nema/accounts", method: "PATCH", body: { id: view().id, name: "Renamed" } });
    expect(calls[2]).toMatchObject({ path: "/_nema/accounts/secret", method: "POST", body: { id: view().id, kind: "byok", value: "sk-0123456789" } });
    expect(calls[3]).toMatchObject({ path: "/_nema/accounts/bind", body: { scope: "thread:th_1", accountId: view().id } });
    expect(calls[4]).toMatchObject({ path: "/_nema/accounts/bind", body: { scope: "thread:th_1", accountId: null } });
  });

  it("removes an account with DELETE and returns the id that went", async () => {
    stub(() => reply({ deleted: view().id }));
    await expect(accountsApi.remove(view().id)).resolves.toEqual({ deleted: view().id });
    expect(calls[0]).toMatchObject({ path: "/_nema/accounts", method: "DELETE", body: { id: view().id } });
  });

  it("surfaces the binding list of an account that cannot be deleted yet", async () => {
    stub(() => reply({ error: "account_in_use", bindings: ["thread:th_1", "ws:ws_1"] }, 409));
    const failure = await accountsApi.remove(view().id).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ModelSettingsError);
    expect((failure as { code: string }).code).toBe("account_in_use");
    expect((failure as { bindings?: string[] }).bindings).toEqual(["thread:th_1", "ws:ws_1"]);
  });
});
