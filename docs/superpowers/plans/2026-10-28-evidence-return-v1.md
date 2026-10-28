# 证据回流 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同一条 `report` 消息上并排留下 agent 声称和 hub 自己读到的 git / 作者 / GitHub 观察，并让「提交已核对」「验收已确认」用不同证据来源。v1 不宣布测试通过，不把 Git 证据写成验收。

**Architecture:** 声称留在 `messages.meta.report`，收到后不改写。git 核对、作者、GitHub 观察各是独立的键。写入用行锁读到最新行，只替换自己的键，并在替换时追加历史。`reportPassed` 仍只看 `ReportCheck` 的三项。需求上的 `verified` 加 `confirmedBy: null` 只表示所引提交已核对；`confirmedBy: "user"` 才是验收。自动路径不能清掉用户确认。稳定 id 是 `messages.id`，不另造 `reportId`。

**Tech Stack:** 现有 TypeScript、zod、Hono、PostgreSQL 与 PGlite、Vitest。不新增依赖。不新表、不新列、不新迁移。

**Spec:** `docs/superpowers/specs/2026-10-28-evidence-return-v1-design.md`。动手前读全文，包括「已定的做法」「留给实现者」「验收标准」1–17 和「v1 明确不做」。

**Base:** 本计划对照 `a2977185d09434bf984590648f2b850a7234c6b4`（`origin/main`，Merge pull request #61）。动手前执行 `git fetch origin main && git rev-parse HEAD`。结果必须是这个 SHA。若 main 已前进，先停：只有 `packages/shared/src/report.ts` 的 `ReportInput`、`apps/hub/src/messages.ts` 的 `setReportMeta`、`packages/knowledge/src/store.ts` 的 `confirmImplementation` 与本计划描述的今天行为一致时才继续；任一不同则先改本计划再写代码。

**North star:** 本计划服务于 [issue #45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准：让人和 agent 更容易对项目保持有证据支撑的共同理解。做法是把声称和观察并排留下，并标出来源。不把 Nema Room 写成编排器、编码界面或线性的讨论到代码流水线。`verified` 仍只表示 Git 证据通过或用户确认过，不表示测试通过，也不表示验收完成。

**格式:** 知识库没有本设计的 R/D 条目。本文用近期 `docs/superpowers/plans/` 的 `### Task N`、**Files**、**Interfaces**、`- [ ] **Step n:**` 结构。每条任务的 **Satisfies** 标它覆盖的验收标准编号。文末有对照表。不写 `满足：R-n`。

## Global Constraints

- 不新增 npm 依赖。不新建 `apps/hub/src/db/migrations/` 文件。最新迁移仍是 `012_source_evidence.sql`。不给现有表加列。
- 不往 `evidence_events` 插入行。不写 `sourceRefs`。不预留空的 `sourceRefs`。不上报路径调用 `insertEvidenceEvent`。
- `Implementation.status` 保持 `reported | verified | mismatch`。不加第四个枚举值。`acceptanceReview` 只挂在需求 `implementation.evidence` 上，不挂到开发包任务。
- `reportPassed` 的函数体保持 `commitsExist && onMain === "yes" && filesOk`。作者和 check run 不是它的输入。
- 不扩展 `report.check` 的返回值。作者和 GitHub 读取是 daemon 上另外两个 RPC。模型不是调用者。hub 在整理任务开始前写好 meta。进行中上报没有整理任务。
- 本机上报令牌仍是一把 `~/.nema/report-token`。不按 agent 拆令牌。hub 不新增 GitHub token 文件。GitHub 读取复用 `apps/cli/src/github/gh.ts` 已有的只读 PR 与 check-runs 请求。
- 一个数据目录只跑一个 hub。不轮询 GitHub。只在收下带 `pr` 的上报时读一次，以及该条被 `recheckReports` 重跑时再读一次。
- `agent` 字符串是未认证标签。不映射到 GitHub 用户、本机账号或令牌。不打 email 到 `console.error`、系统任务句子或 hub 错误文案。
- #28 / #30 的 `user_basis_evidence` 409 和失效改回 `active` 的检查保持原样。CX-03 的外部引用检查不放宽。`report` 角色不是 user。
- 代码和注释用英文。hub 新拒绝文案用下面锁定的中文原句。`apps/web/messages/zh.json`、`apps/web/messages/en.json`、`apps/web/messages/ja.json` 同一次改。
- 不派发 agent，不开 PR，不合并，不发通知，不做冲突检测，不做项目级漂移检测。`checkHistory` 和 `github.history` 只描述这一条上报自己的观察被替换过，文档和界面都不得写成能回答「第一次偏离是什么时候」。
- 不改 `ROADMAP.md`。P1-07 保持「待办」。不把「测试已通过」做成结论。
- `README.md`、`README.en.md`、`README.zh.md`、`README.ja.md` 第 135 行已经写明 `verified` 不是测试通过或验收完成。任务 13 若 grep 不到「派发 agent / 判定测试通过 / 漂移检测」这类已实现声明，这四个文件字节不变。
- `docs/reference.zh-CN.md` 里开发包 plan 的校验标记（`### 任务 n：`、`- 满足：R-n`）是产品协议，任务 13 不改那一节。
- 每个任务结束跑该任务列出的 vitest 和 `npm run typecheck`。只有任务 12 改 web，只有它跑 `npm run lint -w apps/web` 和 `npm run build -w apps/web`。
- 本计划不新建源文件，也不新建测试文件。下面每个 Modify / Test 路径在写本计划时已在 `a297718` 上存在。

## 实现者选择（已定）

spec「留给实现者」的六项，按这里做，不再另选。

1. **RPC。** 新增 daemon 方法 `report.authors` 和 `github.observe`，注册在 `apps/cli/src/repos/handlers.ts`。`report.check` 的返回值仍是今天的 `ReportCheck`。`plugins.status` 已存在，用它读 `github.installed` 和 `github.loggedIn`，不另做状态 RPC。
2. **meta 合并。** `mergeReportMeta` 在 `db.tx` 里 `select meta from messages where id = $1 and role = 'report' for update`，在 TypeScript 里合并，再 `update`。调用方只提交自己的键。`setReportMeta` 的整段替换从 `receiveReport` 和 `recheckReports` 删除；删除该函数，避免留下整段替换入口。
3. **check run 页。** `github.observe` 只发一页，`perPage: 100`。`total_count > check_runs.length`，或响应没有 `total_count`，则 `truncated: true`。不翻页。
4. **「确认时」。** 不另存一份确认快照。比较的是被替换的那份 `check` 和新的 `check`。通过提交集合：`reportPassed` 为真时是 `report.commits`，否则是空数组。与 `evidence.commits` 用现有 `sameCommit` 双向比较。第一次替换后 `acceptanceReview.needed` 保持真，自动路径不能清。
5. **`remote_not_unique`。** 纯函数接受目标数组。生产路径只对这条上报路由到的那个仓库的 `remote_url` 调用一次 `githubTarget`：`null` 得到 `[]`，否则得到长度 1 的数组。不调用 `githubTargets()`，不去扫 workspace 里的其他仓库。今天这一列产生不了两个目标；数组长度大于 1 时返回 `remote_not_unique`，不挑一个。
6. **作者失败。** `report.authors` 抛错时，上报仍 202，`check` 照常留下，`authors` 键不写。不写一份空名单冒充「已经读过」。GitHub 读取失败则写一份新的 `unavailable`，`checkRuns` 为 `[]`，不复制上一份的 `headMatch` 或 `checkRuns`。

## 锁定句子

界面中文用 spec 原文。英文和日文用下表，三层分开：提交核对、测试通过、验收。spec 规定的三句中文里含有「测试已通过」这五个字，只允许出现在这三句否定里。其它句子、状态标签、按钮、note、系统任务禁止出现这五个字，也禁止出现「尚未有测试证据」。

| Id | 用途 | zh | en | ja |
|---|---|---|---|---|
| S1 | Agent 覆盖已确认实现的 409 | 已有用户确认的实现不能由 Agent 改写。 | （API 只返回中文） | （API 只返回中文） |
| S2 | 确认接口不符合条件的 409 | 只能确认已上报、有出入，或提交已核对但尚未验收的实现 | （API 只返回中文） | （API 只返回中文） |
| S3 | `reportPassed` 后的系统任务 | 上报 ${id} 的提交已核对（不是验收）。把还没有用户确认的需求 implementation 设为 verified，且不要写 confirmedBy。不要改写 confirmedBy 已是 "user" 的 implementation。 | （系统任务保持中文） | （系统任务保持中文） |
| S4 | `saveProgress` 的 note 和 commit reason | 开发包 ${id} 的提交已核对 | （知识 note 保持中文） | （知识 note 保持中文） |
| S5 | `state === "read"` 且 `checkRuns` 非空 | 已读到这些 check run。v1 不据此得出测试已通过。 | These check runs were read. v1 does not conclude that tests passed. | これらの check run を読みました。v1 はこれをもってテスト通過とは結論しません。 |
| S6 | `state === "read"` 且 `checkRuns` 为空 | 这次读取没有 check run。没有测试通过的结论。 | This read returned no check runs. There is no conclusion that tests passed. | この読み取りに check run はありません。テスト通過の結論はありません。 |
| S7 | `not_requested` 或 `unavailable` | 没有这次读取的 check run。没有测试通过的结论。 | There are no check runs from this read. There is no conclusion that tests passed. | この読み取りの check run はありません。テスト通過の結論はありません。 |
| S8 | 「提交已核对」旁边的范围 | 只这些提交：它们存在、在主分支上（或 patch-id 相同）、上报声称的文件被它们改过。不是需求的全部验收条件，也不是「需求已经实现」。 | Only these commits: they exist, are on the main branch (or have the same patch-id), and they touch the files the report claimed. This is not the requirement's acceptance criteria, and it is not "the requirement is implemented." | これらのコミットだけを指します。それらが存在し、main 上にある（または patch-id が同じ）こと、および報告が変更したと主張したファイルを変更したことです。要件の受け入れ条件を満たしたことでも、「要件が実装済み」でもありません。 |
| S9 | git 核对标签 | 提交已核对 | Commits checked | コミットは照合済み |
| S10 | 用户确认标签 | 验收已确认 | Accepted | 受け入れ確認済み |
| S11 | 复审按钮 | 仍确认 | Still accept | 引き続き受け入れる |
| S12 | 复审说明 | 所引上报的核对已变，验收仍在，需要复审 | The cited report's check changed. Acceptance remains and needs review. | 引用した報告の照合が変わりました。受け入れは残っており、再確認が必要です。 |
| S13 | agent 标签说明 | 这是上报里的名字，不是已认证的身份 | This is the name in the report, not an authenticated identity. | これは報告に書かれた名前であり、認証された身元ではありません。 |
| S14 | 作者说明 | 这是提交元数据，不是允许或拒绝。 | This is commit metadata, not an allow or deny decision. | これはコミットのメタデータであり、許可または拒否ではありません。 |
| S15 | 旧消息缺块 | 这条上报没有这份 hub 记录 | This report has no hub record of this kind. | この報告には、この hub 記録がありません。 |
| S16 | 历史快照标签 | 历史 | History | 履歴 |
| S17 | 两块标题 | agent 声称 / hub 核实 | Agent claim / Hub check | エージェントの主張 / hub の照合 |
| S18 | `report.verified` 的展示前缀 | agent 声称已验证 | Agent claims this was verified | エージェントは検証したと主張しています |

作者展示顺序固定为：author name、author email、committer name、committer email。S14 与这四项在同一块。找不到的条目 id 用 `MessageItem.tsx` 已有的 `rcheck-note` 段落，不创建条目。失败的 check run 用已有的 `itag red`，和 git「有出入」同一层，不放进 `<details>`，不新增颜色类。`conclusion` 为 `failure`、`timed_out`、`cancelled`、`action_required`、`stale` 时用 `itag red`。其它 conclusion 照列，不用红色，也不写成通过。

## Review Focus

1. `recheckReports` 若仍调用整段 `{ report, check }` 替换，会丢掉 `github` 和 `authors`。→ 任务 3、任务 5。
2. 进行中上报在 `onMain` 变成 `"yes"` 之后仍 `queueReportTask`、`applyReportToWorkPackage` 或 `queueSystemTask`。→ 任务 4、任务 5。
3. 新的 GitHub 读取失败时，把上一份的 `headMatch` 或 `checkRuns` 抄进 `current`。→ 任务 7。
4. 失败的 check run 把任务或需求写成 `mismatch`。`mismatch` 只来自提交不存在或文件不符。→ 任务 7、任务 10。
5. `verified` 且 `confirmedBy` 为 null 没有确认路径，或「仍确认」改了 `status` / `confirmedBy`。→ 任务 2、任务 8、任务 12。
6. `saveProgress` 的 note 仍是「全部任务已核实」，或用户确认 / 推断的任务让需求显示「提交已核对」。→ 任务 10。
7. Agent POST 一份 `confirmedBy: null` 的 implementation，盖掉磁盘上的 `"user"`。→ 任务 9。
8. 界面把 git 核对显示成「已核实」或「测试已通过」。→ 任务 12。
9. 把作者塞进 `ReportCheck`，使 `reportPassed` 开始依赖作者。→ 任务 6。
10. 为上报或 GitHub 读取插入 `evidence_events`、写入 `sourceRefs`，或把 ROADMAP P1-07 标成完成。→ 任务 13。

## v1 明确不做

实现任何一条都算超出本计划：按 agent 吊销令牌或远程接入；从 check run 自动得出「测试已通过」（规则留在 spec 里，不写代码、不显示结论）；把 GitHub 观察接进 `sourceRefs`；用 `checkHistory` 或 `github.history` 回答需求第一次偏离的时间；派发、开 PR、合并、通知、漂移检测；新依赖；新迁移。验收 17：不改 `ROADMAP.md`。

---

### Task 1: shared 上报字段和验收复审类型

**Files:**
- Modify: `packages/shared/src/report.ts`
- Test: `packages/shared/test/report.test.ts`、`packages/shared/test/entry.test.ts`

**Interfaces:**
- `ReportInput` 增加可选字段。`progress` 为 `"completed" | "in_progress"`，省略则 `"completed"`。`commits` 省略则 `[]`；`progress === "completed"` 时长度至少 1，最多 50，每项仍是 7–40 位十六进制。`in_progress` 允许 `[]`。
- 声称字段：`branch`（1–200，不含 `\n` `\r`）、`pr`（正整数）、`headSha`（40 位小写十六进制）、`ci`（最多 30；`name` 1–200，可选 `conclusion` 1–40，可选 `url` 1–500）、`verified` 与 `notVerified`（各最多 30，每项 1–200）、`blockers`（最多 20，每项 1–500）。未知键被 zod 丢掉。
- `ReportCheck` 与 `reportPassed` 不增字段。
- `ReportMessageMeta` 增加可选 `checkSkipped: "in_progress_no_commits" | null`、`checkHistory`（`{ onMain, commitsExist, filesOk, checkedAt, mainSha }[]`）、`authors`、`github: { current: GithubObservation; history: GithubObservation[] }`。旧对象缺这些键时 parse 不失败。
- `GithubObservation` 与 spec 里的类型逐字段一致，`reasonCode` 只允许 spec 列出的十个字符串，`source` 只允许 `"github-plugin-read"`。
- `Implementation.evidence.acceptanceReview` 默认 `null`。非 null 时只允许 `{ needed: true, at: string, reason: "linked_check_changed" }`。`needed: false` 解析失败。
- 不改 `packages/shared/src/index.ts`。它已经 `export * from "./report.js"`。

**Satisfies:** 验收 1 的解析一半。旧 JSON 仍通过，`progress` 为 `completed`。

- [ ] **Step 1: 写失败测试**

`packages/shared/test/report.test.ts` 增加：

- `it("parses a pre-v1 report as completed")`：不带 `progress`、不带声称字段、`commits` 至少 1 个的对象 `ReportInput.parse` 成功，`progress` 为 `"completed"`，`commits` 与输入相同。
- `it("rejects a completed report with no commits")`：省略 `progress` 且 `commits: []` 抛错。`progress: "completed"` 且 `commits: []` 抛错。
- `it("accepts an in-progress report with no commits")`：`progress: "in_progress"` 且省略 `commits`，结果 `commits` 为 `[]`。显式 `[]` 也成功。
- `it("strips unknown report keys")`：多一个 `extra: true` 仍成功，结果上没有 `extra`。
- `it("rejects a bad claim shape")`：`headSha` 不是 40 位小写十六进制、`branch` 含换行、`pr: 0`、`verified` 长度 31，各自抛错。
- `it("keeps reportPassed on the three git fields")`：现有通过用例的 `reportPassed` 仍为真；把 `onMain` 改成 `"not-yet"` 则为假。断言函数参数类型仍是 `ReportCheck`，测试对象不带作者字段。

`packages/shared/test/entry.test.ts` 的现有测试 `"implementation is accepted only on requirements and round-trips"`：期望对象补上 `acceptanceReview: null`。这一改在实现前失败，因为今天解析结果没有这个键。另加 `it("reads a missing acceptanceReview as null and round-trips linked_check_changed")`：不带该键的 frontmatter 解析为 `null`；带 `{ needed: true, at: "2026-10-28T00:00:00.000Z", reason: "linked_check_changed" }` 能往返；`needed: false` 抛错。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/shared report entry` → FAIL。新用例因字段不存在而失败。现有 `reportPassed` 用例仍通过。
- [ ] **Step 3: 实现** 上面的 zod 字段。`completed` 的「至少 1 个提交」放在默认值生效之后的对象校验里。不要把作者或 `GithubObservation` 放进 `ReportCheck`。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(shared): accept in-progress reports and acceptance review`

### Task 2: 知识文件保留旧字节，并放开需求确认

**Files:**
- Modify: `packages/knowledge/src/store.ts`
- Test: `packages/knowledge/test/store.test.ts`

**Interfaces:**
- `toFile` 在 `acceptanceReview === null` 时不写 `acceptance_review`。非 null 时写入 `{ needed, at, reason }`。已有的 `report_message_id`、`confirmed_by`、`commits`、`inferred`、`note` 键名不变。
- `implementationFromData` 把缺的 `acceptance_review` 读成 `null`。
- `confirmImplementation` 的提交说明仍是「用户确认已实现」。
  - 可确认：存在 implementation，且（`status` 为 `reported` 或 `mismatch`，或 `status` 为 `verified` 且 `confirmedBy` 为 null）。结果：`status` 为 `verified`，`confirmedBy` 为 `"user"`，`reportMessageId`、`commits`、`note`、`inferred` 保留，`acceptanceReview` 为 null。
  - 「仍确认」：`status` 为 `verified`、`confirmedBy` 为 `"user"`、`acceptanceReview.needed` 为真。只把 `acceptanceReview` 写成 null。不改 `status`、`confirmedBy`、其余 evidence。
  - `verified` 且 `confirmedBy` 为 `"user"` 且没有 `needed`：抛错，文件不变。
- 不在本任务改 HTTP。

**Satisfies:** 验收 10 的存储一半。

- [ ] **Step 1: 写失败测试**

在 `store.test.ts`：

- `it("omits a null acceptance review from the file")`：`upsert` 一条需求，implementation 为 `verified`、`confirmedBy: null`、`acceptanceReview` 省略。读回为 `null`。文件正文不含 `acceptance_review`。
- `it("round-trips acceptance review")`：写入 `needed: true` 后再 `get`，三个字段都在。
- `it("keeps a legacy file byte-identical when implementation is absent")`：用本文件已有的 `LEGACY` 常量和 `"updating a legacy entry leaves ingestedAt null"` 的写法，只改 `related`。读回的文件等于写入前的字节，不含 `acceptance_review`。
- `it("confirms a git-checked requirement and keeps its commits")`：先写入 `verified`、`confirmedBy: null`、`commits: ["abc1234"]`、`reportMessageId: "m_1"`。`confirmImplementation` 后 `confirmedBy` 为 `"user"`，`status` 仍是 `verified`，`commits` 仍是 `["abc1234"]`，`acceptanceReview` 为 null。
- `it("clears only the review when the user accepts again")`：起点是 `verified`、`confirmedBy: "user"`、`acceptanceReview.needed`。调用后 `acceptanceReview` 为 null，`confirmedBy` 仍是 `"user"`，`commits` 不变。
- `it("refuses to confirm a user-accepted requirement that needs no review")`：同样起点但 `acceptanceReview` 为 null。调用抛错。再 `get`，evidence 与调用前相同。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/knowledge store` → FAIL。今天 `confirmImplementation` 拒绝 `verified`，文件也不写 `acceptance_review` 的往返。
- [ ] **Step 3: 实现** 映射和两个确认分支。`null` 继续省略，保持旧文件字节。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(knowledge): confirm a git-checked requirement without rewriting legacy files`

### Task 3: 按键合并 report meta

**Files:**
- Modify: `apps/hub/src/messages.ts`
- Test: `apps/hub/test/messages.test.ts`

**Interfaces:**
- 新增 `mergeReportMeta(db, messageId, patch)`。`patch` 的键只允许 `check`、`checkError`、`checkSkipped`、`authors`、`github`。不接受 `report`、`checkHistory`。调用方传 `github` 时只传新的 `current`；函数自己追加 `history`。
- 事务内 `for update` 读到的行不是 `role = 'report'` 时返回 `null`。
- 替换 `check` / `checkError` / `checkSkipped` 时，若上一份 `check` 非 null，先把 `onMain`、`commitsExist`、`filesOk`、`checkedAt`、`mainSha` 追加到 `checkHistory`。不截断。patch 里显式 `null` 清掉该键。patch 里没有的键保持最新行上的值。
- 替换 `github` 时，若上一份 `current.state` 不是 `"not_requested"`，先把上一份 `current` 原样追加到 `history`，再写新的 `current`。上一份是 `not_requested` 或不存在时不追加。
- 替换 `authors` 只换 `authors`。
- 删除 `setReportMeta`。本任务先改签名会让 `reports.ts` 编不过；本任务内把 `reports.ts` 的两处调用改成暂时仍能编译的 `mergeReportMeta` 调用，行为等价于今天的写入（整份 check 替换，但不再用整对象覆盖）。任务 4、5 再改这两处的周围逻辑。不要在本任务实现进行中上报。

**Satisfies:** 验收 5 的合并机制。

- [ ] **Step 1: 写失败测试**

`messages.test.ts` 增加：

- `it("merges a check without dropping github or authors")`：先 `addReportMessage`，再 `mergeReportMeta` 写入 `authors` 和 `github.current`（`state: "read"`）。再 `mergeReportMeta` 只传 `{ check }`。读回的 meta 仍有原来的 `authors` 和 `github.current`，并且 `check` 是新的。
- `it("appends the previous check to checkHistory")`：连续两次写入不同的 `check`。`checkHistory` 长度为 1，字段只有上一份的 `onMain`、`commitsExist`、`filesOk`、`checkedAt`、`mainSha`。第三次后再长度为 2。
- `it("appends a github current that was not not_requested")`：先写 `state: "read"`，再写 `state: "unavailable"`。`history` 长度为 1，且是第一份。`current` 是第二份。先写 `not_requested` 再写 `read` 时 `history` 为 `[]`。
- `it("keeps both keys when two merges run together")`：对同一 `messageId` `Promise.all` 两个 `mergeReportMeta`，一个只传 `authors`，一个只传 `github`。最终两个键都在。今天若用调用方手里的整份副本覆盖，会丢掉一个。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub messages` → FAIL。`mergeReportMeta` 尚不存在。
- [ ] **Step 3: 实现** 行锁合并，并删掉 `setReportMeta`。`reports.ts` 的两处改为 `mergeReportMeta(db, id, { check, checkError: null, checkSkipped: null })` 或错误分支的 `{ check: null, checkError }`，使类型通过。不要在这里改排队和套用。
- [ ] **Step 4: 跑** 同一条 vitest、`npx vitest run --project @nema/hub reports` 和 `npm run typecheck` → PASS。既有上报测试仍通过。
- [ ] **Step 5: Commit** `fix(hub): merge report meta by key under a row lock`

### Task 4: 收下进行中上报，不排队、不套用

**Files:**
- Modify: `apps/hub/src/reports.ts`
- Test: `apps/hub/test/reports.test.ts`、`apps/hub/test/report.e2e.test.ts`

**Interfaces:**
- `POST /report` 的 400 文案保持「上报内容不完整或格式不对」。解析成功仍 202 `{ messageId }`。
- `progress` 缺省或 `"completed"`：行为与今天相同，再加任务 6、7 的作者和 GitHub 写入点（本任务先留调用位，RPC 未实现前不要调用尚不存在的方法；作者和 GitHub 的实际调用在任务 6、7 接上）。本任务的 completed 路径继续跑 `report.check`、`mergeReportMeta`、`applyReportToWorkPackage`、`queueReportTask`。
- `in_progress` 且 `commits` 为空：不调用 `daemon.call("report.check")`。`mergeReportMeta` 写入 `check: null`、`checkError: null`、`checkSkipped: "in_progress_no_commits"`。不 `queueReportTask`。不 `applyReportToWorkPackage`。消息留下，`report` 原样。
- `in_progress` 且 `commits` 非空：跑 `report.check` 并合并到这条消息。不排队，不套用。`progress` 保持 `in_progress`（不改 `report`）。
- 已完成且 `commits` 为空仍是 400，不写消息。

**Satisfies:** 验收 2。验收 1 的「git 核对与今天相同」由既有 completed 测试继续守住。

- [ ] **Step 1: 写失败测试**

在 `reports.test.ts` 用现有的 `handlers`、`post`、`bind`：

- `it("stores an in-progress report with no commits and does not check, queue, or apply")`：`progress: "in_progress"`、`commits: []`、带一个已存在的 `W-n` 任务号。响应 202。`calls` 里没有 `report.check`。该消息 meta 的 `report` 等于提交体解析结果，`check` 为 null，`checkSkipped` 为 `"in_progress_no_commits"`，没有 `checkError`。`listQueuedTasks` 为空。任务 `status` 仍是 `pending`。
- `it("checks an in-progress report that has commits without queueing it")`：`commits` 有一项，`handlers["report.check"]` 返回 `onMain: "not-yet"`。202。meta.check 等于该返回。排队任务数为 0。任务状态不变。
- 既有 `"an invalid report is 400 and stores nothing"` 再断言：`progress` 省略且 `commits: []` 也是 400，消息数为 0。
- 既有 `"report creates a report message, stores the check, then queues a task"` 保持断言：不带 `progress` 的上报仍排队。

`report.e2e.test.ts` 增加第二个 `test`，名字 `"an in-progress report with no commits is accepted by a real hub"`。复用本文件已有的 `createApp`、`makeHubDeps` 和本地 `git()`。不要新建 helper 文件。断言 HTTP 202，数据库里这条 `report` 的 `check` 为 null，`checkSkipped` 为 `"in_progress_no_commits"`，没有新的 queued task。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub reports report.e2e` → FAIL。今天空 `commits` 在解析阶段就 400；非空进行中上报会被排队。
- [ ] **Step 3: 实现** 上面的分支。`report` 对象在 `addReportMessage` 时写入后，后续合并不再传 `report`。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): accept in-progress reports without queueing them`

### Task 5: 重跑只合并观察，进行中不上套用

**Files:**
- Modify: `apps/hub/src/reports.ts`
- Test: `apps/hub/test/reports.test.ts`

**Interfaces:**
- `recheckReports` 的挑选不变：近 30 天、`onMain` 为 `"not-yet"`、`gitCommonDir` 匹配。没有 `check` 的进行中上报（空提交）选不中。
- 重跑用 `mergeReportMeta` 写新的 `check`，并显式把 `checkError`、`checkSkipped` 置 null。不传 `report`。因此任务 3 会留下 `authors` 和 `github`。
- `report.progress === "in_progress"`：合并之后返回。不调用 `applyReportToWorkPackage`，不调用 `queueSystemTask`。不改 `report.progress`。
- 缺 `progress` 或 `"completed"`：仍调用 `applyReportToWorkPackage`。仅当 `reportPassed(check)` 时 `queueSystemTask`，句子用 S3，`${id}` 是消息 id。禁止旧句「核实通过」和「全部任务已核实」。
- 本任务在替换 `check` 之后调用任务 9 才会实现的复审标记函数。本任务先把调用点写成一个本文件内的空函数 `noteLinkedCheckChanged`，参数是消息 id、旧 check、新 check。任务 9 填上函数体。空函数必须真的被调用，测试在任务 9 之前只断言它不会把 `confirmedBy` 改成 null（今天的 `applyReportToWorkPackage` 也不改需求的 `confirmedBy`）。

**Satisfies:** 验收 3。验收 5 的「先写 github 再重跑 git」场景。验收 11 里「重跑不把 confirmedBy 改回 null」的上报消息一半，需求行的断言在任务 9 收紧。

- [ ] **Step 1: 写失败测试**

- `it("rechecks an in-progress report onto main without applying or queueing")`：先存一条 `in_progress`、`onMain: "not-yet"` 的消息。`handlers["report.check"]` 改为 `onMain: "yes"` 且三项都过。跑 `recheckReports`。消息 `check.onMain` 为 `"yes"`，`report.progress` 仍是 `"in_progress"`。`apply` 所指向的任务 `status` 仍是 `pending`。系统消息列表里没有新的 system 任务。
- `it("keeps github when a completed report is rechecked")`：消息 meta 先有 `github.current.state === "read"` 和 `authors`。重跑只产生新 check。读回 `github.current` 与 `authors` 仍在，`checkHistory.length` 为 1。
- `it("queues the commits-checked system task when a completed recheck passes")`：既有 `"a main move re-checks a not-yet report and queues the verified system task when it now passes"` 改断言：系统任务正文等于 S3，不含「核实通过」，不含「验收」。`applyReportToWorkPackage` 仍发生（任务在 git 通过且文件命中时变成 `verified`、`confirmedBy` 为 null）。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub reports` → FAIL。今天重跑进行中上报会套用并排队旧句子。
- [ ] **Step 3: 实现** 分支和 S3。`noteLinkedCheckChanged` 先是空函数。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `fix(hub): recheck in-progress reports without applying them`

### Task 6: 作者只作证据

**Files:**
- Modify: `apps/cli/src/repos/reportCheck.ts`
- Modify: `apps/cli/src/repos/handlers.ts`
- Modify: `apps/hub/src/reports.ts`
- Test: `apps/cli/test/repos/reportCheck.test.ts`、`apps/hub/test/reports.test.ts`、`apps/hub/test/roomApi.test.ts`

**Interfaces:**
- `report.authors` 参数与 `report.check` 相同的仓库参数加 `commits: string[]`。返回 `{ checkedAt: string, source: "git", commits: { sha, authorName, authorEmail, committerName, committerEmail }[], missing: string[] }`。
- 对 `checkReport` 会判为存在的每个完整 SHA 读 author name、author email、committer name、committer email。读不到的 SHA 放进 `missing`，不编造姓名。短 SHA 的解析复用 `reportCheck.ts` 里已有的解析；若该逻辑是私有函数，把它导出到同文件，两边调用。不要把作者字段加进 `checkReport` 的返回值。
- hub 在 `report.check` 成功后调用 `report.authors`，用 `mergeReportMeta` 只写 `authors`。RPC 失败则不写 `authors`，上报仍 202，`console.error` 的参数里不得含测试用的 email。
- 空提交的进行中上报不调用 `report.authors`。
- `authors` 不参与 `reportPassed`、`implementationRefusal`、`applyReportToWorkPackage`。

**Satisfies:** 验收 6 的服务端一半。界面「没有允许或禁止」在任务 12。

- [ ] **Step 1: 写失败测试**

`reportCheck.test.ts` 用现有的 `RpcRouter` + `registerRepoHandlers` + 真实临时 git：

- `it("returns author and committer for a resolved commit")`：建一个提交，author 与 committer 不同，email 用 `author@example.com` 和 `committer@example.com`。`report.authors` 的 `commits[0]` 含这四项，`source` 为 `"git"`，`missing` 为 `[]`。
- `it("lists an unreadable sha as missing")`：`commits: ["deadbee"]`（仓库里没有）。`commits` 为 `[]`，`missing` 为 `["deadbee"]`。
- `it("does not add authors to report.check")`：同一提交的 `report.check` 结果的键集合仍是今天的 `ReportCheck` 键。

`reports.test.ts`：

- `it("stores authors beside the check and still passes on git alone")`：`handlers["report.authors"]` 返回带 `author@example.com` 的对象。completed 上报 202 后 meta.authors 等于该对象。`handlers` 被调用的方法含 `report.authors`。把 `console.error` 换成记录参数的假函数，参数里没有 `author@example.com`。
- `it("keeps the report when author lookup throws")`：`report.authors` 抛错。202。meta 有 `check`，没有 `authors`。

`roomApi.test.ts` 在现有 verified-needs-report 用例旁加 `it("ignores authors when refusing a verified implementation")`：同一条 `reportPassed` 的上报，meta 有或没有 `authors`，`implementationRefusal` 的结果相同。没有 `reportPassed` 时仍返回 `VERIFIED_NEEDS_REPORT`。`confirmedBy: "user"` 仍返回 `CONFIRMED_BY_USER_ONLY`。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/cli reportCheck` 和 `npx vitest run --project @nema/hub reports roomApi` → FAIL。`report.authors` 未注册。
- [ ] **Step 3: 实现** RPC 和 hub 合并。错误日志只写消息 id 和「author lookup failed」，不写 email。
- [ ] **Step 4: 跑** 这两条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(cli): record git authors as report evidence`

### Task 7: GitHub 观察的门槛、绑定和失败隔离

**Files:**
- Modify: `apps/hub/src/githubScope.ts`
- Modify: `apps/cli/src/github/gh.ts`
- Modify: `apps/cli/src/repos/handlers.ts`
- Modify: `apps/hub/src/reports.ts`
- Test: `apps/hub/test/githubScope.test.ts`、`apps/cli/test/github/gh.test.ts`、`apps/cli/test/repos/reportCheck.test.ts`、`apps/hub/test/reports.test.ts`

**Interfaces:**
- `githubScope.ts` 新增纯函数 `githubObservationGate({ pr, pluginEnabled, gh, targets })`。`targets` 是 `{ owner, repo }[]`。
  - `pr` 缺省：`{ state: "not_requested" }`，无 `reasonCode`。
  - 否则按这个顺序，命中即停：`pluginEnabled` 假 → `plugin_disabled`；`gh.installed` 假 → `gh_unavailable`；`gh.loggedIn` 假 → `gh_logged_out`；`targets.length === 0` → `remote_missing`；`targets.length > 1` → `remote_not_unique`。这些的 `state` 都是 `"unavailable"`。
  - 否则 `{ state: "read", target: targets[0] }`。
- 生产调用：`pluginEnabled` 来自该 workspace 的 GitHub 插件。没有 `workspace_plugins` 行时为 false（`dataFlow` 是 `external`）。`gh` 来自已有的 `plugins.status`。`targets` 只由 `githubTarget(repo.remoteUrl)` 得到 0 或 1 个。不调用 `githubTargets()`。`plugins.status` 抛错时按 `gh_unavailable`，上报仍 202。
- `GithubReader` 增加可选方法 `observePullRequest?({ owner, repo, pr, perPage })`。已有只实现 `call` / `status` / `close` 的测试假对象不用改。`GithubGh` 实现该方法：与 `pull_request_read` 的 `get` 加 `get_check_runs` 相同的两个 GET，`perPage` 固定 100，不传 `page`。不改 `call("pull_request_read")` 今天的 40–64 位 SHA 接受范围。
- 该方法的结果：PR GET 失败且 stdout 或 stderr 含 `Not Found` 或 `HTTP 404` 时返回 `{ outcome: "out_of_scope" }`，不改去请求别的仓库。超时抛出现有文案 `GitHub call timed out`。head 不是恰好 40 位十六进制时抛出现有文案 `GitHub returned invalid pull request head SHA`，并且不返回 check run。其它非 0 退出抛 `GitHub call failed`。成功时返回 `{ outcome: "read", observedHeadSha, checkRuns, truncated }`。`observedHeadSha` 为小写 40 位。`checkRuns` 项为 `{ name, status, conclusion, url }`，`url` 取 `html_url`，没有则为 null。`total_count > checkRuns.length` 或缺少 `total_count` 时 `truncated` 为 true。
- `github.observe` 注册在 `handlers.ts`。它要求 `observePullRequest` 存在，否则抛 `GitHub call failed`。参数 `{ owner, repo, pr, claimedHeadSha }`。返回该方法的结果。
- hub 组装 `GithubObservation`：`source` 为 `"github-plugin-read"`，`observedAt` 为这次读取结束的 ISO 时间，`binding` 在 `not_requested` 时为 null，在去读或失败时含 `repoId`、`owner`、`repo`、`pr`、`observedHeadSha`、`claimedHeadSha`。还没读到 head 时 `observedHeadSha` 为 null。`headMatch`：两边都是 40 位小写且逐字符相同才是 `"match"`；声称有 `headSha` 但不相同是 `"mismatch"`；声称没有是 `"not_comparable"`；失败或未请求是 null。不改 `report.headSha`。
- 超时 → `timeout`。`GitHub call failed` → `http_error`。非法 SHA → `invalid_response`。`out_of_scope` → `out_of_scope`。这些 `state` 为 `"unavailable"`，`checkRuns` 为 `[]`，`truncated` 为 false。
- `receiveReport` 在 check（若有）和 authors（若有）之后写 `github`。没有 `pr` 也写一份 `not_requested`。`recheckReports` 对选中的行按同一门槛再读一次并 `mergeReportMeta`。历史追加由任务 3 的函数负责。
- check run 不传入 `applyReportToWorkPackage`。

**Satisfies:** 验收 7、验收 8 的数据、验收 13 的「失败 check run 不改 git 状态」的服务端一半。

- [ ] **Step 1: 写失败测试**

`githubScope.test.ts`：

- `it("gates a github read in a fixed order")`：无 `pr` → `not_requested`。有 `pr` 且插件关 → `plugin_disabled`，即使 `gh` 已登录且有目标。插件开、`installed: false` → `gh_unavailable`。已安装未登录 → `gh_logged_out`。已登录且 `targets: []` → `remote_missing`。两个不同目标 → `remote_not_unique`，结果里没有被选中的 owner。一个目标且前提都过 → `read` 且 `target` 是那一个。

`gh.test.ts` 用该文件已有的假 `gh` 二进制：

- `it("reads one page of check runs and marks a short page truncated")`：PR head 是 40 位小写 SHA，check-runs JSON 的 `total_count` 为 2、数组长度为 1。`truncated` 为 true，`observedHeadSha` 等于该 SHA，`per_page=100` 出现在请求里，没有第二页请求。
- `it("returns out of scope on a 404 for that repo")`：假二进制对这个 owner/repo 退出非 0，stdout 为 `{"message":"Not Found"}`。结果 `outcome` 为 `"out_of_scope"`。
- `it("rejects a head that is not 40 hex")`：head 为 64 位 hex。抛 `GitHub returned invalid pull request head SHA`。

`reportCheck.test.ts`：

- `it("observes a pull request through the injected reader")`：注入的 `observePullRequest` 被 `github.observe` 调用，参数 `perPage` 为 100。返回值原样传出。

`reports.test.ts`：

- `it("accepts a report with a pr when the plugin is off")`：不插入 `workspace_plugins`。body 带 `pr: 7`。202。`github.current.state` 为 `"unavailable"`，`reasonCode` 为 `"plugin_disabled"`，`checkRuns` 为 `[]`。`calls` 里没有 `github.observe`。
- `it("does not request github when the report has no pr")`：`github.current.state` 为 `"not_requested"`，无 `reasonCode`，`binding` 为 null。
- `it("stores a bound read and does not copy it onto the claim")`：插入 `workspace_plugins`（`plugin_id` `'github'`，`enabled` true），`bind` 的 `remote_url` 设为 `https://github.com/example/repo.git`（给现有 `bind` 加可选参数，默认仍是 null）。`plugins.status` 返回已登录。`github.observe` 返回 `outcome: "read"`、一个 40 位 head、一条 `conclusion: "failure"` 的 check run、`truncated: false`。meta.github.current.binding 含该 `repoId`、`pr`、`observedHeadSha`、`claimedHeadSha`、以及非空 `observedAt`。`source` 为 `"github-plugin-read"`。`report.headSha` 与 `report.ci` 仍是请求里的原值。任务 `status` 仍由 git 决定：git 三项通过时是 `verified`，不是 `mismatch`。
- `it("replaces a successful read with unavailable when the next read fails")`：消息已有 `state: "read"`、`headMatch: "match"`、一条 `conclusion: "success"`，且 `check.onMain` 为 `"not-yet"`，因此 `recheckReports` 会选中它。重跑时 `github.observe` 抛 `GitHub call timed out`，`report.check` 仍返回 `onMain: "not-yet"`。最终 `current.state` 为 `"unavailable"`，`reasonCode` 为 `"timeout"`，`current.checkRuns` 为 `[]`，`current.headMatch` 为 null。`history[0]` 是上一份成功观察。
- `it("labels the previous head as history when the observed head changes")`：两次 `outcome: "read"` 的 `observedHeadSha` 不同。`history` 有第一份，`current.binding.observedHeadSha` 是第二份。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub githubScope reports` 和 `npx vitest run --project @nema/cli gh reportCheck` → FAIL。门槛函数和 `observePullRequest` 尚不存在。
- [ ] **Step 3: 实现** 门槛、可选读取方法和 hub 组装。失败分支新建对象，不从上一份 `current` 拷贝 `checkRuns` 或 `headMatch`。
- [ ] **Step 4: 跑** 这两条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(cli): record a bound GitHub read on a report`

### Task 8: 确认接口接受「提交已核对」和「仍确认」

**Files:**
- Modify: `apps/hub/src/uiApi.ts`
- Test: `apps/hub/test/uiApi.test.ts`

**Interfaces:**
- `POST .../implementation/confirm` 与任务 2 的两个成功分支一致。成功仍调用 `store.confirmImplementation`，author 仍是 `user`。
- 不可确认时 409，正文是 S2。替换今天的「只能确认已上报或有出入的实现」。
- `verified` 且 `confirmedBy` 为 null：200，之后 `confirmedBy` 为 `"user"`，`status` 仍是 `verified`，`commits` 不变。
- `verified`、`confirmedBy` 为 `"user"`、`acceptanceReview.needed`：200。只清掉 `acceptanceReview`。
- `verified`、`confirmedBy` 为 `"user"`、没有 `needed`：409，正文 S2，文件不变。

**Satisfies:** 验收 10 的 HTTP 一半。

- [ ] **Step 1: 写失败测试**

在 `uiApi.test.ts` 现有确认用例旁：

- `it("confirms a requirement that is verified with no user yet")`：条目 implementation 为 `verified`、`confirmedBy: null`、`commits: ["abc1234"]`。POST 成功。读回 `confirmedBy` 为 `"user"`，`commits` 仍是 `["abc1234"]`，`status` 为 `verified`。
- `it("rejects confirm when the user already accepted and no review is needed")`：409，正文等于 S2。文件里 `confirmedBy` 仍是 `"user"`。
- 既有断言「只能确认已上报或有出入的实现」改为 S2。`reported` 与 `mismatch` 的成功路径保持。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub uiApi` → FAIL。今天 `verified` 走 409 旧句子。
- [ ] **Step 3: 实现** 与 `confirmImplementation` 相同的判断，409 用 S2。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): let a user accept a git-checked requirement`

### Task 9: 用户确认不被自动路径改写

**Files:**
- Modify: `apps/hub/src/roomApi.ts`
- Modify: `apps/hub/src/reports.ts`
- Test: `apps/hub/test/roomApi.test.ts`、`apps/hub/test/reports.test.ts`

**Interfaces:**
- 房间 upsert：请求带了 `implementation`，且磁盘上该需求 `confirmedBy` 为 `"user"` 时，比较 `status`、`confirmedBy`、`reportMessageId`、`commits`（顺序也算）、`note`、`acceptanceReview`。不完全相同则 409，正文 S1，文件字节不变。完全相同则允许（不是 409）。省略 `implementation` 时仍走今天的「保留旧值」。
- 请求对象自己的 `confirmedBy` 非 null 仍返回 `CONFIRMED_BY_USER_ONLY`，且先于 S1 判断。没有 `reportPassed` 仍返回 `VERIFIED_NEEDS_REPORT`。`user_basis_evidence` 的 409 文案和触发条件不变。
- `noteLinkedCheckChanged(db, dataDir, workspaceId, messageId, previous, next)`：`dataDir` 为空则返回。用 `KnowledgeStore.list` 找 `implementation.evidence.reportMessageId === messageId` 且 `confirmedBy === "user"` 的需求。无关消息不标记。
- 设 `needed` 的条件：新 `reportPassed(next)` 与旧 `reportPassed(previous)` 不同，或通过提交集合与 `evidence.commits` 用 `sameCommit` 对不齐。通过提交集合在 `reportPassed` 为真时是该消息 `report.commits`，否则 `[]`。对齐的定义：两边每一项都能在另一边找到 `sameCommit`。命中则把 `acceptanceReview` 设为 `{ needed: true, at: <这次替换的 ISO 时间>, reason: "linked_check_changed" }`。不改 `status`、`confirmedBy`、`reportMessageId`、`commits`、`note`。已经 `needed` 时不要把它改回 null，即使新 check 又对上了。
- `recheckReports` 在 `mergeReportMeta` 之后调用它，进行中和已完成都调用。它不 `queueSystemTask`，不改变进行中的「不套用」。

**Satisfies:** 验收 11 的确认保持和 Agent 409。验收 14 的三条既有拒绝（测试保持绿色）。

- [ ] **Step 1: 写失败测试**

`roomApi.test.ts`：

- `it("rejects an agent rewrite of a user-confirmed implementation")`：磁盘上 `confirmedBy` 为 `"user"`、`status` 为 `verified`、`commits` 为 `["abc1234"]`。请求带一份 `confirmedBy: null` 的 implementation。409，正文 S1。再读文件，`confirmedBy` 仍是 `"user"`，`commits` 不变。
- `it("allows an agent upsert that repeats the stored implementation")`：请求对象与磁盘这六个字段相同。不是 S1。
- `it("keeps a user confirmation when the implementation field is omitted")`：请求不带 `implementation`，只改 `related`。`confirmedBy` 仍是 `"user"`。
- 既有 `user_basis_evidence` 用例不改断言，跑的时候必须仍是 409。

`reports.test.ts`：

- `it("marks acceptance review when a cited check stops passing")`：需求 `confirmedBy` 为 `"user"`，`reportMessageId` 指向这条 `onMain: "not-yet"` 但其余两项为真的上报（此时 `reportPassed` 为假）。先把 check 写成 `reportPassed` 为真并确认，再重跑成 `commitsExist: false`。重跑后 `confirmedBy` 仍是 `"user"`，`status` 仍是 `verified`，`acceptanceReview.needed` 为 true，`reason` 为 `"linked_check_changed"`。另一条需求的 `reportMessageId` 指向别的消息，它的 `acceptanceReview` 仍是 null。
- `it("does not clear a user confirmation when a later completed report is stored")`：用户已确认需求 R-1。再 POST 一条别的 completed 上报。R-1 的 `confirmedBy` 仍是 `"user"`，`status` 仍是 `verified`。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub roomApi reports` → FAIL。今天 Agent 可以用 `confirmedBy: null` 盖掉 `"user"`，重跑也不写 `acceptanceReview`。
- [ ] **Step 3: 实现** 磁盘比较和复审标记。比较用深度相等，不用 `sameCommit`。复审标记的提交比较才用 `sameCommit`。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `fix(hub): keep user acceptance when a later check changes`

### Task 10: 开发包只在全部任务都有 git 核对时写「提交已核对」

**Files:**
- Modify: `apps/hub/src/workpackages.ts`
- Test: `apps/hub/test/workpackages.test.ts`

**Interfaces:**
- `applyReportToWorkPackage`：任务 `status === "verified"` 时仍直接返回，不降级，不改该任务的 `confirmedBy`。git 规则不变：`!commitsExist || !filesOk` → `mismatch`；`onMain !== "yes"` → `reported`；`reportPassed` 且任务文件被碰到 → `verified` 且 `confirmedBy` 保持 null。不读 `github`。调用方不得把 CI 失败译成 `filesOk: false`。
- 任务算「有 git 核对」仅当：`status === "verified"`、`confirmedBy !== "user"`、`inferred === false`，且 `reportMessageId` 指向的上报 `reportPassed` 为真。
- `saveProgress`：全部任务 `status === "verified"` 时开发包仍可变成 `done`。只有每个任务都「有 git 核对」时，才把还没有用户确认的需求写成 `verified`、`confirmedBy: null`。`evidence.commits` 只来自这些 `reportPassed` 上报的 `report.commits`。`evidence.reportMessageId` 指向其中最后一条（按任务顺序）。note 和 commit reason 都用 S4。禁止「已核实」「验收」「全部任务已核实」。
- 任一任务是用户确认、推断、或没有 `reportPassed`：不写需求的 implementation。包仍可 `done`。
- 需求已是 `confirmedBy: "user"`：不替换它的 implementation。若这次rollup所用的、且该需求 `reportMessageId` 指向的上报已经 `acceptanceReview.needed`，保持该标记。本函数不把 `needed` 清掉，也不在这里重算 git；重算在任务 9。

**Satisfies:** 验收 12。验收 13 的任务状态一半。验收 11 的 `saveProgress` 一半。

- [ ] **Step 1: 写失败测试**

在 `workpackages.test.ts`：

- `it("does not verify the requirement when the last task was confirmed by the user")`：两个任务都 `status: "verified"`。最后一个 `confirmedBy: "user"`，它的上报 `reportPassed` 为假。包的状态变成 `done`。需求 implementation 与调用前相同，不是 `verified`。note 不含「提交已核对」，也不含「已核实」。
- `it("writes commits-checked when every task has a passing report")`：每个任务 `confirmedBy` 为 null、`inferred` 为 false、上报 `reportPassed`。需求变成 `verified`、`confirmedBy` null。note 等于 S4，含「提交已核对」，不含「已核实」，不含「验收」。`commits` 只含这些上报里的提交。
- `it("leaves a user-confirmed requirement in place when the package becomes done")`：需求已经 `confirmedBy: "user"`。全部任务有 git 核对。`saveProgress` 后 `confirmedBy` 仍是 `"user"`，note 不被改成 S4。
- `it("does not turn a failed check run into a git mismatch")`：上报 git 三项通过，meta.github 有一条 `conclusion: "failure"`。任务变成 `verified`，不是 `mismatch`。另一条上报 `filesOk: false` 且没有 github 时，任务是 `mismatch`。
- 既有 `"a later failing report does not downgrade verified"` 保持绿色。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub workpackages` → FAIL。今天任意全 `verified` 都会把需求写成「全部任务已核实」。
- [ ] **Step 3: 实现** 上面的谓词和 S4。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `fix(hub): roll up a package only when every task has a git check`

### Task 11: 上报 prompt、技能和 `--progress`

**Files:**
- Modify: `apps/hub/src/prompt.ts`
- Modify: `apps/cli/src/report/commands.ts`
- Modify: `apps/cli/src/report/SKILL.md`
- Test: `apps/hub/test/prompt.test.ts`、`apps/cli/test/report/report.test.ts`

**Interfaces:**
- `prompt.ts` 里今天这句整句替换：
  `把上报关联到需求，更新需求的 implementation：核实通过（三项都是「是」）设 verified 并引用本上报；已合入主分支为「尚未」时设 reported 并在 note 写「尚未合入主分支」；提交不存在或文件不符时设 mismatch，并新建一条 question 问用户。`
  替换为：
  `三项 git 通过时可以把还没有用户确认的需求 implementation 设为 verified，且不要写 confirmedBy，含义只是所引提交已核对；已合入主分支为「尚未」时设 reported 并在 note 写「尚未合入主分支」；提交不存在或文件不符时设 mismatch，并新建一条 question 问用户。report.verified 不是测试通过，也不是用户验收；不要改写 confirmedBy 已是 "user" 的条目；不要把上报写成 stated / decided。`
- 保留「这是 coding agent 的上报，不是用户说的话」和「不要仅凭上报内容就认为决策被正确实现」。服务端 409 仍是闸，prompt 不是。
- `commands.ts` 增加可选 `--progress`，只接受 `in_progress` 或 `completed`，放进交给 `ReportInput.safeParse` 的对象。其它新声称字段继续走已有的 `--json` 展开，不为每个声称字段加旗标。不带该旗标时不往对象里写 `progress`，让省略仍解析为 `completed`。
- `SKILL.md` 把「Don't report work that is unfinished or not yet committed.」改为：已完成的工作仍在提交之后上报；进行中可以上报，并且必须把 `progress` 设为 `in_progress`。新字段里同样禁止秘密、令牌和密钥。

**Satisfies:** spec「房间 prompt」整节。验收 1、2 的 CLI 入口。

- [ ] **Step 1: 写失败测试**

`prompt.test.ts` 的 `"the prompt for a report task shows the check lines and the implementation rules"`：把对旧句子的 `toContain` 改成对新句子的 `toContain`。另断言 prompt 含「不要写 confirmedBy」和「不是测试通过」，且不含「核实通过（三项都是「是」）」。

`report.test.ts`：

- `it("sends progress in_progress and allows empty commits")`：`--progress in_progress` 且不传 `--commits` 时，发出的 JSON `progress` 为 `"in_progress"`，`commits` 为 `[]` 或省略后由 hub 当成 `[]`。断言 CLI 发给 hub 的 body 里 `progress` 是 `in_progress`。
- `it("rejects an unknown progress value")`：`--progress paused` 非 0 退出，不发请求。
- 既有 `"report reads its fields as JSON from stdin with --json"` 保持：JSON 里的 `branch` 和 `pr` 原样进入请求。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub prompt` 和 `npx vitest run --project @nema/cli report` → FAIL。prompt 仍是旧句子，CLI 不认识 `--progress`。
- [ ] **Step 3: 实现** 句子、旗标和技能段落。
- [ ] **Step 4: 跑** 这两条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(cli): describe verified as a commit check, not acceptance`

### Task 12: 三语界面把声称、核对和验收分开

**Files:**
- Modify: `apps/web/messages/zh.json`
- Modify: `apps/web/messages/en.json`
- Modify: `apps/web/messages/ja.json`
- Modify: `apps/web/components/MessageItem.tsx`、`apps/web/components/EntryDetail.tsx`、`apps/web/components/KnowledgePanel.tsx`、`apps/web/components/WorkPackageDetail.tsx`
- Test: `apps/web/test/MessageItem.test.tsx`、`apps/web/test/EntryDetail.test.tsx`、`apps/web/test/KnowledgePanel.test.tsx`、`apps/web/test/WorkPackageDetail.test.tsx`、`apps/web/test/i18n.test.tsx`

**Interfaces:**
- 三份 messages 同时增加 S5–S18 的键。`impl.verified` 保持今天的「已核实」/ `Verified` / `検証済み`，因为 `i18n.test.tsx` 锁了这三句。组件不再用 `t("impl.verified")` 或 `` t(`impl.${status}`) `` 来渲染 `verified`。
- 需求或任务 `verified` 且 `confirmedBy` 不是 `"user"`：标签 S9，需求旁另有 S8。没有 `reportPassed` 的 evidence 时不得显示 S9。
- `confirmedBy === "user"`：标签 S10。`acceptanceReview.needed` 时再显示 S12，按钮文字 S11。否则需求确认按钮用现有 `impl.confirm`。
- 确认按钮可见当且仅当：`reported` 或 `mismatch`，或 `verified` 且 `confirmedBy` 为 null，或 `verified` 且 `confirmedBy` 为 `"user"` 且 `acceptanceReview.needed`。任务按钮仍只在任务 `reported` 或 `mismatch` 时渲染。git 已通过的任务不渲染任务确认按钮。
- `MessageItem` 对 `role === "report"` 分两块，标题 S17。声称块：agent 字符串加 S13；有 `verified` 时每项前加 S18，禁止把这些项渲染成「已核实」或 S9；有则显示 `notVerified`、`ci`、`blockers`。核实块：三项 git 结果（沿用今天的是/否文案）、作者四项加 S14、GitHub 当前观察。缺 `authors` 或缺 `github` 时该块显示 S15，不回填。`github.history` 每项标 S16，不把历史的 `conclusion` 填进当前句。当前句按 `state` 用 S5、S6 或 S7，有 `reasonCode` 时一并显示。失败 check run 用 `itag red`，不放进 `<details>`。
- 条目 id 在本 workspace 不存在：`rcheck-note` 显示该 id，不创建条目。
- `status === "reported"` 的文案保持「已上报」。`mismatch` 保持「有出入」。

**Satisfies:** 验收 4、验收 6 的界面、验收 8 的历史标签、验收 9、验收 10 的按钮、验收 13 的展示。

- [ ] **Step 1: 写失败测试**

- `MessageItem.test.tsx`：`it("splits the agent claim from the hub check")`。meta 含 agent、`verified: ["unit"]`、`headSha`、三项 git、作者、一条 `conclusion: "failure"` 的 check run。屏幕上有 S17 的两个标题、S13、S18 加 `unit`、作者 email、S5。失败 run 的节点 class 含 `itag` 和 `red`，且不在 `details` 里。把核实块的数据换成另一份 head 后，声称里的 `headSha` 文本仍在。
- `it("does not treat a failed read as the previous success")`：`current.state` 为 `"unavailable"`，`history[0]` 有 `conclusion: "success"`。屏幕有 S7 和 S16，当前区域的文本不含 `success`。
- `it("shows the three git lines when authors and github are absent")`：只有 `report` 和 `check`。三项 git 文案仍在，并有 S15。
- `EntryDetail.test.tsx`：现有 `findByText("已核实")` 改为 S9，并断言 S8 出现、S10 不出现（该用例是 `confirmedBy` null 且 evidence 来自 `reportPassed`）。另加 `it("offers confirm on a git-checked requirement and still-accept during review")`：`verified` + `confirmedBy` null 时按钮可见；`confirmedBy: "user"` 且 `needed` 时按钮文字是 S11，并有 S12；`confirmedBy: "user"` 且无 `needed` 时没有确认按钮，标签是 S10。
- `KnowledgePanel.test.tsx`：`"verified row"` 的 `textContent` 从「已核实」改为 S9。用户确认的那一行改为 S10。
- `WorkPackageDetail.test.tsx`：`it("does not confirm a git-verified task from the task button")`。任务 `verified`、`confirmedBy` null 时没有确认按钮，标签是 S9。任务 `reported` 时按钮仍在。
- `i18n.test.tsx`：给新键加上 zh/en/ja 三语期望。三个文件缺任一键则该测试失败。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/web MessageItem EntryDetail KnowledgePanel WorkPackageDetail i18n` → FAIL。今天 `verified` 渲染「已核实」，没有两块标题。
- [ ] **Step 3: 实现** 三语键和四个组件。然后在 `apps/web` 下搜索「测试已通过」：只允许命中 S5 的中文原句。搜索「尚未有测试证据」：零命中。
- [ ] **Step 4: 跑** 同一条 vitest、`npm run typecheck`、`npm run lint -w apps/web`、`npm run build -w apps/web` → PASS。
- [ ] **Step 5: Commit** `feat(web): show commit checks apart from acceptance`

### Task 13: 不写证据事件，并更新参考文档

**Files:**
- Modify: `apps/hub/test/reports.test.ts`
- Modify: `docs/reference.zh-CN.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- 上报和 `github.observe` 之后，该 workspace 的 `evidence_events` 行数与之前相同。不调用 `insertEvidenceEvent`。不改 `sourceRefs` 的校验函数。
- `docs/reference.zh-CN.md` 的 `nema report` 用法和「三种状态」改成与已实现行为一致：可选 `progress` 和声称字段；`messages.meta` 里声称与 hub 观察是两份记录；人看到的三层和各自证据来源；`reasonCode` 十个值；用户确认不会被上报、重跑或rollup清掉；CI 不写入 `evidence_events`。第 113 行附近「全部任务 verified 就是 done；这时它覆盖的需求也会标成 verified」改成：包可以 `done`，需求只有在每个任务都有 git 核对时才写成「提交已核对」。不要把 `done` 写成验收。
- 不改「spec 标记与 plan 格式」那一节（约第 88–92 行）。
- `CHANGELOG.md` 的 `[Unreleased]` 加一条 Changed：进行中上报可以没有提交且不排队；界面把提交核对和用户验收分开；v1 不从 check run 得出测试通过。
- `ROADMAP.md` 的 diff 必须为空。P1-07 仍是「待办」。
- 四个 README：grep「派发」「测试已通过」「漂移」。第 135 行的现有句子保持。没有把 v1 说成已经会派发、已经判定测试通过、或已经做漂移检测的句子时，不改这四个文件。

**Satisfies:** 验收 15、验收 16、验收 17。

- [ ] **Step 1: 写失败测试**

`reports.test.ts` 增加两个测试：

- `it("does not insert an evidence event for a report or a github read")`：记录 `select count(*) from evidence_events`。跑一条带 `pr` 且 `github.observe` 成功的 completed 上报，并跑一次 `recheckReports`。count 与之前相同。该 workspace 的知识条目若已有 `sourceRefs`，长度不变。
- `it("the chinese reference separates commit checks from acceptance")`：读 `docs/reference.zh-CN.md`。正文必须同时含「提交已核对」「reasonCode」「验收不会被自动清除」。今天这三句都不在该文件里，所以本测试失败。第 88–92 行附近的 plan 标记协议仍在，测试不要求删掉 `### 任务`。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub reports evidenceEvents` → FAIL。参考文档还没有这三句。事件计数这条在任务 7 之后应为通过；若它失败，是因为某次写入插了事件，先删掉那次插入，不要加表。既有 `evidenceEvents` 用例必须仍通过。
- [ ] **Step 3: 实现** 只改 `docs/reference.zh-CN.md` 和 `CHANGELOG.md`。`git diff --exit-code -- ROADMAP.md` 必须成功。`git status --short -- apps/hub/src/db/migrations` 必须为空。
- [ ] **Step 4: 跑** `npx vitest run --project @nema/hub reports evidenceEvents` 和 `npm run typecheck` → PASS。再跑 `git diff --exit-code -- ROADMAP.md README.md README.en.md README.zh.md README.ja.md`。README 这条只有在 Step 3 按 grep 结果改过坏句子时才允许非空；默认必须成功。
- [ ] **Step 5: Commit** `docs: describe evidence return without closing P1-07`

---

## 验收对照

| 验收 | 任务 |
|---|---|
| 1 旧 JSON 仍是已完成上报，旧 meta 仍显示三项 git | 1、4、11、12 |
| 2 进行中空提交 202，不排队，不套用；空的已完成仍 400 | 4、11 |
| 3 进行中上报后来到了主分支，只更新 check | 5 |
| 4 声称块和核实块分开，失败 check run 在主列表 | 12 |
| 5 按键合并，整段 `{ report, check }` 替换不再发生 | 3、5 |
| 6 作者不影响判定，界面没有允许或禁止 | 6、12 |
| 7 插件、gh、远程不满足时仍 202，`reasonCode` 符合枚举；无 pr 为 `not_requested` | 7 |
| 8 head 变化留历史；失败的当前观察不继承上一份成功 | 7、12 |
| 9 三语「提交已核对」加范围；「验收已确认」；不出现独立的「测试已通过」 | 12 |
| 10 `verified` 且 `confirmedBy` null 可以确认，commits 不变 | 2、8、12 |
| 11 自动路径不改用户确认；核对变了则 `acceptanceReview`；Agent 覆盖得到 409 | 5、9、10 |
| 12 只有用户确认的任务不能让需求变成「提交已核对」；全部 git 核对则 note 为 S4 | 10 |
| 13 失败 check run 不改变 git 三态 | 7、10、12 |
| 14 Agent 不能写 `confirmedBy: "user"`；无 `reportPassed` 不能写 `verified`；缺用户原话仍是 `user_basis_evidence` | 9（既有断言保持） |
| 15 `evidence_events` 不因上报或 GitHub 读取增加；`sourceRefs` 校验不变 | 13 |
| 16 `docs/reference.zh-CN.md` 写上新行为；README 不把未实现的能力写成已有 | 13 |
| 17 不标记 P1-07 完成；不实现「测试已通过」 | 13，以及上文「v1 明确不做」 |

## 本计划自己的非目标

本文件只排实现顺序。合入本文件不改变运行时行为，不改 `ROADMAP.md`，不改 `CHANGELOG.md`，不改 `docs/reference.zh-CN.md`。那些文档在任务 13，由实现该行为的人提交。
