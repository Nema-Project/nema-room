import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { I18nProvider } from "@/lib/i18n";
import { Sidebar } from "@/components/Sidebar";
import type { WorkspaceView } from "@/lib/types";

const ws = (id: string, name: string, extra: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id,
  name,
  confidential: false,
  knowledgeLanguage: "follow",
  createdAt: "2026-10-21T00:00:00Z",
  openQuestions: 0,
  archived: false,
  ...extra,
});
const list = [ws("w1", "Alpha", { confidential: true, openQuestions: 1 }), ws("w2", "Beta"), ws("w3", "Gamma"), ws("w4", "Delta", { archived: true })];

beforeEach(() => localStorage.clear());

function setup(props: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  const onSelect = vi.fn();
  const onCreate = vi.fn();
  const onArchive = vi.fn();
  const onDelete = vi.fn();
  render(
    <I18nProvider>
      <Sidebar workspaces={list} selectedId="w1" connected={true} onSelect={onSelect} onCreate={onCreate} onArchive={onArchive} onDelete={onDelete} {...props} />
    </I18nProvider>,
  );
  return { onSelect, onCreate, onArchive, onDelete };
}

describe("Sidebar", () => {
  it("marks the selected workspace, confidential workspaces and open-question counts", () => {
    setup();
    const alpha = screen.getByRole("button", { name: /Alpha/ });
    expect(alpha.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /Beta/ }).getAttribute("aria-current")).toBeNull();
    expect(within(alpha).getByTestId("confidential-mark")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /Beta/ })).queryByTestId("confidential-mark")).toBeNull();
    expect(within(alpha).getByTestId("open-questions").textContent).toBe("1");
    expect(within(screen.getByRole("button", { name: /Gamma/ })).queryByTestId("open-questions")).toBeNull();
  });

  it("shows agent online / offline", () => {
    setup({ connected: false });
    expect(screen.getByText("nema daemon offline")).toBeTruthy();
  });

  it("switches the UI language", async () => {
    setup({ connected: false });
    await userEvent.click(screen.getByRole("button", { name: "日本語" }));
    expect(await screen.findByText("nema daemon オフライン")).toBeTruthy();
    expect(localStorage.getItem("nema.locale")).toBe("ja");
  });

  it("selects a workspace and creates one by name", async () => {
    const { onSelect, onCreate } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(onSelect).toHaveBeenCalledWith("w2");
    await userEvent.click(screen.getByRole("button", { name: /New workspace/ }));
    await userEvent.type(screen.getByRole("textbox"), "Delta{Enter}");
    expect(onCreate).toHaveBeenCalledWith("Delta");
  });

  it("keeps the form and typed name open when creation fails", async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error("boom"));
    setup({ onCreate });
    await userEvent.click(screen.getByRole("button", { name: /New workspace/ }));
    await userEvent.type(screen.getByRole("textbox"), "Delta{Enter}");
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Delta");
  });

  it("hides archived workspaces behind a collapsed group", () => {
    setup();
    expect(screen.queryByRole("button", { name: /Delta/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Archived 1" })).toBeTruthy();
  });

  it("right-click archives without a dialog and delete asks first", async () => {
    const { onSelect, onArchive, onDelete } = setup();
    const alpha = screen.getByRole("button", { name: /Alpha/ });
    const event = createEvent.contextMenu(alpha);
    fireEvent(alpha, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    const menu = screen.getByRole("menu");
    const del = within(menu).getByRole("menuitem", { name: "Delete" });
    expect(getComputedStyle(del).color).toBe("rgb(227, 36, 27)");

    await userEvent.click(del);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Alpha");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    await userEvent.click(cancel);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.contextMenu(alpha);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("w1");

    fireEvent.contextMenu(alpha);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Archive" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onArchive).toHaveBeenCalledWith("w1", true);
  });

  it("unarchives from the archived group and Escape closes the menu", async () => {
    const { onArchive, onDelete } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Archived 1" }));
    fireEvent.contextMenu(screen.getByRole("button", { name: /Delta/ }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Unarchive" }));
    expect(onArchive).toHaveBeenCalledWith("w4", false);

    fireEvent.contextMenu(screen.getByRole("button", { name: /Alpha/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("keeps keyboard focus inside the menu and the delete dialog", async () => {
    const { onDelete } = setup();
    const alpha = screen.getByRole("button", { name: /Alpha/ });
    fireEvent.contextMenu(alpha);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Archive" }));

    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBe(document.activeElement);
    await userEvent.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBe(document.activeElement);
    expect(onDelete).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(alpha);
    expect(onDelete).not.toHaveBeenCalled();
  });
});
