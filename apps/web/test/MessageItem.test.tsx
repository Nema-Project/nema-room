import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "@/components/MessageItem";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { HubEvent, Message } from "@/lib/types";
import { FakeEventSource } from "./FakeEventSource";

vi.mock("@/lib/hub", () => ({ getEntry: vi.fn(), withdrawEntry: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), eventsUrl: (id: string) => `http://hub/workspaces/${id}/events` }));
afterEach(() => vi.unstubAllGlobals());

const msg = (p: Partial<Message>): Message => ({
  id: "m1",
  workspaceId: "w1",
  role: "agent",
  content: "已更新 3 处：",
  meta: null,
  taskId: null,
  createdAt: "2026-10-21T14:03:00Z",
  editedAt: null,
  threadId: null,
  seq: 1,
  ...p,
});
const mount = (m: Message) =>
  render(
    <I18nProvider messages={{ en: { "kind.requirement": "需求", "kind.decision": "决策", "kind.source": "来源", "kind.tradeoff": "取舍", "kind.question": "问题", "chip.add": "新增", "chip.update": "更新", "chip.register": "登记", "chat.askedQuestion": "追问 · {id}" } }}>
      <MessageItem message={m} />
    </I18nProvider>,
  );

describe("MessageItem", () => {
  it("a work package change shows a card with id, status and task count", async () => {
    vi.mocked(hub.getEntry).mockResolvedValue({
      id: "W-2", kind: "workpackage", title: "Pkg", status: "draft", businessDate: null, related: [], sourceMessages: [], body: "",
      basis: null, ingestedAt: null, confirmedAt: null, quotes: [],
      workpackage: { requirements: ["R-1"], repos: [], approvedAt: null, approvedCommit: null, blockedOn: null, tasks: [] },
    } as never);
    render(
      <I18nProvider>
        <MessageItem message={msg({ meta: { changes: [{ entryId: "W-2", kind: "workpackage", title: "Pkg", op: "add" }], askedQuestion: null } })} />
      </I18nProvider>,
    );
    const card = await screen.findByTestId("wp-card");
    expect(card.textContent).toContain("W-2");
    expect(card.textContent).toContain("0 tasks");
    expect(card.textContent).toContain("Draft");
  });

  it("withdraw on an add chip calls withdraw", async () => {
    vi.mocked(hub.getEntry).mockResolvedValue({ id: "R-7", status: "active" } as never);
    vi.mocked(hub.withdrawEntry).mockResolvedValue({ id: "R-7", status: "dropped" } as never);
    mount(msg({ meta: { changes: [{ entryId: "R-7", kind: "requirement", title: "Feature", op: "add" }], askedQuestion: null } }));
    await userEvent.click(await screen.findByRole("button", { name: "chip.withdraw" }));
    expect(hub.withdrawEntry).toHaveBeenCalledWith("w1", "R-7");
  });
  it("updates withdraw visibility in two mounted copies after knowledge.changed", async () => {
    let status = "active";
    vi.stubGlobal("EventSource", FakeEventSource); FakeEventSource.reset();
    vi.mocked(hub.getEntry).mockImplementation(async () => ({ id: "R-7", status } as never));
    const change = msg({ meta: { changes: [{ entryId: "R-7", kind: "requirement", title: "Feature", op: "add" }], askedQuestion: null } });
    render(<I18nProvider><><MessageItem message={change} /><MessageItem message={{ ...change, id: "anchor-copy" }} /></></I18nProvider>);
    expect(await screen.findAllByRole("button", { name: "Withdraw" })).toHaveLength(2);
    status = "dropped";
    const event: HubEvent = { type: "knowledge.changed", entryId: "R-7" };
    for (const source of FakeEventSource.instances) source.send(event);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull());
  });
  it("shows change chips with kind and operation", () => {
    mount(
      msg({
        meta: {
          changes: [
            { entryId: "R-7", kind: "requirement", title: "流式输出", op: "add" },
            { entryId: "D-12", kind: "decision", title: "不改 tool", op: "update" },
            { entryId: "S-2", kind: "source", title: "PdM 文档", op: "add" },
          ],
          askedQuestion: null,
        },
      }),
    );
    expect(screen.getByText("需求 · 新增")).toBeTruthy();
    expect(screen.getByText("决策 · 更新")).toBeTruthy();
    expect(screen.getByText("来源 · 登记")).toBeTruthy();
    expect(screen.getByText("R-7")).toBeTruthy();
  });
  it("shows the asked question card", () => {
    mount(msg({ meta: { changes: [], askedQuestion: { id: "Q-4", title: "目标是多少？", body: "例如 **2 秒**" } } }));
    expect(screen.getByText("追问 · Q-4")).toBeTruthy();
    expect(screen.getByText("目标是多少？")).toBeTruthy();
  });
  it("shows a question this message added instead of an older asked question", async () => {
    vi.mocked(hub.getEntry).mockImplementation(async (_workspace, id) => ({
      id, kind: "question", status: "open", title: id === "Q-3" ? "文档在哪" : "更新架构图", body: id === "Q-3" ? "superpowers 文档位置" : "旧正文", priority: 2,
    } as never));
    mount(msg({
      meta: {
        changes: [{ entryId: "Q-3", kind: "question", title: "文档在哪", op: "add" }],
        askedQuestion: { id: "Q-2", title: "更新架构图", body: "旧正文" },
      },
    }));
    expect(await screen.findByText("追问 · Q-3")).toBeTruthy();
    expect(await screen.findByText("superpowers 文档位置")).toBeTruthy();
    expect(screen.queryByText("追问 · Q-2")).toBeNull();
    expect(screen.queryByText("旧正文")).toBeNull();
  });
  it("renders system messages without an avatar", () => {
    const { container } = mount(msg({ role: "system", content: "处理失败：x" }));
    expect(screen.getByText("处理失败：x")).toBeTruthy();
    expect(container.querySelector(".av")).toBeNull();
  });
  it("a report message shows the agent, commits and check lines", async () => {
    const onOpenEntry = vi.fn();
    const report = {
      agent: "claude-code",
      gitCommonDir: "/src/app/.git",
      summary: "Implemented refunds",
      entries: ["R-3", "R-7"],
      commits: ["0123456789abcdef0123456789abcdef01234567", "fedcba9"],
      files: ["src/a.ts", "src/b.ts"],
    };
    const check = {
      commitsExist: true,
      missingCommits: [],
      onMain: "not-yet" as const,
      filesOk: false,
      untouchedFiles: ["src/b.ts"],
      touchedFiles: [],
      checkedAt: "2026-10-23T10:00:00Z",
      mainSha: "a".repeat(40),
    };
    const { container } = render(
      <I18nProvider>
        <MessageItem message={msg({ id: "m9", role: "report", content: "Implemented refunds", meta: { report, check } })} onOpenEntry={onOpenEntry} />
      </I18nProvider>,
    );
    expect(container.querySelector(".msg.report")).toBeTruthy();
    expect(screen.getByText("Coding agent report")).toBeTruthy();
    expect(screen.getByText("claude-code")).toBeTruthy();
    expect(screen.getByText("Implemented refunds")).toBeTruthy();
    expect(screen.getByText("0123456")).toBeTruthy();
    expect(screen.getByText("fedcba9")).toBeTruthy();
    expect(screen.queryByText("0123456789abcdef0123456789abcdef01234567")).toBeNull();
    expect(screen.getByText("Commits exist")).toBeTruthy();
    expect(screen.getByText("Not on main yet")).toBeTruthy();
    expect(screen.queryByText("On main")).toBeNull();
    expect(screen.getByText(/Files not touched/).textContent).toContain("src/b.ts");
    await userEvent.click(screen.getByRole("button", { name: "R-7" }));
    expect(onOpenEntry).toHaveBeenCalledWith("R-7");
  });
  it("a passing report shows on main and files match", () => {
    const report = { agent: "codex", gitCommonDir: "/g", summary: "done", entries: [], commits: ["abcdef1"], files: [] };
    const check = { commitsExist: true, missingCommits: [], onMain: "yes" as const, filesOk: true, untouchedFiles: [], touchedFiles: [], checkedAt: "2026-10-23T10:00:00Z", mainSha: "b".repeat(40) };
    render(
      <I18nProvider>
        <MessageItem message={msg({ role: "report", content: "done", meta: { report, check } })} />
      </I18nProvider>,
    );
    expect(screen.getByText("On main")).toBeTruthy();
    expect(screen.getByText("Files match")).toBeTruthy();
    expect(screen.queryByText("Not on main yet")).toBeNull();
  });
});
