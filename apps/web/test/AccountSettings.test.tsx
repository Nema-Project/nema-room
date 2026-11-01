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

  it("sends a create body with no null fields, because the row schema does not accept them", async () => {
    // The bug this pins: `bodyOf` used to send `model: null`, `capabilities: null` and `baseUrl: null`, and
    // every kind except a keyed account with an endpoint has an empty baseUrl — so create failed for almost
    // every account. The stored-row schema is `.optional()` without `.nullable()`.
    const accounts: AccountView[] = [];
    const calls = stub({
      "GET /_nema/accounts": () => reply({ accounts: [...accounts], defaultAccountId: "", bindings: {} }),
      "POST /_nema/accounts": (body) => {
        accounts.push(work({ id: "acct_new0000009", name: (body as { name: string }).name, authMode: "siwc", baseUrl: undefined, model: undefined, capabilities: {} }));
        return reply({ account: accounts[0] }, 201);
      },
    });
    mount();
    await userEvent.click(await screen.findByRole("button", { name: /add account/i }));
    await userEvent.type(screen.getByLabelText("Name"), "Signer");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "siwc");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/_nema/accounts")).toBe(true));
    const sent = calls.find((c) => c.method === "POST" && c.path === "/_nema/accounts")!.body as Record<string, unknown>;
    expect(sent).toEqual({ name: "Signer", adapter: "codex-direct", authMode: "siwc", costTier: "standard" });
    // No key is present with a null value.
    expect(Object.entries(sent).filter(([, v]) => v === null)).toEqual([]);
  });

  it("sends explicit nulls on an update, so a cleared field is cleared", async () => {
    const calls = stub({
      "GET /_nema/accounts": list([work()]),
      "PATCH /_nema/accounts": () => reply({ account: work() }),
    });
    mount();
    const row = (await screen.findAllByTestId("account-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: /edit/i }));
    // Clear the model the row had.
    await userEvent.clear(screen.getByLabelText("Default model"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(sent.model).toBeNull();
    expect(sent.id).toBe(work().id);
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

describe("switching an account's kind", () => {
  it("sends null for the fields the new kind does not use", async () => {
    const calls = stub({
      "GET /_nema/accounts": list([work()]),
      "PATCH /_nema/accounts": () => reply({ account: work({ adapter: "claude-code", authMode: undefined, baseUrl: undefined }) }),
    });
    mount();
    const row = (await screen.findAllByTestId("account-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: /edit/i }));
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "claude");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = calls.find((c) => c.method === "PATCH")!.body as Record<string, unknown>;
    expect(sent.adapter).toBe("claude-code");
    // A Claude account has no auth mode and no endpoint; leaving them behind makes the row invalid.
    expect(sent.authMode).toBeNull();
    expect(sent.baseUrl).toBeNull();
  });
});

describe("the synthesized account row", () => {
  const implicit = (over: Partial<AccountView> = {}): AccountView => work({ id: "acct_0000000000", name: "Default account", implicit: true, ...over });

  it.each([
    ["a subscription account", { authMode: "siwc" as const, baseUrl: undefined }],
    ["a keyed account", { authMode: "byok" as const }],
    ["a Claude account", { adapter: "claude-code" as const, authMode: undefined, baseUrl: undefined }],
  ])("offers no controls that would be refused for %s", async (_label, over) => {
    // Every action on this row would send the reserved id, which `requestId` rejects, so each one could only
    // ever answer 404. The row describes the setup the user already has; the provider controls above it are
    // where that setup is changed.
    stub({ "GET /_nema/accounts": list([implicit(over)]) });
    mount();
    const row = (await screen.findAllByTestId("account-row"))[0]!;
    expect(within(row).queryByRole("button", { name: /^sign in$/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^edit$/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^delete$/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /save key/i })).toBeNull();
    expect(within(row).queryByLabelText(/API key|Claude Code token/i)).toBeNull();
    // It still says what it is and what its credential state is.
    expect(within(row).getByText("Current setup")).toBeTruthy();
    expect(within(row).getByRole("status").textContent).toBeTruthy();
  });

  it("still lets a second account be added", async () => {
    stub({ "GET /_nema/accounts": list([implicit()]) });
    mount();
    await screen.findByTestId("account-row");
    // The way out of the single-account setup is here, not on the row.
    expect(screen.getByRole("button", { name: /add account/i })).toBeTruthy();
  });

  it("keeps the compat explanation on a synthesized compat account", async () => {
    stub({ "GET /_nema/accounts": list([implicit({ authMode: "compat", baseUrl: undefined })]) });
    mount();
    const row = (await screen.findAllByTestId("account-row"))[0]!;
    expect(within(row).getByText(/this computer's Codex login/i)).toBeTruthy();
  });

  it("still shows a stored account's controls, so the rule is about the synthesized row only", async () => {
    stub({ "GET /_nema/accounts": list([implicit(), work()]) });
    mount();
    const rows = await screen.findAllByTestId("account-row");
    const stored = rows.find((r) => within(r).queryByText("Work"))!;
    expect(within(stored).getByRole("button", { name: /^edit$/i })).toBeTruthy();
    expect(within(stored).getByRole("button", { name: /^delete$/i })).toBeTruthy();
    expect(within(stored).getByLabelText(/API key/i)).toBeTruthy();
    const first = rows.find((r) => within(r).queryByText("Current setup"))!;
    expect(within(first).queryByRole("button", { name: /^edit$/i })).toBeNull();
  });
});

describe("the automatic routing switch", () => {
  const withSwitch = (autoRouting: boolean) =>
    () => reply({ accounts: [work(), personal()], defaultAccountId: work().id, bindings: {}, autoRouting });

  it("is shown off when the daemon has the switch off, and says what it does", async () => {
    stub({ "GET /_nema/accounts": withSwitch(false) });
    mount();
    const toggle = await screen.findByRole("checkbox", { name: /automatic routing/i });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    // The one thing a user must know before turning it on: this can send the same task to another account.
    expect(screen.getByText(/another account/i)).toBeTruthy();
  });

  it("turns the switch on through the accounts API and follows the answer", async () => {
    const calls: Array<{ method: string; body?: unknown }> = [];
    let on = false;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, body });
      if (method === "PATCH") {
        on = (body as { autoRouting: boolean }).autoRouting;
        return Promise.resolve(reply({ autoRouting: on }));
      }
      return Promise.resolve(reply({ accounts: [work(), personal()], defaultAccountId: work().id, bindings: {}, autoRouting: on }));
    }));
    mount();
    const toggle = await screen.findByRole("checkbox", { name: /automatic routing/i });
    await userEvent.click(toggle);
    // The switch is the only subject of this request: no account id, because it is a property of the file.
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ autoRouting: true });
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /automatic routing/i }) as HTMLInputElement).checked).toBe(true));
  });

  it("keeps showing off and says so when the save fails", async () => {
    stub({
      "GET /_nema/accounts": withSwitch(false),
      "PATCH /_nema/accounts": () => reply({ error: "accounts_unusable" }, 409),
    });
    mount();
    const toggle = await screen.findByRole("checkbox", { name: /automatic routing/i });
    await userEvent.click(toggle);
    // A switch that flips while the write failed would tell the user automatic routing is on when it is not.
    await waitFor(() => expect((screen.getByRole("checkbox", { name: /automatic routing/i }) as HTMLInputElement).checked).toBe(false));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
