import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Home from "@/app/page";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";
import type { WorkspaceView } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/hub", () => ({
  listMessages: vi.fn().mockResolvedValue([]),
  listThreads: vi.fn().mockResolvedValue([]),
  getActiveTask: vi.fn().mockResolvedValue({ running: null }),
  postMessage: vi.fn(),
  listWorkspaces: vi.fn(),
  getDaemonStatus: vi.fn(),
  createWorkspace: vi.fn(),
  eventsUrl: (id: string) => `http://hub/${id}/events`,
}));

const ws = (openQuestions: number): WorkspaceView[] => [
  { id: "w1", name: "Alpha", confidential: false, knowledgeLanguage: "follow", createdAt: "x", openQuestions: 0, archived: false },
  { id: "w2", name: "Beta", confidential: false, knowledgeLanguage: "follow", createdAt: "x", openQuestions, archived: false },
];

class FakeES {
  static last: FakeES;
  onopen: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  constructor(public url: string) {
    FakeES.last = this;
  }
  close() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal("EventSource", FakeES);
  vi.mocked(hub.getDaemonStatus).mockResolvedValue({ connected: true });
  vi.mocked(hub.listWorkspaces).mockResolvedValue(ws(0));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(hub.listWorkspaces).mockReset();
});

const mount = async () => {
  render(
    <I18nProvider>
      <Home />
    </I18nProvider>,
  );
  await act(async () => {});
};

describe("Home", () => {
  it("re-lists workspaces every 15s so other workspaces' badges update", async () => {
    await mount();
    expect(screen.queryByTestId("open-questions")).toBeNull();
    const before = vi.mocked(hub.listWorkspaces).mock.calls.length;
    vi.mocked(hub.listWorkspaces).mockResolvedValue(ws(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(vi.mocked(hub.listWorkspaces).mock.calls.length).toBeGreaterThan(before);
    expect(screen.getByTestId("open-questions").textContent).toBe("2");
  });

  it("refetches after the SSE stream reconnects (not on the first open)", async () => {
    await mount();
    const calls = () => vi.mocked(hub.listWorkspaces).mock.calls.length;
    const base = calls();
    await act(async () => FakeES.last.onopen?.());
    expect(calls()).toBe(base);
    await act(async () => FakeES.last.onopen?.());
    expect(calls()).toBe(base + 1);
  });
});
