import { DEFAULT_GRILL_SETTINGS, type Entry, type EntrySummary, type ReportMessageMeta } from "@nema/shared";
import type { GrillState } from "./plugins.js";
import type { Message } from "./messages.js";
import type { TaskChange } from "./tasks.js";
import type { Workspace } from "./workspaces.js";

const LANG_NAME = { ja: "日本語", en: "English", zh: "中文" } as const;

function languageRule(l: Workspace["knowledgeLanguage"]): string {
  if (l === "follow") return "条目语言与用户输入的语言一致。";
  return `所有条目的标题与正文一律用${LANG_NAME[l]}撰写，无论用户用什么语言输入。`;
}

function indexLine(e: EntrySummary): string {
  let line = `${e.id} | ${e.kind} | ${e.status} | ${e.title}`;
  if (e.kind === "question" && e.status === "open" && e.priority !== undefined) line += ` | priority ${e.priority}`;
  if (e.basis === "inferred") line += " | inferred";
  return line;
}

function reportSection(message: Message): string {
  const meta = message.meta as ReportMessageMeta | null;
  const report = meta?.report;
  const list = (values: string[] | undefined) => (values?.length ? values.join(", ") : "（无）");
  const lines = [`[${message.id}] ${report?.agent ?? "coding agent"}：${message.content}`];
  lines.push(`条目：${list(report?.entries)}`, `提交：${list(report?.commits)}`, `文件：${list(report?.files)}`);
  const check = meta?.check;
  if (check) {
    lines.push(
      check.commitsExist ? "提交存在：是" : `提交存在：否（不存在：${check.missingCommits.join(", ")}）`,
      `已合入主分支：${check.onMain === "yes" ? "是" : "尚未"}`,
      check.filesOk ? "文件相符：是" : `文件相符：否（未改动：${check.untouchedFiles.join(", ")}）`,
    );
  } else {
    lines.push(`核实：未能完成${meta?.checkError ? `（${meta.checkError}）` : ""}`);
  }
  return "# 本次 coding agent 上报\n" + lines.join("\n");
}

export type WorkPackagePromptInput = {
  id: string;
  requirements: string[];
  repos: { id: string; label: string }[];
  rules: { spec: string; plan: string };
};

function workPackageSection(wp: WorkPackagePromptInput, grill: GrillState): string {
  const step1 = !grill.enabled
    ? "不做就绪检查；把所有不确定点写进 spec 的「留给实现者」或「待确认」小节。"
    : grill.strictness === "lenient"
      ? "就绪检查（宽松）——读相关需求、决策、取舍、待确认与 inferred 内容；只有决策互相冲突时才停下来：为它建 question，用 workpackage__block 记录最重要的那个，不要写 spec，回复说明卡在哪里。其余不确定点写进 spec 的「待确认」小节。"
      : "就绪检查——读相关需求、决策、取舍、待确认与 inferred 内容；有会影响实现的不确定点时，为每个建 question，用 workpackage__block 记录最重要的那个，不要写 spec，回复说明卡在哪里。";
  const steps = [
    step1,
    "否则先 workpackage__save_spec，再用 code__ 函数核对文件后 workpackage__save_plan；保存被拒时按返回的错误修改再保存。",
    "回复简短说明开发包的状态和任务数。",
  ];
  const strictness = grill.strictness === "lenient" ? "宽松" : "严格";
  return [
    `# 开发包 ${wp.id}`,
    `需求：${wp.requirements.join("、")}`,
    `已绑定仓库：${wp.repos.map((r) => `${r.id}（${r.label}）`).join("、")}`,
    ...(grill.enabled ? [`开发包追问严格程度：${strictness}`] : ["grill-me 已关闭"]),
    "## spec 写作规则\n" + wp.rules.spec.trim(),
    "## plan 写作规则\n" + wp.rules.plan.trim(),
    "## 步骤\n" + steps.map((t, i) => `${i + 1}. ${t}`).join("\n"),
  ].join("\n\n");
}

export function buildPrompt(input: {
  workspace: Workspace;
  userMessage: Message;
  recentMessages: Message[];
  entries: EntrySummary[];
  lastAskedQuestion: Entry | null;
  priorChanges?: TaskChange[];
  /** grill-me state of the workspace; omitted means on with the default settings. */
  grill?: GrillState;
  /** Set for a work package generation task. */
  workpackage?: WorkPackagePromptInput;
  /** The message the user is replying to, in full, whatever its age. */
  quotedMessage?: Message | null;
}): string {
  const { workspace, userMessage, entries, lastAskedQuestion } = input;
  const grill: GrillState = input.grill ?? { enabled: true, ...DEFAULT_GRILL_SETTINGS };
  const recent = input.recentMessages.filter((m) => m.id !== userMessage.id).slice(-20);
  const rules = [
    "你只能通过名为 `room` 的 MCP 工具读写项目知识；不要读写本地文件，不要联网。",
    "把用户输入整理成准确的业务语言，写成 requirement / decision / tradeoff / question / source 条目。每次 `upsert_entry` 都要填写 `sourceMessages`（至少包含本次用户消息 id）和 `reason`。",
    "不确定、有歧义、或与现有条目冲突的内容，不要猜，写成 `question` 条目（status 为 `open`，priority 取 1–3，1 最高）。",
    "每次 `upsert_entry` 都要填写 `basis`：用户字面说过的写 `stated`，用户明确拍板的写 `decided`，你自己推断的写 `inferred`。用户没说过的内容只能写成 `question` 或标 `inferred`，不能写成 `stated` / `decided`。",
    "改写或作废 active 的决策，必须以用户消息为依据（basis 为 `stated` 或 `decided`，sourceMessages 含该用户消息）。只是推断时不要改它，新建一条 `question` 询问用户。",
    "需要保留用户原话时，用 `quotes`（messageId + 从该消息逐字复制的文本，最多 500 字）。摘录对团队可见，只摘与条目相关的部分。",
    "用户确认某条内容仍然有效时，更新该条目并设 `confirmed: true`。",
    "用户的回答要写成决策或需求，并把对应的 question 置为 `resolved`。",
    "输入中出现的 URL 登记为 `source` 条目（url + 一句话说明 + related），不要访问链接。",
    languageRule(workspace.knowledgeLanguage),
    grill.enabled
      ? "最后的回复只简短总结做了什么，不要在回复里提问，系统会自动从待确认中挑一个问题展示。回复的语言与本次用户输入一致。"
      : "最后的回复只简短总结做了什么，不要在回复里提问。回复的语言与本次用户输入一致。",
  ];
  if (grill.enabled) {
    rules.push(
      grill.strictness === "lenient"
        ? "追问严格程度：宽松——只有决策互相冲突时才停下来问，其余写进待确认。"
        : "追问严格程度：严格——任何会影响实现的问题都先问。",
    );
  }
  const system = userMessage.role === "system";
  if (system) rules.push("这是系统发起的请求，不是用户说的话：不要把它当作用户的陈述或决定（basis 不能是 stated / decided）。");
  const report = userMessage.role === "report";
  if (report) {
    rules.push(
      "这是 coding agent 的上报，不是用户说的话：不要把它当作用户的陈述或决定（basis 不能是 stated / decided）。",
      "把上报关联到需求，更新需求的 implementation：核实通过（三项都是「是」）设 verified 并引用本上报；已合入主分支为「尚未」时设 reported 并在 note 写「尚未合入主分支」；提交不存在或文件不符时设 mismatch，并新建一条 question 问用户。",
      "不要仅凭上报内容就认为决策被正确实现；如有疑问用 code__ 函数核对，并新建 question。",
    );
    const rep = (userMessage.meta as ReportMessageMeta | null)?.report;
    const wps = (rep?.entries ?? []).filter((e) => /^W-[1-9]\d*$/.test(e));
    if (rep?.task !== undefined && wps.length === 1) {
      rules.push(`本上报属于开发包 ${wps[0]} 的任务 ${rep.task}；任务状态由系统根据核实结果设置，不要用 workpackage__ 函数改它。`);
    }
  }
  const parts: string[] = [
    "# 规则\n" + rules.map((r, i) => `${i + 1}. ${r}`).join("\n"),
    `# Workspace\n${workspace.name}`,
    "# 现有条目索引\n" + (entries.length ? entries.map(indexLine).join("\n") : "（暂无）"),
  ];
  if (grill.enabled && grill.extraRules.trim()) parts.push(`# 本 workspace 的补充追问规则\n${grill.extraRules}`);
  if (lastAskedQuestion) {
    parts.push(
      `# 上一个追问\n${lastAskedQuestion.id}：${lastAskedQuestion.title}\n${lastAskedQuestion.body}\n本次用户输入很可能是对它的回答。`,
    );
  }
  parts.push("# 最近消息\n" + (recent.length ? recent.map((m) => `[${m.id}] ${m.role}: ${m.content}`).join("\n") : "（无）"));
  if (input.priorChanges?.length) {
    const lines = input.priorChanges.map((c) => `${c.op} ${c.entryId} | ${c.kind} | ${c.title}`);
    parts.push(
      "# 本任务中断前已写入\n" +
        lines.join("\n") +
        "\n这是同一条消息的重试：这些条目已经写入，需要时用 id 更新，不要重复新建。",
    );
  }
  if (input.workpackage) parts.push(workPackageSection(input.workpackage, grill));
  if (input.quotedMessage) {
    const q = input.quotedMessage;
    parts.push(`# 本次消息引用的消息\n[${q.id}] ${q.role}: ${q.content}\n本次用户消息是针对这条消息的补充、更正或确认。`);
  }
  if (report) parts.push(reportSection(userMessage));
  else parts.push(`# ${system ? "本次系统请求" : "本次用户消息"}\n[${userMessage.id}] ${userMessage.content}`);
  return parts.join("\n\n") + "\n";
}
