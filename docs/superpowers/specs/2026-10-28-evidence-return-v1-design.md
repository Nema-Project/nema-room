# 证据回流 v1：结构化上报与核实分离

日期：2026-10-28。Issue：[Nema-Project/nema-room#32](https://github.com/Nema-Project/nema-room/issues/32) 的拆分第 1 项（差距表第 4、5 行）。与 [ROADMAP](../../../ROADMAP.md) P1-07 一起设计。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。

**状态**：设计。本文件不是 plan，不改生产代码，不改测试，不改 ROADMAP 的状态。P1-07 仍是待办。本文件不改变 P0 的顺序。

**修订**：2026-10-28，维护者在 [PR #59](https://github.com/Nema-Project/nema-room/pull/59) 选定了原先的四个问题（见「维护者的决定」）。同一次复审要求写明的验收不变量、观察绑定和需求级范围，写在「已定的做法」里。

**设计所对照的 HEAD**：`f83b6d2f3ea8f8f4c2e7f1283ffdd1539c6b980b`（`origin/main`，Merge pull request #57）。下面标为「已核对」的行为是在这个 SHA 上读代码得到的，不是推断。

知识库里没有本设计对应的 R/D 条目。`## 已定的做法` 里的条款都标 `[推断]`：标的是「不是从已有条目抄来的」。来源标记写的是 issue、路线图、PR #59 里维护者的选择，或本任务已经写明的范围。

本次读过的代码，都在这个 SHA 上：

- `packages/shared/src/report.ts`：`ReportInput` 只有 `agent`（1–40 字符）、`gitCommonDir`、`summary`、`entries`、`commits`（至少 1 个）、`files`、可选 `task`。`ReportCheck` 是提交存在、`onMain`（含 patch-id）、声称的文件确实被改过。`reportPassed` 为这三项都过。`ReportMessageMeta` 是 `{ report, check, checkError? }`。`Implementation.status` 只有 `reported | verified | mismatch`。`evidence.confirmedBy` 只能是 `"user"` 或空。
- `apps/cli/src/report/SKILL.md`：做完并提交后再报一次。不报未完成的工作。
- `apps/cli/src/report/commands.ts`：省略 `--agent` 时写入 `coding-agent`。令牌是本机 `~/.nema/report-token`，一把给所有本机 agent 用。
- `apps/hub/src/reports.ts`：`routeRepo` 按 `gitCommonDir` 找到未归档 workspace。`receiveReport` 先存 `report` 消息，再让 daemon 跑 `report.check`，然后 `queueReportTask`。`recheckReports` 重跑近 30 天 `onMain: "not-yet"` 的上报；通过时调用 `applyReportToWorkPackage`，并 `queueSystemTask`，原文要求把需求的 implementation 更新为 `verified`。已核对：重跑时 `setReportMeta` 写入的对象只有 `report` 和 `check`。
- `apps/hub/src/messages.ts`：`setReportMeta` 用整段 JSON 替换 `messages.meta`。已核对：它不按键合并。
- `apps/hub/src/roomApi.ts`：`implementationRefusal`。Agent 把 `status` 写成 `verified` 时，必须指向本 workspace 一条 `reportPassed` 的上报，且引用的提交都在那条上报里。传入对象的 `confirmedBy` 非空即拒绝。已核对：这个函数不读磁盘上旧的 `confirmedBy`。`KnowledgeStore.upsert` 在请求带了 `implementation` 时用整份替换旧值（`store.ts` 保留旧值只发生在请求省略该字段时）。因此 Agent 可以交一份 `confirmedBy: null` 的新 implementation，把用户已经写下的 `"user"` 盖掉。`assertCurrentTaskUserEvidence`（#28 / #30）要求用户 basis 引用当前任务的 user 消息。`report` 角色不是 user。
- `apps/hub/src/workpackages.ts`：`applyReportToWorkPackage` 按 git 核对改任务状态。已核对：任务已经是 `verified` 时直接返回，不降级，也不看 `confirmedBy`。`saveProgress` 在开发包第一次变成 `done`（每个任务的 `status` 都是 `verified`）时，把相关需求写成 `verified`、`confirmedBy: null`、note「开发包全部任务已核实」。已核对：需求若已经是 `verified` 则跳过，所以不会改写一份已经是 `verified` 的需求；它不区分任务的 `verified` 来自 git 还是 `confirmWorkPackageTask`。`confirmWorkPackageTask` 只接受任务 `reported` 或 `mismatch`，然后写成 `verified` 且 `confirmedBy: "user"`。
- `packages/knowledge/src/store.ts`：`confirmImplementation` 只接受需求 `reported` 或 `mismatch`，写成 `verified` 且 `confirmedBy: "user"`。已核对。
- `apps/hub/src/uiApi.ts`：`POST .../implementation/confirm` 在状态不是 `reported` 或 `mismatch` 时 409，原文「只能确认已上报或有出入的实现」。已核对。
- `apps/web/components/EntryDetail.tsx`：确认按钮只在 `reported` 或 `mismatch` 时渲染。已核对。`WorkPackageDetail.tsx` 的任务确认按钮同样只在这两个状态出现。已核对。
- `apps/web/messages/zh.json`：`impl.verified` 是「已核实」。用户确认和 git 通过都落到这一个词。
- `apps/cli/src/github/gh.ts` 与 `packages/shared/src/plugins.ts`：`github__pull_request_read` 的 `get` / `get_check_runs` 用本机 `gh` 读 PR head SHA 和该 SHA 的 check runs。GitHub 插件的 `dataFlow` 是 `external`。
- `apps/hub/src/plugins.ts`：没有 `workspace_plugins` 行时，`enabled` 取 `dataFlow === "local"`。已核对：GitHub 插件因此默认不是启用。
- `apps/hub/src/db/migrations/005_repos_plugins.sql`：每个绑定仓库一行 `remote_url`。已核对：这一列存不了两个远程。
- `apps/hub/src/githubScope.ts`：`githubTarget` 只认 `github.com`。
- `apps/hub/src/evidenceEvents.ts`：`actor` 固定写 `'user'`。kind 只有 `promote_basis`、`confirm_revision`、`confirm_entry`。
- `packages/shared/src/entry.ts`：`WpTask` 已有 `confirmedBy: "user" | null`、`inferred`、`reportMessageId`。
- 上报路径没有调用 GitHub 插件。`ReportCheck` 没有作者字段。

## 意图

#32 要留下的不是编排，而是执行证据回到讨论，并能和已定的需求、决策对照。今天做不到的那一步是：coding agent 的原话，和 hub 自己核对到的 git / PR / CI，写在同一条上报里，读的人分不出哪一句是声称、哪一句是核对。`verified` 这个词同时表示「提交已在主分支上对得上」和「用户确认做完了」。P1-07 要求把这两件事拆开，并且不把 Git 证据说成测试通过或验收通过。

#45 的判断标准是：这是否让人和 agent 更容易对项目保持有证据支撑的共同理解。本设计服务于这件事，方式是：

- 讨论里同时留着两份记录。一份是 agent 声称的分支、PR、head、它说自己验证了什么、没验证什么、阻塞。一份是 hub 用本机 git 和已有只读 GitHub 路径读到的结果。两份都带时间。后一份不覆盖前一份。
- 需求上的「提交已核对」和「验收已确认」用不同的证据来源。人回看时可以指出分歧从声称开始，还是从核对结果开始，而不是只看见一个「已核实」。
- 用户已经确认过的验收不会被后来的上报、重跑或开发包rollup 悄悄擦掉。核对变了就留着确认，并在这一条需求上做复审标记。
- Agent 的名字、提交作者、check run 都作为证据显示。hub 不据此决定谁有权改仓库，也不把这些记录写成用户的陈述或决定。

做不到这个区分的实现，即使字段都加上了，也不符合本设计。

## 目标

- 旧的 `nema report` JSON 仍能通过解析。没有新字段的上报仍是「已完成」上报，`commits` 仍至少 1 个。
- 已完成上报可以多带可选的声称字段。另有一种「进行中」上报，可以没有提交。每一条进行中上报都留下。它们不排队整理知识。
- 一条上报里，agent 送来的 JSON 原样保留。hub 的 git 核对、提交作者、GitHub 读取结果分开放，各有自己的时间和绑定对象。更新一块不得抹掉另一块。
- 界面把「agent 声称」和「hub 核实」分成两块。CI 失败出现在核实块里，并且醒目，但不改 git 推出的 `reported` / `verified` / `mismatch`。
- 提交的 author 和 committer 出现在核实块旁边，只作为证据。
- 上报通过已有的 `entries` 指向它声称相关的需求或决策。链接不是「这条已经实现了」。需求上的 `verified` 且 `confirmedBy` 为空，只表示所引提交通过了三项 git 核对。
- `verified` 且 `confirmedBy` 为空的需求，用户能把它确认为验收。已经是 `"user"` 的确认不会被自动路径清掉。
- Agent 仍不能伪造用户 basis，不能自己写入 `confirmedBy`。

## 非目标

- 派发 coding agent、自动开 PR、自动合并。#32 拆分第 7 项。主 spec 和开发包 spec 的非目标保持原样。
- 进度看板、按 agent 或 PR 的生命周期状态。#32 拆分第 5 项里的看板部分。
- 跨 agent 的文件或分支冲突检测，以及项目级的实现漂移检测。`repo_hooks` 仍只写不读。单条需求上的复审标记不是漂移检测，也不声称能重建「第一次偏离」的时间。
- 系统通知、桌面 `Notification`、把待决定事项推到其他设备。#32 拆分第 6 项。
- 执行层决定卡片（合并 / 再改 / 放弃，或「是否超出已定范围」）。#32 拆分第 2 项。复审标记不是这种卡片。
- 提交作者的允许名单、禁止账号、据此拒绝上报或拒绝合入。
- 按 agent 可吊销的上报令牌，以及不依赖本机 `gitCommonDir` 的远程 / 云端接入。#32 拆分第 3、4 项。第 3 项仍排在第 4 项之前。
- 把 CI / PR 观察写进 `evidence_events`，或在 v1 把 `sourceRefs` 接到 check run。不新建事件表。
- 新的外部服务连接器、第二套 GitHub 凭证、把本机 hub 暴露到本机以外。
- 在 v1 宣布「测试已通过」。将来的判定规则已经写在下面，v1 只展示读取结果并写明没有得出该结论。
- 持续轮询 GitHub。只在收下带 `pr` 的上报时读，以及在该条上报被重跑 git 核对时按同一规则再读一次。

## 反目标

做到了也算失败：

1. 用 agent 上报里的 `verified`、`ci`、`summary` 或 `blockers`，把需求写成验收已确认，或把测试显示成已通过。
2. `reportPassed` 为真时，界面或系统任务把这叫做验收通过、需求完成，或「已核实」而不说明这只是所引提交的 git 核对。
3. 读不到 PR 或 check run 时，把测试或 head 显示成通过。没请求、失败、超时都不是通过。读取失败后仍把上一次成功的观察显示成当前结果。
4. HEAD 已经变了，界面仍把旧 head 的 check run 显示成当前 PR 的结果。
5. 根据作者或 committer 接受、拒绝、隐藏上报，或显示「该账号被允许 / 被禁止」。
6. 把 GitHub 观察或作者信息写入 `evidence_events`，或把它们当作 `stated` / `decided` 的用户消息。
7. 旧上报因为缺少新字段而 400。已完成上报因为 `commits` 为空而通过解析。GitHub 读不到时把格式正确的声称丢掉。
8. 把 `agent` 字符串显示成已登录的身份，或用它去对 GitHub 用户。
9. 自动路径把 `confirmedBy: "user"` 写成 null，或在用户已确认时改掉 `status`。
10. 开发包里只有用户确认、没有 `reportPassed` 的任务，使需求界面显示「提交已核对」。
11. CI 失败被写成 git 的 `mismatch`。
12. 进行中上报排队整理任务，或在重跑后因为提交到了主分支而 `applyReportToWorkPackage` / `queueSystemTask`。
13. 更新 `check` 时把已存的 `authors` 或 `github` 抹掉。
14. 为了本设计去派发 agent、做冲突合并、发通知、增加执行层决定条目，或新建事件数据库。

## 约束

- 代码和注释用英文。hub 新的拒绝文案和界面新句子用中文，并同时改 `apps/web/messages` 的 en、zh、ja。英文和日文必须保住「提交核对 ≠ 测试通过 ≠ 验收」这三层，不能译成同一个「已核实」。
- 不新增依赖。GitHub 读取复用 `apps/cli/src/github/gh.ts` 已有的只读 PR head 与 check-runs 请求，以及 `githubTarget` 的仓库范围。不新增 hub 上的 GitHub token 文件。
- 知识 Git 仍是条目正文的权威。已有 frontmatter 字段名不改。`Implementation.status` 的三个值保持 `reported | verified | mismatch`。可以增加可选的 `acceptanceReview`；旧文件没有这个键时读成 null。
- 上报的声称和 hub 的观察放在 `messages.meta` 里。不新表，因此不新迁移。旧 meta 缺新键时按「没有这份观察」读。
- `evidence_events` 的形状只作对照：用户确认是另一份记录，`actor` 固定为 user，Agent 不能制造或消费。v1 不往这张表插入行。
- #28 / #30 的用户 basis 检查、失效状态改回 `active` 的检查、CX-03 的外部引用检查，都不得放宽。`report` 消息仍不是 user 消息。
- 一个数据目录同时只跑一个 hub。核对仍走 daemon 的 git。GitHub 读取在 daemon 上用已经存在的 `gh`。
- 本机上报令牌仍是一把共享的 `~/.nema/report-token`。v1 不把它拆成 per-agent 令牌。
- 实施时再对一次当时的 HEAD。若 `ReportInput`、`setReportMeta` 或 `confirmImplementation` 已和本文不同，先改本文再写 plan。

## 已定的做法

### 维护者在 PR #59 选定的四项

2026-10-28，维护者在 PR #59 选定。计划按这里写，不再从旧选项里另选。

- **问题 1 = B。** 每一条进行中上报都是一条新的 `report` 消息，历史保留。进行中上报不排队整理知识的房间任务。已完成上报在核对落盘后仍排队，与今天相同。【PR #59】[推断]
- **问题 2 = A。** CI 失败不改变 git 推出的 `reported` / `verified` / `mismatch`。check run 只出现在核实块里，失败必须醒目。不把 CI 失败写成 `mismatch`。【PR #59】[推断]
- **问题 3 = A。** 仅当该 workspace 的 GitHub 插件已启用、daemon 上的 `gh` 已登录、且这条上报所路由到的仓库恰有一个 `github.com` 远程时，才对带 `pr` 的上报去读。否则 `github.state` 为 `unavailable`；没有 `pr` 时为 `not_requested`。上报照收。【PR #59】[推断]
- **问题 4 = C。** 将来「测试已通过」只统计用户点名的必需检查，并且观察必须绑在同一个 head、结果完整、`truncated !== true`。缺失、skipped、pending 的处理见下文。v1 不实现这个结论，也不显示「测试已通过」。【PR #59】[推断]

### 上报怎么兼容

- 新字段都是可选的。省略时，解析结果与 `f83b6d2` 上的 `ReportInput` 相同，并视为已完成上报。【#32 拆分 1】[推断]
- 增加 `progress`：`"completed"` 或 `"in_progress"`。省略时是 `"completed"`。旧客户端不送这个字段。【#32 拆分 1】[推断]
- `commits` 的「至少 1 个」只约束 `progress === "completed"`。进行中上报的 `commits` 可以是空数组，省略则当成空数组，最多仍是 50 个，每个仍是 7–40 位十六进制。已完成上报沿用今天的至少 1 个、最多 50 个。【#32 拆分 1】[推断]
- 超长、类型不对、提交不是十六进制，仍是今天的 400「上报内容不完整或格式不对」。未知键由 zod 丢掉，不因为多了键而 400。【#32 拆分 1】[推断]
- 进行中上报：保存消息，可以跑下面的 git / 作者 / GitHub 观察并写入 meta。不调用 `queueReportTask`。不调用 `applyReportToWorkPackage`。`recheckReports` 可以按合并规则更新这条消息自己的 `check` / `authors` / `github`，但即使 `onMain` 后来变成 `"yes"`，也不 `applyReportToWorkPackage`，也不 `queueSystemTask`。`progress` 保持 `in_progress`，直到另一条 `completed` 上报到来。已核对：今天的 `receiveReport` 对每条上报都 `queueReportTask`，`recheckReports` 在 `reportPassed` 时既套用开发包又排队系统任务；v1 对进行中上报关掉这两条。【PR #59】[推断]

### Agent 声称的字段

这些字段只表示 agent 说了什么。hub 不改正文，不把它们抄进 `Implementation`。

- `agent`：1–40 字符的自由文本，默认仍是 `coding-agent`。它是未认证标签。服务端不把它映射到 GitHub 用户、本机账号或令牌。界面在这个字符串旁边写明：这是上报里的名字，不是已认证的身份。它不是稳定身份。一条上报的稳定 id 是这条 `messages.id`。v1 不另造 `reportId`。【本任务已定】[推断]
- `branch`：可选字符串，1–200 字符，不含换行。v1 不拿它和 git 分支表对照，也不用它合并进行中上报。
- `pr`：可选正整数，表示这条上报所路由到的那个仓库上的 PR 号。仓库由现有的 `gitCommonDir` 决定。
- `headSha`：可选，40 位小写十六进制。这是 agent 声称的 head，不是 `ReportCheck.mainSha`，也不是 hub 读到的 PR head。
- `ci`：可选数组，最多 30 项。每项是 agent 自己的描述：`name`（1–200）、可选 `conclusion`（1–40）、可选 `url`（1–500）。这不是 hub 读到的 check run。
- `verified`、`notVerified`：可选字符串数组，各最多 30 项，每项 1–200 字符。含义是「agent 声称已验证 / 尚未验证」。界面必须写成「agent 声称已验证」，禁止写成「已核实」或「测试已通过」。【P1-07】[推断]
- `blockers`：可选字符串数组，最多 20 项，每项 1–500 字符。只展示。不自动建 `question`，不写成用户决定。【#28】[推断]
- `entries` 保持今天的 id 语法（`R D T Q S G W`）。它是关联声称。id 在本 workspace 不存在时，上报仍然收下，界面把该 id 标成找不到，不创建条目。存在的需求或决策显示标题，并链到条目。链到决策不修改该决策的 basis、状态或正文。开发包任务的关联仍是：`entries` 里恰有一个 `W-n`，且 `task` 指向该包里的任务号；命中时写入该任务已有的 `reportMessageId`（消息 id）。`agent` 与 `branch` 不参与这个关联。【#32 拆分 1】[推断]
- `summary`、`files`、`task`、`gitCommonDir` 的规则不变。技能文本改为：已完成的工作仍在提交之后上报；进行中可以上报，并且必须把 `progress` 设为 `in_progress`。新字段里同样禁止秘密、令牌和密钥。

### 两份记录怎么放，以及怎么更新

`messages.meta` 扩展为：

- `report`：解析后的 `ReportInput`，即声称。收到之后不改写。
- `check` / `checkError` / `checkSkipped`：git 核对。`reportPassed` 的定义不变。
- `checkHistory`：被替换掉的 git 核对摘要，见「重跑留下什么」。
- `authors`：hub 从本机 git 读到的作者证据。
- `github`：`{ current, history }`。`current` 是当前一次观察，`history` 是被换下的观察。

各块彼此独立。`check` 不改写 `report`。`github` 不改写 `report.ci`。旧消息没有 `authors` 和 `github` 时，界面显示「这条上报没有这份 hub 记录」，不回填，也不当成通过。【#45】[推断]

时间：声称用消息的 `created_at`；`check.checkedAt` 保持今天的字段；`authors.checkedAt` 是读完作者的时间；GitHub 观察用 `observedAt`，表示这一次读取结束的时间。来源写死：作者块 `source: "git"`；GitHub 块 `source: "github-plugin-read"`。这表示走了与 `github__pull_request_read` 相同的只读请求，不是采信模型的转述。模型后来用 `github__` 再读一次，不写回这些块。【#32 拆分 1】[推断]

进行中且 `commits` 为空：不调用 `report.check`，`check` 为 null，不设 `checkError`。另记 `checkSkipped: "in_progress_no_commits"`。这不是失败，也不是 `reportPassed`。进行中但带了提交：对那些提交跑和今天相同的 git 核对，结果只留在这条消息上。已完成上报始终跑 git 核对。【#32 拆分 1】[推断]

已核对：`setReportMeta` 把整段 meta 换成调用方给的对象；`recheckReports` 传入的对象只有 `report` 和 `check`。v1 禁止这种整段覆盖。每一次写入先读到该行最新的 meta（同一条语句里合并，或先锁行再写），只替换自己负责的键：

- git 重跑只替换 `check`、`checkError`、`checkSkipped`，并追加 `checkHistory`。
- 作者重读只替换 `authors`。
- GitHub 重读只替换 `github`。
- 没有产生新 `github` 的写入，不得去掉最新行上已有的 `github`。`authors`、`check`、`report` 同理。

两个写入同时发生时，各自打在已经提交的最新行上，而不是打在自己先前读到的整份副本上。【PR #59 复审】[推断]

`recheckReports` 仍只挑选近 30 天、`onMain` 仍是 `"not-yet"` 的上报。缺 `progress` 的旧上报视为已完成。对已完成上报，重跑后若 `reportPassed`，仍可 `applyReportToWorkPackage`（须遵守下面的验收不变量）并排队系统任务。系统任务的句子改为：提交已核对，不是验收；不要改写 `confirmedBy` 已是 `"user"` 的 implementation。对进行中上报，重跑只合并观察，不套用开发包，不排队系统任务。【PR #59】[推断]

### 重跑留下什么

v1 在同一条 `report` 消息上保存被替换的核对，不新建表。

- 替换 `check` 之前，把上一份的 `onMain`、`commitsExist`、`filesOk`、`checkedAt`、`mainSha` 追加到 `checkHistory`。这样能看到这一条上报何时从「尚未合入」变成通过或失败。
- 这不是项目时间线，也不是 #45 里的「第一次不兼容实现」的时间。不得在界面或文档里写成可以重建那个时间。
- v1 不截断 `checkHistory`。若以后的计划要截断，界面必须写明更早的 git 结果已丢，不能从这条消息重建第一次变化的时间。

### 作者只作证据

- 对 `check` 已经解析到的每个完整 SHA，用本机 git 读取 author 的 name 与 email、committer 的 name 与 email。读不到的提交不编造身份，该 SHA 记入缺失列表。
- 界面把这份名单放在 git 核对结果旁边。固定说明：这是提交元数据，不是允许或拒绝。
- 不把 email 打进 hub 的错误日志。
- 名单不参与 `reportPassed`，不参与 `implementationRefusal`，不参与开发包任务状态。【本任务已定】[推断]

### GitHub 观察

一次观察绑在一个不可变的版本上。当前结果和历史快照分开。

```ts
type GithubObservation = {
  state: "not_requested" | "unavailable" | "read";
  reasonCode?:
    | "plugin_disabled" | "gh_logged_out" | "gh_unavailable"
    | "remote_missing" | "remote_not_unique" | "out_of_scope"
    | "timeout" | "http_error" | "invalid_response";
  reason?: string;
  observedAt: string;
  source: "github-plugin-read";
  binding: {
    repoId: string;
    owner: string;
    repo: string;
    pr: number;
    observedHeadSha: string | null;
    claimedHeadSha: string | null;
  } | null;
  headMatch: "match" | "mismatch" | "not_comparable" | null;
  checkRuns: { name: string; status: string; conclusion: string | null; url: string | null }[];
  truncated: boolean;
};
```

- 没有 `pr`：`current.state = "not_requested"`，`binding` 为 null，没有 `reasonCode`。这不是失败，也不是通过。
- 有 `pr` 才考虑去读。下面任一为真则不去读，`state = "unavailable"`，并带 `reasonCode`：插件未启用（`plugin_disabled`）、`gh` 未登录（`gh_logged_out`）、`gh` 程序不可用（`gh_unavailable`）、路由到的仓库没有 `github.com` 远程（`remote_missing`）、解析出的 `github.com` 目标多于一个（`remote_not_unique`）。已核对：GitHub 插件 `dataFlow` 为 `external`，没有 `workspace_plugins` 行时 `enabled` 为 false。已核对：`workspace_repos.remote_url` 只有一列。v1 只对这条上报路由到的那个仓库的 `remote_url` 调用 `githubTarget`。结果为 null 就是 `remote_missing`。不改去扫 workspace 里的其他仓库。`remote_not_unique` 留给这一列以后能表示多个目标的情况；今天这一列产生不了两个目标，但计划不得在数不清时猜一个。
- 去读之后超时、HTTP 失败或返回的 head 不是 40 位十六进制：`unavailable`，`reasonCode` 分别为 `timeout`、`http_error`、`invalid_response`。`binding.observedHeadSha` 在还没读到 head 时为 null。`checkRuns` 为空，`headMatch` 为 null。
- 读到了 PR：`state = "read"`。`binding` 写上 `repoId`、owner/repo、`pr`、这次读到的 `observedHeadSha`、声称里的 `claimedHeadSha`（没有则为 null）。`observedHeadSha` 与 `claimedHeadSha` 都是 40 位且逐字符相同才是 `headMatch: "match"`，否则在声称有 head 时为 `mismatch`，声称没有 head 时为 `not_comparable`。不改写 `report.headSha`。check run 记 name、status、conclusion、url。读的是这个 `observedHeadSha` 上的 check runs，不是 agent 的 `ci`。一页没读完则 `truncated: true`，界面说明名单不完整。
- 声称的 PR 不属于这个绑定远程：不跟到别的仓库，`unavailable` / `out_of_scope`。
- 替换 `current` 时，若上一份 `current.state` 不是 `not_requested`，先把上一份原样追加到 `history`。HEAD 变了（新的 `observedHeadSha` 与上一份不同，包括从有 head 变成读失败）时，上一份只作为历史快照显示，标签是历史，不是当前结果。
- 读取失败不得把上一份的 `headMatch`、`checkRuns` 或「通过」抄进新的 `current`。新的 `current` 自己就是 `unavailable`。
- 失败的 conclusion 在核实块里与 git 三项同一层级显示，不放进默认折叠的区域。这不改变 `reported` / `verified` / `mismatch`。【PR #59】[推断]

### 测试这一行怎么说

v1 在任何情况下都不显示「测试已通过」，也不把 check run 写入 `Implementation.status`。

- `current` 是 `read` 且 `checkRuns` 非空：句子是「已读到这些 check run。v1 不据此得出测试已通过。」名单照常列出。禁止使用「尚未有测试证据」。
- `current` 是 `read` 且 `checkRuns` 为空：句子是「这次读取没有 check run。没有测试通过的结论。」
- `not_requested` 或 `unavailable`：句子是「没有这次读取的 check run。没有测试通过的结论。」并显示 `reasonCode`（若有）。历史快照里的成功结论不得填到这句里面充当当前结论。

将来（不是 v1）若要得出「测试已通过」，只允许下面这条规则，并且要另写 spec 才实现。用户点名一组必需检查的名字。观察必须是 `state: "read"`，`truncated !== true`，且 `binding.observedHeadSha` 与拿来作结论的那个 head 是同一个。某一个点名检查算满足，仅当它出现在这份 `checkRuns` 里，`status` 为 `completed`，且 `conclusion` 为 `success`。

- 名单里没有这个名字：不满足。
- `status` 为 pending、queued、in_progress、waiting、requested，或还没有完成：不满足。
- `conclusion` 为 skipped、cancelled、timed_out、failure、neutral、action_required、stale，或为空：不满足。
- `truncated === true`：整份结论不成立，即使看得见的点名检查都是 success。

Agent 的 `verified` / `ci` 不是这条规则的输入。未点名之前，将来的 spec 也不得显示「测试已通过」。【PR #59】[推断]

### P1-07：需求上的三个状态

存储仍用今天的三个 `status` 和一个 `confirmedBy`。v1 不加第四个枚举值。界面不再用一个「已核实」覆盖所有情况。【P1-07】[推断]

| 人看到的 | 何时为真 | 证据来源 | 覆盖范围 |
|---|---|---|---|
| 提交已核对 | `status === "verified"` 且 `confirmedBy` 不是 `"user"`，并且 `evidence` 里的提交都来自 `reportPassed` 的上报。 | 那些上报的 `ReportCheck` | 只这些提交：它们存在、在主分支上（或 patch-id 相同）、上报声称的文件被它们改过。不是需求的全部验收条件，也不是「需求已经实现」。界面在这四个字旁边写上这句范围。 |
| 测试已通过 | v1 不显示。 | 将来只来自上面的点名规则。不能来自 `report.verified` / `report.ci`。 | — |
| 验收已确认 | `confirmedBy === "user"`。 | 用户在界面上的确认。提交说明仍是「用户确认已实现」。 | 用户接受了当时留下的 evidence。不是 git 三项因此变成真。若 git 核对后来变了，仍显示验收已确认，并加上复审标记。 |

- `status === "reported"` 的文案是「已上报」。不要把它写成验收。
- `status === "mismatch"` 只表示提交不存在，或声称的文件没有被这些提交改过。文案保持「有出入」。CI 失败不用这个词。
- 需求 evidence 至少链到一条 `report` 消息（`reportMessageId`）和当时核对过的提交。界面可以点进那条上报的核实块。没有这样一份 `reportPassed` 时，不得显示「提交已核对」。

### 用户验收：不变量和转换

已核对的今天：`confirmImplementation`、`POST .../implementation/confirm` 和需求上的按钮都只接受 `reported` 与 `mismatch`。因此 `verified` 且 `confirmedBy` 为 null 的需求没有验收路径。`confirmWorkPackageTask` 只接受任务的 `reported` 与 `mismatch`；任务上的 `confirmedBy` 只有这条用户路径会写成 `"user"`。`saveProgress` 在开发包变成 `done` 时，若需求还不是 `verified`，就写成 `verified` 且 `confirmedBy: null`，不看任务是 git 通过还是用户确认的。`implementationRefusal` 不阻止 Agent 用一份 `confirmedBy: null` 的新对象盖掉磁盘上的 `"user"`。

v1 改成下面这样。

用户可以确认需求，当且仅当存在 implementation，且要么状态是 `reported` 或 `mismatch`，要么状态是 `verified` 且 `confirmedBy` 为 null。确认之后：`status` 为 `verified`，`confirmedBy` 为 `"user"`，原来的 `reportMessageId`、`commits`、`note`、`inferred` 保留，`acceptanceReview` 为 null。按钮和 409 文案与此一致。`verified` 且 `confirmedBy` 已是 `"user"` 时，平常没有这颗按钮；只有 `acceptanceReview.needed` 为真时，同一颗按钮表示「仍确认」：清掉 `acceptanceReview`，不改 `confirmedBy`，不改 `status`，不把 git 核对改成通过。

`acceptanceReview` 是 implementation.evidence 上的可选对象：`null`，或 `{ needed: true, at: string, reason: "linked_check_changed" }`。旧文件没有这个键，读成 null。它只挂在这一条需求上。它不是新表，不是通知，不是执行层决定卡片，也不是项目级漂移检测。

自动路径（`applyReportToWorkPackage`、`recheckReports`、`saveProgress`、房间 Agent 的 upsert、系统任务）禁止：

- 把 `confirmedBy` 从 `"user"` 改成 null 或其他值。
- 在 `confirmedBy` 为 `"user"` 时修改 `status`。
- 在 `confirmedBy` 为 `"user"` 时改写 `reportMessageId`、`commits`、`note`。
- 清掉 hub 已经写下的 `acceptanceReview.needed`。只有上面的用户「仍确认」可以清。

已核对：任务 `status === "verified"` 时，今天的 `applyReportToWorkPackage` 会直接返回。v1 保持「不把已是 `verified` 的任务降级」，并且同样不改该任务的 `confirmedBy`。

当 `confirmedBy` 为 `"user"`，且 `evidence.reportMessageId` 指向的那条上报的 `check` 被替换，并且新的 `reportPassed` 与确认时不同，或新的通过提交集合与 `evidence.commits` 对不上：保持 `confirmedBy` 和 `status`，把 `acceptanceReview` 设为 `needed`，`at` 用这次替换的时间。对不上的比较与今天的 `sameCommit` 相同（允许短 SHA）。无关的上报不设这个标记。

房间 API：若磁盘上的 implementation 已是 `confirmedBy: "user"`，请求里再带 `implementation` 即 409，除非这份对象与磁盘上的 status、confirmedBy、reportMessageId、commits、note、acceptanceReview 完全相同。省略 `implementation` 字段则仍保留旧值（今天 `upsert` 已是这样）。Agent 仍不能把 `confirmedBy` 写成 `"user"`（`CONFIRMED_BY_USER_ONLY` 保持）。Agent 仍不能在没有 `reportPassed` 上报时把 `status` 写成 `verified`。

开发包rollup：

- 一个任务算「有 git 核对」仅当：`status === "verified"`、`confirmedBy !== "user"`、`inferred === false`，且 `reportMessageId` 指向的上报 `reportPassed` 为真。
- 只有每个任务都满足上一句时，`saveProgress` 才可以把还没有用户确认的需求写成 `verified`、`confirmedBy: null`。`evidence.commits` 只收录这些通过核对的上报里的提交。`evidence.reportMessageId` 指向其中一条。`note` 写明这是提交已核对，并写上开发包 id。禁止「已核实」「验收」「全部任务已核实」。
- 若有任一任务的 `verified` 来自 `confirmedBy: "user"` 或 `inferred`，或它的上报没有 `reportPassed`：不把需求写成 `verified`。开发包本身仍可按今天的规则在全部任务 `status === "verified"` 时变成 `done`。包是 `done` 不表示需求已是「提交已核对」。
- 需求已是 `confirmedBy: "user"` 时，`saveProgress` 不替换它的 implementation。若这次rollup所依据的上报就是该需求 `reportMessageId` 指向的那条，且核对已变，只按上面的规则设 `acceptanceReview`。

任务确认按钮的范围不变：仍只给 `reported` 与 `mismatch`。git 已通过的任务（`verified` 且 `confirmedBy` 为 null）不再次用任务按钮确认。需求上的验收走需求的确认按钮，包括这种 `verified` 且 `confirmedBy` 为 null 的需求。

| 起点 | 事件 | 结果 |
|---|---|---|
| 无 implementation | 已完成上报的整理任务把状态写成 `reported` | `reported`，`confirmedBy` null |
| `reported` 或 `mismatch`，或 `verified` 且 `confirmedBy` null | 用户按确认 | `verified`，`confirmedBy` `"user"`，evidence 其余保留，`acceptanceReview` null |
| 需求还不是用户确认 | 每个开发包任务都有 git 核对 | `verified`，`confirmedBy` null，note 为提交已核对 |
| 需求还不是用户确认 | 开发包变成 done，但其中有任务只是用户确认或推断 | 需求 implementation 不变 |
| `verified`，`confirmedBy` `"user"` | 后来的上报、重跑、rollup、Agent upsert | `confirmedBy` 仍是 `"user"`，`status` 仍是 `verified`。所引上报的核对变了则 `acceptanceReview.needed` |
| `verified`，`confirmedBy` `"user"`，且需要复审 | 用户按「仍确认」 | `acceptanceReview` null，确认保留 |
| 进行中上报，或进行中上报的重跑 | 任何 | 不改需求和任务 |

### 和 CX-03、用户 basis 的边界

- 声称和确认分开存放。`evidence_events` 是知识条目上的用户确认。上报的 hub 观察放在 `messages.meta`，不放进 `evidence_events`。
- `evidence_events.actor` 今天只能是 user。把 check run 写进去会把外部观察伪装成用户确认。
- 到 `f83b6d2` 为止，CI / PR 没有接到 `sourceRefs` 或 `evidence_events`。v1 之后仍然没有。
- 以后的 spec 可以让需求用与 `sourceRefs` 同类的引用指向一条上报消息或一份 GitHub 观察（消息 id 或观察的 binding + `observedAt` + 内容哈希）。那不是 v1，也不是新的事件表。v1 不预留列、不写空的 `sourceRefs`。
- 整理上报的房间任务若写知识，仍走 #28 / #30 和 CX-03 的锁内检查。上报正文、`blockers`、check run 名称都不是用户原话。【#28】[推断]

### 房间 prompt

`prompt.ts` 里关于上报的句子改为：三项 git 通过时可以把还没有用户确认的需求 implementation 设为 `verified`，且不要写 `confirmedBy`，含义只是所引提交已核对；`report.verified` 不是测试通过，也不是用户验收；不要改写 `confirmedBy` 已是 `"user"` 的条目；不要把上报写成 `stated` / `decided`。服务端拒绝仍是上面的 409，prompt 不是那道闸。

## 留给实现者

- daemon 上是扩展 `report.check` 的返回值，还是另加一个 RPC。模型不能是这个调用的发起者。已完成上报的整理任务开始时，meta 里已经有这次的 `check`（或 `checkSkipped`）和 `authors`；若按问题 3 去读了 GitHub，`github.current` 也已写上。进行中上报没有整理任务。
- 合并 meta 用一条 SQL 还是行锁后写回。不变量是「只换自己的键，以最新行为准」。
- check runs 的页大小。没读完必须 `truncated: true`。
- 英文和日文措辞。中文用本文的句子。三份 `messages` 一起改。失败的 check run 用与 git「有出入」同一层级的样式，不新发明一套颜色体系也可以，只要不是脚注。
- 作者姓名的展示顺序，只要 author 和 committer 都在，且没有允许 / 拒绝字样。
- 找不到的条目 id 用现有的安静样式。

不留给实现者的：问题 1 到 4 的选择、`progress` 的默认值、`commits` 只在已完成时至少 1 个、进行中上报不排队也不套用开发包、重跑进行中上报不排队系统任务、meta 按块合并、观察绑定 `repoId + pr + observedHeadSha + observedAt`、读取失败不沿用旧的通过、CI 不写成 `mismatch`、`confirmedBy: "user"` 不被自动路径清除、`verified` 且 `confirmedBy` null 可以用户确认、没有 git 核对的任务rollup不得让需求显示「提交已核对」、`reasonCode` 的枚举、v1 不宣布测试通过、`evidence_events` 不写入 CI、作者不参与判定。

## 验收标准

1. `f83b6d2` 上能通过 `ReportInput` 的 JSON，在新解析下仍通过，`progress` 为 `completed`，git 核对与今天相同。缺少新键的已存 meta 仍能显示三项 git 核对。
2. `progress: "in_progress"` 且 `commits: []` 返回 202 并留下声称。不出现 `reportPassed`，不排队整理任务，不改变开发包任务。`progress` 省略或为 `completed` 且 `commits` 为空，仍是 400。
3. 进行中上报带的提交后来到了主分支：`recheckReports` 可以更新这条消息的 `check`，但不调用 `applyReportToWorkPackage`，也不 `queueSystemTask`，`progress` 仍是 `in_progress`。
4. 同一条上报的界面上，声称块含未认证的 agent 标签，以及 `verified` / `notVerified` / `ci` / `blockers`（若有）。核实块含三项 git 结果、作者与 committer、GitHub 观察。有失败的 check run 时，失败出现在核实块的主列表里。改核实块不会改声称里的 `headSha` 或 `ci`。
5. 先写入 `github.current`，再重跑 git：重跑之后 `github` 还在。先写入 `authors`，再写 `github`：`authors` 还在。测试要覆盖「用整段 `{ report, check }` 替换」这种今天的写法不再发生。
6. 作者块不影响 `reportPassed`、开发包任务状态和 `implementationRefusal`。界面没有允许或禁止。
7. 插件未启用、`gh` 未登录、或路由仓库的 `remote_url` 不是一个 `github.com` 目标时，带 `pr` 的上报仍是 202，`github.state` 为 `unavailable` 且 `reasonCode` 符合上面的枚举。没有 `pr` 时为 `not_requested`。这些都不是通过。
8. 同一条上报两次读取的 `observedHeadSha` 不同：界面把前一份标成历史，当前一份使用新的 head。第二次读取失败时，当前状态是 `unavailable`，不显示前一份的成功 conclusion 作为当前结果。`binding` 含 `repoId`、`pr`、`observedHeadSha`、`observedAt`。
9. 需求 `verified`、`confirmedBy` null、且 evidence 来自 `reportPassed`：三语界面是「提交已核对」，并写明只覆盖这些提交，不是验收条件已满足。`confirmedBy` 为 `"user"` 时是「验收已确认」。任何情况下 v1 都不出现「测试已通过」。读到了 check run 时，句子承认名单存在，并写明没有得出测试通过的结论；不使用「尚未有测试证据」。
10. `verified` 且 `confirmedBy` null 时，确认按钮可见，`POST .../implementation/confirm` 成功，结果 `confirmedBy` 为 `"user"`，`status` 仍是 `verified`，`commits` 不变。
11. 用户确认之后，后续的已完成上报、`recheckReports` 和 `saveProgress` 都不把 `confirmedBy` 改回 null，也不改 `status`。所引上报的 `reportPassed` 从真变成假时，`acceptanceReview.needed` 为真，确认仍在。Agent 再 POST 一份 `confirmedBy: null` 的 implementation，得到 409，文件不变。
12. 开发包的最后一个任务是由 `confirmWorkPackageTask` 写成 `verified` 且 `confirmedBy: "user"`、其上报并未 `reportPassed`：包可以变成 `done`，需求不会变成 `verified`，界面不显示「提交已核对」。全部任务都有 `reportPassed` 时，需求写成 `verified`、`confirmedBy` null，note 含「提交已核对」，不含「已核实」或「验收」。
13. 一条失败的 check run 不改变该任务或需求的 `reported` / `verified` / `mismatch`。`mismatch` 仍只来自 git。
14. Agent 不能把 `confirmedBy` 写成 `"user"`。没有 `reportPassed` 时不能把 `status` 写成 `verified`。用上报去写 `stated` / `decided` 且不引用当前用户消息，仍是 409 `user_basis_evidence`。
15. `evidence_events` 的行数不因上报或 GitHub 读取而增加。`sourceRefs` 的校验与 `f83b6d2` 相同。
16. `docs/reference.zh-CN.md` 写上新字段、两份记录、三个状态的证据来源、`reasonCode`、验收不会被自动清除，以及 CI 尚未接入 `evidence_events`。README 不把 v1 写成已经会派发 agent、已经判定测试通过，或已经做了漂移检测。这些文档在实现该行为的提交里改，不在本设计提交里改。
17. 本设计不标记 ROADMAP P1-07 为完成。「测试已通过」的实现不属于 v1。

## v1 明确不做、留给以后的

- 按 agent 吊销的令牌，以及用它做远程接入。进行中上报的稳定身份是消息 id，不是 `agent` 字符串。
- 从 check run 自动得出「测试已通过」。规则已写死在上面，避免以后改成「所有 check 都绿就算」。
- 把 GitHub 观察接进 `sourceRefs`。方向已写在 CX-03 那一节，v1 不预留存储。
- 用 `checkHistory` 或 `github.history` 回答「需求第一次和实现偏离是什么时候」。那两份历史只描述这一条上报自己的观察被替换过。
