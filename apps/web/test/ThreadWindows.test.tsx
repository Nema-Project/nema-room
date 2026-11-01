import { act, fireEvent, render } from "@testing-library/react";
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
  it("keeps focus in a child when keyboard focus activates an inactive window", async () => {
    vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => ({ thread: thread(workspaceId, id), anchor: message(workspaceId, id, id, 2), messages: [message(workspaceId, id, `${id}-reply`, 3)] }));
    const ref = mount(); act(() => ref.current!.open("w1", "t1")); act(() => ref.current!.open("w1", "t2"));
    await vi.waitFor(() => expect(document.querySelector('[data-thread-id="t1"] textarea')).toBeTruthy());
    const textarea = document.querySelector('[data-thread-id="t1"] textarea')!;
    const wrapper = textarea.closest(".thread-floating") as HTMLElement;
    const wrapperFocus = vi.spyOn(wrapper, "focus"); wrapperFocus.mockClear();
    const activeElement = vi.spyOn(document, "activeElement", "get").mockReturnValue(textarea);
    act(() => fireEvent.focusIn(textarea));
    await vi.waitFor(() => expect(wrapper.classList.contains("active")).toBe(true));
    expect(wrapperFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
    activeElement.mockRestore();
  });
  it("keeps a select focused while the click that opens it is inside the window", async () => {
    vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => ({ thread: thread(workspaceId, id), anchor: message(workspaceId, id, id, 2), messages: [message(workspaceId, id, `${id}-reply`, 3)] }));
    const ref = mount();
    act(() => ref.current!.open("w1", "t1"));
    await vi.waitFor(() => expect(document.querySelector('[data-thread-id="t1"] textarea')).toBeTruthy());
    const wrapper = document.querySelector('[data-thread-id="t1"]')!.closest(".thread-floating") as HTMLElement;
    const select = document.createElement("select");
    select.innerHTML = "<option>alpha</option><option>beta</option>";
    wrapper.appendChild(select);
    select.focus();
    const wrapperFocus = vi.spyOn(wrapper, "focus");
    fireEvent.mouseDown(select);
    expect(wrapperFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);
    wrapperFocus.mockClear();
    fireEvent.mouseDown(wrapper.querySelector(".thread-drag")!);
    expect(wrapperFocus).toHaveBeenCalled();
  });
  it("stops acknowledging when focus moves outside all floating windows", async () => {
    vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => ({ thread: thread(workspaceId, id), anchor: message(workspaceId, id, id, 2), messages: [message(workspaceId, id, `${id}-reply`, 3)] }));
    const ref = mount(); act(() => ref.current!.open("w1", "t1"));
    await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "t1", 3));
    vi.mocked(hub.markThreadRead).mockClear();
    fireEvent.pointerDown(document.body);
    FakeEventSource.forWorkspace("w1")!.send({ type: "message.created", message: message("w1", "t1", "outside-focus", 4) } satisfies HubEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.markThreadRead).not.toHaveBeenCalledWith("w1", "t1", 4);
    expect(document.querySelector('[data-thread-id="t1"]')).toBeTruthy();
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
  it("keeps controls inside a small viewport after opening, dragging, and resizing", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 780 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 437 });
    vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => ({ thread: thread(workspaceId, id), anchor: message(workspaceId, id, id, 2), messages: [] }));
    const ref = mount();
    act(() => { ref.current!.open("w1", "t1"); ref.current!.open("w1", "t2"); ref.current!.open("w1", "t3"); });
    const assertReachable = () => {
      for (const host of document.querySelectorAll<HTMLElement>(".thread-floating")) {
        const left = Number.parseFloat(host.style.left);
        const top = Number.parseFloat(host.style.top);
        const width = Math.min(520, window.innerWidth - 32);
        const height = Math.min(680, window.innerHeight - 32);
        expect(left).toBeGreaterThanOrEqual(8);
        expect(left + width).toBeLessThanOrEqual(window.innerWidth - 8);
        expect(top).toBeGreaterThanOrEqual(8);
        expect(top + height).toBeLessThanOrEqual(window.innerHeight - 8);
        expect(top + 44).toBeLessThanOrEqual(window.innerHeight);
        expect(host.querySelector(".thread-header button")).toBeTruthy();
      }
    };
    assertReachable();
    const third = document.querySelector('[data-window-id="w1:t3"]')!;
    const dragHandle = third.querySelector(".thread-drag")!;
    fireEvent.pointerDown(dragHandle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(dragHandle, { pointerId: 1, clientX: -1000, clientY: -1000 });
    fireEvent.pointerUp(dragHandle, { pointerId: 1 });
    assertReachable();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 300 });
    fireEvent(window, new Event("resize"));
    assertReachable();
  });
});
