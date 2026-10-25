import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadView } from "@/components/ThreadView";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { Message, Thread } from "@/lib/types";

vi.mock("@/lib/hub", () => ({ getThreadMessages: vi.fn(), postThreadMessage: vi.fn(), markThreadRead: vi.fn(), getMessage: vi.fn(), getEntry: vi.fn(), getHistory: vi.fn(), getWhy: vi.fn(), listMessages: vi.fn(), listEntries: vi.fn(), listRepos: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), withdrawEntry: vi.fn() }));
const thread: Thread = { id: "anchor", workspaceId: "w1", title: "Need details", openedBy: "user", replyCount: 1, unread: 1, lastReplyAt: null, createdAt: "2026-10-21T00:00:00Z" };
const msg = (id: string, seq: number, content = id, role: Message["role"] = "user"): Message => ({ id, workspaceId: "w1", role, content, meta: null, taskId: null, createdAt: "2026-10-21T00:00:00Z", editedAt: null, threadId: "anchor", seq });
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
  it("does not acknowledge an unrendered arrival while the window is backgrounded", async () => { const view = mount(); await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "anchor", 3)); vi.mocked(hub.markThreadRead).mockClear(); act(() => window.dispatchEvent(new Event("blur"))); view.rerender(<I18nProvider><ThreadView workspaceId="w1" threadId="anchor" floating event={{ type: "message.created", message: msg("r2", 4, "Later") }} /></I18nProvider>); expect(hub.markThreadRead).not.toHaveBeenCalledWith("w1", "anchor", 4); act(() => window.dispatchEvent(new Event("focus"))); await vi.waitFor(() => expect(hub.markThreadRead).toHaveBeenCalledWith("w1", "anchor", 4)); });
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
  it("has no /thread command in its composer", async () => { mount(); const box = await screen.findByRole("textbox"); await userEvent.type(box, "/thread"); expect(screen.queryByRole("option", { name: /thread/ })).toBeNull(); });
});
