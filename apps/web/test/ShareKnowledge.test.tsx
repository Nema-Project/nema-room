import { act, render, screen } from "@testing-library/react";
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

  it("does not send a second create while the first request is open", async () => {
    let finish: (value: Awaited<ReturnType<typeof hub.createShare>>) => void = () => {};
    vi.mocked(hub.createShare).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    renderShare();
    const button = await screen.findByRole("button", { name: "Create link" });
    await user.click(button);
    await user.click(button);
    expect(hub.createShare).toHaveBeenCalledTimes(1);
    finish({ id: "ks_1", token, note: null, expiresAt: null, revokedAt: null, createdAt: "2026-11-10T00:00:00.000Z" });
  });

  it("disables create while the workspace is confidential", async () => {
    renderShare({ confidential: true });
    expect((await screen.findByRole("button", { name: "Create link" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("keeps a newly created link when an earlier list GET finishes late", async () => {
    let finish!: (value: Awaited<ReturnType<typeof hub.listShares>>) => void;
    vi.mocked(hub.listShares).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    vi.mocked(hub.createShare).mockResolvedValue({ id: "ks_new", token, note: "new link", expiresAt: null, revokedAt: null, createdAt: "2026-11-10T00:00:00.000Z" });
    renderShare();
    await userEvent.click(await screen.findByRole("button", { name: "Create link" }));
    expect(await screen.findByText("new link")).toBeTruthy();
    await act(async () => { finish({ shares: [] }); });
    expect(screen.getByText("new link")).toBeTruthy();
  });

  it("keeps create disabled after a 403", async () => {
    vi.mocked(hub.createShare).mockRejectedValue({ status: 403 });
    renderShare();
    const button = await screen.findByRole("button", { name: "Create link" });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Sharing is turned off on this server.");
    expect(button).toHaveProperty("disabled", true);
    await userEvent.click(button);
    expect(hub.createShare).toHaveBeenCalledTimes(1);
  });

  it("identifies links with their creation time and short id", async () => {
    vi.mocked(hub.listShares).mockResolvedValue({ shares: [{ id: "ks_123456789abcdef", note: null, expiresAt: null, revokedAt: null, createdAt: "2026-11-10T00:00:00.000Z" }] });
    renderShare();
    expect(await screen.findByText("Link 789abcdef")).toBeTruthy();
    expect(screen.getByText("2026-11-10T00:00:00.000Z").getAttribute("datetime")).toBe("2026-11-10T00:00:00.000Z");
  });

  it("keeps revocation when a list started before the mutation resolves late", async () => {
    let finish!: (value: Awaited<ReturnType<typeof hub.listShares>>) => void;
    vi.mocked(hub.listShares).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const share = { id: "ks_new", note: "new link", expiresAt: null, revokedAt: null, createdAt: "2026-11-10T00:00:00.000Z" };
    vi.mocked(hub.createShare).mockResolvedValue({ ...share, token });
    vi.mocked(hub.revokeShare).mockResolvedValue({ ...share, revokedAt: "2026-11-10T01:00:00.000Z" });
    renderShare();
    await userEvent.click(await screen.findByRole("button", { name: "Create link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Revoked")).toBeTruthy();
    await act(async () => { finish({ shares: [share] }); });
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

});
