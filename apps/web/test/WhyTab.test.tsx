import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WhyTab } from "@/components/WhyTab";
import { I18nProvider } from "@/lib/i18n";

const blame = [
  { text: "First paragraph", version: 1, commit: "c1", reason: "created", author: "agent" as const },
  { text: "Second **para**", version: 3, commit: "c3", reason: "tightened", author: "agent" as const },
];

describe("WhyTab", () => {
  it("renders one row per paragraph with version, author and reason", () => {
    render(<I18nProvider><WhyTab blame={blame} onSelectVersion={vi.fn()} /></I18nProvider>);
    const rows = screen.getAllByTestId("why-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("v1 · Agent")).toBeTruthy();
    expect(within(rows[0]).getByText("created")).toBeTruthy();
    expect(within(rows[1]).getByText("v3 · Agent")).toBeTruthy();
    expect(within(rows[1]).getByText("tightened")).toBeTruthy();
  });
  it("selects a version when the reason is clicked", async () => {
    const onSelect = vi.fn();
    render(<I18nProvider><WhyTab blame={blame} onSelectVersion={onSelect} /></I18nProvider>);
    await userEvent.click(screen.getByText("tightened"));
    expect(onSelect).toHaveBeenCalledWith(3);
  });
});
