import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryDetailLazy } from "@/components/EntryDetailLazy";
import { I18nProvider } from "@/lib/i18n";

// Simulates a chunk load that fails until the test flips it healthy. As in
// EntryDetailLazyFailure.test.tsx, the failure is simulated at render: a
// rejected dynamic import reaches the error boundary as a throw during the
// lazy component's render. The failure is flag-based rather than a one-shot
// counter because React may re-render a throwing tree while recovering, so a
// counter would let the first mount succeed on its own retry. What this test
// pins down is the retry behavior the per-mount loadable exists for — closing
// the detail and reopening it must make a fresh attempt instead of
// re-exposing the first failure (a module-level loadable caches the rejection
// on its React.lazy resource and would keep failing until a page reload).
const state = vi.hoisted(() => ({ failing: true, attempts: 0 }));
vi.mock("@/components/EntryDetail", () => ({
  EntryDetail: () => {
    state.attempts += 1;
    if (state.failing) throw new Error("chunk load failed");
    return <div>entry detail content</div>;
  },
}));

describe("EntryDetailLazy load retry", () => {
  it("makes a successful second attempt when the entry is closed and reopened after a failed load", async () => {
    const ui = (
      <I18nProvider>
        <EntryDetailLazy workspaceId="w1" entryId="R-1" onClose={vi.fn()} onJumpToMessage={vi.fn()} />
      </I18nProvider>
    );
    const first = render(ui);
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toBe("Could not load entry: chunk load failed");
    first.unmount();
    state.failing = false;
    render(ui);
    expect(await screen.findByText("entry detail content", {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(state.attempts).toBeGreaterThan(1);
  });
});
