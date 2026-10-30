import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentView } from "@nema/shared";
import { AttachmentList } from "@/components/AttachmentList";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";

vi.mock("@/lib/hub", () => ({ fetchAttachmentBlob: vi.fn(), deleteAttachment: vi.fn() }));

const view = (over: Partial<AttachmentView>): AttachmentView => ({
  id: "a1", kind: "image", mime: "image/png", name: "shot.png", size: 245 * 1024, sha256: "0123456789abcdef".repeat(4),
  messageId: "m1", status: "attached", deletedAt: null, ...over,
});
const mount = (attachments: AttachmentView[], canDelete = true) =>
  render(<I18nProvider><AttachmentList workspaceId="w1" attachments={attachments} canDelete={canDelete} /></I18nProvider>);

let n = 0;
beforeEach(() => {
  n = 0;
  vi.mocked(hub.fetchAttachmentBlob).mockResolvedValue(new Blob(["x"], { type: "image/png" }));
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:url-${++n}`), revokeObjectURL: vi.fn() }));
});
afterEach(() => {
  vi.mocked(hub.fetchAttachmentBlob).mockReset();
  vi.mocked(hub.deleteAttachment).mockReset();
  vi.unstubAllGlobals();
});

describe("AttachmentList", () => {
  it("shows an image through a blob: URL, never the hub address", async () => {
    mount([view({})]);
    const img = (await screen.findByRole("img", { name: "shot.png" })) as HTMLImageElement;
    expect(img.src).toBe("blob:url-1");
    expect(hub.fetchAttachmentBlob).toHaveBeenCalledWith("w1", "a1");
  });

  it("revokes the thumbnail URL when it unmounts", async () => {
    const { unmount } = mount([view({})]);
    await screen.findByRole("img", { name: "shot.png" });
    await act(async () => {});
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:url-1");
  });

  it("shows PDFs and text files as cards and downloads on click", async () => {
    vi.mocked(hub.fetchAttachmentBlob).mockResolvedValue(new Blob(["%PDF-1.7"], { type: "application/pdf" }));
    const clicked: { href: string; download: string }[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    mount([view({ id: "p", kind: "pdf", mime: "application/pdf", name: "spec.pdf", size: 2 * 1024 * 1024 }), view({ id: "t", kind: "text", mime: "text/plain", name: "err.log", size: 300 })]);
    expect(screen.getByText("spec.pdf")).toBeTruthy();
    expect(screen.getByText(/application\/pdf/)).toBeTruthy();
    expect(screen.getByText(/2 MB/)).toBeTruthy();
    expect(screen.getByText("err.log")).toBeTruthy();
    expect(hub.fetchAttachmentBlob).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Download spec.pdf" }));
    expect(hub.fetchAttachmentBlob).toHaveBeenCalledWith("w1", "p");
    expect(clicked).toEqual([{ href: "blob:url-1", download: "spec.pdf" }]);
    click.mockRestore();
  });

  it("shows a tombstone for a deleted attachment", () => {
    mount([view({ status: "deleted", deletedAt: "2026-10-30T09:15:00Z" })]);
    const card = screen.getByText(/Attachment deleted/).closest("li")!;
    expect(card.textContent).toContain("shot.png");
    expect(card.textContent).toContain("0123456789ab");
    expect(card.textContent).not.toContain("0123456789abc");
    expect(card.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-30T09:15:00Z");
    expect(hub.fetchAttachmentBlob).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("says the file is missing", () => {
    mount([view({ status: "missing" })]);
    expect(screen.getByText(/Attachment file is missing/)).toBeTruthy();
    expect(hub.fetchAttachmentBlob).not.toHaveBeenCalled();
  });

  it("asks before deleting, warns what cannot be undone, and shows the tombstone it gets back", async () => {
    const deleted = view({ status: "deleted", deletedAt: "2026-10-30T09:15:00Z" });
    vi.mocked(hub.deleteAttachment).mockResolvedValue(deleted);
    mount([view({})]);
    await screen.findByRole("img", { name: "shot.png" });
    await userEvent.click(screen.getByRole("button", { name: "Delete shot.png" }));
    expect(hub.deleteAttachment).not.toHaveBeenCalled();
    expect(screen.getByText(/already sent to an agent or model cannot be taken back/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hub.deleteAttachment).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete shot.png" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete attachment" }));
    expect(hub.deleteAttachment).toHaveBeenCalledWith("w1", "a1");
    expect(await screen.findByText(/Attachment deleted/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:url-1");
  });

  it("keeps the attachment and shows why when deleting fails", async () => {
    vi.mocked(hub.deleteAttachment).mockRejectedValue(new Error("hub down"));
    mount([view({ kind: "text", mime: "text/plain", name: "a.txt" })]);
    await userEvent.click(screen.getByRole("button", { name: "Delete a.txt" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete attachment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("hub down");
    expect(screen.getByText("a.txt")).toBeTruthy();
  });

  it("offers no delete button when deleting is not allowed", async () => {
    mount([view({ kind: "text", mime: "text/plain", name: "a.txt" })], false);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Delete a.txt" })).toBeNull();
  });

  it("shows why an image could not be loaded", async () => {
    vi.mocked(hub.fetchAttachmentBlob).mockRejectedValue(new Error("attachment deleted"));
    mount([view({})]);
    expect(await screen.findByText(/attachment deleted/)).toBeTruthy();
  });

  it("turns the card into a tombstone when the hub says the file was deleted", async () => {
    vi.mocked(hub.fetchAttachmentBlob).mockRejectedValue(Object.assign(new Error("the attachment was deleted"), { status: 410 }));
    mount([view({})]);
    const card = (await screen.findByText(/Attachment deleted/)).closest("li")!;
    expect(card.textContent).toContain("0123456789ab");
    expect(screen.queryByRole("button", { name: "Download shot.png" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete shot.png" })).toBeNull();
  });

  it("marks the card missing when a download finds the file gone", async () => {
    vi.mocked(hub.fetchAttachmentBlob).mockRejectedValue(Object.assign(new Error("the attachment file is missing"), { status: 410 }));
    mount([view({ kind: "text", mime: "text/plain", name: "a.txt" })]);
    await userEvent.click(screen.getByRole("button", { name: "Download a.txt" }));
    expect(await screen.findByText(/Attachment file is missing/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download a.txt" })).toBeNull();
  });

  it("waits until a thumbnail is near the viewport before fetching it", async () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { seen = cb; }
      observe() {}
      disconnect = disconnect;
    });
    mount([view({})]);
    await act(async () => {});
    expect(hub.fetchAttachmentBlob).not.toHaveBeenCalled();
    act(() => seen!([{ isIntersecting: true }]));
    expect(await screen.findByRole("img", { name: "shot.png" })).toBeTruthy();
    expect(hub.fetchAttachmentBlob).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
  });
});
