import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPicker } from "@/components/AccountPicker";
import type { AccountView } from "@/lib/accounts";
import { I18nProvider } from "@/lib/i18n";

/**
 * The account picker, used in the three places spec §1.2 names. It hides itself when there is nothing to
 * choose, so a single-account user never sees it.
 */

const account = (id: string, name: string, over: Partial<AccountView> = {}): AccountView => ({
  id,
  name,
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

const A = account("acct_aaaaaaaaaa", "A");
const B = account("acct_bbbbbbbbbb", "B", { order: 1 });

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const mount = (props: Partial<Parameters<typeof AccountPicker>[0]> = {}) =>
  render(
    <I18nProvider>
      <AccountPicker
        scope="message"
        accounts={[A, B]}
        bindings={{}}
        value={null}
        onChange={() => {}}
        {...props}
      />
    </I18nProvider>,
  );

beforeEach(() => {
  localStorage.setItem("nema.locale", "en");
  vi.restoreAllMocks();
});

describe("AccountPicker", () => {
  it("renders nothing for a single account with no binding", () => {
    const { container } = mount({ accounts: [A] });
    expect(container.querySelector("[data-account-picker]")).toBeNull();
  });

  it("still renders for a single account when a binding exists, so it can be cleared", () => {
    const { container } = mount({ accounts: [A], bindings: { "thread:th_1": A.id }, scope: "thread" });
    expect(container.querySelector("[data-account-picker]")).not.toBeNull();
  });

  it("defaults to following the workspace, and to the global default at workspace scope", () => {
    mount({ scope: "message", accounts: [A, B] });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("option", { name: "Follow the workspace" })).toBeTruthy();
  });

  it("labels the workspace scope's empty choice as the global default", () => {
    mount({ scope: "workspace", accounts: [A, B] });
    expect(screen.getByRole("option", { name: "Global default" })).toBeTruthy();
  });

  it("reports the chosen account upward without writing a binding for a message", async () => {
    const onChange = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply({ scope: "thread:th_1", accountId: B.id }));
    vi.stubGlobal("fetch", fetchMock);
    mount({ scope: "message", onChange });
    await userEvent.selectOptions(screen.getByRole("combobox"), B.id);
    expect(onChange).toHaveBeenCalledWith(B.id);
    // A per-message choice is this message's input, not a stored setting.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds a thread choice through the accounts API", async () => {
    const onChange = vi.fn();
    const calls: Array<{ path: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      calls.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return Promise.resolve(reply({ scope: "thread:th_1", accountId: B.id }));
    }));
    mount({ scope: "thread", threadId: "th_1", bindings: { "thread:th_1": A.id }, value: A.id, onChange });
    await userEvent.selectOptions(screen.getByRole("combobox"), B.id);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ path: "/_nema/accounts/bind", body: { scope: "thread:th_1", accountId: B.id } });
    expect(onChange).toHaveBeenCalledWith(B.id);
  });

  it("clears a binding by choosing the empty option", async () => {
    const calls: Array<{ body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      calls.push({ body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return Promise.resolve(reply({ scope: "ws:ws_1", accountId: null }));
    }));
    mount({ scope: "workspace", workspaceId: "ws_1", bindings: { "ws:ws_1": B.id }, value: B.id });
    await userEvent.selectOptions(screen.getByRole("combobox"), "");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ scope: "ws:ws_1", accountId: null });
  });

  it("shows a stored choice that no longer names an account, rather than silently falling back", () => {
    mount({ scope: "thread", threadId: "th_1", bindings: { "thread:th_1": "acct_gone000000" }, value: "acct_gone000000", accounts: [A] });
    expect(screen.getByRole("option", { name: /acct_gone000000/ })).toBeTruthy();
  });

  it("keeps the previous choice and says so when the save fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(reply({ error: "invalid_request" }, 400)));
    const onChange = vi.fn();
    mount({ scope: "thread", threadId: "th_1", bindings: { "thread:th_1": A.id }, value: A.id, onChange });
    await userEvent.selectOptions(screen.getByRole("combobox"), B.id);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onChange).not.toHaveBeenCalledWith(B.id);
  });

  it("hides itself when the daemon does not support accounts at all", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(reply({ error: "not_found" }, 404)));
    const { container } = mount({ scope: "thread", threadId: "th_1", supported: false });
    await act(async () => {});
    expect(container.querySelector("[data-account-picker]")).toBeNull();
  });
});

describe("values this batch has no option for", () => {
  it("shows a stored \"auto\" binding as automatic rather than as no choice", () => {
    // Automatic routing is S4; a file written by a newer version (or by hand) must not paint the select blank.
    const { container } = mount({ scope: "thread", threadId: "th_1", bindings: { "thread:th_1": "auto" }, value: "auto", accounts: [A, B] });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect(screen.getByRole("option", { name: /Automatic \(not available/i })).toBeTruthy();
  });
});
