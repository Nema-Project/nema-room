import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AttachmentTray } from "@/components/AttachmentTray";
import type { CapabilityState, Notice, TrayItem } from "@/lib/attachments";
import { I18nProvider } from "@/lib/i18n";

const file = (name: string) => new File(["x"], name);
const item = (over: Partial<TrayItem>): TrayItem => ({
  key: "k1", file: file("shot.png"), name: "shot.png", size: 2048, kind: "image", previewUrl: "blob:preview-1", state: "ready", view: null, error: null, ...over,
});
const ok: CapabilityState = { state: "ok", caps: { adapter: "claude-code", image: "native", pdf: "unknown", text: "text" } };
const mount = (items: TrayItem[], caps: CapabilityState = ok, extra: { notices?: Notice[] } = {}) => {
  const onRemove = vi.fn();
  const onRetry = vi.fn();
  render(
    <I18nProvider>
      <AttachmentTray items={items} caps={caps} notices={extra.notices ?? []} onRemove={onRemove} onRetry={onRetry} />
    </I18nProvider>,
  );
  return { onRemove, onRetry };
};

describe("AttachmentTray", () => {
  it("shows an image preview, the size, and removes an item", async () => {
    const { onRemove } = mount([item({})]);
    expect((screen.getByRole("img", { name: "shot.png" }) as HTMLImageElement).src).toBe("blob:preview-1");
    expect(screen.getByText("2 KB")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(onRemove).toHaveBeenCalledWith("k1");
  });

  it("shows progress while uploading", () => {
    mount([item({ state: "uploading" })]);
    expect(screen.getByRole("progressbar", { name: "Uploading shot.png" })).toBeTruthy();
  });

  it("shows a failed upload with its reason and a retry button", async () => {
    const { onRetry } = mount([item({ state: "failed", error: "attachment storage is full" })]);
    expect(screen.getByText(/attachment storage is full/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Retry shot.png" }));
    expect(onRetry).toHaveBeenCalledWith("k1");
  });

  it("names the adapter and the type it cannot read", () => {
    mount([item({ key: "p", name: "spec.pdf", kind: "pdf", previewUrl: null })]);
    const warning = screen.getByText(/claude-code/);
    expect(warning.textContent).toContain("PDF");
    expect(warning.textContent).toContain("spec.pdf");
  });

  it("explains an unsupported type differently from an unconfirmed one", () => {
    mount([item({ key: "i" })], { state: "ok", caps: { adapter: "codex-direct", image: "unsupported", pdf: "native", text: "text" } });
    expect(screen.getByText(/codex-direct/).textContent).toMatch(/cannot read images/);
  });

  it("says the daemon will check when capabilities cannot be confirmed", () => {
    mount([item({})], { state: "unavailable" });
    expect(screen.getByText(/the daemon checks/i)).toBeTruthy();
  });

  it("shows notices for files that were not added", () => {
    mount([], ok, { notices: [{ reason: "too_large", name: "big.pdf" }, { reason: "too_many", name: "ninth.txt" }] });
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("big.pdf");
    expect(alert).toContain("20 MB");
    expect(alert).toContain("ninth.txt");
  });
});
