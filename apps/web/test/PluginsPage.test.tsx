import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginsPage } from "@/components/PluginsPage";
import { Sidebar } from "@/components/Sidebar";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { PluginCatalogItem, WorkspaceView } from "@/lib/types";

vi.mock("@/lib/hub", () => ({ listPlugins: vi.fn() }));

const fn = (name: string, description: string): PluginCatalogItem["functions"][number] => ({
  name,
  description,
  readOnly: true,
});

const catalog: PluginCatalogItem[] = [
  {
    id: "code",
    displayName: "graphify",
    dataFlow: "local",
    installed: true,
    detail: "graphify 0.9.0",
    functions: [
      fn("code__search", "Search the repository for code matching a query."),
      fn("code__explain", "Explain what a named symbol does in the repository."),
      fn("code__path", "Show the path from one symbol to another in the repository."),
      fn("code__read", "Read a file from the repository, optionally limited to a line range."),
      fn("code__changes", "List changes in the repository between two refs."),
    ],
  },
  {
    id: "github",
    displayName: "GitHub",
    dataFlow: "external",
    installed: false,
    detail: "令牌不存在",
    functions: [fn("issue_read", "Read an issue.")],
  },
];

const ws = (id: string, name: string): WorkspaceView => ({
  id,
  name,
  confidential: false,
  knowledgeLanguage: "follow",
  createdAt: "2026-10-21T00:00:00Z",
  openQuestions: 0,
  archived: false,
});

beforeEach(() => {
  localStorage.clear();
  vi.mocked(hub.listPlugins).mockReset();
  vi.mocked(hub.listPlugins).mockResolvedValue(catalog);
});

describe("PluginsPage", () => {
  it("lists graphify as local only with its five functions and install status", async () => {
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "graphify" })).toBeTruthy();
    expect(screen.getByText("Local only").classList.contains("red")).toBe(false);
    expect(screen.getByText("Installed graphify 0.9.0")).toBeTruthy();
    for (const item of catalog[0]!.functions) {
      expect(screen.getByText(item.name)).toBeTruthy();
      expect(screen.getByText(item.description)).toBeTruthy();
    }
    expect(screen.getByText("Sends data out").classList.contains("red")).toBe(true);
    expect(screen.getByText("Not installed 令牌不存在")).toBeTruthy();
    expect(screen.getByText("issue_read")).toBeTruthy();
  });

  it("the plugins page shows GitHub as sends data out, with the login hint when no token", async () => {
    vi.mocked(hub.listPlugins).mockResolvedValue([catalog[0]!, { ...catalog[1]!, loggedIn: false }]);
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    const heading = await screen.findByRole("heading", { name: "GitHub" });
    const block = heading.closest("section")!;
    expect(within(block).getByText("Sends data out").classList.contains("red")).toBe(true);
    expect(within(block).getByText("No token")).toBeTruthy();
    expect(within(block).getByText("Run this in a terminal and paste a personal access token on stdin")).toBeTruthy();
    expect(within(block).getByText("nema auth github").tagName).toBe("CODE");
    expect(within(block).queryByText("Token saved")).toBeNull();
    // graphify has no login state.
    const graphify = screen.getByRole("heading", { name: "graphify" }).closest("section")!;
    expect(within(graphify).queryByText("No token")).toBeNull();
  });

  it("the plugins page shows a saved GitHub token without the hint", async () => {
    vi.mocked(hub.listPlugins).mockResolvedValue([{ ...catalog[1]!, installed: true, detail: "v1.0.0", loggedIn: true }]);
    render(
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>,
    );

    expect(await screen.findByText("Token saved")).toBeTruthy();
    expect(screen.queryByText("No token")).toBeNull();
    expect(screen.queryByText("nema auth github")).toBeNull();
  });

  it("opens from the sidebar plugins entry", async () => {
    render(
      <I18nProvider>
        <Sidebar workspaces={[ws("w1", "Alpha")]} selectedId="w1" connected onSelect={() => {}} onCreate={() => {}} onArchive={() => {}} onDelete={() => {}} />
      </I18nProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(await screen.findByRole("heading", { name: "graphify" })).toBeTruthy();
    expect(hub.listPlugins).toHaveBeenCalledOnce();
  });
});
