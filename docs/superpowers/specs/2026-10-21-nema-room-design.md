# Nema Room 设计文档

- 日期：2026-10-21
- 状态：已批准（2026-10-21）
- 名字来源：根回し（nemawashi）——在做决定之前把背景和各方意见对齐。Nema Room 让 Agent 来做这件事。
- 标注说明：**【决定】** = 用户明确做出的决定；**【Claude 的决定】** = 由 Claude 推荐、用户可以否决的默认选择。

> **2026-10-24 用户决定更新：首版改为本机独立完整运行的桌面应用。** 多设备同步、备份功能和团队只读查看全部推迟到本地基本实现完成之后，再决定是否引入可选服务器。下文关于未来迁移服务端、Compose 安装和 PostgreSQL 的原始方案保留作历史记录，不再作为首版架构或验收约束。当前代码尚未完成桌面迁移。以[桌面首版范围](2026-10-24-local-desktop-first.md)为准。

---

## 1. 意图与动机

### 1.1 问题

用户是一个 senior 工程师，负责多个项目（PJ）的架构、整体进度和方向。一个项目真正的业务背景散落在各处：

- 最初的业务会议、infra 的取舍讨论
- 和 PdM 的对话、业务方发来的需求变更
- GitHub 上的 Project / PR / issue
- 大量随手记录，很多在 Apple 备忘录里

这些背景**不在任何一个人或 Agent 够得着的地方**。典型的失败场景：

> 新加入项目的同事读完相关仓库后，被分配了一个"改进 Agent 回复流程"的任务。用户的本意是让他把任务交给 coding agent：解析 codebase、读任务描述、提 PR，用户来审核。结果他只完成了"读懂代码"，没有理解真正的业务上下文——因为代码只说明系统现在是什么样，说明不了要改善什么问题、为什么当初这样设计、哪些方案被否决过、怎样才算做好。

### 1.2 先前尝试

- **Multica（自托管）**：用来管理 PJ 和同步进度，效果不好，最后用回了 GitHub Project。根本原因是 Multica 维护了一套独立的 issue 数据库，和 GitHub 只有单向、靠编号的 PR 关联，等于多维护了一个进度管理工具，两套进度记录各说各话。
- **GitHub Project**：状态可信，是进度的唯一可信来源，但不承载"为什么"。

### 1.3 Nema Room 是什么

一个按项目划分的 **AI 聊天房间**：用户可以非常随意地往里扔随手记录的文本，Agent 把它整理成准确的业务语言，沉淀成一份持续维护的项目知识。这份知识以后交给新同事和 coding agent 使用。

一句话：**项目"为什么"的唯一可信来源**——就像 GitHub 是代码和进度的唯一可信来源一样。

---

## 2. 目标、非目标、反目标

### 2.1 目标

1. **零成本输入**：用户随手把文本扔进聊天，不需要先整理格式。【决定】
2. **整理成准确的业务语言**：Agent 把输入整理成结构化的项目知识。【决定】
3. **Grill me**：Agent 像面试官一样主动追问，把最真实的需求逼问清楚，防止之后需求漂移。【决定】
4. **业务版 git history**：项目知识的每一次变化都可追溯，像一条跟着业务时间走的 git 历史。【决定】
5. **多 workspace**：每个 workspace 是一个完全不同的 PJ。【决定】
6. **跨 workspace 复用可控**：同样的问题和需求可能在别的 workspace 出现，是否允许关联由每个 workspace 的设置手动控制。【决定】
7. **为以后对接 CLI / MCP / coding agent 打好基础**。【决定】

### 2.2 非目标（第一版不做）

- 不做看板、不做进度管理、不做 issue 追踪。GitHub 继续当代码和任务状态的唯一可信来源。
  - 2026-10-23 补充：Nema 根据代码回答「实现到哪了」（需求的实现状态：已上报 / 已核实 / 有出入），不等于做进度管理；它不排期、不分配、不做看板。见 `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md`。【决定】
- 第一版不对接 coding agent（不自动派活、不提 PR）。【决定：以后再考虑】
- 第一版不读取 GitHub 数据。【Claude 的决定：第一版先把"扔进去 → 整理好"跑通；GitHub 只读接入放到后续阶段】
- 不做自动导入 Apple 备忘录。第一版靠复制粘贴。【Claude 的决定】
- 不做多人实时协作编辑、不做移动端 App。
- 不做多租户 SaaS。

### 2.3 反目标（即使"能跑"也算失败）

- **又多了一个要维护的工具**：如果用户需要手动维护 Nema Room 里的状态才能让它有用，就重蹈了 Multica 的覆辙。
- **Agent 自作主张"脑补"**：把用户没说过的内容当成已定事实写进项目知识。读不懂、有歧义、和已有决定矛盾时，必须追问，而不是猜。
- **保密项目内容泄漏**：标记为保密的 workspace 的任何内容，以任何形式（包括提示、摘要、相似推荐）出现在其他 workspace。
- **历史丢失**：知识被改写后，旧版本和改写原因找不回来。

---

## 3. 用户与使用场景

- **主要用户**：用户本人（第一版以个人使用为主）。【决定】
- **次要读者**：团队成员只读查看。【决定】
  - **能看到**：右侧整理好的项目知识，以及外部上下文来源（如 Google Drive 的 Docs / Slides 链接等）。【决定】
  - **看不到**：左侧原始聊天和随手记录。【决定】
    - 2026-10-23 补充（核实报告 Q6）：Agent 可以把来源消息的原文摘录写进知识条目，摘录随条目一起对团队可见；整段聊天仍然只有本人可见。【决定：原文可以进知识库】
  - **何时实现**：本机桌面应用的基本实现完成后再考虑；团队只读查看和服务器部署均不属于首版范围。【决定，2026-10-24，取代原先由本地开发阶段推导的安排】原始聊天与可共享知识的可见性边界仍然保留。
- **以后的读者**：coding agent（通过 CLI / MCP 读取）。

### 3.1 核心流程

1. 用户打开某个 workspace，在左侧聊天框粘贴一段随手记录（例："跟pm聊了下 agent回复太慢 客户等不及 先流式 后面再说多轮 别动tool调用那块"）。
2. Agent 被唤起，读取现有项目知识，把这段记录整理成条目，直接更新右侧项目知识，并在左侧告诉用户改了哪几处（例："已更新：需求 R-7、决策 D-12"）。
3. 有歧义或冲突时，Agent 在左侧一次问一个尖锐的问题（例："'太慢'的目标值是多少秒？"），同时把它记入右侧"待确认"。
4. 用户在左侧回答，Agent 把回答写成决策或需求，并关闭对应的待确认项。
5. 每次修改都留下可追溯的历史：哪天、因为哪段记录、改了什么。

---

## 4. 产品形态

### 4.1 布局：聊天 + 活的项目文档【决定：方案 B】

- **左侧：聊天**。用户随手输入；Agent 的回复、追问、执行过程都在这里。
- **右侧：项目知识**。Agent 持续维护，按以下分类组织：
  - **当前需求**（Requirements）
  - **已定决策**（Decisions）
  - **取舍记录**（Trade-offs）
  - **待确认**（Open questions）
  - **外部来源**（External sources）：Google Drive Docs / Slides 等外部资料的链接。【决定】每条包含 URL、一句话说明它是什么、和哪些需求/决策相关。用户在输入中贴出链接时，Agent 自动登记。第一版只记录链接与说明，不抓取链接内容。【Claude 的决定】外部文档会过时，所以每条外部来源同样带进库时间和最后确认时间（见 4.4 的时效性）。【决定，2026-10-23，核实报告 Q6】
- 右侧每一条都能点回它来源的原始记录（左侧的某条消息）。
- 新同事和 coding agent 读右侧就能拿到业务背景，不需要翻聊天历史。

### 4.2 Agent 直接改，不逐条审核【决定：选 B 而非"收件箱 + 审核"】

- Agent 直接更新右侧，并在左侧告知改了什么。用户看到不对可以纠正（在聊天里说，或直接编辑条目）。
- 准确性靠 grill（追问）和"不确定就进待确认"来保证，而不是靠逐条审批。
- **改动已定决策要有依据**【决定，2026-10-23，核实报告 Q4】：Agent 要作废或改写一条 active 的决策时，必须在这次改动的来源里给出依据（用户的哪条消息）。没有依据时，Room API 拒绝这次改动（409），并要求 Agent 改为新建一条待确认，问用户是否要改。这符合"Agent 直接改"：有依据的改动照常直接生效，只拦下无依据的替换。

### 4.3 Grill me 行为【决定】

- 用户扔进记录后，Agent 不只是整理，还会主动追问，目的是明确最真实的需求、防止漂移。
- **一次只问一个问题**。【Claude 的决定】
- 新的输入与已有需求/决策冲突时，先追问，再决定是否修改。【Claude 的决定】
- 读不懂或有歧义的内容，不猜，放进"待确认"。【Claude 的决定】
- 用户的回答会作为决策/需求写进右侧，并引用这次问答作为来源。
- **区分说过的、定下的和推断的**【决定，2026-10-23，核实报告 Q5】：每条内容标明依据，取值三种：`stated`（用户说过）、`decided`（用户明确拍板）、`inferred`（Agent 推断）。用户没说过的内容，要么进待确认，要么标 `inferred`，不能当作 `stated` / `decided` 写入。界面上 `inferred` 的条目带「推断」标记，用户确认后改为 `stated` 或 `decided`。【标记的具体样式为 Claude 的决定，留给实现时按 4.6 的风格定】

### 4.4 业务版 git history【决定】

- 项目知识的每次修改 = 一次 commit，带来源（哪段记录）和理由。
- 能看某一条的修改历史、两个版本之间的 diff，能对某一条做 "blame"（这条为什么长这样）。
- 每条记录区分两种时间：**业务日期**（这件事在业务上发生的时间，比如会议日期）和**记录时间**（写进系统的时间）。【Claude 的决定】
- **时效性**【决定，2026-10-23，核实报告 Q6】：原文摘录和外部来源都会过时。每条带两个时间：**进库时间**（第一次写进知识库）和**最后确认时间**（用户或 Agent 最后一次确认它仍然有效）。界面显示这两个时间；超过一定时长没有确认的，标「可能过时」。【阈值为 Claude 的决定：外部来源 90 天，其余条目不自动标记；以后可在 workspace 设置里调整】
- 排序：git 历史按**记录时间**排序（如实反映知识何时被改）；另提供一个按**业务日期**排序的时间线视图，由 PostgreSQL 中对 frontmatter 的索引生成，不改写 git 提交时间。【Claude 的决定】

### 4.5 会话与任务语义【Claude 的决定】

- 每条用户输入（包括对追问的回答）触发一次**无状态**的 Agent 运行：每次都从项目知识 + 最近的聊天记录 + 当前待确认项重新组装上下文，不依赖各家 Agent 的会话续接能力。
- 同一个 workspace 的任务**串行**处理，按输入顺序；不同 workspace 之间可以并行。
- 电脑离线期间积压的多条输入，上线后按顺序逐条处理；产生的追问全部进入"待确认"，但左侧聊天里一次只主动问优先级最高的一个。
- **被中断的任务**【决定，2026-10-23，核实报告 Q2】：hub 重启或 daemon 断线导致正在运行的任务中断时，hub 重新连上后自动重试，最多 3 次；3 次重试都失败后，任务标为失败，聊天里提示用户重新发送。只有中断才重试；任务本身正常结束但失败（登录失效、超限等）的，照旧直接标失败，不重试。【Claude 的决定：重试时在 prompt 里列出这个任务之前已经写入的条目，避免重复写入】
- **崩溃后未提交的写入**【决定，2026-10-23，核实报告 Q3】：hub 启动时，若某个 workspace 的知识仓库里有未提交的改动，保留下来，以一次 "recovered" commit 提交，commit 信息说明这是崩溃后恢复的内容，作者记为系统。

### 4.6 界面设计（2026-10-22 补充）

参考草图：`docs/design/ui-main-room.html`（主界面）、`docs/design/ui-entry-detail.html`（条目详情）。草图是方向参考，不是像素级规范。

**整体风格**
- **Slack 风格的三栏布局**：左侧 workspace 列表、中间聊天、右侧项目知识。【决定】
- **简约 + 瑞士风格字体**。【决定】具体做法【Claude 的决定】：
  - 字体：拉丁字母与数字用 Inter（Helvetica 系无衬线），中文用苹方（PingFang SC），日文用 Hiragino Sans（冬青黑体）；条目编号、代码用等宽字体（JetBrains Mono）。字体栈按语言区分，避免日文汉字落到中文字形上。
  - 排版：左对齐、细线分隔、无圆角无阴影；小标题用大写加宽字距。
  - 配色：只有黑、白、灰；**红色只用于"需要你处理"**（未回答的追问、待确认数量）。

**左栏：workspace 列表**
- 配色采用"纸白"：暖灰纸色背景（约 `#f3f2ee`），选中的 workspace 黑底白字。【决定：方案 B】
- 每个 workspace 显示名称；保密的 workspace 前有小方框标记；有待确认问题时显示红色数字。【Claude 的决定】
- 底部：Agent 连接状态（如「Codex 在线 · nema daemon」/「Agent 离线」）和界面语言切换（EN / 日本語 / 中文）。【Claude 的决定】

**中栏：聊天**
- 顶部：workspace 名称、「保密」标签、设置入口。
- 用户的随手记录以浅灰底 + 左侧黑线显示，与普通对话区分。【Claude 的决定】
- Agent 显示名为「Nema」，头像为 "AI" 字样。【Claude 的决定】
- Agent 回复的结构：先列出本次改动的条目（每条一个标签：编号、标题、类型 · 新增/更新/登记），再用一张左侧红线的「追问」卡片提出**一个**问题。【Claude 的决定，对应 4.3】
- Agent 处理中显示「整理中 · 正在更新 R-7、关闭 Q-4」这类进度文字。
- **输入框**：**Enter 换行，Shift+Enter 发送**。【决定】发送按钮上标注 `⇧↵`。
- **Markdown**：输入框与所有聊天消息支持 Markdown。【决定】输入框底部提供快捷按钮（粗体、斜体、行内代码、列表、链接）。【Claude 的决定】用户的原始记录按原文保存，Agent 读取的始终是原文。【Claude 的决定】

**右栏：项目知识**
- 顶部切换「分类 / 时间线」（时间线按业务日期，见 4.4）。
- 分组顺序：**待确认**（置顶，按优先级）→ 当前需求 → 已定决策 → 取舍记录 → 外部来源。【Claude 的决定：待确认置顶，因为它是需要用户处理的】
- 每条显示：编号（等宽字体）、标题、一行元信息（业务日期 / 关联 / 来源类型）；本次新增的条目带黑色「新」标记；已失效（superseded / dropped / resolved）的条目折叠为「已失效 N 条」。
- 外部来源显示为可点击链接，在新标签页打开。

**条目详情**
- 点击右栏条目，右栏向左展开为约 560px 宽的详情面板，不弹窗，左侧聊天始终可见；✕ 关闭回到列表。【Claude 的决定】
- 顶部：面包屑、编号、状态、标题；标签页「内容 / 历史 N / 为什么」，右侧「编辑」。
- **内容**：业务日期、最后修改（时间 · 作者）、关联条目（已解决的显示删除线）、Markdown 正文、「来源」列表——点击来源，左侧聊天滚动到对应原始消息。
- **历史**：版本从新到旧（v3 / v2 / v1），每个版本显示时间、作者（Agent 描边标签 / 用户黑底标签）、修改理由、来源；选中某个版本，下方显示与当前版本的行级差异（删除：灰色删除线 + 红色「−」；新增：浅灰底 + 黑色「+」）。
- **为什么**：按**段落**标注每段最后一次被修改的版本、作者和理由（不逐行标注，逐行对业务文字太碎）；点击理由跳到对应历史版本与原始消息。【Claude 的决定】
- **编辑**：用户可直接编辑条目，**必须填写修改理由**才能保存。【Claude 的决定，对应 4.2】

**多语言（i18n）**【决定：支持日、英、中】
- 界面语言首次跟随浏览器语言，之后在左栏底部切换并记住。缺少翻译的文案回退为英文。【Claude 的决定】
- 日期时间格式随界面语言（如「10月21日 周二」/「10月21日(火)」/「Tue, Oct 21」）。【Claude 的决定】
- Agent 在聊天中的回复语言跟随该条用户输入的语言。【Claude 的决定】
- **知识语言**：每个 workspace 的设置中有「知识语言」选项：日本語 / English / 中文 / 跟随输入。【决定】选定某种语言后，无论用户用什么语言输入，右侧条目一律用该语言撰写；新建 workspace 默认「跟随输入」。【Claude 的决定：默认值】

**不在第一版范围**
- 窄屏 / 移动端布局（第一版按桌面浏览器设计）。【Claude 的决定】

---

## 5. 多 workspace 与跨 workspace 复用

### 5.1 workspace

- 每个 workspace 对应一个完全不同的 PJ，拥有独立的聊天、项目知识和历史。【决定】
- workspace 设置项：名称、保密开关（5.2）、知识语言（4.6）。

### 5.2 保密开关【决定：在 workspace 设置里手动勾选】

- **保密**：该 workspace 的内容不出去——不出现在任何跨 workspace 的提示、检索、摘要中，也不能被 cherry-pick 到别处。别的 workspace 的内容也不会提示进来。
- **不保密**：可以参与相似问题/需求的提示。
- **新建 workspace 默认为保密**。【Claude 的决定：宁可少一次提示，也不冒泄漏风险】

### 5.3 跨 workspace 提示与复用【Claude 的决定，用户未否决；分阶段：第一版只做保密开关和完全隔离，提示与 cherry-pick 放到第 8 节的后续阶段】

- 默认完全隔离。
- 当两个都"不保密"的 workspace 中出现相似的问题/需求时，Agent **只提示**（例："PJ-B 的 D-5 也处理过类似问题"），不自动复制。
- 提示只对同时有两个 workspace 访问权限的人可见。
- 真要复用时，由用户显式 **cherry-pick**：带上出处，在目标 workspace 中作为一条新记录，之后各自演进。

### 5.4 个人层【Claude 的建议，未确认】

- 建议用户另有一层"个人层"，存放跨 PJ 的经验和偏好，团队不可见。第一版可不实现，留作后续。

---

## 6. 架构与运行方式

> 本节记录迁移前的 Web / hub / daemon 架构。2026-10-24 起，桌面应用必须在本机拥有完整界面、持久化存储、任务调度和 Agent 执行能力；不得以远端 hub 或单独运行的 daemon 作为桌面基本功能的前提。Room 校验、知识 Git 历史、凭证保护和适配器规则继续适用，具体进程布局与存储引擎另行验证。

### 6.1 Agent 运行方式：订阅，外加本机 BYOK【决定；2026-10-23 修订】

- 默认仍是用户自己的订阅（Claude Code、Codex 等），与 Multica / Kylon 的「自带 Agent」一致。
- **BYOK 是后加的、必须显式打开的一种登录**【决定，2026-10-23】：用户把 API key 交给本机 daemon，daemon 用现有的进程内工具循环调用兼容 Responses 的接口。hub 不保存、不转发这把 key。费用按 API 用量计，不占用订阅额度。细节见 `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md` 的 BYOK 一节。
- **用户已接受**：用户的电脑关机/休眠时，Agent 不工作。【决定】开发阶段服务端也在本地，所以电脑关机时整个 Nema Room 都不可用；部署到常开的服务器后，记录才能在电脑离线时写入、等电脑在线后再整理。

### 6.2 组件

```
┌────────────────────── 服务端（自托管）──────────────────────┐
│  Web UI（左聊天 / 右项目知识 / workspace 设置）            │
│  API + 实时推送                                             │
│  任务队列（一条输入 → 一个"整理任务"）                      │
│  Room MCP Server（Agent 读写项目知识的唯一入口）            │
│  存储：每个 workspace 一个 git 仓库 + PostgreSQL            │
└─────────────────────────────▲──────────────────────────────┘
                              │ WebSocket（领取任务、回传过程）
┌─────────────── 用户电脑：nema CLI（常驻 daemon）─────────────┐
│  领取任务 → 启动用户选择的 Agent（Claude Code / Codex /     │
│  Cursor / 其他 ACP Agent），注入 Room MCP → 流式回传结果    │
└──────────────────────────────────────────────────────────────┘
```

- **服务端不调用模型**，只负责协调和存储。【决定，由运行方式推出】
- **Room API 是 Agent 读写知识的唯一入口**（2026-10-23 修订：原文为"Room MCP"）。保密开关、来源记录、"每次改动 = 一次 commit"等规则在 hub 的 Room API 里强制执行，不依赖 Agent 自觉。调用 CLI 的适配器通过 Room MCP（`nema mcp`，转发到 Room API）访问；直连适配器（6.7）在 daemon 内以函数调用方式访问同一个 Room API。两条路径共用同一套 run token 鉴权与校验。【Claude 的决定】
- **Agent 接入顺序**：第一版只接 **Codex**；之后依次接 **Claude Code**、**Cursor**。daemon 内部按统一的适配器接口设计，新增 Agent 只需加一个适配器。【决定：顺序；Claude 的决定：适配器接口】
- **代码库与插件（2026-10-23）**【决定】：workspace 可绑定多个代码仓库；插件（graphify、archify、nema report、GitHub 只读）全部挂在 Room 后面，Agent 仍只走 Room。见 `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md`。
- **Claude Code 与 BYOK（2026-10-23）**【决定】：见 `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md`。Claude Code 增加适配器 `claude-code`（官方 `claude`，工具只剩 Room MCP，登录用 setup token）。BYOK 不增加适配器，而是 `codex-direct` 的 `authMode=byok`。不接 Cursor，不恢复 Codex CLI。调查依据是 Hermes 与 Multica 的 runtime 接法（`docs/reviews/2026-10-23-agent-runtime-research.md`）。
- **Codex 不启动 Codex CLI（2026-10-23，取代原 CLI 方案）**【决定】：本项目的 Codex 不再执行 `codex` 进程，也不再为 Codex 生成隔离的 `CODEX_HOME` 或通过 `nema mcp` 把工具交给 CLI。取代方式是 daemon 内的工具循环，只读用户已经 `codex login` 写好的 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），向 `https://chatgpt.com/backend-api/codex/responses` 发请求。模型只拿得到 Room 的 3 个函数。详见 6.7。6.6 的进程隔离只留给以后的 Claude Code / Cursor，不再用于 Codex。
- **一个 CLI：`nema`**。同时承担 daemon（领取任务、启动 Agent）和以后的命令（如 `nema add "memo…"`、给 coding agent 拉上下文）。【决定：CLI 名为 nema】

### 6.3 存储：项目知识存成 git 仓库【Claude 的决定】

- 每个 workspace 一个 git 仓库，目录如 `requirements/`、`decisions/`、`tradeoffs/`、`questions/`。
- 每一条 = 一个 Markdown 文件 + frontmatter（id、状态、来源、业务日期等）。2026-10-23 追加字段：依据（`stated` / `decided` / `inferred`，4.3）、进库时间、最后确认时间（4.4）。来源可以带原文摘录（第 3 节）。
- 不另做备份命令【决定，2026-10-23，核实报告 Q6】：知识是 git 仓库，PostgreSQL 存聊天和设置；备份由用户自行处理。
- Agent 每次修改 = 一个 commit，commit 信息包含来源与理由 → diff / blame / history 直接由 git 提供。
- 好处：业务 git history 不需要另外实现；coding agent 以后可以直接读取；数据是普通文件，不被工具锁定。
- PostgreSQL 存聊天记录、workspace 设置、任务队列状态等。

### 6.4 技术栈【Claude 的决定，用户表示"看看是否符合期望"，未否决】

- **语言**：TypeScript（Web、服务端、CLI、MCP 共用一套代码）。
- **Web**：Next.js；实时推送用 SSE 或 WebSocket。
- **数据库**：PostgreSQL。
- **相似检索**：第一版用 PostgreSQL 全文检索 + Agent 判断（没有托管 embedding 服务可用）。
- **部署**：Docker Compose 自托管（应用 + PostgreSQL + git 数据卷）。
- **认证**：第一版单人使用；团队查看时加 GitHub 或 Google 登录。

### 6.5 开发阶段部署【决定：开发阶段先放本地】

- 服务端和 `nema` daemon 都跑在用户的笔记本上，服务端只监听 localhost。
- 即使在同一台机器上，也保留"服务端 ↔ daemon 通过 WebSocket 通信"的拆分，以便以后把服务端搬到常开的服务器时不需要重新设计。【Claude 的决定】
- 本地阶段不需要 HTTPS、团队登录和对外暴露；这些随部署到服务器一起做。

### 6.6 本机 Agent 隔离【决定：隔离本机 Agent；以下方案为 Claude 的决定，参考 Multica、Hermes Agent、Kylon 的做法】

> 2026-10-23 决定：本节**不再适用于 Codex**。启动 Codex CLI、软链接 `auth.json`、注入 Room MCP 的做法已废除，由 6.7 的直连取代。下面的分层做法只作为以后接入 Claude Code / Cursor 时的参考，当前 daemon 不会执行。2026-10-22 架构核实报告（`docs/reviews/2026-10-22-architecture-integration-review-report.md`）已说明第 7、8 项在 Codex 0.163 上不成立，这也是放弃用 CLI 跑 Codex 的原因之一。

**目标**：一个 workspace 的运行，只能通过 Room MCP 读写**这个 workspace** 的项目知识；不能通过 Agent 自身的记忆、会话历史、全局指令、其他 MCP server 或文件访问接触到其他 workspace。

**分层做法（第一版）：**

1. **每个 workspace 一个独立的 Agent 配置目录**（权限 0700），例如 `~/.nema/ws/<id>/codex-home/`。配置文件由 `nema` **从零生成**，绝不复制用户自己的 `config.toml`、全局 `AGENTS.md`、`CLAUDE.md` 等。
2. **订阅登录复用**：
   - Codex：把每个 workspace 配置目录里的 `auth.json` 软链接到用户的 `~/.codex/auth.json`（Multica 的做法）。因为刷新令牌只能用一次，多份拷贝会互相失效，所以只链接、不复制。若用户的 Codex 凭证存在系统钥匙串里（没有 `auth.json`），`nema` 拒绝启动并提示用户切换为文件存储。
   - 为避免令牌刷新的竞争，**所有 Codex 运行全局串行**（第一版本来就是单人使用，影响很小）。
3. **只注入 Room MCP**：生成的配置里只有一个 MCP server（Room），不加载用户的任何其他 MCP server。
4. **关闭会跨运行留存的功能**：记忆（Codex `features.memories=false`）、历史记录（`history.persistence="none"`）、会话落盘（`codex exec --ephemeral`）、网页搜索、遥测和更新检查。
5. **临时工作目录**：每次运行在一个全新的临时目录中进行，位于任何 git 仓库和其他 workspace 之外（防止 Agent 自动读到上层目录的 `AGENTS.md`），运行结束后删除。
6. **环境变量白名单**：从空环境开始，只传入 PATH、语言/终端设置、本次运行的 TMPDIR、指向 workspace 配置目录的 HOME 和工具专用变量，以及 Room 的访问令牌；不传入任何其他密钥。
7. **最小工具面**：Agent 的工作只需要 Room MCP。能关的文件/命令工具尽量关；Codex 使用最严格的可行沙箱。
8. **每次运行前自检**：从 Agent 启动时输出的初始化事件中确认"只加载了 Room 一个 MCP server、没有加载任何指令文件"，不符合就中止运行并报错。

**各 Agent 的对应（供实现参考）：**

- Codex（第一版）：`CODEX_HOME=<workspace 配置目录> codex exec --json --ephemeral --skip-git-repo-check -C <临时目录>`；长时运行可考虑 `codex app-server`（Multica 采用）。
- Claude Code（之后）：`CLAUDE_CONFIG_DIR` 指向 workspace 配置目录、关闭自动记忆、`--strict-mcp-config --mcp-config <room>`、不落盘会话、只允许 Room 工具。注意：自定义配置目录下订阅登录需要每个目录登录一次，或由用户运行一次 `claude setup-token` 生成长期令牌交给 `nema` 保管。
- Cursor（之后）：独立的配置/数据目录 + 项目级 MCP 配置；不使用"自动批准所有 MCP"之类的选项（会连带批准用户的全局 MCP）。

**第一版无法彻底堵住、明确接受的残余风险：**

- **同一个系统用户**：Agent 以用户本人的系统账号运行，理论上仍能通过命令读取其他 workspace 的数据目录和用户的其他文件。彻底隔离需要每个 workspace 一个独立系统用户、容器或虚拟机。**第一版不做，列入后续加固**（见第 8 节）。
- **服务商侧共享**：所有 workspace 共用同一个 OpenAI / Anthropic / Cursor 账号，服务商那边的记忆、云端历史和数据保留策略无法由 `nema` 控制。建议用户在账号设置中关闭云端记忆类功能。
- **共享登录**：所有 workspace 共用一份登录凭证，其中一次运行导致登出会影响全部 workspace。

### 6.7 Codex 直连适配器（2026-10-23 新增）【决定：参考 Hermes 默认方案；以下细节为 Claude 的决定，除非另行标注】

参考资料：Hermes Agent 的 `openai-codex` provider（不安装 Codex CLI，自己跑工具循环，用 ChatGPT 订阅 OAuth 调用 Responses API）；调研笔记见 `docs/reviews/2026-10-23-codex-direct-research.md`。

**为什么改**：Codex CLI 自带 shell、文件读取、插件 / connectors 等工具，新版本还会默认开启新功能（核实报告 AR-01-1/2）。直连后模型可用的工具完全由 Nema 决定，隔离从"关掉一堆开关"变成"本来就没有"。

**1. 运行位置**
- 工具循环运行在本机的 `nema` daemon 里；hub 仍然不调用模型、不接触用户凭证（6.2【决定】不变）。
- 任务流程不变：hub 派发任务（prompt + run token）→ daemon 运行工具循环 → 通过 Room API 写知识 → 回传最终回复。

**2. 登录与凭证**
- 新命令 `nema auth login`：Nema 自己完成 OAuth 登录，凭证存 `~/.nema/auth.json`（权限 0600，原子写入，配套文件锁）。`nema auth status` / `nema auth logout` 同理。
- **SIWC 不与 Codex CLI 共用凭证**：刷新令牌只能用一次，两个程序共用同一条令牌链会互相作废；因此 SIWC 单独登录，不导入、不链接 `~/.codex/auth.json`。`authMode=compat` 是例外：它只读该文件、不刷新（见第 3、6 项），用来取代启动 Codex CLI。
- 刷新：在访问令牌过期前约 2 分钟刷新；刷新必须在文件锁内进行——加锁后重新读取，若别的进程已刷新则直接采用；新令牌写盘成功后才释放锁。
- 刷新遇到不可恢复的错误（如 `invalid_grant`、令牌被重用、401/403）：清掉本地令牌并记录错误，当前任务失败，聊天里提示「需要重新登录：在终端运行 nema auth login」，不反复重试。
- `nema doctor` 增加一项：直连登录状态（已登录 / 过期需重登 / 未登录），不输出任何令牌内容。

**3. 认证与模型接口：三种模式【决定：先官方模式，见第 8 项；BYOK 为 2026-10-23 追加】**
- **官方模式（SIWC，Sign in with ChatGPT 令牌共享）**：OpenAI 为第三方应用提供的正式途径。首次登录动态注册得到 Nema 自己的 client id，使用 plan-usage scopes，浏览器 PKCE 回调到 `http://127.0.0.1:<port>/auth/callback`，推理走公开接口 `https://api.openai.com/v1/responses`。官方文档目前写明处于有限试用阶段（对开源伙伴开放 plan usage），个人自用能否开通需实测；刷新接口细节尚未在公开文档中找到。
  - 2026-10-23 事实更正（不改上述决定）：刷新接口已在官方文档 `https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#refreshing-tokens` 中确认，并已用 `nema auth probe --force-refresh` 实测通过；id_token 不做 JWKS 验签是有意的（令牌直接经 TLS 从令牌端点获得，按 OIDC Core 3.1.3.7 可不验签，仍校验 iss / aud / exp / nonce / sub）。
- **兼容模式（Hermes 的「导入已有 Codex 登录」）**：不另做设备码登录，只读 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）里尚未过期的 `access_token` / `refresh_token`（Hermes `_import_codex_cli_tokens`），推理走 `https://chatgpt.com/backend-api/codex/responses`。Nema 不刷新、不改写该文件，以免轮换掉 Codex 自己的刷新令牌。这是非公开接口，OpenAI 的 SIWC 文档明确要求第三方不要使用 `backend-api`，存在服务条款与随时失效的风险。
- **BYOK（2026-10-23）**【决定】：同一条进程内工具循环，用用户交给 daemon 的 API key 调用 Responses 接口。不启动 CLI，不读环境变量里的 key。文件、地址和 401 行为见 `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md` 的 BYOK 一节。
- 三种模式放在同一个「认证 + 传输」接口后面，工具循环与之无关；按用户选择切换。
- 无论哪种模式，请求都如实标识为 Nema（`originator` / `User-Agent` 使用 `nema-room` / `NemaRoom/<版本>`），**不冒充 Codex CLI**。

**4. 工具循环**
- 系统指令：hub 下发的 prompt（4.3/4.5 的规则、知识语言、条目索引、上下文）原样作为本次运行的指令与输入；每次运行无状态（4.5 不变）。
- 工具：只向模型声明 3 个函数——`list_entries`、`read_entry`、`upsert_entry`，参数 schema 与 Room MCP 一致；daemon 收到函数调用后带 run token 调用 hub 的 Room API，把结果（含错误文本）作为函数输出回给模型。**不声明任何其他工具**；模型若请求未知函数，返回错误输出并计入异常次数。
- 对话方式：不依赖服务端保存会话（`store: false`），每轮把完整的输入项（含历史函数调用与输出，按 `call_id` 配对）重新发送；流式接收事件，以每个输出项完成事件为准组装结果。
- 上限：每次运行最多 24 轮模型调用、60 次工具调用、总时长 10 分钟（与现有超时一致）；超限即失败并在聊天里给出原因。输出不完整时最多续写 3 次。
- 错误处理：网络 / 5xx 错误重试 1 次；401 在 SIWC 与 compat 下强制刷新令牌后重试 1 次；`authMode=byok` 的 401 不刷新、不重试（没有刷新令牌）。额度用尽（429 / 用量受限）时任务失败，聊天提示额度重置时间（若接口提供）；其余错误直接失败并显示简要原因。
- 回复：模型最后的文本即任务回复（4.3 规则不变：回复不提问，追问由 hub 选出）；中间的文本以进度事件流式回传到「整理中」。
- 模型与推理强度：daemon 配置项（如 `nema config set model <名称>`），默认取账号可用模型列表中的推荐项；第一版全局一个设置，不按 workspace 区分。
- 全局串行保持不变（4.5、6.6），以简化令牌刷新与额度管理。

**5. 隔离（直连适配器）**
- 不启动外部进程，没有 shell、文件系统、插件、connectors、网页搜索；模型能做的只有调用 3 个 Room 函数，而 Room API 只认本次任务的 run token、只对应本 workspace（6.2）。
- 本机不为每次运行保存任何状态。持久化的凭证是 `~/.nema/auth.json`（SIWC）；BYOK 另有 `~/.nema/byok-key`（见 runtime spec）。compat 不在这里保存 Codex 的令牌。
- 不再需要 6.6 中为 CLI 准备的独立配置目录、环境变量白名单、临时目录和自检；6.6 只适用于调用 CLI 的适配器。
- 仍然存在的残余风险：服务商侧（OpenAI 账号的记忆、数据保留）不受 Nema 控制；所有 workspace 共用同一个 OpenAI 账号与额度；提示注入只能在本 workspace 内滥用 Room 工具（受 Room API 的校验约束）。

**6. 适配器选择（2026-10-23：CLI 方案废除）**【决定】
- 唯一的 Codex 适配器是 `codex-direct`。daemon 不再注册、不再启动 `codex-cli`。`nema config set adapter codex-cli` 直接拒绝。
- 旧配置或在途任务里的 `adapter` 为 `codex` 或 `codex-cli` 时，一律改由 `codex-direct` 执行，并使用下面的 Codex 登录文件（`authMode=compat`），不启动 CLI。
- hub 仍下发 `adapter: "auto"`，由 daemon 按本机配置执行。当前 daemon 的 hello 只上报 `codex-direct`。
- 登录失效或接口不可用时任务失败并说明原因，没有第二条 Codex 路径可以退回。
- **用哪份登录**：`authMode=compat`（读取已有的 Codex 登录文件，见第 3 项）是对「以前启动 Codex CLI、复用它的登录」的取代。`authMode=siwc` 仍是可选的官方登录，默认仍是 `siwc`；从 `codex-cli` 迁过来的配置改为 `compat`，因为 CLI 用的就是那份文件。

**7. 测试与验证**
- 单元测试使用本地假的 Responses 流式服务和假的 OAuth 服务（覆盖：正常工具循环、函数调用配对、未知函数、超限、续写、401 刷新、刷新失败作废、429 额度、并发刷新加锁）。
- 真实冒烟：用户本人完成一次 `nema auth login`，再用真实订阅跑通"发记录 → 整理 → 追问 → 回答"一轮。

**8. 认证模式的决定（2026-10-23）**【决定】
- 官方模式（SIWC）已实现，并仍是未写过配置时的默认（`authMode=siwc`）。
- **Codex CLI 的取代是兼容模式，不是再包一层 CLI**【决定，2026-10-23】：要沿用已经 `codex login` 的账号，用 `nema config set authMode compat`。daemon 只读 `~/.codex/auth.json` 的 access token 调 `chatgpt.com/backend-api/codex`，不刷新、不改写该文件，不启动 `codex`。用户接受该接口可能违反服务条款或随时失效。
- 三种模式共用同一个工具循环；切换是本机配置项 `authMode`。未写过配置时的默认仍是 `siwc`。`byok` 不会被迁移或自动选中。BYOK 已写入设计、代码里还没有。

---

## 7. 约束

- 首版本机独立运行，用户无需部署服务器、Docker 或独立数据库服务。【决定，2026-10-24】自托管服务器只可能用于后续可选功能，不是首版安装条件。
- hub 只跑单个进程、单个副本【决定，2026-10-23，核实报告 Q7】。仓库锁和任务队列都按单进程设计，不考虑多副本。
- Agent 依赖用户本机在线。
- 使用订阅额度做无界面自动化：个人使用一般没问题；若以后让团队共用一个人的订阅，需要先确认各家服务条款（尚未逐条核实）。BYOK 用的是用户自己的 API 额度，key 只在本机 daemon（6.1）。
- Codex 直连（6.7）：官方模式依赖 OpenAI 的 SIWC 试用资格；取代 CLI 的兼容模式依赖非公开接口，可能违反服务条款或随时失效。README 中如实说明。
- 保密 workspace 的隔离是硬约束（见反目标）。Codex 的做法是 6.7：不启动 CLI，模型只有本 workspace 的 Room 函数。6.6 的进程隔离不再用于 Codex。

---

## 8. 后续阶段（不在第一版范围内）

**2026-10-24 顺序约束【决定】**：先完成并验收本机桌面基本能力，再考虑多设备同步、备份功能、团队只读查看及其可选服务器。当前不实现同步协议、远端账户、冲突合并或服务器自动切换；后续是否实现及其顺序仍待决定。

1. `nema add "memo…"` 等 CLI 命令；iOS 快捷指令从 Apple 备忘录一键转发。
2. GitHub 只读接入：把 Project / PR / issue 的事件作为输入，并把项目知识条目和 issue/PR 关联。
3. MCP / CLI 给 coding agent 提供"任务上下文包"：分配任务时，自动打包相关的需求、决策、取舍、验收标准和代码位置。
4. 团队成员的权限和共享方式细化。
5. 个人层。
6. 跨 workspace 相似提示与 cherry-pick（见 5.3）。
7. 隔离加固：现在先把骨架建起来（Codex 直连只有 Room 函数；Claude Code 去掉内置工具，只剩 Room MCP）。以后要更强的隔离时，优先考虑把 Agent 放进 VM 运行。【决定，2026-10-23，核实报告 Q11】
8. 接入 Cursor（见 6.2）。Claude Code 的设计已单独写出，见 `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md`。
9. 提高整理精度阶段：再决定要不要为 Grill 离线评测单独花 API 额度（BYOK 已可用）。【决定，2026-10-23，核实报告 Q9：后续再说】

---

## 9. 留给实现者决定的部分

- 具体的 Web 框架细节、UI 组件库；4.6 未规定的样式细节（间距、字号等）。
- daemon 与服务端之间的具体协议格式（在 WebSocket 之上）。
- Cursor CLI 与 ACP 的具体启动参数。Claude Code 的启动参数与工具面证明已在 `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md` 定下。Codex 不再使用 CLI（6.7）。
- Codex 直连适配器（6.7）的内部结构、OAuth 与流式解析的实现细节、文件锁的具体实现，在不违背 6.7 的前提下由实现者决定。
- git 仓库的具体实现方式（git CLI 或库）与 commit 信息格式。
- 条目 id 规则、frontmatter 的具体字段。
- 任务队列实现（PostgreSQL 队列或其他）。
- 测试策略与代码结构。
