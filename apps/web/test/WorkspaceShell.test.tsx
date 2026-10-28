import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { forwardRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceShell } from "@/components/WorkspaceShell";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { HubEvent } from "@/lib/types";

const hubHandlers: { onEvent?: (e: HubEvent) => void; onResync?: () => void } = {};
const { replace, scroll, showMessage, HubError, threadOpen, threadFocus, registerMainMessageHandler } = vi.hoisted(() => {
  class HubError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  const scroll = vi.fn();
  return { replace: vi.fn(), scroll, showMessage: vi.fn((message: { id: string }) => scroll(message.id)), HubError, threadOpen: vi.fn(), threadFocus: vi.fn(), registerMainMessageHandler: vi.fn(() => () => {}) };
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
    if (typeof ref === "function") ref({ handleEvent: vi.fn(), resync: vi.fn(), scrollToMessage: scroll, showMessage });
    else if (ref) (ref as { current: unknown }).current = { handleEvent: vi.fn(), resync: vi.fn(), scrollToMessage: scroll, showMessage };
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
  window.history.replaceState(null, "", "/");
  scroll.mockClear(); showMessage.mockClear();
  vi.mocked(hub.listWorkspaces).mockResolvedValue([
    { id: "w1", name: "Alpha", confidential: false, knowledgeLanguage: "follow", createdAt: "x", openQuestions: 0, archived: false },
  ]);
  vi.mocked(hub.getDaemonStatus).mockResolvedValue({ connected: true });
});

const mount = async (routeId = "w1") => {
  render(
    <I18nProvider>
      <WorkspaceShell routeId={routeId} />
    </I18nProvider>,
  );
  await act(async () => {});
};
const changed = (entryId: string) => act(async () => hubHandlers.onEvent!({ type: "knowledge.changed", entryId }));
const setMainTarget = (hash: string, path = "/w/ws_1") => {
  window.history.replaceState(null, "", `${path}#${hash}`);
  act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
};

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
  it("consumes same-path main-source hash changes and lets the newest in-flight target win", async () => {
    let resolveFirst!: (message: never) => void;
    let resolveSecond!: (message: never) => void;
    vi.mocked(hub.getMessage).mockImplementation((_workspaceId, id) => new Promise((resolve) => {
      if (id === "m_first") resolveFirst = resolve as (message: never) => void;
      if (id === "m_second") resolveSecond = resolve as (message: never) => void;
    }));
    vi.mocked(hub.listWorkspaces).mockResolvedValue([{ id: "ws_1", name: "Canonical Alpha", confidential: false, knowledgeLanguage: "follow", createdAt: "x", openQuestions: 0, archived: false }]);
    await mount("ws_1");
    setMainTarget("workspace=ws_1&message=m_first");
    setMainTarget("workspace=ws_1&message=m_second");
    expect(hub.getMessage).toHaveBeenCalledWith("ws_1", "m_first");
    expect(hub.getMessage).toHaveBeenCalledWith("ws_1", "m_second");

    await act(async () => resolveFirst({ id: "m_first", workspaceId: "ws_1", role: "user", content: "first", meta: null, taskId: null, createdAt: "x", editedAt: null, threadId: null, seq: 1 } as never));
    expect(window.location.hash).toBe("#workspace=ws_1&message=m_second");
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => resolveSecond({ id: "m_second", workspaceId: "ws_1", role: "user", content: "second", meta: null, taskId: null, createdAt: "x", editedAt: null, threadId: null, seq: 2 } as never));
    expect(showMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "m_second" }));
    expect(scroll).toHaveBeenCalledWith("m_second");
    expect(window.location.hash).toBe("");
  });
  it.each([
    ["workspace=ws_2&message=m_1", "/w/ws_1"],
    ["workspace=ws_1&workspace=ws_1&message=m_1", "/w/ws_1"],
    ["workspace=ws_1&message=m_1&extra=1", "/w/ws_1"],
    ["workspace=ws_1&message=invalid", "/w/ws_1"],
    ["workspace=ws_1&message=m_1", "/w/ws_2"],
  ])("ignores foreign or malformed main-source hash %s at %s", async (hash, path) => {
    vi.mocked(hub.listWorkspaces).mockResolvedValue([{ id: "ws_1", name: "Canonical Alpha", confidential: false, knowledgeLanguage: "follow", createdAt: "x", openQuestions: 0, archived: false }]);
    await mount("ws_1");
    setMainTarget(hash, path);
    expect(hub.getMessage).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#${hash}`);
    expect(scroll).not.toHaveBeenCalled();
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
  it("opens model settings across the main area, not the knowledge column", async () => {
    vi.mocked(hub.listWorkspaces).mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      config: { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium" },
      auth: { mode: "siwc", credential: "siwc", state: "missing", adapter: "codex-direct" },
      tools: { claude: { available: false, tokenSaved: false }, github: { available: false, tokenSaved: false } },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    localStorage.setItem("nema.locale", "en");
    render(<I18nProvider><WorkspaceShell routeId={null} /></I18nProvider>);
    const opener = await screen.findByRole("button", { name: "App settings" });
    await userEvent.click(opener);
    const panel = await screen.findByRole("tabpanel", { name: "Model" });
    expect(panel.closest(".app-settings")).toBeTruthy();
    expect(panel.closest(".know-col")).toBeNull();
    expect(panel.querySelector(".model-settings")?.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Model settings" })).toBeNull();
    expect((screen.getByLabelText("Model provider") as HTMLSelectElement).value).toBe("chatgpt");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tabpanel", { name: "Model" })).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
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
  it("opens message search from the header icon", async () => {
    await mount();
    const search = screen.getByRole("button", { name: "Search messages" });
    expect(search.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(search);
    expect(search.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(search);
    expect(search.getAttribute("aria-expanded")).toBe("false");
  });
});
