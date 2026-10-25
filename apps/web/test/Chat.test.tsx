import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, type ChatHandle } from "@/components/Chat";
import { I18nProvider, LOCALE_STORAGE_KEY } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { Message } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  listMessages: vi.fn(),
  postMessage: vi.fn(),
  getActiveTask: vi.fn(),
  getEntry: vi.fn(),
  editMessage: vi.fn(),
  listMessageVersions: vi.fn(),
  searchMessages: vi.fn(),
  HubError: class HubError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
const running = { id: "t1", workspaceId: "w1", messageId: "a", status: "running" as const, error: null };

const m = (id: string, content: string, role: Message["role"] = "user"): Message => ({
  id, workspaceId: "w1", role, content, meta: null, taskId: null, createdAt: "2026-10-21T14:00:00Z", editedAt: null, threadId: null, seq: 1,
});

beforeEach(() => {
  vi.mocked(hub.listMessages).mockResolvedValue([m("a", "hello")]);
  vi.mocked(hub.getActiveTask).mockResolvedValue({ running: null });
});

const mount = async (connected: boolean) => {
  const ref = createRef<ChatHandle>();
  render(
    <I18nProvider>
      <Chat ref={ref} workspaceId="w1" connected={connected} />
    </I18nProvider>,
  );
  await act(async () => {});
  return ref;
};

describe("Chat", () => {
  it("shows the offline banner only when disconnected", async () => {
    await mount(false);
    expect(screen.getByRole("status").textContent).toContain("nema daemon");
  });
  it("hides the banner when connected", async () => {
    await mount(true);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("shows progress for a running task and refetches on resync", async () => {
    const ref = await mount(true);
    act(() => ref.current!.handleEvent({ type: "task.updated", task: { id: "t1", workspaceId: "w1", messageId: "a", status: "running", error: null } }));
    act(() => ref.current!.handleEvent({ type: "task.progress", taskId: "t1", text: "更新 R-7" }));
    expect(screen.getByText(/更新 R-7/)).toBeTruthy();
    const n = vi.mocked(hub.listMessages).mock.calls.length;
    await act(async () => ref.current!.resync());
    expect(vi.mocked(hub.listMessages).mock.calls.length).toBe(n + 1);
  });
  it("appends SSE messages once", async () => {
    const ref = await mount(true);
    act(() => ref.current!.handleEvent({ type: "message.created", message: m("b", "new one") }));
    act(() => ref.current!.handleEvent({ type: "message.created", message: m("b", "new one") }));
    expect(screen.getAllByText("new one")).toHaveLength(1);
  });
  it("message.updated replaces a report's pending check with the stored one", async () => {
    const ref = await mount(true);
    const report = { agent: "codex", gitCommonDir: "/g", summary: "did it", entries: [], commits: ["abcdef1"], files: [] };
    const pending: Message = { ...m("rep", "did it", "report"), meta: { report, check: null } };
    act(() => ref.current!.handleEvent({ type: "message.created", message: pending }));
    expect(screen.getByText("Checking…")).toBeTruthy();
    const check = { commitsExist: true, missingCommits: [], onMain: "yes" as const, filesOk: true, untouchedFiles: [], touchedFiles: [], checkedAt: "2026-10-23T10:00:00Z", mainSha: "b".repeat(40) };
    act(() => ref.current!.handleEvent({ type: "message.updated", message: { ...pending, meta: { report, check } } }));
    expect(screen.queryByText("Checking…")).toBeNull();
    expect(screen.getByText("Commits exist")).toBeTruthy();
    expect(screen.getByText("On main")).toBeTruthy();
  });
  it("message.updated for an unknown or other-workspace message adds nothing", async () => {
    const ref = await mount(true);
    act(() => ref.current!.handleEvent({ type: "message.updated", message: m("zz", "elsewhere") }));
    act(() => ref.current!.handleEvent({ type: "message.updated", message: { ...m("a", "other ws"), workspaceId: "w2" } }));
    expect(screen.queryByText("elsewhere")).toBeNull();
    expect(screen.queryByText("other ws")).toBeNull();
    expect(screen.getByText("hello")).toBeTruthy();
  });
  it("seeds the running indicator from the hub on mount", async () => {
    vi.mocked(hub.getActiveTask).mockResolvedValue({ running });
    await mount(true);
    expect(screen.getByText("Organizing")).toBeTruthy();
  });
  it("resync with no running task clears a stale indicator", async () => {
    vi.mocked(hub.getActiveTask).mockResolvedValue({ running });
    const ref = await mount(true);
    vi.mocked(hub.getActiveTask).mockResolvedValue({ running: null });
    await act(async () => ref.current!.resync());
    expect(screen.queryByText("Organizing")).toBeNull();
  });
  it("an agent message for the running task clears the indicator", async () => {
    vi.mocked(hub.getActiveTask).mockResolvedValue({ running });
    const ref = await mount(true);
    act(() => ref.current!.handleEvent({ type: "message.created", message: { ...m("r", "done", "agent"), taskId: "t1" } }));
    expect(screen.queryByText("Organizing")).toBeNull();
  });
  it("a stale {running: t1} response does not resurrect a task cleared by SSE", async () => {
    let resolve!: (v: { running: typeof running | null }) => void;
    vi.mocked(hub.getActiveTask).mockReturnValue(new Promise((r) => (resolve = r)));
    const ref = await mount(true);
    act(() => ref.current!.handleEvent({ type: "message.created", message: { ...m("r", "done", "agent"), taskId: "t1" } }));
    await act(async () => resolve({ running }));
    expect(screen.queryByText("Organizing")).toBeNull();
  });
  it("an older open follow-up can be answered by name", async () => {
    const asked = (id: string, qid: string): Message => ({
      ...m(id, "asked", "agent"),
      meta: { changes: [], askedQuestion: { id: qid, title: "进度？", body: "现在到哪了" } },
    });
    vi.mocked(hub.getEntry).mockImplementation(async (_workspace, id) => ({ kind: "question", status: id === "Q-9" ? "resolved" : "open" }) as never);
    vi.mocked(hub.listMessages).mockResolvedValue([asked("a1", "Q-1"), m("u1", "先这样"), asked("a2", "Q-2"), asked("a9", "Q-9")]);
    vi.mocked(hub.postMessage).mockImplementation(async (_workspace, content) => ({
      message: m("u2", content),
      task: { id: "t2", workspaceId: "w1", messageId: "u2", status: "queued", error: null },
    }));
    await mount(true);
    const box = await screen.findByRole("textbox", { name: "Answer Q-1" });
    expect(screen.getByRole("textbox", { name: "Answer Q-2" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Answer Q-9" })).toBeNull();
    await userEvent.type(box, "到里程碑二");
    await userEvent.click(screen.getByRole("button", { name: "Answer Q-1" }));
    expect(hub.postMessage).toHaveBeenCalledWith("w1", "回答 Q-1：\n到里程碑二");
    expect(screen.queryByRole("textbox", { name: "Answer Q-1" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Answer Q-2" })).toBeTruthy();
  });
  it("a follow-up that already has a reply does not keep its answer box", async () => {
    const asked = (id: string, qid: string): Message => ({
      ...m(id, "asked", "agent"),
      meta: { changes: [], askedQuestion: { id: qid, title: "进度？", body: "现在到哪了" } },
    });
    vi.mocked(hub.getEntry).mockResolvedValue({ kind: "question", status: "open" } as never);
    vi.mocked(hub.listMessages).mockResolvedValue([
      asked("a1", "Q-1"),
      m("u1", "回答 Q-1：\n我想让你查看文档"),
      asked("a2", "Q-2"),
    ]);
    await mount(true);
    expect(screen.queryByRole("textbox", { name: "Answer Q-1" })).toBeNull();
    expect(await screen.findByRole("textbox", { name: "Answer Q-2" })).toBeTruthy();
  });
  it("a stale {running: null} response does not hide a task started via SSE", async () => {
    let resolve!: (v: { running: typeof running | null }) => void;
    vi.mocked(hub.getActiveTask).mockReturnValue(new Promise((r) => (resolve = r)));
    const ref = await mount(true);
    act(() => ref.current!.handleEvent({ type: "task.updated", task: running }));
    await act(async () => resolve({ running: null }));
    expect(screen.getByText("Organizing")).toBeTruthy();
  });
  it("quotes a message, edits it, and searches", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh");
    try {
      const placeholder = "随手扔点什么… 会议速记、和 PdM 的聊天、需求变更、链接都可以";
      vi.mocked(hub.listMessages).mockResolvedValue([{ ...m("a", "hello"), editedAt: "2026-10-22T00:00:00Z" }]);
      vi.mocked(hub.postMessage).mockResolvedValue({ message: m("n", "about it"), task: { id: "t", workspaceId: "w1", messageId: "n", status: "queued", error: null } });
      vi.mocked(hub.listMessageVersions).mockResolvedValue([{ version: 1, content: "first draft", createdAt: "2026-10-21T00:00:00Z" }]);
      vi.mocked(hub.editMessage).mockResolvedValue({
        message: { ...m("a", "revised"), editedAt: "2026-10-22T01:00:00Z" },
        task: { id: "t2", workspaceId: "w1", messageId: "a", status: "queued", error: null },
      });
      vi.mocked(hub.searchMessages).mockResolvedValue([m("s", "进度说明", "agent")]);
      await mount(true);
      await userEvent.click(screen.getByRole("button", { name: "引用" }));
      expect(screen.getByRole("button", { name: "取消引用" })).toBeTruthy();
      await userEvent.type(screen.getByPlaceholderText(placeholder), "about it");
      await userEvent.click(screen.getByRole("button", { name: "发送 ⇧↵" }));
      expect(hub.postMessage).toHaveBeenCalledWith("w1", "about it", "a");
      expect(screen.queryByRole("button", { name: "取消引用" })).toBeNull();

      await userEvent.click(screen.getAllByRole("button", { name: "引用" })[0]!);
      await userEvent.click(screen.getByRole("button", { name: "取消引用" }));
      expect(screen.queryByRole("button", { name: "取消引用" })).toBeNull();
      await userEvent.type(screen.getByPlaceholderText(placeholder), "plain");
      await userEvent.click(screen.getByRole("button", { name: "发送 ⇧↵" }));
      expect(hub.postMessage).toHaveBeenLastCalledWith("w1", "plain");

      await userEvent.click(screen.getByRole("button", { name: "已编辑" }));
      expect(hub.listMessageVersions).toHaveBeenCalledWith("w1", "a");
      expect(await screen.findByText("first draft")).toBeTruthy();
      expect(screen.getByText("更早的版本")).toBeTruthy();
      expect(document.querySelector(".versions time")?.textContent).toMatch(/\d{2}:\d{2}/);

      await userEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
      const box = screen.getByDisplayValue("hello");
      await userEvent.clear(box);
      await userEvent.type(box, "revised");
      await userEvent.click(screen.getByRole("button", { name: "保存" }));
      expect(hub.editMessage).toHaveBeenCalledWith("w1", "a", "revised");
      expect(screen.getByText("revised")).toBeTruthy();
      vi.mocked(hub.listMessageVersions).mockResolvedValue([
        { version: 1, content: "first draft", createdAt: "2026-10-21T00:00:00Z" },
        { version: 2, content: "kept hello", createdAt: "2026-10-22T00:00:00Z" },
      ]);
      await userEvent.click(screen.getAllByRole("button", { name: "已编辑" })[0]!);
      expect(await screen.findByText("kept hello")).toBeTruthy();

      vi.mocked(hub.editMessage).mockRejectedValue(new hub.HubError(409, "message is still being processed"));
      await userEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
      await userEvent.click(screen.getByRole("button", { name: "保存" }));
      expect(await screen.findByText("这条消息还在处理，暂时不能编辑")).toBeTruthy();

      const search = screen.getByPlaceholderText("搜索消息");
      await userEvent.type(search, "进度");
      await userEvent.keyboard("{Enter}");
      expect(hub.searchMessages).toHaveBeenCalledWith("w1", "进度");
      const hit = (await screen.findByText("说明")).closest(".search-hit") as HTMLElement;
      expect(hit.textContent).toContain("进度说明");
      await userEvent.click(hit.querySelector("button")!);
      expect(screen.getByRole("button", { name: "取消引用" })).toBeTruthy();
    } finally {
      localStorage.removeItem(LOCALE_STORAGE_KEY);
    }
  });
});
