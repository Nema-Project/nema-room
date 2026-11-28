import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageItem } from "@/components/MessageItem";
import * as hub from "@/lib/hub";
import { I18nProvider } from "@/lib/i18n";
import type { HubEvent, Message } from "@/lib/types";
import { FakeEventSource } from "./FakeEventSource";

vi.mock("@/lib/hub", () => ({ fetchAttachmentBlob: vi.fn(), deleteAttachment: vi.fn(), getEntry: vi.fn(), listEntries: vi.fn(), withdrawEntry: vi.fn(), editMessage: vi.fn(), listMessageVersions: vi.fn(), listMembers: vi.fn(async () => []), getMe: vi.fn(async () => ({ userId: "usr_local", displayName: null })), eventsUrl: (id: string) => `http://hub/workspaces/${id}/events` }));
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
  it("renders the stored text when the index-failure meta has an unreadable shape", () => {
    const missingStatus = msg({
      role: "system",
      content: "仓库 API 的代码索引没有完成，暂时还不能询问代码库。",
      meta: { repoIndexFailure: { label: "API", error: { code: "graphify-unavailable", state: "failed" } } } as unknown as Message["meta"],
    });
    const { unmount } = render(<I18nProvider><MessageItem message={missingStatus} /></I18nProvider>);
    expect(screen.getByText(missingStatus.content)).toBeTruthy();
    unmount();

    const unknownCode = msg({
      role: "system",
      content: "仓库 API 的代码索引没有完成，暂时还不能询问代码库。",
      meta: { repoIndexFailure: { label: "API", error: { code: "graphify-future", status: { state: "failed" } } } } as unknown as Message["meta"],
    });
    render(<I18nProvider><MessageItem message={unknownCode} /></I18nProvider>);
    expect(screen.getByText(unknownCode.content)).toBeTruthy();
  });

  it("renders the stored text when the system meta is not an object", () => {
    const legacy = msg({
      role: "system",
      content: "仓库 API 的代码索引没有完成，暂时还不能询问代码库。",
      meta: "legacy" as unknown as Message["meta"],
    });
    render(<I18nProvider><MessageItem message={legacy} /></I18nProvider>);
    expect(screen.getByText(legacy.content)).toBeTruthy();
  });

  it("renders a stored Graphify index failure in the UI language", async () => {
    localStorage.setItem("nema.locale", "ja");
    try {
      render(
        <I18nProvider>
          <MessageItem message={msg({
            role: "system",
            content: "仓库 API 的代码索引没有完成",
            meta: { repoIndexFailure: { label: "API", error: { code: "graphify-interrupted" } } },
          })} />
        </I18nProvider>,
      );
      expect(await screen.findByText("API のインデックスを作成できませんでした。Graphify の処理が中断されました。")).toBeTruthy();
    } finally {
      localStorage.removeItem("nema.locale");
    }
  });

  it("labels index completion as a system notice and quotes the original message", async () => {
    const message = msg({ role: "system", content: "仓库 API 的代码索引已完成，可以开始询问代码库。" });
    const onQuote = vi.fn();
    render(<I18nProvider><MessageItem message={message} onQuote={onQuote} /></I18nProvider>);

    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByText(message.content)).toBeTruthy();
    expect(screen.queryByText("Failure")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(onQuote).toHaveBeenCalledWith(message);
  });

  it("separates the repository from a task instruction and quotes the stored text", async () => {
    const body = "画架构图：用 code__ 函数读代码，用 diagram__save 保存，type 为 architecture。";
    const message = msg({ role: "system", content: `为仓库 API（backend）（repo_abcDeF0_-123）${body}` });
    const onQuote = vi.fn();
    render(<I18nProvider><MessageItem message={message} onQuote={onQuote} /></I18nProvider>);

    expect(screen.getByText("Task instruction")).toBeTruthy();
    const repository = screen.getByRole("group", { name: "Repository" });
    expect(within(repository).getByText("API（backend）")).toBeTruthy();
    expect(within(repository).getByText("repo_abcDeF0_-123")).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect(screen.queryByText(message.content)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(onQuote).toHaveBeenCalledWith(message);
  });

  it("keeps an unrecognized system message intact", () => {
    const message = msg({ role: "system", content: "为仓库 API（repo_x）刷新说明。" });
    render(<I18nProvider><MessageItem message={message} /></I18nProvider>);

    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByText(message.content)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Repository" })).toBeNull();
  });

  it("marks task failure and copies the command without surrounding prose", async () => {
    const user = userEvent.setup();
    const message = msg({ role: "system", taskId: "task1", content: "处理失败：未登录直连 Codex，请在终端运行 nema auth login（账户「Codex」· model）" });
    render(<I18nProvider><MessageItem message={message} /></I18nProvider>);

    expect(screen.getByText("Failure")).toBeTruthy();
    expect(screen.getByText("nema auth login", { selector: "code" })).toBeTruthy();
    expect(screen.getByText(/处理失败：未登录直连 Codex/)).toBeTruthy();
    expect(screen.getByText(/（账户「Codex」· model）/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy command: nema auth login" }));
    expect(await navigator.clipboard.readText()).toBe("nema auth login");
    expect(screen.getByRole("status").textContent).toBe("Copied");
  });

  it("copies the BYOK model and GitHub recovery commands", async () => {
    const user = userEvent.setup();
    const model = msg({ role: "system", taskId: "task2", content: "处理失败：BYOK 需要指定模型，请运行 nema config set model <名称>" });
    const { unmount } = render(<I18nProvider><MessageItem message={model} /></I18nProvider>);
    await user.click(screen.getByRole("button", { name: "Copy command: nema config set model <名称>" }));
    expect(await navigator.clipboard.readText()).toBe("nema config set model <名称>");
    unmount();

    const github = msg({ role: "system", taskId: "task3", content: "处理失败：GitHub 令牌未保存，请运行 nema auth github" });
    render(<I18nProvider><MessageItem message={github} /></I18nProvider>);
    await user.click(screen.getByRole("button", { name: "Copy command: nema auth github" }));
    expect(await navigator.clipboard.readText()).toBe("nema auth github");
  });

  it("shows a placeholder hint beside the model command and not beside plain commands", () => {
    const model = msg({ role: "system", taskId: "task2", content: "处理失败：BYOK 需要指定模型，请运行 nema config set model <名称>" });
    const { unmount } = render(<I18nProvider><MessageItem message={model} /></I18nProvider>);
    expect(screen.getByText("Replace <名称> with a model name before running.")).toBeTruthy();
    unmount();

    const github = msg({ role: "system", taskId: "task3", content: "处理失败：GitHub 令牌未保存，请运行 nema auth github" });
    render(<I18nProvider><MessageItem message={github} /></I18nProvider>);
    expect(screen.queryByText("Replace <名称> with a model name before running.")).toBeNull();
  });

  it("does not turn the appended account name into a recovery command", () => {
    const message = msg({ role: "system", taskId: "task4", content: "处理失败：连接超时，任务已中止。（账户「nema auth github」· some-model）" });
    render(<I18nProvider><MessageItem message={message} /></I18nProvider>);

    expect(screen.getByText("Failure")).toBeTruthy();
    expect(screen.getByText(message.content)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy command/ })).toBeNull();
  });

  it("copies the proxy forwarding recovery command the Claude adapter emits", async () => {
    const user = userEvent.setup();
    const message = msg({ role: "system", taskId: "task5", content: "处理失败：Claude 连不上 Anthropic API（网络或 API 连接失败），任务已中止。如果这台机器只能经代理出网，请运行 nema config set proxyEnv forward，让 Claude 子进程使用 daemon 环境里的代理变量。" });
    render(<I18nProvider><MessageItem message={message} /></I18nProvider>);

    await user.click(screen.getByRole("button", { name: "Copy command: nema config set proxyEnv forward" }));
    expect(await navigator.clipboard.readText()).toBe("nema config set proxyEnv forward");
  });

  it("keeps the repository chip and failure styling for labels with U+2028/U+2029", () => {
    const body = "画架构图：用 code__ 函数读代码，用 diagram__save 保存，type 为 architecture。";
    const arch = msg({ role: "system", content: `为仓库 A B（repo_x）${body}` });
    const { unmount } = render(<I18nProvider><MessageItem message={arch} /></I18nProvider>);
    const repository = screen.getByRole("group", { name: "Repository" });
    expect(repository.textContent).toContain("A\u2028B");
    unmount();

    const index = msg({ role: "system", content: "仓库 A B 的代码索引没有完成，暂时还不能询问代码库。" });
    render(<I18nProvider><MessageItem message={index} /></I18nProvider>);
    expect(screen.getByText("Failure")).toBeTruthy();
    expect(document.body.textContent).toContain("仓库 A\u2029B 的代码索引没有完成");
  });

  it("marks an index failure even without a task or recovery command", () => {
    const message = msg({ role: "system", content: "仓库 nema auth login 的代码索引没有完成，暂时还不能询问代码库。" });
    render(<I18nProvider><MessageItem message={message} /></I18nProvider>);

    expect(screen.getByText("Failure")).toBeTruthy();
    expect(screen.getByText(message.content)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Copy command/ })).toBeNull();
  });

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

describe("system notices (#299 batch 2)", () => {
  const inLocale = (locale: string, message: Message) => {
    localStorage.setItem("nema.locale", locale);
    return render(<I18nProvider><MessageItem message={message} /></I18nProvider>);
  };
  afterEach(() => localStorage.removeItem("nema.locale"));

  it("renders an index notice in the page's language instead of the English fallback", () => {
    const content = "The code index for repository API is ready. You can now ask about the codebase.";
    inLocale("ja", msg({ role: "system", content, meta: { notice: { code: "repo.index.ready", params: { label: "API" } } } }));
    expect(screen.getByText("リポジトリ API のコードインデックスが完成しました。コードベースについて質問できます。")).toBeTruthy();
    expect(screen.queryByText(content)).toBeNull();
    expect(screen.queryByText("失敗")).toBeNull();
  });

  it("styles an index failure notice as a failure, and prefers the stored graphify reason", () => {
    const content = "The code index for repository API did not finish. You cannot ask about the codebase yet.";
    const { unmount } = inLocale("zh", msg({ role: "system", content, meta: { notice: { code: "repo.index.failed", params: { label: "API" } } } }));
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("仓库 API 的代码索引没有完成，暂时还不能询问代码库。")).toBeTruthy();
    unmount();

    inLocale("ja", msg({
      role: "system",
      content,
      meta: { repoIndexFailure: { label: "API", error: { code: "graphify-interrupted" } }, notice: { code: "repo.index.failed", params: { label: "API" } } } as unknown as Message["meta"],
    }));
    expect(screen.getByText("API のインデックスを作成できませんでした。Graphify の処理が中断されました。")).toBeTruthy();
  });

  it("falls back to the stored text when the catalog has no entry for the code, never to a blank or a key", () => {
    const content = "Something a newer hub said.";
    inLocale("en", msg({ role: "system", content, meta: { notice: { code: "future.notice", params: { x: 1 } } } }));
    expect(screen.getByText(content)).toBeTruthy();
    expect(screen.queryByText("notice.future.notice")).toBeNull();
  });

  it("renders the stored text when the notice cannot be read", () => {
    const content = "仓库 API 的代码索引已完成，可以开始询问代码库。";
    inLocale("en", msg({ role: "system", content, meta: { notice: { code: "Not A Code!" } } as unknown as Message["meta"] }));
    expect(screen.getByText(content)).toBeTruthy();
  });

  it("names a coded task failure's reason in the page's language", () => {
    inLocale("zh", msg({
      role: "system",
      taskId: "t1",
      content: "Processing failed: The connected daemon does not support attachments. Upgrade the CLI.",
      meta: { notice: { code: "task.failed", params: { reason: "daemon.no-attachments" } } },
    }));
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("处理失败：当前 daemon 不支持附件，请升级 CLI。")).toBeTruthy();
  });

  it("uses the reason's params for a coded failure", () => {
    inLocale("ja", msg({
      role: "system",
      taskId: "t1",
      content: "Processing failed: Work package W-3 not found.",
      meta: { notice: { code: "task.failed", params: { reason: "workpackage.not-found", id: "W-3" } } },
    }));
    expect(document.body.textContent).toContain("処理に失敗しました：");
    expect(document.body.textContent).toContain("W-3");
    expect(document.body.textContent).not.toContain("Processing failed");
  });

  it("keeps an uncoded failure's error text inside the localised sentence, with its recovery command", async () => {
    const user = userEvent.setup();
    inLocale("ja", msg({
      role: "system",
      taskId: "t1",
      content: "Processing failed: 未登录直连 Codex，请在终端运行 nema auth login",
      meta: { notice: { code: "task.failed" } },
    }));
    expect(screen.getByText("失敗")).toBeTruthy();
    expect(document.body.textContent).toContain("処理に失敗しました：未登录直连 Codex");
    expect(document.body.textContent).not.toContain("Processing failed");
    expect(screen.getByText("nema auth login", { selector: "code" })).toBeTruthy();
    await user.click(screen.getAllByRole("button").find((b) => b.getAttribute("aria-label")?.includes("nema auth login"))!);
    expect(await navigator.clipboard.readText()).toBe("nema auth login");
  });

  it("names the failed task's account and model from meta.route, never as a command", () => {
    const route = { accountId: "acct_abc1234567", accountName: "nema auth github", model: "gpt-5.5", mode: "manual" as const, reason: "user_message" as const };
    inLocale("en", msg({
      role: "system",
      taskId: "t1",
      content: "Processing failed: 订阅额度已用完",
      meta: { notice: { code: "task.failed" }, route } as unknown as Message["meta"],
    }));
    expect(document.body.textContent).toContain("Processing failed: 订阅额度已用完 (account “nema auth github” · gpt-5.5)");
    expect(screen.queryByRole("button", { name: /Copy command/ })).toBeNull();
  });

  it("renders an interrupted task in the page's language", () => {
    inLocale("zh", msg({
      role: "system",
      taskId: "t1",
      content: "Processing failed: The task was interrupted and did not finish after 3 automatic retries. Send the message again.",
      meta: { notice: { code: "task.interrupted", params: { retries: 3 } } },
    }));
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.getByText("处理失败：任务被中断，自动重试 3 次后仍未完成。请重新发送这条消息。")).toBeTruthy();
  });

  it("shows a diagram task as an instruction with its repository, not the model's instruction text", () => {
    const content = "为仓库 API（repo_x）画架构图：用 code__ 函数读代码，用 diagram__save 保存，type 为 architecture。";
    inLocale("en", msg({ role: "system", content, meta: { notice: { code: "system.task.diagram", params: { label: "API", repoId: "repo_x" } } } }));
    expect(screen.getByText("Task instruction")).toBeTruthy();
    const repository = screen.getByRole("group", { name: "Repository" });
    expect(within(repository).getByText("API")).toBeTruthy();
    expect(within(repository).getByText("repo_x")).toBeTruthy();
    expect(screen.getByText("Draw the architecture diagram of repository API.")).toBeTruthy();
    expect(screen.queryByText(content)).toBeNull();
  });

  it("shows the other system tasks from their codes", () => {
    const { unmount } = inLocale("en", msg({ role: "system", content: "用户要求更新代码图 G-1：…", meta: { notice: { code: "system.task.diagramUpdate", params: { id: "G-1" } } } }));
    expect(screen.getByText("Update code diagram G-1 with the code changes since it was drawn.")).toBeTruthy();
    expect(screen.getByText("Task instruction")).toBeTruthy();
    unmount();
    const second = inLocale("ja", msg({ role: "system", content: "上报 m9 的提交已核对…", meta: { notice: { code: "system.task.commitsChecked", params: { messageId: "m9" } } } }));
    expect(document.body.textContent).toContain("報告 m9 のコミットを照合しました");
    second.unmount();
    inLocale("en", msg({
      role: "system",
      content: "主分支有新提交但没有收到上报…",
      meta: { notice: { code: "system.task.uncoveredCommits", params: { label: "API", repoId: "repo_x", count: 2, commits: "aaa, bbb" } } },
    }));
    expect(document.body.textContent).toContain("The main branch of repository API has 2 new commit(s) without a report: aaa, bbb.");
  });

  it("renders a follow-up card from its notice and keeps the question box", () => {
    vi.mocked(hub.getEntry).mockResolvedValue({ id: "Q-4", kind: "question", status: "open", title: "Which DB?", body: "pick one" } as never);
    inLocale("zh", msg({
      role: "system",
      threadId: "t1",
      content: "Follow-up Q-4: Which DB?",
      meta: { changes: [], askedQuestion: { id: "Q-4", title: "Which DB?", body: "pick one" }, notice: { code: "question.followUp", params: { id: "Q-4", title: "Which DB?" } } } as unknown as Message["meta"],
    }));
    expect(screen.getByText("追问 Q-4：Which DB?")).toBeTruthy();
    expect(screen.queryByText("Follow-up Q-4: Which DB?")).toBeNull();
    // The question card itself still renders below the notice.
    expect(screen.getByText("pick one")).toBeTruthy();
  });

  it("falls back to the stored text when a known notice is missing a param it needs", () => {
    const content = "The code index for repository API is ready. You can now ask about the codebase.";
    inLocale("ja", msg({ role: "system", content, meta: { notice: { code: "repo.index.ready" } } }));
    expect(screen.getByText(content)).toBeTruthy();
    expect(document.body.textContent).not.toContain("{label}");
  });

  it("falls back to the stored text when a known notice's param has an invalid type", () => {
    const content = "The code index for repository API is ready. You can now ask about the codebase.";
    inLocale("en", msg({ role: "system", content, meta: { notice: { code: "repo.index.ready", params: { label: {} } } } as unknown as Message["meta"] }));
    expect(screen.getByText(content)).toBeTruthy();
    expect(document.body.textContent).not.toContain("{label}");
  });

  it("falls back to the stored failure when a coded reason is missing its param", () => {
    const content = "Processing failed: Work package W-3 not found.";
    inLocale("en", msg({
      role: "system",
      taskId: "t1",
      content,
      meta: { notice: { code: "task.failed", params: { reason: "workpackage.not-found" } } },
    }));
    expect(screen.getByText(content)).toBeTruthy();
    expect(document.body.textContent).not.toContain("{id}");
  });

  it("keeps a command-like repository label in an index failure as plain text", () => {
    const content = "The code index for repository codex login did not finish. You cannot ask about the codebase yet.";
    inLocale("en", msg({ role: "system", content, meta: { notice: { code: "repo.index.failed", params: { label: "codex login" } } } }));
    expect(screen.getByText("Failure")).toBeTruthy();
    expect(screen.getByText(content)).toBeTruthy();
    expect(screen.queryByText("codex login", { selector: "code" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copy command/ })).toBeNull();
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

  it("keeps a tombstone when an edit response read before the delete arrives after it", async () => {
    const tomb = { ...file, status: "deleted" as const, deletedAt: "2026-10-30T09:15:00Z" };
    vi.mocked(hub.deleteAttachment).mockResolvedValue(tomb);
    const onEdited = vi.fn();
    const before = user({ content: "v1", attachments: [file] });
    const { rerender } = show(before, onEdited);
    await confirmDelete("err.log");
    await vi.waitFor(() => expect(onEdited).toHaveBeenCalledTimes(1));
    rerender(<I18nProvider><MessageItem message={{ ...before, attachments: [tomb] }} onEdited={onEdited} /></I18nProvider>);
    vi.mocked(hub.editMessage).mockResolvedValue({ message: { ...before, content: "v2", attachments: [file] } } as never);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(onEdited).toHaveBeenCalledTimes(2));
    expect(onEdited.mock.calls[1]![0]).toEqual(expect.objectContaining({ content: "v2", attachments: [tomb] }));
  });
});

describe("editing mentions", () => {
  const user = (p: Partial<Message>) => msg({ role: "user", ...p });
  const mention = { type: "entry" as const, id: "D-12", text: "[D-12]" };
  const show = (m: Message) => render(<I18nProvider><MessageItem message={m} /></I18nProvider>);

  it("says how many mentions an edit dropped, and still saves", async () => {
    vi.mocked(hub.editMessage).mockResolvedValue({ message: user({ content: "plain" }) } as never);
    show(user({ content: "see [D-12]", meta: { mentions: [mention] } }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, "plain");
    expect(screen.queryByText("Removed 1 stale mention")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Removed 1 stale mention")).toBeTruthy();
    expect(hub.editMessage).toHaveBeenCalledWith("w1", "m1", "plain");
  });

  it("does not bring the notice back after a later edit is cancelled", async () => {
    vi.mocked(hub.editMessage).mockResolvedValue({ message: user({ content: "plain" }) } as never);
    show(user({ content: "see [D-12]", meta: { mentions: [mention] } }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox");
    await userEvent.clear(box);
    await userEvent.type(box, "plain");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Removed 1 stale mention")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Removed 1 stale mention")).toBeNull();
  });

  it("stays quiet when the edit keeps every mention", async () => {
    vi.mocked(hub.editMessage).mockResolvedValue({ message: user({ content: "see [D-12] please", meta: { mentions: [mention] } }) } as never);
    show(user({ content: "see [D-12]", meta: { mentions: [mention] } }));
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.type(screen.getByRole("textbox"), " please");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(hub.editMessage).toHaveBeenCalled());
    expect(screen.queryByText(/stale mention/)).toBeNull();
  });
});

describe("the route line", () => {
  const withRoute = (route: unknown) => msg({ meta: { changes: [], askedQuestion: null, route } as never });
  const route = {
    accountId: "acct_abc1234567",
    accountName: "OpenRouter 免费",
    model: "deepseek/xxx",
    mode: "manual",
    reason: "user_workspace",
  };

  it("shows the account and the model, and why it was chosen", async () => {
    render(
      <I18nProvider>
        <MessageItem message={withRoute(route)} />
      </I18nProvider>,
    );
    const line = await screen.findByTestId("route-line");
    expect(line.textContent).toContain("OpenRouter 免费");
    expect(line.textContent).toContain("deepseek/xxx");
    expect(line.textContent).toContain("chosen in this workspace");
  });

  it("shows nothing for a message written before routing existed", async () => {
    render(
      <I18nProvider>
        <MessageItem message={msg({ meta: { changes: [], askedQuestion: null } })} />
      </I18nProvider>,
    );
    // The old message renders exactly as it did; no empty line, no placeholder.
    expect(screen.queryByTestId("route-line")).toBeNull();
  });

  it("gives each reason its own sentence", async () => {
    const reasons: Array<[string, string]> = [
      ["user_message", "chosen for this message"],
      ["user_thread", "chosen for this thread"],
      ["user_workspace", "chosen in this workspace"],
      ["default", "the default account"],
    ];
    for (const [reason, text] of reasons) {
      const { unmount } = render(
        <I18nProvider>
          <MessageItem message={withRoute({ ...route, reason })} />
        </I18nProvider>,
      );
      const line = await screen.findByTestId("route-line");
      expect(line.textContent, reason).toContain(text);
      unmount();
    }
  });

  it("opens a details panel with what was tried, and only when there was more than one attempt", async () => {
    const { unmount } = render(
      <I18nProvider>
        <MessageItem message={withRoute(route)} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(screen.getByTestId("route-details")).toBeTruthy();
    // Nothing was retried, so there is no attempt list to show.
    expect(screen.queryByTestId("route-attempts")).toBeNull();
    unmount();

    render(
      <I18nProvider>
        <MessageItem
          message={withRoute({
            ...route,
            mode: "auto",
            reason: "auto_failover",
            attempts: [{ accountId: "acct_0000000001", accountName: "Free key", model: "m", failure: "rate_limit" }],
            usage: { inputTokens: 12, outputTokens: 34 },
          })}
        />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    const attempts = screen.getByTestId("route-attempts");
    expect(attempts.textContent).toContain("Free key");
    expect(screen.getByTestId("route-usage").textContent).toContain("12");
  });

  it("says no usage was reported rather than showing zeros", async () => {
    render(
      <I18nProvider>
        <MessageItem message={withRoute(route)} />
      </I18nProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    expect(screen.getByTestId("route-usage").textContent).toBe("No token counts were reported");
  });
});

describe("the route line after a switch", () => {
  const switched = {
    accountId: "acct_bbbbbbbbbb",
    accountName: "OpenAI 主账号",
    model: "gpt-5",
    mode: "auto",
    reason: "auto_after_limit",
    attempts: [{ accountId: "acct_aaaaaaaaaa", accountName: "OpenRouter 免费", model: "deepseek/xxx", failure: "rate_limit" }],
  };
  const show = (route: unknown) =>
    render(<I18nProvider><MessageItem message={msg({ meta: { changes: [], askedQuestion: null, route } as never })} /></I18nProvider>);

  it("names the account that was passed over and what happened to it", async () => {
    // The acceptance criterion for S4: the reply says which account was rate limited and which one took over.
    // A generic "automatic, after another account hit its limit" would leave out the account name, which is the
    // only part a reader cannot derive.
    show(switched);
    const line = await screen.findByTestId("route-line");
    expect(line.textContent).toContain("OpenAI 主账号");
    expect(line.textContent).toContain("gpt-5");
    expect(line.textContent).toContain("OpenRouter 免费");
    expect(line.textContent).toContain("rate limited");
  });

  it("keeps the generic sentence when nothing moved", async () => {
    show({ ...switched, reason: "auto_primary", attempts: [] });
    const line = await screen.findByTestId("route-line");
    expect(line.textContent).toContain("automatic, first choice");
    // No attempts means no account to name, and naming one would be wrong.
    expect(line.textContent).not.toContain("switched");
  });

  it("does not say the route switched when the only attempt is the account that answered", async () => {
    show({
      ...switched,
      accountId: "acct_aaaaaaaaaa",
      accountName: "OpenRouter 免费",
      reason: "auto_primary",
      attempts: [{ accountId: "acct_aaaaaaaaaa", accountName: "OpenRouter 免费", model: "deepseek/xxx", failure: "rate_limit" }],
    });
    const line = await screen.findByTestId("route-line");
    expect(line.textContent).toContain("automatic, first choice");
    expect(line.textContent).not.toContain("switched");
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByTestId("route-attempts").textContent).toContain("was rate limited");
  });

  it("pairs each failed account with its own reason", async () => {
    show({
      ...switched,
      attempts: [
        { accountId: "acct_aaaaaaaaaa", accountName: "OpenRouter 免费", model: "deepseek/xxx", failure: "quota" },
        { accountId: "acct_cccccccccc", accountName: "Work", model: "m", failure: "server" },
      ],
    });
    const line = await screen.findByTestId("route-line");
    expect(line.textContent).toContain("OpenRouter 免费 ran out of quota");
    expect(line.textContent).toContain("Work had a server error");
    expect(line.textContent).not.toContain("OpenRouter 免费 had a server error");
  });

  it("translates the failure kind in the details panel instead of showing the raw code", async () => {
    show(switched);
    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    const attempts = screen.getByTestId("route-attempts");
    expect(attempts.textContent).toContain("was rate limited");
    // `rate_limit` is a machine-readable code in the metadata, not something to put in front of a reader.
    expect(attempts.textContent).not.toContain("rate_limit");
  });
});

describe("MessageItem authors (#163)", () => {
  const member = (userId: string, displayName: string | null, role: "owner" | "member" = "member", removedAt: string | null = null) => ({ userId, displayName, role, removedAt });
  const show = (m: Message) => render(<I18nProvider><MessageItem message={m} /></I18nProvider>);
  const who = (container: HTMLElement) => container.querySelector(".who")!;

  it("with one active member, null and usr_local authors both read You", async () => {
    vi.mocked(hub.listMembers).mockResolvedValue([member("usr_local", null, "owner")]);
    const first = show(msg({ id: "a1", workspaceId: "w-solo", role: "user", content: "old", authorUserId: null }));
    const second = show(msg({ id: "a2", workspaceId: "w-solo", role: "user", content: "new", authorUserId: "usr_local" }));
    await vi.waitFor(() => expect(hub.listMembers).toHaveBeenCalledWith("w-solo"));
    expect(who(first.container).textContent).toContain("You");
    expect(who(second.container).textContent).toContain("You");
    expect(screen.queryByText("Author not recorded")).toBeNull();
  });

  it("with two active members names others, marks removed authors and says when no author was recorded", async () => {
    vi.mocked(hub.listMembers).mockResolvedValue([
      member("usr_local", null, "owner"), member("usr_zhang", "张三"), member("usr_gone", "Gone", "member", "2026-11-17T00:00:00.000Z"),
    ]);
    const mine = show(msg({ id: "b1", workspaceId: "w-two", role: "user", content: "mine", authorUserId: "usr_local" }));
    const theirs = show(msg({ id: "b2", workspaceId: "w-two", role: "user", content: "theirs", authorUserId: "usr_zhang" }));
    const unknown = show(msg({ id: "b3", workspaceId: "w-two", role: "user", content: "old", authorUserId: null }));
    const removed = show(msg({ id: "b4", workspaceId: "w-two", role: "user", content: "bye", authorUserId: "usr_gone" }));
    await vi.waitFor(() => expect(who(theirs.container).textContent).toContain("张三"));
    expect(who(mine.container).textContent).toContain("You");
    expect(who(unknown.container).textContent).toContain("Author not recorded");
    expect(who(removed.container).textContent).toContain("Gone");
    expect(who(removed.container).textContent).toContain("(removed)");
  });

  it("marks a stored mention of a removed member without rewriting the body", async () => {
    vi.mocked(hub.listMembers).mockResolvedValue([
      member("usr_local", null, "owner"), member("usr_zhang", "张三"), member("usr_gone", "Gone", "member", "2026-11-17T00:00:00.000Z"),
    ]);
    const content = "按 @Gone 和 @张三 的说法";
    const { container } = show(msg({
      id: "c1", workspaceId: "w-removed", role: "user", content, authorUserId: "usr_local",
      meta: { mentions: [{ type: "member", id: "usr_gone", text: "@Gone" }, { type: "member", id: "usr_zhang", text: "@张三" }] } as Message["meta"],
    }));
    const chips = await screen.findByTestId("removed-member-mentions");
    expect(chips.textContent).toContain("@Gone");
    expect(chips.textContent).toContain("(removed)");
    expect(chips.textContent).not.toContain("@张三");
    expect(container.textContent).toContain(content);
  });

  it("an older hub without the roster routes still shows You", async () => {
    vi.mocked(hub.listMembers).mockRejectedValue(new Error("404"));
    const { container } = show(msg({ id: "d1", workspaceId: "w-old", role: "user", content: "x" }));
    await vi.waitFor(() => expect(hub.listMembers).toHaveBeenCalledWith("w-old"));
    expect(who(container).textContent).toContain("You");
  });
});
