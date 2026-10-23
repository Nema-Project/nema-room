# 代码库与插件

日期：2026-10-23。上游设计：`docs/superpowers/specs/2026-10-21-nema-room-design.md`（以下称主 spec）、`docs/superpowers/specs/2026-10-23-agent-runtimes-design.md`（以下称 runtime spec）。参考：核实报告 OS-06（graphify）、Stably AI 的 Orca（agent 钩子做法）。

标注：【决定】是用户在 2026-10-23 的讨论中定下的；【Claude 的决定】是 Claude 的判断，用户可以推翻。

## 意图

Nema 总结的纸面知识和代码仓库会分开。有些问题不看仓库就答不对，例如 PdM 问「某个实现做到哪了」。用户把需求交给 coding agent 之后，最怕的情况是 coding agent 说「做完了」，Nema 还说「没做完」，用户不知道该信谁。

Nema 的角色是 copilot：管「为什么」和「要做什么」，自己不写代码、不动仓库。用户要能直接相信它关于实现进度的回答，所以这些回答必须以代码为准、给出依据；证据不够时明确说「无法确认」。【决定】

要做到这一点，Nema 需要读得到代码库，需要知道 coding agent 做了什么，还需要接外部工具（GitHub 等）。接外部工具迟早需要管理功能，所以插件框架和代码库功能一起做。【决定】

## 阶段

1. **本阶段：读代码库 + 插件框架。**【决定】
2. 下一阶段：Nema 从知识库写 spec 和 plan（superpowers 方法），交给 coding agent 实现；再用本阶段的上报与核实闭环核对 plan 是否完成。superpowers、grill-me 的开关与编辑放在这一阶段。【决定】
3. 以后：其余外部插件、写入型工具等。

## 目标

- 一个 workspace 可以绑定多个本地代码仓库。【决定：1 对 n】
- Nema 回答「做到哪了」时以代码为准，给出依据（仓库、提交、文件）；证据不够时说「无法确认」。
- 每条需求有实现状态，分三级：已上报 → 已核实 → 有出入。【决定】「做完了」等于已核实。
- coding agent 完成工作后自动向 Nema 上报；没有上报时，Nema 自己去看代码。【决定】
- 导入仓库时自动画出架构图，作为项目知识的一部分；代码变化后能看出图过时并增量更新。【决定】
- 插件统一管理：全局安装一次，每个 workspace 决定开哪些。【决定】
- 第一版插件：graphify（读代码）、archify（画图）、nema report（上报）三个自带，加 GitHub（只读）一个外部插件，用来验证框架。【决定】

## 非目标（本阶段不做）

- Google Drive 和其他外部插件。Drive 是本阶段之后的第一个插件（它能读到文档最后修改时间，把主 spec 4.4 的「可能过时」从按天数判断改为按实际修改判断）。【决定】
- 任何写入外部的工具（建 issue、合并 PR、写 Drive 等）。【决定：第一版只读】
- 写 spec / plan、superpowers、grill-me 的开关与编辑（下一阶段）。【决定】
- 用户自己安装任意 MCP 服务器。框架按能支持它来设计，但第一版只提供上面四个预置插件。【Claude 的决定：范围定为「三个自带 + GitHub」，自定义 MCP 安装界面不在其中】
- 自动重画图。【决定：由用户触发】
- Nema 运行或修改用户仓库里的代码。

## 反目标（即使「能跑」也算失败）

- Agent 因为插件拿到了文件系统、shell 或网络。插件必须挂在 Room 后面（见决定 2）。
- 插件往用户仓库里写东西：`CLAUDE.md`、`AGENTS.md`、`.claude/skills/`、git hooks、`graphify-out/` 等。
- 插件的缓存、日志或索引把不同 workspace 串在一起（例如 graphify 的全局查询日志 `~/.cache/graphify-queries.log`）。
- Nema 只凭 coding agent 的一句话就说「做完了」。
- 钩子把 coding agent 的对话内容、工具调用细节、或未绑定仓库里的工作发进 Nema。
- 保密 workspace 的内容经由「会外发」的插件被发出去，而用户没有在这个 workspace 里手动打开它。

## 已有决定（沿用）

- Room API 是 Agent 读写知识的唯一入口（主 spec 6.2）。本设计把它扩展为「Agent 接触任何外部能力的唯一入口」。
- hub 不调用模型、不接触凭证（主 spec 6.2、runtime spec）。插件的凭证只在本机 daemon。
- 每次运行无状态，同一 workspace 串行（主 spec 4.5）。
- 条目的依据 `stated / decided / inferred`、进库时间、最后确认时间（主 spec 4.3、4.4，实现计划 `docs/superpowers/plans/2026-10-23-review-decisions.md`）。本设计依赖这套字段。
- hub 运行在容器里，看不到宿主机文件；daemon 在宿主机上（主 spec 6.5、Compose 运行方式）。

## 这次的决定

### 1. 代码仓库绑定

- workspace 设置里可以绑定多个仓库。每个仓库记录：本地路径（daemon 所在机器上的路径）、用途说明（如「后端」）、主分支。主分支默认取仓库的默认分支（`origin/HEAD` 指向的分支，取不到则 `main`），可以改。【决定：1 对 n；Claude 的决定：字段】
- **主分支以远端为准**【决定】：比较、核实、读代码、建图都用 `origin/<主分支>`，不用本地分支，这样在 GitHub 上合并而本地没有 pull 的工作也算数。daemon 每 5 分钟（以及收到钩子信号时）执行 `git fetch --no-tags origin <主分支>`，使用用户已有的 git 凭证。这只更新远端跟踪引用和 `.git` 里的对象，不动工作区、不动本地分支、不改 `git status` 的结果。仓库没有 `origin` 时退回本地主分支，并在设置页提示。fetch 失败（离线、凭证失效）不报错打断，只在设置页显示最后一次成功的时间。
- 绑定数据存在 hub 的数据库里。所有读仓库的动作都由 daemon 执行，因为只有 daemon 看得到这些路径。【Claude 的决定】
- 同一个本地路径不能同时绑定到两个 workspace。【Claude 的决定：上报按路径路由到 workspace，路径必须唯一】
- 绑定时 daemon 校验：路径存在、是 git 仓库的根目录、不在 `~/.nema` 之下。

### 2. 插件挂在 Room 后面【决定：方案 A，包括生态里现成的 MCP】

- **插件在 Agent 之外运行**，由 daemon 负责。插件开启后，Room 多出它提供的只读函数；Agent 仍然只走 Room 这一个入口。
- **插件清单**：每个插件登记 id、名称、数据流向（`local` 仅本机 / `external` 会外发）、它提供的函数（名字、说明、参数 schema、是否只读）。第一版的四个插件清单写在代码里。
- **函数命名**：`<插件 id>__<函数名>`，例如 `code__search`、`github__pull_request_read`。【Claude 的决定】
- **范围由 Room 限定**：每次调用，hub 检查这个 workspace 开了这个插件、这个函数，参数里的仓库是本 workspace 绑定的仓库（GitHub 则是绑定仓库的远端 `owner/repo`）。不满足就返回错误给 Agent，不转给 daemon。
- **执行路径**：Agent →（直连函数调用或 `nema mcp`）→ hub Room API（鉴权、范围检查、记录）→ 经 daemon WebSocket 下发给 daemon 执行 → 结果返回 hub → 返回 Agent。【Claude 的决定：插件调用必须经过 hub，才能统一记录和限定范围；daemon 执行，因为文件和凭证在本机】
- **记录**：每次插件调用在任务的工具调用记录里显示（现有 `tool_call` 事件），并在 hub 里按任务存一行（函数名、参数摘要、结果大小、耗时）。不存结果全文。
- **只读**：第一版只开放只读函数。清单里标为写入的函数不能开启。【决定】
- **数据流向与默认开关**【决定】：
  - `local` 插件默认开启，保密 workspace 也一样。
  - `external` 插件默认关闭，在 workspace 设置里逐个手动打开。
  - 将来用户自己装的 MCP 一律当作 `external`。
- **Agent 运行时的变化**（需同步修改 runtime spec）【Claude 的决定】：
  - `task.assign` 多一个字段：本次任务可用的插件函数列表（名字、说明、参数 schema）。hub 按 workspace 设置生成。
  - `codex-direct`：向模型声明的函数 = 3 个 Room 函数 + 这个列表。未知函数的处理不变。
  - `claude-code`：`nema mcp` 的 `room` 服务器按同一个列表多暴露这些函数；`--allowedTools` 和 init 工具面证明的允许集合同步扩大为 `mcp__room__` 加上这些名字。仍然只有一个 MCP 服务器 `room`，`--tools ""` 不变。
  - 工具调用上限（60 次）把插件函数计入。上限是否需要提高，留到实测后决定。
- **模型外发说明**：Agent 通过 Room 读到的代码片段会随请求发给模型服务商（OpenAI / Anthropic），和现在的知识内容一样，属于主 spec 已接受的残余风险。workspace 设置的「代码与插件」页写明这一点，不另外拦截。【决定】

### 3. 自带插件：graphify（读代码）

- 数据流向：`local`。默认开启。
- 依赖：用户本机安装 graphify（`uv tool install graphifyy`，Python 3.10+）。Nema 不自动安装。`nema doctor` 检查 `graphify` 是否在 PATH 上；不在时，绑定了仓库的 workspace 里该插件显示「未安装」，代码函数返回明确错误。【Claude 的决定】
- 运行方式，全部固定，不允许配置覆盖：
  - 只解析代码：`--code-only`，`GRAPHIFY_BACKEND=none`。不走任何模型。
  - 关闭查询日志：`GRAPHIFY_QUERY_LOG_DISABLE=1`。
  - 输出放在 `~/.nema/ws/<workspaceId>/graphify/<repoId>/`，不放在用户仓库里。
  - 不执行 `graphify install`、`graphify <platform> install`、`graphify hook install`。
  - 环境变量从空环境开始，只传 PATH、HOME、LANG 和上面这些，和 runtime spec 对 Claude 的做法一致。
  - 实现前核对 graphify 是否支持把输出目录放到仓库之外。如果做不到，停下来修改本设计，不要接受「在仓库里留下 `graphify-out/`」。
- **建图对象是主分支的快照，不是工作区**【Claude 的决定】：daemon 用 `git archive <主分支>` 把主分支导出到 `~/.nema/ws/<workspaceId>/graphify/<repoId>/src/`，graphify 解析这个快照。这样 `code__search` / `code__explain` 给出的位置与 `code__read`（也读主分支）一致，也符合「做完了以主分支为准」。不用 `git worktree`，因为它会写进用户仓库的 `.git`。主分支前进时，把改动的文件（`git diff --name-status`）同步到快照目录，再运行 `graphify update`。图的 `nodePaths` 与「可能过时」也都以主分支为准。
- 建图时机：绑定仓库时建一次；之后在收到上报、钩子信号、或主分支前进时，用增量更新（`graphify update`）。【Claude 的决定】
- 提供给 Agent 的函数（都要求参数 `repo`，取值为本 workspace 绑定仓库的 id 或用途说明）：
  - `code__search`：按自然语言或符号名查代码图，返回相关符号及其文件位置。
  - `code__explain`：解释一个符号（调用关系、所在文件）。
  - `code__path`：两个符号之间的调用路径。
  - `code__read`：读主分支上某个文件的一段（`git show <主分支>:<路径>`，按行号范围）。路径必须在仓库内，单次最多 400 行、64 KB。读的是主分支，不是工作区，因为「做完了」以主分支为准（决定 5）。
  - `code__changes`：某个提交范围内改了哪些文件（`git diff --stat`），用于核对上报和更新图。
- 具体参数 schema、返回格式留给实现者，只要满足上面的范围与大小限制。

### 4. 自带插件：archify（画图）

- 数据流向：`local`。默认开启。
- 依赖：archify（`tt-a1i/archify`，MIT）没有发布到 npm（`package.json` 为 `private`）。把固定版本的渲染器源码连同 LICENSE 放进本仓库 `vendor/archify/`，记录来源提交号；升级就是替换这个目录并重新渲染所有图。hub 镜像带上它。【Claude 的决定：渲染是确定性的、不需要读文件，放在 hub 里，Agent 写完描述就能同步拿到校验结果】
- **导入即画架构图**：绑定仓库后，hub 自动为这个 workspace 排一个系统任务：「为仓库 X 画架构图」。Agent 用 `code__*` 函数读代码，写出 archify 的 `architecture` 类型 JSON，交给 `diagram__save`。其他类型（流程、时序、数据流、生命周期、数据表关系等）不自动画，用户在聊天里提出时再画。【决定】
- **存放**：图的 JSON 描述是正本，存进知识仓库；HTML 只是渲染结果，按需生成，不进 git。【决定】
  - 新增条目类型 `diagram`，编号前缀 `G`，目录 `diagrams/`。条目 Markdown 记录标题、简短说明和 frontmatter；同名 `.json` 文件存 archify 描述。【Claude 的决定】
  - frontmatter 额外记录：仓库 id、图类型、画图时各相关仓库的主分支提交号、每个节点对应的路径列表（`nodePaths`）。
- **函数**：
  - `diagram__save`：参数为仓库、图类型、archify JSON、节点到路径的对应、（更新时）已有图的 id。hub 用 archify 校验（`validate <type> --quality showcase`）；不通过时把诊断返回给 Agent，让它修改后重试；通过则写入知识仓库（一次 commit，作者 agent，带来源和理由）。
  - `diagram__read`：读已有图的 JSON 描述和元信息。
- **显示**：右侧项目知识新增一组「代码图」，按仓库分组。点开在单独的浏览器窗口显示 archify 渲染的 HTML。HTML 由 hub 渲染并缓存，带限制性的内容安全策略（不允许外部脚本、不允许外连）。【决定：单独窗口；Claude 的决定：CSP】
- **过时与更新**【决定】：
  - 主分支前进后，若新提交改动的文件命中某张图的 `nodePaths`，这张图标「可能过时」（用主 spec 4.4 的时效性展示）。没命中的图不受影响。
  - 用户点「更新」或在聊天里要求时，跑一次任务：Agent 拿到旧描述（`diagram__read`）和自上次以来的改动（`code__changes`），只改受影响的节点和连线，再 `diagram__save`。
  - archify 升级时，用已存的 JSON 重新渲染即可，不需要重新读代码。

### 5. 自带插件：nema report（上报）与实现状态

数据流向：`local`。默认开启。参考 Orca 的做法：每家 agent 一个很薄的适配脚本，统一发到本机一个端点。【决定：两层】

**钩子层：自动发现「这里有人干过活」，不需要模型配合。**

- `nema report install --agent <名字>`：给指定的 coding agent 装钩子。只订阅「一轮结束」和「会话结束」两类事件（Claude Code 的 `Stop`、`SessionEnd`；Codex 等按各自的对应事件）。由用户手动执行，因为它会改动 coding agent 的全局配置；Nema 不会自己装。`nema report uninstall` 对称删除。【决定：手动安装】
- 第一版支持 Claude Code 和 Codex；其余 agent 按同一模式以后加。【Claude 的决定】
- 钩子只发：agent 名字、工作目录、当前分支、HEAD 提交号、时间、会话 id。不发对话内容、提示词、工具调用细节。钩子从 agent 给的事件里只取工作目录和会话 id，其余丢掉。
- 发送：钩子调用 `nema report hook`，POST 到 hub 的本机上报端点，带本机上报令牌（新文件 `~/.nema/report-token`，0600，由 `nema report install` 生成并登记到 hub）。连接超时 0.5 秒、总超时 1.5 秒，失败不影响 agent。【Claude 的决定：数值参照 Orca】
- hub 不可达时写入本机暂存文件（`~/.nema/report-spool.jsonl`，0600），超过 5 MB 停止写入，7 天前的内容清空；下次发送成功时补发。
- hub 收到后，按仓库找到 workspace：`nema report hook` 先在工作目录执行 `git rev-parse --git-common-dir`，得到仓库的共享 git 目录，再与各绑定仓库的 git 目录比较。这样 coding agent 在 `git worktree` 检出的目录里工作也能对上。独立 clone 的副本不匹配，它的工作由兜底规则通过主分支发现。找不到就丢弃，不存任何内容。【Claude 的决定】
- 钩子信号本身不触发整理任务。它只用来：触发 graphify 增量更新；以及判断「有没有语义上报」（见下面的兜底）。

**技能层：说清楚「做了什么」，靠模型自觉。**

- 一份通用的 `SKILL.md`：告诉 coding agent，完成一项工作后调用 `nema report`，写明：一句话说明、涉及的条目编号（可选，如 `R-7,D-12`）、提交号、改了哪些文件。`nema report install` 把它放进该 agent 的用户级技能目录（Claude Code：`~/.claude/skills/nema-report/`；Codex：其对应目录，实现前核对）。
- `nema report`（不带 `hook`）从参数或标准输入读取这些字段，同样按工作目录路由，同样用上报令牌。不在已绑定仓库里执行时报错并说明原因。
- 路由规则同钩子层（共享 git 目录）。
- 上报进入 workspace 聊天，显示为「coding agent 上报」，样式与用户消息区分（新的消息角色 `report`）。它和用户消息一样触发一次整理任务。上报内容对团队的可见性与原始聊天相同（仅本人）。【Claude 的决定】

**三级实现状态**【决定】

- 需求条目新增实现状态：`reported`（已上报）、`verified`（已核实）、`mismatch`（有出入），以及未开始时的空值。状态旁记录证据：上报消息 id、相关提交、核实结果。
- **已上报**：整理任务把上报关联到条目，状态设为 `reported`。回答进度时说「coding agent 上报已完成，尚未核实」。
- **已核实**：收到语义上报后，daemon 立即做确定性检查，不用模型：
  1. 上报的每个提交都存在；
  2. 都已在仓库主分支上（`git merge-base --is-ancestor <提交> <主分支>`）；
  3. 上报所列的文件都确实被这些提交改动过。实际改动多于上报所列不算问题（coding agent 可能漏写）；上报列了但没改动的文件才算不符。合并提交不计入，改名按新路径计。【Claude 的决定：只查「声称改了的确实改了」，避免待确认泛滥】

  第 2 项的「在主分支上」包括两种情况：提交本身是主分支的祖先；或者主分支上存在与它补丁内容相同的提交（`git patch-id` 相同），用来覆盖 squash 合并和 rebase 合并。squash 把多个提交合成一个时，比较上报各提交合起来的补丁与主分支上那一个提交的补丁。【Claude 的决定】

  检查结果附在上报消息上，进入整理任务的 prompt。全部通过，条目才能设为 `verified`。**Room API 强制这一点**：把条目设为 `verified` 的请求，必须引用一条核实通过、且覆盖相关提交的上报，否则返回 409。
- **有出入**：检查不通过（提交不存在、改动文件与上报不符），或 Agent 发现代码与决策不一致时，状态设为 `mismatch`，并新建一条待确认问用户，不自己判断谁对。
- 「做完了」= 已合进主分支（`origin/<主分支>`）并核实。工作区未提交的改动、开发分支上的提交，都只算「进行中」。
- 语义核对（代码是否真按决策实现）只在确定性检查发现异常、或用户要求时做，用 `code__*` 函数读代码。【决定】
- 提交存在但还不在主分支上（第 2 项不通过）时，不算有出入：状态保持 `reported`，证据里记「尚未合入主分支」。之后主分支前进到包含该提交时，daemon 重跑检查并更新。【Claude 的决定：避免每个开发中的上报都变成待确认】

**没有上报时的兜底**【决定】

- daemon 每 5 分钟检查一次各绑定仓库主分支的 HEAD，钩子信号到来时也检查。【Claude 的决定：5 分钟】
- 主分支出现新提交，且 30 分钟内没有覆盖这些提交的语义上报时（「覆盖」同样按祖先或补丁相同判断），hub 在该 workspace 生成一条系统输入「主分支有新提交但没有收到上报」，附提交列表，触发一次整理任务。Agent 用 `code__changes`、`code__read` 判断这些提交对应哪些条目；仅凭代码推断的关联标 `inferred`。【Claude 的决定：30 分钟】
- **代码推断的工作最多到「已上报（代码推断）」**【决定】：兜底发现的关联把需求设为 `reported`，证据记为「无上报，代码推断」，依据为 `inferred`。界面上与普通「已上报」区分显示。用户在条目上点「确认」后才升为 `verified`。Room API 的 409 规则因此是：`verified` 必须有核实通过的上报，或者由用户本人确认（UI 接口，不经 Room）。Agent 不能把代码推断的工作直接设为 `verified`。

### 6. 外部插件：GitHub（只读）

- 数据流向：`external`。默认关闭，在 workspace 设置里手动打开。【决定】
- 运行：官方 `github/github-mcp-server`（MIT），由 daemon 以 stdio 启动，固定参数 `--read-only --toolsets pull_requests,issues`。【Claude 的决定】
- 凭证：`nema auth github` 从标准输入读一个 personal access token，写入 `~/.nema/github-token`（0600，原子写入，拒绝符号链接），只以环境变量 `GITHUB_PERSONAL_ACCESS_TOKEN` 传给子进程。做法与 runtime spec 的 BYOK key 相同。不做 OAuth。【Claude 的决定：第一版用 PAT，OAuth 留给以后统一做】
- 开放给 Agent 的函数：从该服务器只读工具里挑出 PR 与 issue 的读取类（实现前用 `tools/list` 核对实际名字，例如 `pull_request_read`、`issue_read`、`list_issues`、`search_issues`）。全局插件页显示完整工具列表；workspace 设置里可以逐个关掉。
- 范围：每次调用的 `owner/repo` 必须是本 workspace 某个绑定仓库的 GitHub 远端；否则 hub 拒绝。

### 7. 管理界面【决定：方案 A】

- **侧栏底部「插件」页（全局）**：已安装的插件；每个插件的数据流向标签（仅本机 / 会外发）、安装或登录状态（graphify 是否在 PATH、GitHub 令牌是否存在，不显示令牌）、它提供的函数列表。
- **workspace 设置新增「代码与插件」页**：
  - 绑定的仓库：路径、用途说明、主分支；添加、移除。
  - 本 workspace 的插件：开关；`external` 插件旁注明「会外发」；可展开逐个开关函数。
  - 模型外发说明（决定 2 末项）。
- **右侧项目知识**：新增「代码图」分组（决定 4）；需求条目显示实现状态标记（已上报 / 已核实 / 有出入）及证据（决定 5）。
- 选 A 的理由：workspace 可能有约 100 个，矩阵式全局表不可读。【决定】
- 样式沿用主 spec 4.6，文案提供 ja / en / zh。

## 留给实现者

- 插件函数的参数与返回格式、错误文案的具体用词（中文短句，不含凭证）。
- hub 与 daemon 之间插件调用的消息格式（在现有 WebSocket 协议上扩展）。
- `diagram` 条目与 `.json` 文件的具体字段命名，只要包含决定 4 列出的信息。
- 各 agent 钩子的具体配置写法。
- 实现状态字段在 frontmatter 里的具体形状。

### 8. 系统发起的任务【Claude 的决定】

- 有三类任务不是用户发起的：绑定仓库后的画架构图、「主分支有新提交但没有上报」、用户点图的「更新」按钮。它们都以一条 `system` 角色的聊天消息作为任务输入（现有的「处理失败」已经是 `system` 消息），在聊天里显示为系统提示。
- 这条消息就是这次改动的来源：Agent 写入时 `sourceMessages` 引用它，满足现有「至少一条来源」的规则，修改历史里也能看到「因为哪条系统提示」。
- 用户点「更新」时，系统消息的内容写明是用户触发的，例如「用户要求更新架构图 G-3」。

## 实现前必须核对（不成立就停下来改本设计）

- archify 的 `validate` 和 HTML 渲染能否在不启动浏览器的情况下完成（影响 hub 镜像大小与 CSP）。

- graphify 能否把输出放在仓库之外，且 `--code-only` + `GRAPHIFY_BACKEND=none` 下完全不联网。
- `github-mcp-server --read-only --toolsets pull_requests,issues` 实际暴露的工具名。
- Codex 的钩子事件与技能目录位置。
- 扩大后的 Claude Code 工具面（`mcp__room__` 加插件函数）在真实 `claude` 的 init 里与预期一致。

## 验证

- 单元测试不启动真实 graphify、github-mcp-server、模型或 GitHub：用假的可执行文件和假的 MCP 服务器。
- 范围检查：调用未绑定仓库、未开启的插件或函数、未绑定的 `owner/repo`，都被 hub 拒绝且不转给 daemon。
- `code__read` 拒绝仓库外路径（含 `..` 与符号链接逃逸）和超限读取。
- 用户仓库在建图、读代码、画图之后，`git status` 与目录内容不变。
- graphify 运行时 `~/.cache/graphify-queries.log` 不被写入。
- 钩子：未绑定目录的信号被丢弃且不留记录；钩子载荷里的对话内容不进入 hub；hub 不可达时写入暂存并在恢复后补发。
- 三级状态：提交不在主分支时不能设为 `verified`（409）；主分支包含该提交后重跑检查可升为 `verified`。
- 兜底：主分支新提交 30 分钟无上报，生成系统输入并触发任务。
- 图：导入仓库触发一次架构图任务；archify 校验失败时诊断返回给 Agent；改动命中 `nodePaths` 时图标「可能过时」，未命中不标。
- 真机冒烟（用户执行）：绑定一个真实仓库 → 自动出架构图 → 在 Claude Code 里完成一项小改动并合入主分支 → 收到上报 → 需求升为「已核实」。
