# 证据回流 v1：结构化上报与核实分离

日期：2026-10-28。Issue：[Nema-Project/nema-room#32](https://github.com/Nema-Project/nema-room/issues/32) 的拆分第 1 项（差距表第 4、5 行）。与 [ROADMAP](../../../ROADMAP.md) P1-07 一起设计。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。

**状态**：设计。本文件不是 plan，不改生产代码，不改测试，不改 ROADMAP 的状态。P1-07 仍是待办，直到实现和下面的开放问题有了用户的选择，并有验收证据。本文件不改变 P0 的顺序。

**设计所对照的 HEAD**：`f83b6d2f3ea8f8f4c2e7f1283ffdd1539c6b980b`（`origin/main`，Merge pull request #57）。

知识库里没有本设计对应的 R/D 条目。`## 已定的做法` 里的条款都标 `[推断]`：标的是「不是从已有条目抄来的」。来源标记写的是 issue、路线图或本任务已经写明的范围，不是知识库编号。

本次读过的代码，都在这个 SHA 上：

- `packages/shared/src/report.ts`：`ReportInput` 只有 `agent`（1–40 字符）、`gitCommonDir`、`summary`、`entries`、`commits`（至少 1 个）、`files`、可选 `task`。`ReportCheck` 是提交存在、`onMain`（含 patch-id）、声称的文件确实被改过。`reportPassed` 为这三项都过。`ReportMessageMeta` 是 `{ report, check, checkError? }`。`Implementation.status` 只有 `reported | verified | mismatch`。`evidence.confirmedBy` 只能是 `"user"` 或空。
- `apps/cli/src/report/SKILL.md`：做完并提交后再报一次。不报未完成的工作。
- `apps/cli/src/report/commands.ts`：省略 `--agent` 时写入 `coding-agent`。令牌是本机 `~/.nema/report-token`，一把给所有本机 agent 用。
- `apps/hub/src/reports.ts`：`routeRepo` 按 `gitCommonDir` 找到未归档 workspace。`receiveReport` 先存 `report` 消息，再让 daemon 跑 `report.check`。`recheckReports` 在主分支移动后重跑「尚未合入」的核对，通过时排队一条系统任务，原文要求把需求的 implementation 更新为 `verified`。
- `apps/hub/src/roomApi.ts`：`implementationRefusal`。Agent 把 `status` 写成 `verified` 时，必须指向本 workspace 一条 `reportPassed` 的上报，且引用的提交都在那条上报里。`confirmedBy` 不能由 Agent 设置。`assertCurrentTaskUserEvidence`（#28 / #30）要求用户 basis 引用当前任务的 user 消息。`report` 角色不是 user。
- `apps/hub/src/workpackages.ts`：`applyReportToWorkPackage` 按 git 核对把开发包任务写成 `verified` / `reported` / `mismatch`。全部任务 `verified` 时，用 `author: "system"` 把相关需求的 implementation 写成 `verified`、`confirmedBy: null`。
- `packages/knowledge/src/store.ts`：`confirmImplementation` 只接受 `reported` 或 `mismatch`，写成 `verified` 且 `confirmedBy: "user"`，提交说明是「用户确认已实现」。
- `apps/hub/src/prompt.ts`：上报不是用户陈述。三项都是「是」时，prompt 要求把 implementation 设为 `verified`。
- `apps/web/components/MessageItem.tsx`：上报气泡展示 `agent` 字符串、条目 id、提交、三项 git 核对。没有 PR、CI、作者。
- `apps/web/components/EntryDetail.tsx` 与 `messages/*.json`：`impl.verified` 的中文是「已核实」。用户确认和 git 通过都落到这一个词。
- `apps/cli/src/github/gh.ts` 与 `packages/shared/src/plugins.ts`：`github__pull_request_read` 的 `get` / `get_check_runs` 用本机 `gh` 读 PR head SHA 和该 SHA 的 check runs。这是只读路径。
- `apps/hub/src/githubScope.ts`：`githubTarget` 只认 `github.com` 远程。调用必须落在本 workspace 已绑定仓库的远程里。
- `apps/hub/src/evidenceEvents.ts`：`actor` 固定写 `'user'`。kind 只有 `promote_basis`、`confirm_revision`、`confirm_entry`。这是知识确认，不是 CI。
- 上报路径没有调用 GitHub 插件。`ReportCheck` 没有作者字段。

## 意图

#32 要留下的不是编排，而是执行证据回到讨论，并能和已定的需求、决策对照。今天做不到的那一步是：coding agent 的原话，和 hub 自己核对到的 git / PR / CI，写在同一条上报里，读的人分不出哪一句是声称、哪一句是核对。`verified` 这个词同时表示「提交已在主分支上对得上」和「用户确认做完了」。P1-07 要求把这两件事拆开，并且不把 Git 证据说成测试通过或验收通过。

#45 的判断标准是：这是否让人和 agent 更容易对项目保持有证据支撑的共同理解。本设计服务于这件事，方式是：

- 讨论里同时留着两份记录。一份是 agent 声称的分支、PR、head、它说自己验证了什么、没验证什么、阻塞。一份是 hub 用本机 git 和已有只读 GitHub 路径读到的结果。两份都带时间。后一份不覆盖前一份。
- 需求上的「提交已核对」和「验收已确认」用不同的证据来源。人回看时可以指出分歧从声称开始，还是从核对结果开始，而不是只看见一个「已核实」。
- Agent 的名字、提交作者、check run 都作为证据显示。hub 不据此决定谁有权改仓库，也不把这些记录写成用户的陈述或决定。

做不到这个区分的实现，即使字段都加上了，也不符合本设计。

## 目标

- 旧的 `nema report` JSON 仍能通过解析。没有新字段的上报仍是「已完成」上报，`commits` 仍至少 1 个。
- 已完成上报可以多带可选的声称字段。另有一种「进行中」上报，可以没有提交。
- 一条上报里，agent 送来的 JSON 原样保留。hub 的 git 核对、提交作者、GitHub 读取结果分开放，各有自己的时间和来源。
- 界面把「agent 声称」和「hub 核实」分成两块。提交的 author 和 committer 出现在核实块旁边，只作为证据。
- 上报通过已有的 `entries` 指向它声称相关的需求或决策。链接不是「这条已经实现了」。
- 需求的实现状态在界面上能分清「提交已核对」「测试证据还没有」「验收已确认」。Git 三项通过不再显示成验收。
- Agent 仍不能伪造用户 basis，不能自己写入 `confirmedBy`。

## 非目标

- 派发 coding agent、自动开 PR、自动合并。#32 拆分第 7 项。主 spec 和开发包 spec 的非目标保持原样。
- 进度看板、按 agent 或 PR 的生命周期状态。#32 拆分第 5 项里的看板部分。
- 跨 agent 的文件或分支冲突检测。`repo_hooks` 仍只写不读。
- 系统通知、桌面 `Notification`、把待决定事项推到其他设备。#32 拆分第 6 项。
- 执行层决定卡片（合并 / 再改 / 放弃，或「是否超出已定范围」）。#32 拆分第 2 项。
- 提交作者的允许名单、禁止账号、据此拒绝上报或拒绝合入。那是需要人先写下名单的仓库策略。#45 不允许 hub 自行决定组织权威。
- 按 agent 可吊销的上报令牌，以及不依赖本机 `gitCommonDir` 的远程 / 云端接入。#32 拆分第 3、4 项。第 3 项仍排在第 4 项之前，本设计不实现它。
- 把 CI / PR 观察写进 `evidence_events`，或把 `sourceRefs` 接到 check run。CX-03 今天没有这条接线，v1 也不加。
- 新的外部服务连接器、第二套 GitHub 凭证、把本机 hub 暴露到本机以外。
- 用 agent 的 `verified` 列表或某条 check run 自动宣布「测试已通过」。测试结论怎样才算通过，见开放问题，v1 在得到答案之前不宣布通过。

## 反目标

做到了也算失败：

1. 用 agent 上报里的 `verified`、`ci`、`summary` 或 `blockers`，把需求写成验收已确认，或把测试显示成已通过。
2. `reportPassed` 为真时，界面或系统任务把这叫做验收通过、需求完成，或「已核实」而不说明这只是提交核对。
3. 读不到 PR 或 check run 时，把测试或 head 显示成通过。没请求、失败、超时都不是通过。
4. 根据作者或 committer 接受、拒绝、隐藏上报，或显示「该账号被允许 / 被禁止」。
5. 把 GitHub 观察或作者信息写入 `evidence_events`，或把它们当作 `stated` / `decided` 的用户消息。
6. 旧上报因为缺少新字段而 400。已完成上报因为 `commits` 为空而通过解析。
7. 把 `agent` 字符串显示成已登录的身份，或用它去对 GitHub 用户。
8. GitHub 读取失败或超时时，把 head 比较或 check run 显示成通过。开放问题 3 的选项 B 会在未登录时拒绝带 `pr` 的请求；那是用户尚未选择的策略，不是本条反目标。
9. 为了本设计去派发 agent、做冲突合并、发通知，或增加执行层决定条目。

## 约束

- 代码和注释用英文。hub 新的拒绝文案和界面新句子用中文，并同时改 `apps/web/messages` 的 en、zh、ja。英文和日文必须保住「提交核对 ≠ 测试通过 ≠ 验收」这三层，不能译成同一个「已核实」。
- 不新增依赖。GitHub 读取复用 `apps/cli/src/github/gh.ts` 已有的只读 PR head 与 check-runs 请求，以及 `githubTarget` / `checkGithubCall` 的仓库范围。不新增 hub 上的 GitHub token 文件。
- 知识 Git 仍是条目正文的权威。本设计不改条目 frontmatter 的字段名。`Implementation.status` 的三个值保持 `reported | verified | mismatch`。
- 上报的声称和 hub 的观察放在 `messages.meta` 里，和今天的 `report` / `check` 放在一起。不新表，因此不新迁移。旧 meta 缺新键时按「没有这份观察」读。
- `evidence_events` 的形状只作对照：用户确认是另一份记录，`actor` 固定为 user，Agent 不能制造或消费。v1 不往这张表插入行。CI / PR 证据今天没有接到这张表，本设计也不接。
- #28 / #30 的用户 basis 检查、失效状态改回 `active` 的检查、CX-03 的外部引用检查，都不得放宽。`report` 消息仍不是 user 消息。
- 一个数据目录同时只跑一个 hub。核对仍走 daemon 的 git。GitHub 读取在 daemon 上用已经存在的 `gh`，不在 hub 进程里保存第二份凭证。
- 本机上报令牌仍是一把共享的 `~/.nema/report-token`。v1 不把它拆成 per-agent 令牌。
- 实施时再对一次当时的 HEAD。若 `ReportInput` 或 `ReportMessageMeta` 已和本文不同，先改本文再写 plan。

## 已定的做法

### 上报怎么兼容

- 新字段都是可选的。省略时，解析结果与 `f83b6d2` 上的 `ReportInput` 相同，并视为已完成上报。【#32 拆分 1】[推断]
- 增加 `progress`：`"completed"` 或 `"in_progress"`。省略时是 `"completed"`。旧客户端不送这个字段。【#32 拆分 1】[推断]
- `commits` 的「至少 1 个」只约束 `progress === "completed"`。进行中上报的 `commits` 可以是空数组，省略则当成空数组，最多仍是 50 个，每个仍是 7–40 位十六进制。已完成上报沿用今天的至少 1 个、最多 50 个。这样旧上报不变，进行中也不必编造提交。【#32 拆分 1】[推断]
- 其余新字段见下一节。超长、类型不对、提交不是十六进制，仍是今天的 400「上报内容不完整或格式不对」。未知键由 zod 丢掉，与今天相同，不因为多了键而 400。【#32 拆分 1】[推断]

### Agent 声称的字段

这些字段只表示 agent 说了什么。hub 不改正文，不把它们抄进 `Implementation`。

- `agent`：1–40 字符的自由文本，默认仍是 `coding-agent`。它是未认证标签。服务端不把它映射到 GitHub 用户、本机账号或令牌。界面在这个字符串旁边写明：这是上报里的名字，不是已认证的身份。两个人可以送同一个字符串。【本任务已定】[推断]
- `branch`：可选字符串，1–200 字符，不含换行。v1 不拿它和 git 分支表对照。一个提交可以在多个分支上，对照分支会滑进冲突检测。【非目标】[推断]
- `pr`：可选正整数，表示这条上报所路由到的那个仓库上的 PR 号。仓库由现有的 `gitCommonDir` 决定，不在字段里再写 owner/repo。【#32 拆分 1】[推断]
- `headSha`：可选，40 位小写十六进制。这是 agent 声称的 head，不是 `ReportCheck.mainSha`。
- `ci`：可选数组，最多 30 项。每项是 agent 自己的描述：`name`（1–200）、可选 `conclusion`（1–40）、可选 `url`（1–500）。这不是 hub 读到的 check run。
- `verified`、`notVerified`：可选字符串数组，各最多 30 项，每项 1–200 字符。含义是「agent 声称已验证 / 尚未验证」。名字与 `Implementation.status` 的 `verified` 撞车。存储就用这两个 JSON 名；界面必须写成「agent 声称已验证」，禁止写成「已核实」或「测试已通过」。【P1-07】[推断]
- `blockers`：可选字符串数组，最多 20 项，每项 1–500 字符。只展示。不自动建 `question`，不写成用户决定，不产生执行层决定卡片。【#28】[推断]
- `entries` 保持今天的 id 语法（`R D T Q S G W`）。它是关联声称：这条上报说自己和这些条目有关。id 在本 workspace 不存在时，上报仍然收下，界面把该 id 标成找不到，不创建条目。存在的需求或决策显示标题，并链到条目。链到决策不修改该决策的 basis、状态或正文。【#32 拆分 1】[推断]
- `summary`、`files`、`task`、`gitCommonDir` 的规则不变。技能文本改为：已完成的工作仍在提交之后上报；进行中可以上报，并且必须把 `progress` 设为 `in_progress`。新字段里同样禁止秘密、令牌和密钥。【#32 拆分 1】[推断]

### 两份记录怎么放

`messages.meta` 扩展为：

- `report`：解析后的 `ReportInput`，即声称。收到之后不改写。
- `check` / `checkError`：今天的 git 核对，含义不变。`reportPassed` 的定义不变：提交都存在、都在主分支上（或 patch-id 相同）、声称的文件都被这些提交改过。
- `authors`：hub 从本机 git 读到的作者证据。见下。
- `github`：hub 用只读 GitHub 路径读到的观察。见下。

四块彼此独立。`check` 不为了匹配声称而改写 `report`。`github` 不为了匹配 `report.ci` 而改写 `report.ci`。旧消息没有 `authors` 和 `github` 时，界面显示「这条上报没有这份 hub 记录」，不回填，也不当成通过。【#45】[推断]

每块有自己的时间：声称用消息的 `created_at`；`check.checkedAt` 保持今天的字段；`authors.checkedAt` 与 `github.checkedAt` 是 hub 写完该块的时间。来源写死在数据里：作者块 `source: "git"`；GitHub 块 `source: "github-plugin-read"`。这里的 source 表示「走了与 `github__pull_request_read` 相同的只读请求」，不是「房间里的模型调用了工具，所以我们采信模型的转述」。模型后来用 `github__` 再读一次，不写回这三块，也不能代替它们。【#32 拆分 1】[推断]

进行中且 `commits` 为空：不调用 `report.check`，`check` 为 null，不设 `checkError`。另记 `checkSkipped: "in_progress_no_commits"`。这不是失败，也不是 `reportPassed`。进行中但带了提交：对那些提交跑和今天相同的 git 核对。已完成上报始终跑 git 核对，与今天相同。【#32 拆分 1】[推断]

`recheckReports` 仍只重跑 git 核对仍是 `onMain: "not-yet"` 的上报，期限仍是 30 天。重跑时一并重读这些提交的作者。GitHub 块是否在同一次重跑里刷新，跟开放问题 3 的「何时去读」同一规则。git 重跑本身不依赖 GitHub。【兼容】[推断]

### 作者只作证据

- 对 `check` 已经解析到的每个完整 SHA，用本机 git 读取 author 的 name 与 email、committer 的 name 与 email。读不到的提交不编造身份，该 SHA 记入缺失列表。
- 界面把这份名单放在 git 核对结果旁边。固定说明：这是提交元数据，不是允许或拒绝。不出现允许名单、禁止账号、通过或拦截。
- 不把 email 打进 hub 的错误日志。上报摘要里本来就禁止秘密；作者 email 是 git 对象上的字段，只进 `authors` 和界面。
- 名单不参与 `reportPassed`，不参与 `implementationRefusal`，不参与开发包任务状态。【本任务已定】[推断]

### GitHub 观察

观察的形状现在定死。何时发起读取见开放问题 3。不论那个选项怎么选，下面的结果含义不变。

- 声称没有 `pr`：`github.state = "not_requested"`。这不是失败，也不是通过。
- 去读了但 `gh` 不可用、未登录、插件未开、远程不是一个明确的 `github.com` 仓库、超时或 HTTP 失败：`state = "unavailable"`，带原因短句。head 与测试都不是通过。
- 读到了 PR：记下远程的 owner/repo、PR 当前 head SHA、与声称 `headSha` 的比较。声称没有 `headSha` 时比较结果是 `not_comparable`，仍保存读到的 head。两边都是 40 位十六进制且逐字符相同才是 `match`，否则是 `mismatch`。不改写声称里的 `headSha`。
- check runs 记 `name`、`status`、`conclusion`、url（没有则为 null）。读的是 PR head 的 check runs，不是 agent 的 `ci` 数组。若一页没读完，`truncated: true`，界面说明名单不完整。不完整的名单不能被说成「全部通过」。
- 范围与今天的插件相同：只读本 workspace 绑定仓库的 `github.com` 远程。声称的 PR 若对不上这个仓库，不跟过去读别的仓库，观察为 `unavailable`，原因是不在绑定范围内。
- check run 名单要显示，并和 `report.ci` 分开，让人能看见 hub 读到了什么。它不得被标成「测试已通过」或「验收已确认」。它会不会把需求或开发包任务从 `reported` / 存储值 `verified` 改成 `mismatch`，见开放问题 2。计划在用户选定之前不得假设 A、B 或 C。【P1-07】[推断]

### P1-07：三个状态各有来源

存储仍用今天的三个 `status` 和一个 `confirmedBy`。v1 不加第四个枚举值，这样已有文件不用迁移。界面不再用一个「已核实」覆盖所有情况。【P1-07】[推断]

| 人看到的 | 何时为真 | 证据来源 | 时间 |
|---|---|---|---|
| 提交已核对 | 关联上报的 `reportPassed(check)` 为真，且 `confirmedBy` 不是 `"user"`。开发包因全部任务 git 通过而把需求写成 `verified`、`confirmedBy: null` 时，也是这一行，不是验收。 | `ReportCheck`，daemon 的 git | `check.checkedAt` |
| 测试已通过 | v1 不成立。见下。 | 只能来自 hub 的 `github.checkRuns`，或将来用户选定的规则。不能来自 `report.verified` / `report.ci` | `github.checkedAt` |
| 验收已确认 | `implementation.evidence.confirmedBy === "user"`。只有现有的 `confirmImplementation`（界面按钮）能写成这样。 | 用户在界面上的确认。提交说明仍是「用户确认已实现」 | 该次知识提交的时间 |

- 测试这一行在 v1 固定显示「尚未有测试证据」，旁边可以列出 hub 读到的 check runs。不显示「测试未通过」，除非开放问题 2 选定了失败规则并且实现了它。未选定之前，失败的 conclusion 只作为名单出现，不升格成需求状态。【P1-07】[推断]
- `status === "reported"` 仍表示提交尚未全部在主分支上。文案用「已上报」。不要把它写成验收。
- `status === "mismatch"` 仍表示提交不存在或声称的文件对不上。文案保持「有出入」。
- `confirmedBy === "user"` 时，即使先前的 git 核对是 `mismatch` 或 `not-yet`，界面仍是「验收已确认」，并继续展示那次 git 核对的原结果。用户可以在有出入时仍确认。这是今天 `confirmImplementation` 的行为，v1 不收紧，也不把这次确认说成 git 已通过。【兼容】[推断]
- Agent 的 Room API 仍不能设置 `confirmedBy`。Agent 仍不能在没有 `reportPassed` 上报时把 `status` 写成 `verified`。`implementationRefusal` 的这三条原文保持不变。`verified` 在存储里继续表示「git 核对通过或用户确认」；区分靠 `confirmedBy` 和界面文案，不靠把旧的 `verified` 改名。【P1-07】[推断]
- `prompt.ts` 里关于上报的那三条改为：三项通过时可以把 implementation 设为 `verified` 且不要写 `confirmedBy`，含义只是提交已核对；`report.verified` 不是测试通过，也不是用户验收；不要把上报写成 `stated` / `decided`。系统任务「核实通过：把相关需求的 implementation 更新为 verified」改为说明这是提交已核对，不是验收。
- `applyReportToWorkPackage` 对已完成上报仍先按今天的 git 核对更新任务的 `verified` / `reported` / `mismatch`。开放问题 2 若选 B 或 C，只在这个结果之上追加 CI 条件。全部任务为存储值 `verified` 时，仍可把需求写成 `verified`、`confirmedBy: null`，但写入的 `note` 改为提交已核对，禁止「已核实」「验收」。进行中上报不调用这个函数，不推进任务状态。【P1-07】[推断]
- 用户按钮 `POST .../implementation/confirm` 的资格不变：只有 `reported` 或 `mismatch`。它是验收路径。它不读取 check runs，不因为 CI 红了而拒绝。

### 和 CX-03、用户 basis 的边界

- 对照用的形状是：声称（上报 JSON）和确认（用户动作）分开存放，确认带时间和出处，Agent 写不了确认。`evidence_events` 已经是知识条目上的这种确认。上报的 hub 观察用同一原则，放在 `messages.meta` 的另外两块，不放进 `evidence_events`。
- 原因：`evidence_events.actor` 今天只能是 user；kind 只覆盖 basis 提升、快照确认和条目确认。把 check run 写进去会把外部观察伪装成用户确认。CX-03 的 spec 也写了这张表不记录对外部系统的写入。
- 因此本文明确：到 `f83b6d2` 为止，CI / PR 证据没有接到 `sourceRefs` 或 `evidence_events`。v1 实施之后仍然没有这条接线。
- 整理上报的房间任务若写知识，仍走 #28 / #30 和 CX-03 的锁内检查。上报正文、`blockers`、check run 名称都不是用户原话，不能作为 `stated` / `decided` 的证据。【#28】[推断]

## 留给实现者

- daemon 上是扩展 `report.check` 的返回值，还是另加一个 RPC。模型不能是这个调用的发起者。组织任务开始时，meta 里已经有这次的 `check`（或 `checkSkipped`）、`authors`，以及按开放问题 3 该有的 `github`。
- check runs 的页大小。必须在没读完时把 `truncated` 设为 true。
- 「尚未有测试证据」「agent 声称已验证」「未认证的身份」的英文和日文措辞。中文用本文的句子。三份 `messages` 一起改。
- 作者姓名的展示顺序（author 在前或 committer 在前），只要两行都在，且没有允许 / 拒绝字样。
- 找不到的条目 id 用现有的安静样式，不必新做一种错误色。

不留给实现者的：`progress` 的默认值、`commits` 只在已完成时至少 1 个、声称与核对分块、作者不参与判定、`evidence_events` 不写入 CI、`confirmedBy === "user"` 才是验收、v1 不宣布测试通过、进行中上报不推进开发包任务、旧上报缺少新键仍能读。

## 验收标准

实现计划逐条对照。开放问题里的选项不在这些标准里猜；计划必须先写下用户选了哪一项。

1. `f83b6d2` 上能通过 `ReportInput` 的 JSON，在新解析下仍通过，`progress` 为 `completed`，行为与今天的 git 核对相同。缺少新键的已存 `messages.meta` 仍能显示三项 git 核对。
2. `progress: "in_progress"` 且 `commits: []` 返回 202 并留下声称。它不出现 `reportPassed`，不改变开发包任务状态。`progress` 省略或为 `completed` 且 `commits` 为空，仍是 400。
3. 同一条上报的界面上，声称块含 agent 标签（并说明未认证）、`verified` / `notVerified` / `ci` / `blockers`（若有）。核实块含三项 git 结果、作者与 committer、GitHub 观察。改核实块不会改声称块里的 `headSha` 或 `ci`。
4. 作者块不影响 `reportPassed`、开发包任务状态和 `implementationRefusal`。界面句子里没有允许或禁止。
5. 需求 `verified` 且 `confirmedBy` 为 null 时，三语界面都是提交已核对，不是验收。`confirmedBy` 为 `"user"` 时才是验收已确认。没有用户选定的测试规则时，不出现「测试已通过」。
6. Agent 用 Room API 把 `confirmedBy` 写成 `"user"` 仍被拒绝。没有 `reportPassed` 上报时把 `status` 写成 `verified` 仍被拒绝。用一条上报去写 `stated` / `decided` 且不引用当前用户消息，仍是 409 `user_basis_evidence`。
7. 系统任务和开发包自动写下的 note 不再把 git 通过称为验收或「已核实」。
8. `evidence_events` 的行数不因上报或 GitHub 读取而增加。`sourceRefs` 的校验与 `f83b6d2` 相同。
9. 文档：`docs/reference.zh-CN.md` 写上新字段、两份记录、三个状态各自的证据来源，以及 CI 尚未接入 `evidence_events`。README 不把 v1 写成已经会派发 agent 或已经判定测试通过。这些文档在实现该行为的提交里改，不在本设计提交里改。
10. 本设计不标记 ROADMAP P1-07 为完成。P1-07 的「测试已通过」要等开放问题 2 有选择并实现之后，才有资格谈完成。

## 开放问题（留给用户）

下面每一项本 spec 都不选。实现计划在用户选定之前不写。选项只说明后果，不是推荐。

### 1. 进行中上报留哪些

- **A.** 每一条进行中上报都是一条新的 `report` 消息，和已完成上报一样保留历史。每条都可以带自己的 `authors` / `github`。
- **B.** 同样每条都保留，但是进行中上报不排队整理知识的房间任务。已完成上报仍排队，与今天相同。
- **C.** 同一个仓库、同一 `branch`、同一个 `agent` 字符串只保留最新一条进行中上报，后一条覆盖前一条的 meta。更早的声称不再留下。

A 和 B 保留「当时怎么说的」。C 少占对话，但覆盖之后看不到上一次声称。C 和 #45 要保留证据来源是冲突的；仍然列在这里，由用户选。

### 2. CI 失败是否挡住 `reported`

这里的 `reported` 是需求或开发包任务上的现有状态（提交还没全部到主分支，或已上报），不是「测试已通过」。

- **A.** 不挡。git 核对照旧决定 `reported` / `verified` / `mismatch`。check run 只出现在核实块里。
- **B.** 任一 check run 的 conclusion 为失败，就把本会写成 `reported` 或存储值 `verified` 的任务改成 `mismatch`。
- **C.** 只有名字被用户另行列出的检查失败时才改成 `mismatch`。名单本身不是本问题的一部分；选 C 还要再给名单，否则计划仍不能写。

无论 A/B/C，失败或缺失都不得显示成「测试已通过」或「验收已确认」。选 B 或 C 之前，v1 的界面保持「尚未有测试证据」，即使名单里已经有失败项。

### 3. GitHub 读取的前提

凭证只考虑本机已经存在的 `gh` 登录和 workspace 的 GitHub 插件开关。不新做一套 token。

- **A.** 仅当该 workspace 的 GitHub 插件已启用，且 daemon 上的 `gh` 已登录，且路由到的仓库恰有一个绑定的 `github.com` 远程时，才对带 `pr` 的上报去读。否则 `github.state = "unavailable"` 或 `not_requested`（没有 `pr` 时），上报照收。
- **B.** 带 `pr` 的上报在插件未开或 `gh` 未登录时直接 400，不保存声称。
- **C.** 忽略插件开关，只要 `gh` 已登录且远程唯一就去读。插件开关今天管的是模型能不能调用 `github__`。

多个 `github.com` 远程，或一个都没有：三种选项下都不要猜远程。观察为 `unavailable`，原因写明远程不唯一或不存在。这是范围，不是第 3 项的第四个选项。

### 4. 测试「通过」将来认什么

v1 不实现通过。本题只记录下一份 spec 要回答的规则，避免计划里偷偷定下来。

- **A.** 永远不从 check run 自动得出「测试已通过」。只有用户在界面上另作确认（那将是另一份 spec，不是 v1）。
- **B.** 所有已读到的 check run conclusion 都成功，且 `truncated` 为 false，才可以在将来标成测试已通过。
- **C.** 只统计用户点名的检查。未点名之前保持「尚未有测试证据」。

Agent 的 `verified` 数组在 A/B/C 下都不是这个状态的来源。
