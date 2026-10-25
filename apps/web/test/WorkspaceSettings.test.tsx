import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { WorkspaceSettings } from "@/components/WorkspaceSettings";
import * as hub from "@/lib/hub";
import type { WorkspaceView } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  updateWorkspace: vi.fn(),
  listRepos: vi.fn(),
  pickDirectory: vi.fn(),
  bindRepo: vi.fn(),
  updateRepo: vi.fn(),
  unbindRepo: vi.fn(),
  listPlugins: vi.fn(),
  listWorkspacePlugins: vi.fn(),
  updateWorkspacePlugin: vi.fn(),
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

beforeEach(() => {
  localStorage.clear();
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

  it("includes the code and plugins section", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Code & plugins" })).toBeTruthy();
  });
});
