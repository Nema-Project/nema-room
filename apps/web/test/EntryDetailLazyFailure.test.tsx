import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EntryDetailLazy } from "@/components/EntryDetailLazy";
import { I18nProvider } from "@/lib/i18n";

// Simulates a failed chunk load. A rejected dynamic import reaches the error
// boundary as a throw during the lazy component's render, so a component that
// throws on render stands in for it (a throwing mock factory instead leaves
// vitest's module import pending forever).
vi.mock("@/components/EntryDetail", () => ({
  EntryDetail: () => {
    throw new Error("chunk load failed");
  },
}));

describe("EntryDetailLazy load failure", () => {
  it("shows the detail error presentation instead of a blank screen, and close still works", async () => {
    const onClose = vi.fn();
    render(
      <I18nProvider>
        <div>
          <span>shell survives</span>
          <EntryDetailLazy workspaceId="w1" entryId="R-1" onClose={onClose} onJumpToMessage={vi.fn()} />
        </div>
      </I18nProvider>,
    );
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toBe("Could not load entry: chunk load failed");
    expect(screen.getByText("shell survives")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
