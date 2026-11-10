import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShareKnowledge } from "@/components/ShareKnowledge";
import { I18nProvider } from "@/lib/i18n";
import * as hub from "@/lib/hub";

vi.mock("@/lib/hub", () => ({
  listShares: vi.fn(),
  createShare: vi.fn(),
  revokeShare: vi.fn(),
}));

const token = "a".repeat(43);

beforeEach(() => {
  vi.mocked(hub.listShares).mockReset();
  vi.mocked(hub.createShare).mockReset();
  vi.mocked(hub.revokeShare).mockReset();
  vi.mocked(hub.listShares).mockResolvedValue({ shares: [] });
});

function renderShare(props: { confidential?: boolean; archived?: boolean } = {}) {
  return render(
    <I18nProvider>
      <ShareKnowledge workspaceId="w1" confidential={props.confidential ?? false} archived={props.archived ?? false} />
    </I18nProvider>,
  );
}

describe("ShareKnowledge", () => {
  it("shows a created link once, then hides the token on the next render", async () => {
    vi.mocked(hub.createShare).mockResolvedValue({
      id: "ks_1",
      token,
      note: null,
      expiresAt: null,
      revokedAt: null,
      createdAt: "2026-11-10T00:00:00.000Z",
    });
    const first = renderShare();
    await userEvent.click(await screen.findByRole("button", { name: "Create link" }));
    expect(hub.createShare).toHaveBeenCalledTimes(1);
    expect(screen.getByDisplayValue(`${location.origin}/s/${token}`)).toBeTruthy();
    first.unmount();
    renderShare();
    await screen.findByRole("button", { name: "Create link" });
    expect(screen.queryByDisplayValue(`${location.origin}/s/${token}`)).toBeNull();
    expect(screen.queryByText(token)).toBeNull();
  });

  it("revokes a listed link", async () => {
    vi.mocked(hub.listShares).mockResolvedValue({
      shares: [{ id: "ks_1", note: "desk", expiresAt: null, revokedAt: null, createdAt: "2026-11-10T00:00:00.000Z" }],
    });
    vi.mocked(hub.revokeShare).mockResolvedValue({
      id: "ks_1",
      note: "desk",
      expiresAt: null,
      revokedAt: "2026-11-10T01:00:00.000Z",
      createdAt: "2026-11-10T00:00:00.000Z",
    });
    renderShare();
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(hub.revokeShare).toHaveBeenCalledWith("w1", "ks_1");
  });

  it("disables create while the workspace is confidential", async () => {
    renderShare({ confidential: true });
    expect((await screen.findByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
