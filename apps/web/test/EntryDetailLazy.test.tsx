import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EntryDetailLazy } from "@/components/EntryDetailLazy";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { Entry, WorkPackage } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  getEntry: vi.fn(), getHistory: vi.fn(), getWhy: vi.fn(), getVersion: vi.fn(), putEntry: vi.fn(), confirmEntry: vi.fn(), listEntries: vi.fn(), listMessages: vi.fn(),
  listRepos: vi.fn(), updateDiagram: vi.fn(), requestWorkPackage: vi.fn(), getWorkPackage: vi.fn(), confirmImplementation: vi.fn(),
  approveWorkPackage: vi.fn(), saveWorkPackageDoc: vi.fn(), regenerateWorkPackage: vi.fn(), dropWorkPackage: vi.fn(), confirmWorkPackageTask: vi.fn(),
  diagramHtmlUrl: (w: string, g: string) => `http://hub/api/workspaces/${w}/diagrams/${g}.html`,
}));

const entry: Entry = {
  id: "R-1", kind: "requirement", title: "Refund window", status: "active", businessDate: "2026-10-21",
  tags: [], related: [], sourceMessages: [], body: "Refunds within **7 days**.",
  basis: null, ingestedAt: null, confirmedAt: null, confirmedRevision: null, sourceRefs: [], quotes: [],
};
const pkg: WorkPackage = {
  entry: {
    id: "W-2", kind: "workpackage", title: "Refund package", status: "draft", businessDate: null, tags: [], related: [], sourceMessages: [], body: "",
    basis: null, ingestedAt: null, confirmedAt: null, confirmedRevision: null, sourceRefs: [], quotes: [],
    workpackage: { requirements: ["R-3"], repos: ["r1"], approvedAt: null, approvedCommit: null, blockedOn: null, tasks: [] },
  },
  spec: "## 已定的做法\n- 7 天内退款 [R-3]",
  plan: "### 任务 1：退款",
};

beforeEach(() => {
  vi.mocked(hub.getEntry).mockResolvedValue(entry);
  vi.mocked(hub.getHistory).mockResolvedValue([]);
  vi.mocked(hub.getWhy).mockResolvedValue([]);
  vi.mocked(hub.listEntries).mockResolvedValue([]);
  vi.mocked(hub.listMessages).mockResolvedValue([]);
  vi.mocked(hub.listRepos).mockResolvedValue([]);
  vi.mocked(hub.getWorkPackage).mockResolvedValue(pkg);
});

describe("EntryDetailLazy", () => {
  it("lazy-loads and renders a plain entry on first open", async () => {
    render(
      <I18nProvider>
        <EntryDetailLazy workspaceId="w1" entryId="R-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} />
      </I18nProvider>,
    );
    // The lazy chunk import is part of what this waits for; allow for it under
    // parallel test load (findBy's 1s default is not enough on a busy runner).
    expect(await screen.findByText("Refund window", {}, { timeout: 5000 })).toBeTruthy();
    expect(hub.getEntry).toHaveBeenCalledWith("w1", "R-1");
  });

  it("lazy-loads the work package detail for W- entries", async () => {
    render(
      <I18nProvider>
        <EntryDetailLazy workspaceId="w1" entryId="W-2" onClose={vi.fn()} onJumpToMessage={vi.fn()} />
      </I18nProvider>,
    );
    expect(await screen.findByText("Refund package", {}, { timeout: 5000 })).toBeTruthy();
    expect(hub.getWorkPackage).toHaveBeenCalledWith("w1", "W-2");
  });
});
