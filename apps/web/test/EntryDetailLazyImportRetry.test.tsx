import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryDetailLazy } from "@/components/EntryDetailLazy";
import { I18nProvider } from "@/lib/i18n";

// Drives the real import-rejection path through the injectable loader: the
// first import rejects (the loadError presentation), and reopening the entry
// makes a second import attempt that succeeds. A module-level React.lazy
// loadable caches the first rejection on its resource, so with the original
// loader this reopening could never succeed.
describe("EntryDetailLazy import rejection", () => {
  it("retries a rejected import when the entry is closed and reopened", async () => {
    let calls = 0;
    const loadEntryDetail = () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("chunk load failed"));
      return Promise.resolve({ EntryDetail: () => <div>entry detail content</div> });
    };
    const ui = (
      <I18nProvider>
        <EntryDetailLazy
          loadEntryDetail={loadEntryDetail}
          workspaceId="w1"
          entryId="R-1"
          onClose={vi.fn()}
          onJumpToMessage={vi.fn()}
        />
      </I18nProvider>
    );
    const first = render(ui);
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toBe("Could not load entry: chunk load failed");
    first.unmount();
    render(ui);
    expect(await screen.findByText("entry detail content", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toBe(2);
  });
});
