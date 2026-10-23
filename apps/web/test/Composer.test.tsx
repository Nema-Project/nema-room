import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/Composer";
import { I18nProvider } from "@/lib/i18n";

const mount = (onSend: (c: string) => Promise<void>) =>
  render(
    <I18nProvider>
      <Composer onSend={onSend} />
    </I18nProvider>,
  );
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("Composer", () => {
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
    expect(onSend).toHaveBeenCalledWith("a");
    await vi.waitFor(() => expect(box().value).toBe(""));
  });
  it("keeps text typed while a send is in flight", async () => {
    let resolve!: () => void;
    const onSend = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    mount(onSend);
    await userEvent.type(box(), "hello{Shift>}{Enter}{/Shift}");
    expect(onSend).toHaveBeenCalledWith("hello");
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
    expect(onSend).toHaveBeenCalledWith("a");
  });
  it("does not send whitespace-only content", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    mount(onSend);
    await userEvent.type(box(), "   {Shift>}{Enter}{/Shift}");
    expect(onSend).not.toHaveBeenCalled();
  });
  it("keeps content and shows an error when sending fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("boom"));
    mount(onSend);
    await userEvent.type(box(), "keep{Shift>}{Enter}{/Shift}");
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(box().value).toBe("keep");
  });
});
