import { describe, expect, test } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import type { Message } from "../src/messages.js";
import type { Workspace } from "../src/workspaces.js";
import type { Entry, EntrySummary } from "@nema/shared";

const ws = (l: Workspace["knowledgeLanguage"]): Workspace => ({
  id: "ws_1", name: "项目甲", confidential: true, knowledgeLanguage: l, createdAt: "2026-01-01T00:00:00.000Z", archivedAt: null,
});
const msg = (i: number, role: Message["role"] = "user"): Message => ({
  id: `m_${i}`, workspaceId: "ws_1", role, content: `content-${i}`, meta: null, taskId: null, createdAt: "2026-01-01T00:00:00.000Z",
});
const entries = [
  { id: "R-1", kind: "requirement", status: "active", title: "流式输出", related: [] },
  { id: "Q-4", kind: "question", status: "open", title: "谁审批", priority: 2, related: [] },
] as unknown as EntrySummary[];

const base = (l: Workspace["knowledgeLanguage"] = "follow", recent: Message[] = [], last: Entry | null = null) =>
  buildPrompt({ workspace: ws(l), userMessage: msg(999), recentMessages: recent, entries, lastAskedQuestion: last });

describe("buildPrompt", () => {
  test("rules and content", () => {
    const p = base();
    for (const k of ["room", "sourceMessages", "question", "resolved", "source", "不要在回复里提问"]) expect(p).toContain(k);
    expect(p).toContain("m_999");
    expect(p).toContain("content-999");
    expect(p).toContain("项目甲");
    expect(p).toContain("R-1 | requirement | active | 流式输出");
    expect(p).toMatch(/Q-4 \| question \| open \| 谁审批.*2/);
  });
  test("recent messages capped at 20 (latest kept)", () => {
    const recent = Array.from({ length: 30 }, (_, i) => msg(i, i % 2 ? "agent" : "user"));
    const p = base("follow", recent);
    expect((p.match(/^\[m_(?!999)\d+\] /gm) ?? []).length).toBe(20);
    expect(p).toContain("[m_29] agent: content-29");
    expect(p).not.toContain("[m_9] ");
  });
  test("language rules", () => {
    expect(base("ja")).toContain("日本語");
    expect(base("en")).toContain("English");
    expect(base("zh")).toContain("中文");
    expect(base("follow")).toContain("与用户输入的语言一致");
    expect(base("ja")).not.toContain("与用户输入的语言一致");
  });
  test("last asked question", () => {
    const q = { id: "Q-4", kind: "question", title: "谁审批", body: "请确认审批人", status: "open" } as unknown as Entry;
    const p = base("follow", [], q);
    expect(p).toContain("上一个追问");
    expect(p).toContain("请确认审批人");
    expect(base()).not.toContain("上一个追问");
  });

  test("lists prior changes on a retry", () => {
    const p = buildPrompt({
      workspace: ws("follow"),
      userMessage: msg(999),
      recentMessages: [],
      entries,
      lastAskedQuestion: null,
      priorChanges: [
        { entryId: "R-1", kind: "requirement", title: "流式输出", op: "add" },
        { entryId: "D-2", kind: "decision", title: "用库", op: "update" },
      ],
    });
    const section = [
      "# 本任务中断前已写入",
      "add R-1 | requirement | 流式输出",
      "update D-2 | decision | 用库",
      "这是同一条消息的重试：这些条目已经写入，需要时用 id 更新，不要重复新建。",
    ].join("\n");
    expect(p).toContain(section);
    expect(p.indexOf(section)).toBeLessThan(p.indexOf("# 本次用户消息"));
  });

  test("omits the section when there are none", () => {
    expect(base()).not.toContain("本任务中断前已写入");
    const p = buildPrompt({
      workspace: ws("follow"),
      userMessage: msg(999),
      recentMessages: [],
      entries,
      lastAskedQuestion: null,
      priorChanges: [],
    });
    expect(p).not.toContain("本任务中断前已写入");
  });

  test("includes the basis, decision, quote and confirm rules", () => {
    const rules = [
      "每次 `upsert_entry` 都要填写 `basis`：用户字面说过的写 `stated`，用户明确拍板的写 `decided`，你自己推断的写 `inferred`。用户没说过的内容只能写成 `question` 或标 `inferred`，不能写成 `stated` / `decided`。",
      "改写或作废 active 的决策，必须以用户消息为依据（basis 为 `stated` 或 `decided`，sourceMessages 含该用户消息）。只是推断时不要改它，新建一条 `question` 询问用户。",
      "需要保留用户原话时，用 `quotes`（messageId + 从该消息逐字复制的文本，最多 500 字）。摘录对团队可见，只摘与条目相关的部分。",
      "用户确认某条内容仍然有效时，更新该条目并设 `confirmed: true`。",
    ];
    const block = [
      "3. 不确定、有歧义、或与现有条目冲突的内容，不要猜，写成 `question` 条目（status 为 `open`，priority 取 1–3，1 最高）。",
      ...rules.map((r, i) => `${i + 4}. ${r}`),
      "8. 用户的回答要写成决策或需求，并把对应的 question 置为 `resolved`。",
    ].join("\n");
    expect(base()).toContain(block);
  });

  test("marks inferred entries in the index", () => {
    const mixed = [
      { id: "R-1", kind: "requirement", status: "active", title: "流式输出", related: [], basis: "inferred" },
      { id: "D-2", kind: "decision", status: "active", title: "用库", related: [], basis: "decided" },
      { id: "R-3", kind: "requirement", status: "active", title: "已说", related: [], basis: "stated" },
      { id: "Q-4", kind: "question", status: "open", title: "谁审批", priority: 2, related: [], basis: "inferred" },
      { id: "Q-5", kind: "question", status: "open", title: "无依据", priority: 1, related: [], basis: null },
    ] as unknown as EntrySummary[];
    const p = buildPrompt({
      workspace: ws("follow"),
      userMessage: msg(999),
      recentMessages: [],
      entries: mixed,
      lastAskedQuestion: null,
    });
    expect(p).toContain("R-1 | requirement | active | 流式输出 | inferred");
    expect(p).toContain("Q-4 | question | open | 谁审批 | priority 2 | inferred");
    expect(p).toContain("D-2 | decision | active | 用库");
    expect(p).not.toContain("D-2 | decision | active | 用库 | inferred");
    expect(p).toContain("R-3 | requirement | active | 已说");
    expect(p).not.toContain("R-3 | requirement | active | 已说 | inferred");
    expect(p).toContain("Q-5 | question | open | 无依据 | priority 1");
    expect(p).not.toContain("Q-5 | question | open | 无依据 | priority 1 | inferred");
  });
  test("the prompt for a system task says 本次系统请求 and forbids stated/decided", () => {
    const p = buildPrompt({ workspace: ws("follow"), userMessage: msg(999, "system"), recentMessages: [], entries, lastAskedQuestion: null });
    expect(p).toContain("# 本次系统请求\n[m_999] content-999");
    expect(p).not.toContain("# 本次用户消息");
    expect(p).toContain("这是系统发起的请求，不是用户说的话：不要把它当作用户的陈述或决定（basis 不能是 stated / decided）。");
    expect(base()).not.toContain("这是系统发起的请求");
  });
  test("the prompt for a report task shows the check lines and the implementation rules", () => {
    const report = {
      agent: "claude-code",
      gitCommonDir: "/real/a/.git",
      summary: "实现了流式输出",
      entries: ["R-1", "D-2"],
      commits: ["abcdef1", "1234567"],
      files: ["src/a.ts", "src/b.ts"],
    };
    const check = {
      commitsExist: true,
      missingCommits: [],
      onMain: "not-yet" as const,
      filesOk: false,
      untouchedFiles: ["src/b.ts"],
      touchedFiles: [],
      checkedAt: "2026-10-23T10:00:00.000Z",
      mainSha: "2".repeat(40),
    };
    const userMessage: Message = { ...msg(999, "report"), content: report.summary, meta: { report, check } };
    const p = buildPrompt({ workspace: ws("follow"), userMessage, recentMessages: [], entries, lastAskedQuestion: null });
    const section = p.slice(p.indexOf("# 本次 coding agent 上报"));
    expect(p.indexOf("# 本次 coding agent 上报")).toBeGreaterThan(p.indexOf("# 最近消息"));
    expect(p).not.toContain("# 本次用户消息");
    for (const line of [
      "[m_999] claude-code：实现了流式输出",
      "条目：R-1, D-2",
      "提交：abcdef1, 1234567",
      "文件：src/a.ts, src/b.ts",
      "提交存在：是",
      "已合入主分支：尚未",
      "文件相符：否（未改动：src/b.ts）",
    ]) {
      expect(section).toContain(line);
    }
    expect(p).toContain(
      "把上报关联到需求，更新需求的 implementation：核实通过（三项都是「是」）设 verified 并引用本上报；已合入主分支为「尚未」时设 reported 并在 note 写「尚未合入主分支」；提交不存在或文件不符时设 mismatch，并新建一条 question 问用户。",
    );
    expect(p).toContain("不要仅凭上报内容就认为决策被正确实现；如有疑问用 code__ 函数核对，并新建 question。");
    expect(base()).not.toContain("把上报关联到需求");

    const passed = buildPrompt({
      workspace: ws("follow"),
      userMessage: { ...userMessage, meta: { report, check: { ...check, onMain: "yes", filesOk: true, untouchedFiles: [] } } },
      recentMessages: [],
      entries,
      lastAskedQuestion: null,
    });
    expect(passed).toContain("提交存在：是\n已合入主分支：是\n文件相符：是");

    const missing = buildPrompt({
      workspace: ws("follow"),
      userMessage: { ...userMessage, meta: { report, check: { ...check, commitsExist: false, missingCommits: ["1234567"] } } },
      recentMessages: [],
      entries,
      lastAskedQuestion: null,
    });
    expect(missing).toContain("提交存在：否（不存在：1234567）");

    const failed = buildPrompt({
      workspace: ws("follow"),
      userMessage: { ...userMessage, meta: { report, check: null, checkError: "daemon 未连接" } },
      recentMessages: [],
      entries,
      lastAskedQuestion: null,
    });
    expect(failed).toContain("核实：未能完成（daemon 未连接）");
  });

  const withGrill = (grill: { enabled: boolean; strictness: "strict" | "lenient"; extraRules: string }) =>
    buildPrompt({ workspace: ws("follow"), userMessage: msg(999), recentMessages: [], entries, lastAskedQuestion: null, grill });

  test("strict and lenient add their line", () => {
    expect(withGrill({ enabled: true, strictness: "strict", extraRules: "" })).toContain("追问严格程度：严格——任何会影响实现的问题都先问。");
    const lenient = withGrill({ enabled: true, strictness: "lenient", extraRules: "" });
    expect(lenient).toContain("追问严格程度：宽松——只有决策互相冲突时才停下来问，其余写进待确认。");
    expect(lenient).not.toContain("补充追问规则");
  });

  test("extra rules are appended under their heading", () => {
    const p = withGrill({ enabled: true, strictness: "strict", extraRules: "涉及付款一律先问" });
    expect(p).toContain("# 本 workspace 的补充追问规则\n涉及付款一律先问");
  });

  test("grill-me off drops strictness and extra rules but keeps uncertain-to-question", () => {
    const p = withGrill({ enabled: false, strictness: "lenient", extraRules: "涉及付款一律先问" });
    expect(p).toContain("不确定、有歧义、或与现有条目冲突的内容，不要猜，写成 `question` 条目");
    expect(p).not.toContain("追问严格程度");
    expect(p).not.toContain("涉及付款一律先问");
    expect(p).not.toContain("系统会自动从待确认中挑一个问题展示");
  });

  describe("work package generation", () => {
    const wp = { id: "W-1", requirements: ["R-1", "R-2"], repos: [{ id: "repo_a", label: "api" }], rules: { spec: "SPEC-RULES-TEXT", plan: "PLAN-RULES-TEXT" } };
    const gen = (grill: { enabled: boolean; strictness: "strict" | "lenient"; extraRules: string }) =>
      buildPrompt({ workspace: ws("follow"), userMessage: msg(999, "system"), recentMessages: [], entries, lastAskedQuestion: null, grill, workpackage: wp });

    test("the prompt includes both rule files and the readiness steps", () => {
      const p = gen({ enabled: true, strictness: "strict", extraRules: "" });
      expect(p).toContain("# 开发包 W-1");
      expect(p).toContain("R-1、R-2");
      expect(p).toContain("repo_a（api）");
      expect(p).toContain("SPEC-RULES-TEXT");
      expect(p).toContain("PLAN-RULES-TEXT");
      expect(p).toContain("1. 就绪检查——读相关需求、决策、取舍、待确认与 inferred 内容；有会影响实现的不确定点时，为每个建 question，用 workpackage__block");
      expect(p).toContain("2. 否则先 workpackage__save_spec，再用 code__ 函数核对文件后 workpackage__save_plan");
      expect(p).toContain("3. 回复简短说明开发包的状态和任务数。");
    });

    test("with grill off it skips the readiness stop", () => {
      const p = gen({ enabled: false, strictness: "strict", extraRules: "" });
      expect(p).toContain("1. 不做就绪检查；把所有不确定点写进 spec 的「留给实现者」或「待确认」小节。");
      expect(p).not.toContain("workpackage__block");
      expect(p).toContain("workpackage__save_spec");
    });

    test("lenient only stops on conflicting decisions", () => {
      const p = gen({ enabled: true, strictness: "lenient", extraRules: "" });
      expect(p).toContain("只有决策互相冲突时才停下来");
      expect(p).toContain("workpackage__block");
    });

    test("an ordinary prompt has no work package section", () => {
      expect(base()).not.toContain("# 开发包");
    });
  });
});
