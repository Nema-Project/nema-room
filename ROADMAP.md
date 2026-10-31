# 项目路线图与验收台账

更新日期：2026-10-31（Asia/Tokyo）

本文件承接仓库评估中提出的 TODO，作为当前待办入口。它是建议的稳定化顺序，不代表全部问题已复现，也不代表已承诺交付日期。历史设计和评审保留在 `docs/superpowers/` 与 `docs/reviews/`；遇到冲突，应以对应提交的源码、CI 和验收证据为准。

## 当前阶段与证据

项目已形成“讨论 → 知识归档 → 开发包批准 → 编码 Agent 接手 → 提交回报”的功能链路，当前重点是公开预览版的稳定化。

- [v0.1.2](https://github.com/Nema-Project/nema-room/releases/tag/v0.1.2) 已发布 Windows x64 与 macOS ARM64 安装包及校验清单。
- 该版本对应提交的[完整 CI](https://github.com/Nema-Project/nema-room/actions/runs/40307045900)在 npm test 失败，但[发布工作流](https://github.com/Nema-Project/nema-room/actions/runs/40307052077)成功。失败原因需要另行定位，不能直接归因为产品缺陷或测试抖动。
- 后续提交已有[完整 CI 成功记录](https://github.com/Nema-Project/nema-room/actions/runs/40309633322)，它不替代发布提交自身的验证。
- [真实 Agent 线程验收](docs/reviews/2026-10-26-thread-agent-script.md)记录为 not run：模型连接失败，未完成语义验收。该条是 2026-10-26 的历史记录。2026-10-27 的修复后脚本已由 Codex direct 与 Claude 各跑两次，均为退出码 0、12/12，见 [PR #26 评论](https://github.com/Nema-Project/nema-room/pull/26#issuecomment-6434135887) 与 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md)。
- [历史桌面验收](docs/reviews/2026-10-24-desktop-validation.md)只证明其记录的提交与环境；其中“尚未发布”等结论已经过时。
- 已合入 `main` 的近期工作：[PR #29](https://github.com/Nema-Project/nema-room/pull/29) macOS 原生红绿灯（`5ff8cf9`）；[PR #30](https://github.com/Nema-Project/nema-room/pull/30) 落实 [issue #28](https://github.com/Nema-Project/nema-room/issues/28) 的用户 basis 证据检查（`afd1456`）；[PR #31](https://github.com/Nema-Project/nema-room/pull/31) 桌面包瘦身（`76680b8`）。
- 本次评估通过 GitHub 读取源码、配置、Actions 和 Release；未本地重跑测试。开始每项工作前须重新检查最新状态。

## v0.2.0 发布与后续验收

v0.2.0 是 v0.1.6 之后的一次功能大版本：附件、`@` 提及、Skills 渐进载入与手动调用、MCP 配置与生命周期、插件页分区，以及发布机制第 3 期（tag 只验证，`release-promote` 翻指针）。

发布记录：

- tag `v0.2.0` 是 annotated tag `8d2b107bc6701a59832086080e387e81e306ed17`，解引用到 `3d676f21bac8895859016ac200fd5ef1f39a5d4f`（`release: prepare v0.2.0`，[PR #154](https://github.com/Nema-Project/nema-room/pull/154) 的合并提交）；该提交的 [main CI](https://github.com/Nema-Project/nema-room/actions/runs/41163721788) 成功。
- 三条 tag 工作流均成功：[npm](https://github.com/Nema-Project/nema-room/actions/runs/41167014904)（`Publish to npm` 按设计 skipped，只打包与冒烟）、[镜像](https://github.com/Nema-Project/nema-room/actions/runs/41167014878)、[桌面](https://github.com/Nema-Project/nema-room/actions/runs/41167014880)（只建 draft Release）。
- tag 之后、晋升之前：Release 是 draft（8 个资产，其 `docker-compose.yml` 已是 0.2.0 双 pin 且带版本头）；`npm view` 仍为 0.1.6；两个 GHCR 的 `latest` digest 与 0.1.6 完全相同；`releases/latest/download/docker-compose.yml` 仍是 0.1.6 双 pin。
- 只读检查 `npm run release:verify -- 0.2.0` 在晋升前：**退出 1**，唯一 `MISSING` 是 npm（`npm has no @nema-project/nema@0.2.0`），`images` 与 `release` 为 ok，`consistency` 因 npm 未就绪标注 `UNKNOWN` 并跳过。
- `release:verify -- --pointers 0.2.0` 的前后对照：晋升前 npm latest / ghcr hub latest / ghcr web latest / github latest 全部为 `0.1.6` 且均判定 `-> move`；晋升后四项全部为 `0.2.0`。
- 晋升：`gh workflow run release-promote.yml --ref main -f tag=v0.2.0`，[run 41170238828](https://github.com/Nema-Project/nema-room/actions/runs/41170238828)。**第 1 次 attempt 失败并 fail-closed**：npm 发布子运行 [41170270882](https://github.com/Nema-Project/nema-room/actions/runs/41170270882) 成功，但 promote 在其后约 18 秒回读 registry，此时包仍处于索引中，于是以 `npm publish run finished but the registry does not hold the expected tarball` 停止，`flipped by this run: none`；只重跑失败的 job 后 attempt 2 成功。这一时序缺口已记录为 [#158](https://github.com/Nema-Project/nema-room/issues/158)（milestone v0.2.x），本版不因此重新晋升。
- 晋升后 `release:verify -- 0.2.0` **退出 0**：npm integrity 为 `sha512-Z3rZ07LiIlD/…`，镜像 hub `sha256:ab15013e…` / web `sha256:69741449…`，Release 已公开且 `docker-compose.yml` pin 0.2.0，`consistency` 认定 tag、release manifest 与 npm provenance 同为 `3d676f21…`。
- Release 于 2026-10-31 04:58:18 UTC 公开；`releases/latest/download/docker-compose.yml` 由 0.1.6 双 pin 变为 0.2.0 双 pin，并带版本头（`# Nema Room 0.2.0 release asset.`）。

发布可用性不等于功能或真机验收完成：

- 真模型验收已在 2026-10-31 完成（OpenRouter 免费模型，`codex-direct` + `byok`）：附件图片逐字读到暗号；`@` 提及的条目、附件、话题四项通过，daemon 离线时提及照常保存，引用超过 8 个附件时发送被拒。记录见 [#104 评论](https://github.com/Nema-Project/nema-room/issues/104#issuecomment-6537654518)、[#136 评论](https://github.com/Nema-Project/nema-room/issues/136#issuecomment-6537656356) 与[附件验收记录](docs/reviews/2026-10-30-attachments-model-acceptance.md) 第 8 节。没有免费模型声明 `file` 输入，PDF 未实测；`claude-code` 与 `siwc` 两种运行方式未做真模型验收。
- Windows x64 与 macOS arm64 安装包的真机安装、覆盖升级、启动与旧数据保留仍待验证；不能用 v0.1.6 的验收代替。
- 不自动升级：依赖 `^0.1.x` 不会解析到 0.2.0，升级需显式安装，见 CHANGELOG 的 0.2.0 节。

## v0.1.6 发布与后续验收

v0.1.6 已公开发布：tag `v0.1.6` 指向 `280b224589ae13d4db99a4481bcd0baf58cf273d`，该提交的 [main CI](https://github.com/Nema-Project/nema-room/actions/runs/40994815874) 成功；[npm](https://github.com/Nema-Project/nema-room/actions/runs/40996073785)、[镜像](https://github.com/Nema-Project/nema-room/actions/runs/40996073787) 与[桌面](https://github.com/Nema-Project/nema-room/actions/runs/40996073896)发布工作流均成功。发布可用性不等于功能或真机验收完成：

- 这是第一个带固定名 `docker-compose.yml` 资产的版本。2026-10-30 实测 `releases/latest/download/docker-compose.yml` 跟随跳转后返回 200，双镜像钉在 `0.1.6`，与 `SHA256SUMS-0.1.6.txt` 里的哈希一致；`npm view @nema-project/nema version` 为 `0.1.6`；两个 GHCR 镜像的 `0.1.6` 与 `latest` 可匿名读到；`node scripts/install/public.mjs --check` 四项齐。公开安装链接据此由发布机制第 2 期任务 10 切到该固定名资产。
- Windows x64 与 macOS arm64 安装包的真机安装／覆盖升级、启动、一次 Graphify、退出与旧数据保留仍待验证；CX-03 最终验收继续跟踪。维护者已选择快速迭代，这些未完成验收不阻塞小版本。

## v0.1.5 发布与后续验收

v0.1.5 已公开发布：npm、hub/web 镜像与桌面产物的发布流水线成功，包完整性、镜像匿名访问及桌面下载校验已验证。公开安装入口已由 PR #65 切到 v0.1.5。发布可用性不等于功能或真机验收完成：

- Windows x64 与 macOS arm64 安装包的真机安装／覆盖升级、启动、一次 Graphify、退出与旧数据保留仍待验证；记录安装包 SHA，不能用旧版本的验收代替。
- CX-03 最终验收作为后续事项继续跟踪；不因实现已合入或产物已发布就标记完成。维护者已选择快速迭代，不用这些未完成验收阻塞无关的小版本或安装文档修正。
- v0.1.5 tag 指向 `d765122b9dabf19b79d75b9006cea68a6ca8aeef`，该提交的 main 完整 CI 已通过；npm、镜像与桌面发布结果分别验证。
- 公开安装使用 v0.1.5 tag 的 Compose 和同版 daemon；tag 内的发布前注释仍称候选版，这是不可变历史说明，当前安装以 README/指南为准，实际镜像 pin 正确，不移动 tag；hub/web 镜像已验证匿名访问及发布后 pull/smoke。main 可能领先于公开产物，开发走 `npm run up` 源码构建。
- 新版本不自动撤下旧版分发物。后续版本仍分别检查包、镜像和桌面产物的发布可用性。

## 优先级与维护规则

- **P0**：建议下一次公开发布前闭环。
- **P1**：下一轮稳定化迭代。
- **P2**：稳定化后的能力扩展。
- 状态统一使用：待核实、待办、进行中、阻塞、已完成、延期。
- 所有负责人暂为“待认领”；除下一条版本映射已写明的事项外，目标版本暂未承诺。认领时补充负责人、Issue/PR 和目标版本。
- 2026-10-31 起的版本映射：v0.2.x 承载轻量化发布（P2-09）与 0.2 系列小修；v0.3.0 承载只读分享知识库（P2-04 第一期）；v0.4.x 承载依赖大版本升级（P2-07）。
- 只有满足验收标准并附上对应提交、测试或人工验收记录，才能标记已完成。变更优先级或延期时记录原因。
- 发布前更新本文件，并同步 README、CHANGELOG、SECURITY 与官网。历史报告不改写为新的验收结果。
- 同步与团队功能尚未具备前置条件时，不与稳定化任务同时扩张。

## 产品北极星

产品方向以 [issue #45](https://github.com/Nema-Project/nema-room/issues/45) 为北极星：Nema Room 是项目对齐副驾，帮助人和编码 Agent 持续理解项目在做什么、决策为何如此、还有什么没有定。该 issue 是对齐参考，不是已交付能力清单，其中的想法也不都已排期。

评估新功能或架构变更时先问：这是否让人和 Agent 更容易维持一份有证据、且随项目演进而更新的共同理解？如果不是，先说明它为什么属于 Nema Room，再排优先级。新增事项和 spec 应写明如何服务于这条规则。发布、打包和分发算稳定化，不算产品方向。

## P0：发布前闭环

| ID | 事项与依据 | 状态 | 验收标准 |
| --- | --- | --- | --- |
| P0-01 | 发布绑定完整 CI；已有同一提交测试失败但发布成功的记录 | 进行中 | 发布提交通过完整测试；tag 可追溯到主线；测试失败或缺失时发布被阻止；以失败场景验证门禁 |
| P0-02 | 核实并强制合并检查。2026-10-30 用 API 读到的实际规则：ruleset `25873388`（`main pull request`，active，目标默认分支，无 bypass actor）要求 PR（0 名审批、`require_extra_approval_for_unattributed_changes: true`，允许 merge / squash / rebase），必过检查只有 `{context: "CI gate", integration_id: 15368}`，`do_not_enforce_on_create: false`；`strict_required_status_checks_policy` 已由维护者按 [规格 D-9](docs/superpowers/specs/2026-10-27-pr-ci-fast-gate-design.md) 改为 false（ruleset 更新于 2026-10-27 22:24 JST，晚于 PR #51 合并后 `main` 全量 CI [40509850472](https://github.com/Nema-Project/nema-room/actions/runs/40509850472) 22:21 JST 的成功，顺序符合 D-9）。ruleset `25809837`（`main`，deletion 与 non_fast_forward）仍为 disabled，即不拦删除和强推；传统分支保护接口返回 404 Branch not protected。已有证据：检查未完成时被拦，PR [#93](https://github.com/Nema-Project/nema-room/pull/93) 推送 `ae50f86` 后、检查尚未上报时 `mergeStateStatus` 为 BLOCKED（2026-10-30 12:51 JST）；文档变更不会永久等待，纯文档 PR [#91](https://github.com/Nema-Project/nema-room/pull/91) 的重型任务跳过、`CI gate` 成功并已合并。还差：一次 `CI gate` 失败时 PR 被拦（BLOCKED 或合并被拒）的记录 | 进行中 | 记录实际保护规则；需要的检查未完成或失败时不可合并；文档变更与路径过滤不会造成检查永久等待 |
| P0-03 | 修复后的线程验收脚本上，Codex direct 与 Claude 各跑两次，均为退出码 0、12/12。证据：[PR #26 评论](https://github.com/Nema-Project/nema-room/pull/26#issuecomment-6434135887)、[执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) | 已完成 | 跑通只读总结、讨论后决策、无结论线程、冲突澄清、明确推翻旧决策；记录模型、适配器、提交、消息、知识变更与工具轨迹；Codex direct 和 Claude 分别记录结果 |
| P0-04 | 数据目录升级与备份恢复已在 Windows 与 macOS 托管运行器通过；2026-10-27 维护者在 macOS 与 Windows 上手动覆盖安装后，workspace 数据均完整。证据：[执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) | 已完成 | 使用含聊天、线程、开发包、知识 Git 历史的旧版数据升级；核对数据完整性；模拟升级失败并从备份恢复；Windows 与 macOS 分别记录 |
| P0-05 | 私密报告已启用。read 权限、非管理员协作者于 2026-10-27 12:18（Asia/Tokyo）提交测试报告并进入 triage，12:27 关闭且未发布。证据：[GHSA-mgcq-mcqv-75ff](https://github.com/Nema-Project/nema-room/security/advisories/GHSA-mgcq-mcqv-75ff)、[执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) | 已完成 | 修正文档，配置并验证私密报告渠道，明确桌面支持版本；避免引导用户在公开 Issue 提交敏感漏洞细节 |

## 下一项

P0-01 与 P0-02 仍在进行中。连接器侧的下一项是 CX-03：实现已由 PR #54 合入，仅待最终验收；设计已随 [PR #27](https://github.com/Nema-Project/nema-room/pull/27) 合入，实施前置 [issue #28](https://github.com/Nema-Project/nema-room/issues/28) 已由 [PR #30](https://github.com/Nema-Project/nema-room/pull/30) 完成。它不代替 P0-01、P0-02。

| ID | 事项与依据 | 状态 | 验收标准 |
| --- | --- | --- | --- |
| CX-03 | 外部来源证据协议。契约见 [spec](docs/superpowers/specs/2026-10-27-source-evidence-protocol-design.md) 与 [plan](docs/superpowers/plans/2026-10-27-source-evidence-protocol.md)。#28 已合入，协议实现已由 PR #54 合入，仅待最终验收 | 进行中 | 已实现 `sourceRefs`、`evidence_events` 与内部 `source__import`，待整体验证；保留 #28 的用户 basis 检查，以及从 `superseded`、`dropped`、`resolved` 改回 `active` 的检查；不得把外部正文伪装成聊天消息 |

## P0 之后

| ID | 事项与依据 | 状态 | 验收标准 |
| --- | --- | --- | --- |
| 32 | [manager agent 工作流场景与现状差距](https://github.com/Nema-Project/nema-room/issues/32)。这是设计参考，不是 spec | 待办 | 落地前另走 spec、plan、实现和测试；不改变 P0 顺序；与 P1-07 对 `verified` 的区分分开记录 |

## P1：稳定化迭代

| ID | 事项与依据 | 状态 | 验收标准 |
| --- | --- | --- | --- |
| P1-01 | 将备份和迁移库接口做成可用 CLI 或 UI | 待办 | 提供预检查、备份、导入、错误说明与恢复入口；真实 PostgreSQL 导出到空桌面目录完成往返验证；拒绝运行中或非空目标；不迁移凭证 |
| P1-02 | Git 知识文件与数据库索引对账 | 待办 | 文档定义各类数据的权威来源；检测缺项和陈旧索引；安全重建可派生索引；覆盖写入中断和进程崩溃后的恢复 |
| P1-03 | 补足桌面平台验收；macOS 发布 smoke 目前仅运行 staged runtime | 待办 | macOS 实际 DMG 安装、Finder 启动、退出及后台进程清理通过；Windows 升级、卸载保留数据通过；记录干净机器与权限条件 |
| P1-04 | 认证与临时凭证权限复核 | 待核实 | 评估 SIWC ID token 的签名验证与信任边界；实测 Windows Claude run 目录及含 run token 的 mcp.json 有效 ACL；必要时接入统一私密文件写入机制；记录复现及回归测试 |
| P1-05 | 开发包使用语言无关的结构化协议；wpFormat.ts 当前依赖中文标题与字段 | 待办 | 定义有版本的 schema 存储任务、文件、需求关联；中英日 Markdown 仅用于展示；兼容旧开发包；验证批准撤销与回报关联仍正确 |
| P1-06 | 同步版本与验收文档 | 待办 | README、官网、CHANGELOG、SECURITY 对齐实际发布；各历史报告注明适用提交；新增当前验收矩阵而非将旧记录视为现状 |
| P1-07 | 区分实现证据与需求验收；现有 verified 不代表测试或验收通过 | 待办 | 明确“提交已核对”“测试已通过”“验收已确认”的状态及证据来源；兼容现有数据；用户不会将 Git 核对误认为需求完成 |
| P1-08 | 完善 CI 分层和桌面运行时变更覆盖。规格见 [fast-gate spec](docs/superpowers/specs/2026-10-27-pr-ci-fast-gate-design.md)，计划见 [fast-gate plan](docs/superpowers/plans/2026-10-27-pr-ci-fast-gate.md) | 进行中 | 保留 PR 检查及发布前完整打包；local/hub/cli/web 运行时改动有适当集成检查；依赖变更的打包风险有明确检查策略；避免无必要重复跑重型任务 |
| P1-09 | [#63](https://github.com/Nema-Project/nema-room/issues/63) 发布去版本耦合。规格见 [release mechanics spec](docs/superpowers/specs/2026-10-28-release-mechanics-design.md) | 进行中 | 第 1 期（单点盖印 + changelog 片段）已由 [PR #70](https://github.com/Nema-Project/nema-room/pull/70) 合入（`954a8c3`）。第 2 期基本落地：[plan](docs/superpowers/plans/2026-10-28-release-mechanics-phase2.md)（[PR #79](https://github.com/Nema-Project/nema-room/pull/79)），以及 [PR #80](https://github.com/Nema-Project/nema-room/pull/80) Compose 模板与固定名资产、[PR #81](https://github.com/Nema-Project/nema-room/pull/81) 安装说明、[PR #83](https://github.com/Nema-Project/nema-room/pull/83) 整套产物校验与锁定版本安装。v0.1.6 是第一个附带 `docker-compose.yml` 资产的版本，已于 2026-10-30 发布；它的 release PR [#89](https://github.com/Nema-Project/nema-room/pull/89) 没有改 Compose、站点、README 和指南里的版本号。第 2 期任务 10 已由 [PR #92](https://github.com/Nema-Project/nema-room/pull/92) 合入（`a869b2c`），公开安装链接改为 `releases/latest/download/docker-compose.yml`。第 3 期：[plan](docs/superpowers/plans/2026-10-30-release-mechanics-phase3.md)（[PR #102](https://github.com/Nema-Project/nema-room/pull/102)，`d01babf`）；第一步只读检查 `npm run release:verify -- <x.y.z>` 已加入，2026-10-30 对 v0.1.6 回溯运行退出 0、对 v0.1.5 退出 1 并点名缺 `docker-compose.yml`，这是演练，不算规格要求的「第一步上线后的一次真实发布」。第 3 期第二步已由 [PR #112](https://github.com/Nema-Project/nema-room/pull/112) 合入（`de5347e`）：tag 推送只做验证、打包和冒烟：不再发布 npm、不公开 GitHub Release、不移动 GHCR `latest`（image-publish 仍照常推送版本号镜像 tag）；新增 `release-promote.yml`，由维护者从 main 触发，按 npm → 最终校验 → 两个 GHCR `latest` → GitHub Release 的顺序晋升。2026-10-30 对 v0.1.6 做了不打 tag 的演练（任务 14 第 2 步）：[run 41045206706](https://github.com/Nema-Project/nema-room/actions/runs/41045206706) 成功，维护者检查通过；preflight 认定 image-publish 与 desktop-release 的 push 运行全部通过；summary 逐项为已完成（npm 0.1.6 已是预期 tarball、hub/web `latest` 已是 0.1.6 的 digest、Release 已发布且为 latest），结尾 `promote v0.1.6: done`。演练没有 dispatch npm-publish（该工作流没有 workflow_dispatch 运行），npm dist-tags、两个 `latest` digest 和 Release 的 `updated_at` 与演练前一致，`release:verify -- 0.1.6` 前后都退出 0；唯一写入是该运行自己的 `promote-binding` 产物。剩余：下一次真实发布的只读报告无误报；第一次真实发布时观察 npm dispatch 链路与 trusted publishing（任务 14 第 3 步、任务 15）；后续加固：npm-publish 的直接 dispatch 不核对发起者身份、`same` 路径不核对 `maintenance` dist-tag、晋升中途被 tag 工作流重跑打断时会留下部分窗口（重跑可补完）。spec 的问题 1、问题 2 已由维护者在 2026-10-28 选定，均为 A |

## P2：后续能力

| ID | 事项 | 状态 | 验收标准与前置条件 |
| --- | --- | --- | --- |
| P2-01 | 签名、公证与更新体验 | 待办 | 正式签名与 macOS 公证可验证；P0-04 已于 2026-10-27 完成，再设计自动更新、失败恢复与版本兼容。版本号展示和只读的稳定版提示（issue #35）不计入本项 |
| P2-02 | 规模与可诊断性 | 待办 | 建立大仓库、长会话、大量知识条目的耗时和资源基线；提供脱敏诊断导出；确保不含 token、密钥或默认导出私有讨论内容 |
| P2-03 | 多设备同步 | 待办 | 先完成备份恢复与数据权威来源定义；设计冲突解决和一致性模型，再确定实现范围 |
| P2-04 | [#165](https://github.com/Nema-Project/nema-room/issues/165) 只读分享知识库（P2-04 第一期 viewer，v0.3.0）。第一阶段只做分享链接的只读浏览，不做账号、登录与成员表；完整身份模型（users / workspace_members / messages.author_user_id、按人授权与撤销）留到后续阶段 | 进行中 | 先设计身份、授权、撤销与审计；不得直接把当前单用户本地服务暴露为多人服务。2026-10-31 收窄为第一期只读分享：分享链接可撤销、撤销后立即失效，只暴露知识条目，不暴露聊天/任务/附件/设置；完整身份模型留到后续阶段。 |
| P2-05 | [#25](https://github.com/Nema-Project/nema-room/issues/25) 外部连接器 Epic。设计见 [connector architecture v0.2](docs/design/connector-architecture-v0.2.md) | 进行中 | CX-01、CX-03 已实现，CX-03 待最终验收；CX-02、CX-04、CX-05、CX-06、CX-07、CX-08、CX-09、CX-10 尚未开始 |
| P2-06 | [#75](https://github.com/Nema-Project/nema-room/issues/75) 扩展管理：Skills/MCP/插件的安装、卸载与启停。规格见 [extension management spec](docs/superpowers/specs/2026-10-25-extension-management-design.md)，计划见 [extension management plan](docs/superpowers/plans/2026-10-25-extension-management.md) | 进行中 | 已完成：启停（[PR #84](https://github.com/Nema-Project/nema-room/pull/84)）；卸载受管扩展、移出外部项，内置项不可卸载（[PR #85](https://github.com/Nema-Project/nema-room/pull/85)）；GitHub / skills.sh 来源钉到固定提交后预览（[PR #86](https://github.com/Nema-Project/nema-room/pull/86)）；按钉住的提交安装 Skill，带进度、取消、重试，重启时把未完成的安装标为中断（[PR #87](https://github.com/Nema-Project/nema-room/pull/87)）；插件页安装入口（[PR #88](https://github.com/Nema-Project/nema-room/pull/88)）；聊天里的安装卡片，需用户确认，与页面走同一服务（[PR #90](https://github.com/Nema-Project/nema-room/pull/90)）。剩余：已安装 / 发现分区、类型筛选与搜索；外部项接入；内置项修复；Skills 渐进载入；MCP 的 stdio / HTTP 配置、本机凭据保管与启停。进度见 [#75 评论](https://github.com/Nema-Project/nema-room/issues/75#issuecomment-6514317610) |
| P2-07 | [#56](https://github.com/Nema-Project/nema-room/issues/56) 依赖体检的剩余项：ESLint 9→10、TypeScript 5.9→7、Node 22→24，以及内置 Python 从 3.11 换线到 3.13/3.14。该 issue 中的桌面 Python 升 3.11.18、基础镜像 trixie 化与移除 Vue 图标已由 PR #57、#58 完成。2026-10-31 排期改为 v0.4.x（原与轻量化发布一同放在 v0.3.0） | 待办 | 各升级单独 PR；内置 Python 换线需按 spec/plan 单独立项。范围以该 issue 为准 |
| P2-08 | [#50](https://github.com/Nema-Project/nema-room/issues/50) hub/web 镜像增加 linux/arm64（多架构 manifest） | 待办 | 范围以该 issue 为准 |
| P2-09 | [#132](https://github.com/Nema-Project/nema-room/issues/132) 轻量化发布：大组件按需下载与离线组件包。2026-10-31 从 v0.3.0 提前到 v0.2.x | 待办 | 按 #132 的 spec 与验收标准；开工前先写 spec，D 项由维护者决定 |

## 仓库演进原则

1. 保留现有 monorepo。shared、knowledge、hub、cli、local、desktop、web 的边界有用；没有大规模重写的依据。
2. 围绕主流程建立版本级回归：讨论、归档、批准开发包、Agent 执行、回报、验收。新增功能应说明对这条流程的价值。
3. 修改集中模块时逐步分离启动编排、HTTP 路由、业务规则与持久化，优先关注 local/runtime、hub/uiApi、knowledge/store；不以文件长度单独决定重构。
4. CI 成功、打包成功、真实模型验收、人工平台验收分别记录，不能互相替代。
5. 未复现的风险先核实；源码存在某种写法不等于已证实可利用漏洞。

## 执行记录

新增或完成任务时追加一行，详细证据留在对应 Issue、PR 或 reviews 文档中。

| 日期 | 任务 ID | 负责人 | Issue / PR | 目标版本 | 状态与证据 |
| --- | --- | --- | --- | --- | --- |
| 2026-10-26 | 全部 | 待认领 | 待补充 | 未承诺 | 建立建议清单；未执行实现任务 |
| 2026-10-26 | P0-01/02/05 | Codex | 实现分支 codex/p0-release-assurance | 未承诺 | Native 实现与验证进行中；合并后激活及私密渠道验收未完成，见 [执行证据](docs/reviews/2026-10-26-p0-release-assurance.md) |
| 2026-10-27 | P0-03/04/05 | Cursor Agent | 实现分支 github-rule/p0-semantic-upgrade-reporting-05b6 | 未承诺 | 验收脚本与数据目录升级检查已落地；真实模型、Windows/macOS 运行记录和私密渠道启用仍未闭环，见 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | P0-04 | Cursor Agent | [PR #26](https://github.com/Nema-Project/nema-room/pull/26) | 未承诺 | 数据目录升级与恢复在 windows-latest 与 macos-latest 通过（[CI 40440137400](https://github.com/Nema-Project/nema-room/actions/runs/40440137400)，`ef87a29`）；安装包原地覆盖仍未验证，见 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | P0-05 | Cursor Agent | [PR #26](https://github.com/Nema-Project/nema-room/pull/26) | 未承诺 | 维护者约 11:52（Asia/Tokyo）启用私密报告；11:54 读取为 HTTP 200 `{"enabled":true}`，未登录安全页链到报告表单。普通非管理员登录后打开表单仍未验收，状态改为进行中，见 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | P0-05 | Cursor Agent | [PR #26](https://github.com/Nema-Project/nema-room/pull/26) | 未承诺 | read 权限协作者 Nullum-ai 于 12:18（Asia/Tokyo）提交测试报告 [GHSA-mgcq-mcqv-75ff](https://github.com/Nema-Project/nema-room/security/advisories/GHSA-mgcq-mcqv-75ff)，进入 triage；12:27 关闭，`published_at` 为空且无 CVE。状态改为已完成，见 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | P0-04 | 维护者 NullumNomen | [PR #26](https://github.com/Nema-Project/nema-room/pull/26) | 未承诺 | 维护者分别在 macOS 与 Windows 手动覆盖安装，结果均为 workspace 数据完整。Cursor Agent 只记录该报告，见 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | P0-03 | Cursor Agent | [PR #26](https://github.com/Nema-Project/nema-room/pull/26) | 未承诺 | Windows 上 Codex direct 与 Claude 均在 `b158daf` 跑完并评分，退出码均为 1。Codex 通过 5/12，Claude 通过 6/12。讨论正文未写入仓库。状态保持进行中，见 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | P0-03 | Cursor Agent | [PR #26](https://github.com/Nema-Project/nema-room/pull/26) | 未承诺 | 修正评测脚本：Claude 的 room MCP 必须启动真实 CLI，room 服务器须 connected 且列出 4 个工具，否则记为 blocked。设计、讨论和冲突使用独立 workspace，open_thread 改由 threads 表判断。提示词改为比较方案时先开 thread。真实模型尚未按修复后脚本重跑，状态保持进行中，见 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | P0-03 | Cursor Agent | [PR #26](https://github.com/Nema-Project/nema-room/pull/26) | 未承诺 | Windows 上修复后脚本各跑两次，Codex direct 与 Claude 均为退出码 0、12/12。JSON 记录的提交是 `be0eb32`；编译产物还包含后来提交的 `edba735` 路径修正，否则命令会在评分前退出。讨论正文未写入仓库。状态改为已完成，见 [PR #26 评论](https://github.com/Nema-Project/nema-room/pull/26#issuecomment-6434135887) 与 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md) |
| 2026-10-27 | — | 维护者 NullumNomen | [PR #29](https://github.com/Nema-Project/nema-room/pull/29) | 未承诺 | macOS 桌面窗口改用系统红绿灯，自定义最小化、最大化和关闭按钮留在 Windows 与 Linux。已合入 `main` `5ff8cf9` |
| 2026-10-27 | 28 | 维护者 NullumNomen | [issue #28](https://github.com/Nema-Project/nema-room/issues/28) / [PR #30](https://github.com/Nema-Project/nema-room/pull/30) | 未承诺 | Room API 写入 `stated` 或 `decided`，以及把 `superseded`、`dropped`、`resolved` 改回 `active`，都必须引用当前任务的用户消息；检查在同一段仓库锁内。缺少或不相关的引用返回 409 `user_basis_evidence`。已合入 `main` `afd1456` |
| 2026-10-27 | — | 维护者 NullumNomen | [PR #31](https://github.com/Nema-Project/nema-room/pull/31) | 未承诺 | 桌面包去掉 Node headers、npm 和 Corepack，只带一份 CPython，去掉未引用的 macOS `libpython3.11.dylib`，只留一份 Chromium 许可声明，去掉 source map、未用的 tree-sitter 语法和 sharp。打包打印各段体积，超出预算时警告。缺语法时警告并跳过。已合入 `main` `76680b8` |
| 2026-10-27 | CX-03 | 待认领 | [PR #27](https://github.com/Nema-Project/nema-room/pull/27) | 未承诺 | 外部来源证据协议的设计已合入。实施前置 #28 已由 PR #30 完成，CX-03 成为下一项。生产代码尚未按该 spec 修改 |
| 2026-10-27 | 32 | 待认领 | [issue #32](https://github.com/Nema-Project/nema-room/issues/32) | 未承诺 | 设计参考：实现证据与执行反馈回流到讨论（原 manager agent 场景，按 [issue #45](https://github.com/Nema-Project/nema-room/issues/45) 修订）。P0 之后的设计参考，不是 spec，不改变 P0 顺序 |
| 2026-10-27 | 45 | Cursor Agent | [issue #45](https://github.com/Nema-Project/nema-room/issues/45) | 未承诺 | 将该 issue 记为产品北极星，决策规则写入路线图与 AGENTS.md。英文、中文、日文 README 与官网的标题和介绍改为项目对齐，并把交付写成回路 |
| 2026-10-27 | CX-03 | Codex | 本地分支 `work`（实现至 `7b3548b`） | 未承诺 | 十项实现与审查修复已提交，361 项针对性测试通过；全量 1486 通过、7 项失败均在基线复现，等待最终验收，见 [实施验证](docs/reviews/2026-10-27-cx03-implementation.md)。不代替 P0 验收 |
