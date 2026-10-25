import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";
import { ThreadWindowsProvider, useThreadWindows } from "@/components/ThreadWindowsProvider";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { Message, Thread, WorkspaceView } from "@/lib/types";
import { FakeEventSource } from "./FakeEventSource";

vi.mock("@/lib/hub", () => ({ nextAttention: vi.fn(), getThreadMessages: vi.fn(), postThreadMessage: vi.fn(), markThreadRead: vi.fn(), getMessage: vi.fn(), getEntry: vi.fn(), getHistory: vi.fn(), getWhy: vi.fn(), listMessages: vi.fn(), listEntries: vi.fn(), listRepos: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), withdrawEntry: vi.fn(), eventsUrl: (id: string) => `http://hub/workspaces/${id}/events` }));
const ws = (id: string): WorkspaceView => ({ id, name: id, confidential: false, knowledgeLanguage: "follow", createdAt: "2026-10-21T00:00:00Z", openQuestions: 0, archived: false, attention: id === "w2" ? 1 : 0 });
const thread = (workspaceId: string, id: string): Thread => ({ id, workspaceId, title: id, openedBy: "user", replyCount: 1, unread: 1, lastReplyAt: null, createdAt: "2026-10-21T00:00:00Z" });
const message = (workspaceId: string, threadId: string, id: string, seq: number): Message => ({ id, workspaceId, role: "user", content: id, meta: null, taskId: null, createdAt: "2026-10-21T00:00:00Z", editedAt: null, threadId, seq });

function RoutePage({ workspaceId, navigate }: { workspaceId: string; navigate: (id: string) => void }) {
  const host = useThreadWindows();
  return <>
    <button onClick={() => host.open("w1", "t1")}>Open A thread</button>
    <Sidebar workspaces={[ws("w1"), ws("w2")]} selectedId={workspaceId} connected onSelect={navigate} onCreate={() => {}} onArchive={() => {}} onDelete={() => {}} onOpenThread={(targetWorkspace, targetThread) => { host.open(targetWorkspace, targetThread); navigate(targetWorkspace); }} />
  </>;
}
function RemountingRoutes() {
  const [workspaceId, setWorkspaceId] = useState("w1");
  return <RoutePage key={workspaceId} workspaceId={workspaceId} navigate={setWorkspaceId} />;
}
beforeEach(() => {
  FakeEventSource.reset(); vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.mocked(hub.nextAttention).mockResolvedValue({ threadId: "t2" } as never);
  vi.mocked(hub.getThreadMessages).mockImplementation(async (workspaceId, id) => ({ thread: thread(workspaceId, id), anchor: message(workspaceId, id, id, 2), messages: [message(workspaceId, id, `${id}-reply`, 3)] }));
});
afterEach(() => vi.unstubAllGlobals());

describe("persistent floating thread host", () => {
  it("keeps A's window through route remount and opens B's attention target in B", async () => {
    render(<I18nProvider><ThreadWindowsProvider><RemountingRoutes /></ThreadWindowsProvider></I18nProvider>);
    await userEvent.click(screen.getByRole("button", { name: "Open A thread" }));
    await vi.waitFor(() => expect(document.querySelector('[data-thread-id="t1"]')).toBeTruthy());
    expect(document.activeElement?.closest(".thread-floating")).toBe(document.querySelector('[data-thread-id="t1"]')?.closest(".thread-floating"));
    await userEvent.click(screen.getByRole("button", { name: /next unread thread/i }));
    await vi.waitFor(() => expect(document.querySelector('[data-thread-id="t2"]')).toBeTruthy());
    expect(document.querySelector('[data-thread-id="t1"]')).toBeTruthy();
    expect(hub.getThreadMessages).toHaveBeenCalledWith("w2", "t2");
    expect(document.querySelectorAll(".thread-floating")).toHaveLength(2);
    expect(document.querySelector('[data-thread-id="t2"]')?.closest(".thread-floating")?.classList.contains("active")).toBe(true);
  });
});
