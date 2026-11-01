import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSettings } from "@/components/AccountSettings";
import type { AccountView } from "@/lib/accounts";
import { I18nProvider } from "@/lib/i18n";

/**
 * The account block of the settings page. It reads `/_nema/accounts`; when that daemon has no such route the
 * whole block stays out of the page, so a 0.2.0 daemon shows the 0.2.0 interface and nothing else.
 */

const work = (over: Partial<AccountView> = {}): AccountView => ({
  id: "acct_abc1234567",
  name: "Work",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://work.example.com/v1",
  model: "gpt-5",
  capabilities: { image: true, pdf: false, contextTokens: 200000 },
  costTier: "standard",
  order: 0,
  credential: "connected",
  implicit: false,
  ...over,
});

const personal = (over: Partial<AccountView> = {}): AccountView => ({
  id: "acct_def7654321",
  name: "Personal",
  enabled: true,
  adapter: "claude-code",
  capabilities: {},
  costTier: "low",
  order: 1,
  credential: "missing",
  implicit: false,
  ...over,
});

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Routes = Record<string, (body?: unknown) => Response>;
function stub(routes: Routes) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const handler = routes[`${method} ${path}`];
    return Promise.resolve(handler ? handler(body) : reply({ error: "not_found" }, 404));
  }));
  return calls;
}

const list = (accounts: AccountView[], bindings: Record<string, string> = {}) => () =>
  reply({ accounts, defaultAccountId: accounts[0]!.id, bindings });

const mount = () => render(<I18nProvider><AccountSettings onChanged={() => {}} /></I18nProvider>);

beforeEach(() => {
  localStorage.setItem("nema.locale", "en");
  vi.restoreAllMocks();
});

describe("AccountSettings", () => {
  it("renders nothing at all when the daemon does not support accounts", async () => {
    stub({});
    const { container } = mount();
    await waitFor(() => expect(container.querySelector(".account-settings")).toBeNull());
    expect(screen.queryByText("Accounts")).toBeNull();
  });

  it("lists each account's name, kind, address, credential state and capabilities", async () => {
    stub({ "GET /_nema/accounts": list([work(), personal()]) });
    mount();
    const rows = await screen.findAllByTestId("account-row");
    expect(rows).toHaveLength(2);

    const first = within(rows[0]!);
    expect(first.getByText("Work")).toBeTruthy();
    expect(first.getByText("https://work.example.com/v1")).toBeTruthy();
    expect(first.getByText("Credentials are saved.")).toBeTruthy();
    // Declared true / declared false / not declared are three different labels.
    expect(first.getByText(/Image/).textContent).toContain("yes");
    expect(first.getByText(/PDF/).textContent).toContain("no");
    expect(within(rows[1]!).getByText(/Image/).textContent).toContain("not declared");
  });

  it("adds a byok account and then offers a write-only key field", async () => {
    const accounts = [work()];
    const calls = stub({
      "GET /_nema/accounts": () => reply({ accounts, defaultAccountId: accounts[0]!.id, bindings: {} }),
      "POST /_nema/accounts": (body) => {
        accounts.push(work({ id: "acct_new0000001", name: (body as { name: string }).name, credential: "missing" }));
        return reply({ account: accounts[1] }, 201);
      },
      "POST /_nema/accounts/secret": () => reply({ saved: true }),
    });
    mount();
    await screen.findByText("Work");
    await userEvent.click(screen.getByRole("button", { name: /add account/i }));

    await userEvent.type(screen.getByLabelText("Name"), "Second");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "byok");
    fireEvent.change(screen.getByLabelText("Service address"), { target: { value: "https://second.example.com/v1" } });
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await screen.findByText("Second");
    // Every key account offers its own write-only field; the one under test is the new row's.
    const newRow = screen.getAllByTestId("account-row").find((row) => within(row).queryByText("Second"))!;
    const keyField = within(newRow).getByLabelText(/API key/i);
    expect(keyField.getAttribute("type")).toBe("password");
    await userEvent.type(keyField, "sk-second-0123456789");
    await userEvent.click(within(newRow).getByRole("button", { name: /save key/i }));

    await waitFor(() => {
      const sent = calls.find((c) => c.path === "/_nema/accounts/secret");
      expect(sent?.body).toEqual({ id: "acct_new0000001", kind: "byok", value: "sk-second-0123456789" });
    });
  });

  it("keeps the typed name and says so when the name is taken", async () => {
    stub({
      "GET /_nema/accounts": list([work()]),
      "POST /_nema/accounts": () => reply({ error: "account_exists" }, 409),
    });
    mount();
    await screen.findByText("Work");
    await userEvent.click(screen.getByRole("button", { name: /add account/i }));
    await userEvent.type(screen.getByLabelText("Name"), "WORK");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "claude");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "An account with this name already exists.");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("WORK");
    expect((screen.getByLabelText("Kind") as HTMLSelectElement).value).toBe("claude");
  });

  it("shows the scopes that block a delete", async () => {
    stub({
      "GET /_nema/accounts": list([work(), personal()], { "ws:ws_1": work().id, "thread:th_1": work().id }),
      "DELETE /_nema/accounts": () => reply({ error: "account_in_use", bindings: ["thread:th_1", "ws:ws_1"] }, 409),
    });
    mount();
    const rows = await screen.findAllByTestId("account-row");
    await userEvent.click(within(rows[0]!).getByRole("button", { name: /delete/i }));
    await userEvent.click(within(rows[0]!).getByRole("button", { name: /confirm delete/i }));

    const alert = await within(rows[0]!).findByRole("alert");
    expect(alert.textContent).toContain("thread:th_1");
    expect(alert.textContent).toContain("ws:ws_1");
  });

  it("shows the reason when the daemon cannot read its account file", async () => {
    stub({ "GET /_nema/accounts": () => reply({ unusableReason: "corrupt", bindings: {} }) });
    mount();
    expect(await screen.findByText(/could not be read/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add account/i })).toBeNull();
  });

  it("offers login only for an siwc account and reads a claude account's token field", async () => {
    stub({
      "GET /_nema/accounts": list([work({ authMode: "siwc", baseUrl: undefined, credential: "missing" }), personal()]),
      "POST /_nema/accounts/login": () => reply({ state: "running" }, 202),
    });
    mount();
    const rows = await screen.findAllByTestId("account-row");
    expect(within(rows[0]!).getByRole("button", { name: /^sign in$/i })).toBeTruthy();
    // A Claude account is authenticated by its token, not by a browser login.
    expect(within(rows[1]!).queryByRole("button", { name: /^sign in$/i })).toBeNull();
    fireEvent.change(within(rows[1]!).getByLabelText(/token/i), { target: { value: "tok-1" } });
  });

  it("shows a compat account as using the local Codex login", async () => {
    stub({ "GET /_nema/accounts": list([work({ authMode: "compat", baseUrl: undefined })]) });
    mount();
    const row = (await screen.findAllByTestId("account-row"))[0]!;
    expect(within(row).getByText(/this computer's Codex login/i)).toBeTruthy();
    expect(within(row).queryByLabelText(/api key/i)).toBeNull();
  });

  it("renders in Japanese with the catalog's labels", async () => {
    localStorage.setItem("nema.locale", "ja");
    stub({ "GET /_nema/accounts": list([work()]) });
    mount();
    expect(await screen.findByText("アカウント")).toBeTruthy();
  });
});
