import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "@/components/MessageItem";
import { SkillOfferCard } from "@/components/SkillOfferCard";
import * as hub from "@/lib/hub";
import { HubError } from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { Message } from "@/lib/types";
import type { SkillInstallJob, SkillInstallOffer } from "@nema/shared";

vi.mock("@/lib/hub", () => {
  class HubError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  }
  return {
    HubError,
    getEntry: vi.fn(),
    withdrawEntry: vi.fn(),
    editMessage: vi.fn(),
    listMessageVersions: vi.fn(),
    installExtension: vi.fn(),
    getExtensionInstall: vi.fn(),
    cancelExtensionInstall: vi.fn(),
    eventsUrl: (id: string) => `http://hub/workspaces/${id}/events`,
  };
});

const COMMIT = "c0ffee0".padEnd(40, "1");
const offer: SkillInstallOffer = {
  id: "pdf",
  name: "pdf",
  description: "Read and fill PDF forms",
  source: "acme/skills",
  repository: "https://github.com/acme/skills",
  commit: COMMIT,
  path: "skills/pdf",
  license: "MIT",
  target: "/home/me/.nema/extensions/extensions/pdf",
};
const job = (state: SkillInstallJob["state"], extra: Partial<SkillInstallJob> = {}): SkillInstallJob => ({
  id: "pdf",
  state,
  done: 0,
  total: 3,
  error: null,
  commit: COMMIT,
  path: "skills/pdf",
  ...extra,
});
const message = (meta: Message["meta"]): Message => ({
  id: "m1",
  workspaceId: "w1",
  role: "agent",
  content: "Here is the skill you asked for.",
  meta,
  taskId: "t1",
  createdAt: "2026-10-30T02:00:00Z",
  editedAt: null,
  threadId: null,
  seq: 1,
});
const card = () => render(<I18nProvider><SkillOfferCard offer={offer} pollMs={1} /></I18nProvider>);

beforeEach(() => {
  vi.mocked(hub.installExtension).mockReset();
  vi.mocked(hub.getExtensionInstall).mockReset().mockRejectedValue(new HubError(502, "pdf has no install"));
  vi.mocked(hub.cancelExtensionInstall).mockReset();
});

describe("SkillOfferCard", () => {
  it("an agent reply with an offer shows the pinned preview and installs nothing by itself", async () => {
    render(<I18nProvider><MessageItem message={message({ changes: [], askedQuestion: null, skillOffers: [offer] })} /></I18nProvider>);
    const region = await screen.findByRole("region", { name: "Install pdf?" });
    expect(region.textContent).toContain("Read and fill PDF forms");
    expect(region.textContent).toContain("https://github.com/acme/skills");
    expect(region.textContent).toContain("Pinned to commit c0ffee0");
    expect(region.textContent).toContain("License: MIT");
    expect(region.textContent).toContain("Installs to /home/me/.nema/extensions/extensions/pdf");
    expect(region.textContent).toContain("Nothing is installed until you press Install.");
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
    expect(hub.installExtension).not.toHaveBeenCalled();
  });

  it("a reply without offers has no install card", () => {
    render(<I18nProvider><MessageItem message={message({ changes: [], askedQuestion: null })} /></I18nProvider>);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("Install sends exactly the offered source, commit and folder once, then follows the job to the end", async () => {
    let release: (value: SkillInstallJob) => void = () => {};
    vi.mocked(hub.installExtension).mockReturnValue(new Promise((resolve) => (release = resolve)));
    card();
    const install = await screen.findByRole("button", { name: "Install" });
    await userEvent.dblClick(install);
    expect(hub.installExtension).toHaveBeenCalledTimes(1);
    expect(hub.installExtension).toHaveBeenCalledWith({ source: "acme/skills", commit: COMMIT, path: "skills/pdf" });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(hub.getExtensionInstall).mockReset().mockResolvedValueOnce(job("running", { done: 2 })).mockResolvedValue(job("installed", { done: 3 }));
    await act(async () => release(job("running", { done: 1 })));
    expect(await screen.findByText("Install finished")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("a skill installed earlier shows as installed when the card opens", async () => {
    vi.mocked(hub.getExtensionInstall).mockResolvedValue(job("installed", { done: 0, total: 0 }));
    card();
    expect(await screen.findByText("Already installed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("a running install can be cancelled from the card", async () => {
    vi.mocked(hub.installExtension).mockResolvedValue(job("running"));
    vi.mocked(hub.getExtensionInstall).mockReset().mockRejectedValueOnce(new HubError(502, "pdf has no install")).mockResolvedValue(job("running", { done: 1 }));
    vi.mocked(hub.cancelExtensionInstall).mockResolvedValue(job("cancelled"));
    card();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel install" }));
    expect(hub.cancelExtensionInstall).toHaveBeenCalledWith("pdf");
    expect(await screen.findByText("Install cancelled")).toBeTruthy();
    // A cancelled install can be started again from the same card.
    expect(screen.getByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("a failed install says why and can be tried again", async () => {
    vi.mocked(hub.installExtension).mockResolvedValue(job("failed", { error: "SKILL.md changed" }));
    card();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect(await screen.findByText("Install failed: SKILL.md changed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a refused install request shows the daemon's answer", async () => {
    vi.mocked(hub.installExtension).mockRejectedValue(new HubError(502, "pdf is already installed"));
    card();
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect((await screen.findByRole("alert")).textContent).toBe("pdf is already installed");
  });
});
