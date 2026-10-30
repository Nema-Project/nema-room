import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentView } from "@nema/shared";
import { Composer } from "@/components/Composer";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";

vi.mock("@/lib/hub", () => ({
  uploadAttachment: vi.fn(),
  attachmentCapabilities: vi.fn(),
  HubError: class HubError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const mount = (onSend: (c: string, ids: string[]) => Promise<void>) =>
  render(
    <I18nProvider>
      <Composer onSend={onSend} />
    </I18nProvider>,
  );
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("Composer", () => {
  it("/thread text posts a new thread", async () => {
    const onThread = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider><Composer onSend={vi.fn()} onThread={onThread} /></I18nProvider>);
    await userEvent.type(box(), "/thr");
    await userEvent.click(screen.getByRole("option", { name: /thread/i }));
    await userEvent.type(box(), "need details{Shift>}{Enter}{/Shift}");
    expect(onThread).toHaveBeenCalledWith("need details", []);
  });
  it("thread mode selects only visible slash commands by keyboard", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider><Composer onSend={onSend} threadMode /></I18nProvider>);
    await userEvent.type(box(), "/");
    await userEvent.keyboard("{Enter}");
    expect(box().value).toContain("Say how far this is, based on the code");
    expect(box().value).not.toContain("/thread");
    expect(onSend).not.toHaveBeenCalled();
  });
  it("thread mode does not offer a typed /thread command", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider><Composer onSend={onSend} threadMode /></I18nProvider>);
    await userEvent.type(box(), "/thread");
    expect(screen.queryByRole("option", { name: /thread/i })).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
  });
  it("Enter inserts a newline and does not send", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "a{Enter}");
    expect(box().value).toBe("a\n");
    expect(onSend).not.toHaveBeenCalled();
  });
  it("Shift+Enter sends and clears", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "a{Shift>}{Enter}{/Shift}");
    expect(onSend).toHaveBeenCalledWith("a", []);
    await vi.waitFor(() => expect(box().value).toBe(""));
  });
  it("keeps text typed while a send is in flight", async () => {
    let resolve!: () => void;
    const onSend = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    mount(onSend);
    await userEvent.type(box(), "hello{Shift>}{Enter}{/Shift}");
    expect(onSend).toHaveBeenCalledWith("hello", []);
    await userEvent.type(box(), " world");
    resolve();
    await vi.waitFor(() => expect((screen.getByRole("button", { name: /送信|发送|Send/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(box().value).toBe("world");
  });
  it("keeps the whole draft if the sent text was edited during the send", async () => {
    let resolve!: () => void;
    const onSend = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    mount(onSend);
    await userEvent.type(box(), "abc{Shift>}{Enter}{/Shift}");
    await userEvent.clear(box());
    await userEvent.type(box(), "xyz");
    resolve();
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(box().value).toBe("xyz");
  });
  it("does not send during IME composition", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "a");
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
  it("does not send on keyCode 229 without compositionstart (Safari)", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "a");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true, keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });
  it("does not send when isComposing is set without compositionstart", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "a");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true, isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
  it("sends again after compositionend", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "a");
    fireEvent.compositionStart(box());
    fireEvent.compositionEnd(box());
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(onSend).toHaveBeenCalledWith("a", []);
  });
  it("does not send whitespace-only content", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "   {Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
  });
  it("lists diagram types and Enter fills the one the typed prefix matches", async () => {
    mount(vi.fn().mockResolvedValue(undefined));
    await userEvent.type(box(), "/");
    expect(screen.getAllByRole("option")).toHaveLength(13);
    await userEvent.type(box(), "diagram:s");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["/diagram:sequenceSequence"]);
    await userEvent.keyboard("{Enter}");
    expect(box().value).toBe("Draw a sequence code diagram.");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("Escape closes the slash menu until the query changes", async () => {
    mount(vi.fn().mockResolvedValue(undefined));
    await userEvent.type(box(), "/");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.type(box(), "p");
    expect(screen.getByRole("option", { name: /\/progress/ })).toBeTruthy();
  });
  it("keeps content and shows an error when sending fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("boom"));
    mount(onSend);
    await userEvent.type(box(), "keep{Shift>}{Enter}{/Shift}");
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(box().value).toBe("keep");
  });
});

const png = (name = "shot.png") => new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])], name, { type: "image/png" });
const pdf = (name = "spec.pdf") => new File(["%PDF-1.7\n"], name, { type: "application/pdf" });
const staged = (file: File, id: string): AttachmentView => ({
  id, kind: file.type === "application/pdf" ? "pdf" : "image", mime: file.type, name: file.name, size: file.size, sha256: "a".repeat(64), messageId: null, status: "staged", deletedAt: null,
});
const allNative = { adapter: "codex-direct", image: "native", pdf: "native", text: "text" } as const;

describe("Composer attachments", () => {
  beforeEach(() => {
    vi.mocked(hub.attachmentCapabilities).mockResolvedValue(allNative);
    let n = 0;
    vi.mocked(hub.uploadAttachment).mockImplementation(async (_w, file) => staged(file as File, `att${++n}`));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    vi.mocked(hub.uploadAttachment).mockReset();
    vi.mocked(hub.attachmentCapabilities).mockReset();
    vi.unstubAllGlobals();
  });
  const mountWs = async (onSend: (c: string, ids: string[]) => Promise<void> = vi.fn().mockResolvedValue(undefined), onThread?: (c: string, ids: string[]) => Promise<void>) => {
    render(<I18nProvider><Composer workspaceId="w1" onSend={onSend} onThread={onThread} /></I18nProvider>);
    await act(async () => {});
    return onSend;
  };
  const picker = () => screen.getByLabelText("Choose files to attach") as HTMLInputElement;
  const sendButton = () => screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;

  it("hides the attachment entry when the hub has no attachment support", async () => {
    vi.mocked(hub.attachmentCapabilities).mockResolvedValue(null);
    await mountWs();
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
    expect(screen.queryByLabelText("Choose files to attach")).toBeNull();
  });

  it("uploads a chosen file, previews it, and sends an attachment-only message", async () => {
    const onSend = await mountWs();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    const file = png();
    await userEvent.upload(picker(), file);
    await vi.waitFor(() => expect(hub.uploadAttachment).toHaveBeenCalledWith("w1", file, expect.stringMatching(/^[0-9a-f-]{36}$/)));
    expect((await screen.findByRole("img", { name: "shot.png" }) as HTMLImageElement).src).toBe("blob:preview");
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("", ["att1"]);
    await vi.waitFor(() => expect(screen.queryByRole("img", { name: "shot.png" })).toBeNull());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("uploads pasted files", async () => {
    await mountWs();
    const file = png("pasted.png");
    fireEvent.paste(box(), { clipboardData: { files: [file], types: ["Files"], getData: () => "" } });
    await vi.waitFor(() => expect(hub.uploadAttachment).toHaveBeenCalledWith("w1", file, expect.any(String)));
  });

  it("pastes text, not an attachment, when the clipboard also holds a picture of it", async () => {
    await mountWs();
    fireEvent.paste(box(), { clipboardData: { files: [png("render.png")], types: ["text/plain", "Files"], getData: (t: string) => (t === "text/plain" ? "copied words" : "") } });
    await act(async () => {});
    expect(hub.uploadAttachment).not.toHaveBeenCalled();
  });

  it("uploads dropped files", async () => {
    await mountWs();
    const file = pdf();
    fireEvent.drop(box().closest(".composer")!, { dataTransfer: { files: [file], types: ["Files"] } });
    await vi.waitFor(() => expect(hub.uploadAttachment).toHaveBeenCalledWith("w1", file, expect.any(String)));
    expect(await screen.findByText("spec.pdf")).toBeTruthy();
  });

  it("cannot send while an upload is in flight", async () => {
    let finish!: (v: AttachmentView) => void;
    vi.mocked(hub.uploadAttachment).mockImplementation(() => new Promise((r) => (finish = r)));
    const onSend = await mountWs();
    const file = png();
    await userEvent.upload(picker(), file);
    expect(await screen.findByRole("progressbar", { name: "Uploading shot.png" })).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => finish(staged(file, "late")));
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it("refuses an oversize file before uploading it", async () => {
    await mountWs();
    const big = pdf("big.pdf");
    Object.defineProperty(big, "size", { value: 21 * 1024 * 1024 });
    await userEvent.upload(picker(), big);
    expect((await screen.findByRole("alert")).textContent).toContain("big.pdf");
    expect(hub.uploadAttachment).not.toHaveBeenCalled();
  });

  it("refuses a file whose extension does not match its content", async () => {
    await mountWs();
    await userEvent.upload(picker(), new File(["%PDF-1.7"], "fake.png"));
    expect((await screen.findByRole("alert")).textContent).toContain("fake.png");
    expect(hub.uploadAttachment).not.toHaveBeenCalled();
  });

  it("blocks sending a type the adapter cannot read, with the reason", async () => {
    vi.mocked(hub.attachmentCapabilities).mockResolvedValue({ adapter: "claude-code", image: "native", pdf: "unknown", text: "text" });
    const onSend = await mountWs();
    await userEvent.upload(picker(), pdf());
    expect((await screen.findByText(/claude-code/)).textContent).toContain("spec.pdf");
    await userEvent.type(box(), "read this");
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Remove spec.pdf" }));
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
  });

  it("still allows attachments when the daemon cannot be asked, and says the daemon will check", async () => {
    vi.mocked(hub.attachmentCapabilities).mockRejectedValue(new hub.HubError(503, "daemon offline"));
    const onSend = await mountWs();
    await userEvent.upload(picker(), pdf());
    expect(await screen.findByText(/the daemon checks/i)).toBeTruthy();
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("", ["att1"]);
  });

  it("keeps text and attachments when sending fails", async () => {
    const onSend = await mountWs(vi.fn().mockRejectedValue(new Error("boom")));
    await userEvent.upload(picker(), png());
    await userEvent.type(box(), "look");
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("look", ["att1"]);
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(box().value).toBe("look");
    expect(screen.getByRole("img", { name: "shot.png" })).toBeTruthy();
  });

  it("blocks sending after a failed upload and retries with the same upload key", async () => {
    vi.mocked(hub.uploadAttachment).mockRejectedValueOnce(new hub.HubError(507, "attachment storage is full"));
    const onSend = await mountWs();
    await userEvent.upload(picker(), png());
    expect(await screen.findByText(/attachment storage is full/)).toBeTruthy();
    await userEvent.type(box(), "x");
    expect(sendButton().disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Retry shot.png" }));
    await vi.waitFor(() => expect(hub.uploadAttachment).toHaveBeenCalledTimes(2));
    const keys = vi.mocked(hub.uploadAttachment).mock.calls.map((c) => c[2]);
    expect(keys[0]).toBe(keys[1]);
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("x", ["att1"]);
  });

  it("passes attachments to a /thread command", async () => {
    const onThread = vi.fn().mockResolvedValue(undefined);
    await mountWs(vi.fn(), onThread);
    await userEvent.upload(picker(), png());
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.type(box(), "/thread look here");
    fireEvent.keyDown(box(), { key: "Escape" });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    await vi.waitFor(() => expect(onThread).toHaveBeenCalledWith("look here", ["att1"]));
  });

  it("allows at most eight attachments", async () => {
    await mountWs();
    const files = Array.from({ length: 9 }, (_, i) => png(`p${i}.png`));
    await userEvent.upload(picker(), files);
    expect((await screen.findByRole("alert")).textContent).toContain("p8.png");
    await vi.waitFor(() => expect(hub.uploadAttachment).toHaveBeenCalledTimes(8));
  });
});
