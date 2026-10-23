# Nema Room

本地运行的「需求讨论室」：你在聊天里随手丢进零散的讨论记录，Agent（你自己的 Codex 订阅）把它们整理成需求、决策、外部来源与待确认问题。

## 前置条件

- Node ≥ 22
- Docker（用来跑 Postgres）
- git
- 默认的 Codex 直连需要一个 ChatGPT 订阅账号，并运行一次 `npx nema auth login`（见下面的「Codex 直连（默认）」）。
- 要用已经 `codex login` 的账号（`authMode=compat`）：凭证必须是**文件存储**（`~/.codex/auth.json` 存在）。如果凭证存在系统钥匙串里，请在 `~/.codex/config.toml` 设置 `cli_auth_credentials_store = "file"` 后重新登录。本项目不再启动 `codex` 命令。

有两种运行方式：开发时用 `npm run dev`（下面的「启动（开发模式）」），日常使用可以用 Docker Compose 一键跑起 Postgres + hub + web（「用 Docker Compose 运行」）。两种方式下 daemon 都在本机运行。

## 启动（开发模式）

```bash
cp .env.example .env      # 可选；不创建则 hub 需要自行设置 NEMA_DATABASE_URL
npm install
npm run db:up             # 启动 Postgres（127.0.0.1:5433）
npm run dev               # 同时启动 hub（4400）和 web（3000）
```

`npm run dev` 会读取仓库根目录的 `.env`（hub 与 web 都会加载；已存在的环境变量优先）。`NEMA_DATA_DIR` 中的 `~` 会被展开为你的 home 目录。

再**另开一个终端**启动 daemon（它负责在本机调起 Codex）：

```bash
npm run build -w apps/cli && npx nema daemon
```

必须先 `npm run build -w apps/cli`，因为 `nema` 命令指向编译后的 `apps/cli/dist/index.js`。最后打开 <http://localhost:3000>。

**升级说明**：`git pull` 之后，请**同时**重新构建 compose（`npm run up`）和 CLI（`npm run build -w apps/cli`）并重启 `nema daemon`。hub 与 CLI 版本不一致时，新 hub 会拒绝过旧的 daemon（日志提示「nema CLI 版本过旧」），任务保持排队而不会被悄悄丢弃。

随时可以运行 `npx nema doctor` 自检：它会检查 `git`、`codex` 是否安装（只作提示，缺失也不判失败，因为不再启动 CLI）、`graphify` 是否在 PATH 上（只作提示，缺失也不判失败：已安装时是 `graphify 可用：<版本>`，缺失时是安装提示 `graphify 未安装：请运行 uv tool install graphifyy`）、Codex 登录文件（只有 `authMode=compat` 时缺失才判失败）、直连登录状态、BYOK key 权限与 model 配置、`claude` 是否在 PATH 上、Claude Code token 文件是否存在且权限为 0600、hub 是否可达、daemon token 文件是否存在，每项一行 `✓/✗`，任何一项失败则退出码为 1。`authMode=siwc` 时未登录直连记为 `✗`；只有 `authMode=byok` 时才要求 BYOK key 和 model。只有 `adapter=claude-code` 时，缺 `claude` 或 token 文件（含权限不是 0600）才记为 `✗`；其他适配器下这两项只是说明，不算失败。doctor 不打印 token。

## Codex 直连（默认）

默认适配器是 `codex-direct`：daemon 不启动 Codex CLI，而是在本机运行 Nema 自己的工具循环，用你的 ChatGPT 订阅直接调用模型。模型拿得到 Room 的三个函数（`list_entries`、`read_entry`、`upsert_entry`）加上本次任务开启的插件函数，没有 shell、文件系统或联网工具，所以不再依赖「关掉 CLI 的一堆开关」来隔离。

```bash
npx nema auth login      # 浏览器里完成「Sign in with ChatGPT」，凭证存到 ~/.nema/auth.json（权限 0600）
npx nema auth status     # 查看模式、账号尾号、到期时间、最近一次认证错误（不显示令牌）
npx nema auth probe      # 列出模型并发一次最小请求，确认能用
npx nema auth logout     # 删除 Nema 自己的直连凭证
npx nema config get      # 查看配置；也可以 nema config get adapter
npx nema config set authMode compat        # 取代原来的 Codex CLI：直接读 ~/.codex/auth.json 调接口（见下方）
npx nema config set model <名称>            # 不设置则取账号可用模型列表的第一项
npx nema config set reasoningEffort high   # low | medium（默认）| high
```

也可以改用自己的 API key（BYOK）。这是按量付费的 API 调用，不使用 ChatGPT 订阅额度；接口返回 401 时不会刷新 key：

```bash
npx nema config set authMode byok
npx nema config set byokBaseUrl <url>       # 可省略，默认 https://api.openai.com/v1
npx nema config set model <名称>
printf '%s\n' 'YOUR_API_KEY_HERE' | npx nema auth byok  # key 从 stdin 写入
```

- **登录凭证与 Codex CLI 完全分开**：Nema 不读取、不链接 `~/.codex/auth.json`（刷新令牌只能用一次，两个程序共用会互相作废）。
- **不再启动 Codex CLI**。以前的 `codex-cli` 适配器已取消。配置或在途任务里如果还写着 `codex` / `codex-cli`，会改由直连执行，并读取 Codex 登录文件（`authMode=compat`）。`nema config set adapter codex-cli` 会报错。
- **不会静默换登录方式**：直连登录失效、额度用尽或接口不可用时，任务会失败并在聊天里说明原因。SIWC 与读取 Codex 登录文件之间的切换必须由你用 `nema config set authMode` 显式执行。
- 每次运行最多 24 轮模型调用、60 次工具调用、10 分钟；返回给模型的单个工具输出最多 64 KB。

### 风险与限制（如实说明）

- **目前实现的是官方模式（SIWC，Sign in with ChatGPT）**：这是 OpenAI 为第三方应用提供的正式途径，推理走公开的 `https://api.openai.com/v1/responses`，请求如实标识为 Nema，不冒充 Codex CLI。但 OpenAI 目前把它作为有限试用提供，个人账号能否开通取决于 OpenAI；令牌刷新接口见官方文档 <https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#refreshing-tokens>，已用 `nema auth probe --force-refresh` 实测验证可用（接口细节以后仍可能变化）。
- **刷新失败可能留下已作废的令牌**：刷新令牌每次刷新都会轮换。如果服务端已经消耗了旧令牌、但响应没能回到 Nema（5xx / 超时），本机保存的就是一个已作废的令牌，下一次刷新会得到 `refresh_token_reused`，这时必须重新运行 `nema auth login`。
- **id_token 的签名没有用 JWKS 校验**：登录时会检查 id_token 的 iss / aud / exp / nonce / sub 等声明，但不校验签名——该令牌是 Nema 通过 TLS 直接从令牌端点拿到的，按 OIDC Core 3.1.3.7 这种情况可以不验签；这是有意的取舍。
- **兼容模式（`nema config set authMode compat`）直接读 Codex 已经登好的登录**：daemon 读取 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）里的 access token，请求发到 `https://chatgpt.com/backend-api/codex/responses`，带上 token 里的 `ChatGPT-Account-ID`。不启动 Codex CLI，也不把这份凭证复制进 `~/.nema/auth.json`。Nema **不会刷新、不会改写** 这个文件——刷新令牌只能用一次，Nema 若自己刷新就会把 Codex 的登录作废。access token 过期后，打开一次 Codex 让它自己刷新，Nema 下次会重新读到新 token。这个接口不是 OpenAI 给第三方的公开接口，可能违反服务条款或随时失效。请求仍标明为 Nema（`originator: nema-room`），不冒充 Codex CLI。
- **公司 / 团队的 ChatGPT workspace 可能不允许**：这类账号的管理员可以禁止第三方应用代用户访问，登录或调用时会返回 `error_code: 3p_delegated_access_policy_denied`。这是组织的策略，Nema 不会也不提供任何绕过它的办法；请改用个人订阅账号，或请管理员放行。
- 服务商侧不受 Nema 控制：OpenAI 账号的记忆和数据保留、所有 workspace 共用同一个账号与额度；提示注入最多只能在本 workspace 内滥用 Room 工具（受 Room API 校验约束）。

## Claude Code

把适配器换成 Claude Code 后，daemon 用本机 PATH 上的 `claude` 跑同一次整理任务。这一档失败就停在 Claude，不会退回 Codex。仍然只有一个 MCP 服务器 `room`，`--tools ""` 不变。`--allowedTools` 是三个 Room 工具，再加上本次任务的插件函数（`mcp__room__<name>`）。`nema mcp` 向这个 `room` 服务器注册同一份函数。

```bash
npx nema config set adapter claude-code
claude setup-token
printf '%s\n' 'YOUR_TOKEN_HERE' | npx nema auth claude   # 从 stdin 写入，命令输出不打印 token
```

`claude setup-token` 只负责在 Claude 那边取出令牌。`nema auth claude` 从标准输入读这一行并写入 `~/.nema/claude-code-token`（权限 0600）。Nema 不读取 `~/.claude`，也不刷新这个令牌。Claude 报登录失败时，重新运行 `claude setup-token`，再把新令牌从标准输入交给 `nema auth claude`。

## 知识依据与时效

每条知识有一个依据：`stated` 是用户说过的，`decided` 是用户决定的，`inferred` 是 Agent 推断的。逐字摘录（`quotes`）对团队可见。

来源超过 90 天没有确认，会标成可能过时；其他类型不会。任务中断后最多重试 3 次，第四次中断就失败，并在聊天里留下一条系统消息。崩溃留下的未提交条目，会变成作者为 `system` 的 recover 提交。

## Code repositories and plugins

让 Agent 读本机代码之前，先安装 graphify：

```bash
uv tool install graphifyy
```

在 workspace 设置里绑定仓库。daemon 在线时会检查这条路径并建立索引。

Nema 读的是 `origin/<main>`，不是你当前检出的文件。daemon 每 5 分钟对已绑定的仓库执行一次 `git fetch`，不改动你的工作区，也不动本地分支。

graphify 不直接扫检出目录。它在一份私有快照上工作，目录是 `~/.nema/ws/<id>/graphify/`。

绑定仓库之后，Agent 可以使用这些函数：`code__search`、`code__explain`、`code__path`、`code__read`、`code__changes`。

Agent 读到的代码片段会随请求发送给模型服务商（OpenAI / Anthropic）。

## Code diagrams

**绑定时画架构图。** 新绑定一个仓库后，hub 会自动排一个系统任务，为这个仓库画一张 `architecture` 图。每个新绑定的仓库只画这一次；解绑后重新绑定，会再画一次。

**其他类型在聊天里要。** workflow、sequence、data-flow、ERD 等其他类型不会自动画。需要时在聊天里请 Agent 画，它用 `code__` 函数读代码，再用 `diagram__save` 保存。

**JSON 在 git 里，HTML 按需渲染。** 每张图是一条 `diagram` 条目（编号 `G-n`），存成知识库里的 `diagrams/G-n.md` 和 archify JSON `diagrams/G-n.json`，跟其他知识一起版本化。hub 保存前用 archify 校验 JSON，不通过就把诊断信息还给 Agent 让它修，不写入 git。HTML 在打开时由 hub 渲染，不提交；返回时带严格的 `Content-Security-Policy`。在知识面板的「代码图」分组里点开，图在新窗口里显示。

**「可能过时」标记。** 仓库的 main 分支移动后，如果改动的文件落在某张图节点对应的路径里，这张图会被标成「可能过时」。没碰到图上路径的改动不会标记。图不会自动重画。

**更新按钮。** 在图的详情里点「更新」，hub 排一个系统任务，让 Agent 读旧图、看自画图那次提交以来的改动，只改受影响的节点和连线（编号不变）。也可以直接在聊天里要求更新。

**vendored archify。** 渲染和校验用的是仓库里的 `vendor/archify/`，当前是 archify v3.2.0（提交 `208acba`），纯 Node 运行，不联网。升级时：克隆新 tag，替换 `vendor/archify/` 里的目录，更新 `vendor/archify/VENDORED.md` 里的 tag、提交和日期，再跑 `npx vitest run apps/hub/test/archify.test.ts`。已经存下的图不用改：HTML 不落盘，重启 hub 后再打开，就用新版本重新渲染。

## Coding agent reports

编码 Agent（Claude Code、Codex）做完活后，可以把结果报给 Nema。Nema 不用模型，只用 git 核对这份上报，再跟踪每条需求的实现状态。

**安装 / 卸载。**

```bash
nema report install --agent claude     # 写入 ~/.claude/settings.json 和 ~/.claude/skills/nema-report/
nema report install --agent codex      # 写入 ~/.codex/hooks.json 和 ~/.agents/skills/nema-report/
nema report uninstall --agent claude   # 只删 Nema 自己的 hook 条目和 skill
```

安装会在 `Stop` 和 `SessionEnd` 上各加一条 hook，执行 `nema report hook`，并装一个 `nema-report` skill。配置文件里已有的其他 hook（比如 Orca 的）原样保留，顺序也不变。卸载只删 Nema 的条目；`~/.nema/report-token` 留着。

**hook 发什么。** 只发 `agent`、`cwd`、git common dir、分支名、HEAD 的 sha、时间和 session id，别的都不发。Agent 的 hook 数据里还有对话记录路径、提示词等，这些不读、不存、也不转发。hub 用 git common dir 找到绑定的仓库，所以在 `git worktree` 或子目录里工作也能对上；单独 clone 的另一份不算同一个仓库。没绑定到未归档 workspace 的仓库，hub 直接丢弃，什么也不存。hub 不在线时，hook 写进 `~/.nema/report-spool.jsonl`（0600，上限 5 MB，超过 7 天的行丢弃），下次发送成功时按顺序补发。hook 失败不会让 Agent 出错，也不往标准输出写任何东西。

**`nema report` 用法。** skill 会让 Agent 在仓库里跑：

```bash
nema report --summary "实现了流式输出" --commits abc1234,def5678 --entries R-7,D-12 --files src/stream.ts
echo '{"summary":"…","commits":["abc1234"]}' | nema report --json
```

上报会变成聊天里的一条 `report` 消息。daemon 核对三件事：提交存在；提交在主分支上；声称改过的文件确实被这些提交改过（多改了别的文件没关系，merge 提交不算，改名按新路径算）。核对完，hub 排一个整理任务。

**三种状态。** 需求条目的 `implementation` 有三种：

- `reported`：已上报，还没核实通过（比如提交还没合入主分支，证据写着「尚未合入主分支」）。
- `verified`：上报的核对通过。只有核对通过的上报，或你在界面上的确认，才能变成 verified。
- `mismatch`：上报和代码对不上，比如提交不存在，或声称的文件没被改过。

**「做完」= 在 `origin/<main>` 上。** 没有 origin 时看本地 main。上报的提交是主分支的祖先，就算合入。之后主分支每移动一次，还没合入的上报会重新核对，通过后变成 `verified`。

**squash 合并。** squash 之后原提交不是主分支的祖先。只要主分支上有一个提交的 `git patch-id --stable` 和这些提交合起来的 patch-id 相同，也算合入。

**30 分钟兜底。** hub 每 5 分钟检查一次。主分支移动 30 分钟后，如果里面有提交没有任何上报覆盖，hub 排一个系统任务，列出这些提交，让 Agent 用 `code__changes` / `code__read` 判断它们对应哪些需求。

**推断出来的要你确认。** 仅凭代码推断出的关联，只会标成 `reported`，并注明是推断的。Agent 不能把它设成 `verified`，要你在界面上确认后才会变成 verified。

## Work packages

开发包把你选好的需求变成「一份 spec + 一份 plan」，交给编码 Agent 去做，再用上报推进状态直到完成。

**生成。** 在知识面板里选一条或几条 `active` 的需求，点「生成开发包」（要先绑定代码仓库，并开着 `superpowers` 插件）。hub 新建一条 `workpackage` 条目（编号 `W-n`，存成知识库里的 `W-n.md`、`W-n.spec.md`、`W-n.plan.md`），并排一个系统任务，让 Agent 写 spec 和 plan。这类任务的上限比普通任务大：48 次模型调用、120 次工具调用、20 分钟。写的时候 Agent 用 `workpackage__*` 函数，规则文本在 `vendor/superpowers-rules/`。

**grill 步骤。** 写 spec 之前先做就绪检查：Agent 读相关需求、决策和待确认内容，遇到会影响实现的不确定点，就建 `question` 条目，并用 `workpackage__block` 把开发包卡在最重要的那个问题上，不写 spec。你在界面里回答（解决）这个问题后，生成会自动重跑一次。`grill-me` 是内置插件，在 workspace 设置里可以调：严格程度（严格 / 宽松，宽松时只有决策互相冲突才停下来），以及额外规则（最多 2000 个字符）。关掉 grill-me 后不再做就绪检查，不确定点写进 spec；但整理时「拿不准就建 question」这条规则始终保留。

**spec 标记与 plan 格式。** hub 在保存时校验，不通过就把原因还给 Agent 让它改，不写入 git。无论知识库用什么语言，下面这些固定标记都按原样书写：

- spec 里的「## 已定的做法」一节，每个列表项至少带一个 `[R-n]`、`[D-n]`、`[T-n]`、`[Q-n]`、`[S-n]`、`[G-n]` 来源标记，或者 `[推断]`。
- plan 里每个任务的标题是 `### 任务 <n>：<标题>`，编号从 1 连续递增，最多 15 个任务。
- 任务里用 `- 修改：<仓库标签>:<路径>` 和 `- 新建：<仓库标签>:<路径>` 列文件，用一行 `- 满足：R-3、R-5` 写它满足的需求。「修改」的文件必须已经在主分支上，否则保存被拒；新文件请写「新建」。仓库标签必须是已绑定的。

**批准，以及编辑后重置。** 批准只能由你在界面上做，批准时会记下知识库当时的提交。批准之后，你在界面里改 spec 或 plan（或 Agent 重新生成），状态都会回到 `draft`，要重新批准；回到 `draft` 的包不再提供给 `nema wp get`。你也可以重新生成或放弃（`dropped`）一个开发包。

**`nema wp list` / `nema wp get`。** 在绑定了的仓库里：

```bash
nema wp list                       # 列出覆盖这个仓库、已批准的开发包
nema wp get W-1                    # 写入 ./.nema/W-1/spec.md 和 plan.md
nema wp get W-1 --stdout           # 只打印，不写文件
nema wp get W-1 --dir ../elsewhere # 写到别处的 .nema/W-1/ 下
```

`nema wp get` 在编码 Agent 自己的进程里运行，文件写在它的工作目录下；Nema 从不往你的仓库里写东西。已有同名文件且内容不同时会拒绝，加 `--force` 覆盖。

**按任务上报。** plan 文件开头会带一行提示。每做完一个任务，编码 Agent 运行：

```bash
nema report --entries W-1 --task 2 --summary "…" --commits abc1234 --files src/x.ts
```

**状态怎么变，什么时候算 done。** 任务状态是 `pending`、`reported`、`verified`、`mismatch`，另有一个 `inferred` 标记。它们由 hub 根据上报的核对结果设置，Agent 不能自己改：提交已在主分支上、声称的文件确实改过、并且碰到了任务列出的文件，才是 `verified`；提交还没合入主分支是 `reported`；对不上是 `mismatch`。同一任务的后一次上报通过核对，可以把 `reported` 或 `mismatch` 升成 `verified`，而 `verified` 不会被后来失败的上报降级。上报写了不存在的任务号、或开发包没有批准，上报照常保存和整理，任务状态不变。`reported`（包括仅凭代码推断出的）和 `mismatch` 的任务，可以由你在界面上确认成 `verified`。开发包状态由任务推出来：有任务离开 `pending` 就是 `in_progress`，全部任务 `verified` 就是 `done`；这时它覆盖的需求也会标成 `verified`。

**superpowers 署名。** spec 和 plan 的写作规则改写自 [superpowers](https://github.com/obra/superpowers)（MIT，Copyright (c) 2025 Jesse Vincent）的 brainstorming 和 writing-plans 技能。许可证和来源版本在 `vendor/superpowers-rules/` 下。

## GitHub (read-only)

GitHub 插件让 Agent 只读查看已绑定仓库在 GitHub 上的 pull request 和 issue。它通过官方的 `github-mcp-server` 工作，每个 workspace 默认关闭。

**安装 `github-mcp-server`。** 从 [github/github-mcp-server](https://github.com/github/github-mcp-server) 的 Releases 下载对应平台的二进制，放进 `PATH`；或者用 Go 安装：

```bash
go install github.com/github/github-mcp-server/cmd/github-mcp-server@latest
```

daemon 用固定参数 `stdio --read-only --toolsets pull_requests,issues` 启动它，任何设置都不能改。子进程的环境变量只有 `PATH`、`HOME`（`~/.nema/run/github/` 下的目录）和 `GITHUB_PERSONAL_ACCESS_TOKEN`。

**保存令牌。** 在终端运行下面的命令，从标准输入粘贴 personal access token：

```bash
nema auth github
```

令牌写入 `~/.nema/github-token`（0600），不会打印，也不会写进日志或错误信息。权限只要读就够：fine-grained token 给相关仓库 Contents、Pull requests、Issues 的只读权限（Metadata 只读会自动带上）；classic token 读公开仓库不需要额外 scope，读私有仓库需要 `repo`。`nema doctor` 会检查 `github-mcp-server` 和令牌。插件页面显示是否已安装、是否已保存令牌。

**默认关闭，会外发。** 每个 workspace 都要在 workspace 设置里手动打开 GitHub 插件，机密 workspace 也一样。打开后，Agent 的查询内容（仓库名、issue / PR 编号、搜索词）会发送给 GitHub。

**只能访问绑定仓库的远端。** 每次调用的 `owner/repo` 必须是本 workspace 已绑定仓库的 GitHub 远端（`origin`，不区分大小写）。`https://github.com/o/r.git`、`git@github.com:o/r.git`、`ssh://git@github.com/o/r` 都算 `o/r`。搜索必须且只能带一个 `repo:owner/name` 限定。其他目标一律拒绝，不会转发给 GitHub。远端不在 github.com 上的仓库（GitLab、自建服务器）没有 GitHub 目标，workspace 设置里在该仓库下显示「没有 GitHub 远端」。

Agent 可用的函数：`github__pull_request_read`、`github__list_pull_requests`、`github__search_pull_requests`、`github__issue_read`、`github__list_issues`、`github__search_issues`。服务器有、但不在这个列表里的工具不会提供给 Agent。

## 用 Docker Compose 运行

`docker compose up` 会启动 Postgres、hub 和 web 三个容器；**daemon 不进容器，仍在本机运行**。

### 前置条件

- Docker（含 Docker Compose v2）
- 本机：Node ≥ 22、git。默认的 SIWC 需要 `npx nema auth login`；`authMode=compat` 需要已经 `codex login` 且凭证在文件里（见上文「前置条件」）。两种都不启动 `codex` 进程。

### 启动

```bash
cp .env.example .env      # 可选；compose 会读取其中的 NEMA_HUB_PORT / NEMA_WEB_ORIGIN / NEXT_PUBLIC_HUB_URL 等
npm run up                # = mkdir -p ~/.nema/data && docker compose up -d --build
```

然后在**本机**另开一个终端启动 daemon：

```bash
npm install
npm run build -w apps/cli
npx nema daemon           # 连接 http://127.0.0.1:4400
```

最后打开 <http://localhost:3000>。`npm run logs` 查看 hub / web 日志，`npm run down` 停止全部容器（Postgres 数据保存在 `nema-pg` volume 中，不会丢）。

注意：

- 容器内的 hub / web 监听 `0.0.0.0`，但 compose 只把端口发布到本机回环地址：`127.0.0.1:4400`（hub）、`127.0.0.1:3000`（web）、`127.0.0.1:5433`（Postgres），局域网上的其他机器访问不到。
- hub 的数据目录是本机 `~/.nema/data` 的 bind mount（可用 `NEMA_DATA_HOST_DIR` 改成别的绝对路径；`npm run up` 只会预先创建 shell 环境变量里的这个目录，写在 `.env` 里时请自己先 `mkdir -p`）。hub 在这里生成 `daemon-token`、保存各 workspace 的知识库 git 仓库，本机的 daemon 也从这里读取 `daemon-token`，所以两边必须是同一个目录（daemon 默认读 `~/.nema/data/daemon-token`，否则用 `--token-file` 指定）。
- Linux 上 hub 容器默认以 uid/gid `1000` 运行；如果你的 `id -u` / `id -g` 不是 1000，请在 `.env` 里设置 `NEMA_UID` / `NEMA_GID`，否则 daemon 读不到容器写出的 `daemon-token`（权限 600）。Docker Desktop（macOS / Windows）会自动映射文件属主，不用设置。
- `NEXT_PUBLIC_HUB_URL` 在构建 web 镜像时写进前端代码，改了以后要重新 `npm run up`（会重新构建）。
- 开发模式与 compose 模式共用 4400 / 3000 端口和同一个 Postgres，不要同时运行 `npm run dev` 和 `npm run up`。

### 为什么 daemon 必须在本机运行

daemon 在本机调用模型：SIWC 凭证在 `~/.nema/auth.json`，`authMode=compat` 则读取本机的 `~/.codex/auth.json`。把它放进容器就得把登录凭证搬进去，所以第一版保持在本机运行，只通过 `http://127.0.0.1:4400` 连接 hub。它不再启动 `codex` 可执行文件。

也因为 hub 在容器里看不到本机的 `~/.nema/ws/`，删除 workspace 时 hub 只删除自己的数据（数据库记录和知识库仓库），本机的隔离目录由 daemon 删除：daemon 在线时 hub 会立即通知它；daemon 离线期间删除的 workspace，会在 daemon 下次连接时根据 hub 发来的现存 workspace 列表一并清理。清理只针对 `~/.nema/ws/` 下名字形如 `ws_xxx` 的目录，不跟随符号链接。

### 环境变量

见 `.env.example`：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `NEMA_DATABASE_URL` | `postgres://nema:nema@127.0.0.1:5433/nema` | hub 的数据库 |
| `NEMA_DATA_DIR` | `~/.nema/data` | hub 数据目录（含 `daemon-token`） |
| `NEMA_HUB_PORT` | `4400` | hub 端口（compose 模式下容器内外端口相同） |
| `NEMA_HUB_HOST` | `127.0.0.1` | hub 监听地址（开发模式请保持默认；Docker 镜像内为 `0.0.0.0`，端口只发布到 127.0.0.1） |
| `NEMA_WEB_ORIGIN` | `http://localhost:3000,http://127.0.0.1:3000` | hub 允许的 web 来源（逗号分隔；web 只监听 127.0.0.1） |
| `NEXT_PUBLIC_HUB_URL` | `http://127.0.0.1:4400` | web 访问 hub 的地址（compose 模式下为构建参数） |
| `NEMA_DATA_HOST_DIR` | `~/.nema/data` | 仅 compose：挂载为 hub 数据目录的本机目录 |
| `NEMA_UID` / `NEMA_GID` | `1000` | 仅 compose（Linux）：hub 容器运行的 uid / gid |

daemon / doctor 默认读取 `<NEMA_DATA_DIR>/daemon-token`（未设置则 `~/.nema/data/daemon-token`）。注意 CLI 读的是 shell 环境变量而不是 `.env`，如果在 `.env` 里改了 `NEMA_DATA_DIR`，请同样 export 它，或加 `--token-file <路径>`。`CODEX_HOME` 指定 `authMode=compat` 读取的 Codex 配置目录（默认 `~/.codex`）。

### Hub 的本机访问限制

- hub 只接受 `Host` 为 `127.0.0.1:<NEMA_HUB_PORT>` 或 `localhost:<NEMA_HUB_PORT>` 的 `/api`、`/room` 请求，其他 Host 一律 403（防 DNS rebinding）。因此请用这两个名字之一访问 hub（`NEXT_PUBLIC_HUB_URL` 也必须是其中之一）；daemon 的 WebSocket `/daemon` 不受影响，仍靠 daemon token 认证。compose 模式下浏览器和 daemon 经由发布到 `127.0.0.1` 的端口访问容器里的 hub，`Host` 依旧是 `127.0.0.1:<端口>` / `localhost:<端口>`，所以容器内端口必须与发布端口一致（`docker-compose.yml` 已按 `NEMA_HUB_PORT` 两边设成同一个值）。
- `/api` 下的 POST / PUT / PATCH 必须带 `content-type: application/json`，否则返回 415（挡住跨站的“简单请求”）。
- 用户在界面里修改条目（`PUT /api/workspaces/:id/entries/:eid`）时，请求里的 `basis` 和 `confirmed` 会被忽略：决策写成 `decided`，其他类型写成 `stated`，并刷新确认时间。`POST /api/workspaces/:id/entries/:eid/confirm` 的 body 为 `{}`，返回确认后的条目，重新索引并发出 `knowledge.changed`；条目不存在时返回 404。
- 绑定本机 git 仓库：`GET/POST /api/workspaces/:id/repos`，`PATCH/DELETE /api/workspaces/:id/repos/:repoId`。POST 的 body 是 `{ path, label, mainBranch? }`。daemon 在线时会校验路径，并尝试 `git fetch` 后用 graphify 建索引（不把符号链接展开进快照）。有 origin 且 fetch 成功时快照是 `origin/<main>`；fetch 失败或没有 origin 时快照是本地分支，或仓库里已经有的远程 ref。同一个 git 仓库（相同的 git common dir，即使路径写法不同）不能绑第二次，返回 409，错误信息为 `该仓库已绑定到 workspace <名称>`。用途说明（label）需为 1–40 个字符且不含控制字符，否则 400 `用途说明需为 1–40 个字符`；同一 workspace 内不能重复，否则 409 `本 workspace 已有用途为 <label> 的仓库`。`code__changes` 的 `from`/`to` 只能是主分支 ref 本身，或主分支已包含的提交 sha，否则报 `提交 <x> 不在主分支上`。daemon 未连接、已断开或响应超时时 POST 返回 503，正文就是 `daemon 未连接`、`daemon 已断开` 或 `daemon 响应超时`。仓库路径校验失败返回 400，正文是 daemon 的中文原因。`mainBranch` 不是单个分支名（例如含 `:` 的 refspec）时 POST / PATCH 返回 400 `主分支名称无效`。保存的 origin URL 会去掉 `user:secret@`。仓库不存在时 PATCH / DELETE 返回 404 `找不到仓库：<id>`。本机需要 `graphify`（`uv tool install graphifyy`）；测试通过 daemon 的 `graphify: { bin, timeoutMs }` 选项注入假可执行文件（不再读环境变量）。daemon 每 5 分钟检查已绑定仓库的 main：hub 在 welcome、绑定变化和删除 workspace 时发送 `repos.sync`，条目含 `lastMainSha`（从未记录时为 null）。绑定后建索引成功时，hub 把索引用的 sha 存为 `lastMainSha`，不发 `repo.moved`。第一次看到 null 只记下当前 sha，不更新索引也不发 `repo.moved`；之后 sha 变了才按变更文件增量更新索引（重命名会删掉旧路径；还没有 `graphify-out/graph.json` 时整份重建），并发送 `repo.moved`。每次检查都发 `repo.fetched`。fetch 失败时保留上次的 sha，索引和 `code__read` 仍用上次的 ref；没有 origin 时跟随本地分支。索引失败（例如没装 graphify）时 daemon 记下错误，仍发送 `repo.moved` 并推进 sha。fetch 失败时 hub 只更新 `last_fetch_error`，`last_fetch_at` 保留上次成功的时间，设置页同时显示失败原因和上次成功时间。`repo.moved` 没发出去（socket 已关、发送失败或回调抛错）时也不推进 sha，下一轮重试索引和消息。上一轮还没跑完时不会再开一轮。这些操作不改工作区。
- 房间插件：运行中的任务用 run token 调用 `GET /room/plugins` 和 `POST /room/plugins/:name`。GET 返回本 workspace 已开启的只读工具。POST 的 body 是函数参数，且必须带一个本 workspace 已绑定仓库的 `repo`（仓库 id 或标签）。函数未开启返回 403 `函数 <name> 未在本 workspace 开启`。repo 对不上返回 400 `repo 不是本 workspace 绑定的仓库：<value>`。通过这项检查后，hub 把调用转发给 daemon 的 `plugin.call`（带上解析出的仓库路径），成功返回 `{ result }`。daemon 的其它错误返回 502，正文是 daemon 的错误信息；`daemon 未连接`、`daemon 已断开`、`daemon 响应超时` 返回 503，正文就是这一句。只要通过了「函数已开启」这一关，无论后面成功还是失败，都会写一行 `plugin_calls`；没通过则不写。
- daemon 的 `plugin.call` 执行代码函数。`code__search`、`code__explain`、`code__path` 查图；还没有 `graphify-out/graph.json` 时先走和 `repo.index` 相同的建索引。`code__read` 读主分支上已提交的文件（可选 `startLine` / `endLine`，均为 ≥1 的整数）。`code__changes` 比较 `from` 到 `to`，省略 `to` 时用当前主分支 ref 的完整 SHA。缺参数或类型不对返回 `<函数名> 参数无效：<字段>`，未知函数返回 `未知函数 <name>`。查图的 `query`、`symbol`、`from`、`to` 以 `-` 开头时返回 `参数不能以 - 开头：<值>`。`plugins.status` 运行 `graphify --version`：成功时 `{ code: { installed: true, detail: "<版本>" } }`，找不到命令时 `installed` 为 false，`detail` 为 `graphify 未安装：请运行 uv tool install graphifyy`。
- 插件设置：`GET /api/plugins` 返回插件注册表，并附带 daemon `plugins.status` 的 `installed` 和 `detail`（daemon 不在线时同样是上面的 503 / 502）。`GET /api/workspaces/:id/plugins` 和 `PATCH /api/workspaces/:id/plugins/:pluginId` 读写该 workspace 的开关和禁用函数。本地插件默认开启，机密 workspace 也一样；没有对应行时不落库。未知插件返回 404 `找不到插件：<id>`。`disabledFunctions` 里出现该插件没有的函数名时返回 400 `未知函数 <name>`。`code` 的函数只有在 workspace 至少绑定了一个仓库时才会交给模型和 `task.assign` 的 `pluginTools`；`readOnly: false` 的函数不会提供。`repo` 参数的说明会列出已绑定仓库，格式为 `id (label)`。

### 重启与归档

- hub 重启时会中断上一个进程遗留的 `running` 任务并作废其 run token；daemon 连接时也会中断不属于当前连接的 `running` 任务。前三次中断会重新排队，daemon 重连后重新领取执行；第四次中断则让任务失败，并在聊天里留下一条系统消息。
- hub 启动时会检查每个 workspace（含已归档）的知识仓库。未提交的条目文件各自记为一条 system 的 recover 提交；解析不了的文件、删除，以及其他路径都原样留下。
- 只有**正在运行**的任务会阻止归档 / 删除 workspace（返回 409）。删除会一并删掉排队中的任务；归档会保留排队中的任务但暂停领取，取消归档后继续；已归档的 workspace 不能再发消息（409）。

## 隔离

Codex 不再走 CLI。模型只有 Room 的三个函数和本次任务的插件函数，没有 shell 和文件系统，见上面的「Codex 直连（默认）」。

下面是已取消的 Codex CLI 隔离措施，只留作以后接入其他 CLI agent 时的记录。当时每个 workspace 的每次运行会：

- Codex 主目录 `~/.nema/ws/<workspace id>/codex-home/` 每次从零生成，只有一份 `config.toml`，以及指向你 `~/.codex/auth.json` 的符号链接，**不继承**你的全局指令、记忆、历史或其他 MCP server；
- `config.toml` 关闭记忆、历史持久化、联网搜索和更新检查，沙箱为只读，审批策略为 never（`room` 的 MCP 工具通过 `default_tools_approval_mode = "approve"` 预先批准，否则 Codex 非交互模式会自动拒绝工具调用），且 MCP server 只有 `room` 一个；
- 子进程的 `HOME`、`CODEX_HOME`、`TMPDIR` 都指向该 workspace 的目录，环境变量只透传 `PATH`、`LANG`、`LC_ALL`、`TERM`；
- 工作目录是一次性的临时目录，运行前会做 preflight（目录向上不能有 `.git` 或 `AGENTS.md`，`codex-home` 里不能有 `AGENTS.md` 等），运行后清理。

## 第一版无法彻底堵住、明确接受的残余风险

- **同一个系统用户**：Agent 以用户本人的系统账号运行，理论上仍能通过命令读取其他 workspace 的数据目录和用户的其他文件。彻底隔离需要每个 workspace 一个独立系统用户、容器或虚拟机。第一版不做，列入后续加固。
- **服务商侧共享**：所有 workspace 共用同一个 OpenAI / Anthropic / Cursor 账号，服务商那边的记忆、云端历史和数据保留策略无法由 `nema` 控制。建议用户在账号设置中关闭云端记忆类功能。
- **共享登录**：所有 workspace 共用一份登录凭证，其中一次运行导致登出会影响全部 workspace。
