import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentView } from "@nema/shared";
import { Composer } from "@/components/Composer";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import { resetSkillMenuCache } from "@/lib/skillMenu";

vi.mock("@/lib/hub", () => ({
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  attachmentCapabilities: vi.fn(),
  listSkills: vi.fn(),
  searchMentionContext: vi.fn(),
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
    expect(onThread).toHaveBeenCalledWith("need details", [], []);
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
    expect(onSend).toHaveBeenCalledWith("a", [], []);
    await vi.waitFor(() => expect(box().value).toBe(""));
  });
  it("keeps text typed while a send is in flight", async () => {
    let resolve!: () => void;
    const onSend = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    mount(onSend);
    await userEvent.type(box(), "hello{Shift>}{Enter}{/Shift}");
    expect(onSend).toHaveBeenCalledWith("hello", [], []);
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
    expect(onSend).toHaveBeenCalledWith("a", [], []);
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
    vi.mocked(hub.deleteAttachment).mockImplementation(async (_w, id) => ({ ...staged(png(), id), status: "deleted", deletedAt: "2026-10-30T00:00:00.000Z" }));
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    vi.mocked(hub.uploadAttachment).mockReset();
    vi.mocked(hub.attachmentCapabilities).mockReset();
    vi.mocked(hub.deleteAttachment).mockReset();
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
    expect(onSend).toHaveBeenCalledWith("", ["att1"], []);
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
    expect(onSend).toHaveBeenCalledWith("", ["att1"], []);
  });

  it("keeps text and attachments when sending fails", async () => {
    const onSend = await mountWs(vi.fn().mockRejectedValue(new Error("boom")));
    await userEvent.upload(picker(), png());
    await userEvent.type(box(), "look");
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("look", ["att1"], []);
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
    expect(onSend).toHaveBeenCalledWith("x", ["att1"], []);
  });

  it("passes attachments to a /thread command", async () => {
    const onThread = vi.fn().mockResolvedValue(undefined);
    await mountWs(vi.fn(), onThread);
    await userEvent.upload(picker(), png());
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.type(box(), "/thread look here");
    fireEvent.keyDown(box(), { key: "Escape" });
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    await vi.waitFor(() => expect(onThread).toHaveBeenCalledWith("look here", ["att1"], []));
  });

  it("waits for a fresh capability answer before sending", async () => {
    let answer!: (v: Awaited<ReturnType<typeof hub.attachmentCapabilities>>) => void;
    const onSend = await mountWs();
    vi.mocked(hub.attachmentCapabilities).mockImplementation(() => new Promise((r) => (answer = r)));
    await userEvent.upload(picker(), pdf());
    await screen.findByText("spec.pdf");
    await vi.waitFor(() => expect(vi.mocked(hub.uploadAttachment)).toHaveBeenCalled());
    await act(async () => {});
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => answer({ adapter: "claude-code", image: "native", pdf: "unknown", text: "text" }));
    expect(await screen.findByText(/claude-code/)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  it("does not send text while a picked file is still being read", async () => {
    const onSend = await mountWs();
    const file = png();
    let release!: (b: ArrayBuffer) => void;
    vi.spyOn(file, "arrayBuffer").mockReturnValue(new Promise((r) => (release = r)));
    await userEvent.type(box(), "with file");
    fireEvent.change(picker(), { target: { files: [file] } });
    await act(async () => {});
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => release(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]).buffer));
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith("with file", ["att1"], []);
  });

  it("says when a file cannot be read", async () => {
    await mountWs();
    const file = png("locked.png");
    vi.spyOn(file, "arrayBuffer").mockRejectedValue(new DOMException("NotReadableError"));
    await userEvent.upload(picker(), file);
    expect((await screen.findByRole("alert")).textContent).toContain("locked.png");
    expect(hub.uploadAttachment).not.toHaveBeenCalled();
  });

  it("keeps the eight-file limit across overlapping adds", async () => {
    await mountWs();
    const target = box().closest(".composer")!;
    const batch = (from: number) => Array.from({ length: 5 }, (_, i) => png(`q${from + i}.png`));
    fireEvent.drop(target, { dataTransfer: { files: batch(0), types: ["Files"] } });
    fireEvent.drop(target, { dataTransfer: { files: batch(5), types: ["Files"] } });
    await vi.waitFor(() => expect(hub.uploadAttachment).toHaveBeenCalledTimes(8));
    await act(async () => {});
    expect(hub.uploadAttachment).toHaveBeenCalledTimes(8);
  });

  it("gives back a staged upload that is removed from the tray", async () => {
    await mountWs();
    await userEvent.upload(picker(), png());
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    await vi.waitFor(() => expect(hub.deleteAttachment).toHaveBeenCalledWith("w1", "att1"));
  });

  it("gives back an upload that finishes after its item was removed", async () => {
    let finish!: (v: AttachmentView) => void;
    vi.mocked(hub.uploadAttachment).mockImplementation(() => new Promise((r) => (finish = r)));
    await mountWs();
    const file = png();
    await userEvent.upload(picker(), file);
    await screen.findByRole("progressbar", { name: "Uploading shot.png" });
    await userEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(hub.deleteAttachment).not.toHaveBeenCalled();
    await act(async () => finish(staged(file, "late")));
    await vi.waitFor(() => expect(hub.deleteAttachment).toHaveBeenCalledWith("w1", "late"));
    expect(screen.queryByText("shot.png")).toBeNull();
  });

  it("gives back staged uploads when the composer goes away, but not sent ones", async () => {
    const { unmount } = render(<I18nProvider><Composer workspaceId="w1" onSend={vi.fn().mockResolvedValue(undefined)} /></I18nProvider>);
    await act(async () => {});
    await userEvent.upload(picker(), png("sent.png"));
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    await userEvent.click(sendButton());
    await vi.waitFor(() => expect(screen.queryByText("sent.png")).toBeNull());
    await userEvent.upload(picker(), png("draft.png"));
    await vi.waitFor(() => expect(sendButton().disabled).toBe(false));
    unmount();
    await vi.waitFor(() => expect(hub.deleteAttachment).toHaveBeenCalledTimes(1));
    expect(hub.deleteAttachment).toHaveBeenCalledWith("w1", "att2");
  });

  it("allows at most eight attachments", async () => {
    await mountWs();
    const files = Array.from({ length: 9 }, (_, i) => png(`p${i}.png`));
    await userEvent.upload(picker(), files);
    expect((await screen.findByRole("alert")).textContent).toContain("p8.png");
    await vi.waitFor(() => expect(hub.uploadAttachment).toHaveBeenCalledTimes(8));
  });
});

describe("Composer Skills menu", () => {
  const rows = [
    { id: "tdd", name: "tdd", description: "Write the test first.", command: "/tdd", invocation: "model-and-user", repoId: null },
    { id: "thread", name: "thread", description: "Shares a built-in name.", command: "/skill:thread", invocation: "model-and-user", repoId: null },
  ];
  beforeEach(() => {
    resetSkillMenuCache();
    vi.mocked(hub.attachmentCapabilities).mockResolvedValue({ adapter: "codex-direct", image: "native", pdf: "native", text: "text" });
    vi.mocked(hub.listSkills).mockResolvedValue({ supported: true, skills: rows });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:preview"), revokeObjectURL: vi.fn() }));
  });
  afterEach(() => {
    vi.mocked(hub.listSkills).mockReset();
    vi.mocked(hub.attachmentCapabilities).mockReset();
    vi.mocked(hub.uploadAttachment).mockReset();
    vi.unstubAllGlobals();
  });
  const mountWs = async (onSend = vi.fn().mockResolvedValue(undefined), onThread?: (c: string, ids: string[]) => Promise<void>) => {
    render(<I18nProvider><Composer workspaceId="w1" onSend={onSend} onThread={onThread} /></I18nProvider>);
    await act(async () => {});
    return onSend;
  };

  it("offers Skills after the commands when / starts the message, and inserts the command", async () => {
    await mountWs();
    await userEvent.type(box(), "/td");
    expect(screen.getByText("Skills")).toBeTruthy();
    await userEvent.click(screen.getByRole("option", { name: /\/tdd/ }));
    expect(box().value).toBe("/tdd ");
    expect(hub.listSkills).toHaveBeenCalledWith("w1");
  });

  it("a Skill with a built-in name sits under Skills as /skill:name; Enter on the command still picks the command", async () => {
    const onThread = vi.fn().mockResolvedValue(undefined);
    await mountWs(vi.fn().mockResolvedValue(undefined), onThread);
    await userEvent.type(box(), "/thread");
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options[0]).toMatch(/^\/thread/);
    expect(options[1]).toMatch(/^\/skill:thread/);
    await userEvent.click(screen.getAllByRole("option")[1]!);
    expect(box().value).toBe("/skill:thread ");
  });

  it("on a later line only the built-in commands show", async () => {
    await mountWs();
    await userEvent.type(box(), "hello{Enter}/td");
    expect(screen.queryByRole("option", { name: /\/tdd/ })).toBeNull();
  });

  it("an older daemon leaves only the built-in commands", async () => {
    vi.mocked(hub.listSkills).mockResolvedValue({ supported: false, skills: [] });
    await mountWs();
    await userEvent.type(box(), "/");
    expect(screen.queryByText("Skills")).toBeNull();
    expect(screen.getByRole("option", { name: /\/thread/ })).toBeTruthy();
  });

  it("/tdd with an attachment sends both; an upload in flight still holds it back", async () => {
    let finish!: (v: AttachmentView) => void;
    vi.mocked(hub.uploadAttachment).mockImplementation(() => new Promise((r) => (finish = r)));
    const onSend = await mountWs();
    await userEvent.type(box(), "/td");
    await userEvent.keyboard("{Enter}");
    await userEvent.type(box(), "write it");
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "shot.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("Choose files to attach") as HTMLInputElement, file);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
    await act(async () => finish({ id: "att1", kind: "image", mime: "image/png", name: "shot.png", size: file.size, sha256: "a".repeat(64), messageId: null, status: "staged", deletedAt: null }));
    await vi.waitFor(() => expect((screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(onSend).toHaveBeenCalledWith("/tdd write it", ["att1"], []);
  });
});

describe("Composer @ mentions", () => {
  const ctx = {
    status: "ok",
    entries: [
      { id: "D-12", kind: "decision", title: "发布流程", status: "active" },
      { id: "R-3", kind: "requirement", title: "支持导出", status: "active" },
    ],
    attachments: [{ id: "att_1", name: "发布会截图.png", kind: "image", size: 100, messageId: "m_1", createdAt: "2026-10-30T00:00:00.000Z" }],
    threads: [{ id: "m_2", title: "发布流程讨论", lastReplyAt: null }],
    truncated: false,
  };

  beforeEach(() => {
    vi.mocked(hub.listSkills).mockResolvedValue([]);
    vi.mocked(hub.searchMentionContext).mockResolvedValue(ctx);
  });

  const mountWs = (onSend: (c: string, ids: string[], mentions?: unknown[]) => Promise<void>, extra: Record<string, unknown> = {}) =>
    render(<I18nProvider><Composer workspaceId="w1" onSend={onSend} {...extra} /></I18nProvider>);

  it("shows the three groups once the query settles, and chooses with Enter", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mountWs(onSend);
    await userEvent.type(box(), "@发布");
    const menu = await screen.findByRole("listbox", { name: /mention|提及/i });
    expect(menu).toBeTruthy();
    expect(await screen.findByRole("option", { name: /D-12/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /发布会截图/ })).toBeTruthy();
    await vi.waitFor(() => expect(hub.searchMentionContext).toHaveBeenCalledWith("w1", "发布"));
    fireEvent.keyDown(box(), { key: "ArrowDown" }); // the exact-id row is first; move to the next
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toContain("[D-12] ");
    expect(screen.getByTestId("mention-chip").textContent).toContain("[D-12]");
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    await vi.waitFor(() => expect(onSend).toHaveBeenCalledWith("[D-12]", [], [{ type: "entry", id: "D-12", text: "[D-12]" }]));
  });

  it("inserts a file mention with the 附件 text and removes both text and chip from the chip's ×", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mountWs(onSend);
    await userEvent.type(box(), "@截图");
    await (await screen.findByRole("option", { name: /发布会截图/ })).click();
    expect(box().value).toBe("`附件：发布会截图.png` ");
    const chip = screen.getByTestId("mention-chip");
    await userEvent.click(chip.querySelector("button")!);
    expect(box().value).toBe("");
    expect(screen.queryByTestId("mention-chip")).toBeNull();
  });

  it("drops the chip when its text is typed away", async () => {
    mountWs(vi.fn().mockResolvedValue(undefined));
    await userEvent.type(box(), "@D-12");
    await (await screen.findByRole("option", { name: /D-12/ })).click();
    expect(screen.getByTestId("mention-chip")).toBeTruthy();
    await userEvent.clear(box());
    await userEvent.type(box(), "别的");
    expect(screen.queryByTestId("mention-chip")).toBeNull();
  });

  it("an @ in the middle of a line opens only the mention menu, and / at the start still opens commands", async () => {
    mountWs(vi.fn().mockResolvedValue(undefined), { onThread: vi.fn().mockResolvedValue(undefined) });
    await userEvent.type(box(), "先说一句 @发");
    expect(await screen.findByRole("listbox", { name: /mention|提及/i })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: /commands|命令/i })).toBeNull();
    fireEvent.keyDown(box(), { key: "Escape" });
    await userEvent.clear(box());
    await userEvent.type(box(), "/thr");
    expect(await screen.findByRole("listbox", { name: /commands|命令/i })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: /mention|提及/i })).toBeNull();
  });

  it("does not open for an email-like a@b or inside a code fence", async () => {
    mountWs(vi.fn().mockResolvedValue(undefined));
    await userEvent.type(box(), "a@b");
    expect(screen.queryByRole("listbox", { name: /mention|提及/i })).toBeNull();
    await userEvent.clear(box());
    await userEvent.type(box(), "```");
    await userEvent.type(box(), "{Enter}@发");
    expect(screen.queryByRole("listbox", { name: /mention|提及/i })).toBeNull();
  });

  it("says when there is nothing to mention yet", async () => {
    vi.mocked(hub.searchMentionContext).mockResolvedValue({ status: "ok", entries: [], attachments: [], threads: [], truncated: false });
    mountWs(vi.fn().mockResolvedValue(undefined));
    await userEvent.type(box(), "@x");
    expect(await screen.findByText(/还没有可提及的附件|no files/i)).toBeTruthy();
  });

  it("sends mentions from a /thread command too", async () => {
    const onThread = vi.fn().mockResolvedValue(undefined);
    mountWs(vi.fn(), { onThread });
    await userEvent.type(box(), "/thr");
    await userEvent.click(await screen.findByRole("option", { name: /^\/thread/ }));
    await userEvent.type(box(), "细节 @D-12");
    await (await screen.findByRole("option", { name: /D-12/ })).click();
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    await vi.waitFor(() => expect(onThread).toHaveBeenCalledWith("细节 [D-12]", [], [{ type: "entry", id: "D-12", text: "[D-12]" }]));
  });
});
