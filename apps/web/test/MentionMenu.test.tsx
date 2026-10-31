import { fireEvent, render, screen } from "@testing-library/react";
import { cleanup } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MentionMenu, MentionTray } from "@/components/MentionMenu";
import { I18nProvider } from "@/lib/i18n";

const groups = [
  { kind: "entry" as const, items: [{ type: "entry" as const, id: "D-12", label: "[D-12]", hint: "发布流程", text: "[D-12]" }] },
  { kind: "attachment" as const, items: [{ type: "attachment" as const, id: "att_1", label: "截图 1.png", hint: "image", text: "`附件：截图 1.png`" }] },
  { kind: "thread" as const, items: [{ type: "thread" as const, id: "m_2", label: "发布流程讨论", hint: "话题", text: "[话题：发布流程讨论]" }] },
];

describe("MentionMenu", () => {
  it("groups the three kinds and reports clicks and hover with the flat index", () => {
    const onChoose = vi.fn();
    const onHover = vi.fn();
    render(<I18nProvider><MentionMenu groups={groups} active={1} onChoose={onChoose} onHover={onHover} empty={{ entries: true, attachments: true, state: "ok", query: "" }} /></I18nProvider>);
    expect(screen.getByRole("option", { name: /D-12/ }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("option", { name: /截图 1\.png/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("listbox", { name: /mention|提及/i })).toBeTruthy();
    fireEvent.mouseEnter(screen.getByRole("option", { name: /发布流程讨论/ }));
    expect(onHover).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("option", { name: /D-12/ }));
    expect(onChoose).toHaveBeenCalledWith(groups[0]!.items[0]);
  });

  const emptyWith = (empty: { entries: boolean; attachments: boolean; state: "idle" | "loading" | "ok" | "failed"; query: string }) =>
    render(<I18nProvider><MentionMenu groups={[{ kind: "entry", items: [] }]} active={0} onChoose={vi.fn()} onHover={vi.fn()} empty={empty} /></I18nProvider>);

  it("says what is truly missing when the workspace has nothing, and never claims absence while loading", () => {
    emptyWith({ entries: false, attachments: false, state: "ok", query: "" });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/knowledge panel has no entries|知识库里还没有条目/)).toBeTruthy();
    cleanup();
    emptyWith({ entries: false, attachments: false, state: "loading", query: "" });
    expect(screen.getByText(/Looking|正在查找/)).toBeTruthy();
    cleanup();
    emptyWith({ entries: false, attachments: false, state: "failed", query: "x" });
    expect(screen.getByText(/Could not look up|暂时查不到/)).toBeTruthy();
    cleanup();
    emptyWith({ entries: true, attachments: true, state: "ok", query: "zzz" });
    expect(screen.getByText(/Nothing matches|没有与/)).toBeTruthy();
  });
});

describe("MentionTray", () => {
  it("lists one chip per mention and removes by index", () => {
    const onRemove = vi.fn();
    render(
      <I18nProvider>
        <MentionTray
          chips={[
            { mention: { type: "entry", id: "D-12", text: "[D-12]" }, label: "[D-12]" },
            { mention: { type: "attachment", id: "att_1", text: "`附件：截图 1.png`" }, label: "截图 1.png" },
          ]}
          onRemove={onRemove}
        />
      </I18nProvider>,
    );
    expect(screen.getAllByTestId("mention-chip")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /移除 截图 1\.png|Remove 截图 1\.png/ }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it("renders nothing without chips", () => {
    const { container } = render(<I18nProvider><MentionTray chips={[]} onRemove={vi.fn()} /></I18nProvider>);
    expect(container.textContent).toBe("");
  });
});
