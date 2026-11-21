# 桌面启动剩余项实施计划（#186，v0.3.1）

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were given authorizes it; otherwise leave changes for supervisor review.

**Goal:** 落实 #186 在 v0.3.1 的已定案范围：W1 渲染端首屏负载先测量后拆分（本计划唯一的生产代码改动）、W2 冷启动 DB 只评估并留记录、W3 按新口径收尾 P1-10 与 #186 的验收依据、W4 启动链剩余串行段只测量不改造。

**Architecture:**
- W1 在 `apps/web` 内完成：先用现有构建产物量出首屏 chunk 构成，再只把非首屏面板改成 `next/dynamic` 按需加载，沿用 `WorkspaceShell.tsx` 里 `AppSettings`/`WorkspaceSettings` 已有的拆分形态。首屏组件（`Chat`、`EntryDetail`、`KnowledgePanel`、`Sidebar`）保持静态，除非分析证据表明其中有可分离的非首屏部分。
- W2 不写代码：从 CI 平台 runner 的 `startup-sample` 输出收集样本，按规格口径算中位数，记录回 #186，并按 D-3 的两倍规则给出「触发/不触发另行立项」的结论。
- W3 只改文档与状态记录：ROADMAP P1-10 的验收行改写为 D-6 口径，#186 逐项对账。
- W4 不改生产代码（只给平台 job 补一条采样承载）：用 core 自身的 `startup-phase` 打点记录 lease 与 private-files 两段的量级，不动启动顺序。

**Tech Stack:** Next.js（`apps/web`）、TypeScript、Vitest、GitHub Actions（`verify.yml` 平台 job、`scripts/ci/startup-sample.mjs`）、`apps/local` 运行时测试。

**Spec:** [桌面启动速度与加载体验：剩余项与 0.3.1 范围](../specs/2026-11-18-desktop-startup-design.md)（D-1 到 D-7 已于 2026-11-18 由维护者全部按推荐定案）。产品判断标准：[#45](https://github.com/Nema-Project/nema-room/issues/45)。Issue：[#186](https://github.com/Nema-Project/nema-room/issues/186)。

**本计划如何服务 #45：** #45 要求打开共享房间这一入口可靠、可感知。本计划不新增功能：W1 只减少首屏等待且不改变任何呈现语义；W2/W4 产出的是带来源的数字证据，让「改或不改」成为可复核的决定而不是猜测；W3 把验收口径改成与维护者测试政策一致的可执行形式，并把主动放弃的证据（真实硬件打包数字）写明，不用 CI 样本冒充打包基准。

**Estimated size:** 6 个任务（1 个分析、1 个代码改动、2 个测量记录、1 个文档收尾、1 个验收关闭）。只有 Task 2 改生产代码。

## Global Constraints

- **已定案的 D 项是固定的**（规格，2026-11-18，全部按推荐）。只实现这些，不多不少：
  - D-1：0.3.1 只纳入 W1、W2、W3；W4 只测量不改造；已发布项（ACL、启动窗口、进度回传、web/DB 并行）不重开。
  - D-2：不做 ACL 校验合并/批量化，不做任何校验结果缓存；「合并进程、不合并校验」的已发布形态即定案。
  - D-3：冷启动 DB 只评估（W2）；沿用 2026-11-10 的 D-1 选 B（不预置数据目录、不跳迁移、不开 `relaxedDurability`）；只有 windows-latest 冷中位达到 Linux 数字约两倍时才另行立项，本计划内不实现预置目录。
  - D-4：维持同窗口 `data:` 启动文档，不做独立 splash 窗口。
  - D-5：阶段进度回传已实现，只登记状态，无工作。
  - D-6：验收口径正式改为「基准脚本 + CI 平台样本 + 自动化测试」；`desktop:bench` 保留为手工可选工具，引用其数字必须注机型与安装包 SHA，不作合并门槛；P1-10 据此收尾，并注明真实硬件打包数字未采集是按政策主动放弃的证据。
  - D-7：无记忆工作区的一跳保留 cookie 记忆路线，不做根页面 SSR/服务端重定向改造；本版只做确认性工作（骨架覆盖、无重复请求）。
- **安全不变量（规格四条，验收可查）**：每次打开仍实际执行 ACL 校验、无任何缓存；允许集合不变；失败即关闭、helper 拆解顺序不动；本计划 W1–W4 不触碰 `apps/cli/src/secrets/permissions.ts`、`apps/local/src/instance.ts` 的校验时机与 `apps/local/src/runtime.ts` 的 private-files 阶段。若实施中发现必须动，先停下来另写安全论证并单独评审，不并入本版顺手改。
- **证据政策**（维护者 2026-11-16）：不安排真实 Windows/macOS 硬件测试；数字来自基准脚本与 CI 平台 runner（`windows-latest`、`macos-latest`），行为来自自动化测试。静态检查、自动化测试与验收三种说法分开写，不互相冒充。
- **文案**：W1 预期不新增 UI 文案，`apps/web/messages/{en,zh,ja}.json` 不动；若拆分引入新的加载占位文案，三语必须同步补齐，缺一不可发布。
- **文档与变更记录**：Task 2 的 PR 带一个 `changelog.d/` 片段（`changed` 类别）；README 与 guide 不涉及（无安装/配置/用法变化）。ROADMAP 只改 P1-10 相关行，随 Task 5 的 PR 一起做。

## Review Focus

- Task 1 的分析必须区分首屏/非首屏：把等待从启动挪到首次点击不算收益，拆分清单要逐项给出依据。
- Task 2 前后 chunk 对照以同一构建口径量取（同命令、同机器），只报入口 chunk 与被拆 chunk 的字节数，不报无法复现的毫秒数。
- Task 3 的中位数口径不得偷工：样本必须来自至少 5 次独立的 `verify.yml` 运行，单次运行每平台只有一份冷样本，不许用单份日志充数。
- Task 3/4 的记录只写量级结论与原始数字出处（run id、job、平台），CI runner 数字不与用户机器数字混写。
- 任何任务都不得顺手改启动顺序、校验路径或 `startup-sample` 的测量内容；发现测量本身有问题，另开 issue 记录，不在本计划内修。

---

### Task 1: W1 首屏 chunk 分析（先测量）

**Spec:** W1、D-1、D-7。

**Files:** `apps/web` 构建产物（`npm run build -w apps/web` 的输出与 `.next/` 构建清单）；`apps/web/components/WorkspaceShell.tsx`（静态 import 在 :6-9：`Chat`、`EntryDetail`、`KnowledgePanel`、`Sidebar`；`AppSettings`/`WorkspaceSettings` 已是 `next/dynamic`，:12-13）。

**产出：** 一份分析记录（随 Task 2 的 PR 描述给出，或先贴 #186），含：
- 首屏入口 chunk 清单与字节数：`/` 与 `/w/[id]` 首次加载实际拉取的 JS，逐 chunk 列大小与主要来源模块。
- issue 点名的 v0.2.1 大 chunk（457KB 级）在当前构建里对应什么、还存不存在、由哪些依赖构成。
- 拆分候选清单：当前跟随 `EntryDetail` 等静态进入首屏的非首屏部分（图表、工作包详情等），逐项标注「拆/不拆」与依据（是否首屏可见、首次点击延迟是否可接受、是否已有骨架/占位）。
- 无记忆工作区一跳的确认结论：`listWorkspaces()` 是否只发起一次、骨架（`room-skeleton`）是否覆盖等待期（D-7 的确认性工作，只读代码与既有测试，不改行为）。

- [x] 在干净检出上运行 `npm run build -w apps/web`，保存构建输出的路由/chunk 表作为基线。
- [x] 从构建清单追出入口 chunk 的构成，定位大 chunk 的来源依赖，写成上表。
- [x] 逐项判定拆分候选，写明每项依据；没有值得拆的就如实写「不拆」，Task 2 相应缩小或跳过。
- [x] 核对 `WorkspaceShell` 无记忆路径的请求次数与骨架覆盖，记录结论。
- [x] 分析记录经评审确认后再进 Task 2；未确认的候选不拆。

### Task 2: W1 非首屏面板按需拆分（唯一的生产代码改动）

**Spec:** W1、D-1、D-7；安全不变量第 4 条（不触碰校验路径）。

**Files:** `apps/web/components/WorkspaceShell.tsx` 及 Task 1 清单点名的组件文件（`apps/web/components/` 下）；对应组件测试；`changelog.d/desktop-startup-lazy-panels.changed.md`（新增片段，每行以 `- ` 开头）。仅当引入新文案时才动 `apps/web/messages/{en,zh,ja}.json`（三语同步）。

**改动：**
- 把 Task 1 确认的非首屏面板改为 `next/dynamic` 按需加载，形态与现有 `AppSettings`/`WorkspaceSettings` 的拆法一致；加载占位沿用既有骨架/空占位，不新造视觉语言。
- 首屏组件保持静态 import；不改路由、不改 cookie 记忆路线、不改 `WorkspaceShell` 的跳转逻辑（D-7）。
- 不改任何数据请求语义：拆分前后同一面板的请求次数与时机（除代码加载外）不变。

- [x] 按 Task 1 清单逐项改 `next/dynamic`，每项单独可回退。
- [x] 被拆面板补/改组件测试：首次打开时按需加载并正常渲染，加载失败有既有错误呈现而非白屏。
- [x] 既有测试保持全绿：`WorkspaceShell` 骨架与直达行为、其余 `apps/web` 组件测试；运行 `npm run lint -w apps/web` 与 `npm run build -w apps/web`。
- [x] 用与 Task 1 相同的构建口径复测 chunk，给出首屏入口 chunk 字节数的前后对照，随 PR 描述给出。
- [x] 若出现新 UI 文案：三语 `messages/*.json` 同步补齐并在 PR 里点名；没有新文案则在 PR 里明说三语文件未动。
- [x] 加 changelog 片段；开 PR，描述写清分析依据、拆分清单、前后数字与未拆项的理由。

### Task 3: W2 冷启动 DB 评估记录（只评估，不写代码）

**Spec:** W2、D-3。

**Files:** 无代码改动。数据源：`verify.yml` 平台 job 日志中 `scripts/ci/startup-sample.mjs` 的 JSON 输出（`.github/workflows/verify.yml` :86 起的平台 job）。记录去向：issue #186 评论。

**口径（规格 W2，不得变通）：**
- 每个平台（`windows-latest`、`macos-latest`）跨最近至少 5 次独立的 `verify.yml` 运行收集冷样本，排序后取中间值（5 个样本取第 3 个）为冷中位；热样本同口径附记。先把样本数字的定义写死：`startup-sample.mjs` 并不调用 `createLocalDb`——它在 fresh process 里重演其两步（`new PGlite(dir)` 并等 `waitReady` 得 `readyMs`，再跑 hub 的 `migrate` 得 `migrateMs`），本计划以其 `totalMs` 作为 `createLocalDb` 总时长的代理量；下文「冷/热总时长」一律指这个 `totalMs`，2026-11-10 的 Linux 基线同为 ready + migrate 的分解数字、同一口径可比，D-3 的两倍判定也只对 `totalMs` 做。
- 对照基线：2026-11-10 设计在 Linux 主机上的数字——冷中位 1605ms、热中位 264ms（其中迁移约 102/61ms）。
- D-3 判定：windows-latest 冷中位达到 Linux 冷中位约两倍（≈3210ms 量级）→ 结论为「触发」，另行立项讨论预置数据目录（2026-11-10 的 D-1 方案 A）及其恢复方案；未达到 → 结论为「不触发」，维持选 B，本项关闭。

- [x] 用 `gh run list` / `gh run view --log` 找到最近至少 5 次含平台 job 的 `verify.yml` 运行，逐次提取两平台的 `startup-sample` 冷/热总时长，保留 run id 出处。
- [x] 按口径算两平台冷中位与热中位，与 Linux 基线并列表格。
- [x] 写 D-3 结论（触发/不触发及数字依据），注明 CI runner 数字含量级意义、性能波动大，只比量级。
- [x] 把表格与结论作为评论贴到 #186（GitHub 写入需当次任务授权；无授权时把评论全文交维护者贴）。
- [x] 若结论为「触发」：另开一个 issue 记录立项意向与本评估链接，不在本计划内做任何预置目录实现。

### Task 4: W4 串行段测量记录（只测量，不改造）

**Spec:** W4、D-1（只测量不改造）；安全不变量第 4 条。

**Files:** 不改生产代码；唯一的仓库改动是给 W4 补测量承载：新增 `scripts/ci/startup-phase-sample.mjs` 与 `.github/workflows/verify.yml` 平台 job 的一个采样步骤。数据源：core 自身写到 stdout 的 `startup-phase` JSON 行（`apps/local/src/runtime.ts` :428 的 `lease`、:503 的 `private-files`；每行 `ms` 是自 `startedAt` 起的累计值，不是单段时长）。先纠正一处旧说法：`apps/local/test/runtime.test.ts` 只在 Linux 的 unit 分片里运行，不在平台 job 内，其 `startupPhases` 助手解析出的 ms 只供测试内断言、不落任何记录——平台 job 今天不产 `startup-phase` 样本，它只能作行格式的参照，不能作本项来源；`NEMA_LOCAL_CORE_LOG` 落盘是打包/手工路径的手段，同样不作 CI 来源。本项的采样路径就是新增的那一步：新脚本仿 `startup-sample.mjs` 的形态（fresh 子进程 + tsx，一次性临时目录），用与 `runtime.test.ts` 的 `testAssets()` 相同的造法备假 assets 与一次性 home，进程内启动一次 `startLocalRuntime`，让 `startup-phase` 行原样落到 stdout 后关闭运行时；平台 job 在两平台各跑一次，行随 job 日志保存，记录引 run id 为出处。这是新增采样承载，不改 `startup-sample` 的测量内容、不改启动顺序与校验路径。`scripts/ci/startup-sample.mjs` 不产 `startup-phase` 行，不作本项来源。

**产出：** 一条记录（贴 #186 或随 Task 5 的 PR），含 lease 与 private-files 两段在 CI 平台 job 中的量级（平台、样本出处、段时长范围/中位），以及与 issue 旧表（v0.2.1、含旧 ACL 行为，合计约 1.2–1.8s）的对照说明。

- [x] 落地采样路径（见上）：脚本与平台 job 步骤就位后，从最近至少 5 次平台 job 运行的采样步骤输出中提取各阶段累计 `ms`，相邻相减得段时长——lease 段 = `lease.ms` − `helper-scope.ms`，private-files 段 = `private-files.ms` − `lease.ms`；`ms` 是累计值，直接当段时长会把前段重复计入。
- [x] 按平台汇总量级，注明样本数与出处（run id）。
- [x] 写明结论：两段在新数字里是否仍占启动大头；无论结论如何，本版不改顺序、不做优化——若占大头，只建议下一版立项。
- [x] 记录贴到 #186（授权要求同 Task 3）。

### Task 5: W3 验收口径收尾（P1-10 与 #186 对账）

**Spec:** W3、D-6。

**Files:** `ROADMAP.md`（P1-10 条目）；issue #186 的对账评论。`scripts/desktop/bench-startup.mjs` 与 `scripts/ci/startup-sample.mjs` 本身不改。

**改动：**
- P1-10 验收行改写为 D-6 口径：Electron 侧行为由 lifecycle 自动化测试 + `desktop-mark` 打点覆盖；平台 DB/ACL 数字由 `startup-sample` 在 CI 平台 runner 持续记录（注明它只测 fresh-process 的 PGlite 就绪 + 迁移总时长——即 `createLocalDb` 两步的代理量，定义见 Task 3 口径——与 Windows ACL 微基准，不启动 core、不产 `startup-phase` 行）；core 各阶段时长来自 core stdout 的 `startup-phase` 行，由 `desktop:bench` 从 core 日志解析、由本地运行时测试解析断言；`desktop:bench` 为手工可选工具，引用数字注机型与安装包 SHA，不作合并门槛。
- 改写中明说口径取舍：打包态的 Electron 启动、`requireSystemGit`、首帧时间继续没有数字；打包应用在真实用户硬件上的冷/热数字仍未采集，是按维护者 2026-11-16 测试政策主动放弃的证据，不是遗漏。
- Task 1–4 的证据齐备后，P1-10 状态按 ROADMAP 状态词改为已完成（完成标记只依据验收证据，不因单个子任务落地提前标）。
- #186 按新口径逐项对账：issue 五个问题逐条写明「已由哪个 PR/哪条证据关闭」或「剩余什么、归哪个任务/新 issue」。

- [x] 起草 P1-10 改写文本，逐句核对与 D-6 一致、与 `startup-sample`/`desktop:bench` 的实际测量范围一致（不夸大 sample 的覆盖面）。
- [x] Task 1–4 证据齐备后提交 ROADMAP 改动（随本任务的文档 PR），状态改为已完成。
- [x] #186 对账评论逐项写完（授权要求同 Task 3）。

### Task 6: 验收与关闭 #186

**Spec:** 规格「验收」一节、D-1、D-6。

**关闭 #186 需要齐备的证据（逐项核对，缺一不可）：**
- W1：以下两条满足其一即可——(a) Task 2 的 PR 已合并，含 chunk 前后对照（首屏入口 chunk 字节数可查）、被拆面板的按需加载测试、`apps/web` 既有测试与 lint/build 全绿；无新文案或三语文案齐备。(b) Task 1 分析经评审确认没有值得拆的候选、Task 2 按 Task 1 的约定跳过：以该分析记录（逐项不拆依据，以及 D-7 确认结论——`listWorkspaces()` 只发起一次、骨架覆盖等待期）加 `apps/web` 既有测试与 lint/build 全绿作为 W1 的关闭证据。
- W2：#186 上有 Task 3 的评估记录（两平台 ≥5 次运行的冷/热中位、Linux 对照、D-3 触发/不触发结论）。
- W3：ROADMAP P1-10 已按新口径改写并标已完成；#186 对账评论齐备。
- W4：#186 上有 Task 4 的 lease/private-files 量级记录（只测量，无改造声明属实——本计划所有 PR 的 diff 不含启动顺序与校验路径改动）。
- 回归线（既有能力不许退，全部由既有自动化测试承载、CI 平台 job 运行）：窗口在 `ensureLocalRuntime` 返回前已显示且背景色随主题；启动失败时错误出现在启动窗口文档内而非只有模态框；子进程回报 `db` 阶段时启动文档显示对应文案；web 被挡住时 `startup-phase` 的 `db` 可早于 `web`；Windows 上一次启动内 ACL helper 启动次数为每进程 1 次、校验逐次执行且无缓存，次数按描述文件状态区分（无残留时 8 次；残留有效描述文件时读取与清除各多执行校验、至少多 3 次，口径见规格「验收」回归线），放宽 ACL 后再次打开仍抛 `cannot verify private Windows ACL`。
- 诚实限定随关闭评论写明：issue 的「点击后 1s 内出现启动画面」只以 lifecycle 测试中「窗口先于 core 就绪显示」的既有断言为据，未在真实硬件上复测；打包数字未采集是政策性放弃（D-6）。

- [ ] 逐项核对上列证据，缺项回到对应任务补齐，不降低标准凑关闭。
- [ ] 在 #186 发关闭评论：逐项列证据链接（PR、CI run、评估记录、ROADMAP 行），并写明诚实限定。
- [ ] 关闭 #186（GitHub 写入需维护者授权；无授权时把关闭评论全文交维护者执行）。
- [ ] ROADMAP v0.3.1 范围节中 #186 一行按验收结果更新状态。
