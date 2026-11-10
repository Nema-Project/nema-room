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
});
