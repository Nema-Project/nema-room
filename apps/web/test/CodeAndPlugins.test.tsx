import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeAndPlugins } from "@/components/CodeAndPlugins";
import { formatDay, formatTime } from "@/lib/format";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { PluginCatalogItem, Repo, WorkspacePlugin } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  listRepos: vi.fn(),
  bindRepo: vi.fn(),
  updateRepo: vi.fn(),
  unbindRepo: vi.fn(),
  listPlugins: vi.fn(),
  listWorkspacePlugins: vi.fn(),
  updateWorkspacePlugin: vi.fn(),
}));

const repo = (extra: Partial<Repo> & Pick<Repo, "id" | "path" | "label">): Repo => ({
  workspaceId: "w1",
  gitCommonDir: extra.path,
  mainBranch: "main",
  hasOrigin: true,
  remoteUrl: null,
  githubTarget: null,
  lastMainSha: null,
  lastFetchAt: null,
  lastFetchError: null,
  ...extra,
});

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
  vi.mocked(hub.listRepos).mockReset();
  vi.mocked(hub.bindRepo).mockReset();
  vi.mocked(hub.updateRepo).mockReset();
  vi.mocked(hub.unbindRepo).mockReset();
  vi.mocked(hub.listPlugins).mockReset();
  vi.mocked(hub.listWorkspacePlugins).mockReset();
  vi.mocked(hub.updateWorkspacePlugin).mockReset();
  vi.mocked(hub.listRepos).mockResolvedValue([]);
  vi.mocked(hub.listPlugins).mockResolvedValue([]);
  vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([]);
  vi.mocked(hub.updateRepo).mockImplementation(async (id, repoId, patch) => repo({ id: repoId, workspaceId: id, path: `/tmp/${repoId}`, label: "app", ...patch }));
  vi.mocked(hub.unbindRepo).mockResolvedValue(undefined);
  vi.mocked(hub.updateWorkspacePlugin).mockImplementation(async (_id, pluginId, patch) => {
    const current = pluginId === "github" ? githubPlugin : codePlugin;
    return { ...current, ...patch };
  });
});

function mount() {
  render(
    <I18nProvider>
      <CodeAndPlugins workspaceId="w1" />
    </I18nProvider>,
  );
}

async function fill(path: string, label: string, mainBranch = "") {
  await userEvent.type(screen.getByRole("textbox", { name: "Local path" }), path);
  await userEvent.type(screen.getByRole("textbox", { name: "Label" }), label);
  if (mainBranch) await userEvent.type(screen.getByRole("textbox", { name: "Main branch" }), mainBranch);
}

describe("CodeAndPlugins", () => {
  it("adds a repo and shows the hub's 409 message inline", async () => {
    const created = repo({ id: "r1", path: "/tmp/app", label: "app", mainBranch: "develop" });
    vi.mocked(hub.bindRepo).mockResolvedValueOnce(created).mockRejectedValueOnce(new Error("该仓库已绑定到 workspace Alpha"));
    mount();
    await screen.findByRole("button", { name: "Add repository" });

    await fill("/tmp/app", "app", "develop");
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));

    expect(hub.bindRepo).toHaveBeenCalledWith("w1", { path: "/tmp/app", label: "app", mainBranch: "develop" });
    const path = await screen.findByText("/tmp/app");
    expect(path.classList.contains("repo-path")).toBe(true);
    expect((screen.getByRole("textbox", { name: "Local path" }) as HTMLInputElement).value).toBe("");

    await fill("/tmp/dup", "dup");
    await userEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect((await screen.findByRole("alert")).textContent).toBe("该仓库已绑定到 workspace Alpha");
    expect((screen.getByRole("textbox", { name: "Local path" }) as HTMLInputElement).value).toBe("/tmp/dup");
    expect((screen.getByRole("textbox", { name: "Label" }) as HTMLInputElement).value).toBe("dup");
    expect(hub.bindRepo).toHaveBeenLastCalledWith("w1", { path: "/tmp/dup", label: "dup" });
  });

  it("shows no origin and fetch failure states", async () => {
    const fetchedAt = "2026-10-23T01:00:00.000Z";
    vi.mocked(hub.listRepos).mockResolvedValue([
      repo({ id: "r-local", path: "/tmp/local", label: "local", hasOrigin: false, lastFetchAt: fetchedAt, lastFetchError: "没有 origin" }),
      repo({ id: "r-fail", path: "/tmp/remote", label: "remote", mainBranch: "trunk", lastFetchAt: fetchedAt, lastFetchError: "origin unreachable" }),
      repo({ id: "r-ok", path: "/tmp/ok", label: "ok", lastFetchAt: fetchedAt }),
    ]);
    mount();

    expect(await screen.findByText("No origin; using the local branch")).toBeTruthy();
    expect(screen.queryByText(/没有 origin/)).toBeNull();
    const at = new Date(fetchedAt);
    const lastFetched = `Last fetched ${formatDay(at, "en")} ${formatTime(at, "en")}`;
    expect(screen.getByText(`Fetch failed origin unreachable · ${lastFetched}`)).toBeTruthy();
    expect(screen.getByText(lastFetched)).toBeTruthy();

    const label = screen.getByRole("textbox", { name: "Label /tmp/local" });
    await userEvent.clear(label);
    await userEvent.type(label, "renamed");
    await userEvent.tab();
    expect(hub.updateRepo).toHaveBeenCalledWith("w1", "r-local", { label: "renamed" });

    const branch = screen.getByRole("textbox", { name: "Main branch /tmp/ok" });
    await userEvent.clear(branch);
    await userEvent.type(branch, "release");
    await userEvent.tab();
    expect(hub.updateRepo).toHaveBeenCalledWith("w1", "r-ok", { mainBranch: "release" });

    await userEvent.click(screen.getByRole("button", { name: "Delete /tmp/remote" }));
    expect(hub.unbindRepo).toHaveBeenCalledWith("w1", "r-fail");
    expect(screen.queryByText("/tmp/remote")).toBeNull();
  });

  it("toggling a function sends PATCH with disabledFunctions", async () => {
    vi.mocked(hub.listPlugins).mockResolvedValue(catalog);
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([codePlugin, githubPlugin]);
    mount();

    expect(await screen.findByText("Installed graphify 0.9.0")).toBeTruthy();
    expect(screen.getByText("Not installed 令牌不存在")).toBeTruthy();
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

  it("the workspace page shows the GitHub target per repo and starts the toggle off", async () => {
    vi.mocked(hub.listRepos).mockResolvedValue([
      repo({ id: "r-gh", path: "/tmp/gh", label: "gh", remoteUrl: "git@github.com:Acme/App.git", githubTarget: "acme/app" }),
      repo({ id: "r-gl", path: "/tmp/gl", label: "gl", remoteUrl: "https://gitlab.com/acme/app.git", githubTarget: null }),
    ]);
    vi.mocked(hub.listPlugins).mockResolvedValue(catalog);
    vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([codePlugin, githubPlugin]);
    mount();

    const gh = (await screen.findByText("/tmp/gh")).closest(".repo-row")!;
    expect(within(gh as HTMLElement).getByText("acme/app")).toBeTruthy();
    expect(within(gh as HTMLElement).queryByText("No GitHub remote")).toBeNull();
    const gl = screen.getByText("/tmp/gl").closest(".repo-row")!;
    expect(within(gl as HTMLElement).getByText("No GitHub remote")).toBeTruthy();

    const toggle = (await screen.findByRole("checkbox", { name: "GitHub" })) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    const row = toggle.closest(".plugin-row")!;
    expect(within(row as HTMLElement).getByText("When on, call contents are sent to an external service")).toBeTruthy();
  });

  it("the GitHub write permission starts off and PATCHes allowWrites", async () => {
    vi.mocked(hub.listRepos).mockResolvedValue([]);
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
    vi.mocked(hub.listRepos).mockRejectedValue(new Error("down"));
    vi.mocked(hub.listPlugins).mockRejectedValue(new Error("down"));
    mount();
    expect(screen.getByText("Code the Agent reads is sent to the model provider (OpenAI / Anthropic) with each request.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Code & plugins" })).toBeTruthy();
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
