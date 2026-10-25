import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadView } from "@/components/ThreadView";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { HubEvent, Message, Thread } from "@/lib/types";
import { FakeEventSource } from "./FakeEventSource";

vi.mock("@/lib/hub", () => ({ getThreadMessages: vi.fn(), postThreadMessage: vi.fn(), markThreadRead: vi.fn(), getMessage: vi.fn(), getEntry: vi.fn(), getHistory: vi.fn(), getWhy: vi.fn(), listMessages: vi.fn(), listEntries: vi.fn(), listRepos: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), withdrawEntry: vi.fn(), eventsUrl: (id: string) => `http://hub/workspaces/${id}/events` }));
const thread: Thread = { id: "anchor", workspaceId: "w1", title: "Need details", openedBy: "user", replyCount: 1, unread: 1, lastReplyAt: null, createdAt: "2026-10-21T00:00:00Z" };
const msg = (id: string, seq: number, content = id, role: Message["role"] = "user"): Message => ({ id, workspaceId: "w1", role, content, meta: null, taskId: null, createdAt: "2026-10-21T00:00:00Z", editedAt: null, threadId: "anchor", seq });
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [msg("r1", 3, "Reply")] });
  vi.mocked(hub.postThreadMessage).mockResolvedValue({ message: msg("r2", 4), task: { id: "task", workspaceId: "w1", messageId: "r2", status: "queued", error: null } });
});
const mount = (props: Partial<React.ComponentProps<typeof ThreadView>> = {}) => render(<I18nProvider><ThreadView workspaceId="w1" threadId="anchor" {...props} /></I18nProvider>);
describe("ThreadView", () => {
  it("shows the anchor and thread messages", async () => { mount(); expect(await screen.findByText("Pinned question")).toBeTruthy(); expect(screen.getByText("Reply")).toBeTruthy(); });
  it("sends in the thread", async () => { mount(); const box = await screen.findByRole("textbox"); await userEvent.type(box, "more{Shift>}{Enter}{/Shift}"); expect(hub.postThreadMessage).toHaveBeenCalledWith("w1", "anchor", "more", undefined); });
  it("marks rendered messages read on open with throughSeq", async () => { mount(); await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "anchor", 3)); });
  it("retains an SSE message that arrives while the initial fetch is pending", async () => {
    let finish!: (result: { thread: Thread; anchor: Message; messages: Message[] }) => void;
    vi.mocked(hub.getThreadMessages).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("EventSource", FakeEventSource); FakeEventSource.reset();
    mount(); await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const arrival = msg("arrived", 4, "Arrived during loading");
    FakeEventSource.instances[0]!.send({ type: "message.created", message: arrival } satisfies HubEvent);
    await act(async () => finish({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [msg("r1", 3, "Reply")] }));
    expect(await screen.findByText("Arrived during loading")).toBeTruthy();
  });
  it("reloads a standalone thread after reconnect", async () => {
    vi.stubGlobal("EventSource", FakeEventSource); FakeEventSource.reset();
    let loads = 0;
    vi.mocked(hub.getThreadMessages).mockImplementation(async () => { loads += 1; return { thread, anchor: msg("anchor", 2, "Pinned question"), messages: [msg("r1", 3, "Reply"), ...(loads > 1 ? [msg("reconnected", 4, "Recovered reply")] : [])] }; });
    mount(); await vi.waitFor(() => expect(hub.getThreadMessages).toHaveBeenCalledTimes(1));
    const source = FakeEventSource.instances[0]!; source.open(); source.open();
    expect(await screen.findByText("Recovered reply")).toBeTruthy();
    expect(hub.getThreadMessages).toHaveBeenCalledTimes(2);
  });
  it("does not repeat a successful acknowledgement for an identical sequence after thread.updated", async () => {
    vi.stubGlobal("EventSource", FakeEventSource); FakeEventSource.reset();
    mount(); await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledTimes(1));
    FakeEventSource.instances[0]!.send({ type: "thread.updated", thread: { ...thread, replyCount: 2 } } satisfies HubEvent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.markThreadRead).toHaveBeenCalledTimes(1);
  });
  it("retries a failed read acknowledgement after focus returns", async () => {
    vi.mocked(hub.markThreadRead).mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(undefined);
    mount({ floating: true }); await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("blur"))); act(() => window.dispatchEvent(new Event("focus")));
    await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledTimes(2));
    expect(hub.markThreadRead).toHaveBeenLastCalledWith("w1", "anchor", 3);
  });
  it("does not acknowledge an unrendered arrival while the window is backgrounded", async () => { vi.stubGlobal("EventSource", FakeEventSource); FakeEventSource.reset(); mount({ floating: true }); await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "anchor", 3)); vi.mocked(hub.markThreadRead).mockClear(); act(() => window.dispatchEvent(new Event("blur"))); FakeEventSource.instances[0]!.send({ type: "message.created", message: msg("r2", 4, "Later") } satisfies HubEvent); expect(hub.markThreadRead).not.toHaveBeenCalledWith("w1", "anchor", 4); act(() => window.dispatchEvent(new Event("focus"))); await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "anchor", 4)); });
  it("opens entry and history chips from the standalone view", async () => {
    vi.mocked(hub.getEntry).mockResolvedValue({ id: "R-7", kind: "requirement", status: "active", title: "Feature", body: "", related: [], sourceMessages: [], quotes: [], businessDate: null } as never);
    vi.mocked(hub.getHistory).mockResolvedValue([]); vi.mocked(hub.getWhy).mockResolvedValue([]); vi.mocked(hub.listMessages).mockResolvedValue([]); vi.mocked(hub.listEntries).mockResolvedValue([]); vi.mocked(hub.listRepos).mockResolvedValue([]);
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [{ ...msg("r1", 3, "Reply", "agent"), meta: { changes: [{ entryId: "R-7", kind: "requirement", title: "Feature", op: "update" }], askedQuestion: null } }] });
    mount(); await userEvent.click(await screen.findByRole("button", { name: "History" })); expect(await screen.findByRole("tab", { name: /History/, selected: true })).toBeTruthy(); expect(hub.getHistory).toHaveBeenCalledWith("w1", "R-7");
  });
  it("opens an entry from a standalone message chip", async () => {
    vi.mocked(hub.getEntry).mockResolvedValue({ id: "R-7", kind: "requirement", status: "active", title: "Feature", body: "", related: [], sourceMessages: [], quotes: [], businessDate: null } as never);
    vi.mocked(hub.getHistory).mockResolvedValue([]); vi.mocked(hub.getWhy).mockResolvedValue([]); vi.mocked(hub.listMessages).mockResolvedValue([]); vi.mocked(hub.listEntries).mockResolvedValue([]); vi.mocked(hub.listRepos).mockResolvedValue([]);
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [{ ...msg("r1", 3, "Reply", "agent"), meta: { changes: [{ entryId: "R-7", kind: "requirement", title: "Feature", op: "add" }], askedQuestion: null } }] });
    mount(); await userEvent.click(await screen.findByRole("button", { name: "Feature" }));
    expect(await screen.findByText("R-7", { selector: ".kid" })).toBeTruthy();
    expect(hub.getEntry).toHaveBeenCalledWith("w1", "R-7");
  });
  it("opens another thread for a quoted source jump", async () => {
    const onOpenThread = vi.fn(); vi.mocked(hub.getMessage).mockResolvedValue({ ...msg("outside", 8), threadId: "other" });
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [{ ...msg("r1", 3, "Reply", "agent"), meta: { changes: [], askedQuestion: null, quote: { messageId: "outside", role: "user", excerpt: "Quoted source" } } }] });
    mount({ onOpenThread }); await userEvent.click(await screen.findByRole("button", { name: /Quoted source/ })); expect(onOpenThread).toHaveBeenCalledWith("w1", "other", "outside");
  });
  it("scrolls to an already-rendered same-thread quote target", async () => {
    const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    vi.mocked(hub.getMessage).mockResolvedValue(msg("r1", 3, "Reply"));
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [{ ...msg("r2", 4, "Another reply", "agent"), meta: { changes: [], askedQuestion: null, quote: { messageId: "r1", role: "user", excerpt: "Jump to reply" } } }] });
    mount(); await userEvent.click(await screen.findByRole("button", { name: /Jump to reply/ }));
    expect(scroll).toHaveBeenCalled();
  });
  it("fetches, renders, and scrolls to a same-thread target outside the loaded batch", async () => {
    const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    vi.mocked(hub.getMessage).mockResolvedValue(msg("older", 1, "Older reply"));
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [{ ...msg("r2", 4, "Another reply", "agent"), meta: { changes: [], askedQuestion: null, quote: { messageId: "older", role: "user", excerpt: "Jump to old reply" } } }] });
    mount(); await userEvent.click(await screen.findByRole("button", { name: /Jump to old reply/ }));
    expect(await screen.findByText("Older reply")).toBeTruthy(); expect(scroll).toHaveBeenCalled();
  });
  it("routes a standalone jump to a main-conversation message", async () => {
    const onOpenMainMessage = vi.fn(); const main = { ...msg("main", 1, "Main message"), threadId: null };
    vi.mocked(hub.getMessage).mockResolvedValue(main);
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [{ ...msg("r2", 4, "Another reply", "agent"), meta: { changes: [], askedQuestion: null, quote: { messageId: "main", role: "user", excerpt: "Go to main" } } }] });
    mount({ onOpenMainMessage }); await userEvent.click(await screen.findByRole("button", { name: /Go to main/ }));
    expect(onOpenMainMessage).toHaveBeenCalledWith("w1", main);
  });
  it.each([ ["main conversation", null, "w1"], ["other thread", "different", "w1"], ["other workspace", "anchor", "w2"] ] as const)("rejects a deep-link target from the %s", async (_label, targetThreadId, targetWorkspaceId) => {
    vi.mocked(hub.getMessage).mockResolvedValue({ ...msg("foreign", 99, "Foreign reply"), workspaceId: targetWorkspaceId, threadId: targetThreadId });
    mount({ focusMessageId: "foreign" });
    await vi.waitFor(() => expect(hub.getMessage).toHaveBeenCalledWith("w1", "foreign"));
    expect(screen.queryByText("Foreign reply")).toBeNull();
    expect(hub.markThreadRead).not.toHaveBeenCalledWith("w1", "anchor", 99);
  });
  it("scrolls each newly selected target in the same mounted thread window", async () => {
    const scroll = vi.fn(); Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
    vi.mocked(hub.getThreadMessages).mockResolvedValue({ thread, anchor: msg("anchor", 2, "Pinned question"), messages: [msg("target-a", 3, "Target A"), msg("target-b", 4, "Target B")] });
    const view = render(<I18nProvider><ThreadView workspaceId="w1" threadId="anchor" focusMessageId="target-a" /></I18nProvider>);
    await screen.findByText("Target A");
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
    scroll.mockClear();
    view.rerender(<I18nProvider><ThreadView workspaceId="w1" threadId="anchor" focusMessageId="target-b" /></I18nProvider>);
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
  });
  it("has no /thread command in its composer", async () => { mount(); const box = await screen.findByRole("textbox"); await userEvent.type(box, "/thread"); expect(screen.queryByRole("option", { name: /thread/ })).toBeNull(); });
});
