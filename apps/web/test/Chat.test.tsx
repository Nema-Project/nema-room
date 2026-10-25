import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, type ChatHandle } from "@/components/Chat";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { Message } from "@/lib/types";

vi.mock("@/lib/hub", () => ({ listMessages: vi.fn(), postMessage: vi.fn(), getActiveTask: vi.fn() }));
const running = { id: "t1", workspaceId: "w1", messageId: "a", status: "running" as const, error: null };

const m = (id: string, content: string, role: Message["role"] = "user"): Message => ({
  id, workspaceId: "w1", role, content, meta: null, taskId: null, createdAt: "2026-10-21T14:00:00Z",
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
  it("the latest unanswered follow-up has an answer box that sends a chat message", async () => {
    const asked = (id: string, qid: string): Message => ({
      ...m(id, "asked", "agent"),
      meta: { changes: [], askedQuestion: { id: qid, title: "进度？", body: "现在到哪了" } },
    });
    vi.mocked(hub.listMessages).mockResolvedValue([asked("a1", "Q-1"), m("u1", "先这样"), asked("a2", "Q-2")]);
    vi.mocked(hub.postMessage).mockResolvedValue({ message: m("u2", "到里程碑二") });
    await mount(true);
    const boxes = screen.getAllByRole("textbox", { name: "Answer" });
    expect(boxes).toHaveLength(1);
    await userEvent.type(boxes[0]!, "到里程碑二");
    await userEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(hub.postMessage).toHaveBeenCalledWith("w1", "到里程碑二");
    expect(screen.queryByRole("textbox", { name: "Answer" })).toBeNull();
  });
  it("a stale {running: null} response does not hide a task started via SSE", async () => {
    let resolve!: (v: { running: typeof running | null }) => void;
    vi.mocked(hub.getActiveTask).mockReturnValue(new Promise((r) => (resolve = r)));
    const ref = await mount(true);
    act(() => ref.current!.handleEvent({ type: "task.updated", task: running }));
    await act(async () => resolve({ running: null }));
    expect(screen.getByText("Organizing")).toBeTruthy();
  });
});
