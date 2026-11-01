import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettings } from "@/components/ModelSettings";
import { I18nProvider } from "@/lib/i18n";

/**
 * The three compatibility shapes S2 has to keep, checked on the page that contains the account block:
 *
 * 1. a single-account user sees the 0.2.0 page, plus one descriptive row and no picker;
 * 2. a 0.2.0 web against this daemon (the settings response has the extra fields): unchanged;
 * 3. this web against a 0.2.0 daemon (no `/_nema/accounts`): the block is absent, the rest is unchanged.
 */

const config = { adapter: "codex-direct", authMode: "byok", reasoningEffort: "medium", byokBaseUrl: "https://a.example.com/v1" };
const base = {
  config,
  auth: { mode: "byok", credential: "byok", state: "connected", adapter: "codex-direct" },
  credentials: { siwc: "missing", byok: "connected", claude: "missing" },
  tools: { claude: { available: false, tokenSaved: false }, github: { available: false, tokenSaved: false } },
};
const single = {
  id: "acct_abc1234567",
  name: "Default account",
  enabled: true,
  adapter: "codex-direct",
  authMode: "byok",
  baseUrl: "https://a.example.com/v1",
  costTier: "standard",
  order: 0,
  credential: "connected",
  implicit: true,
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stub(accountsReply: Response) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    seen.push(path);
    if (path === "/_nema/accounts") return Promise.resolve(accountsReply.clone());
    if (path === "/_nema/auth/status") return Promise.resolve(reply({ state: "idle", error: null }));
    if (path === "/_nema/models") return Promise.resolve(reply({ models: ["gpt-5"] }));
    return Promise.resolve(reply({ ...base, accounts: [single], defaultAccountId: single.id }));
  }));
  return seen;
}

const mount = () => render(<I18nProvider><ModelSettings onClose={() => {}} /></I18nProvider>);

beforeEach(() => {
  localStorage.setItem("nema.locale", "en");
  vi.restoreAllMocks();
});

describe("account block compatibility", () => {
  it("adds one descriptive row to a single-account page and nothing else", async () => {
    stub(reply({ accounts: [single], defaultAccountId: single.id, bindings: {} }));
    mount();
    // The 0.2.0 controls are all still there, unchanged.
    expect(await screen.findByLabelText("Model provider")).toBeTruthy();
    expect(screen.getByLabelText("Model provider")).toBeTruthy();
    // The address field belongs to the draft form and only appears while that provider is being edited.
    expect(screen.getByRole("button", { name: "Save settings" })).toBeTruthy();

    // And exactly one account row, marked as the setup the user already has.
    const rows = await screen.findAllByTestId("account-row");
    expect(rows).toHaveLength(1);
    expect(screen.getByText("Current setup")).toBeTruthy();
    // No picker: with one account and no binding there is nothing to choose between.
    expect(document.querySelector("[data-account-picker]")).toBeNull();
  });

  it("hides the block against a daemon that answers 404 and leaves every other control working", async () => {
    const seen = stub(reply({ error: "not_found" }, 404));
    mount();
    expect(await screen.findByLabelText("Model provider")).toBeTruthy();
    await waitFor(() => expect(seen).toContain("/_nema/accounts"));
    expect(screen.queryByText("Accounts")).toBeNull();
    expect(screen.queryAllByTestId("account-row")).toHaveLength(0);
    // The four provider controls of 0.2.0 are untouched by the 404.
    expect(screen.getByLabelText("Model")).toBeTruthy();
    expect(screen.getByLabelText("Reasoning effort")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save settings" })).toBeTruthy();
  });

  it("shows the accounts block only when a daemon serves it", async () => {
    const seen = stub(reply({ accounts: [single], defaultAccountId: single.id, bindings: {} }));
    mount();
    expect(await screen.findByText("Accounts")).toBeTruthy();
    expect(seen).toContain("/_nema/accounts");
  });
});
