import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntryDetail } from "@/components/EntryDetail";
import { formatDay, formatTime } from "@/lib/format";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { Entry } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  getEntry: vi.fn(), getHistory: vi.fn(), getWhy: vi.fn(), getVersion: vi.fn(), putEntry: vi.fn(), confirmEntry: vi.fn(), listEntries: vi.fn(), listMessages: vi.fn(),
  listRepos: vi.fn(), updateDiagram: vi.fn(), requestWorkPackage: vi.fn(), getWorkPackage: vi.fn(), confirmImplementation: vi.fn(), diagramHtmlUrl: (w: string, g: string) => `http://hub/api/workspaces/${w}/diagrams/${g}.html`,
}));

const entry: Entry = {
  id: "R-1", kind: "requirement", title: "Refund window", status: "active", businessDate: "2026-10-21",
  related: ["Q-4"], sourceMessages: ["m_1", "m_2"], body: "Refunds within **7 days**.",
  basis: null, ingestedAt: null, confirmedAt: null, confirmedRevision: null, sourceRefs: [], quotes: [],
};
const hist = [
  { version: 2, commit: "c2", committedAt: "2026-10-21T15:00:00Z", op: "update" as const, reason: "changed window", sourceMessages: ["m_2"], author: "user" as const },
  { version: 1, commit: "c1", committedAt: "2026-10-21T14:00:00Z", op: "add" as const, reason: "created", sourceMessages: ["m_1"], author: "agent" as const },
];

beforeEach(() => {
  vi.mocked(hub.getEntry).mockResolvedValue(entry);
  vi.mocked(hub.getHistory).mockResolvedValue(hist);
  vi.mocked(hub.getWhy).mockResolvedValue([]);
  vi.mocked(hub.putEntry).mockResolvedValue(entry);
  vi.mocked(hub.confirmEntry).mockResolvedValue(entry);
  vi.mocked(hub.listEntries).mockResolvedValue([
    { id: "Q-4", kind: "question", title: "q4", status: "resolved", businessDate: null, related: [], priority: 2, isNew: false, basis: null, confirmedAt: null },
  ]);
  vi.mocked(hub.listMessages).mockResolvedValue(
    ["m_1", "m_2"].map((id, i) => ({ id, workspaceId: "w1", role: "user" as const, content: `message ${id}`, meta: null, taskId: null, createdAt: "2026-10-21T14:00:00Z", editedAt: null, threadId: null, seq: i + 1 })),
  );
  vi.mocked(hub.putEntry).mockClear();
  vi.mocked(hub.confirmEntry).mockClear();
  vi.mocked(hub.listRepos).mockResolvedValue([]);
  vi.mocked(hub.updateDiagram).mockReset();
});

const mount = async (props: { onClose?: () => void; onJumpToMessage?: (id: string) => void } = {}) => {
  render(
    <I18nProvider>
      <EntryDetail workspaceId="w1" entryId="R-1" onClose={props.onClose ?? vi.fn()} onJumpToMessage={props.onJumpToMessage ?? vi.fn()} />
    </I18nProvider>,
  );
  await act(async () => {});
};

describe("EntryDetail", () => {
  it("lists two sources and jumps to the clicked message", async () => {
    const onJump = vi.fn();
    await mount({ onJumpToMessage: onJump });
    const sources = screen.getAllByTestId("source-item");
    expect(sources).toHaveLength(2);
    await userEvent.click(sources[0]);
    expect(onJump).toHaveBeenCalledWith("m_1");
  });
  it("strikes through resolved related questions", async () => {
    await mount();
    const tag = screen.getByText("Q-4");
    expect(tag.style.textDecoration).toBe("line-through");
  });
  it("requires a reason before saving", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Please enter a reason for the change")).toBeTruthy();
    expect(hub.putEntry).not.toHaveBeenCalled();
  });
  it("saves with a reason and only offers statuses allowed for the kind", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const opts = Array.from(screen.getByRole("combobox", { name: "Status" }).querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(opts).toEqual(["active", "superseded", "dropped"]);
    await userEvent.type(screen.getByRole("textbox", { name: "Reason for change" }), "PdM said so");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(hub.putEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hub.putEntry).mock.calls[0][2]).toMatchObject({ kind: "requirement", reason: "PdM said so", title: "Refund window" });
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
  it("keeps an unsaved edit draft across tab switches", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    await userEvent.clear(title);
    await userEvent.type(title, "Draft title");
    await userEvent.type(screen.getByRole("textbox", { name: "Reason for change" }), "draft reason");
    await userEvent.click(screen.getByRole("tab", { name: "History 2" }));
    expect(screen.queryByRole("textbox", { name: "Title" })).toBeNull(); // form hidden on other tabs
    await userEvent.click(screen.getByRole("tab", { name: "Why" }));
    await userEvent.click(screen.getByRole("tab", { name: "Content" }));
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Draft title");
    expect((screen.getByRole("textbox", { name: "Reason for change" }) as HTMLInputElement).value).toBe("draft reason");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(vi.mocked(hub.putEntry).mock.calls[0][2]).toMatchObject({ title: "Draft title", reason: "draft reason" });
  });
  it("closes", async () => {
    const onClose = vi.fn();
    await mount({ onClose });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
  it("clicking a why-reason opens that history version and jumps to its source message", async () => {
    vi.mocked(hub.getWhy).mockResolvedValue([
      { text: "Refunds within 7 days.", version: 2, commit: "c2", reason: "changed window", author: "user" },
    ]);
    vi.mocked(hub.getVersion).mockResolvedValue({ ...entry, body: "old" });
    const onJump = vi.fn();
    await mount({ onJumpToMessage: onJump });
    await userEvent.click(screen.getByRole("tab", { name: "Why" }));
    await userEvent.click(screen.getByRole("button", { name: "changed window" }));
    expect(screen.getByRole("tab", { name: "History 2" }).getAttribute("aria-selected")).toBe("true");
    expect(onJump).toHaveBeenCalledWith("m_2");
  });
  it("ignores an older response that resolves after a newer one", async () => {
    let first!: (e: Entry) => void;
    vi.mocked(hub.getEntry).mockReset();
    vi.mocked(hub.getEntry)
      .mockImplementationOnce(() => new Promise<Entry>((r) => (first = r)))
      .mockResolvedValue({ ...entry, title: "Newer title" });
    const ui = (k: number) => (
      <I18nProvider>
        <EntryDetail workspaceId="w1" entryId="R-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} refreshKey={k} />
      </I18nProvider>
    );
    const { rerender } = render(ui(0));
    await act(async () => {});
    rerender(ui(1));
    await act(async () => {});
    expect(screen.getByText("Newer title")).toBeTruthy();
    await act(async () => first({ ...entry, title: "Older title" }));
    expect(screen.getByText("Newer title")).toBeTruthy();
    expect(screen.queryByText("Older title")).toBeNull();
  });
  it("shows a notice when a refresh fails while content is displayed", async () => {
    const ui = (k: number) => (
      <I18nProvider>
        <EntryDetail workspaceId="w1" entryId="R-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} refreshKey={k} />
      </I18nProvider>
    );
    const { rerender } = render(ui(0));
    await act(async () => {});
    vi.mocked(hub.getEntry).mockRejectedValue(new Error("boom"));
    rerender(ui(1));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(screen.getByText("Refund window")).toBeTruthy();
  });
  it("keeps typed values and warns when the entry changes during editing", async () => {
    const ui = (k: number) => (
      <I18nProvider>
        <EntryDetail workspaceId="w1" entryId="R-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} refreshKey={k} />
      </I18nProvider>
    );
    const { rerender } = render(ui(0));
    await act(async () => {});
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement;
    await userEvent.clear(title);
    await userEvent.type(title, "My edit");
    vi.mocked(hub.getEntry).mockResolvedValue({ ...entry, title: "Someone else" });
    rerender(ui(1));
    await act(async () => {});
    expect(screen.getByText(/Saving will overwrite/)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("My edit");
    await userEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).value).toBe("Someone else");
    expect(screen.queryByText(/Saving will overwrite/)).toBeNull();
  });
  it("shows basis, times and quotes, and confirm calls the confirm route then shows the updated basis", async () => {
    const ingestedAt = "2026-10-21T05:00:00.000Z";
    const confirmedAt = "2026-10-22T06:30:00.000Z";
    const initial: Entry = {
      ...entry,
      basis: "inferred",
      ingestedAt,
      confirmedAt,
      quotes: [{ messageId: "m_9", text: "先流式" }],
    };
    const updated: Entry = { ...initial, basis: "stated" };
    vi.mocked(hub.getEntry).mockResolvedValue(initial);
    let release!: (value: Entry) => void;
    vi.mocked(hub.confirmEntry).mockImplementation(
      () =>
        new Promise<Entry>((resolve) => {
          vi.mocked(hub.getEntry).mockResolvedValue(updated);
          release = resolve;
        }),
    );
    const onJump = vi.fn();
    await mount({ onJumpToMessage: onJump });

    const stamp = (iso: string) => {
      const at = new Date(iso);
      return `${formatDay(at, "en")} ${formatTime(at, "en")}`;
    };
    expect(screen.getByText("Basis").nextElementSibling?.textContent).toBe("Inferred");
    expect(screen.getByText("Added").nextElementSibling?.textContent).toBe(stamp(ingestedAt));
    expect(screen.getByText("Last confirmed").nextElementSibling?.textContent).toBe(stamp(confirmedAt));
    const quote = screen.getByText("先流式");
    expect(quote.closest("blockquote")).toBeTruthy();
    await userEvent.click(quote);
    expect(onJump).toHaveBeenCalledWith("m_9");

    const confirmBtn = screen.getByRole("button", { name: "Confirm still valid" });
    const pendingClick = userEvent.click(confirmBtn);
    await vi.waitFor(() => expect((confirmBtn as HTMLButtonElement).disabled).toBe(true));
    await userEvent.click(confirmBtn);
    expect(hub.confirmEntry).toHaveBeenCalledTimes(1);
    expect(hub.confirmEntry).toHaveBeenCalledWith("w1", "R-1");
    release(updated);
    await pendingClick;
    await vi.waitFor(() => expect(screen.getByText("Basis").nextElementSibling?.textContent).toBe("Stated"));
  });
  it("hides confirm for a fresh stated entry", async () => {
    vi.mocked(hub.getEntry).mockResolvedValue({
      ...entry,
      basis: "stated",
      ingestedAt: "2026-10-23T00:00:00.000Z",
      confirmedAt: "2026-10-23T00:00:00.000Z",
    });
    await mount();
    expect(screen.getByText("Refund window")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm still valid" })).toBeNull();
  });
  it("shows confirm for a stale stated source", async () => {
    vi.mocked(hub.getEntry).mockResolvedValue({
      ...entry,
      id: "S-1",
      kind: "source",
      basis: "stated",
      url: "https://example.com/s",
      ingestedAt: "2020-01-01T00:00:00.000Z",
      confirmedAt: "2020-01-01T00:00:00.000Z",
    });
    await mount();
    expect(screen.getByRole("button", { name: "Confirm still valid" })).toBeTruthy();
  });
  it("the update button posts and shows 已排队更新", async () => {
    localStorage.setItem("nema.locale", "zh");
    const diagram: Entry = {
      ...entry, id: "G-1", kind: "diagram", title: "系统架构", related: [], sourceMessages: [], body: "后端的模块。",
      diagram: { repoId: "rp_a", type: "architecture", sourceCommits: { rp_a: "0123456789abcdef0123" }, nodePaths: { api: ["src/api"], db: ["src/db"], ui: ["web"] } },
    };
    vi.mocked(hub.getEntry).mockResolvedValue(diagram);
    vi.mocked(hub.listRepos).mockResolvedValue([
      { id: "rp_a", workspaceId: "w1", path: "/src/a", gitCommonDir: "/src/a/.git", label: "backend", mainBranch: "main", hasOrigin: false, remoteUrl: null, githubTarget: null, lastMainSha: null, lastFetchAt: null, lastFetchError: null },
    ]);
    vi.mocked(hub.updateDiagram).mockResolvedValue({} as Awaited<ReturnType<typeof hub.updateDiagram>>);
    try {
      render(
        <I18nProvider>
          <EntryDetail workspaceId="w1" entryId="G-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} />
        </I18nProvider>,
      );
      await act(async () => {});
      expect(screen.getByText("architecture")).toBeTruthy();
      expect(screen.getByText("backend")).toBeTruthy();
      expect(screen.getByText("画图时的提交")).toBeTruthy();
      expect(screen.getByText("0123456")).toBeTruthy();
      expect(screen.getByText("3")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
      expect(screen.queryByText("已排队更新")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "更新" }));
      expect(hub.updateDiagram).toHaveBeenCalledWith("w1", "G-1");
      expect(await screen.findByText("已排队更新")).toBeTruthy();
    } finally {
      localStorage.removeItem("nema.locale");
    }
  });
  it("the confirm button posts and shows verified with 由用户确认", async () => {
    localStorage.setItem("nema.locale", "zh");
    const reported: Entry = {
      ...entry,
      implementation: {
        status: "reported",
        evidence: { reportMessageId: null, commits: ["0123456789abcdef0123456789abcdef01234567"], inferred: true, note: "主分支上的退款逻辑", confirmedBy: null, acceptanceReview: null, reportEvidence: null },
      },
    };
    const verified: Entry = {
      ...reported,
      implementation: { status: "verified", evidence: { ...reported.implementation!.evidence, confirmedBy: "user" } },
    };
    vi.mocked(hub.getEntry).mockResolvedValue(reported);
    vi.mocked(hub.confirmImplementation).mockImplementation(async () => {
      vi.mocked(hub.getEntry).mockResolvedValue(verified);
      return verified;
    });
    try {
      await mount();
      expect(screen.getByText("已上报（代码推断）")).toBeTruthy();
      expect(screen.getByText("0123456")).toBeTruthy();
      expect(screen.getByText("主分支上的退款逻辑")).toBeTruthy();
      expect(screen.queryByText("由用户确认")).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "确认已实现" }));
      expect(hub.confirmImplementation).toHaveBeenCalledTimes(1);
      expect(hub.confirmImplementation).toHaveBeenCalledWith("w1", "R-1");
      expect(await screen.findByText("已核实")).toBeTruthy();
      expect(screen.getByText("由用户确认")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "确认已实现" })).toBeNull();
    } finally {
      localStorage.removeItem("nema.locale");
    }
  });
  it("a reported implementation links to its report message", async () => {
    const onJump = vi.fn();
    vi.mocked(hub.getEntry).mockResolvedValue({
      ...entry,
      implementation: { status: "mismatch", evidence: { reportMessageId: "m_r", commits: ["abcdef1"], inferred: false, note: null, confirmedBy: null, acceptanceReview: null, reportEvidence: null } },
    });
    await mount({ onJumpToMessage: onJump });
    expect(screen.getByText("Mismatch").classList.contains("red")).toBe(true);
    expect(screen.getByRole("button", { name: "Confirm implemented" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "View report" }));
    expect(onJump).toHaveBeenCalledWith("m_r");
  });

  it("generate from a requirement posts and shows the hub error inline", async () => {
    vi.mocked(hub.requestWorkPackage).mockRejectedValueOnce(new Error("没有绑定仓库")).mockResolvedValueOnce({ id: "W-4" } as never);
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Generate work package" }));
    expect(hub.requestWorkPackage).toHaveBeenCalledWith("w1", ["R-1"]);
    expect((await screen.findByRole("alert")).textContent).toBe("没有绑定仓库");
    await userEvent.click(screen.getByRole("button", { name: "Generate work package" }));
    expect(await screen.findByText("Requested work package W-4")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("a work package entry opens the work package detail", async () => {
    vi.mocked(hub.getWorkPackage).mockResolvedValue({
      entry: { ...entry, id: "W-1", kind: "workpackage", status: "draft", title: "Pkg", workpackage: { requirements: ["R-1"], repos: [], approvedAt: null, approvedCommit: null, blockedOn: null, tasks: [] } },
      spec: null,
      plan: null,
    });
    render(
      <I18nProvider>
        <EntryDetail workspaceId="w1" entryId="W-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} />
      </I18nProvider>,
    );
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "Overview" })).toBeTruthy();
    expect(hub.getWorkPackage).toHaveBeenCalledWith("w1", "W-1");
  });
});
