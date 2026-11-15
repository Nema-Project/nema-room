import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShareView } from "@/components/ShareView";
import { I18nProvider } from "@/lib/i18n";

const token = "b".repeat(43);

describe("ShareView", () => {
  it("renders one entry as a read-only link", () => {
    render(
      <I18nProvider>
        <ShareView
          token={token}
          workspaceName="Alpha"
          entries={[{ id: "D-1", title: "Ship it" }]}
          entry={{ id: "D-1", title: "Ship it", body: "See [D-1].", quotes: [{ text: "public quote" }] }}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send|confirm|edit|发送|确认|编辑/i })).toBeNull();
    expect(screen.getByRole("link", { name: "Ship it" }).getAttribute("href")).toBe(`/s/${token}/e/D-1`);
  });
  it("distinguishes user acceptance from checked commits and shows inferences", () => {
    const selected = { id: "W-1", title: "Work", body: "Body", status: "active", basis: "inferred", confirmedAt: "2026-11-10", implementationStatus: "verified", implementationAccepted: false, implementationInferred: true, quotes: [], workpackage: { blockedOn: null, taskCount: 1, tasks: [{ n: 1, title: "Do work", status: "verified", inferred: true }] } };
    render(<I18nProvider><ShareView token={token} workspaceName="Alpha" entries={[]} entry={selected} /></I18nProvider>);
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getAllByText("Inferred").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Commits checked only").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Accepted by user")).toBeNull();
    expect(screen.getByText("2026-11-10")).toBeTruthy();
    expect(screen.getByText(/Do work/)).toBeTruthy();
  });

  it("only labels implementation accepted when explicitly confirmed", () => {
    render(<I18nProvider><ShareView token={token} workspaceName="Alpha" entries={[{ id: "R-1", title: "Accepted", implementationStatus: "verified", implementationAccepted: true }]} /></I18nProvider>);
    expect(screen.getByText("Accepted by user")).toBeTruthy();
  });

  it("retains a changed check status alongside user acceptance", () => {
    render(<I18nProvider><ShareView token={token} workspaceName="Alpha" entries={[{ id: "R-1", title: "Review", implementationStatus: "mismatch", implementationAccepted: true }]} /></I18nProvider>);
    expect(screen.getByText("Mismatch")).toBeTruthy();
    expect(screen.getByText(/Accepted by user/)).toBeTruthy();
  });

  it("translates work-package statuses with the existing work-package keys", () => {
    render(<I18nProvider><ShareView token={token} workspaceName="Alpha" entries={[{ id: "W-1", title: "Work", status: "draft", basis: null }]} /></I18nProvider>);
    expect(screen.getByText("Draft")).toBeTruthy();
  });

});
