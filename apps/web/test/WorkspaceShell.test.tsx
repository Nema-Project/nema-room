import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { HubEvent } from "@/lib/types";

const hubHandlers: { onEvent?: (e: HubEvent) => void; onResync?: () => void } = {};
const scroll = vi.fn();
const { replace, HubError, threadOpen, threadFocus, registerMainMessageHandler } = vi.hoisted(() => {
  class HubError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return { replace: vi.fn(), HubError, threadOpen: vi.fn(), threadFocus: vi.fn(), registerMainMessageHandler: vi.fn(() => () => {}) };
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace }) }));
vi.mock("@/lib/hub", () => ({
  listWorkspaces: vi.fn(),
  getDaemonStatus: vi.fn(),
  createWorkspace: vi.fn(),
  archiveWorkspace: vi.fn(),
  deleteWorkspace: vi.fn(),
  getMessage: vi.fn(),
  HubError,
}));
vi.mock("@/lib/useHubEvents", () => ({
  useHubEvents: (_id: string | null, onEvent: (e: HubEvent) => void, onResync: () => void) => {
    hubHandlers.onEvent = onEvent;
    hubHandlers.onResync = onResync;
  },
}));
vi.mock("@/components/ThreadWindowsProvider", () => ({ useThreadWindows: () => ({ open: threadOpen, focus: threadFocus, registerMainMessageHandler }) }));
vi.mock("@/components/Chat", () => ({
  Chat: forwardRef(function Chat(_p: unknown, ref: React.Ref<unknown>) {
    if (typeof ref === "function") ref({ handleEvent: vi.fn(), resync: vi.fn(), scrollToMessage: scroll });
    else if (ref) (ref as { current: unknown }).current = { handleEvent: vi.fn(), resync: vi.fn(), scrollToMessage: scroll };
    return <div />;
  }),
}));
vi.mock("@/components/KnowledgePanel", () => ({
  KnowledgePanel: (p: { refreshKey?: number; onOpen: (id: string) => void }) => (
    <div>
      <span data-testid="panel-key">{p.refreshKey}</span>
      <button onClick={() => p.onOpen("R-1")}>open R-1</button>
    </div>
  ),
  groupOf: () => "pending",
}));
vi.mock("@/components/EntryDetail", () => ({
  EntryDetail: (p: { refreshKey?: number; onJumpToMessage: (id: string) => void }) => (
    <div>
      <span data-testid="detail-key">{p.refreshKey}</span>
      <button onClick={() => p.onJumpToMessage("m_1")}>jump</button>
    </div>
  ),
}));

beforeEach(() => {
  vi.mocked(hub.listWorkspaces).mockResolvedValue([
    { id: "w1", name: "Alpha", confidential: false, knowledgeLanguage: "follow", createdAt: "x", openQuestions: 0, archived: false },
  ]);
  vi.mocked(hub.getDaemonStatus).mockResolvedValue({ connected: true });
});

const mount = async () => {
  render(
    <I18nProvider>
      <WorkspaceShell routeId="w1" />
    </I18nProvider>,
  );
  await act(async () => {});
};
const changed = (entryId: string) => act(async () => hubHandlers.onEvent!({ type: "knowledge.changed", entryId }));

describe("WorkspaceShell knowledge wiring", () => {
  it("refreshes the panel on knowledge.changed", async () => {
    await mount();
    expect(screen.getByTestId("panel-key").textContent).toBe("0");
    await changed("R-5");
    expect(screen.getByTestId("panel-key").textContent).toBe("1");
  });
  it("refreshes the detail only when the open entry changed", async () => {
    await mount();
    await userEvent.click(screen.getByText("open R-1"));
    expect(screen.getByTestId("detail-key").textContent).toBe("0");
    await changed("R-2");
    expect(screen.getByTestId("detail-key").textContent).toBe("0");
    await changed("R-1");
    expect(screen.getByTestId("detail-key").textContent).toBe("1");
  });
  it("refreshes the panel when a task finishes, not while it runs, and never bumps the open entry", async () => {
    await mount();
    const task = (status: string) => act(async () => hubHandlers.onEvent!({ type: "task.updated", task: { id: "t1", status } } as never));
    await task("running");
    expect(screen.getByTestId("panel-key").textContent).toBe("0");
    await task("done");
    expect(screen.getByTestId("panel-key").textContent).toBe("1");
    await task("failed");
    expect(screen.getByTestId("panel-key").textContent).toBe("2");
    // knowledge.changed (not task.updated) is what refreshes an open entry; no false "changed" notice.
    await userEvent.click(screen.getByText("open R-1"));
    const before = screen.getByTestId("detail-key").textContent;
    await task("done");
    await task("failed");
    expect(screen.getByTestId("detail-key").textContent).toBe(before);
  });
  it("refreshes both on resync", async () => {
    await mount();
    await act(async () => hubHandlers.onResync!());
    expect(screen.getByTestId("panel-key").textContent).toBe("1");
    await userEvent.click(screen.getByText("open R-1"));
    const before = Number(screen.getByTestId("detail-key").textContent);
    await act(async () => hubHandlers.onResync!());
    expect(Number(screen.getByTestId("detail-key").textContent)).toBe(before + 1);
  });
  it("drags the knowledge panel wider", async () => {
    localStorage.setItem("nema.locale", "en");
    await mount();
    const frame = document.querySelector(".frame") as HTMLElement;
    const handle = screen.getByRole("separator", { name: "Resize knowledge panel" });
    const col = handle.parentElement as HTMLElement;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ width: 1200, height: 800, x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, toJSON() { return {}; } });
    vi.spyOn(col, "getBoundingClientRect").mockReturnValue({ width: 380, height: 800, x: 820, y: 0, top: 0, left: 820, right: 1200, bottom: 800, toJSON() { return {}; } });
    fireEvent.pointerDown(handle, { button: 0, clientX: 820, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 740, pointerId: 1 });
    expect(frame.style.getPropertyValue("--know-width")).toBe("460px");
    expect(localStorage.getItem("nema.knowWidth")).toBe("460");
  });
  it("collapses a column when its divider is dragged below 160px", async () => {
    localStorage.setItem("nema.locale", "en");
    await mount();
    const frame = document.querySelector(".frame") as HTMLElement;
    const box = { height: 800, x: 0, y: 0, top: 0, bottom: 800, toJSON() { return {}; } };
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ ...box, width: 1200, left: 0, right: 1200 });
    const know = screen.getByRole("separator", { name: "Resize knowledge panel" });
    vi.spyOn(know.parentElement!, "getBoundingClientRect").mockReturnValue({ ...box, width: 380, left: 820, right: 1200 });
    fireEvent.pointerDown(know, { button: 0, clientX: 820, pointerId: 1 });
    fireEvent.pointerMove(know, { clientX: 1070, pointerId: 1 });
    expect(frame.style.getPropertyValue("--know-width")).toBe("12px");
    expect(document.querySelector(".know-col")!.classList.contains("is-collapsed")).toBe(true);

    const side = screen.getByRole("separator", { name: "Resize workspace list" });
    vi.spyOn(side.parentElement!, "getBoundingClientRect").mockReturnValue({ ...box, width: 232, left: 0, right: 232 });
    fireEvent.pointerDown(side, { button: 0, clientX: 232, pointerId: 1 });
    fireEvent.pointerMove(side, { clientX: 80, pointerId: 1 });
    expect(frame.style.getPropertyValue("--side-width")).toBe("12px");
    expect(document.querySelector(".side-col")!.classList.contains("is-collapsed")).toBe(true);
  });
  it("collapses and expands a column from its button", async () => {
    localStorage.setItem("nema.locale", "en");
    localStorage.removeItem("nema.sideCollapsed");
    localStorage.removeItem("nema.knowCollapsed");
    await mount();
    const frame = document.querySelector(".frame") as HTMLElement;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ width: 1200, height: 800, x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 800, toJSON() { return {}; } });
    await userEvent.click(screen.getByRole("button", { name: "Collapse workspace list" }));
    expect(document.querySelector(".side-col")!.classList.contains("is-collapsed")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Expand workspace list" }));
    expect(document.querySelector(".side-col")!.classList.contains("is-collapsed")).toBe(false);
    expect(screen.getByRole("button", { name: "Settings" }).querySelector("svg")).toBeTruthy();
  });
  it("widens the frame and jumps to a source message", async () => {
    await mount();
    await userEvent.click(screen.getByText("open R-1"));
    expect(document.querySelector(".frame")!.classList.contains("entry-open")).toBe(true);
    await userEvent.click(screen.getByText("jump"));
    expect(scroll).toHaveBeenCalledWith("m_1");
  });
  it("passes the source message id through when opening its thread", async () => {
    vi.mocked(hub.getMessage).mockResolvedValue({ id: "m_1", workspaceId: "w1", role: "user", content: "source", meta: null, taskId: null, createdAt: "x", editedAt: null, threadId: "t_1", seq: 9 } as never);
    await mount(); await userEvent.click(screen.getByText("open R-1")); await userEvent.click(screen.getByText("jump"));
    await vi.waitFor(() => expect(threadOpen).toHaveBeenCalledWith("w1", "t_1", "m_1"));
  });
  it("resolves a source even when its DOM node exists only in an inactive floating thread", async () => {
    vi.mocked(hub.getMessage).mockResolvedValue({ id: "m-floating", workspaceId: "w1", role: "user", content: "source", meta: null, taskId: null, createdAt: "x", editedAt: null, threadId: "t-floating", seq: 23 } as never);
    const floatingOnly = document.createElement("div"); floatingOnly.id = "msg-m-floating"; floatingOnly.className = "thread-floating"; document.body.append(floatingOnly);
    await mount(); await userEvent.click(screen.getByText("open R-1")); await userEvent.click(screen.getByText("jump"));
    await vi.waitFor(() => expect(threadOpen).toHaveBeenCalledWith("w1", "t-floating", "m-floating"));
    expect(scroll).not.toHaveBeenCalledWith("m-floating");
    floatingOnly.remove();
  });
  it("leaves an archived room for the next active workspace", async () => {
    replace.mockClear();
    vi.mocked(hub.listWorkspaces).mockResolvedValue([
      { id: "w-old", name: "Old", confidential: false, knowledgeLanguage: "follow", createdAt: "x", openQuestions: 0, archived: true },
      { id: "w2", name: "Next", confidential: false, knowledgeLanguage: "follow", createdAt: "y", openQuestions: 0, archived: false },
    ]);
    render(
      <I18nProvider>
        <WorkspaceShell routeId="w-old" />
      </I18nProvider>,
    );
    await act(async () => {});
    expect(replace).toHaveBeenCalledWith("/w/w2");
    expect(screen.queryByRole("heading", { name: "Old" })).toBeNull();
  });
  it("opens model settings from the sidebar when the workspace list is empty", async () => {
    vi.mocked(hub.listWorkspaces).mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      config: { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium" },
      auth: { mode: "siwc", credential: "siwc", state: "missing", adapter: "codex-direct" },
      tools: { claude: { available: false, tokenSaved: false }, github: { available: false, tokenSaved: false } },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    localStorage.setItem("nema.locale", "en");
    render(<I18nProvider><WorkspaceShell routeId={null} /></I18nProvider>);
    await userEvent.click(await screen.findByRole("button", { name: "Model settings" }));
    expect(await screen.findByRole("dialog", { name: "Model settings" })).toBeTruthy();
    expect((screen.getByLabelText("Model provider") as HTMLSelectElement).value).toBe("chatgpt");
  });
  it("refreshes the list when delete fails and shows the hub error", async () => {
    vi.mocked(hub.deleteWorkspace).mockRejectedValue(new HubError(500, "internal error"));
    await mount();
    const before = vi.mocked(hub.listWorkspaces).mock.calls.length;
    const alpha = screen.getByRole("button", { name: /Alpha/ });
    fireEvent(alpha, createEvent.contextMenu(alpha));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(vi.mocked(hub.listWorkspaces).mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByRole("alert").textContent).toBe("internal error");
  });
});
