import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetComponentsForTests } from "@/lib/components";
import { I18nProvider } from "@/lib/i18n";
import { WorkspaceSettings } from "@/components/WorkspaceSettings";
import * as hub from "@/lib/hub";
import type { Repo, WorkspaceView } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  updateWorkspace: vi.fn(),
  listShares: vi.fn(async () => ({ shares: [] })),
  createShare: vi.fn(),
  revokeShare: vi.fn(),
  listRepos: vi.fn(),
  pickDirectory: vi.fn(),
  previewRepo: vi.fn(),
  bindRepo: vi.fn(),
  updateRepo: vi.fn(),
  unbindRepo: vi.fn(),
  listPlugins: vi.fn(),
  listWorkspacePlugins: vi.fn(),
  updateWorkspacePlugin: vi.fn(),
  getComponents: vi.fn(async () => ({ components: [] })),
}));

const workspace: WorkspaceView = {
  id: "w1",
  name: "Alpha",
  confidential: true,
  knowledgeLanguage: "follow",
  createdAt: "2026-10-21T00:00:00Z",
  openQuestions: 0,
  archived: false,
};

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
  trustSkills: false,
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  resetComponentsForTests();
  vi.mocked(hub.getComponents).mockResolvedValue({ components: [] });
  vi.mocked(hub.updateWorkspace).mockReset();
  vi.mocked(hub.updateWorkspace).mockImplementation(async (id, patch) => ({ ...workspace, id, ...patch }));
  vi.mocked(hub.listRepos).mockResolvedValue([]);
  vi.mocked(hub.listPlugins).mockResolvedValue([]);
  vi.mocked(hub.listWorkspacePlugins).mockResolvedValue([]);
});

function setup() {
  const onUpdated = vi.fn();
  render(
    <I18nProvider>
      <WorkspaceSettings workspace={workspace} onUpdated={onUpdated} onClose={() => {}} />
    </I18nProvider>,
  );
  return { onUpdated };
}

describe("WorkspaceSettings", () => {
  it("saves the knowledge language", async () => {
    const { onUpdated } = setup();
    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(hub.updateWorkspace).toHaveBeenCalledWith("w1", { knowledgeLanguage: "en" });
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it("saves the confidential toggle", async () => {
    setup();
    const toggle = screen.getByRole("checkbox", { name: /Confidential/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await userEvent.click(toggle);
    expect(hub.updateWorkspace).toHaveBeenCalledWith("w1", { confidential: false });
  });

  it("saves a renamed workspace on blur", async () => {
    setup();
    const input = screen.getByRole("textbox", { name: "Name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Omega");
    await userEvent.tab();
    expect(hub.updateWorkspace).toHaveBeenCalledWith("w1", { name: "Omega" });
  });

  it("shows the help copy", () => {
    setup();
    expect(screen.getByText(/never appear in any cross-project/i)).toBeTruthy();
  });

  it("shows and edits linked repositories in their own settings section", async () => {
    const linked = repo({ id: "r1", path: "/tmp/app", label: "app" });
    vi.mocked(hub.listRepos).mockResolvedValueOnce([linked]);
    vi.mocked(hub.updateRepo).mockResolvedValueOnce({ ...linked, mainBranch: "release" });
    setup();

    const repos = within(screen.getByRole("region", { name: "Repositories" }));
    const code = within(screen.getByRole("region", { name: "Code & plugins" }));
    const branch = await repos.findByRole("textbox", { name: "Main branch /tmp/app" });
    expect((branch as HTMLInputElement).value).toBe("main");
    expect(repos.getByRole("button", { name: "Choose folder" })).toBeTruthy();
    expect(repos.getByRole("button", { name: "Add repository" })).toBeTruthy();
    expect(code.getByRole("heading", { name: "Plugins for this workspace" })).toBeTruthy();
    expect(code.queryByRole("button", { name: "Choose folder" })).toBeNull();
    expect(code.queryByRole("button", { name: "Add repository" })).toBeNull();
    expect(code.queryByRole("textbox", { name: "Main branch /tmp/app" })).toBeNull();

    await userEvent.clear(branch);
    await userEvent.type(branch, "release");
    await userEvent.tab();
    expect(hub.updateRepo).toHaveBeenCalledWith("w1", "r1", { mainBranch: "release" });
  });

  it("groups the fields like model settings and borders the close control", () => {
    setup();
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.classList.contains("settings-action")).toBe(true);
    expect(close.classList.contains("link")).toBe(false);
    expect(document.querySelectorAll(".settings-group").length).toBeGreaterThan(0);
  });
});

describe("WorkspaceSettings Graphify offer", () => {
  const notInstalled = {
    name: "graphify" as const,
    status: { state: "not-installed" as const, name: "graphify" as const, lockHash: "e".repeat(64) },
    offer: { lockHash: "e".repeat(64), totalBytes: 2 * 1024 * 1024, location: "/home/u/.nema/runtime/graphify", hosts: ["github.com"] },
    settings: {
      pythonMirror: { value: null, source: null, config: null },
      pypiBase: { value: null, source: null, config: null },
      offline: { value: false, source: null, config: false },
    },
  };

  beforeEach(() => {
    vi.mocked(hub.getComponents).mockResolvedValue({ components: [notInstalled] });
  });

  it("shows the graph entry without prompting, and binding a repository (its first graph build) opens the offer", async () => {
    vi.mocked(hub.bindRepo).mockResolvedValueOnce(repo({ id: "r1", path: "/real/app", label: "app" }));
    setup();
    const code = within(screen.getByRole("region", { name: "Code & plugins" }));
    const repos = within(screen.getByRole("region", { name: "Repositories" }));
    expect(await code.findByText("Graphify is not installed. Repository indexing and code search need it.")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Download Graphify?" })).toBeNull();
    vi.mocked(hub.pickDirectory).mockResolvedValueOnce({ path: "/tmp/app" });
    vi.mocked(hub.previewRepo).mockResolvedValueOnce({
      root: "/real/app", defaultBranch: "main", hasOrigin: false, remoteUrl: null, label: "app", labelTaken: false,
    });
    await userEvent.click(repos.getByRole("button", { name: "Choose folder" }));
    await userEvent.click(repos.getByRole("button", { name: "Add repository" }));
    expect(await screen.findByRole("dialog", { name: "Download Graphify?" })).toBeTruthy();
    expect(screen.getByText("2.0 MiB")).toBeTruthy();
  });
});
