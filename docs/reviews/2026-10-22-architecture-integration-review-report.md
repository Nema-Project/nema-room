# Nema Room · 架构与开源集成 Review Report

- 日期：2026-10-22
- 被核实对象：`/Volumes/tp-nas/Documents/Work/NemaDocs/Nema_Room_Architecture_Integration_Review.md`（只作为核实问题清单使用，不作为对用户决定的权威）
- 代码基线：`main` @ `e731ccc`（只读；另一 agent 同时在提交 Docker Compose 改动，`docker-compose.yml` 引用以 `e731ccc` 为准）
- 设计文档：`docs/superpowers/specs/2026-10-21-nema-room-design.md`（下称 spec）
- 标注约定：**Confirmed Finding**（有 file:line / URL 证据）/ **Recommendation**（建议，未实施）/ **Open Question**（证据不足或需用户决定）。建议与 spec 中用户【决定】冲突时标 **Decision Conflict**。各节冲突且无法用证据裁决的，一律降为 Potential / Open Question。

---

## 1. Executive Summary

**总体判断：设计方向合理，但 V1 实现未达到 spec 自己的隔离硬约束。**

- 核心分层（Room MCP 作为唯一写入口、git 存知识、PG 存聊天/任务、daemon 适配器）是合理且足够简单的。Hub 侧 run token 的 workspace 作用域实现正确（AR-01-10）。
- **必须在 V1 解决的架构问题（3 组）：**
  1. **本机 Agent 隔离未达标（Critical/High）。** Codex 0.163 默认开启 `apps`/`plugins`/`remote_plugin`/`hooks` 等功能，隔离 home 中已缓存 239 个 `codex_apps` 工具（GitHub、Google Drive 等）和系统 skills（AR-01-1）；`sandbox_mode="read-only"` 只限制写、不限制读，三次独立实测均能跨 workspace 读文件（AR-01-2）。这违反 spec §7 用户【决定】（spec:291，明确列出"其他 MCP server 或文件访问"）。最小修复不需要容器：关掉多余 features 与 shell 工具，并改用 Codex 的 permission profile 限制可读路径（DC-1）。
  2. **Git/PG 一致性没有恢复路径（High）。** `entry_index` 是 best-effort 写入且不可重建，却驱动时间线和 Agent 的 prompt 索引（AR-02-1）；hub 重启/WebSocket 断开会让任务整段重跑，而旧 Codex 进程不被中止（AR-02-2）。
  3. **知识变更缺少确定性约束（High）。** Agent 可无依据地改写或作废 active 决策（AR-03-1）；来源校验只检查"消息存在"，不检查角色和是否为本次输入（AR-03-2）。
- **值得接受的建议：** Review 的 P0 三项（隔离核实、Git/PG 一致性、知识变更来源与冲突校验）全部接受，并已收敛为 7 项最小设计变更（第 4 节）。开源方面只借鉴设计思想：OS-01（三态判定 + 写后确定性校验）、OS-04（变更前影响说明）、OS-08（agent-as-assignee、触发类型，不复制 AGPL 代码）。
- **应拒绝或推迟的建议：** 没有任何开源项目建议"Integrate Now"。OS-05 Omnigraph、OS-07 billion-context、OS-09 Reason Network、OS-10 PGX 建议 Reject（比原 Review 更严格）；OS-02 Harness2、OS-03 Headroom、OS-06 Graphify 推迟为 Prototype Later。Review 中"逐 claim 必须校验"（`claims[]`）若成为写入门槛，会与 §4.2【决定】冲突，不建议 V1 采用。
- **Part III（Extension Interfaces 是否需要提前抽象）：不需要。** 理由与建议见第 4 节 DC-8。

---

## 2. Architecture Findings

### AR-01 · Workspace 隔离与保密

```text
Finding ID: AR-01-1
Severity: Critical
Status: Confirmed（功能开启与工具缓存）；Potential（守卫在调用发出前还是发出后触发）
Current Implementation: renderCodexConfig 只关闭 memories/history/web_search/analytics/update-check，并只定义 room 一个 MCP server；没有关闭 Codex 默认开启、会增加工具或指令的功能。
Evidence:
  - apps/cli/src/codex/isolation.ts:43-58
  - `codex features list`（codex-cli 0.163.0，使用与 renderCodexConfig 相同的 CODEX_HOME 配置，两位核实者各自独立运行）：apps、plugins、remote_plugin、hooks、multi_agent、shell_tool、unified_exec、view_image、image_generation、browser_use、computer_use、skill_mcp_dependency_install、tool_suggest、goals、code_mode_host 均为 true；memories 为 false。
  - 两个真实隔离 home（~/.nema/ws/ws_2nlYkR0VLphI、~/.nema/ws/ws_GyqvKMb_j6Oq）的 cache/codex_apps_tools/*.json：共 239 个工具，server_name 均为 codex_apps（GitHub 91、Google Drive 45、Sites 44、ChatGPT Space 38 等）；另有 skills/.system/{imagegen,openai-docs,review-agent,skill-creator,skill-installer} 与 plugins/cache/openai-curated-remote。只统计了文件名和 JSON 字段，未读取凭证或 sqlite。
  - `codex debug prompt-input` 显示注入了 <skills_instructions>、<multi_agent_role>、<collaboration_mode>。
  - 运行时守卫只在 adapter.ts:120-121 对 server !== "room" 的 mcp_tool_call 杀进程。
Risk: 用户 ChatGPT 账号的 connectors 对所有 workspace 相同，一次运行可接触其他项目的 Drive/GitHub 内容，且 connector 流量不受沙箱网络代理控制（Codex 官方 config reference）。违反 §6.6 第 3、7 项和 §7【决定】(spec:291)。
Recommended Change: 见 DC-1：在生成的 config 中关闭上述 features（合并后的必须关闭清单），preflight 运行 `codex features list` 验证全部为 false，加单元测试。
Estimated Complexity: S（另需约 0.5 天用真实 Codex 验证）
Decision Conflict: No（使实现符合 §6.6 / §7）
```

> 说明：AR01-live 报告曾称 Test 3 中的 codex_apps 工具清单是模型"虚构"、"MCP 向量已关闭"。该结论被上述磁盘证据推翻，**已撤回**。仅保留其中"Agent 声称用 JavaScript 检查过工具注册表，但事件流中没有任何工具调用"这一点（见 AR-01-4）。

```text
Finding ID: AR-01-2
Severity: High
Status: Confirmed
Current Implementation: sandbox_mode="read-only"，shell_tool / unified_exec 仍开启，Agent 可执行任意读命令。
Evidence:
  - isolation.ts:49；adapter.ts:99-103（未传 -s 或 -c 覆盖）
  - Codex 源码 rust-v0.163.0：read-only = Root → Read（codex-rs/protocol/src/permissions.rs:606-624）；Seatbelt 生成 (allow file-read*)（codex-rs/sandboxing/src/seatbelt.rs:980-985）；Linux bwrap 用 --ro-bind / /（linux-sandbox/src/bwrap.rs:416-418）
  - 实测 1（`codex sandbox`，两位核实者分别执行）：cat 另一目录的 secret 成功；写入返回 "Operation not permitted"
  - 实测 2（真实 `codex exec --json`，按 adapter/buildEnv 配置）：ws_A 运行读取 ws_B 的 decisions/D-1.md，exit 0，事件流中出现预埋的 secret；写 ws_B 返回 exit 1
  - 其他 workspace 的知识仓库位于 <dataDir>/repos/<ws>（apps/hub/src/workspaces.ts:40-41），dataDir 默认为 ~/.nema/data（apps/hub/src/main.ts:41）；Docker 模式下仍为 bind mount（docker-compose.yml:49 @ e731ccc）
Risk: workspace A 的运行可读 workspace B 的知识、git 历史和 codex-home 状态。spec:280 把"同一系统用户"列为【Claude 的决定】下接受的残余风险，但 §6.6 标题【决定：隔离本机 Agent】与 §7【决定】(spec:291) 明确禁止通过文件访问泄漏。两者相互矛盾，需要用户裁决（Q1）。
Recommended Change: 见 DC-1（关闭 shell/view_image 等工具 + permission profile 限制可读路径），两层叠加做纵深防御。注意：sandbox_mode 的任何取值（含 workspace-write）都不能限制读，--add-dir 与 exclude_* 只影响写；只有 default_permissions + permissions.<name>.filesystem（支持 "deny"）能限制读（Codex config reference / permissions 文档；seatbelt.rs:624-660）。
Estimated Complexity: S–M（工具关闭 S；permission profile M）；独立系统用户/容器 L
Decision Conflict: No（关闭工具 + profile）。若选择"接受残余风险、弱化保密表述"则为 Decision Conflict（§7 spec:291）。
```

```text
Finding ID: AR-01-3
Severity: High
Status: Confirmed（可读）；Potential（端到端外泄链，未整链运行）
Current Implementation: 每个 codex-home 内有指向 ~/.codex/auth.json 的软链接；~/.nema/data/daemon-token 与用户 home 均可被 Agent 读取；upsert_entry 会把 Agent 提供的文本写入知识仓库。
Evidence:
  - isolation.ts:74-81；apps/cli/src/mcp/server.ts:47-54
  - 实测（真实 exec）：ls ~/.codex 成功（含 auth.json），ls 用户 home 成功。按规则未读取 auth.json 内容。
  - daemon-token 可完成 hello 并接管连接，从而收到所有 workspace 的 prompt（apps/hub/src/daemonSocket.ts:152-170）
Risk: 粘贴文本中的 prompt injection 可让 Agent 读取 auth.json / daemon-token / 其他 workspace 文件，再经 Room MCP 写入条目（网络已禁用，但 Room MCP 是合法出口）。
  修正（经二次核实）：其他 workspace config.toml 中的 run token 在实践中总是已失效（tasks.ts:99,124,138,150 清空；tasks.ts:157-163 要求 running；运行全局串行），不构成攻击面。经条目外泄给"团队读者"是未来风险，V1 只有用户本人（spec:74）。
Recommended Change: 主要由 DC-1 解决（无读工具 + profile 拒绝 ~/.codex、~/.nema）。纵深防御：hub 在 upsert 时扫描 token 形态字符串（JWT、sk- 前缀、daemon-token 值）并拒绝。凭证代理 / 短期 token 列为后续加固，成本未评估（Open Question）。
Estimated Complexity: S（扫描）
Decision Conflict: No（保留 §6.6 第 2 项软链接方案）
```

```text
Finding ID: AR-01-4
Severity: Medium
Status: Confirmed
Current Implementation: spec §6.6 第 8 项要求从初始化事件确认"只加载 Room、无指令文件"；实际实现为静态 preflight + 运行时对外部 MCP 调用杀进程。
Evidence:
  - events.ts:7-16：exec --json 不输出 mcp_startup_complete / session_configured
  - preflight isolation.ts:101-136：只检查 codexHome 的 AGENTS 文件、mcp_servers 仅 room、auth.json 为软链接、向上查找 .git/AGENTS
  - 缺少 server 字段的 mcp_tool_call 会被杀（events.ts:54 映射为 ""，adapter.ts:120 判断 !== "room"）；events.ts:15-16 的注释与代码行为不符，已过时
  - AR01-live Test 3：Agent 声称"用 JavaScript 检查了工具注册表"，但该次 JSONL 中只有 agent_message、没有任何工具调用
Risk: 自检无法发现 AR-01-1 的任何问题；Agent 的自我描述不能作为隔离证据。
Recommended Change: 修订 §6.6 第 8 项：以权威来源自检——生成的 config、`codex features list` 对照必须关闭清单、skills/plugins/cache/codex_apps_tools 目录为空、JSONL 事件流中无意外 command_execution / 非 room 调用。评估 `codex app-server`（§6.6 已提及）能否提供启动事件。修正 events.ts:15-16 注释。
Estimated Complexity: M
Decision Conflict: No（§6.6 第 8 项属【Claude 的决定】）
```

```text
Finding ID: AR-01-5
Severity: Medium
Status: Confirmed
Current Implementation: 每次运行只重写 config.toml 与 auth.json 链接，Codex 写入 CODEX_HOME 的其他状态跨运行保留。
Evidence: isolation.ts:67-81；真实 ws home 中有 memories_1.sqlite（45 KB，memories 已关仍存在）、logs_2.sqlite、state_5.sqlite、goals_1.sqlite、shell_snapshots/、skills/、plugins/、cache/、installation_id；README.md:106 却写"每次从零生成，只有一份 config.toml"。
Risk: 同 workspace 跨运行留存状态，违背 §6.6 第 4 项意图；在 AR-01-2 下也可被其他 workspace 读取；README 夸大了保证。
Recommended Change: 每次运行前清空 codexHome 中除 config.toml、auth.json 以外的内容（或每次运行使用全新 CODEX_HOME）；修正 README.md:106。memories_1.sqlite 是否含数据未读取（Q10）。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-01-6
Severity: Medium
Status: Confirmed（无版本门槛）；Potential（未知配置键是否被静默忽略，未测试）
Current Implementation: 使用 PATH 上任意 codex 或 NEMA_CODEX_BIN；doctor 只打印版本。
Evidence: adapter.ts:65；doctor.ts:36；fixture 为 0.148（events.ts:2），本机为 0.163.0；AR-01-1 本身就是版本漂移的结果；`codex exec --help` 显示存在 --strict-config。
Risk: Codex 升级可能新增工具、改名配置键或改变沙箱/事件结构而无人察觉。
Recommended Change: 维护已测试版本范围，超出则 daemon 拒绝运行；以 --strict-config 运行，使改名的键直接报错；启动自检（features 清单 + 一次 sandbox 读探针）；任何 Codex 升级视为重新核实事件。
Estimated Complexity: S–M
Decision Conflict: No
```

```text
Finding ID: AR-01-7
Severity: Medium
Status: Confirmed
Current Implementation: 清理在 finally 中执行并杀掉 detached 进程组；CLI 无 SIGINT/SIGTERM 处理；从不清扫残留的 nema-run-* 目录。
Evidence: adapter.ts:54-61、99-103（detached: true）；grep apps/cli/src 中 SIGTERM|SIGINT|process.on( 无结果；daemon/cleanup.ts 只对账 <nemaHome>/ws/<id>。核实时残留为 0。
Risk（经二次核实修正）：daemon 崩溃或 Ctrl-C 后，detached 的 Codex 进程组继续运行并消耗额度；hub 在 WebSocket 关闭时即重新入队（daemonSocket.ts:186-192），run token 很快失效，因此问题不是"token 仍有效"，而是孤儿进程可能与下一次运行重叠，破坏 spec:264 的"全局串行"令牌刷新保证。workDir（含 last.txt）留在 $TMPDIR，在 AR-01-2 下可被读取。
Recommended Change: 增加 SIGINT/SIGTERM 处理器（杀活动进程组 + cleanupRun）；daemon 启动时清扫 os.tmpdir()/nema-run-*（仅真实目录、属当前用户、不跟随软链接）；补测试。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-01-8
Severity: Low
Status: Confirmed（env 白名单正确）；Potential（preflight 缺口）
Current Implementation: env 白名单为 PATH、LANG、LC_ALL、TERM + HOME=wsHome、CODEX_HOME、TMPDIR=workDir/.tmp；向上查找只检查 .git、AGENTS.md、AGENTS.override.md。
Evidence: isolation.ts:83-99、124-133；isolation.test.ts:127-134；codexAdapter.test.ts:46-50；沙箱内 env 只见 HOME、PATH、CODEX_SANDBOX*。
Risk: 上层目录中的项目级 .codex/、.agents/skills、hooks 未检查（在 /var/folders/.../T 下可能性低）。
Recommended Change: 向上查找列表加入 .codex、.agents；可选将 PATH 收窄为 codex 所在目录 + 系统路径。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-01-9
Severity: Low
Status: Potential
Current Implementation: Codex 系统级配置（/etc/codex/config.toml、requirements.toml、managed preferences）不在 CODEX_HOME 内，preflight 不检查。
Evidence: 本机均不存在（ls /etc/codex、/Library/Managed Preferences/com.openai.codex.plist 均未找到）；代码中无引用。
Risk: 受管设备上管理员配置可能加入 MCP server 或指令。
Recommended Change: 这些路径存在时 preflight 失败。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-01-10
Severity: Low
Status: Not Applicable（核实为正确）
Current Implementation: (a) hub 仅在 status='running' 时把 run token 解析为唯一 {taskId, workspaceId}，所有 Room 路由使用 auth.workspaceId，sourceMessages 必须属于同一 workspace；(b) read-only 沙箱的写边界成立。
Evidence: tasks.ts:157-163；roomApi.ts:17-23、27-37、56-65；roomApi.test.ts:42-65、67；tasks.test.ts:44、63；实测写 ws_B 与写凭证区域均被拒绝，auth.json 软链接与原文件未变。
Risk: Room MCP 路径未发现问题；泄漏路径绕过它（AR-01-1～3）。
Recommended Change: 无。DC-1 改用 permission profile 时须保持写边界不弱于现状。
Estimated Complexity: —
Decision Conflict: No
```

**隔离测试矩阵（Review 要求）**

| # | 场景 | 自动化覆盖 | 实际状态 |
|---|---|---|---|
| 1 | A 读 B 的文件 | 无（isolation.test.ts:83-91 只断言目录分离） | 失败：可读（实测） |
| 2 | A 读其他 workspace 的 Git 数据 | 无 | 失败：repos/<ws>/.git 可读 |
| 3 | A 读全局配置与凭证 | 部分（不复制用户 AGENTS/config/memories/history：isolation.test.ts:51-71） | 全局配置已隔离；凭证可读；connectors 已加载 |
| 4 | A 调用未授权 MCP | 部分（config 仅 room：isolation.test.ts:61、106；fake-Codex 外部 MCP 被杀：codexAdapter.test.ts:67-89） | 239 个 codex_apps 工具可用；**未用真实 Codex 验证调用是否被拦截**（Open Question） |
| 5 | A 用 shell/文件工具绕过 Room MCP | 无 | 可绕过；修复后未在 exec 中验证（Open Question） |
| 6 | 异常退出后清理临时数据 | 部分（成功路径删除 workDir：codexAdapter.test.ts:51；超时杀进程组：:82-89） | Codex 失败：OK；daemon 崩溃/信号：泄漏（仅代码分析） |

### AR-02 · Git 与 PostgreSQL 一致性

**当前一致性模型（实现）：** git 工作区是知识内容与修改理由的事实来源；PG 是聊天、任务、设置的来源，外加不可重建的派生 `entry_index`、`task_changes`。顺序为先 git、后 PG、PG 仅 best-effort；无游标、无对账、add 无幂等、无崩溃扫描、无备份。另：Review 假设"用户修改理由只在 PG"不成立——理由在 git commit message 中（shared/src/entry.ts:127，store.ts:195-204），PG 不存。

```text
Finding ID: AR-02-1
Severity: High
Status: Confirmed
Current Implementation: commit 后 entry_index 与 task_changes 在事务外分别写入，失败只 console.error，请求仍成功；无任何重建代码。但时间线、Agent prompt 索引、待确认计数与 topOpenQuestion 都由 entry_index 驱动。
Evidence: roomApi.ts:82-89；uiApi.ts:181-187；entryIndex.ts:18-28（timeline 跳过无索引行的条目）；daemonSocket.ts:52 → prompt.ts:38；entryIndex.ts:30-48；entryIndex.ts:9-12（updated_at 为索引时的 clock_timestamp()，非 commit 时间）；grep reindex/rebuild/reconcile 无结果。
Risk: PG 故障、hub 在 commit 与 indexEntry 之间崩溃、约束错误，都会让条目在 git 中存在却从时间线和 Agent 索引中消失，下次运行易产生重复条目；计数与"最重要问题"错误；索引可能残留过期行；重建也无法复现当前排序。
Recommended Change: 见 DC-5：明确 entry_index 为可重建读模型；reindexWorkspace(ws)（store.list + 每条 git log -1 --format=%cI，单事务替换）；workspaces.index_head 游标；hub 启动时及游标 ≠ HEAD 时重建；记账失败时清空游标标脏。
Estimated Complexity: M（约 1 天）
Decision Conflict: No（符合 §4.4、§6.3）
```

```text
Finding ID: AR-02-2（合并原 AR-03-F7）
Severity: High
Status: Confirmed（重跑机制）；Potential（重复条目，取决于模型行为）
Current Implementation: hub 重启或 daemon WebSocket 断开时，所有 running 任务以相同 task id 重新入队、run token 作废、之后从头重跑；第一次尝试已产生的 commit 保留；daemon 不因断线中止 Codex（最多运行到 600 s 超时）。
Evidence: main.ts:58 → tasks.ts:136-142；daemonSocket.ts:166、186-194；tasks.ts:124、138、150、157-163；daemon/connection.ts:74-77、runner.ts:30-48、codex/adapter.ts:67、104；store.ts:159-162（add 总是 max+1）；tasks.ts:168-193（两次尝试的 task_changes 合并在同一 task 下）。旧运行的 task.finished 发往已关闭的 socket 被丢弃（connection.ts:26-28），不会错误归属。重新派发的尝试还要在 daemon 串行链中等待孤儿运行结束。
Risk: 短暂重启、网络抖动、睡眠唤醒都可能让同一输入跑两次：重复的 R-/D-/Q- 条目、两个带同一 Task: trailer 的 commit。AR-03 所说"重跑时 prompt 索引能看到先前新增"只在 indexEntry 成功时成立（依赖 AR-02-1）。
Recommended Change: 见 DC-6：tasks.attempt 列；重派前收集该任务已有 commit（git log --grep "^Task: <id>$" 或 AR-02-6 的 commit 列）并告知 Agent，或标记为 failed 由用户决定（Q2）；daemon 在断线或收到同任务新 assign 时中止旧运行。
Estimated Complexity: M
Decision Conflict: No（保持 §4.5 串行与输入顺序）
```

```text
Finding ID: AR-02-3
Severity: Medium
Status: Confirmed（代码路径存在且无恢复代码）
Current Implementation: upsert = writeFile → git add → git commit -- rel；rollback 仅对进程内捕获的错误执行；启动时不检查 git status。
Evidence: store.ts:188-208；main.ts:54-59；get/list 读工作区（store.ts:92-113、137-146），history/blame 读 git（history.ts:28、86）；pathspec 提交（store.ts:204）不会带上其他残留暂存文件。
Risk: 进程被 SIGKILL/OOM/断电后：UI 与 Agent 看到无 commit、无理由的知识（破坏【决定】§4.4"每次修改 = 一次 commit"）；孤儿 R-n.md 占用 id；blame（HEAD）与正文（工作区）不一致。
Recommended Change: 启动时每个仓库在 withRepoLock 下执行 git status --porcelain，不干净时丢弃或以 "recovered uncommitted change after crash" 提交（Q3）；可选临时文件 + rename 保证原子写。
Estimated Complexity: S
Decision Conflict: No（是在执行【决定】§4.4）
```

```text
Finding ID: AR-02-4
Severity: Medium
Status: Potential
Current Implementation: add 无幂等键；commit 成功但响应丢失时，MCP 工具返回 isError，Codex 可能重试。
Evidence: roomApi.ts:70-80（upsert 内任何异常返回 500，包括 try 之外的 rev-parse：store.ts:209）；mcp/server.ts:22-35；store.ts:159-162。
Risk: 同一知识以不同 id 提交两次。
Recommended Change: 可选 requestId（MCP server 每次调用生成），记录为 Request: trailer 或 PG 行，重放时返回原结果；更便宜的替代：同一任务内拒绝 kind + 规范化标题重复的 add 并返回已有条目。
Estimated Complexity: S–M
Decision Conflict: No
```

```text
Finding ID: AR-02-5
Severity: Medium
Status: Confirmed（缺口）；Potential（影响）
Current Implementation: 两个存储均无备份/恢复，生命周期独立。原始聊天只在 PG；条目来源（frontmatter source_messages、commit Source-Messages）引用 PG 消息 id；用户修改理由只在 git。
Evidence: 001_init.sql:9-17；store.ts:37、173、195-203；commitMessage.ts:19-21；docker-compose.yml:16（nema-pg volume）、:49（~/.nema/data bind mount）@ e731ccc；README.md:59；无 pg_dump / backup 脚本。
Risk: 丢失 PG volume（如 docker compose down -v）后，所有"点理由 → 原始消息"（§4.6）链接失效；两个存储从不同时间点恢复会使 entry_index、task_changes、消息引用失步；丢失 bind mount 则丢失全部知识与理由。
Recommended Change: 见 DC-5：在 README 与 spec 写明权威划分（git = 知识内容/理由/历史；PG = 聊天/任务/设置；entry_index = 派生缓存）；npm run backup（pg_dump + 每仓库 git bundle --all，同一时间戳目录）；恢复后执行重建，无法解析的 source id 显示"消息不可用"。
Estimated Complexity: S（脚本与文档）
Decision Conflict: No。可选项"把来源消息原文镜像进 commit/知识仓库"若使原始聊天对团队可见，则为 Decision Conflict（§3【决定】spec:73），不建议未经批准采用。
```

```text
Finding ID: AR-02-6
Severity: Low
Status: Confirmed
Current Implementation: commit → task 只有单向关联（Task: trailer，仅 Agent）；task_changes 无 commit 列；no-op 时返回当前 HEAD，可能是别的条目的 commit。
Evidence: 001_init.sql:32-39；tasks.ts:165-193；commitMessage.ts:23；store.ts:191-194；roomApi.ts:90；uiApi.ts:177（UI 编辑无 task）。
Risk: 对账与审计无法回答"任务 X 产生了哪些 commit"或"commit Y 是否进入 PG"。
Recommended Change: task_changes 增加 commit 列；upsert 返回 changed 标志，no-op 时返回该条目自身最后 commit。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-02-7
Severity: Low
Status: Potential
Current Implementation: 写串行化仅为进程内 Map（withRepoLock）；跨进程只依赖 git index.lock；失败方 rollback 用内存中的 previous 回写，可能覆盖另一进程已提交的内容。
Evidence: git.ts:16-28；store.ts:182-187、214-226；README.md:67（警告不要同时运行 dev 与 compose）；docker-compose.yml:49 与 main.ts:41 共享数据目录。
Risk: 单用户单 hub 下低；误启两种模式或未来多副本时会丢更新。
Recommended Change: 跨进程锁（pg_advisory_xact_lock(hashtext(workspace_id)) 或 .git/ 下 O_EXCL 锁文件）；过渡方案：rollback 改为从 git show HEAD:rel 恢复。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-02-8
Severity: Low
Status: Confirmed
Current Implementation: workspace 创建/删除跨 FS 与 PG 非原子；删除不持仓库锁，只有 running 任务会阻止删除，进行中的 UI PUT 不会。
Evidence: workspaces.ts:55-61、106-122；uiApi.ts:117-127、173-189。
Risk: 插入失败留下孤儿仓库；rm 失败使已删除的保密 workspace 仓库残留磁盘；UI 编辑与删除竞争。
Recommended Change: 删除时 fs.rm 包在 withRepoLock 中；启动时清扫无 PG 行的 repos/ws_*。
Estimated Complexity: S
Decision Conflict: No
```

### AR-03 · 知识变更与无依据断言

**六种区分的现状：** Explicit User Statement——无（仅 sourceMessages 指向消息，且接受任意角色）；Explicit Decision——部分（kind=decision + active，不区分用户决定与 Agent 推断）；Agent Interpretation——无；Unresolved Assumption——部分，仅靠 prompt 规则 3（prompt.ts:29）；Contradiction——无（Agent 只看到标题索引，prompt.ts:13）；Superseded Decision——部分（status 有 superseded，无 supersededBy 链接、无守卫，prompt 未提及）。

**Agent 可自行推断的边界（Review 要求明确，现 spec 未写）：** Recommendation —— Agent 可以改写措辞、归类、合并重复；**用户没有字面说出的内容必须进入 `question`（待确认），或显式标记为 inferred**；不得据此改写 active 决策。这与 §4.3"读不懂或有歧义的内容，不猜，放进待确认"一致，只是把它从 prompt 约定变为服务端可检查的规则。

```text
Finding ID: AR-03-1
Severity: High
Status: Confirmed
Current Implementation: Agent 可改变 active 决策的 status 或整段改写正文，无任何检查。
Evidence: store.ts:165-177（status 取自输入，body 整体替换）；roomApi.ts:66-72（只检查条目存在）；shared/src/entry.ts:42-48、77-79（只校验状态取值合法，无迁移规则）。
Risk: Review 示例（"暂停所有多轮工作、TTFT < 1s"）可无声替换真实决策；git 只记录、不阻止。
Recommended Change: 见 DC-7：POST /room/entries 对 active 的 decision/requirement 做状态变为 superseded/dropped 或正文改写时，要求 (a) sourceMessages 含本任务用户消息，且 (b) 同任务写入了 supersedes 指向它的新决策，或本任务消息回答了 related 该条目的 question；否则 409 并提示"改为创建 question"。
Estimated Complexity: S–M（roomApi.ts 约 40 行 + 测试）
Decision Conflict: No（§4.2【决定】Agent 直接改仍成立，只拒绝无依据的决策替换；对应 §4.3"冲突先追问"。是否接受此语义见 Q4）
```

```text
Finding ID: AR-03-2
Severity: High
Status: Confirmed
Current Implementation: 来源校验仅要求 id 存在于本 workspace，任意角色、任意时间，不要求包含本任务消息。
Evidence: roomApi.ts:53-65（无 role / task.message_id 过滤）；prompt.ts:28（要求只写在 prompt 中）。用户 PUT 路径无来源检查（uiApi.ts:173-180），schema 默认 sourceMessages=[]（entry.ts:124），解析器接受空 Source-Messages（commitMessage.ts:47）。
Risk: 条目可引用旧消息或 Agent 自己的消息作为"证据"，来源看似有效实则不成立。
Recommended Change: 加载 auth.taskId 对应的 tasks.message_id，要求其在 sourceMessages 中；来源须为 user 角色（或正在被回答的 Agent 提问消息）；拒绝晚于本任务消息的来源。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-03-3
Severity: Medium
Status: Confirmed
Current Implementation: 两条写路径均无版本冲突检测（last-writer-wins）。
Evidence: entry.ts:115-128（无 base revision 字段）；uiApi.ts:173-181；apps/web/components/EntryDetail.tsx:195-206；store.ts:148-177。仓库锁（store.ts:150）只排序写入。
Risk: 任务运行期间用户的纠正（§4.2 的纠错机制）可能被 Agent 静默覆盖，反之亦然。
Recommended Change: 可选 baseCommit；store.upsert 与该文件最后 commit 比对，不一致返回 409；UI 发送加载时的 commit；Agent 侧可在条目于任务开始后被用户编辑时拒绝更新。
Estimated Complexity: M
Decision Conflict: No
```

```text
Finding ID: AR-03-4
Severity: Medium
Status: Confirmed
Current Implementation: 用户编辑回传 Agent 原有的 sourceMessages，用户 commit 的 Source-Messages trailer 指向 Agent 时期的消息。
Evidence: EntryDetail.tsx:202；store.ts:200。Author: user 记录正确，理由必填（EntryDetail.tsx:189、entry.ts:127）。
Risk: blame / "为什么"视图把人工修改归因到旧消息，削弱【决定】§4.4 的可追溯性。
Recommended Change: UI 编辑发送 sourceMessages: []；author=user 时写空 Source-Messages 或加 Edit: direct trailer；frontmatter 并集保持不变。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-03-5
Severity: Medium
Status: Confirmed
Current Implementation: 陈述、解释、假设在一个 body 中混合；无矛盾或取代链接。
Evidence: entry.ts:92-113；prompt.ts:26-34（无区分陈述与推断的规则，无取代规则）。
Risk: 推断出的约束与用户陈述在读者信任的知识面板上看起来一样。
Recommended Change: 可选、向后兼容字段 origin: stated|decided|inferred、supersedes: ID[]；prompt 增加上文"推断边界"规则。不建议 V1 引入逐 claim 的 claims[] 必检（见 DC-7）。
Estimated Complexity: M
Decision Conflict: No（逐 claim 必检若成为写入门槛则为 Decision Conflict，§4.2 spec:101）
```

```text
Finding ID: AR-03-6
Severity: Medium
Status: Confirmed
Current Implementation: lastAskedQuestion 在任务被领取时解析，而非用户消息发出时。
Evidence: daemonSocket.ts:45-47；messages.ts:103-118（包含用户消息之后发出的 Agent/系统消息）。
Risk: 连续输入时，B 被当作用户尚未看到的问题的答案，Agent 可能据此解决错误的问题并写入决策（prompt.ts:42 提示"很可能是对它的回答"）。
Recommended Change: 取 seq 小于该用户消息的最后一条 Agent 消息；之后的 Agent 消息排除或标注"发布于本输入之后"。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-03-7
Severity: Low
Status: Confirmed
Current Implementation: related id 不校验，仅存储。
Evidence: entry.ts:99、123；roomApi.ts、store.ts 无检查。
Risk: 悬空或格式错误的链接；削弱 AR-03-1 中依赖 related 的守卫。
Recommended Change: upsert 前校验 ID_RE 且条目存在。
Estimated Complexity: S
Decision Conflict: No
```

```text
Finding ID: AR-03-8
Severity: Low
Status: Not Applicable
Current Implementation: Review 担心的同一 workspace 内 Agent 并发写入。
Evidence: tasks.ts:64-80（每 workspace 仅一个 running）；daemonSocket.ts:60、89；store.ts:150。另：MCP 层注册 inputSchema: UpsertEntryInput.shape（mcp/server.ts:51），只校验字段形状，对象级 superRefine 与全部语义检查在 hub 侧。
Risk: Agent–Agent 并发无风险；真实的顺序风险是 AR-03-3、AR-03-6、AR-02-2。
Recommended Change: 无。
Estimated Complexity: —
Decision Conflict: No
```

---

## 3. Open-Source Verification Matrix

核实方式：GitHub REST API（repo / commits / contents / trees / releases / contributors）+ 原始 README + 选定文件。未安装或运行任何项目。

**OS-01 · cloudflare/security-audit-skill**
- Repository: https://github.com/cloudflare/security-audit-skill
- Repository Verified: Yes
- Last Activity: pushed 2026-09-14；创建 2026-06-18；未归档
- License: MIT
- Technical Capability: Markdown skill，6 阶段安全审计；确定性部分为零依赖 Node 校验器 `validate-findings.cjs`、`validate-coverage-ledger.cjs`；`report-schema.json` 三态判定 confirmed（需 trace + evidence）/ needs_validation（需写出具体未决事实）/ rejected。领域是代码安全漏洞，不是业务知识来源校验。
- Integration Method: 产品内无实际集成方式；只能借鉴模式。
- Maintenance Risk: 低–中（Cloudflare，活跃；README 称其为内部 harness 的种子，公开版可能不跟进）
- Security Risk: 仅借鉴设计时低
- Overlap with Existing Design: Agent 写入须引用 ≥1 条已存在消息（roomApi.ts:53-55）；commit 格式总带 Reason/Author，但 Source-Messages 可为空、用户编辑不要求来源（修正原报告对 commitMessage.ts:28-49 的误读）；§4.3"不清楚 → 待确认"近似 needs_validation。
- Actual Benefit to Nema: 中，仅设计输入（需写明未决事实的待确认态；写后确定性校验）
- Integration Cost: 借鉴低；每次变更再加独立验证 Agent 则高（全局串行，延迟约翻倍）
- Recommendation: **Borrow Design**。Decision Conflict（条件性）：独立验证若成为右侧更新前的门槛，则与 §4.2【决定】冲突；事后标记不冲突。

**OS-02 · google-research/harness2**
- Repository: https://github.com/google-research/harness2
- Repository Verified: Yes
- Last Activity: pushed 2026-10-14；创建 2026-10-06；仅 3 个 commit
- License: Apache-2.0（第三方代码/数据集保留上游许可）
- Technical Capability: Python 3.12 / Linux 研究框架，固定模型权重下递归优化 harness（Propose–Probe–Compose，8 类组件）；自带 JobBench、LAB、WorkBuddy-Bench。无需求澄清/逐问基准、无模拟用户。README 称增加递归预算可进一步提分，是否有算力对齐基线为 Open Question（docs/EXPERIMENTS.md 未读）。参考配置使用 Vertex AI / API key，Codex executor 关闭沙箱、网络不受限（docs/SETUP.md、README）。
- Integration Method: 仅可作为另一台 Linux 机器上的离线研究工具
- Maintenance Risk: 高（新发布，"not an officially supported Google product"）
- Security Risk: 中–高（若靠近用户数据运行）
- Overlap with Existing Design: 无
- Actual Benefit to Nema: V1/V1.1 低；昂贵部分是 Nema 自己的 Grill 基准与模拟用户
- Integration Cost: 高
- Recommendation: **Prototype Later**（只取"Grill 离线评测集"这个想法，不采用框架）。Decision Conflict：条件性——仅当其运行进入 Nema 产品/运行路径时与 §6.1【决定】（不用 API key，spec:205-207）冲突；离线研究预算属用户决定（Q9）。

**OS-03 · headroomlabs-ai/headroom**
- Repository: https://github.com/headroomlabs-ai/headroom
- Repository Verified: Yes
- Last Activity: pushed 2026-10-22；创建 2026-01-07
- License: Apache-2.0（另有商业 Enterprise 版）
- Technical Capability: 本地上下文压缩（Python 库、TS SDK、proxy、MCP、wrap）；按 JSON / 代码 / 文本分别处理，可逆缓存（CCR）。TS SDK "Requires a running Headroom proxy"，proxy 只在 PyPI 包中，即仍需 Python sidecar。匿名 beacon 默认开启、每日更新检查默认开启（可关闭）。另含跨 agent 共享记忆、`headroom learn` 写 AGENTS.md/CLAUDE.md、`wrap` 改 ~/.claude.json。ID/日期/约束措辞是否逐字保留：无文档（Open Question）。
- Integration Method: 仅无状态 proxy/库模式，关闭 memory、learn、wrap、遥测、更新检查
- Maintenance Risk: 活跃度低风险；变化极快，开源/商业分层可能把功能移入付费版
- Security Risk: 中（位于完整 prompt 路径；默认 beacon；CCR 缓存集中保存所有 workspace 原文）
- Overlap with Existing Design: 无；§6.6 第 4 项已要求关闭遥测与更新检查
- Actual Benefit to Nema: V1 低（Nema 负载是短 Markdown + 聊天，Headroom 的收益来自大型工具输出/日志/JSON）
- Integration Cost: 中（Python 运行时 + HF 模型 + ID 保真测试）
- Recommendation: **Prototype Later**（仅在实测上下文规模成为问题时）。Decision Conflict：memory / learn / wrap 模式与 §6.6【决定】及 §7【决定】(spec:291) 冲突，禁止启用；压缩结果不得写回 Git 知识库（Review 自身约束）。

**OS-04 · fabio-rovai/open-ontologies**
- Repository: https://github.com/fabio-rovai/open-ontologies
- Repository Verified: Yes
- Last Activity: pushed 2026-10-17；创建 2026-03-09
- License: MIT（另有托管商业平台）
- Technical Capability: Rust 单二进制 + MCP，OWL/RDFS 本体的 plan/apply/rollback；报告影响范围、风险分、保守性；SHACL、SWRL/RIF/Horn 规则。Proof certificate 可由独立的 Lean 4 checker 验证（不与引擎共享代码，伪造结论 exit 1）；不保证不可满足性结论。不原生支持 Requirement/Decision/Trade-off，需先映射到 RDF。
- Integration Method: 对 Git 知识库导出的 RDF 运行外部 CLI/MCP（可选、单向）
- Maintenance Risk: 中（实质单一维护者 + 商业托管；CI 活跃）
- Security Risk: 低（本地离线）
- Overlap with Existing Design: 低；§4.3 冲突检测依赖 Agent 判断，无形式规则层
- Actual Benefit to Nema: V1/V2 低；可借鉴"应用前的影响说明"，用 frontmatter 类型化链接即可实现
- Integration Cost: 高（RDF 建模 + Rust + Lean）
- Recommendation: **Borrow Design**。Decision Conflict（条件性）：强制 plan-then-apply 审批步骤与 §4.2【决定】冲突；仅展示说明不冲突。

**OS-05 · ModernRelay/omnigraph**
- Repository: https://github.com/ModernRelay/omnigraph
- Repository Verified: Yes
- Last Activity: pushed 2026-10-22；创建 2026-04-10
- License: MIT（另有 Omnigraph Cloud 私有预览）
- Technical Capability: Rust 图数据库，数据存为 Lance 文件（本地/S3）；类型化 schema、图/向量/BM25 检索、每次变更 Cedar 策略、TS SDK/MCP/HTTP。分支、合并、time travel 仅由 README 核实（未看代码）。数据模型不是 Git Markdown；按设计就是第二个权威存储。
- Integration Method: 独立 omnigraph-server + 自有存储，hub 通过 TS SDK 访问
- Maintenance Risk: 中–高（提交极快、商业云产品、部分功能为 preview）
- Security Risk: 中（新增联网服务；官方安装方式为 curl | bash）
- Overlap with Existing Design: §6.3 每 workspace 一个 git 仓库已提供分支/合并/历史/blame；时间线由 PG 索引生成（spec:119）；spec:27-34 记录了 Multica"两套进度记录各说各话"的教训
- Actual Benefit to Nema: 低
- Integration Cost: 高
- Recommendation: **Reject**（比 Review 的"Borrow Design, V2+"更严格）。理由为双权威存储，属 Recommendation。**不构成 Decision Conflict**：目标 4【决定】要求的是可追溯历史而非 git 本身；冲突对象是 §6.3【Claude 的决定】与 §1.2/1.3 单一事实来源的教训（无【决定】标记）。未来如需关系查询，用 PG 关系表从 frontmatter 建索引。

**OS-06 · Graphify-Labs/graphify**
- Repository: https://github.com/Graphify-Labs/graphify
- Repository Verified: Yes
- Last Activity: pushed 2026-10-21；release v0.9.93（2026-10-20）
- License: Apache-2.0（根目录另有 LICENSE-MIT 与 NOTICE）
- Technical Capability: Python CLI + skill；tree-sitter 本地解析约 40 种语言（含 TS）为 graph.json；边标注 EXTRACTED / INFERRED；query/path/explain、增量 --update、git hook、可选 MCP。文档/媒体走 LLM 语义处理。不原生支持"需求条目 → 代码符号"关联。
- Integration Method: 作为外部 CLI/MCP 针对目标代码仓库运行，置于 Code Intelligence 适配器之后
- Maintenance Risk: 低–中（非常活跃；open issues 多；README 推广 Graphify Cloud）
- Security Risk: 中。README 写"No telemetry"，但所有 query 默认记录到全局 `~/.cache/graphify-queries.log`（README:421-422，跨项目共享文件，可用 GRAPHIFY_QUERY_LOG_DISABLE=1 关闭）；install 会写 CLAUDE.md/AGENTS.md/hooks。
- Overlap with Existing Design: 与 V1 无重叠；对应 §8 第 3 项（任务上下文包中的代码位置）
- Actual Benefit to Nema: 未来阶段中等；需求 → 符号映射仍需 Nema 自己做
- Integration Cost: 中
- Recommendation: **Prototype Later**（V2，仅外部适配器）。Decision Conflict：若注入到 Nema 知识整理 Agent 的运行配置中，与 §7【决定】(spec:291，"其他 MCP server") 冲突。

**OS-07 · ranxianglei/billion-context**
- Repository: https://github.com/ranxianglei/billion-context
- Repository Verified: Yes
- Last Activity: pushed 2026-10-22；release v0.1.204（2026-10-21）；创建 2026-08-06
- License: API 为 NOASSERTION；LICENSE 为 MIT **附加署名条款**（面向用户的产品须在首页/文档/About 署名），非标准 MIT
- Technical Capability: 本地 HTTP proxy，改写 Anthropic/OpenAI 请求与响应流，向会话注入 compress / decompress / search_context / acp_status 工具，维持长期会话；多种客户端通过证书 MITM 或改写启动配置接入
- Integration Method: 把 Agent 的 base URL 指向 proxy，或以插件写入客户端配置
- Maintenance Risk: 中（主要单一作者，2.5 个月 204 个补丁版本）
- Security Risk: 高（全部模型流量经第三方改写 proxy；需信任本地 CA；修改客户端配置）
- Overlap with Existing Design: 冲突：Nema 运行 --ephemeral 且关闭历史（spec:266），持久知识在 git + PG
- Actual Benefit to Nema: 基本没有（运行短且无状态）
- Integration Cost: 高
- Recommendation: **Reject**（Review 为"Research Only"，此处改为明确拒绝）。Decision Conflict：Yes——注入非 Room 工具并跨运行留存会话，冲突 §7【决定】(spec:291) 与 §6.6【决定：隔离本机 Agent】。

**OS-08 · croffasia/itsaplan**
- Repository: https://github.com/croffasia/itsaplan
- Repository Verified: Yes
- Last Activity: pushed 2026-10-22；release v1.7.0；创建 2026-07-14
- License: AGPL-3.0（`packages/runner` 为 Apache-2.0；另售商业许可）
- Technical Capability: 完整自托管 Linear/Jira 替代品，自有 issue 数据库（Drizzle + PG）；AI agent 作为项目成员，按 @mention / 指派 / 定时触发；外部 agent 通过 @itsaplan/runner 驱动 Claude Code、Codex 等；REST/MCP/webhook；PR 关键字关联
- Integration Method: 作为独立服务并成为任务记录系统
- Maintenance Risk: 中（README："Expect breaking changes before the first stable release"；单一维护者主导）
- Security Risk: 中
- Overlap with Existing Design: 与 GitHub Project 重度重叠，重复 Multica 的失败模式（spec:27）
- Actual Benefit to Nema: 仅设计参考（agent-as-assignee、触发类型、runner 协议、PR 关键字关联）
- Integration Cost: 集成高；借鉴想法低（禁止复制 AGPL 代码，仅 Apache-2.0 runner 可复用）
- Recommendation: **Borrow Design**。与 spec 非目标（spec:52）和反目标（spec:61）冲突，但**不是**【决定】冲突。

**OS-09 · reason-machines/reason-network**
- Repository: https://github.com/reason-machines/reason-network
- Repository Verified: Yes
- Last Activity: pushed 2026-10-22；release v0.12.6；**创建 2026-10-16（6 天前）**
- License: API 为 Apache-2.0，README 写 MIT OR Apache-2.0
- Technical Capability: 各机器上的 Rust daemon，让队友机器上的编码 agent 会话通过 iroh 端到端加密 P2P 互相可见、互发消息（默认回落到 Reason relay）；向每个本地 agent 配置注入 MCP（list_team、send_message、ask_user、check_inbox）；需 Reason 账号；curl | bash 安装并自动更新。是团队在线/消息层，不是 server↔daemon 任务传输。README 中有面向 AI agent 的引导文字（要求 agent 访问其网站加入），已作为数据处理，未执行。
- Integration Method: 安装 daemon 并让其注册 MCP，或使用托管 MCP
- Maintenance Risk: 高（不足一周、依赖厂商账号与 relay）
- Security Risk: 高（第三方身份、广播会话元数据、自动更新二进制、接收他人文件）
- Overlap with Existing Design: Nema 已有 hub↔daemon WebSocket（spec:220、252）；V1 不需要 agent 间聊天
- Actual Benefit to Nema: V1/V2 无
- Integration Cost: 中–高
- Recommendation: **Reject**（Review 的"V3 候选"无依据）。Decision Conflict：Yes——向所有本地 agent 注入 MCP 并向队友发布会话活动，冲突 §7【决定】(spec:291) 与保密反目标（spec:63）。

**OS-10 · pgrundev/pgx**
- Repository: https://github.com/pgrundev/pgx
- Repository Verified: Yes
- Last Activity: pushed 2026-10-22；首个 release v0.1.0（2026-10-21）；**创建 2026-10-08；2 名贡献者**
- License: AGPL-3.0
- Technical Capability: 讲 Postgres wire 协议的 Rust 运行时，一个进程托管数千个短期数据库（ZFS 块克隆 CoW）；223/231 回归测试逐字节通过；**不 crash-safe（fsync = off）**、无 C 扩展；curl | sh 安装。是否支持 Nema 依赖的全文检索（spec:245）未核实（code search 0 结果不能定论）。
- Integration Method: CI/dev 中运行 pgx 并把 NEMA_DATABASE_URL 指向它
- Maintenance Risk: 高
- Security Risk: 仅测试用途时中
- Overlap with Existing Design: 已覆盖——测试用进程内 PGlite（apps/hub/package.json:13、apps/hub/test/helpers.ts:4），真实 postgres:17 经 Compose（docker-compose.yml:7）；已知 PGlite 缺口 FOR UPDATE SKIP LOCKED（apps/hub/test/tasks.test.ts:142）更适合用现有真实 Postgres 覆盖
- Actual Benefit to Nema: 基本没有
- Integration Cost: 低–中，但无收益（会引入第三种数据库引擎）
- Recommendation: **Reject**

**汇总**

| ID | 仓库 | Verified | License | 与 Review 描述是否相符 | Recommendation |
|---|---|---|---|---|---|
| OS-01 | cloudflare/security-audit-skill | Yes | MIT | 相符，但仅安全审计领域 | Borrow Design |
| OS-02 | google-research/harness2 | Yes | Apache-2.0 | 部分：无澄清类基准；预算越大分越高 | Prototype Later |
| OS-03 | headroomlabs-ai/headroom | Yes | Apache-2.0 | 大体相符：TS 需 Python proxy；遥测默认开 | Prototype Later |
| OS-04 | fabio-rovai/open-ontologies | Yes | MIT | 相符：Lean 证书真实；仅 RDF/OWL | Borrow Design |
| OS-05 | ModernRelay/omnigraph | Yes | MIT | 相符，且按设计是第二权威存储 | Reject |
| OS-06 | Graphify-Labs/graphify | Yes | Apache-2.0 | 相符；无需求 → 符号原生关联 | Prototype Later |
| OS-07 | ranxianglei/billion-context | Yes | NOASSERTION（MIT + 署名） | 相符 | Reject |
| OS-08 | croffasia/itsaplan | Yes | AGPL-3.0 | 相符，但是完整的竞争 issue 系统 | Borrow Design |
| OS-09 | reason-machines/reason-network | Yes | Apache-2.0 / MIT | 部分：团队 agent 消息，非任务传输 | Reject |
| OS-10 | pgrundev/pgx | Yes | AGPL-3.0 | 相符 | Reject |

统计：Integrate Now 0 · Borrow Design 3 · Prototype Later 3 · Reject 4。

---

## 4. Concrete Design Changes

### DC-1 · Codex 运行配置加固（解决 AR-01-1、AR-01-2、AR-01-3 主体）
- 影响章节：spec §6.6 第 3、4、7 项；README "隔离"一节；`isolation.ts` 及其测试（plan 中固定 `sandbox_mode: "read-only"` 的测试，plan:568）
- 为什么必须改：当前实现违反 §7【决定】(spec:291) 中"其他 MCP server""文件访问"两项，已由磁盘证据与实测确认。
- 是否与【决定】冲突：No（执行 §6.6【Claude 的决定】第 7 项"能关的尽量关；最严格的可行沙箱"）
- 最小修改方案（Recommendation；**已解析并做 sandbox 探针，未在真实 `codex exec` 回合中验证**）：
  1. **在现有键之上追加**，不得删除 `history.persistence="none"`、`[analytics] enabled=false`、`check_for_update_on_startup=false`、`shell_environment_policy`、`web_search`、`features.memories=false`。
  2. 合并后的必须关闭清单：`shell_tool`、`unified_exec`、`view_image`（`[tools] view_image=false` 与 `features.view_image` 的正确写法需以 `codex features list` 为准）、`apps`、`plugins`、`remote_plugin`、`hooks`、`multi_agent`、`image_generation`、`browser_use`、`computer_use`、`code_mode_host`、`skill_mcp_dependency_install`、`tool_suggest`、`goals`。
  3. 用 `default_permissions = "nema-room"` 替换 `sandbox_mode`（两者不能共存）：`":minimal"="read"`、`":workspace_roots" "."="read"`、Codex 二进制所在目录（运行时解析软链链，如 `~/.local/bin` 与 `~/.codex/packages/standalone`，**不得授权 `~/.codex` 本身**）为 read；`/tmp`、`/private/tmp`、`~/.nema`、`~/.codex` 为 deny。实测：该 profile 下 `~/.nema`、`~/Desktop`、`$TMPDIR`、`~/.codex/config.toml` 均被拒，cwd 可读；不授权 Codex 安装路径时 Codex 自身 helper 会失败。
  4. `mcp_servers.room.enabled_tools = [Room 工具名]`；以 `--strict-config` 运行；preflight 增加 `codex features list` 对照清单、校验 `default_permissions` 存在。
- 可替代方案：每 workspace 独立系统用户（3–5 天，需 sudo；auth.json 软链跨用户失效，需各自登录或凭证代理，可能被迫改用 API key → 有 §6.1【决定】冲突风险）；每次运行一个容器（3–5 天，macOS 上失去 Seatbelt；凭证同样难处理）；独立 VM（未评估成本）。三者都只推翻 spec:280 的【Claude 的决定】，不推翻用户【决定】。
- 预计成本：0.5–1 天 + 0.5 天真实 Codex 验证（Linux 上 `:minimal` 范围、`/tmp` 处理、bwrap 缺失时行为另需验证）
- 不修改的后果：V1 保密 workspace 的保证不成立；任何 prompt injection 都可读取其他 workspace 与共享凭证。

### DC-2 · 解决 spec 内部矛盾：残余风险声明 vs 隔离硬约束
- 影响章节：spec §6.6"明确接受的残余风险"（spec:280）与 §7（spec:291）
- 为什么必须改：spec:280（【Claude 的决定】，接受同用户读）与 spec:291（用户【决定】，禁止文件访问泄漏）互相矛盾，代码按前者实现。
- 是否与【决定】冲突：取决于用户选择（Q1）。选 DC-1 修复：No。选"接受残余风险、弱化保密表述"：**Decision Conflict（§7 spec:291）**。
- 最小修改方案：采用 DC-1 后，把残余风险改写为"Codex 自身的非沙箱读取、服务商侧共享、跨版本漂移"，删除"Agent 可通过命令读取其他 workspace"。
- 可替代方案：用户明确接受同用户读，并修改 §7。
- 预计成本：文档 0.5 小时
- 不修改的后果：spec 对读者给出互相矛盾的保证。

### DC-3 · 运行状态卫生与版本门槛（AR-01-5、AR-01-6、AR-01-7、AR-01-8、AR-01-9）
- 影响章节：spec §6.6 第 4、5 项；README.md:106
- 为什么必须改：Codex 写入的状态跨运行留存；无版本门槛；崩溃后孤儿进程破坏"全局串行"（spec:264）。
- 是否与【决定】冲突：No
- 最小修改方案：每次运行前清空 codexHome（保留 config.toml、auth.json）；SIGINT/SIGTERM 处理 + 启动时清扫 `nema-run-*`；已测试版本范围 + 启动自检；preflight 增加 `.codex`、`.agents` 与系统级配置路径检查；修正 README。
- 可替代方案：每次运行全新 CODEX_HOME 目录。
- 预计成本：约 1 天
- 不修改的后果：状态泄漏、额度浪费、令牌刷新竞争；下次 Codex 升级可能再次静默扩大工具面。

### DC-4 · 改写 §6.6 第 8 项自检方式（AR-01-4）
- 影响章节：spec §6.6 第 8 项；events.ts:15-16 注释
- 为什么必须改：spec 要求的"从初始化事件确认"在 `exec --json` 下不可行，现状是未记录的偏离；且 Agent 自我描述不可作证据。
- 是否与【决定】冲突：No（【Claude 的决定】）
- 最小修改方案：以权威来源自检——生成的 config + features 清单 + 目录检查 + JSONL 事件流断言（无 command_execution、无非 room 调用）。
- 可替代方案：迁移到 `codex app-server` 获取启动事件（需评估）。
- 预计成本：M（含在 DC-1/DC-3 实现中约 0.5 天）
- 不修改的后果：自检给出虚假安全感。

### DC-5 · 明确存储权威划分并提供恢复路径（AR-02-1、AR-02-3、AR-02-5、AR-02-6）
- 影响章节：spec §6.3、§4.4；README；迁移文件
- 为什么必须改：entry_index 实际上是第二事实来源且不可重建；崩溃会留下未提交的知识；无备份。
- 是否与【决定】冲突：No（使 §4.4【决定】"每次修改 = 一次 commit"得到执行）
- 最小修改方案：spec 写明 git = 知识内容/理由/历史，PG = 聊天/任务/设置，entry_index = 派生缓存；`reindexWorkspace` + `workspaces.index_head` + 启动时重建；启动 `git status` 恢复；`task_changes.commit`；`npm run backup`（pg_dump + git bundle）。
- 可替代方案：把 entry_index 写入与 commit 放入同一"outbox"表再异步投递（更复杂，不建议 V1）。
- 预计成本：约 1.5–2 天
- 不修改的后果：PG 抖动即可让条目从时间线和 Agent 索引中消失，进而产生重复知识；数据丢失无法恢复。

### DC-6 · 中断任务的处理语义（AR-02-2、AR-02-4）
- 影响章节：spec §4.5（串行处理）、§6.2（daemon 行为）
- 为什么必须改：当前"静默整段重跑 + 旧进程继续运行"会产生重复条目并破坏串行保证。
- 是否与【决定】冲突：No
- 最小修改方案：`tasks.attempt`；daemon 断线或收到同任务新 assign 时中止旧运行；重跑时在 prompt 中列出该任务已写入的条目（或标记 failed，见 Q2）；同任务内拒绝重复标题的 add。
- 可替代方案：requestId 幂等键（S–M）。
- 预计成本：约 1 天
- 不修改的后果：睡眠唤醒、网络抖动即导致重复知识。

### DC-7 · 知识变更的确定性约束（AR-03-1～AR-03-7）
- 影响章节：spec §4.2、§4.3、§4.4、§6.2（"Room MCP 强制执行规则"）
- 为什么必须改：spec 说规则"在 Room MCP 强制执行，不依赖 Agent 自觉"（spec:228），但来源深度、决策变更、推断边界目前只在 prompt 中。
- 是否与【决定】冲突：No——有效更新仍立即生效，无收件箱/审核；只拒绝无来源或试图替换决策的更新。逐 claim 的 `claims[]` 必检**不采用**（若成为写入门槛则为 Decision Conflict，§4.2 spec:101）。
- 最小修改方案：roomApi 四项检查（本任务消息必须在来源中且来源为 user 角色或被回答的提问；active 决策变更需 supersedes 或已回答的 question，否则 409；`baseCommit` 比对；`related` 校验）；可选字段 `origin`、`supersedes`；lastAskedQuestion 按消息 seq 计算；用户编辑不回传旧来源；spec §4.3 写入推断边界。
- 可替代方案：只做 prompt 规则（成本低，但不可验证，不推荐）。
- 预计成本：约 1.5–2 天
- 不修改的后果：知识面板中推断与陈述无法区分；一次误读即可无声替换已确认的决策，违背产品"可信知识系统"的核心目标。

### DC-8 · Part III：Extension Interfaces 是否需要提前抽象 —— 不需要
- 影响章节：spec §6.2 / §8（仅文档）
- 判断（Recommendation）：
  - V1 已有的两个边界就够了：**Room MCP 作为唯一知识写入口**（spec:228）与 **daemon 适配器接口**（spec:229）。第 3 节中没有任何项目被建议 Integrate Now，Context Processor / Knowledge Validator / Harness Evaluator / Code Intelligence 四个接口目前都没有第一个实现者，提前抽象属于为假想需求过度设计。
  - 第 8 条约束"外部索引属于派生数据、必须可重建"已经由 DC-5 的 entry_index 重建落地为第一个实例；第 4–7 条约束（不绕过保密策略、第三方不直接写 Git）由 DC-1 与 DC-7 在实现上保证。
  - 建议只把 Part III 的 9 条约束作为原则写入 spec §8，等到出现第一个真实集成（预计 V2 的 Graphify 或 GitHub 只读同步）时再抽出对应接口。
- 是否与【决定】冲突：No（§2.1 目标 7"为以后对接打好基础"由现有 Room MCP + 适配器满足）
- 成本：文档 0.5 小时；不做的后果：无（反之，提前抽象会增加 V1 维护成本）。

---

## 5. Proposed Revised Roadmap

**Must Fix Before V1**
1. DC-1 Codex 配置加固（features 关闭清单 + permission profile + strict-config + enabled_tools），并用真实 `codex exec` 跑通隔离矩阵第 4、5 行
2. DC-2 解决 spec:280 与 spec:291 的矛盾（需用户裁决 Q1）
3. DC-3 运行状态清空、信号处理与临时目录清扫、Codex 版本门槛
4. DC-5 entry_index 可重建 + index_head 游标 + 启动时 git 状态恢复
5. DC-6 中断任务不再静默重跑；断线时中止旧运行
6. DC-7 中的 AR-03-1（决策变更守卫）、AR-03-2（来源校验深度）、AR-03-6（lastAskedQuestion 时点）

**Should Improve After V1**
- DC-4 自检方式改写 / 评估 `codex app-server`
- DC-5 中的备份脚本与 `task_changes.commit`；AR-02-4 幂等键；AR-02-7 跨进程锁；AR-02-8 workspace 删除加锁与孤儿清扫
- DC-7 其余部分：baseCommit、`origin`/`supersedes` 字段、用户编辑来源修正、`related` 校验
- AR-01-3 upsert token 形态扫描；AR-01-8/9 preflight 补充
- Grill 离线评测集（自建，不依赖 Harness2）

**Future Research**
- 凭证代理 / 每 workspace 独立系统用户 / 容器 / VM（spec §8 第 7 项）
- OS-06 Graphify 作为外部 Code Intelligence 适配器（V2，关闭查询日志，不注入 Agent 配置）
- OS-03 Headroom 无状态 proxy（仅当实测上下文规模成为问题）
- OS-01 / OS-04 / OS-08 设计借鉴（三态判定、变更影响说明、agent-as-assignee）

**Not Recommended**
- OS-05 Omnigraph、OS-07 billion-context、OS-09 Reason Network、OS-10 PGX
- 逐 claim 必检或任何写入前审批步骤（与 §4.2【决定】冲突）
- 把来源消息原文镜像进团队可见的知识仓库（与 §3【决定】冲突）
- V1 提前抽象 4 个 Extension Interfaces

---

## 6. Questions Requiring User Approval

以下事项需由用户决定，本报告不作决定。

> **2026-10-23 用户回答（已写入 spec `docs/superpowers/specs/2026-10-21-nema-room-design.md`）：**
> - Q1：问题已不存在。Codex 不再启动 CLI（6.7），Claude Code 去掉内置工具后只剩 Room MCP（runtime spec），Agent 没有文件访问；§7 硬约束保持不变。
> - Q2：hub 重新连上后自动重试，最多 3 次；都失败则标失败（§4.5）。
> - Q3：保留，以 "recovered" commit 提交（§4.5）。
> - Q4：符合（§4.2）。
> - Q5：区分 `stated / decided / inferred`（§4.3）。
> - Q6：不做备份命令；原文可以进知识库，但要标进库时间和最后确认时间，外部文档同样（§3、§4.1、§4.4、§6.3）。
> - Q7：单进程（§7）。
> - Q8：作废，Codex CLI 已移除。
> - Q9：到提高精度阶段再说（§8）。
> - Q10：未回答（Claude 建议直接删除 `~/.nema/ws/*/codex-home/`，不读内容）。
> - Q11：现在先建骨架，以后优先考虑 VM（§8）。

1. **Q1 威胁模型 / 保密边界：** V1 是否要求挡住"被 prompt injection 的 Agent 读取其他 workspace 文件"？选"是"→ 实施 DC-1 并改写 spec:280；选"否，接受同用户读"→ 需修改 §7【决定】(spec:291)，属 **Decision Conflict**。
2. **Q2 中断任务：** hub 重启或断线后，被中断的任务应自动重跑（当前行为，需告知 Agent 已写入内容），还是标记为 failed 由用户重新发送？
3. **Q3 崩溃恢复：** 启动时发现未提交的写入，是丢弃（Agent 可重做），还是以 "recovered" commit 保留？
4. **Q4 决策变更守卫语义：** Agent 试图作废/改写 active 决策但缺少依据时，服务端返回 409 并要求改写为 question——是否符合你对 §4.2"Agent 直接改"的理解？
5. **Q5 推断标记：** 是否在数据与 UI 中区分 `stated / decided / inferred`？是否把"用户没说的内容必须进待确认或标 inferred"写入 §4.3？
6. **Q6 备份：** 是否增加 `npm run backup`？是否在任何情况下允许把来源消息原文写入知识仓库（与 §3【决定】相关）？
7. **Q7 部署形态：** 是否计划多进程 / 多副本 hub？若是，AR-02-7 升为 High。
8. **Q8 Codex 版本策略：** 是否接受固定已测试版本范围、每次升级重新核实？
9. **Q9 离线评测预算：** 是否愿意在 §6.1 之外为 Grill 离线评测使用 API key / 独立机器？
10. **Q10 现存状态：** `~/.nema/ws/*/codex-home/memories_1.sqlite` 等文件是否允许检查内容或直接清除？（本次刻意未读取）
11. **Q11 后续加固方向：** 若未来需要更强隔离，优先评估凭证代理、独立系统用户、容器还是 VM？

---

## 附录 · 核实方法（2026-10-22）

**实际运行（只读，不修改仓库，未启动 hub / web / docker）：**
- `codex --version`（codex-cli 0.163.0）、`codex --help`、`codex exec --help`、`codex features list`（使用与 `renderCodexConfig` 相同键的临时 CODEX_HOME，两位核实者独立运行）、`codex debug prompt-input`
- `codex sandbox` 对临时目录中的伪造文件做读/写探针（read-only 配置与 permission profile 配置各一组）
- 真实 `codex exec --json`，按 `adapter.ts` 参数与 `buildEnv` 环境复现（room MCP 以 `true` 代替），共 3 次：跨 workspace 读（成功泄漏预埋 secret）、读用户 home 与写他人仓库（读成功、写被拒）、要求 Agent 自述工具（结论仅用于"自述不可信"）
- GitHub REST API 查询 10 个仓库的元数据、commits、releases、contributors、README 与选定文件
- grep 检查信号处理、重建/对账/备份代码是否存在

**阅读：** 被核实的 Review；spec §1–§8；plan；README；`apps/cli/src/codex/{isolation,adapter,events}.ts`、`apps/cli/src/{doctor.ts,mcp/server.ts,daemon/*}`；`apps/hub/src/{roomApi,uiApi,entryIndex,tasks,messages,workspaces,daemonSocket,main,prompt}.ts` 与迁移文件；`packages/knowledge/src/*`；`packages/shared/src/entry.ts`；`apps/web/components/EntryDetail.tsx`；对应测试；openai/codex 源码 tag `rust-v0.163.0`（permissions.rs、seatbelt.rs、bwrap.rs、spec_plan.rs、view_image.rs）；learn.chatgpt.com 上的 Codex config reference 与 permissions 文档。真实 workspace home 只看文件名、大小与工具缓存 JSON 的字段计数。

**未读取 / 无法核实：**
- 未读取 `~/.codex/auth.json`、`daemon-token` 或任何 sqlite 内容（按规则）。
- 未在真实 `codex exec` 回合中验证 DC-1 配置：Room 调用在新配置下是否被批准、`command_execution` 是否消失、`codex_apps` 调用是否以带 `server` 字段的 `mcp_tool_call` 出现、`multi_agent=false` 后 `spawn_agent` 是否真正移除、`"~/.codex"="deny"` 与 `~` 展开是否生效、`/private/tmp` 在 `:minimal` 下为何可读。
- 守卫在 `item.started` 时触发与调用实际发出的先后顺序（AR-01-1 中标为 Potential）。
- Linux 上 permission profile 的行为（`:minimal` 范围、bwrap 缺失或 user namespace 受限）。
- Harness2 `docs/EXPERIMENTS.md`、Headroom 对 ID 密集 Markdown 的保真度、Omnigraph 分支/合并（仅 README）、PGX 全文检索支持。
- `docker-compose.yml` 正被另一 agent 修改，卷布局引用以 `e731ccc` 为准，可能变化。
- 隔离矩阵第 6 行（异常退出清理）仅做了代码分析。
