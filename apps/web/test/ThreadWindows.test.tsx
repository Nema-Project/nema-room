import { act, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadWindows, type ThreadWindowsHandle } from "@/components/ThreadWindows";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { HubEvent, Message, Thread } from "@/lib/types";
import { FakeEventSource } from "./FakeEventSource";

vi.mock("@/lib/hub", () => ({ getThreadMessages: vi.fn(), postThreadMessage: vi.fn(), markThreadRead: vi.fn(), getMessage: vi.fn(), getEntry: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), withdrawEntry: vi.fn(), eventsUrl: (id: string) => `http://hub/workspaces/${id}/events` }));
const message = (workspaceId: string, threadId: string, id: string, seq: number): Message => ({ id, workspaceId, role: "user", content: id, meta: null, taskId: null, createdAt: "2026-10-21T00:00:00Z", editedAt: null, threadId, seq });
const thread = (workspaceId: string, id: string): Thread => ({ id, workspaceId, title: id, openedBy: "user", replyCount: 1, unread: 1, lastReplyAt: null, createdAt: "2026-10-21T00:00:00Z" });
beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); FakeEventSource.reset(); vi.stubGlobal("EventSource", FakeEventSource); });
afterEach(() => { vi.unstubAllGlobals(); });
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
    FakeEventSource.forWorkspace("w1")!.send({ type: "message.created", message: message("w1", "t1", "later", 4) } satisfies HubEvent);
    expect(hub.markThreadRead).not.toHaveBeenCalled();
    act(() => ref.current!.focus("w1", "t1"));
    await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "t1", 4));
  });
  it("delivers rapid messages to inactive windows and opens subscriptions per workspace", async () => {
    vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => ({ thread: thread(workspaceId, id), anchor: message(workspaceId, id, id, 2), messages: [message(workspaceId, id, `${id}-reply`, 3)] }));
    const ref = mount(); act(() => ref.current!.open("w1", "t1")); act(() => ref.current!.open("w2", "t2"));
    await vi.waitFor(() => expect(hub.getThreadMessages).toHaveBeenCalledWith("w2", "t2"));
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(expect.arrayContaining([expect.stringContaining("w1"), expect.stringContaining("w2")]));
    const source = FakeEventSource.forWorkspace("w1")!;
    source.send({ type: "message.created", message: message("w1", "t1", "burst-user", 4) } satisfies HubEvent);
    source.send({ type: "message.created", message: message("w1", "t1", "burst-agent", 5) } satisfies HubEvent);
    source.send({ type: "thread.updated", thread: { ...thread("w1", "t1"), replyCount: 3 } } satisfies HubEvent);
    await vi.waitFor(() => expect(document.querySelector('[data-thread-id="t1"]')?.textContent).toContain("burst-agent"));
    expect(document.querySelector('[data-thread-id="t1"]')?.textContent).toContain("burst-user");
    expect(hub.markThreadRead).not.toHaveBeenCalledWith("w1", "t1", 5);
  });
  it("reloads a floating thread on reconnect without discarding a newer event", async () => {
    let loads = 0;
    vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => { loads += 1; return { thread: { ...thread(workspaceId, id), replyCount: loads > 1 ? 2 : 1 }, anchor: message(workspaceId, id, id, 2), messages: [message(workspaceId, id, `${id}-reply`, 3), ...(loads > 1 ? [message(workspaceId, id, "from-reconnect", 4)] : [])] }; });
    const ref = mount(); act(() => ref.current!.open("w1", "t1"));
    await vi.waitFor(() => expect(hub.getThreadMessages).toHaveBeenCalledTimes(1));
    const source = FakeEventSource.forWorkspace("w1")!; source.open(); source.open();
    await vi.waitFor(() => expect(hub.getThreadMessages).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.querySelector('[data-thread-id="t1"]')?.textContent).toContain("from-reconnect"));
  });
  it("keeps the active floating window above three overlapping windows", async () => {
    const ref = mount(); act(() => ref.current!.open("w1", "t1")); act(() => ref.current!.open("w1", "t2")); act(() => ref.current!.open("w1", "t3"));
    const first = document.querySelector('[data-thread-id="t1"]')!.closest(".thread-floating") as HTMLElement;
    const third = document.querySelector('[data-thread-id="t3"]')!.closest(".thread-floating") as HTMLElement;
    act(() => ref.current!.focus("w1", "t1"));
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(third.style.zIndex));
  });
});
