import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HistoryTab } from "@/components/HistoryTab";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { Entry, HistoryItem } from "@/lib/types";

vi.mock("@/lib/hub", () => ({ getVersion: vi.fn() }));

const base: Entry = {
  id: "R-1", kind: "requirement", title: "t", status: "active", businessDate: null, related: [], sourceMessages: [], body: "",
  basis: null, ingestedAt: null, confirmedAt: null, quotes: [],
};
const h = (version: number, author: HistoryItem["author"]): HistoryItem => ({
  version, commit: `c${version}`, committedAt: "2026-10-21T14:00:00Z", op: version === 1 ? "add" : "update", reason: `reason ${version}`, sourceMessages: [], author,
});
const history = [h(3, "agent"), h(2, "user"), h(1, "agent")];

const mount = async () => {
  vi.mocked(hub.getVersion).mockResolvedValue({ ...base, body: "keep\nold line" });
  render(
    <I18nProvider>
      <HistoryTab workspaceId="w1" entryId="R-1" history={history} current={{ ...base, body: "keep\nnew line" }} />
    </I18nProvider>,
  );
  await act(async () => {});
};

describe("HistoryTab", () => {
  it("lists versions newest first with author tags", async () => {
    await mount();
    const rows = screen.getAllByTestId("version-row");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("v3"), expect.stringContaining("v2"), expect.stringContaining("v1")]);
    expect(rows.map((r) => r.querySelector("[data-author]")?.textContent)).toEqual(["Agent", "You", "Agent"]);
  });
  it("diffs the selected version against the current body", async () => {
    await mount();
    await userEvent.click(screen.getAllByTestId("version-row")[1]);
    await act(async () => {});
    expect(hub.getVersion).toHaveBeenCalledWith("w1", "R-1", "c2");
    expect(screen.getByText("v2 → v3")).toBeTruthy();
    const del = screen.getByText("old line").closest("[data-diff]") as HTMLElement;
    expect(del.getAttribute("data-diff")).toBe("del");
    const add = screen.getByText("new line").closest("[data-diff]") as HTMLElement;
    expect(add.getAttribute("data-diff")).toBe("add");
    expect(add.textContent).toContain("+");
  });
  it("labels a system author", async () => {
    vi.mocked(hub.getVersion).mockResolvedValue(base);
    render(
      <I18nProvider>
        <HistoryTab workspaceId="w1" entryId="R-1" history={[{ ...h(1, "agent"), author: "system" }]} current={base} />
      </I18nProvider>,
    );
    await act(async () => {});
    const tag = screen.getByTestId("version-row").querySelector("[data-author='system']") as HTMLElement;
    expect(tag.textContent).toBe("System");
    expect(tag.className).toBe("atag");
  });
});
