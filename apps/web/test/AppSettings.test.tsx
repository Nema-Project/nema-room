import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSettings } from "@/components/AppSettings";
import { resetAppReleaseForTests } from "@/components/AppRelease";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";

vi.mock("@/lib/hub", () => ({ listExtensions: vi.fn(async () => []), discoverExtensions: vi.fn(async () => ({ locations: [], skills: [], truncated: false })) }));

const offer = { version: "0.2.0", url: "https://github.com/Nema-Project/nema-room/releases/tag/v0.2.0" };

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => body } as Response);
}

function renderSettings(onClose = vi.fn()) {
  render(
    <I18nProvider>
      <AppSettings onClose={onClose} />
    </I18nProvider>,
  );
  return onClose;
}

beforeEach(() => {
  localStorage.clear();
  delete window.nemaLoginItem;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});

afterEach(() => {
  resetAppReleaseForTests();
  delete window.nemaLoginItem;
  vi.unstubAllGlobals();
});

describe("AppSettings", () => {
  it("switches tabs from the keyboard and shows each section", async () => {
    renderSettings();
    const tabs = screen.getByRole("tablist", { name: "Settings sections" });
    expect(tabs.getAttribute("aria-orientation")).toBe("vertical");
    const model = screen.getByRole("tab", { name: "Model" });
    expect(model.getAttribute("aria-selected")).toBe("true");
    expect(model.tabIndex).toBe(0);
    expect(document.activeElement).toBe(model);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    const modelPanel = screen.getByRole("tabpanel", { name: "Model" });
    expect(modelPanel.querySelector(".model-settings.embedded")).toBeTruthy();
    expect(modelPanel.querySelector(".model-settings")?.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Model settings" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Model settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    for (const [id, name] of [["model", "Model"], ["plugins", "Plugins"], ["general", "General"], ["about", "About"]] as const) {
      expect(document.getElementById(`app-settings-panel-${id}`)).toBeTruthy();
      expect(screen.getByRole("tab", { name }).getAttribute("aria-controls")).toBe(`app-settings-panel-${id}`);
      expect(document.getElementById(`app-settings-panel-${id}`)?.hidden).toBe(id !== "model");
      expect(document.getElementById(`app-settings-panel-${id}`)?.tabIndex).toBe(id === "model" ? 0 : -1);
    }
    await waitFor(() => expect(hub.listExtensions).toHaveBeenCalledTimes(1));
    expect(model.getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{ArrowDown}");
    const plugins = screen.getByRole("tab", { name: "Plugins" });
    expect(plugins.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(plugins);
    expect(plugins.tabIndex).toBe(0);
    expect(model.tabIndex).toBe(-1);
    expect(await screen.findByRole("heading", { name: "Extensions" })).toBeTruthy();
    expect(hub.listExtensions).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    const login = screen.getByRole("checkbox", { name: "Open at login" });
    expect((login as HTMLInputElement).disabled).toBe(true);
    expect(await screen.findByText("Open at login is available in the desktop app. This browser session cannot change it.")).toBeTruthy();

    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "About" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("Version details are not available in this session.")).toBeTruthy();
    await userEvent.keyboard("{Home}");
    expect(model.getAttribute("aria-selected")).toBe("true");
    await userEvent.click(screen.getByRole("tab", { name: "About" }));
    expect(screen.getByRole("tab", { name: "About" }).getAttribute("aria-selected")).toBe("true");
  });

  it("closes from Escape only while focus is inside, and from the back button", async () => {
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <button type="button">Outside</button>
        <AppSettings onClose={onClose} />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    screen.getByRole("tab", { name: "Model" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Back to conversation" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("reads and saves open at login when the desktop bridge is present", async () => {
    const get = vi.fn(async () => ({ openAtLogin: true }));
    const set = vi.fn(async (openAtLogin: boolean) => ({ openAtLogin }));
    window.nemaLoginItem = { get, set };
    renderSettings();
    await userEvent.click(screen.getByRole("tab", { name: "General" }));
    const box = screen.getByRole("checkbox", { name: "Open at login" });
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
    expect((box as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText("Open Nema Room when you sign in on this computer.")).toBeTruthy();
    await userEvent.click(box);
    await waitFor(() => expect(set).toHaveBeenCalledWith(false));
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("reverts open at login and explains a failed save", async () => {
    window.nemaLoginItem = {
      get: vi.fn(async () => ({ openAtLogin: false })),
      set: vi.fn(async () => { throw new Error("rejected"); }),
    };
    renderSettings();
    await userEvent.click(screen.getByRole("tab", { name: "General" }));
    const box = screen.getByRole("checkbox", { name: "Open at login" });
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    await userEvent.click(box);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "The login setting could not be saved.");
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("keeps the version, the update check, and the release link on About", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/_nema/version") return json({ version: "0.1.5", commit: "4bdf89c" });
      if (url.startsWith("/_nema/update")) return json({ enabled: true, state: "newer", offer });
      return json({
        config: { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium" },
        auth: { mode: "siwc", credential: "siwc", state: "missing", adapter: "codex-direct" },
        tools: { claude: { available: false, tokenSaved: false }, github: { available: false, tokenSaved: false } },
      });
    }));
    renderSettings();
    await userEvent.click(screen.getByRole("tab", { name: "About" }));
    expect(await screen.findByText("Version 0.1.5 (4bdf89c)")).toBeTruthy();
    const link = await screen.findByRole("link", { name: "Update available: 0.2.0" });
    expect(link.getAttribute("href")).toBe(offer.url);
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Check for updates automatically" }) as HTMLInputElement).checked).toBe(true);
  });

  it("keeps an unsaved model change when another tab is shown", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/_nema/auth/status") return json({ state: "idle", error: null });
      if (url === "/_nema/version" || url.startsWith("/_nema/update")) return json({}, false);
      return json({
        config: { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium" },
        auth: { mode: "siwc", credential: "siwc", state: "missing", adapter: "codex-direct" },
        tools: { claude: { available: false, tokenSaved: false }, github: { available: false, tokenSaved: false } },
      });
    }));
    renderSettings();
    const effort = await screen.findByLabelText("Reasoning effort") as HTMLSelectElement;
    await userEvent.selectOptions(effort, "high");
    await userEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(screen.queryByRole("combobox", { name: "Reasoning effort" })).toBeNull();
    expect(document.getElementById("app-settings-panel-model")?.hidden).toBe(true);
    expect((document.getElementById("app-settings-panel-model")?.querySelector("[aria-label='Reasoning effort']") as HTMLSelectElement).value).toBe("high");
    await userEvent.click(screen.getByRole("tab", { name: "Model" }));
    expect((screen.getByRole("combobox", { name: "Reasoning effort" }) as HTMLSelectElement).value).toBe("high");
  });
});
