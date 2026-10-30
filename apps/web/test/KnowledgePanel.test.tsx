import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePanel } from "@/components/KnowledgePanel";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { EntryListItem } from "@/lib/types";

vi.mock("@/lib/hub", async (orig) => ({ ...(await orig<typeof import("@/lib/hub")>()), listEntries: vi.fn(), getTimeline: vi.fn(), listRepos: vi.fn(), requestWorkPackage: vi.fn() }));

const e = (id: string, kind: EntryListItem["kind"], status: EntryListItem["status"], extra: Partial<EntryListItem> = {}): EntryListItem => ({
  id, kind, status, title: `title ${id}`, businessDate: null, related: [], isNew: false, basis: null, confirmedAt: null, ...extra,
});
const entries: EntryListItem[] = [
  e("R-1", "requirement", "active", { isNew: true, businessDate: "2026-10-21", related: ["Q-1"] }),
  e("R-2", "requirement", "superseded"),
  e("Q-1", "question", "open", { priority: 2 }),
  e("Q-2", "question", "open", { priority: 1 }),
  e("Q-3", "question", "resolved", { priority: 3 }),
  e("S-1", "source", "active", { url: "https://example.com/spec" }),
];

beforeEach(() => {
  vi.mocked(hub.listEntries).mockResolvedValue(entries);
  vi.mocked(hub.getTimeline).mockResolvedValue(entries);
  vi.mocked(hub.listRepos).mockResolvedValue([]);
});

const repo = (id: string, label: string) => ({
  id, workspaceId: "w1", path: `/src/${id}`, gitCommonDir: `/src/${id}/.git`, label, mainBranch: "main",
  hasOrigin: false, remoteUrl: null, githubTarget: null, lastMainSha: null, lastFetchAt: null, lastFetchError: null, trustSkills: false,
});

const mount = async (lang: "follow" | "ja" = "follow", onOpen = vi.fn()) => {
  const r = render(
    <I18nProvider>
      <KnowledgePanel workspaceId="w1" knowledgeLanguage={lang} onOpen={onOpen} />
    </I18nProvider>,
  );
  await act(async () => {});
  return { ...r, onOpen };
};

describe("KnowledgePanel", () => {
  it("shows the five groups in order, pending first", async () => {
    await mount();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(titles.map((t) => t.replace(/\d+$/, ""))).toEqual(["Pending", "Requirements", "Decisions", "Trade-offs", "Sources"]);
  });
  it("sorts pending by priority and folds inactive entries", async () => {
    await mount();
    const ids = screen.getAllByTestId("entry-id").map((n) => n.textContent);
    expect(ids.indexOf("Q-2")).toBeLessThan(ids.indexOf("Q-1"));
    expect(screen.queryByText("Q-3")).toBeNull();
    expect(screen.queryByText("R-2")).toBeNull();
    const folds = screen.getAllByRole("button", { name: /1 inactive/ });
    expect(folds).toHaveLength(2);
    await userEvent.click(folds[1]);
    expect(screen.getByText("R-2")).toBeTruthy();
  });
  it("marks new entries and renders source links in a new tab", async () => {
    await mount();
    const row = screen.getByText("title R-1").closest("[data-testid='entry-row']") as HTMLElement;
    expect(within(row).getByText("New")).toBeTruthy();
    const link = screen.getByRole("link", { name: /example\.com|title S-1/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("href")).toBe("https://example.com/spec");
  });
  it("sets lang from the knowledge language", async () => {
    const { container } = await mount("ja");
    expect((container.firstElementChild as HTMLElement).getAttribute("lang")).toBe("ja");
  });
  it("opens an entry on click", async () => {
    const { onOpen } = await mount();
    await userEvent.click(screen.getByText("title Q-2"));
    expect(onOpen).toHaveBeenCalledWith("Q-2");
  });
  it("loads the timeline when switched", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Timeline" }));
    await act(async () => {});
    expect(hub.getTimeline).toHaveBeenCalledWith("w1");
    expect(screen.getByText("No date")).toBeTruthy();
  });
  it("refetches when refreshKey changes", async () => {
    const { rerender } = await mount();
    const n = vi.mocked(hub.listEntries).mock.calls.length;
    rerender(
      <I18nProvider>
        <KnowledgePanel workspaceId="w1" knowledgeLanguage="follow" onOpen={vi.fn()} refreshKey={1} />
      </I18nProvider>,
    );
    await act(async () => {});
    expect(vi.mocked(hub.listEntries).mock.calls.length).toBe(n + 1);
  });
  it("ignores an older list response that resolves late", async () => {
    let first!: (l: EntryListItem[]) => void;
    vi.mocked(hub.listEntries).mockReset();
    vi.mocked(hub.listEntries)
      .mockImplementationOnce(() => new Promise<EntryListItem[]>((r) => (first = r)))
      .mockResolvedValue([e("R-9", "requirement", "active", { title: "newer" })]);
    const ui = (k: number) => (
      <I18nProvider>
        <KnowledgePanel workspaceId="w1" knowledgeLanguage="follow" onOpen={vi.fn()} refreshKey={k} />
      </I18nProvider>
    );
    const { rerender } = render(ui(0));
    rerender(ui(1));
    await act(async () => {});
    expect(screen.getByText("newer")).toBeTruthy();
    await act(async () => first([e("R-8", "requirement", "active", { title: "older" })]));
    expect(screen.getByText("newer")).toBeTruthy();
    expect(screen.queryByText("older")).toBeNull();
  });
  it("shows 推断 for an inferred entry and 可能过时 for a source confirmed 91 days ago", async () => {
    const now = new Date("2026-10-23T00:00:00.000Z");
    const confirmedAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem("nema.locale", "zh");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.mocked(hub.listEntries).mockResolvedValue([
      e("R-9", "requirement", "active", { title: "inferred row", basis: "inferred" }),
      e("S-9", "source", "active", { title: "stale source", url: "https://example.com/old", confirmedAt }),
      e("R-8", "requirement", "active", { title: "stated row", basis: "stated" }),
    ]);
    try {
      await mount();
      const inferred = screen.getByText("inferred row").closest("[data-testid='entry-row']") as HTMLElement;
      const tag = within(inferred).getByText("推断");
      expect(tag.classList.contains("atag")).toBe(true);
      expect(tag.classList.contains("user")).toBe(false);
      expect(within(inferred).queryByText("可能过时")).toBeNull();

      const stale = screen.getByText("stale source").closest("[data-testid='entry-row']") as HTMLElement;
      expect(within(stale).getByText(/可能过时/).closest(".kmeta")).toBeTruthy();
      expect(within(stale).queryByText("推断")).toBeNull();

      const stated = screen.getByText("stated row").closest("[data-testid='entry-row']") as HTMLElement;
      expect(within(stated).queryByText("推断")).toBeNull();
      expect(within(stated).queryByText("可能过时")).toBeNull();
    } finally {
      vi.useRealTimers();
      localStorage.removeItem("nema.locale");
    }
  });
  it("diagrams are grouped by repo label and open the html route in a new window", async () => {
    vi.mocked(hub.listRepos).mockResolvedValue([repo("rp_a", "backend"), repo("rp_b", "web app")]);
    vi.mocked(hub.listEntries).mockResolvedValue([
      e("T-1", "tradeoff", "active"),
      e("S-1", "source", "active", { url: "https://example.com/spec" }),
      e("G-1", "diagram", "active", { title: "backend architecture", diagram: { repoId: "rp_a", type: "architecture" } }),
      e("G-2", "diagram", "active", { title: "web flow", diagram: { repoId: "rp_b", type: "workflow" } }),
      e("G-3", "diagram", "active", { title: "backend erd", diagram: { repoId: "rp_a", type: "erd" } }),
    ]);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      const { onOpen } = await mount();
      const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => (h.textContent ?? "").replace(/\d+$/, ""));
      expect(titles.indexOf("Code diagrams")).toBe(titles.indexOf("Trade-offs") + 1);
      expect(titles.indexOf("Sources")).toBe(titles.indexOf("Code diagrams") + 1);

      const group = screen.getByRole("heading", { level: 3, name: /Code diagrams/ }).closest("section") as HTMLElement;
      const labels = within(group).getAllByTestId("repo-label").map((n) => n.textContent);
      expect(labels).toEqual(["backend", "web app"]);
      const ids = within(group).getAllByTestId("entry-id").map((n) => n.textContent);
      expect(ids).toEqual(["G-1", "G-3", "G-2"]);
      const row = screen.getByText("backend erd").closest("[data-testid='entry-row']") as HTMLElement;
      expect(within(row).getByText(/erd/, { selector: ".kmeta" })).toBeTruthy();

      const opener = screen.getByRole("button", { name: "web flow" });
      expect(opener.querySelector(".ext")?.textContent).toBe("↗");
      await userEvent.click(opener);
      expect(open).toHaveBeenCalledWith(`${hub.hubUrl()}/api/workspaces/w1/diagrams/G-2.html`, "_blank", "noopener");
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
  it("a stale diagram shows 可能过时", async () => {
    localStorage.setItem("nema.locale", "zh");
    vi.mocked(hub.listRepos).mockResolvedValue([repo("rp_a", "backend")]);
    vi.mocked(hub.listEntries).mockResolvedValue([
      e("G-1", "diagram", "active", { title: "old map", stale: true, diagram: { repoId: "rp_a", type: "architecture" } }),
      e("G-2", "diagram", "active", { title: "fresh map", stale: false, diagram: { repoId: "rp_a", type: "architecture" } }),
    ]);
    try {
      await mount();
      expect(screen.getByRole("heading", { level: 3, name: /代码图/ })).toBeTruthy();
      const old = screen.getByText("old map").closest("[data-testid='entry-row']") as HTMLElement;
      expect(within(old).getByText(/可能过时/).closest(".kmeta")).toBeTruthy();
      const fresh = screen.getByText("fresh map").closest("[data-testid='entry-row']") as HTMLElement;
      expect(within(fresh).queryByText(/可能过时/)).toBeNull();
    } finally {
      localStorage.removeItem("nema.locale");
    }
  });
  it("requirement rows show each implementation tag, inferred distinct from reported", async () => {
    const impl = (status: "reported" | "verified" | "mismatch", inferred = false, extra: Record<string, unknown> = {}) => ({
      status,
      evidence: { reportMessageId: inferred ? null : "m_r", commits: ["abcdef1"], inferred, note: null, confirmedBy: null, acceptanceReview: null, reportEvidence: null, reports: [{ reportMessageId: "m_r", reportPassed: true }], ...extra },
    }) as never;
    localStorage.setItem("nema.locale", "zh");
    vi.mocked(hub.listEntries).mockResolvedValue([
      e("R-1", "requirement", "active", { title: "reported row", implementation: impl("reported") }),
      e("R-2", "requirement", "active", { title: "inferred row", implementation: impl("reported", true) }),
      e("R-3", "requirement", "active", { title: "verified row", implementation: impl("verified") }),
      e("R-4", "requirement", "active", { title: "mismatch row", implementation: impl("mismatch") }),
      e("R-5", "requirement", "active", { title: "plain row" }),
      e("R-6", "requirement", "active", { title: "unchecked row", implementation: impl("verified", false, { reports: [{ reportMessageId: "m_r", reportPassed: false }] }) }),
      e("R-7", "requirement", "active", { title: "accepted row", implementation: impl("verified", false, { confirmedBy: "user" }) }),
    ]);
    try {
      await mount();
      const row = (title: string) => screen.getByText(title).closest("[data-testid='entry-row']") as HTMLElement;
      const tag = (title: string) => row(title).querySelector("[data-testid='impl-tag']");
      expect(tag("reported row")?.textContent).toBe("已上报");
      expect(tag("inferred row")?.textContent).toBe("已上报（代码推断）");
      expect(tag("verified row")?.textContent).toBe("提交已核对");
      expect(tag("unchecked row")).toBeNull();
      expect(tag("accepted row")?.textContent).toBe("验收已确认");
      expect(tag("mismatch row")?.textContent).toBe("有出入");
      expect(tag("mismatch row")?.classList.contains("red")).toBe(true);
      expect(tag("reported row")?.classList.contains("red")).toBe(false);
      expect(tag("inferred row")?.className).not.toBe(tag("reported row")?.className);
      expect(tag("plain row")).toBeNull();
    } finally {
      localStorage.removeItem("nema.locale");
    }
  });

  it("selecting two requirements generates one package", async () => {
    vi.mocked(hub.listEntries).mockResolvedValue([e("R-1", "requirement", "active"), e("R-2", "requirement", "active"), e("R-3", "requirement", "active")]);
    vi.mocked(hub.requestWorkPackage).mockResolvedValue({ id: "W-1" } as never);
    await mount();
    expect(screen.queryByRole("checkbox")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Select requirements" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "R-3" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "R-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate for selected" }));
    expect(hub.requestWorkPackage).toHaveBeenCalledWith("w1", ["R-1", "R-3"]);
    expect(await screen.findByText("Requested work package W-1")).toBeTruthy();
  });
  it("shows the hub error inline when generating fails", async () => {
    vi.mocked(hub.listEntries).mockResolvedValue([e("R-1", "requirement", "active")]);
    vi.mocked(hub.requestWorkPackage).mockRejectedValue(new Error("还没有绑定仓库"));
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Select requirements" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "R-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate for selected" }));
    expect((await screen.findByRole("alert")).textContent).toBe("还没有绑定仓库");
  });
  it("the group shows status tags and 待澄清 with the question link", async () => {
    const wp = (id: string, status: EntryListItem["status"], blockedOn: string | null) =>
      e(id, "workpackage", status, { workpackage: { blockedOn, taskCount: 2 } });
    vi.mocked(hub.listEntries).mockResolvedValue([
      e("R-1", "requirement", "active"),
      e("Q-1", "question", "open", { priority: 1 }),
      wp("W-1", "draft", "Q-1"),
      wp("W-2", "approved", null),
      wp("W-3", "in_progress", null),
    ]);
    const { onOpen } = await mount();
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent ?? "");
    expect(titles.slice(0, 3).map((t) => t.replace(/\d+$/, ""))).toEqual(["Pending", "Work packages", "Requirements"]);
    const rows = screen.getAllByTestId("wp-status").map((n) => n.textContent);
    expect(rows).toEqual(["Draft", "Approved", "In progress"]);
    const row = screen.getByText("title W-1").closest("[data-testid='entry-row']") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: /Needs answers/ }));
    expect(onOpen).toHaveBeenCalledWith("Q-1");
  });
});
