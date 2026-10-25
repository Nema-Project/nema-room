import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadWindows, type ThreadWindowsHandle } from "@/components/ThreadWindows";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { Message, Thread } from "@/lib/types";

vi.mock("@/lib/hub", () => ({ getThreadMessages: vi.fn(), postThreadMessage: vi.fn(), markThreadRead: vi.fn(), getMessage: vi.fn(), getEntry: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), withdrawEntry: vi.fn() }));
const message = (workspaceId: string, threadId: string, id: string, seq: number): Message => ({ id, workspaceId, role: "user", content: id, meta: null, taskId: null, createdAt: "2026-10-21T00:00:00Z", editedAt: null, threadId, seq });
const thread = (workspaceId: string, id: string): Thread => ({ id, workspaceId, title: id, openedBy: "user", replyCount: 1, unread: 1, lastReplyAt: null, createdAt: "2026-10-21T00:00:00Z" });
beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });
function mount() {
  const ref = createRef<ThreadWindowsHandle>();
  render(<I18nProvider><ThreadWindows ref={ref} /></I18nProvider>);
  return ref;
}
describe("ThreadWindows", () => {
  it("loads a cross-workspace target using the requested workspace id", async () => {
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread: thread("w2", "t2"), anchor: message("w2", "t2", "t2", 2), messages: [message("w2", "t2", "r2", 7)] });
    const ref = mount();
    act(() => ref.current!.open("w2", "t2"));
    await vi.waitFor(() => expect(hub.getThreadMessages).toHaveBeenCalledWith("w2", "t2"));
    await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w2", "t2", 7));
  });
  it("keeps a background thread unread until it becomes active", async () => {
    vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => ({ thread: thread(workspaceId, id), anchor: message(workspaceId, id, id, 2), messages: [message(workspaceId, id, `${id}-reply`, 3)] }));
    const ref = mount();
    act(() => ref.current!.open("w1", "t1"));
    await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "t1", 3));
    act(() => ref.current!.open("w1", "t2"));
    await vi.waitFor(() => expect(hub.getThreadMessages).toHaveBeenCalledWith("w1", "t2"));
    await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "t2", 3));
    vi.mocked(hub.markThreadRead).mockClear();
    act(() => ref.current!.handleEvent({ type: "message.created", message: message("w1", "t1", "later", 4) }));
    expect(hub.markThreadRead).not.toHaveBeenCalled();
    act(() => ref.current!.focus("w1", "t1"));
    await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "t1", 4));
  });
});
