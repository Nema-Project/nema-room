import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPicker } from "@/components/AccountPicker";
import { Composer } from "@/components/Composer";
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

  it("still renders for a single account when this scope holds a choice, so it can be cleared", () => {
    const { container } = mount({ accounts: [A], value: A.id, scope: "thread", threadId: "th_1" });
    expect(container.querySelector("[data-account-picker]")).not.toBeNull();
  });

  it("stays hidden at a scope with no choice even when another scope is bound", () => {
    // One thread's binding must not put a picker on every message and workspace: there is nothing there
    // to change or clear.
    const { container } = mount({ accounts: [A], scope: "message", value: null });
    expect(container.querySelector("[data-account-picker]")).toBeNull();
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
    mount({ scope: "thread", threadId: "th_1", value: A.id, onChange });
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
    mount({ scope: "workspace", workspaceId: "ws_1", value: B.id });
    await userEvent.selectOptions(screen.getByRole("combobox"), "");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ scope: "ws:ws_1", accountId: null });
  });

  it("shows a stored choice that no longer names an account, rather than silently falling back", () => {
    mount({ scope: "thread", threadId: "th_1", value: "acct_gone000000", accounts: [A] });
    expect(screen.getByRole("option", { name: /acct_gone000000/ })).toBeTruthy();
  });

  it("keeps the previous choice and says so when the save fails", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(reply({ error: "invalid_request" }, 400)));
    const onChange = vi.fn();
    mount({ scope: "thread", threadId: "th_1", value: A.id, onChange });
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
    const { container } = mount({ scope: "thread", threadId: "th_1", value: "auto", accounts: [A] });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("auto");
    expect(screen.getByRole("option", { name: /Automatic \(not available/i })).toBeTruthy();
    // It is a stored value being shown, not a choice offered: the select stays on it.
    expect(container.querySelector("select")).toBeTruthy();
  });
});

describe("the per-message choice after a send", () => {
  it("is cleared once the message has gone, so the next one starts from the default", async () => {
    // A per-message choice belongs to that message (spec §1.2). Keeping it would silently send every later
    // message to an account the user picked once.
    const A2 = account("acct_aaaaaaaaaa", "A");
    const B2 = account("acct_bbbbbbbbbb", "B", { order: 1 });
    const onSend = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      if (path === "/_nema/accounts") return Promise.resolve(reply({ accounts: [A2, B2], defaultAccountId: A2.id, bindings: {} }));
      return Promise.resolve(reply({}));
    }));
    render(<I18nProvider><Composer workspaceId="ws_1" onSend={onSend} /></I18nProvider>);

    // The composer's own picker, once the account list has arrived.
    const picker = await screen.findByLabelText("Account for this message");
    await userEvent.selectOptions(picker, B2.id);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(box, "first{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("first", [], [], B2.id));

    // Back to "follow the workspace" for the next message.
    await waitFor(() => expect((screen.getByLabelText("Account for this message") as HTMLSelectElement).value).toBe(""));
  });
});
