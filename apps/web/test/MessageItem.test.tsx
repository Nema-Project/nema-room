import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "@/components/MessageItem";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { HubEvent, Message } from "@/lib/types";
import { FakeEventSource } from "./FakeEventSource";

vi.mock("@/lib/hub", () => ({ fetchAttachmentBlob: vi.fn(), deleteAttachment: vi.fn(), getEntry: vi.fn(), listEntries: vi.fn(), withdrawEntry: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), eventsUrl: (id: string) => `http://hub/workspaces/${id}/events` }));
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
  it("renders a converted legacy system question card with its body", () => {
    vi.mocked(hub.getEntry).mockResolvedValue({ id: "Q-8", kind: "question", status: "open", title: "Question title", body: "Question body, distinct from title", priority: 1 } as never);
    const { container } = mount(msg({
      role: "system",
      content: "Legacy question Q-8",
      meta: { changes: [], askedQuestion: { id: "Q-8", title: "Question title", body: "Question body, distinct from title" } },
    }));
    expect(screen.getByText("Question title")).toBeTruthy();
    expect(screen.getByText("Question body, distinct from title")).toBeTruthy();
    expect(container.querySelector(".ask")).toBeTruthy();
    expect(container.querySelector("textarea")).toBeNull();
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
  it("does not render a skipped in-progress check as pending", () => {
    const report = { agent: "codex", gitCommonDir: "/g", summary: "halfway", progress: "in_progress" as const, entries: [], commits: [], files: [] };
    render(
      <I18nProvider>
        <MessageItem message={msg({ role: "report", content: "halfway", meta: { report, check: null, checkSkipped: "in_progress_no_commits" } })} />
      </I18nProvider>,
    );
    expect(screen.getByText("This in-progress report has no commits, so no commit check was run.")).toBeTruthy();
    expect(screen.queryByText("Checking…")).toBeNull();
  });
  describe("report claim and hub check", () => {
    const report = {
      agent: "claude-code", gitCommonDir: "/g", summary: "done", entries: ["R-1", "R-404"], commits: ["abcdef1"], files: ["src/a.ts"],
      branch: "feat/x", pr: 7, headSha: "c".repeat(40), verified: ["unit"], notVerified: ["e2e"], blockers: ["needs review"],
    };
    const check = { commitsExist: true, missingCommits: [], onMain: "yes" as const, filesOk: true, untouchedFiles: [], touchedFiles: ["src/a.ts"], checkedAt: "2026-10-23T10:00:00Z", mainSha: "b".repeat(40) };
    const authors = {
      checkedAt: "2026-10-23T10:00:00Z", source: "git" as const, missing: [],
      commits: [{ sha: "abcdef1", authorName: "Ann", authorEmail: "ann@example.com", committerName: "Bob", committerEmail: "bob@example.com" }],
    };
    const observation = (over: Record<string, unknown> = {}) => ({
      state: "read" as const, observedAt: "2026-10-23T10:00:00Z", source: "github-plugin-read" as const,
      binding: { repoId: "r1", owner: "o", repo: "r", pr: 7, observedHeadSha: "c".repeat(40), claimedHeadSha: "c".repeat(40) },
      headMatch: "match" as const, truncated: false,
      checkRuns: [{ name: "lint", status: "completed", conclusion: "failure", url: null }, { name: "unit", status: "completed", conclusion: "success", url: null }],
      ...over,
    });
    const show = (meta: Record<string, unknown>, entryIds?: Set<string>) => {
      void entryIds;
      return render(
        <I18nProvider>
          <MessageItem message={msg({ role: "report", content: "done", meta: meta as never })} />
        </I18nProvider>,
      );
    };

    it("splits the agent claim from the hub check", () => {
      const { container } = show({ report, check, authors, github: { current: observation(), history: [] } });
      expect(screen.getByRole("heading", { name: "Agent claim" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Hub check" })).toBeTruthy();
      expect(screen.getByText("This is the name in the report, not an authenticated identity.")).toBeTruthy();
      expect(screen.getByText(/Agent claims this was verified/).textContent).toContain("unit");
      expect(screen.getByText(/Agent says this was not verified/).textContent).toContain("e2e");
      expect(screen.getByText(/needs review/)).toBeTruthy();
      expect(screen.getByText("ann@example.com")).toBeTruthy();
      expect(screen.getByText("bob@example.com")).toBeTruthy();
      expect(screen.getByText("This is commit metadata, not an allow or deny decision.")).toBeTruthy();
      expect(screen.getByText("These check runs were read. v1 does not conclude that tests passed.")).toBeTruthy();
      const failed = screen.getByText(/lint/).closest(".itag") as HTMLElement;
      expect(failed.classList.contains("red")).toBe(true);
      expect(failed.closest("details")).toBeNull();
      const passed = screen.getAllByText(/unit/).map((n) => n.closest(".itag")).find(Boolean) as HTMLElement;
      expect(passed.classList.contains("red")).toBe(false);
      const claim = container.querySelector("[data-testid='report-claim']") as HTMLElement;
      const hubCheck = container.querySelector("[data-testid='report-hub']") as HTMLElement;
      expect(claim.textContent).toContain("cccccc");
      expect(claim.textContent).not.toContain("Commits checked");
      expect(hubCheck.textContent).toContain("On main");
      expect(claim.textContent).not.toContain("On main");
    });

    it("keeps the claimed head when the hub saw another head", () => {
      const other = observation({ headMatch: "mismatch", binding: { repoId: "r1", owner: "o", repo: "r", pr: 7, observedHeadSha: "d".repeat(40), claimedHeadSha: "c".repeat(40) } });
      const { container } = show({ report, check, authors, github: { current: other, history: [] } });
      expect((container.querySelector("[data-testid='report-claim']") as HTMLElement).textContent).toContain("cccccc");
      expect(screen.getByText("PR head differs from the claim")).toBeTruthy();
    });

    it("does not treat a failed read as the previous success", () => {
      const failed = observation({ state: "unavailable", reasonCode: "gh_logged_out", headMatch: null, checkRuns: [] });
      const old = observation({ checkRuns: [{ name: "build", status: "completed", conclusion: "success", url: null }] });
      const { container } = show({ report, check, authors, github: { current: failed, history: [old] } });
      expect(screen.getByText("There are no check runs from this read. There is no conclusion that tests passed.")).toBeTruthy();
      expect(screen.getByText("History")).toBeTruthy();
      const current = container.querySelector("[data-testid='github-current']") as HTMLElement;
      expect(current.textContent).not.toContain("success");
      expect(current.textContent).not.toContain("build");
      expect(current.textContent).toContain("gh_logged_out");
    });

    it("shows the three git lines when authors and github are absent", () => {
      show({ report: { agent: "codex", gitCommonDir: "/g", summary: "done", entries: [], commits: ["abcdef1"], files: [] }, check });
      expect(screen.getByText("Commits exist")).toBeTruthy();
      expect(screen.getByText("On main")).toBeTruthy();
      expect(screen.getByText("Files match")).toBeTruthy();
      expect(screen.getAllByText("This report has no hub record of this kind.")).toHaveLength(2);
    });

    it("names an entry id this workspace does not have, with one list read for every report on screen", async () => {
      vi.mocked(hub.getEntry).mockClear();
      vi.mocked(hub.listEntries).mockReset().mockResolvedValue([{ id: "R-1" }] as never);
      render(
        <I18nProvider>
          <MessageItem message={msg({ id: "m1", role: "report", content: "a", meta: { report, check } as never })} />
          <MessageItem message={msg({ id: "m2", role: "report", content: "b", meta: { report, check } as never })} />
        </I18nProvider>,
      );
      expect(await screen.findAllByText("No entry R-404 in this workspace")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: "R-404" })).toBeNull();
      expect(screen.getAllByText("R-1")).toHaveLength(2);
      expect(hub.listEntries).toHaveBeenCalledTimes(1);
      expect(hub.getEntry).not.toHaveBeenCalled();
    });

    it("explains a GitHub read that was not requested apart from an empty read", () => {
      const none = observation({ state: "not_requested", binding: null, headMatch: null, checkRuns: [] });
      show({ report, check, authors, github: { current: none, history: [] } });
      expect(screen.getByText("The report claims no PR, so the hub did not read GitHub.")).toBeTruthy();
      expect(screen.getByText("There are no check runs from this read. There is no conclusion that tests passed.")).toBeTruthy();
      expect(screen.queryByText("This read returned no check runs. There is no conclusion that tests passed.")).toBeNull();
    });

    it("an empty read says there are no check runs", () => {
      show({ report, check, authors, github: { current: observation({ checkRuns: [] }), history: [] } });
      expect(screen.getByText("This read returned no check runs. There is no conclusion that tests passed.")).toBeTruthy();
    });
  });
  it("separates a quoted sender from the excerpt", () => {
    render(
      <I18nProvider>
        <MessageItem message={msg({ role: "user", content: "reply", meta: { quote: { messageId: "m0", role: "user", excerpt: "retry" } } })} />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "You: retry" })).toBeTruthy();
  });
});

describe("MessageItem attachments", () => {
  const file = { id: "a1", kind: "text" as const, mime: "text/plain", name: "err.log", size: 300, sha256: "f".repeat(64), messageId: "m1", status: "attached" as const, deletedAt: null };
  const user = (p: Partial<Message>) => msg({ role: "user", ...p });
  const show = (m: Message, onEdited?: (m: Message) => void) => render(<I18nProvider><MessageItem message={m} onEdited={onEdited} /></I18nProvider>);

  it("lists a user message's attachments under its text", () => {
    const { container } = show(user({ content: "see log", attachments: [file] }));
    expect(screen.getByText("see log")).toBeTruthy();
    expect(screen.getByText("err.log")).toBeTruthy();
    expect(container.querySelector(".att-list")).toBeTruthy();
  });

  it("renders no empty text block for an attachment-only message", () => {
    const { container } = show(user({ content: "", attachments: [file] }));
    expect(container.querySelector(".memo")).toBeNull();
    expect(screen.getByText("err.log")).toBeTruthy();
  });

  it("renders a message from a hub without attachments", () => {
    const { container } = show(user({ content: "plain" }));
    expect(screen.getByText("plain")).toBeTruthy();
    expect(container.querySelector(".att-list")).toBeNull();
  });

  it("hands the tombstone back as an updated message", async () => {
    const tomb = { ...file, status: "deleted" as const, deletedAt: "2026-10-30T09:15:00Z" };
    vi.mocked(hub.deleteAttachment).mockResolvedValue(tomb);
    const onEdited = vi.fn();
    show(user({ content: "see log", attachments: [file] }), onEdited);
    await userEvent.click(screen.getByRole("button", { name: "Delete err.log" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete attachment" }));
    await vi.waitFor(() => expect(onEdited).toHaveBeenCalledWith(expect.objectContaining({ id: "m1", content: "see log", attachments: [tomb] })));
  });

  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const confirmDelete = async (name: string) => {
    const card = screen.getByText(name).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: `Delete ${name}` }));
    await userEvent.click(within(card).getByRole("button", { name: "Delete attachment" }));
  };

  it("keeps every tombstone when two deletes finish out of order", async () => {
    const other = { ...file, id: "a2", name: "b.log" };
    const d1 = deferred<typeof file>();
    const d2 = deferred<typeof file>();
    vi.mocked(hub.deleteAttachment).mockImplementation((_w, id) => (id === "a1" ? d1.promise : d2.promise) as never);
    const onEdited = vi.fn();
    show(user({ content: "logs", attachments: [file, other] }), onEdited);
    await confirmDelete("err.log");
    await confirmDelete("b.log");
    const t2 = { ...other, status: "deleted" as const, deletedAt: "2026-10-30T09:16:00Z" };
    const t1 = { ...file, status: "deleted" as const, deletedAt: "2026-10-30T09:15:00Z" };
    d2.resolve(t2 as never);
    await vi.waitFor(() => expect(onEdited).toHaveBeenCalledTimes(1));
    d1.resolve(t1 as never);
    await vi.waitFor(() => expect(onEdited).toHaveBeenCalledTimes(2));
    expect(onEdited.mock.calls[1]![0].attachments).toEqual([t1, t2]);
  });

  it("applies a late tombstone to the newest message, not the one it started from", async () => {
    const d = deferred<typeof file>();
    vi.mocked(hub.deleteAttachment).mockReturnValue(d.promise as never);
    const onEdited = vi.fn();
    const { rerender } = show(user({ content: "v1", attachments: [file] }), onEdited);
    await confirmDelete("err.log");
    rerender(<I18nProvider><MessageItem message={user({ content: "v2", editedAt: "2026-10-30T09:14:00Z", attachments: [file] })} onEdited={onEdited} /></I18nProvider>);
    const tomb = { ...file, status: "deleted" as const, deletedAt: "2026-10-30T09:15:00Z" };
    d.resolve(tomb as never);
    await vi.waitFor(() => expect(onEdited).toHaveBeenCalledWith(expect.objectContaining({ content: "v2", attachments: [tomb] })));
  });
});
