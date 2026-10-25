import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { ModelSettings } from "@/components/ModelSettings";
import { I18nProvider } from "@/lib/i18n";

const config = { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium" };
const settings = {
  config,
  auth: { mode: "siwc", credential: "siwc", state: "missing", adapter: "codex-direct" },
  tools: {
    claude: { available: false, tokenSaved: false },
    github: { available: false, tokenSaved: false },
  },
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubModelFetch(fetchMock: typeof fetch, statusFetchMock: typeof fetch = vi.fn<typeof fetch>().mockResolvedValue(reply({ state: "idle", error: null })), models: unknown = { models: [] }) {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    if (path === "/_nema/auth/status") return statusFetchMock(input, init);
    if (path === "/_nema/models") return Promise.resolve(reply(models));
    return fetchMock(input, init);
  }));
}

function setup(fetchMock: typeof fetch, locale = "en", statusFetchMock?: typeof fetch, content?: ReactNode, models?: unknown) {
  localStorage.setItem("nema.locale", locale);
  stubModelFetch(fetchMock, statusFetchMock, models);
  return render(
    <I18nProvider>
      {content ?? <ModelSettings onClose={() => {}} />}
    </I18nProvider>,
  );
}

function ReopenableSettings() {
  const [open, setOpen] = useState(true);
  return open
    ? <ModelSettings onClose={() => setOpen(false)} />
    : <button type="button" onClick={() => setOpen(true)}>Reopen settings</button>;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("ModelSettings", () => {
  it.each([
    ["en", "Model provider", "ChatGPT sign-in", "Model", "ChatGPT subscription", "Claude subscription", "API key", "Provider"],
    ["ja", "モデル提供元", "ChatGPT のログイン方法", "モデル", "ChatGPT サブスクリプション", "Claude サブスクリプション", "API キー", "プロバイダー"],
    ["zh", "模型提供方", "ChatGPT 登录方式", "模型", "ChatGPT 订阅", "Claude 订阅", "API 密钥", "提供方"],
  ])("renders contextual connection controls in %s", async (locale, providerLabel, signIn, modelName, chatgpt, claude, apiKey, providerHeading) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(settings));
    setup(fetchMock, locale);
    for (const label of [providerLabel, signIn, modelName]) expect(await screen.findByLabelText(label)).toBeTruthy();
    const provider = screen.getByLabelText(providerLabel) as HTMLSelectElement;
    expect(Array.from(provider.options, (option) => option.textContent)).toEqual([chatgpt, claude, apiKey]);
    expect(screen.queryByRole("option", { name: /built-in|組み込み|内置/ })).toBeNull();
    const model = screen.getByRole("heading", { name: modelName });
    const heading = screen.getByRole("heading", { name: providerHeading });
    expect(model.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ["siwc", "codex-direct", "siwc"],
    ["compat", "codex-direct", "compat"],
    ["byok", "codex-direct", "byok"],
    ["claude", "claude-code", "siwc"],
  ])("saves %s to the accepted adapter/authMode pair", async (mode, adapter, authMode) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ config: { ...config, adapter, authMode } }))
      .mockResolvedValueOnce(reply({
        ...settings,
        config: { ...config, adapter, authMode },
        auth: { mode: authMode, credential: mode === "claude" ? "claude" : mode, state: "missing", adapter },
      }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("Model provider");
    if (mode === "claude") {
      await userEvent.selectOptions(screen.getByLabelText("Model provider"), "claude");
    } else if (mode === "byok") {
      await userEvent.selectOptions(screen.getByLabelText("Model provider"), "api");
    } else if (mode === "compat") {
      await userEvent.selectOptions(screen.getByLabelText("ChatGPT sign-in"), "codex");
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    }
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/_nema/settings");
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toMatchObject({ adapter, authMode });
    expect(body).not.toHaveProperty("model");
  });

  it.each([
    ["compat", "codex-direct", "compat", "codex", false],
    ["byok", "codex-direct", "byok", "", true],
    ["claude", "claude-code", "siwc", "", false],
  ])("initially selects saved %s configuration and its relevant fields", async (mode, adapter, authMode, signIn, hasApiFields) => {
    const saved = {
      ...settings,
      config: { ...config, adapter, authMode },
      auth: { ...settings.auth, mode: authMode, credential: mode === "claude" ? "claude" : mode },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(saved));
    setup(fetchMock);
    const provider = await screen.findByLabelText("Model provider") as HTMLSelectElement;
    expect(provider.value).toBe(mode === "claude" ? "claude" : mode === "byok" ? "api" : "chatgpt");
    if (mode === "byok") {
      expect(screen.getByLabelText("API key")).toBeTruthy();
      expect(screen.getByLabelText("Service address (optional)")).toBeTruthy();
      expect(screen.queryByLabelText("ChatGPT sign-in")).toBeNull();
    } else if (mode === "compat") {
      expect((screen.getByLabelText("ChatGPT sign-in") as HTMLSelectElement).value).toBe(signIn);
      expect(screen.queryByLabelText("API key")).toBeNull();
    } else {
      expect(screen.getByText(/Claude Code is not installed here/)).toBeTruthy();
      expect(screen.queryByLabelText("ChatGPT sign-in")).toBeNull();
      expect(screen.queryByLabelText("API key")).toBeNull();
    }
    expect(hasApiFields).toBe(mode === "byok");
  });

  it.each([
    ["en", "Model provider", "No credentials are saved for this mode.", "Each provider keeps its own login."],
    ["ja", "モデル提供元", "このモードの認証情報は保存されていません。", "プロバイダーごとにログインは分かれています。"],
    ["zh", "模型提供方", "此模式未保存凭据。", "每个提供方的登录分开保存。"],
  ])("shows the selected provider's own login after switching in %s", async (locale, serviceLabel, ownStatus, independent) => {
    const byok = {
      ...settings,
      config: { ...config, authMode: "byok" as const },
      auth: { ...settings.auth, mode: "byok" as const, credential: "byok" as const, state: "missing" as const },
      credentials: { siwc: "connected" as const, compat: "missing" as const, byok: "missing" as const, claude: "connected" as const },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ config: byok.config }))
      .mockResolvedValueOnce(reply(byok));
    setup(fetchMock, locale);
    await userEvent.selectOptions(await screen.findByLabelText(serviceLabel), "api");
    const status = await screen.findByText(ownStatus);
    const note = screen.getByText(new RegExp(independent));
    expect(status.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/saved connection|保存済みの接続|已保存的连接/)).toBeNull();
    expect(screen.queryByText(/SIWC|BYOK/i)).toBeNull();
  });

  it("chooses a listed model for the saved provider and does not accept a typed model id", async () => {
    const saved = {
      ...settings,
      config: { ...config, model: "gpt-a" },
      auth: { ...settings.auth, state: "connected" as const },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(saved))
      .mockResolvedValueOnce(reply({ config: { ...config, model: "gpt-b", reasoningEffort: "medium" } }))
      .mockResolvedValueOnce(reply({ ...saved, config: { ...config, model: "gpt-b" } }));
    setup(fetchMock, "en", undefined, undefined, { models: ["gpt-a", "gpt-b"] });
    const select = await screen.findByLabelText("Model") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("gpt-a"));
    expect(Array.from(select.options, (option) => option.value)).toEqual(["", "gpt-a", "gpt-b"]);
    expect(screen.queryByRole("textbox", { name: /model/i })).toBeNull();
    await userEvent.selectOptions(select, "gpt-b");
    await userEvent.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ model: "gpt-b", reasoningEffort: "medium" });
  });

  it("offers Claude Code model aliases and saves the chosen alias", async () => {
    const claude = {
      ...settings,
      config: { ...config, adapter: "claude-code" as const, model: "sonnet" },
      auth: { ...settings.auth, credential: "claude" as const, adapter: "claude-code" as const },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(claude))
      .mockResolvedValueOnce(reply({ config: { ...claude.config, model: "opus" } }))
      .mockResolvedValueOnce(reply({ ...claude, config: { ...claude.config, model: "opus" } }));
    setup(fetchMock);
    const select = await screen.findByLabelText("Model") as HTMLSelectElement;
    expect(select.value).toBe("sonnet");
    expect(Array.from(select.options, (option) => option.text)).toEqual(["Default (Opus 5.5)", "sonnet", "opus", "haiku", "fable", "best", "opusplan"]);
    expect(screen.queryByText(/daily coding|does not use a model list/)).toBeNull();
    await userEvent.selectOptions(select, "opus");
    await userEvent.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ model: "opus", reasoningEffort: "medium" });
  });

  it("keeps an unlisted saved model until a listed one replaces it", async () => {
    const saved = {
      ...settings,
      config: { ...config, model: "custom-exact" },
      auth: { ...settings.auth, state: "connected" as const },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(saved));
    setup(fetchMock, "en", undefined, undefined, { models: ["gpt-a"] });
    const select = await screen.findByLabelText("Model") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("");
    expect(screen.getByText(/custom-exact/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /model/i })).toBeNull();
    expect((screen.getByRole("button", { name: "Save model" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("validates the service address and saves the provider without a model", async () => {
    const byokSettings = { ...settings, config: { ...config, authMode: "byok" as const }, auth: { ...settings.auth, mode: "byok" as const, credential: "byok" as const } };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ config: byokSettings.config }))
      .mockResolvedValueOnce(reply(byokSettings))
      .mockResolvedValueOnce(reply({ config: byokSettings.config }))
      .mockResolvedValueOnce(reply(byokSettings));
    setup(fetchMock);
    await screen.findByLabelText("Model provider");
    await userEvent.selectOptions(screen.getByLabelText("Model provider"), "api");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await userEvent.type(screen.getByLabelText("Service address (optional)"), "http://example.com/v1");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter an HTTPS URL or a localhost URL.");
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await userEvent.clear(screen.getByLabelText("Service address (optional)"));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    const body = JSON.parse(String(fetchMock.mock.calls[3][1]?.body));
    expect(body).toMatchObject({ adapter: "codex-direct", authMode: "byok", byokBaseUrl: null });
    expect(body).not.toHaveProperty("model");
  });

  it("maps backend schema errors to local text and omits unknown server details", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ error: "invalid_request", detail: "raw-provider-marker" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("Model provider");
    await userEvent.selectOptions(screen.getByLabelText("ChatGPT sign-in"), "codex");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Some settings are invalid. Review the values and try again.");
    expect(alert.textContent).not.toContain("raw-provider-marker");
  });

  it("uses the selected provider's login as soon as that provider is chosen", async () => {
    const compatSettings = {
      ...settings,
      config: { ...config, authMode: "compat" },
      auth: { ...settings.auth, mode: "compat", credential: "compat" },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ config: { ...config, authMode: "compat" } }))
      .mockResolvedValueOnce(reply(compatSettings))
      .mockResolvedValueOnce(reply({ state: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("Model provider");
    await userEvent.selectOptions(screen.getByLabelText("ChatGPT sign-in"), "codex");
    const loginButton = screen.getByRole("button", { name: "Start login" }) as HTMLButtonElement;
    await waitFor(() => expect(loginButton.disabled).toBe(false));
    await userEvent.click(loginButton);
    expect(fetchMock.mock.calls[3][0]).toBe("/_nema/auth/login");
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ body: "{}" });
  });

  it("never prefills a saved secret and clears a submitted secret before a failed request settles", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ ...settings, config: { ...config, authMode: "byok" }, auth: { ...settings.auth, mode: "byok", credential: "byok", state: "connected" } }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    const input = await screen.findByLabelText("API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    await userEvent.type(input, "secret-marker");
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(input.value).toBe("");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ kind: "byok", value: "secret-marker" });
    await act(async () => finish(reply({ error: "internal_error" }, 500)));
    expect((await screen.findByRole("alert")).textContent).toContain("The settings service is unavailable.");
    expect(input.value).toBe("");
  });

  it("clears a draft password when the selected credential kind changes", async () => {
    const claudeSettings = {
      ...settings,
      config: { ...config, adapter: "claude-code" as const },
      auth: { ...settings.auth, credential: "claude" as const, adapter: "claude-code" as const },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({
        ...settings,
        config: { ...config, authMode: "byok" },
        auth: { ...settings.auth, mode: "byok", credential: "byok" },
      }))
      .mockResolvedValueOnce(reply({ config: claudeSettings.config }))
      .mockResolvedValueOnce(reply(claudeSettings));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await userEvent.type(await screen.findByLabelText("API key"), "draft-secret");
    await userEvent.selectOptions(screen.getByLabelText("Model provider"), "claude");
    const claudeInput = await screen.findByLabelText("Claude Code token") as HTMLInputElement;
    expect(claudeInput.type).toBe("password");
    expect(claudeInput.value).toBe("");
    expect((screen.getByRole("button", { name: "Save credential" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("requires the explicit quota opt-in and handles pending, duplicate, cancellation and failure", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ error: "job_conflict" }, 409))
      .mockResolvedValueOnce(reply({ state: "running" }))
      .mockResolvedValueOnce(reply({ state: "cancelled" }))
      .mockResolvedValueOnce(reply({ state: "running" }));
    const statusFetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ state: "idle", error: null }))
      .mockResolvedValue(reply({ state: "failed", error: "login_failed" }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock, "en", statusFetchMock);
    await screen.findByLabelText("Model provider");
    const probe = screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement;
    expect(probe.disabled).toBe(true);
    await userEvent.click(screen.getByLabelText("I understand this may use model quota"));
    expect(probe.disabled).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Start login" }));
    expect(await screen.findByText("Login or another authentication task is already running.")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Start login" }));
    expect(await screen.findByText("Authentication task in progress…")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel authentication task" }));
    expect(await screen.findByText("Authentication task cancelled.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Start login" }));
    expect(await screen.findByText("Login failed. Try again.", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("never sends a probe before the explicit opt-in and submits the accepted confirmation DTO after", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ state: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("Model provider");
    const probe = screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement;
    expect(probe.disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/_nema/auth/probe")).toBe(false);
    await userEvent.click(screen.getByLabelText("I understand this may use model quota"));
    await userEvent.click(probe);
    expect(fetchMock.mock.calls[1][0]).toBe("/_nema/auth/probe");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ body: JSON.stringify({ confirmQuotaUse: true }) });
  });

  it("shows the unsupported Claude probe message without exposing the SIWC probe action", async () => {
    const claudeSettings = {
      ...settings,
      config: { ...config, adapter: "claude-code" as const },
      auth: { ...settings.auth, credential: "claude" as const, adapter: "claude-code" as const },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ config: claudeSettings.config }))
      .mockResolvedValueOnce(reply(claudeSettings));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("Model provider");
    await userEvent.selectOptions(screen.getByLabelText("Model provider"), "claude");
    expect(await screen.findByText("Connection testing is not available for Claude Code.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/_nema/auth/probe")).toBe(false);
  });

  it("keeps compatibility login files intact when the backend reports logout as a no-op", async () => {
    const compatSettings = {
      ...settings,
      config: { ...config, authMode: "compat" },
      auth: { ...settings.auth, mode: "compat", credential: "compat", state: "connected" },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(compatSettings))
      .mockResolvedValueOnce(reply({ loggedOut: false, kind: "compat" }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("ChatGPT sign-in");
    await userEvent.click(screen.getByRole("button", { name: "Log out of Nema Room" }));
    expect(await screen.findByText("Compatibility mode does not change the Codex login files.")).toBeTruthy();
    expect(screen.getByText("Credentials are saved.")).toBeTruthy();
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ kind: "compat" });
  });

  it("shows login completion and updates redacted credential status after the job succeeds", async () => {
    const connected = { ...settings, auth: { ...settings.auth, state: "connected" } };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ state: "running" }))
      .mockResolvedValueOnce(reply(connected));
    const statusFetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ state: "idle", error: null }))
      .mockResolvedValue(reply({ state: "succeeded", error: null }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock, "en", statusFetchMock);
    await screen.findByLabelText("Model provider");
    await userEvent.click(screen.getByRole("button", { name: "Start login" }));
    expect(await screen.findByText("Authentication task completed.", {}, { timeout: 3000 })).toBeTruthy();
    expect(await screen.findByText("Credentials are saved.")).toBeTruthy();
  });

  it("cleans up a pending auth-status poll when the settings panel unmounts", async () => {
    const statusFetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply({ state: "idle", error: null }));
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ state: "running" }));
    const view = setup(fetchMock, "en", statusFetchMock);
    await screen.findByLabelText("Model provider");
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Start login" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(statusFetchMock).toHaveBeenCalledTimes(1);
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(statusFetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a running job and keeps Cancel available after closing and reopening the drawer", async () => {
    let finishFirstStatus!: (response: Response) => void;
    const statusFetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirstStatus = resolve; }))
      .mockResolvedValueOnce(reply({ state: "running", error: null }));
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ state: "cancelled", error: null }));
    setup(fetchMock, "en", statusFetchMock, <ReopenableSettings />);
    await screen.findByLabelText("Model provider");
    await waitFor(() => expect(statusFetchMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen settings" }));
    expect(await screen.findByText("Authentication task in progress…")).toBeTruthy();
    expect((screen.getByLabelText("Model provider") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Cancel authentication task" })).toBeTruthy();

    await act(async () => finishFirstStatus(reply({ state: "idle", error: null })));
    expect(screen.getByText("Authentication task in progress…")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel authentication task" }));
    expect(await screen.findByText("Authentication task cancelled.")).toBeTruthy();
    expect(fetchMock.mock.calls[2][0]).toBe("/_nema/auth/cancel");
  });

  it("keeps the success settings refresh alive when the terminal job state renders", async () => {
    let finishSettingsRefresh!: (response: Response) => void;
    let loginStarted = false;
    const connected = { ...settings, auth: { ...settings.auth, state: "connected" } };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ state: "running" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSettingsRefresh = resolve; }));
    const statusFetchMock = vi.fn<typeof fetch>(() => Promise.resolve(reply(loginStarted
      ? { state: "succeeded", error: null }
      : { state: "idle", error: null })));
    setup(fetchMock, "en", statusFetchMock);
    await screen.findByLabelText("Model provider");
    await waitFor(() => expect((screen.getByRole("button", { name: "Start login" }) as HTMLButtonElement).disabled).toBe(false));
    loginStarted = true;
    await userEvent.click(screen.getByRole("button", { name: "Start login" }));
    expect(await screen.findByText("Authentication task completed.", {}, { timeout: 3000 })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const refreshSignal = fetchMock.mock.calls[2][1]?.signal as AbortSignal;
    expect(refreshSignal.aborted).toBe(false);
    await act(async () => finishSettingsRefresh(reply(connected)));
    expect(await screen.findByText("Credentials are saved.")).toBeTruthy();
  });

  it("retries a transient status failure and reaches the later terminal status", async () => {
    let failStatus!: (error: Error) => void;
    let loginStarted = false;
    let failedOnce = false;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ state: "running" }));
    const statusFetchMock = vi.fn<typeof fetch>(() => {
      if (!loginStarted) return Promise.resolve(reply({ state: "idle", error: null }));
      if (!failedOnce) {
        failedOnce = true;
        return new Promise((_resolve, reject) => { failStatus = reject; });
      }
      return Promise.resolve(reply({ state: "failed", error: "login_failed" }));
    });
    setup(fetchMock, "en", statusFetchMock);
    await screen.findByLabelText("Model provider");
    await waitFor(() => expect((screen.getByRole("button", { name: "Start login" }) as HTMLButtonElement).disabled).toBe(false));
    const callsBeforeLogin = statusFetchMock.mock.calls.length;
    loginStarted = true;
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Start login" }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(statusFetchMock).toHaveBeenCalledTimes(callsBeforeLogin + 1);
      await act(async () => failStatus(new Error("temporary transport failure")));
      expect((screen.getByRole("alert")).textContent).toContain("The settings service is unavailable.");
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(statusFetchMock).toHaveBeenCalledTimes(callsBeforeLogin + 2);
      expect(screen.getByText("Login failed. Try again.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a reopened BYOK probe job cancellable while the form mode is unsaved", async () => {
    const byokSettings = {
      ...settings,
      config: { ...config, authMode: "byok", byokBaseUrl: "" },
      auth: { ...settings.auth, mode: "byok", credential: "byok" },
    };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(byokSettings))
      .mockResolvedValueOnce(reply({ state: "running" }))
      .mockResolvedValueOnce(reply(byokSettings))
      .mockResolvedValueOnce(reply({ state: "cancelled", error: null }));
    const statusFetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ state: "idle", error: null }))
      .mockResolvedValueOnce(reply({ state: "running", error: null }));
    setup(fetchMock, "en", statusFetchMock, <ReopenableSettings />);
    await screen.findByLabelText("Model provider");
    await waitFor(() => expect(statusFetchMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByLabelText("I understand this may use model quota"));
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Authentication task in progress…")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen settings" }));
    expect(await screen.findByText("Authentication task in progress…")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Model provider"), "claude");
    expect(screen.getByRole("button", { name: "Cancel authentication task" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel authentication task" }));
    expect(await screen.findByText("Authentication task cancelled.")).toBeTruthy();
    expect(fetchMock.mock.calls[3][0]).toBe("/_nema/auth/cancel");
  });

  it("preserves a failed save alert when the delayed mount status succeeds", async () => {
    let finishInitialStatus!: (response: Response) => void;
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ error: "invalid_request" }, 400));
    const statusFetchMock = vi.fn<typeof fetch>(() => new Promise((resolve) => { finishInitialStatus = resolve; }));
    setup(fetchMock, "en", statusFetchMock);
    await screen.findByLabelText("Model provider");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Some settings are invalid.");

    await act(async () => finishInitialStatus(reply({ state: "idle", error: null })));
    expect(screen.getByRole("alert").textContent).toContain("Some settings are invalid.");
  });

  it("explains unavailable optional Claude and GitHub tools without blocking direct use", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(settings));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    expect(await screen.findByLabelText("Model provider")).toBeTruthy();
    expect(screen.queryByLabelText(/GitHub.*(?:token|access)/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /GitHub.*(?:token|credential)/i })).toBeNull();
  });
});
