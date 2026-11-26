import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeAndPlugins } from "@/components/CodeAndPlugins";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { PluginCatalogItem, WorkspacePlugin } from "@/lib/types";

vi.mock("@/lib/hub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hub")>()),
  listPlugins: vi.fn(),
  listWorkspacePlugins: vi.fn(),
  updateWorkspacePlugin: vi.fn(),
  getComponents: vi.fn(async () => ({ components: [] })),
}));

const readOnly = (name: string, description: string) => ({ name, description, readOnly: true });

const codePlugin: WorkspacePlugin = {
  plugin: {
    id: "code",
    displayName: "graphify",
    dataFlow: "local",
    functions: [
      readOnly("code__search", "Search the repository for code matching a query."),
      readOnly("code__explain", "Explain what a named symbol does in the repository."),
      { name: "code__write", description: "Write a file.", readOnly: false },
    ],
  },
  enabled: true,
  disabledFunctions: ["code__explain"],
};

const githubPlugin: WorkspacePlugin = {
  plugin: {
    id: "github",
    displayName: "GitHub",
    dataFlow: "external",
    functions: [readOnly("issue_read", "Read an issue.")],
  },
  enabled: false,
  disabledFunctions: [],
};

const catalog: PluginCatalogItem[] = [
  {
    id: "code",
    displayName: "graphify",
    dataFlow: "local",
    installed: true,
    detail: "graphify 0.9.0",
    functions: codePlugin.plugin.functions,
  },
  {
    id: "github",
    displayName: "GitHub",
    dataFlow: "external",
    installed: false,
    detail: "令牌不存在",
    functions: githubPlugin.plugin.functions,
  },
];

beforeEach(() => {
  localStorage.clear();
  vi.mocked(hub.listPlugins).mockReset();
  vi.mocked(hub.listWorkspacePlugins).mockReset();
  vi.mocked(hub.updateWorkspacePlugin).mockReset();
  vi.mocked(hub.listPlugins).mockResolvedValue([]);
  vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([]);
  vi.mocked(hub.updateWorkspacePlugin).mockImplementation(async (_id, pluginId, patch) => {
    const current = pluginId === "github" ? githubPlugin : codePlugin;
    return { ...current, ...patch };
  });
});

function mount() {
  render(
    <I18nProvider>
      <CodeAndPlugins workspaceId="w1" graphOfferSignal={0} />
    </I18nProvider>,
  );
}

describe("CodeAndPlugins", () => {
  it("localizes Graphify status using the catalog facts", async () => {
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([codePlugin]);
    vi.mocked(hub.listPlugins).mockResolvedValue([{
      ...catalog[0]!,
      installed: false,
      detail: "Graphify 组件未安装",
      graphifyError: { code: "graphify-unavailable", state: "not-installed", status: { state: "not-installed" } },
    }]);
    mount();

    expect(await screen.findByText("Graphify is not installed. Repository indexing and code search need it. Install it from Settings, or run nema components install graphify.")).toBeTruthy();
  });

  it("localizes an interrupted Graphify catalog check from the HTTP response", async () => {
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([codePlugin]);
    const realHub = await vi.importActual<typeof hub>("@/lib/hub");
    vi.mocked(hub.listPlugins).mockImplementation(realHub.listPlugins);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: "graphify 已中断", graphifyError: { code: "graphify-interrupted" },
    }, { status: 502 })));
    try {
      mount();
      expect(await screen.findByText("Graphify was interrupted.")).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("toggling a function sends PATCH with disabledFunctions", async () => {
    vi.mocked(hub.listPlugins).mockResolvedValue(catalog);
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([codePlugin, githubPlugin]);
    mount();

    expect(await screen.findByText("Installed graphify 0.9.0")).toBeTruthy();
    expect(screen.queryByText("Not installed 令牌不存在")).toBeNull();
    expect(screen.getByText("When on, call contents are sent to an external service")).toBeTruthy();
    expect(screen.getByText("Sends data out").classList.contains("red")).toBe(true);
    expect(screen.getByText("Local only").classList.contains("red")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "graphify" }));
    expect(screen.queryByText("code__write")).toBeNull();
    expect((screen.getByRole("checkbox", { name: /code__explain/ }) as HTMLInputElement).checked).toBe(false);
    await userEvent.click(screen.getByRole("checkbox", { name: /code__search/ }));
    expect(hub.updateWorkspacePlugin).toHaveBeenCalledWith("w1", "code", { disabledFunctions: ["code__explain", "code__search"] });

    await userEvent.click(screen.getByRole("checkbox", { name: "GitHub" }));
    expect(hub.updateWorkspacePlugin).toHaveBeenCalledWith("w1", "github", { enabled: true });
  });

  it("shows the GitHub plugin disabled by default", async () => {
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([githubPlugin]);
    mount();

    const toggle = (await screen.findByRole("checkbox", { name: "GitHub" })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const row = toggle.closest(".plugin-row")!;
    expect(within(row as HTMLElement).getByText("When on, call contents are sent to an external service")).toBeTruthy();
  });

  it("the GitHub write permission starts off and PATCHes allowWrites", async () => {
    vi.mocked(hub.listPlugins).mockResolvedValue(catalog);
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([{ ...githubPlugin, enabled: true, settings: { allowWrites: false } }]);
    vi.mocked(hub.updateWorkspacePlugin).mockImplementation(async (_id, _pluginId, patch) => ({ ...githubPlugin, enabled: true, settings: patch.settings }));
    mount();
    const toggle = (await screen.findByRole("checkbox", { name: /Let the agent change GitHub/ })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await userEvent.click(toggle);
    expect(hub.updateWorkspacePlugin).toHaveBeenCalledWith("w1", "github", { settings: { allowWrites: true } });
  });

  it("the model egress note is always shown", async () => {
    vi.mocked(hub.listWorkspacePlugins).mockRejectedValue(new Error("down"));
    vi.mocked(hub.listPlugins).mockRejectedValue(new Error("down"));
    mount();
    expect(screen.getByText("Code the Agent reads is sent to the model provider (OpenAI / Anthropic) with each request.")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toBe("down");
  });

  it("the grill settings save and enforce the 2000 counter", async () => {
    const grill: WorkspacePlugin = {
      plugin: { id: "grill", displayName: "grill-me", dataFlow: "local", functions: [] },
      enabled: true,
      disabledFunctions: [],
      settings: { strictness: "strict", extraRules: "ask about money" },
    };
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([grill]);
    vi.mocked(hub.updateWorkspacePlugin).mockImplementation(async (_id, _pluginId, patch) => ({ ...grill, settings: patch.settings }));
    mount();
    const box = (await screen.findByRole("textbox", { name: "Extra questioning rules" })) as HTMLTextAreaElement;
    expect(box.value).toBe("ask about money");
    expect(screen.getByTestId("grill-counter").textContent).toBe("15 / 2000");

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Strictness" }), "lenient");
    await userEvent.clear(box);
    await userEvent.type(box, "ask about dates");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.classList.contains("settings-action")).toBe(true);
    await userEvent.click(save);
    expect(hub.updateWorkspacePlugin).toHaveBeenCalledWith("w1", "grill", { settings: { strictness: "lenient", extraRules: "ask about dates" } });

    vi.mocked(hub.updateWorkspacePlugin).mockClear();
    fireEvent.change(box, { target: { value: "x".repeat(2001) } });
    expect(screen.getByTestId("grill-counter").textContent).toBe("2001 / 2000");
    expect(save.disabled).toBe(true);
    await userEvent.click(save);
    expect(hub.updateWorkspacePlugin).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "x".repeat(2000) } });
    expect(save.disabled).toBe(false);
  });
});
