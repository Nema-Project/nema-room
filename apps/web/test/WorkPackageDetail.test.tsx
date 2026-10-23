import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkPackageDetail } from "@/components/WorkPackageDetail";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { Entry, WorkPackage, WpTask } from "@/lib/types";

vi.mock("@/lib/hub", () => ({
  getWorkPackage: vi.fn(), getHistory: vi.fn(), getVersion: vi.fn(), approveWorkPackage: vi.fn(), saveWorkPackageDoc: vi.fn(),
  regenerateWorkPackage: vi.fn(), dropWorkPackage: vi.fn(), confirmWorkPackageTask: vi.fn(),
}));

const task = (n: number, extra: Partial<WpTask> = {}): WpTask => ({
  n, title: `task ${n}`, satisfies: ["R-3"], files: [], status: "pending", inferred: false, reportMessageId: null, confirmedBy: null, ...extra,
});
const wpEntry = (status: Entry["status"], tasks: WpTask[], blockedOn: string | null = null): Entry => ({
  id: "W-2", kind: "workpackage", title: "Refund package", status, businessDate: null, related: [], sourceMessages: [], body: "",
  basis: null, ingestedAt: null, confirmedAt: null, quotes: [],
  workpackage: { requirements: ["R-3", "R-5"], repos: ["r1"], approvedAt: null, approvedCommit: null, blockedOn, tasks },
});
const pkg = (status: Entry["status"], opts: { spec?: string | null; plan?: string | null; tasks?: WpTask[] } = {}): WorkPackage => ({
  entry: wpEntry(status, opts.tasks ?? [task(1)]),
  spec: opts.spec === undefined ? "## 已定的做法\n- 7 天内退款 [R-3]" : opts.spec,
  plan: opts.plan === undefined ? "### 任务 1：退款" : opts.plan,
});

const mount = async (props: { onOpenEntry?: (id: string) => void; onJumpToMessage?: (id: string) => void } = {}) => {
  render(
    <I18nProvider>
      <WorkPackageDetail workspaceId="w1" entryId="W-2" onClose={vi.fn()} onJumpToMessage={props.onJumpToMessage ?? vi.fn()} onOpenEntry={props.onOpenEntry} />
    </I18nProvider>,
  );
  await act(async () => {});
};

beforeEach(() => {
  localStorage.clear();
  for (const f of [hub.getWorkPackage, hub.getHistory, hub.approveWorkPackage, hub.saveWorkPackageDoc, hub.regenerateWorkPackage, hub.dropWorkPackage, hub.confirmWorkPackageTask]) vi.mocked(f).mockReset();
  vi.mocked(hub.getWorkPackage).mockResolvedValue(pkg("draft"));
  vi.mocked(hub.getHistory).mockResolvedValue([]);
});

describe("WorkPackageDetail", () => {
  it("detail tabs render spec markers as links, edit saves, approve appears only for a draft with spec and plan", async () => {
    const onOpenEntry = vi.fn();
    await mount({ onOpenEntry });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "Spec" }));
    await userEvent.click(screen.getByRole("button", { name: "[R-3]" }));
    expect(onOpenEntry).toHaveBeenCalledWith("R-3");

    vi.mocked(hub.saveWorkPackageDoc).mockResolvedValue(pkg("draft").entry);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: "Spec" });
    await userEvent.clear(box);
    await userEvent.type(box, "new spec");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(hub.saveWorkPackageDoc).toHaveBeenCalledWith("w1", "W-2", "spec", "new spec");

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(hub.approveWorkPackage).toHaveBeenCalledWith("w1", "W-2");
  });

  it("shows no approve for an approved package or a draft without a plan", async () => {
    vi.mocked(hub.getWorkPackage).mockResolvedValue(pkg("approved"));
    await mount();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
  });

  it("no approve for a draft that has no plan", async () => {
    vi.mocked(hub.getWorkPackage).mockResolvedValue(pkg("draft", { plan: null }));
    await mount();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows a refused save inline", async () => {
    vi.mocked(hub.saveWorkPackageDoc).mockRejectedValue(new Error("缺少来源标记：- 7 天"));
    await mount();
    await userEvent.click(screen.getByRole("tab", { name: "Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("缺少来源标记：- 7 天");
  });

  it("task rows show status and confirm", async () => {
    const onJump = vi.fn();
    vi.mocked(hub.getWorkPackage).mockResolvedValue(
      pkg("in_progress", { tasks: [task(1, { status: "verified", reportMessageId: "m_1" }), task(2, { status: "reported", inferred: true }), task(3, { status: "mismatch" }), task(4)] }),
    );
    await mount({ onJumpToMessage: onJump });
    const rows = screen.getAllByTestId("task-row");
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("Verified")).toBeTruthy();
    expect(within(rows[1]!).getByText("Reported (inferred from code)")).toBeTruthy();
    expect(within(rows[2]!).getByText("Mismatch").classList.contains("red")).toBe(true);
    expect(within(rows[3]!).getByText("Pending")).toBeTruthy();
    expect(within(rows[0]!).queryByRole("button", { name: /Confirm implemented/ })).toBeNull();
    expect(within(rows[3]!).queryByRole("button", { name: /Confirm implemented/ })).toBeNull();
    await userEvent.click(within(rows[0]!).getByRole("button", { name: "View report" }));
    expect(onJump).toHaveBeenCalledWith("m_1");
    await userEvent.click(within(rows[1]!).getByRole("button", { name: /Confirm implemented/ }));
    expect(hub.confirmWorkPackageTask).toHaveBeenCalledWith("w1", "W-2", 2);
  });
});
