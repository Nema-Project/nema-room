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
    ["en", "Agent runtime", "Model service", "ChatGPT sign-in", "Model"],
    ["ja", "エージェント", "モデル接続", "ChatGPT のログイン方法", "モデル"],
    ["zh", "Agent 运行环境", "模型服务", "ChatGPT 登录方式", "模型"],
  ])("renders contextual connection controls in %s", async (locale, ...labels) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(settings));
    setup(fetchMock, locale);
    for (const label of labels) expect(await screen.findByLabelText(label)).toBeTruthy();
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
    await screen.findByLabelText("Agent runtime");
    if (mode === "claude") {
      await userEvent.selectOptions(screen.getByLabelText("Agent runtime"), "claude");
    } else if (mode === "byok") {
      await userEvent.selectOptions(screen.getByLabelText("Model service"), "api");
    } else if (mode === "compat") {
      await userEvent.selectOptions(screen.getByLabelText("ChatGPT sign-in"), "codex");
    }
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
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
    const agent = await screen.findByLabelText("Agent runtime") as HTMLSelectElement;
    expect(agent.value).toBe(mode === "claude" ? "claude" : "nema");
    if (mode === "byok") {
      expect((screen.getByLabelText("Model service") as HTMLSelectElement).value).toBe("api");
      expect(screen.getByLabelText("API key")).toBeTruthy();
      expect(screen.getByLabelText("Service address (optional)")).toBeTruthy();
    } else if (mode === "compat") {
      expect((screen.getByLabelText("ChatGPT sign-in") as HTMLSelectElement).value).toBe(signIn);
      expect(screen.queryByLabelText("API key")).toBeNull();
    } else {
      expect(screen.getByText(/Claude Code is not installed here/)).toBeTruthy();
      expect(screen.queryByLabelText("Model service")).toBeNull();
    }
    expect(hasApiFields).toBe(mode === "byok");
  });

  it.each([
    ["en", "ChatGPT with browser sign-in"],
    ["ja", "ChatGPT をブラウザーでログイン"],
    ["zh", "通过浏览器登录 ChatGPT"],
  ])("uses user-facing saved-connection wording for unsaved changes in %s", async (locale, chatgptBrowser) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(settings));
    setup(fetchMock, locale);
    const service = await screen.findByLabelText(locale === "en" ? "Model service" : locale === "ja" ? "モデル接続" : "模型服务") as HTMLSelectElement;
    await userEvent.selectOptions(service, "api");
    expect(service.value).toBe("api");
    expect(screen.getByText(new RegExp(chatgptBrowser))).toBeTruthy();
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
    await userEvent.selectOptions(screen.getByLabelText("Model service"), "api");
    expect(select.disabled).toBe(true);
    expect(screen.getByText("Save the provider first. The model list belongs to the saved provider, not the draft above.")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Model service"), "chatgpt");
    await waitFor(() => expect(select.disabled).toBe(false));
    await userEvent.selectOptions(select, "gpt-b");
    await userEvent.click(screen.getByRole("button", { name: "Save model" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ model: "gpt-b", reasoningEffort: "medium" });
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
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ config: { ...config, authMode: "byok" } }))
      .mockResolvedValueOnce(reply({ ...settings, config: { ...config, authMode: "byok" }, auth: { ...settings.auth, mode: "byok", credential: "byok" } }));
    setup(fetchMock);
    await screen.findByLabelText("Model service");
    await userEvent.selectOptions(screen.getByLabelText("Model service"), "api");
    await userEvent.type(screen.getByLabelText("Service address (optional)"), "http://example.com/v1");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter an HTTPS URL or a localhost URL.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await userEvent.clear(screen.getByLabelText("Service address (optional)"));
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body).toMatchObject({ adapter: "codex-direct", authMode: "byok", byokBaseUrl: null });
    expect(body).not.toHaveProperty("model");
  });

  it("maps backend schema errors to local text and omits unknown server details", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply(settings))
      .mockResolvedValueOnce(reply({ error: "invalid_request", detail: "raw-provider-marker" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("Agent runtime");
    await userEvent.selectOptions(screen.getByLabelText("ChatGPT sign-in"), "codex");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Some settings are invalid. Review the values and try again.");
    expect(alert.textContent).not.toContain("raw-provider-marker");
  });

  it("does not start auth for a newly selected mode until that mode is saved", async () => {
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
    await screen.findByLabelText("Agent runtime");
    await userEvent.selectOptions(screen.getByLabelText("ChatGPT sign-in"), "codex");
    const loginButton = screen.getByRole("button", { name: "Start login" }) as HTMLButtonElement;
    expect(loginButton.disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply({
      ...settings,
      config: { ...config, authMode: "byok" },
      auth: { ...settings.auth, mode: "byok", credential: "byok" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await userEvent.type(await screen.findByLabelText("API key"), "draft-secret");
    await userEvent.selectOptions(screen.getByLabelText("Agent runtime"), "claude");
    const claudeInput = screen.getByLabelText("Claude Code token") as HTMLInputElement;
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
    await screen.findByLabelText("Agent runtime");
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
    await screen.findByLabelText("Agent runtime");
    const probe = screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement;
    expect(probe.disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/_nema/auth/probe")).toBe(false);
    await userEvent.click(screen.getByLabelText("I understand this may use model quota"));
    await userEvent.click(probe);
    expect(fetchMock.mock.calls[1][0]).toBe("/_nema/auth/probe");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ body: JSON.stringify({ confirmQuotaUse: true }) });
  });

  it("shows the unsupported Claude probe message without exposing the SIWC probe action", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(settings));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    await screen.findByLabelText("Agent runtime");
    await userEvent.selectOptions(screen.getByLabelText("Agent runtime"), "claude");
    expect(screen.getByText("Connection testing is not available for Claude Code.")).toBeTruthy();
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
    await screen.findByLabelText("Agent runtime");
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
    await screen.findByLabelText("Agent runtime");
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
    await screen.findByLabelText("Agent runtime");
    await waitFor(() => expect(statusFetchMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen settings" }));
    expect(await screen.findByText("Authentication task in progress…")).toBeTruthy();
    expect((screen.getByLabelText("Agent runtime") as HTMLSelectElement).disabled).toBe(true);
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
    await screen.findByLabelText("Agent runtime");
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
    await screen.findByLabelText("Agent runtime");
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
    await screen.findByLabelText("Model service");
    await waitFor(() => expect(statusFetchMock).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByLabelText("I understand this may use model quota"));
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Authentication task in progress…")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Reopen settings" }));
    expect(await screen.findByText("Authentication task in progress…")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Agent runtime"), "claude");
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
    await screen.findByLabelText("Agent runtime");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Some settings are invalid.");

    await act(async () => finishInitialStatus(reply({ state: "idle", error: null })));
    expect(screen.getByRole("alert").textContent).toContain("Some settings are invalid.");
  });

  it("explains unavailable optional Claude and GitHub tools without blocking direct use", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(reply(settings));
    vi.stubGlobal("fetch", fetchMock);
    setup(fetchMock);
    expect(await screen.findByLabelText("Agent runtime")).toBeTruthy();
    expect(screen.queryByLabelText(/GitHub.*(?:token|access)/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /GitHub.*(?:token|credential)/i })).toBeNull();
  });
});
