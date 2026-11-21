# 项目路线图与验收台账

更新日期：2026-11-22（Asia/Tokyo）

本文件承接仓库评估中提出的 TODO，作为当前待办入口。它是建议的稳定化顺序，不代表全部问题已复现，也不代表已承诺交付日期。历史设计和评审保留在 `docs/superpowers/` 与 `docs/reviews/`；遇到冲突，应以对应提交的源码、CI 和验收证据为准。

## 当前阶段与证据

项目已形成“讨论 → 知识归档 → 开发包批准 → 编码 Agent 接手 → 提交回报”的功能链路，公开预览版的稳定化已推进到 v0.3.1（2026-11-21 发布）；当前开放事项见「下一项」与 P2 表。

- 最新发布为 [v0.3.1](https://github.com/Nema-Project/nema-room/releases/tag/v0.3.1)（2026-11-21）：tag 指向 `f33612c`，三条 tag 工作流全 success，晋升一次完成，晋升后 `release:verify` 退出 0（记录见「v0.3.1 发布与后续验收」）。milestone 仅 v0.4.x 开放（只含 [#56](https://github.com/Nema-Project/nema-room/issues/56)）；开放 issue 共 7 个：#45（北极星）、#25（连接器 Epic）、#32（设计参考）、#56、#167（方向调研）、#264 与 #265（v0.3.1 后续，均已登记进 P2 表）。以下为历史证据记录，不替代各版本节的发布记录。
- [v0.1.2](https://github.com/Nema-Project/nema-room/releases/tag/v0.1.2) 已发布 Windows x64 与 macOS ARM64 安装包及校验清单。
- 该版本对应提交的[完整 CI](https://github.com/Nema-Project/nema-room/actions/runs/40307045900)在 npm test 失败，但[发布工作流](https://github.com/Nema-Project/nema-room/actions/runs/40307052077)成功。失败原因需要另行定位，不能直接归因为产品缺陷或测试抖动。
- 后续提交已有[完整 CI 成功记录](https://github.com/Nema-Project/nema-room/actions/runs/40309633322)，它不替代发布提交自身的验证。
- [真实 Agent 线程验收](docs/reviews/2026-10-26-thread-agent-script.md)记录为 not run：模型连接失败，未完成语义验收。该条是 2026-10-26 的历史记录。2026-10-27 的修复后脚本已由 Codex direct 与 Claude 各跑两次，均为退出码 0、12/12，见 [PR #26 评论](https://github.com/Nema-Project/nema-room/pull/26#issuecomment-6434135887) 与 [执行证据](docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md)。
- [历史桌面验收](docs/reviews/2026-10-24-desktop-validation.md)只证明其记录的提交与环境；其中“尚未发布”等结论已经过时。
- 已合入 `main` 的近期工作：[PR #29](https://github.com/Nema-Project/nema-room/pull/29) macOS 原生红绿灯（`5ff8cf9`）；[PR #30](https://github.com/Nema-Project/nema-room/pull/30) 落实 [issue #28](https://github.com/Nema-Project/nema-room/issues/28) 的用户 basis 证据检查（`afd1456`）；[PR #31](https://github.com/Nema-Project/nema-room/pull/31) 桌面包瘦身（`76680b8`）。
- 本次评估通过 GitHub 读取源码、配置、Actions 和 Release；未本地重跑测试。开始每项工作前须重新检查最新状态。

## v0.3.1 准备

维护者于 2026-11-18 定 v0.3.1 范围为 milestone 中的两项：[#132](https://github.com/Nema-Project/nema-room/issues/132) 轻量化发布与 [#186](https://github.com/Nema-Project/nema-room/issues/186) 桌面启动。两份 spec 已起草并合入（PR #260）；D 项已于 2026-11-18 由维护者全部按 spec 推荐定案，实施计划随定案记录一并编写。

进本版：

- [x] 完成：[#132](https://github.com/Nema-Project/nema-room/issues/132) 轻量化发布。Node 去重已由 [#134](https://github.com/Nema-Project/nema-room/pull/134) 完成（v0.3.0 桌面 payload 实测 node 0.0 MiB），剩余范围只有 Graphify：spec 为 [2026-11-18 轻量化发布设计](docs/superpowers/specs/2026-11-18-lightweight-release-design.md)——按当前 main 实测，Graphify 占 payload 约 62%（122 MiB），改为第一次用到时经确认按需下载、按 `graphify-lock.json` 的 sha256 逐文件校验、原子安装到 `~/.nema/runtime/graphify/<lock-hash>/`，另提供可侧载的离线组件包（Nema 不再分发）；npm 与 Compose 用户借此第一次能用上 Graphify。D-1～D-4、D-6 已于 2026-11-18 全部按推荐定案（A / B / A / B / A），D-5 已由 #134 解决；实施计划为 [2026-11-18 轻量化发布实施计划](docs/superpowers/plans/2026-11-18-lightweight-release.md)。已于 2026-11-21 完成并随 v0.3.1 发布：任务 1–3 由 PR #262 合入，任务 4–8 由 PR #263 合入，任务 9 验收中发现的 Linux 安装 bug 由 PR #269 修复；验收记录见 #132（发布前记录与体积实测各一条）。payload 实测 win32-x64 75.1 MiB、darwin-arm64 72.9 MiB（graphify 0.0 MiB）；安装包上限未达，差额构成为 Electron 本体量级，详见 #132 关闭记录。
- [x] 完成：[#186](https://github.com/Nema-Project/nema-room/issues/186) 桌面启动剩余项。逐条核实后，issue 的主体已在此前版本交付（启动窗口与失败呈现 [#213](https://github.com/Nema-Project/nema-room/pull/213)、web 与 DB 重叠启动、ACL 单进程 helper 且每次校验仍执行、阶段进度回传、直达上次工作区、骨架屏），issue 中的 v0.2.1 耗时表已过时；spec 为 [2026-11-18 桌面启动设计](docs/superpowers/specs/2026-11-18-desktop-startup-design.md)，剩余工作流为 W1 渲染端首屏负载分析与非首屏面板懒加载、W2 冷启动 DB 以 CI 采样复核（只评估）、W3 打包基准验收口径收尾、W4 启动链剩余串行段只测量。D-1～D-7 已于 2026-11-18 全部按推荐定案；实施计划为 [2026-11-18 桌面启动实施计划](docs/superpowers/plans/2026-11-18-desktop-startup.md)。验收按 2026-11-16 测试政策：基准脚本与 CI 平台 runner 采样加自动化测试，不做桌面实机主动测试。已于 2026-11-21 完成：W1 拆分由 PR #266 合入，W2 评估记录与 W4 量级记录均贴在 #186，P1-10 已按 D-6 口径改写并标已完成；W2 的 D-3 在 windows-latest 触发，预置数据目录另开 #265 讨论，不进本版。

明确不进本版：[#56](https://github.com/Nema-Project/nema-room/issues/56) 依赖大版本（维持 v0.4.x）；#186 中已交付的部分不重开（ACL 批量合并、预置数据目录、独立启动窗口等已决事项见 spec 的「不再重开」一节）。

## v0.3.1 发布与后续验收

v0.3.1 只含 milestone 的两项：[#132](https://github.com/Nema-Project/nema-room/issues/132) 轻量化发布（Graphify 改为首次使用时经确认按需下载、按锁校验、原子安装，另有离线组件包与 npm/Compose 宿主机路径；PR [#262](https://github.com/Nema-Project/nema-room/pull/262)、[#263](https://github.com/Nema-Project/nema-room/pull/263)，验收中发现的 Linux 安装必失败 bug 由 PR [#269](https://github.com/Nema-Project/nema-room/pull/269) 在发布前修复）与 [#186](https://github.com/Nema-Project/nema-room/issues/186) 桌面启动收尾（W1 懒加载拆分 PR [#266](https://github.com/Nema-Project/nema-room/pull/266)、W4 采样承载 PR [#267](https://github.com/Nema-Project/nema-room/pull/267)、ROADMAP 口径收尾 PR [#268](https://github.com/Nema-Project/nema-room/pull/268)）。两项均已完成各自计划的验收并关闭；三条 changelog 片段已在发布准备 PR [#270](https://github.com/Nema-Project/nema-room/pull/270) cut 进 `[0.3.1]`。

发布记录（2026-11-21 晋升后回填）：

- tag `v0.3.1` → `f33612c0dd6a3c8c9d0d20736d7574d5b3515fe6`（[#270](https://github.com/Nema-Project/nema-room/pull/270) 的合并提交）。
- 三条 tag 工作流全 success：npm [44914600487](https://github.com/Nema-Project/nema-room/actions/runs/44914600487)、镜像 [44914600440](https://github.com/Nema-Project/nema-room/actions/runs/44914600440)、桌面 [44914600456](https://github.com/Nema-Project/nema-room/actions/runs/44914600456)（桌面运行结束后 draft Release 带齐 8 项资产）。
- 晋升一次完成：`gh workflow run release-promote.yml --ref main -f tag=v0.3.1` 的运行 [44917243924](https://github.com/Nema-Project/nema-room/actions/runs/44917243924) 全程 success；Release 于 2026-11-21T15:09:27Z 公开。晋升后 `npm run release:verify -- 0.3.1` 退出 0，四项全 ok：npm integrity `sha512-SeMF8teXmwTOyDNsmMVMg9wGm3KcNWrmIx72a+mX0huV8syMKPm9xEcw1ihmCEC5KplWfJC2rtmi/15luVrobw==`；镜像 hub `sha256:2e9963d4…`、web `sha256:f3627da7…`（linux/amd64 与 linux/arm64）；release 8 项资产对版、资产里的 `docker-compose.yml` 已 pin 0.3.1；tag、release 清单与 npm provenance 提交同为 `f33612c…`。
- 体积（#132 任务 9）：两个桌面 target 的 payload 报告 graphify 均为 0.0 MiB，合计 win32-x64 75.1 MiB、darwin-arm64 72.9 MiB，均 ≤ 80 MiB 上限（v0.3.0 基线 196.7 / 193.7）。安装包实测 dmg 134.2 MiB、NSIS exe 116.4 MiB、Windows zip 167.8 MiB（基线 165.7 / 136.0 / 199.0），未达 spec 的安装包上限（95 / 80 / 90）；差额构成是 Electron 本体（win32 zip 解开后 `Nema.exe` 单文件 238.2 MiB 未压缩），该组上限在 payload 为零时也达不到，属 spec 口径误算，构成与数字记在 [#132 关闭记录](https://github.com/Nema-Project/nema-room/issues/132#issuecomment-7064590698)，安装包期望值的重新标定不在本版范围。

发布可用性不等于功能或真机验收完成：#132 与 #186 的验收证据分别记在两个 issue 上（#132 的网页弹窗逐字呈现、Compose 容器栈、macOS Gatekeeper 三项按记录标注为环境/政策限制未验，与 #162、#163 遗留的浏览器逐字检查同属待本地带浏览器部署时一并核对的开放项）；跨进程发布/回滚窗口的 OS 锁方案在 [#264](https://github.com/Nema-Project/nema-room/issues/264)、预置数据目录立项讨论在 [#265](https://github.com/Nema-Project/nema-room/issues/265)，均不在本版范围。

## v0.3.0 准备

版本映射原定 v0.3.0 承载 P2-04 第一期（只读分享 viewer），该内容已提前在 v0.2.6 发布（见下一节）；[#165](https://github.com/Nema-Project/nema-room/issues/165) 已于 2026-11-17 完成实环境验收并关闭（记录见 [#165 评论](https://github.com/Nema-Project/nema-room/issues/165#issuecomment-6936529478)）。维护者于 2026-11-16 重新定 v0.3.0 的范围：以稳定化清尾为主，外加两份新功能 spec；实现与验收在本节记录，完成一项勾一项。

进本版（清尾）：

- [x] 完成：[#174](https://github.com/Nema-Project/nema-room/issues/174) `release-promote` 可见性加固。provenance 等待已由 [#177](https://github.com/Nema-Project/nema-room/pull/177) / [#211](https://github.com/Nema-Project/nema-room/pull/211) 落地；剩余的是包本体可见性：v0.2.6 晋升时注册表处理约 13 分钟，超过 360 秒预算，第一次 promote 失败（记录见 v0.2.6 一节）。目标：发布分发运行已成功且 integrity 对版时，注册表滞后不再被判成确定性失败；预算与等待结构以实现 PR 的证据为准。
- [x] 完成：[#195](https://github.com/Nema-Project/nema-room/issues/195) 提及候选收尾。非空查询的服务端 SQL 搜索已由 [#219](https://github.com/Nema-Project/nema-room/pull/219) 在 v0.2.5 落地；剩余的是空查询浏览只返回一页、没有继续翻页的路径（`MENTION_POOL = 500` 只剩在未被菜单调用的列表 helper 里）。验收沿用该 issue：超过上限的工作区里能找到第 501 条之后的目标，菜单响应不比现在差。
- [x] 完成：[#194](https://github.com/Nema-Project/nema-room/issues/194) MCP `tools/list_changed`：先核实 `@modelcontextprotocol/sdk` 是否投递该通知并记录出处；投递才实现连接期间刷新，本版不把 MCP 工具交给 Agent，这一点不变。
- [x] 完成：[#50](https://github.com/Nema-Project/nema-room/issues/50) hub/web 镜像增加 linux/arm64：按该 issue 的流程先写 spec 与 plan（原生 arm64 runner、双架构各自构建冒烟后合 manifest list、保留 #44 的指针安全规则），再实现；`check-images` 与 compose 冒烟覆盖两种架构，文档去掉「仅 amd64」。实现已由 [#240](https://github.com/Nema-Project/nema-room/pull/240) 合入；GHCR manifest 合成与匿名拉取只能在真实版本发布时验证，已随 v0.3.0 发布完成（镜像运行 [44130554793](https://github.com/Nema-Project/nema-room/actions/runs/44130554793) 全绿含双架构拉取冒烟，晋升后匿名核验 `:0.3.0` 与 `:latest` 均为双架构 index），记录见 [#50 评论](https://github.com/Nema-Project/nema-room/issues/50#issuecomment-6955968129)，#50 已关闭。
- [x] 完成：[#131](https://github.com/Nema-Project/nema-room/issues/131) S5 验收：按维护者 2026-11-16 定的测试政策，真实环境验收在本机 VM 走 Compose 路线（web + hub + PostgreSQL），用已登录的真实 Agent 账户执行；验收记录写回对应 issue 与本文件。桌面端不做主动实机测试（同为该政策），桌面问题等用户反馈 issue 再处理。2026-11-17 已执行并记录（见 [#131 评论](https://github.com/Nema-Project/nema-room/issues/131#issuecomment-6936005381)）：本 VM 沙箱无 NET_ADMIN 且镜像拉取被出口代理阻断，Docker 不可用，改用等价的源码部署（main `035388f` 构建的 hub/web + 真实 PostgreSQL 16 + 宿主机 daemon）。S5.2 部分完成：codex 家族的选号优先级（消息＞话题＞工作区＞默认，route.reason 逐级留痕）、路由展示、真实端点拒绝（无效 key 的 401 分类、点名账户、无静默回退）与自动路由选择均有真实账户证据；Claude 家族有选号与失败呈现证据，但完整运行被 [#242](https://github.com/Nema-Project/nema-room/issues/242) 阻断——daemon 拉起 Claude Code 子进程时清洗环境、不转发代理变量，代理出口环境下连不上 Anthropic API。真实限流（429）触发的切换维持未验证（订阅账户无法按需制造）。待 #242 修复后补验 Claude 家族完整运行，再关闭 #131。 2026-11-17 补验完成：#242 已由 [PR #246](https://github.com/Nema-Project/nema-room/pull/246) 修复并合入（`proxyEnv` 配置项），同日在同一实环境补验 Claude 家族完整运行——off 时呈现新的连接失败文案，`nema config set proxyEnv forward` 后不重启 daemon 即端到端跑通、回复落入话题（记录见 [#131 评论](https://github.com/Nema-Project/nema-room/issues/131#issuecomment-6940469368) 与 [#242 评论](https://github.com/Nema-Project/nema-room/issues/242#issuecomment-6940468232)）；#131 与 #242 均已关闭。429 切换维持未验证，为既有限制，不阻塞关闭。
- [x] 完成：CX-03 最终验收（原与 #131 同项，2026-11-17 分开记录）：spec §515 第 1–8 条均有通过证据——三套测试（sourceImport / evidenceEvents / sourceFreshness）在当前 main 上 44/44 通过，`docs/reference.zh-CN.md` 逐项核对一致；记录见 [#25 评论](https://github.com/Nema-Project/nema-room/issues/25#issuecomment-6936006267)。

只写 spec（实现另行排期）：

- [x] 完成：[#163](https://github.com/Nema-Project/nema-room/issues/163) 身份模型（D11-A）：users / workspace_members / `messages.author_user_id` / 认证给出身份 / 成员提及语义与投递 / 撤销与审计。spec 的 D 项已于 2026-11-17 由维护者全部按推荐定案（提及语义选 B：引用其发言、只给指针），实施计划已编写并合并（[PR #249](https://github.com/Nema-Project/nema-room/pull/249)），实现已合并（[PR #254](https://github.com/Nema-Project/nema-room/pull/254)，2026-11-17）；Task 13 实环境验收已于 2026-11-18 执行（记录见 [#163 评论](https://github.com/Nema-Project/nema-room/issues/163#issuecomment-6952474813)），#163 已关闭。
- [x] 完成：[#162](https://github.com/Nema-Project/nema-room/issues/162) 知识条目 tag（D10-A）：frontmatter `tags` 与归一化、索引存储选型、面板按 tag 筛、提及菜单 tag 组与投递语义、prompt 索引段预算。spec/plan 里写清选型理由。spec 的 D 项已于 2026-11-17 由维护者全部按推荐定案，实施计划另行编写。实现已于 2026-11-17 合并（未知 frontmatter 键保留为 [PR #250](https://github.com/Nema-Project/nema-room/pull/250)，其余 Tasks 2–11 为 [PR #251](https://github.com/Nema-Project/nema-room/pull/251)）；实环境验收（实施计划 Task 12）已于 2026-11-17 经维护者授权执行：升级/回填、分享页、未知键保留与 agent 侧行为均有实环境证据，记录见 [#162 评论](https://github.com/Nema-Project/nema-room/issues/162#issuecomment-6945885353)；其中面板建 tag、面板筛选、编辑器选 tag 三项 UI 交互因验收环境无浏览器可达 VM loopback 未做字面验证（以同一 UI 的 upsert API 与 web 组件测试代偿，详见计划 Task 12 的逐项注记），#162 已关闭、三项字面验证留待有浏览器的本地部署补做。已知限制：图表与工作包详情页只展示 tag、不提供编辑（其保存路径会丢失专用元数据，需另行改造）。

明确不进本版：[#132](https://github.com/Nema-Project/nema-room/issues/132) 轻量化发布（P2-09，已排 v0.3.1，spec 未写）；[#56](https://github.com/Nema-Project/nema-room/issues/56) 依赖大版本（P2-07，已排 v0.4.x）；[#167](https://github.com/Nema-Project/nema-room/issues/167) 远程 hub（方向调研，未立项实现）；P1-10 打包 bench 与其他桌面实机验收（按上述测试政策不主动做）；[#232](https://github.com/Nema-Project/nema-room/pull/232)（外部 fork PR，维护者已搁置）。

## v0.3.0 发布与后续验收

v0.3.0 是稳定化清尾加两个新功能的版本：清尾为 [#174](https://github.com/Nema-Project/nema-room/issues/174) 的 promote 可见性加固（[#237](https://github.com/Nema-Project/nema-room/pull/237)）、[#195](https://github.com/Nema-Project/nema-room/issues/195) 提及候选分页（[#238](https://github.com/Nema-Project/nema-room/pull/238)）、[#194](https://github.com/Nema-Project/nema-room/issues/194) MCP `tools/list_changed` 刷新（[#236](https://github.com/Nema-Project/nema-room/pull/236)）、[#242](https://github.com/Nema-Project/nema-room/issues/242) Claude 代理配置项（[#245](https://github.com/Nema-Project/nema-room/pull/245) / [#246](https://github.com/Nema-Project/nema-room/pull/246)）；新功能为 [#162](https://github.com/Nema-Project/nema-room/issues/162) 知识条目 tag（[#250](https://github.com/Nema-Project/nema-room/pull/250) / [#251](https://github.com/Nema-Project/nema-room/pull/251)）与 [#163](https://github.com/Nema-Project/nema-room/issues/163) 身份模型（[#254](https://github.com/Nema-Project/nema-room/pull/254)），两者均已完成实环境验收并关闭；镜像双架构 [#50](https://github.com/Nema-Project/nema-room/issues/50)（[#240](https://github.com/Nema-Project/nema-room/pull/240)）随本次发布完成 GHCR 端验证并关闭。七条 changelog 片段已在发布准备 PR [#257](https://github.com/Nema-Project/nema-room/pull/257) cut 进 `[0.3.0]`。

发布记录（2026-11-18 晋升后回填）：

- tag `v0.3.0` → `5935e378c9cbf89fdb4dda4ed7317d412e0bb94f`（[#258](https://github.com/Nema-Project/nema-room/pull/258) 的合并提交）。tag 原打在发布准备合并提交 `bd56d1a` 上，因镜像发布工具的循环依赖 bug（见下）修复后移至 `5935e37` 重跑；修复只动发布脚本，应用代码与 `bd56d1a` 一致。
- 三条 tag 工作流全 success：npm [44130554539](https://github.com/Nema-Project/nema-room/actions/runs/44130554539)、镜像 [44130554793](https://github.com/Nema-Project/nema-room/actions/runs/44130554793)（双架构构建冒烟、manifest 合成、发布自检与双架构拉取冒烟均 success）、桌面 [44130554399](https://github.com/Nema-Project/nema-room/actions/runs/44130554399)（draft Release 带齐 8 项资产）。当晚 GitHub macOS runner 排队拥塞，多条运行的 macOS verify job 被 cancelled，均以 `rerun --failed` 恢复，无代码层失败。
- 第一条镜像 tag 运行 [44122604319](https://github.com/Nema-Project/nema-room/actions/runs/44122604319)（tag 还在 `bd56d1a` 时）暴露了发布工具 bug：双架构构建与推送全部成功，但 `Publish images` 最后的 `check-images.mjs --registry` 自检必挂——它动态 import 的 `registry-read.mjs` 又静态 import 回 check-images 的共享模型，循环只在 CLI 入口路径上闭合，顶层 await 死锁（Node exit 13）；单测从 registry-read 一侧 import、#50 的 workflow_dispatch 演练又跑不到 publish job，故此前未暴露。修复 PR [#258](https://github.com/Nema-Project/nema-room/pull/258) 把共享模型抽到叶子模块 `scripts/images/image-model.mjs`，本地与 CI 均验证 `--registry 0.3.0` 退出 0。
- 晋升一次完成：`gh workflow run release-promote.yml --ref main -f tag=v0.3.0` 的运行 [44138026128](https://github.com/Nema-Project/nema-room/actions/runs/44138026128) 全程 success；其分发的 npm 发布运行 [44138232199](https://github.com/Nema-Project/nema-room/actions/runs/44138232199) success。[#237](https://github.com/Nema-Project/nema-room/pull/237) 把包可见性预算提到 1800 秒，本次是它第一次真实行使，未再出现 v0.2.6 那种注册表滞后导致的首次晋升失败。
- `npm run release:verify -- --pointers 0.3.0` 前后对照：晋升前 npm latest、ghcr hub latest、ghcr web latest、github latest 都是 0.2.6；晋升后四者都是 0.3.0。Release 于 2026-11-17T17:37:16Z 公开；晋升后 `npm run release:verify -- 0.3.0` 退出 0，四项全 ok（npm integrity `sha512-3u/GiWOnNJWMxMe8+uQPqjDCWYZrPSFCeLrGSXuoJftVau+WieGXgtNsHC1brn3dBVBDUGBGlXS4XHsc27E9yg==`；镜像 hub `sha256:20cea87b…`、web `sha256:42b9b7fa…`，均 linux/amd64 + linux/arm64；tag、release 清单与 npm provenance 提交同为 `5935e378…`）。
- 匿名独立核验（仅 GHCR 匿名 token）：hub/web 的 `:0.3.0` 与 `:latest` 均为含 linux/amd64 与 linux/arm64 的 OCI index，per-arch tag `:0.3.0-amd64` / `:0.3.0-arm64` 各含对应平台（另有 buildx provenance 的 unknown/unknown 条目）。

发布可用性不等于功能或真机验收完成：

- [#162](https://github.com/Nema-Project/nema-room/issues/162) / [#163](https://github.com/Nema-Project/nema-room/issues/163) 的三项浏览器字面 UI 验证（面板建 tag 与筛选、编辑器选 tag、@ 菜单选成员等）仍未做，留待有浏览器可达的本地部署补验，逐项注记在各自实施计划里。
- 真实 429 触发的账户切换仍未验证（订阅账户无法按需制造），为 [#131](https://github.com/Nema-Project/nema-room/issues/131) 关闭时已记录的既有限制。
- Windows 原生 ACL 子进程收尸、分享限流/撤销的真实 PostgreSQL 并发等既有未验证项维持 v0.2.6 一节的记录。

## 提及候选后续（#195，已随 v0.3.0 发布）

[#219](https://github.com/Nema-Project/nema-room/pull/219) 已让非空查询在整个工作区的 SQL 中搜索；遗留的 `MENTION_POOL = 500` 只供未被菜单调用的列表 helper 使用。当前工作树删除这些 helper，并给空查询增加按时间戳与 id 继续浏览的游标和菜单下一页入口；每组仍最多 8 个指针，每次最多检查 50 个附件，不改变条目决策或状态。这让大型工作区里的既有证据可以继续被引用，符合 [产品北极星 #45](https://github.com/Nema-Project/nema-room/issues/45)。

本地回归覆盖每组 513 个目标，逐页找到第 501 条之后的条目、话题与附件，并检查每页条数和附件检查预算；另覆盖时间戳并列、微秒精度、工作区隔离及过期页面响应。验证命令与剩余限制在本次交付报告中记录。未做真实浏览器、原生桌面或 PostgreSQL 延迟验收；不把这些自动化测试当成真机或性能验收。本节为合入前的交付记录；该工作其后已由 [PR #238](https://github.com/Nema-Project/nema-room/pull/238) 合入并随 v0.3.0 发布，#195 已关闭（见「v0.3.0 发布与后续验收」）。


## v0.2.6 发布与后续验收

v0.2.6 是 v0.2.5 之后的功能版本，主体是只读知识库分享：[#223](https://github.com/Nema-Project/nema-room/pull/223) 的哈希令牌、[#224](https://github.com/Nema-Project/nema-room/pull/224)–[#227](https://github.com/Nema-Project/nema-room/pull/227) 的 hub 投影与签发、[#228](https://github.com/Nema-Project/nema-room/pull/228)–[#230](https://github.com/Nema-Project/nema-room/pull/230) 的公开分享页、桌面网关与设置列表、[#231](https://github.com/Nema-Project/nema-room/pull/231) 的四语指南；同一段 `v0.2.5..main` 里还有 [#222](https://github.com/Nema-Project/nema-room/pull/222) 的 Windows ACL 子进程监管与收尸。七条 changelog 片段已在发布准备 PR [#233](https://github.com/Nema-Project/nema-room/pull/233) cut 进 `[0.2.6]`：片段在 cut 前统一成英文项目符号（与 changelog 的语言一致），其中三条 review 修复片段按出货行为改写措辞、内容不丢。公开投影区分「用户已验收」与「只核对过提交」（`implementationAccepted` / `implementationInferred`），分享默认只开本机回环；局域网出货形态与前提写在指南里。

发布记录（2026-11-16 晋升后回填）：

- tag `v0.2.6` → `bafbef591328e83d6c13a4b65e680483622672ab`（[#233](https://github.com/Nema-Project/nema-room/pull/233) 的合并提交）；该提交的 main CI：运行 [43804578733](https://github.com/Nema-Project/nema-room/actions/runs/43804578733)，success。
- 三条 tag 工作流全 success：npm [43805535086](https://github.com/Nema-Project/nema-room/actions/runs/43805535086)、镜像 [43805535099](https://github.com/Nema-Project/nema-room/actions/runs/43805535099)、桌面 [43805535134](https://github.com/Nema-Project/nema-room/actions/runs/43805535134)（桌面运行结束后 draft Release 带齐 8 项资产）。
- 三条 tag 工作流都结束后，用能看到 draft 的 `GITHUB_TOKEN` 跑 `npm run release:verify -- 0.2.6` 的首次结果：退出 1，只点名 npm（`npm has no @nema-project/nema@0.2.6`）；镜像 ok（hub `sha256:ff9c2851…`、web `sha256:887dd566…`，linux/amd64），release ok（仍是 draft、8 项资产对版、资产里的 `docker-compose.yml` 已 pin 0.2.6、GitHub latest 指针未动），consistency 因 npm 未发布记为 UNKNOWN。
- `npm run release:verify -- --pointers 0.2.6` 的前后对照：晋升前 npm latest、ghcr hub latest、ghcr web latest、github latest 都是 0.2.5，npm next 为空；晋升后四者都是 0.2.6。
- 晋升没有一次完成：第一次 `gh workflow run release-promote.yml --ref main -f tag=v0.2.6` 的运行 [43807519999](https://github.com/Nema-Project/nema-room/actions/runs/43807519999) 在可见性等待处失败。它的发布分发运行 [43807624746](https://github.com/Nema-Project/nema-room/actions/runs/43807624746) 实际已发布成功（日志有 `+ @nema-project/nema@0.2.6`，integrity `sha512-VGV6gZz8…` 与预期一致，provenance 已写入透明日志），但注册表处理用了约 13 分钟才让该版本可查，超过 promote 的 360 秒可见性预算（发布后约 9 分钟时仍答 404）；promote 因此停下，它自己没有翻转任何指针（运行总结 flipped: none）、Release 保持 draft。npm latest 不归 promote 翻转，需要分开记：发布步骤以 `--tag latest` 发布，版本在注册表可见时 npm 的 latest 就已指向 0.2.6；ghcr hub/web 的 latest 与 GitHub latest 只由 promote 后段与 Release 公开移动，当时仍是 0.2.5。等注册表能查到 0.2.6 后重新分发 promote，运行 [43808943051](https://github.com/Nema-Project/nema-room/actions/runs/43808943051) 全程 success；Release 于 2026-11-16T05:15:24Z 公开，晋升后 `npm run release:verify -- 0.2.6` 退出 0，四项全 ok（npm integrity `sha512-VGV6gZz8l3APwHGofOnQIc+4i3Ouni9LhN2db9iZmKMDf5OfdzpZjJhlun2ZpdmaFW7KlM2fLH3wKI1mDnsDPw==`；tag、release 清单与 npm provenance 提交同为 `bafbef5…`）。
- `releases/latest/download/docker-compose.yml` 在晋升前仍是 0.2.5 的双 pin，晋升后变为 0.2.6 且带版本头。

发布可用性不等于功能或真机验收完成：

- 分享限流与撤销的并发测试跑在 PGlite 上，没有证明真实 PostgreSQL 的并发行为。
- hub 的「仅回环」是 Host 头钉定加回环发布，不是连接级对端强制；真正的对端校验在桌面网关一侧。局域网分享是明文 HTTP（SECURITY.md 已记录），只适合可信局域网。
- Windows 原生的 ACL 子进程收尸没有在真实 Windows 硬件上验证过；[#222](https://github.com/Nema-Project/nema-room/pull/222) 的证据是 POSIX 真实进程测试加 Windows CI 平台作业。
- [#131](https://github.com/Nema-Project/nema-room/issues/131) 的真实账户验收还没有。现有证据仍是假 provider 上的自动化测试。

## v0.2.5 发布准备

v0.2.5 是 v0.2.4 之后的小版本。用户可见的变更只有一项：[#219](https://github.com/Nema-Project/nema-room/pull/219) 在 SQL 里搜索提及候选（[#195](https://github.com/Nema-Project/nema-room/issues/195)）。同一段 `v0.2.4..main` 里，[#215](https://github.com/Nema-Project/nema-room/pull/215) 是设计与基准记录，[#218](https://github.com/Nema-Project/nema-room/pull/218) 只补 v0.2.4 的发布记录，都没有用户可见片段。本 release PR 在 cut 之前把提及片段改成英文，与 changelog 的语言一致，并写明菜单还没在真实浏览器里点过。

发布记录（tag 之后补真实值，以下为占位；本 PR 不打 tag、不跑 promote）：

- tag `v0.2.5` → `<TAG_COMMIT>`；该提交的 main CI：`<MAIN_CI_RUN>`。
- 三条 tag 工作流：npm `<NPM_RUN>`、镜像 `<IMAGE_RUN>`、桌面 `<DESKTOP_RUN>`。
- 三条 tag 工作流都结束后，用能看到 draft 的 `GITHUB_TOKEN` 跑 `npm run release:verify -- 0.2.5` 的首次结果：`<PRE_PROMOTE_VERIFY>`（预期退出 1，且只点名 npm。没有这份 token 时，draft Release 会被读成 unknown，那个退出 1 不能当成「只缺 npm」）。
- `npm run release:verify -- --pointers 0.2.5` 的前后对照：`<POINTERS_BEFORE>` / `<POINTERS_AFTER>`。
- 晋升：`gh workflow run release-promote.yml --ref main -f tag=v0.2.5`，运行 `<PROMOTE_RUN>`；晋升后 `npm run release:verify -- 0.2.5` 退出 0。需记录可见性等待实际用了多久、首次晋升是否一次完成。
- `releases/latest/download/docker-compose.yml` 在晋升前仍是 0.2.4 的双 pin，晋升后变为 0.2.5 且带版本头。

发布可用性不等于功能或真机验收完成：

- `@` 菜单没有在真实浏览器里点过，只有组件测试覆盖。
- 候选 SQL 在 PGlite 和 PostgreSQL 16 上测过。hub 测试在 PGlite 上跑了随包查询（含 UTF-16 长度排序）。PostgreSQL 16.15 上计时的是设计脚本的候选 SQL，长度排序用的是 `char_length`，不是随包的 UTF-16 长度；随包的那条长度表达式没有在 PostgreSQL 上计时，桌面 PGlite 的延迟也没有测。
- Windows x64 与 macOS arm64 安装包的冷启动、暖启动和覆盖升级都还没有真机验收。Linux 上的生命周期测试、runtime 重叠测试和桌面打包冒烟不能代替这两台机器上的安装包。
- [#131](https://github.com/Nema-Project/nema-room/issues/131) 的真实账户验收还没有。现有证据仍是假 provider 上的自动化测试。

## v0.2.4 发布与后续验收

v0.2.4 是 v0.2.3 之后的小版本。用户可见的变更只有一项：[#213](https://github.com/Nema-Project/nema-room/pull/213) 桌面启动窗口与等待体验（[#186](https://github.com/Nema-Project/nema-room/issues/186) 的已合并子集）。同一段时间合入的 [#216](https://github.com/Nema-Project/nema-room/pull/216) 是验收记录，[#214](https://github.com/Nema-Project/nema-room/pull/214) 只补 v0.2.3 的发布记录，都没有用户可见片段。[#211](https://github.com/Nema-Project/nema-room/pull/211) 把 `release-promote` 的 npm 可见性预算改为 360 秒、provenance 索引窗口改为 600 秒（Refs [#174](https://github.com/Nema-Project/nema-room/issues/174)），只影响维护者的发布流程，没有写片段。这次晋升是该预算的第一次真实使用。本 release PR 在 cut 之前把启动片段改成英文，与 changelog 的语言一致，并写明尚未做的真机验收。[#195](https://github.com/Nema-Project/nema-room/issues/195) 提及搜索还没有实现，不在这一版。P1-10 仍是进行中：冷启动迁移、多次 ACL 合并，以及打包基准都还没做。

发布记录（tag、三条 tag 工作流、晋升 run 内的 final verify，以及其后的指针移动均已核实）：

- tag `v0.2.4` 是 annotated tag `555f565b7f0b7aa2279e80cf01120e227c8fecff`，解引用到 `1b05a4c31603c8ae6fc494d41f0ffa4d7c8076f2`（[PR #217](https://github.com/Nema-Project/nema-room/pull/217) 的合并提交）。该提交的 [main CI](https://github.com/Nema-Project/nema-room/actions/runs/42810292062) 于 2026-11-10T11:53:08Z 成功，tag 于 2026-11-10T11:53:51Z 创建。
- 三条 tag 工作流均成功：[npm](https://github.com/Nema-Project/nema-room/actions/runs/42811202759)、[镜像](https://github.com/Nema-Project/nema-room/actions/runs/42811202898)、[桌面](https://github.com/Nema-Project/nema-room/actions/runs/42811202826)（只建 draft Release）。npm 那条按设计只打包与冒烟，npm 上的 0.2.4 由晋升 dispatch 的 [run 42818177987](https://github.com/Nema-Project/nema-room/actions/runs/42818177987) 发布。
- 晋升前的检查是这次 promote 的 candidate preflight，不是另一次独立的 `release:verify`。它的 `overall` 是 `complete`：`npm` 为 pending（`@nema-project/nema@0.2.4` 尚未发布），`images` 为 ok（hub `sha256:7ce6f938…` / web `sha256:6bfdd79b…`，linux/amd64），`release` 为 ok（仍是 draft、8 个资产匹配、`docker-compose.yml` 钉 0.2.4），`consistency` 为 ok（tag 与 release manifest 同为 `1b05a4c3…`，npm 尚未发布所以未比对 provenance）。
- 指针按这次 run 的顺序移动。run 开始时 npm 上还没有 0.2.4，ghcr hub latest 与 ghcr web latest 都是 `0.2.3`。npm latest 在 final verify 之前变为 `0.2.4`。final verify 当时读到 Release 仍是 draft，GitHub latest 指针未动。其后 ghcr hub latest 与 ghcr web latest 变为 `0.2.4`，最后 GitHub Release 公开且成为 latest。事后 `npm view @nema-project/nema dist-tags --json` 只有 `{ "latest": "0.2.4" }`，GitHub latest release 是 `v0.2.4`。
- 晋升：[run 42818088692](https://github.com/Nema-Project/nema-room/actions/runs/42818088692) **第一次即成功**，结尾 `promote v0.2.4: done`（2026-11-10T12:49:19Z）。这是 [#211](https://github.com/Nema-Project/nema-room/pull/211) 的 360 秒预算第一次用于真实发布。可见性等待里，包本体一直是 `package absent`，直到 `298536ms` 才同时读到 `npm latest -> 0.2.4` 与 provenance。298536ms 是 298.5 秒，约占 360 秒预算的 83%（预算 `360000ms`）。余量约 61 秒。这次没有出现 v0.2.3 那种包已可见、provenance 仍未索引的分段等待。预算余量的讨论记在 [#174](https://github.com/Nema-Project/nema-room/issues/174)。
- 同一次 run 里，npm 可见之后、移动 GHCR latest 与公开 GitHub Release 之前，`verify-release --stage final` 是 `complete`。它的 `release` 项写明仍是 draft、8 个资产匹配、`docker-compose.yml` 钉 0.2.4，且 GitHub latest 指针未动。`npm` ok，integrity 为 `sha512-lpw7A8mmnMiGflYKTg+JmuSqSfoT2V1TsvCAVzuM//5g59ONxLmaqHLhbXNh3jgsNvwqibQHQczFbxQOobw/DA==`，与 tag push run 的 `nema-tarball` 一致；镜像 hub `sha256:7ce6f9382dbd4834094c5b6c8a73d94a1424493a8f87ff236d3e8a5c249bca87`，web `sha256:6bfdd79bc36b357c7d107a4aae67777621a79c4432bda344f0d0453fb203100e`（linux/amd64）；`consistency` 认定 tag、release manifest 与 npm provenance 同为 `1b05a4c31603c8ae6fc494d41f0ffa4d7c8076f2`。镜像没有 revision label，没有比对镜像 commit。provenance 来自 registry 的 `workflow_dispatch` 记录，未验证签名。GHCR latest 与 GitHub latest 的移动记在前面的指针顺序和下面的公开记录里，不在这次 final verify 里。
- GitHub Release 于 `2026-11-10T12:49:19Z` 公开，`draft: false`、`prerelease: false`、`isImmutable: true`、`latest=true`。`releases/latest/download/docker-compose.yml` 现为 0.2.4 双 pin，首行为 `# Nema Room 0.2.4 release asset. Hub and web are pinned to 0.2.4.` ghcr hub latest 的索引 digest 是 `sha256:20635892e3b8b157883694824f2c96e3f579889a069f70753b2a6f5295464e7d`，ghcr web latest 是 `sha256:3b7f7980145ec95885c9e6f9858a1d3123f2d62e7ef72ea35eafd3441491face`。

发布可用性不等于功能或真机验收完成：

- Windows x64 与 macOS arm64 安装包的冷启动、暖启动和覆盖升级都还没有真机验收。Linux 上的生命周期测试、runtime 重叠测试和桌面打包冒烟不能代替这两台机器上的安装包。验收记录见 [v0.2.4 acceptance](docs/reviews/2026-11-07-v0-2-4-acceptance.md)。
- [#131](https://github.com/Nema-Project/nema-room/issues/131) 的真实账户验收还没有。现有证据仍是假 provider 上的自动化测试。

## v0.2.3 发布与后续验收

v0.2.3 是 v0.2.2 之后的小版本。用户可见的变更有四项：[#205](https://github.com/Nema-Project/nema-room/pull/205) 桌面包不再另带一份 Node，改用 Electron 自带的 Node（[#134](https://github.com/Nema-Project/nema-room/issues/134)）；[#201](https://github.com/Nema-Project/nema-room/pull/201) stdio MCP 服务器按规范顺序关停（[#190](https://github.com/Nema-Project/nema-room/issues/190)）；[#207](https://github.com/Nema-Project/nema-room/pull/207) 清理第一次账户迁移时没能删掉的旧凭据（[#206](https://github.com/Nema-Project/nema-room/issues/206)）；[#200](https://github.com/Nema-Project/nema-room/pull/200) 与 [#208](https://github.com/Nema-Project/nema-room/pull/208) 显示 skill 限制和被去掉的 mention。[#196](https://github.com/Nema-Project/nema-room/pull/196) 把 `release-promote` 的 npm 可见性预算放宽到 180 秒（Refs [#174](https://github.com/Nema-Project/nema-room/issues/174)），只影响维护者的发布流程，没有写片段。[#199](https://github.com/Nema-Project/nema-room/pull/199) 加了可重复运行的桌面启动 benchmark，[#204](https://github.com/Nema-Project/nema-room/pull/204) 只改测试，[#197](https://github.com/Nema-Project/nema-room/pull/197)、[#198](https://github.com/Nema-Project/nema-room/pull/198)、[#202](https://github.com/Nema-Project/nema-room/pull/202)、[#203](https://github.com/Nema-Project/nema-room/pull/203) 只改文档，这些都没有用户可见片段。本 release PR 在 cut 之前给 Node 去重片段补上了 bullet（缺了它 `release:cut` 会拒绝），并把 MCP 关停片段译成英文，与 changelog 的语言一致。

发布记录（tag、三条 tag 工作流、晋升与晋升后核验均已核实）：

- tag `v0.2.3` 是 annotated tag `e450a56ec6a8601d7f3ff7b921feef553bcb118f`，解引用到 `6ae1be243465e88772b45eaec418866d203fc11f`（[PR #209](https://github.com/Nema-Project/nema-room/pull/209) 的合并提交）；该提交的 [main CI](https://github.com/Nema-Project/nema-room/actions/runs/41591476814) 成功后才创建 tag。
- 三条 tag 工作流均成功：[npm](https://github.com/Nema-Project/nema-room/actions/runs/41592079086)、[镜像](https://github.com/Nema-Project/nema-room/actions/runs/41592079064)、[桌面](https://github.com/Nema-Project/nema-room/actions/runs/41592079167)（只建 draft Release）。npm 那条按设计只打包与冒烟，npm 上的 0.2.3 由晋升 dispatch 的 [run 41593856788](https://github.com/Nema-Project/nema-room/actions/runs/41593856788) 发布。
- tag 之后、晋升之前，带 `GITHUB_TOKEN` 跑 `npm run release:verify -- 0.2.3`：**退出 1**，`result: incomplete (exit 1)`。逐项为 `MISSING npm`（`npm has no @nema-project/nema@0.2.3`）、`ok images`（hub `sha256:c70eebaa…` / web `sha256:af536be2…`，linux/amd64）、`ok release`（仍是 draft、8 个资产匹配、`docker-compose.yml` 钉 0.2.3、GitHub latest 指针未动）、`UNKNOWN consistency`（因 npm 未就绪而未检查）。与预期一致，只点名 npm。
- 晋升前 `release:verify -- --pointers 0.2.3`：npm latest、ghcr hub latest、ghcr web latest、github latest 均为 `0.2.2`，npm next `(none)`。晋升后这四个 `latest` 均为 `0.2.3`，npm next 仍为 `(none)`（决策列恒打印 `-> move`，读法见 v0.2.1 一节）。
- 晋升：[run 41593792001](https://github.com/Nema-Project/nema-room/actions/runs/41593792001) **第一次即成功**，结尾 `promote v0.2.3: done`（2026-11-03T07:07:59Z）。这是 [#196](https://github.com/Nema-Project/nema-room/pull/196) 的 180 秒预算第一次用于真实发布：可见性等待先有约 110 秒读到 `package absent`，之后约 60 秒读到 `provenance not indexed yet (the version document declares it)`，到 `175976ms` 才同时读到 `npm latest -> 0.2.3` 与 provenance。**余量约 4 秒**（预算 `180000ms`）；按 v0.2.2 时的 120 秒预算，这次会在包本体可见之后不久耗尽。v0.2.2 是约 55 秒 absent、约 60 秒等 provenance；这次 provenance 那段同样约 60 秒，变长的是包本体可见之前的那段。预算余量的讨论记在 [#174](https://github.com/Nema-Project/nema-room/issues/174)。
- 晋升后 `npm run release:verify -- 0.2.3` **退出 0**：`result: complete (exit 0)`，四项全 `ok`。npm integrity 为 `sha512-yel2ve6hxiku1Fp8oZjgsEeO4i0LuIGEbtNjU8200MSFkDAEDDIwwq3PuedeHR6RG8ZjX8hlTHN5zSbMUQVt9A==`，与 tag push run 的 `nema-tarball` 一致；Release 已公开、8 个资产匹配、`docker-compose.yml` 钉 0.2.3；`consistency` 认定 tag、release manifest 与 npm provenance 同为 `6ae1be24…`（镜像无 revision label，未比对镜像 commit；provenance 来自 registry 的 `workflow_dispatch` 记录，未验证签名）。
- GitHub Release 于 `2026-11-03T07:07:58Z` 公开，`draft: false`、`prerelease: false`、`latest=true`；`releases/latest/download/docker-compose.yml` 由 0.2.2 双 pin 变为 0.2.3 双 pin，首行为 `# Nema Room 0.2.3 release asset. Hub and web are pinned to 0.2.3.`

发布可用性不等于功能或真机验收完成：

- Node 去重的证据是 PR #205 最后一个提交 `ff10c1e` 上的 [Desktop release run 41345394881](https://github.com/Nema-Project/nema-room/actions/runs/41345394881)：win32-x64 与 darwin-arm64 的 Build and smoke 都成功；tag `v0.2.3` 的[桌面工作流](https://github.com/Nema-Project/nema-room/actions/runs/41592079167)在同两个目标上再次成功。这只验证了 CI 上的打包与冒烟。安装包的真机安装、从 0.2.2 覆盖升级、启动、旧数据保留，以及旧 report hook 改写后能否正常上报，都还没有真机证据。
- [#131](https://github.com/Nema-Project/nema-room/issues/131) 仍 OPEN（milestone v0.2.3）：[#202](https://github.com/Nema-Project/nema-room/pull/202) 补了三语指南与技术参考，但真实账户验收记录还没有。
- [#174](https://github.com/Nema-Project/nema-room/issues/174) 仍 OPEN。上面这次晋升用掉 180 秒预算中的约 176 秒之后，main 把 `NPM_VISIBILITY_BUDGET_MS` 改为 360 秒、provenance 索引窗口改为 600 秒；下次真实晋升才能证明余量。这不阻塞本版已完成的发布。
- [#189](https://github.com/Nema-Project/nema-room/issues/189) 已完成。v0.2.3 是开启 immutable releases 之后的第一个 Release：`gh release view v0.2.3 --json isImmutable` 为 `true`，这次晋升一次通过。`npm-publish.yml` 里 provenance 来自 trusted publishing 的注释在 `6c4137d`。v0.2.2 及更早的 Release 仍是 `isImmutable: false`，该设置不回溯。

## v0.2.2 发布与后续验收

v0.2.2 是 v0.2.1 之后的小版本，主要内容是同一供应商多账户的第 2–4 批：[#175](https://github.com/Nema-Project/nema-room/pull/175) 设置接口与三处账户选择器（S2），[#176](https://github.com/Nema-Project/nema-room/pull/176) daemon 按所选账户运行任务（S3，手动模式），[#178](https://github.com/Nema-Project/nema-room/pull/178) 跨账户自动路由（S4，默认关闭）。另有两项修复：[#177](https://github.com/Nema-Project/nema-room/pull/177) `release-promote` 的可见性等待覆盖 npm provenance（Refs [#174](https://github.com/Nema-Project/nema-room/issues/174)），[#180](https://github.com/Nema-Project/nema-room/pull/180) 浮动 thread 窗口里的下拉列表点开即关。[#181](https://github.com/Nema-Project/nema-room/pull/181) 只改 CI 分片，[#179](https://github.com/Nema-Project/nema-room/pull/179)、[#182](https://github.com/Nema-Project/nema-room/pull/182)、[#183](https://github.com/Nema-Project/nema-room/pull/183)、[#184](https://github.com/Nema-Project/nema-room/pull/184) 只改文档，均无用户可见片段。三个多账户片段在本 release PR 里合成一条英文片段：S2 片段写的「只存选择、任务仍由默认账户执行」和 S3 片段写的「自动路由尚未提供」在同一版本里已被后续批次取代，原样合并会自相矛盾。

发布记录（tag、三条 tag 工作流、晋升与晋升后核验均已核实）：

- tag `v0.2.2` 是 annotated tag `3f98abee2e3a814ee192affa2686def68220e2fe`，解引用到 `a3806ba284fa66c59d3a551edf072430ad4a019a`（[PR #185](https://github.com/Nema-Project/nema-room/pull/185) 的合并提交）；该提交的 [main CI](https://github.com/Nema-Project/nema-room/actions/runs/41312458519) 成功。
- 三条 tag 工作流均成功：[npm](https://github.com/Nema-Project/nema-room/actions/runs/41315201832)、[镜像](https://github.com/Nema-Project/nema-room/actions/runs/41315201831)、[桌面](https://github.com/Nema-Project/nema-room/actions/runs/41315201849)（只建 draft Release）。npm 那条按设计只打包与冒烟，npm 上的 0.2.2 由晋升 dispatch 的 [run 41317003985](https://github.com/Nema-Project/nema-room/actions/runs/41317003985) 发布。
- tag 之后、晋升之前，带 `GITHUB_TOKEN` 跑 `npm run release:verify -- 0.2.2`：**退出 1**，`result: incomplete (exit 1)`。逐项为 `MISSING npm`（`npm has no @nema-project/nema@0.2.2`）、`ok images`（hub `sha256:d493963f…` / web `sha256:973cc7b2…`，linux/amd64）、`ok release`（仍是 draft、8 个资产匹配、`docker-compose.yml` 钉 0.2.2、GitHub latest 指针未动）、`UNKNOWN consistency`（因 npm 未就绪而未检查）。与预期一致，只点名 npm。
- 晋升前 `release:verify -- --pointers 0.2.2`：npm latest、ghcr hub latest、ghcr web latest、github latest 均为 `0.2.1`，npm next `(none)`。晋升后这四个 `latest` 均为 `0.2.2`，npm next 仍为 `(none)`（决策列恒打印 `-> move`，读法见 v0.2.1 一节）。
- 晋升：[run 41316950604](https://github.com/Nema-Project/nema-room/actions/runs/41316950604) **第一次即成功**，结尾 `promote v0.2.2: done`（2026-11-01T14:38:58Z）。这是 [#177](https://github.com/Nema-Project/nema-room/pull/177) 的 provenance 等待第一次在真实发布上使用，且确实被用到了：可见性等待先有约 55 秒读到 `package absent`，之后约 60 秒读到 `provenance not indexed yet (the version document declares it)`，到 `117670ms` 才同时读到 `npm latest -> 0.2.2` 与 provenance。**余量只有约 2.3 秒**（预算 `120000ms`）；v0.2.1 时 provenance 在发布完成 1 分钟后仍是 404，这次从等待开始约 2 分钟才可读。预算耗尽时若只剩 provenance 未索引（版本文档已声明），promote 按设计把它作为 waitable 项交给 final verify，verify 通过就继续移动后续指针，并在运行记录里注明该项仍待 registry 补上（`scripts/release/promote.mjs` 的 final verify 一段），不会仅因这一等待超时停在 partial window。仍会停下的情形是：包本体或频道 dist-tag 在预算内一直不可见，或 provenance 被判定为确定性缺失。预算余量的讨论记在 [#174](https://github.com/Nema-Project/nema-room/issues/174)。
- 晋升后 `npm run release:verify -- 0.2.2` **退出 0**：`result: complete (exit 0)`，四项全 `ok`。npm integrity 为 `sha512-+0eU16bNnSN4bh9lZkSIFvWQxc3D0f9hyJ9mqXNMq0/liJg+zEUeSI6yxG8HQt3/jTfLsb/vSus8beb7F3JSmg==`；Release 已公开、8 个资产匹配、`docker-compose.yml` 钉 0.2.2；`consistency` 认定 tag、release manifest 与 npm provenance 同为 `a3806ba2…`（镜像无 revision label，未比对镜像 commit；provenance 来自 registry 的 `workflow_dispatch` 记录，未验证签名）。
- GitHub Release 于 `2026-11-01T14:38:58Z` 公开，`draft: false`、`prerelease: false`；`releases/latest/download/docker-compose.yml` 由 0.2.1 双 pin 变为 0.2.2 双 pin，首行为 `# Nema Room 0.2.2 release asset. Hub and web are pinned to 0.2.2.`

发布可用性不等于功能或真机验收完成：

- 多账户 S2–S4 的验收是临时 `nemaHome` 与假 provider 上的自动化测试（含 `test/routing/acceptance-auto.test.ts` 对两个假端点跑的 S4 七条验收标准），没有真账户或真 provider 参与；限流与额度用尽时的真实切换、真实 provider 的错误分类都还没有真机证据。[#131](https://github.com/Nema-Project/nema-room/issues/131) 仍 OPEN，已移到 milestone v0.2.3，只剩 S5（三语指南、技术参考与真实账户验收记录）。
- [#174](https://github.com/Nema-Project/nema-room/issues/174) 仍 OPEN（milestone v0.2.3）：本版晋升一次完成，说明 #177 让 provenance 时序问题不再被判成确定性缺失。provenance 超出预算时会以 waitable 项继续晋升；包本体或 dist-tag 超出预算仍会停下。余量只有约 2.3 秒，预算是否需要放宽仍待决定。
- Windows x64 与 macOS arm64 安装包的真机安装、覆盖升级、启动与旧数据保留仍待验证；不能用 v0.2.1 的验收代替。

## v0.2.1 发布与后续验收

v0.2.1 是 v0.2.0 之后的小版本，不含新功能。四项都是 v0.2.0 发布后暴露的加固与修复：[#159](https://github.com/Nema-Project/nema-room/pull/159) 同一供应商多账户的第 1 阶段（账户数据与凭据），[#169](https://github.com/Nema-Project/nema-room/pull/169) `release:cut` 的并发与中断安全，[#171](https://github.com/Nema-Project/nema-room/pull/171) `mcpLeftovers` 的偶发失败，[#170](https://github.com/Nema-Project/nema-room/pull/170) `release-promote` 有界等待 npm registry 可见性。同一轮把四份 README 与三份指南里「升级到更新的次版本」那段改成 `<version>` 占位符，[#63](https://github.com/Nema-Project/nema-room/issues/63) 第六条（release PR 的安装入口与示例命令不出现写死版本号）在这个 release PR 上成立；该 issue 的其余分期不因本版改变状态。

发布记录（tag、三条 tag 工作流、晋升与晋升后核验均已核实）：

- tag `v0.2.1` 是 annotated tag `6ef80a536d3f74ccdec82817419c3ae88ea72625`，解引用到 `55edeff6b101a5c0d68a42ade2359623f2490ccb`（`release: prepare v0.2.1`，[PR #172](https://github.com/Nema-Project/nema-room/pull/172) 的合并提交）；该提交的 [main CI](https://github.com/Nema-Project/nema-room/actions/runs/41217993126) 成功（`CI gate`、`classify`、`docs`、`Workflow lint`、macOS/Windows 平台检查、三平台 pack smoke、完整应用测试与 web 构建）。
- 三条 tag 工作流均成功：[npm](https://github.com/Nema-Project/nema-room/actions/runs/41220073049)、[镜像](https://github.com/Nema-Project/nema-room/actions/runs/41220073015)、[桌面](https://github.com/Nema-Project/nema-room/actions/runs/41220073153)（只建 draft Release）。npm 那条按设计 `Publish to npm` 为 skipped，只打包与冒烟，所以该 run 成功只表示 tag 阶段通过；npm 上的 0.2.1 是之后由晋升 dispatch 发布的。
- tag 之后、晋升之前，带 `GITHUB_TOKEN` 跑 `npm run release:verify -- 0.2.1`：**退出 1**，`result: incomplete (exit 1)`。逐项为 `MISSING npm`（`npm has no @nema-project/nema@0.2.1`）、`ok images`（hub `sha256:a38b1bf9…` / web `sha256:4f50509d…`，linux/amd64）、`ok release`（Release 仍是 draft、8 个资产匹配、`docker-compose.yml` 钉 0.2.1、GitHub latest 指针未动）、`UNKNOWN consistency`（因 npm 未就绪而未检查）。不带 token 时 release 那一行是 UNKNOWN；本条记录的是带 token 的那次。
- 晋升：第一次 [run 41256637721](https://github.com/Nema-Project/nema-room/actions/runs/41256637721) **失败并 fail-closed**；重跑 [run 41256904054](https://github.com/Nema-Project/nema-room/actions/runs/41256904054) 成功，结尾 `promote v0.2.1: done`（2026-11-01T00:29:06Z）。首次失败的原因：promote 的可见性等待只覆盖包本体与频道 dist-tag，没有等 provenance；npm 发布步骤于 `00:25:42Z` 完成后，该 run 在 `00:26:45Z` 的 final verify 回读 attestations 端点仍是 404，被 `readNpmProvenance` 读成 `missing`，`consistency` 因此判 incomplete 而停下；当时 `flipped by this run: npm latest`，`not flipped: ghcr hub latest, ghcr web latest, github latest`，即 partial window，需人工重跑才能补完其余三个指针。跟进见 [#174](https://github.com/Nema-Project/nema-room/issues/174)（milestone v0.2.x，OPEN）。
- 晋升前 `release:verify -- --pointers 0.2.1`：npm latest `0.2.0`、npm next `(none)`、ghcr hub latest `0.2.0`、ghcr web latest `0.2.0`、github latest `0.2.0`，五个指针都还没动。晋升后四个 `latest` 指针（npm、ghcr hub、ghcr web、github）均为 `0.2.1`；npm `next` 仍为 `(none)`。**读法注意**：这个只读输出的决策列在 `current <= target` 时一律打印 `-> move`，`shouldMoveLatest('0.2.1','0.2.1')` 返回 true，所以晋升后再跑同样会显示 `-> move`，不能据此判断指针是否还需移动；判断以该行左侧实际读到的版本为准。
- 晋升后 `npm run release:verify -- 0.2.1` **退出 0**：`result: complete (exit 0)`，四项全 `ok`。npm integrity 为 `sha512-nX6k5+EczILqMEOqOpF+WFL5Li4hTPuycWeGBvwg5kqPVR5FZmi/CI2GKsOqTQQgWfCzQWvsgD1rzN1jq2jXTQ==`；镜像 hub `sha256:a38b1bf9…` / web `sha256:4f50509d…`；Release 已公开、8 个资产匹配、`docker-compose.yml` 钉 0.2.1；`consistency` 认定 tag、release manifest 与 npm provenance 同为 `55edeff6…`（镜像无 revision label，未比对镜像 commit；provenance 来自 registry 的 `workflow_dispatch` 记录，未验证签名）。
- GitHub Release 于 `2026-11-01T00:29:06Z` 公开（即 2026-11-01 09:29:06 JST），`draft: false`、`prerelease: false`；`releases/latest/download/docker-compose.yml` 现由 0.2.0 双 pin 变为 0.2.1 双 pin，并带版本头（`# Nema Room 0.2.1 release asset. Hub and web are pinned to 0.2.1.`）。

发布可用性不等于功能或真机验收完成：

- 多账户只有第 1 阶段落地（`apps/cli` 的账户数据与凭据）。设置 API、自动路由与界面属于 S2–S4，所以不要把这个版本当作多账户功能可用。[#131](https://github.com/Nema-Project/nema-room/issues/131) 仍 OPEN，已从 milestone v0.2.1 移到 v0.2.2 继续做（v0.2.1 现已无 open issue）。
- 同一供应商多账户的后续分批在 v0.2.2 里做。第 2 批（设置接口与界面，分支 `feat/multi-account-s2`）加了 `/_nema/accounts*`、设置页账户块和三处账户选择器，但**只存选择、不按选择路由**：daemon 仍用默认账户跑任务，选择要到第 3 批才生效。该分支的验收是临时 `nemaHome` 与假 provider 上的自测，没有真账户或真 provider 参与；第 3 批合并前不要把这个功能当作可用。
- `mcpLeftovers` 的修复在测试侧，产品代码未改；它把偶发失败归因于 fixture 读到尚未写入的 pid 文件：`Number("")` 为 0，而 POSIX 下 pid 0 指调用者自己的进程组，所以 `process.kill(0, 0)` 成功，测试就一直等到超时。该测试只在 POSIX 上运行（`describe.skipIf(!posix)`）。[#161](https://github.com/Nema-Project/nema-room/issues/161) 按此关闭。
- registry 可见性等待有上限（`NPM_VISIBILITY_BUDGET_MS` 为 120 秒），预算耗尽仍 fail-closed 且不移动后续指针。这条路径在 v0.2.1 上确实走了一次，但**不是无问题的通过**：首次 promote 的等待只覆盖包本体与频道 dist-tag，没覆盖 provenance。npm 发布步骤 `00:25:42Z` 完成，`00:26:45Z` 的 final verify 回读 attestations 仍得 404，被读成 `missing`，于是在已经翻动 npm latest 之后停在 partial window；到重跑的 `00:28:51Z` preflight 才读到 provenance，随后完成。也就是说等待机制起效、失败也是 fail-closed 的，但它把可恢复的时序问题判成了确定性缺失，代价是一次人工重跑和一个部分指针的窗口。跟进见 [#174](https://github.com/Nema-Project/nema-room/issues/174)（milestone v0.2.x，OPEN）。
- Windows x64 与 macOS arm64 安装包的真机安装、覆盖升级、启动与旧数据保留仍待验证；不能用 v0.2.0 的验收代替。

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
- 版本映射（2026-10-31 定，2026-11-02 调整，2026-11-04 再调整，2026-11-16 再调整）：v0.2.x 承载 0.2 系列小修与 Node 去重（[#134](https://github.com/Nema-Project/nema-room/issues/134)）；v0.3.0 原定承载只读分享知识库（P2-04 第一期），该内容已提前在 v0.2.6 发布，2026-11-16 改为稳定化清尾（#174、#195、#194、#50、#131 S5 与 CX-03 验收）加 #163 / #162 两份 spec，见「v0.3.0 准备」一节；v0.3.1 承载轻量化发布（P2-09）与桌面启动收尾（P1-10），均已于 2026-11-21 发布并关闭；v0.4.x 承载依赖大版本升级（P2-07）。
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

P0-01 与 P0-02 仍在进行中。v0.3.1 已于 2026-11-21 发布，milestone v0.3.1 关闭；下一版 v0.4.x 目前只含 [#56](https://github.com/Nema-Project/nema-room/issues/56)（P2-07 依赖大版本）。未排期的后续项已登记在 P2 表：[#264](https://github.com/Nema-Project/nema-room/issues/264) 组件安装器 OS 锁（P2-10）、[#265](https://github.com/Nema-Project/nema-room/issues/265) 预置数据目录立项讨论（P2-11）、[#167](https://github.com/Nema-Project/nema-room/issues/167) 远程 hub 方向调研（P2-12）；[#25](https://github.com/Nema-Project/nema-room/issues/25) 连接器 Epic 的后续 CX 项与 [#32](https://github.com/Nema-Project/nema-room/issues/32) 设计参考仍开放。下一项由维护者选定。连接器侧最近完成的是 CX-03：实现已由 PR #54 合入，最终验收已于 2026-11-17 完成（记录见 [#25 评论](https://github.com/Nema-Project/nema-room/issues/25#issuecomment-6936006267)，spec §515 第 1–8 条均有通过证据，三套测试在当前 main 上 44/44 通过）。

| ID | 事项与依据 | 状态 | 验收标准 |
| --- | --- | --- | --- |
| CX-03 | 外部来源证据协议。契约见 [spec](docs/superpowers/specs/2026-10-27-source-evidence-protocol-design.md) 与 [plan](docs/superpowers/plans/2026-10-27-source-evidence-protocol.md)。#28 已合入，协议实现已由 PR #54 合入，最终验收已于 2026-11-17 完成：spec §515 第 1–8 条均有通过证据，三套测试在当前 main 上 44/44 通过，记录见 [#25 评论](https://github.com/Nema-Project/nema-room/issues/25#issuecomment-6936006267) | 已完成 | 已实现 `sourceRefs`、`evidence_events` 与内部 `source__import`，已整体验证；保留 #28 的用户 basis 检查，以及从 `superseded`、`dropped`、`resolved` 改回 `active` 的检查；不得把外部正文伪装成聊天消息 |

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
| P1-09 | [#63](https://github.com/Nema-Project/nema-room/issues/63) 发布去版本耦合。规格见 [release mechanics spec](docs/superpowers/specs/2026-10-28-release-mechanics-design.md) | 已完成 | 第 1 期（单点盖印 + changelog 片段）已由 [PR #70](https://github.com/Nema-Project/nema-room/pull/70) 合入（`954a8c3`）。第 2 期基本落地：[plan](docs/superpowers/plans/2026-10-28-release-mechanics-phase2.md)（[PR #79](https://github.com/Nema-Project/nema-room/pull/79)），以及 [PR #80](https://github.com/Nema-Project/nema-room/pull/80) Compose 模板与固定名资产、[PR #81](https://github.com/Nema-Project/nema-room/pull/81) 安装说明、[PR #83](https://github.com/Nema-Project/nema-room/pull/83) 整套产物校验与锁定版本安装。v0.1.6 是第一个附带 `docker-compose.yml` 资产的版本，已于 2026-10-30 发布；它的 release PR [#89](https://github.com/Nema-Project/nema-room/pull/89) 没有改 Compose、站点、README 和指南里的版本号。第 2 期任务 10 已由 [PR #92](https://github.com/Nema-Project/nema-room/pull/92) 合入（`a869b2c`），公开安装链接改为 `releases/latest/download/docker-compose.yml`。第 3 期：[plan](docs/superpowers/plans/2026-10-30-release-mechanics-phase3.md)（[PR #102](https://github.com/Nema-Project/nema-room/pull/102)，`d01babf`）；第一步只读检查 `npm run release:verify -- <x.y.z>` 已加入，2026-10-30 对 v0.1.6 回溯运行退出 0、对 v0.1.5 退出 1 并点名缺 `docker-compose.yml`，这是演练，不算规格要求的「第一步上线后的一次真实发布」。第 3 期第二步已由 [PR #112](https://github.com/Nema-Project/nema-room/pull/112) 合入（`de5347e`）：tag 推送只做验证、打包和冒烟：不再发布 npm、不公开 GitHub Release、不移动 GHCR `latest`（image-publish 仍照常推送版本号镜像 tag）；新增 `release-promote.yml`，由维护者从 main 触发，按 npm → 最终校验 → 两个 GHCR `latest` → GitHub Release 的顺序晋升。2026-10-30 对 v0.1.6 做了不打 tag 的演练（任务 14 第 2 步）：[run 41045206706](https://github.com/Nema-Project/nema-room/actions/runs/41045206706) 成功，维护者检查通过；preflight 认定 image-publish 与 desktop-release 的 push 运行全部通过；summary 逐项为已完成（npm 0.1.6 已是预期 tarball、hub/web `latest` 已是 0.1.6 的 digest、Release 已发布且为 latest），结尾 `promote v0.1.6: done`。演练没有 dispatch npm-publish（该工作流没有 workflow_dispatch 运行），npm dist-tags、两个 `latest` digest 和 Release 的 `updated_at` 与演练前一致，`release:verify -- 0.1.6` 前后都退出 0；唯一写入是该运行自己的 `promote-binding` 产物。收口前记录的剩余项：下一次真实发布的只读报告无误报；第一次真实发布时观察 npm dispatch 链路与 trusted publishing（任务 14 第 3 步、任务 15）；后续加固：npm-publish 的直接 dispatch 不核对发起者身份、`same` 路径不核对 `maintenance` dist-tag、晋升中途被 tag 工作流重跑打断时会留下部分窗口（重跑可补完）。spec 的问题 1、问题 2 已由维护者在 2026-10-28 选定，均为 A 已收口：#63 于 2026-11-01 以 COMPLETED 关闭，六条验收在 v0.2.1 上全部有据（见 #63 关闭评论）；其后 v0.2.5–v0.3.1 多次真实发布反复走通 tag → 晋升 → 校验链。 |
| P1-10 | [#186](https://github.com/Nema-Project/nema-room/issues/186) 桌面启动速度与等待体验。采纳时 [#188](https://github.com/Nema-Project/nema-room/issues/188) 的启动基准和 [#134](https://github.com/Nema-Project/nema-room/issues/134) 的 Node 去重已关闭。服务于 [#45](https://github.com/Nema-Project/nema-room/issues/45)：打开共享房间时，要能分清在启动、卡住和失败。已落地：主窗口在核心就绪前出现，背景色与主题一致，并显示启动画面；失败时错误留在窗口里。画面会改成子进程回报的启动阶段。web 的 HTTP 就绪与打开 PGlite、启动 hub 并行，15 秒预算从这段工作结束才开始计算。daemon 在 web 就绪后才连接，避免 web 超时打断已经领走的任务。网关仍等 web 就绪。再次打开时，若这台机器记得上次的工作区，启动链接直接进入该房间；房间列表返回前显示骨架。设置和插件面板按需加载。Electron 主进程不再在每次轮询时做私有文件 ACL：只在 `instance.json` 出现，或子进程报就绪、端口冲突时才发现实例。调用方刚刚保护过的 home 不会在同一次调用里再保护一遍。每次打开私有文件仍会检查。Windows 上同一次进程里的私有文件 ACL 共用一个 PowerShell，每次检查仍然执行。冷启动不预置 PGlite 数据目录（D-1 选 B，规格在 [#221](https://github.com/Nema-Project/nema-room/pull/221)）。v0.3.1 收尾（规格见 [desktop startup remainder spec](docs/superpowers/specs/2026-11-18-desktop-startup-design.md)，D-1～D-7 已于 2026-11-18 全部按推荐定案）：W1 首屏分析后把条目详情子树与浮窗线程层拆为按需加载（[PR #266](https://github.com/Nema-Project/nema-room/pull/266)，`/` 与 `/w/[id]` 首屏 JS 各降约 30KB）；W2 以 CI `startup-sample` 复核冷启动 DB，windows-latest 冷中位 3484ms 约为 2026-11-10 Linux 基线 1605ms 的 2.17 倍、D-3 触发，预置数据目录另开 [#265](https://github.com/Nema-Project/nema-room/issues/265) 讨论、本版不实现，macOS 冷中位 1662ms 未触发；W4 以新增的 `startup-phase-sample` 承载在 CI 平台 job 测量 lease 与 private-files 两段，量级为毫秒级（Windows 约 8–9ms 与 15–23ms，macOS 约 4–5ms 与 0–1ms，记录在 #186），不再是启动大头，本版不改顺序、不做优化。目标版本未承诺，不改 v0.3.0 上 P2-04 的映射。规格见 [startup window spec](docs/superpowers/specs/2026-11-04-desktop-startup-window-design.md) 与 [startup remainder spec](docs/superpowers/specs/2026-11-04-desktop-startup-remainder-design.md) | 已完成 | 窗口在 `ensureLocalRuntime` 返回前已经显示，背景为浅色 `#ffffff` 或深色 `#141311`。启动失败时窗口文档含错误文字，且不再只靠模态对话框。子进程回报 `db` 时，启动文档含 `Opening the database`，不含未知阶段名。web 被挡住时，`startup-phase` 的 `db` 可以早于 `web`。`nema_workspace=ws_…` 的启动链接进入 `/w/ws_…`；其它 cookie 值仍进入 `/`。房间列表未返回时主区是骨架，不是“加载中”正文。`homeAlreadyProtected` 不再次收紧目录权限，公开的 instance 描述仍被拒绝。验收口径（2026-11-18 D-6 定案）：Electron 侧行为由 lifecycle 自动化测试与 `desktop-mark` 打点覆盖；平台 DB/ACL 数字由 `startup-sample` 在 CI 平台 runner 持续记录——它只测 fresh-process 的 PGlite 就绪与迁移总时长（`createLocalDb` 两步的代理量）与 Windows ACL 微基准，不启动 core、不产 `startup-phase` 行；core 各阶段时长来自 core stdout 的 `startup-phase` 行，由 `desktop:bench` 从 core 日志解析、由本地运行时测试解析断言，CI 平台 job 另以 `startup-phase-sample` 承载持续采样（[PR #267](https://github.com/Nema-Project/nema-room/pull/267)）。`desktop:bench` 为手工可选工具，引用其数字须注机型与安装包 SHA，不作合并门槛。口径取舍明示：打包态的 Electron 启动、`requireSystemGit`、首帧时间没有数字；打包应用在真实用户硬件上的冷/热数字未采集，是按维护者 2026-11-16 测试政策主动放弃的证据，不是遗漏。不放宽私有文件 ACL |

## P2：后续能力

| ID | 事项 | 状态 | 验收标准与前置条件 |
| --- | --- | --- | --- |
| P2-01 | 签名、公证与更新体验 | 待办 | 正式签名与 macOS 公证可验证；P0-04 已于 2026-10-27 完成，再设计自动更新、失败恢复与版本兼容。版本号展示和只读的稳定版提示（issue #35）不计入本项 |
| P2-02 | 规模与可诊断性 | 待办 | 建立大仓库、长会话、大量知识条目的耗时和资源基线；提供脱敏诊断导出；确保不含 token、密钥或默认导出私有讨论内容 |
| P2-03 | 多设备同步 | 待办 | 先完成备份恢复与数据权威来源定义；设计冲突解决和一致性模型，再确定实现范围 |
| P2-04 | [#165](https://github.com/Nema-Project/nema-room/issues/165) 只读分享知识库（P2-04 第一期 viewer）。第一阶段只做分享链接的只读浏览，不做账号、登录与成员表；完整身份模型（users / workspace_members / messages.author_user_id、按人授权与撤销）留到后续阶段。规格见 [readonly knowledge share spec](docs/superpowers/specs/2026-11-04-readonly-knowledge-share-design.md)，计划见 [readonly knowledge share plan](docs/superpowers/plans/2026-11-04-readonly-knowledge-share.md) | 已完成 | 先设计身份、授权、撤销与审计；不得直接把当前单用户本地服务暴露为多人服务。2026-10-31 收窄为第一期只读分享：分享链接可撤销、撤销后立即失效，只暴露知识条目，不暴露聊天/任务/附件/设置；完整身份模型留到后续阶段。规格已写。D-1（整库）与 D-4（仅局域网，不支持公网）已由用户在 2026-11-11 确认。第一期已由 #223–#231 实现并随 v0.2.6 发布（2026-11-16），2026-11-17 完成实环境验收并关闭 #165（记录见 [#165 评论](https://github.com/Nema-Project/nema-room/issues/165#issuecomment-6936529478)）。后续阶段的身份模型由 [#163](https://github.com/Nema-Project/nema-room/issues/163)（D11-A）承接，spec 排在 v0.3.0。 该后续阶段已随 v0.3.0 发布，#163 于 2026-11-18 验收关闭，本行全部收口。 |
| P2-05 | [#25](https://github.com/Nema-Project/nema-room/issues/25) 外部连接器 Epic。设计见 [connector architecture v0.2](docs/design/connector-architecture-v0.2.md) | 进行中 | CX-01、CX-03 已实现，CX-03 最终验收已完成（2026-11-17）；CX-02、CX-04、CX-05、CX-06、CX-07、CX-08、CX-09、CX-10 尚未开始 |
| P2-06 | [#75](https://github.com/Nema-Project/nema-room/issues/75) 扩展管理：Skills/MCP/插件的安装、卸载与启停。规格见 [extension management spec](docs/superpowers/specs/2026-10-25-extension-management-design.md)，计划见 [extension management plan](docs/superpowers/plans/2026-10-25-extension-management.md) | 已完成 | 已完成：启停（[PR #84](https://github.com/Nema-Project/nema-room/pull/84)）；卸载受管扩展、移出外部项，内置项不可卸载（[PR #85](https://github.com/Nema-Project/nema-room/pull/85)）；GitHub / skills.sh 来源钉到固定提交后预览（[PR #86](https://github.com/Nema-Project/nema-room/pull/86)）；按钉住的提交安装 Skill，带进度、取消、重试，重启时把未完成的安装标为中断（[PR #87](https://github.com/Nema-Project/nema-room/pull/87)）；插件页安装入口（[PR #88](https://github.com/Nema-Project/nema-room/pull/88)）；聊天里的安装卡片，需用户确认，与页面走同一服务（[PR #90](https://github.com/Nema-Project/nema-room/pull/90)）。剩余：已安装 / 发现分区、类型筛选与搜索；外部项接入；内置项修复；Skills 渐进载入；MCP 的 stdio / HTTP 配置、本机凭据保管与启停。进度见 [#75 评论](https://github.com/Nema-Project/nema-room/issues/75#issuecomment-6514317610) 已收口：#75 于 2026-10-31 以 COMPLETED 关闭，十条验收项在 main 上全部有实现与测试支撑（收尾表见 #75 关闭评论），上列各项均已包含在内。 |
| P2-07 | [#56](https://github.com/Nema-Project/nema-room/issues/56) 依赖体检的剩余项：ESLint 9→10、TypeScript 5.9→7、Node 22→24，以及内置 Python 从 3.11 换线到 3.13/3.14。该 issue 中的桌面 Python 升 3.11.18、基础镜像 trixie 化与移除 Vue 图标已由 PR #57、#58 完成。2026-10-31 排期改为 v0.4.x（原与轻量化发布一同放在 v0.3.0） | 待办 | 各升级单独 PR；内置 Python 换线需按 spec/plan 单独立项。范围以该 issue 为准 |
| P2-08 | [#50](https://github.com/Nema-Project/nema-room/issues/50) hub/web 镜像增加 linux/arm64（多架构 manifest）。[规格](docs/superpowers/specs/2026-11-16-multiarch-images-design.md)、[计划](docs/superpowers/plans/2026-11-16-multiarch-images.md) | 已完成 | 已实现原生双架构构建与冒烟矩阵、manifest 合成和发布校验；本地 fixture 检查不等于发布验收。arm64 runner、GHCR 合成与匿名拉取仍待实际运行验证 该验证已随 v0.3.0 发布完成：GHCR 双架构 manifest 合成与匿名拉取端到端核对，#50 于 2026-11-18 关闭；v0.3.1 的 `release:verify` 再次确认双架构。 |
| P2-09 | [#132](https://github.com/Nema-Project/nema-room/issues/132) 轻量化发布：大组件按需下载与离线组件包。2026-10-31 从 v0.3.0 提前到 v0.2.x；2026-11-02 改排 v0.3.x，其中 Node 去重已拆到 [#134](https://github.com/Nema-Project/nema-room/issues/134)，留在 v0.2.x。2026-11-04 改排 v0.3.1。已于 v0.3.1 完成并发版（PR #262、#263、#269），#132 已关闭 | 已完成 | 按 #132 的 spec 与验收标准验收，记录见 #132；体积的 payload 口径达标（75.1 / 72.9 MiB、graphify 0），安装包上限未达、差额构成记在 #132 关闭记录 |
| P2-10 | [#264](https://github.com/Nema-Project/nema-room/issues/264) 组件安装器跨进程发布/回滚窗口的 OS 锁方案。#263 评审中确认的两个竞态窗口（指针发布、回滚改名）已按维护者决定接受为残余风险并记录在该 issue；本项是其后续 | 待办 | 按 #264 的设计评估并实现 OS 级锁（fcntl / LockFileEx 或等价方案），或经评估后正式维持现状；两个窗口有回归测试或明确的不可测说明。未排期 |
| P2-11 | [#265](https://github.com/Nema-Project/nema-room/issues/265) 预置数据目录（方案 A）立项讨论。#186 的 W2 评估触发 D-3：windows-latest 冷启动 DB 中位 3484ms 约为 Linux 基线 2.17 倍 | 待办 | 维护者决定是否立项；立项则另写 spec 并按 #45 北极星说明价值，不立项则在 issue 记录理由后关闭。未排期 |
| P2-12 | [#167](https://github.com/Nema-Project/nema-room/issues/167) 远程 hub 方向调研：hub 作为远程综合主机、多个 daemon 互享 | 待办 | 方向调研，未立项实现；先产出调研结论与对 #45 的价值说明，立项前另走 spec。未排期 |

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
| 2026-11-04 | P1-10 | Cursor Agent | [issue #186](https://github.com/Nema-Project/nema-room/issues/186) / [PR #213](https://github.com/Nema-Project/nema-room/pull/213) | 未承诺 | 采纳为进行中。主窗口在核心就绪前显示启动画面；web 的 HTTP 就绪与打开数据库、启动 hub、等待 daemon 并行。证据是本变更的生命周期测试和 runtime 重叠测试。打包基准、Windows ACL、冷启动迁移和渲染端渐进加载仍未做 |
| 2026-11-04 | P1-10 | Cursor Agent | [issue #186](https://github.com/Nema-Project/nema-room/issues/186) / [PR #213](https://github.com/Nema-Project/nema-room/pull/213) | 未承诺 | 启动画面显示子进程回报的阶段；记得的工作区从启动链接直达，列表返回前是骨架；设置和插件面板按需加载。主进程不再在每次轮询时做私有文件检查。冷启动 PGlite、多次 ACL 合并成一次 PowerShell，以及打包基准仍未做 |
| 2026-11-04 | P2-09 | 维护者 | [issue #132](https://github.com/Nema-Project/nema-room/issues/132) / [PR #213](https://github.com/Nema-Project/nema-room/pull/213) | v0.3.1 | 不在本轮实现。排期从 v0.3.x 改为 v0.3.1。D-1～D-4、D-6 仍待决定，开工前先写 spec |
| 2026-11-04 | P1-10 | Cursor Agent | [issue #186](https://github.com/Nema-Project/nema-room/issues/186) / [PR #213](https://github.com/Nema-Project/nema-room/pull/213) | 未承诺 | web 就绪预算改到数据库和 hub 之后再计算。daemon 改到 web 就绪后连接。已删除的上次工作区不再和 `/` 来回跳。证据是 runtime 重叠测试、WorkspaceShell 测试和桌面生命周期测试 |
| 2026-11-04 | P1-10 | Cursor Agent | [issue #186](https://github.com/Nema-Project/nema-room/issues/186) / [PR #213](https://github.com/Nema-Project/nema-room/pull/213) | 未承诺 | 启动器等待从 20 秒改为 45 秒，盖过数据库和 hub 之后的 15 秒 web 预算，以及其后的 10 秒 daemon 预算。否则启动器会在 web 仍在预算内时停掉核心 |
| 2026-11-10 | P1-10 | Cursor Agent | [issue #186](https://github.com/Nema-Project/nema-room/issues/186) / [PR #213](https://github.com/Nema-Project/nema-room/pull/213) | v0.2.4 | 准备发布已合并的启动窗口子集和文档。P1-10 仍是进行中。Windows x64 与 macOS arm64 安装包的冷启动、暖启动和覆盖升级没有真机验收。[#131](https://github.com/Nema-Project/nema-room/issues/131) 的真实账户验收没有。[#195](https://github.com/Nema-Project/nema-room/issues/195) 不在本版。tag 尚未创建 |
| 2026-11-10 | P1-10 | Cursor Agent | [PR #217](https://github.com/Nema-Project/nema-room/pull/217) | v0.2.4 | 已发布。annotated tag `v0.2.4` 解引用到 `1b05a4c3`。Windows x64 与 macOS arm64 安装包的冷启动、暖启动和覆盖升级仍没有真机验收。[#131](https://github.com/Nema-Project/nema-room/issues/131) 的真实账户验收仍没有。P1-10 仍是进行中 |
| 2026-11-10 | 174 | Cursor Agent | [issue #174](https://github.com/Nema-Project/nema-room/issues/174) / [PR #211](https://github.com/Nema-Project/nema-room/pull/211) | v0.2.4 | 360 秒预算第一次用于真实晋升。[run 42818088692](https://github.com/Nema-Project/nema-room/actions/runs/42818088692) 一次成功。npm latest 与 provenance 在 `298536ms`（298.5 秒，约占 360 秒预算的 83%）后同时可见。不改变该 issue 的状态 |
| 2026-11-10 | P1-10 | Cursor Agent | [issue #186](https://github.com/Nema-Project/nema-room/issues/186) / [PR #222](https://github.com/Nema-Project/nema-room/pull/222) | 未承诺 | Windows 上同一次进程里的私有文件 ACL 共用一个 PowerShell，每次检查仍然执行。放宽后的 DACL 仍会被拒绝。不预置 PGlite 数据目录。平台 CI 记录源码级冷/暖 `createLocalDb` 与 Windows 空 PowerShell 对照，不是打包后的安装包 bench。P1-10 仍是进行中 |
| 2026-11-17 | CX-03 | Muse | [issue #25](https://github.com/Nema-Project/nema-room/issues/25) | v0.3.0 | 最终验收完成：spec §515 第 1–8 条均有通过证据，三套测试（sourceImport / evidenceEvents / sourceFreshness）在当前 main 上 44/44 通过，`docs/reference.zh-CN.md` 逐项核对一致，记录见 [#25 评论](https://github.com/Nema-Project/nema-room/issues/25#issuecomment-6936006267)。状态改为已完成 |
| 2026-11-21 | P1-10 | Muse | [issue #186](https://github.com/Nema-Project/nema-room/issues/186) / [PR #268](https://github.com/Nema-Project/nema-room/pull/268) | v0.3.1 | 状态改为已完成。W1 拆分由 [PR #266](https://github.com/Nema-Project/nema-room/pull/266) 合入，W2 冷启动 DB 评估完成（D-3 在 windows-latest 触发，预置数据目录另开 [#265](https://github.com/Nema-Project/nema-room/issues/265)），W4 两段量级已测，P1-10 验收口径按 D-6 改写。验收证据见 #186 的评估、量级与对账记录；打包实机数字按 2026-11-16 测试政策未采集 |
| 2026-11-21 | P2-09 | Muse | [issue #132](https://github.com/Nema-Project/nema-room/issues/132) / [PR #270](https://github.com/Nema-Project/nema-room/pull/270) | v0.3.1 | 已发布并关闭。tag `v0.3.1` → `f33612c`，三条 tag 工作流全 success，晋升一次完成（运行 44917243924），晋升后 `release:verify` 退出 0。#132 任务 9 验收记录见 #132；安装包上限未达、差额构成为 Electron 本体，详见 #132 关闭记录 |
| 2026-11-22 | — | Muse | 本文件 / GitHub issues | — | ROADMAP 与 issue 对账整理：P1-09（#63）、P2-04（#165/#163）、P2-06（#75）、P2-08（#50）按各自关闭记录改为已完成；新增 P2-10（#264）、P2-11（#265）、P2-12（#167）三行登记未排期后续；「当前阶段与证据」「下一项」与 #195 一节按 v0.3.1 发布后的状态更新 |
