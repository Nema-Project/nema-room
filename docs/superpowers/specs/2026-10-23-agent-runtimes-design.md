# Agent runtime：Claude Code 与 BYOK

调研笔记：`docs/reviews/2026-10-23-agent-runtime-research.md`。日期：2026-10-23。

## 意图

设计说明 6.2 已经定了接入顺序：Codex，然后 Claude Code，然后 Cursor。Codex 已改为进程内直连（6.7），因为 Codex CLI 关不掉自带的 shell、文件和插件。下一步是让用户改用本机已登录的 Claude Code 订阅来跑同一个整理任务。

Hermes 和 Multica 的接法都是「本机拉起一个已经登录的 CLI」。Multica 把仓库、shell 和会话续写交给那个 CLI。Nema 要的是相反的东西：模型仍然只能读写本 workspace 的 Room。所以 Claude Code 只借用它们的进程边界和失败方式，不借用它们的工具面。

BYOK 走另一条已经存在的路：Hermes 把 API key 放在自己的进程里，工具循环仍是自己的。Nema 的 `codex-direct` 就是这条循环。BYOK 给它加一把 key，不新开 CLI。

## 目标

- 本机配置 `adapter=claude-code` 时，daemon 用官方 `claude` 进程跑 hub 下发的同一次整理任务。
- 模型能调用的工具只有 Room 的 `list_entries`、`read_entry`、`upsert_entry`，经现有的 `nema mcp` 打到 hub Room API。
- 登录是用户显式交给 Nema 的 Claude Code setup token。Nema 不读、不刷新用户自己的 `~/.claude` 或钥匙串。
- `claude` 不在 PATH 上、没有 token、或无法证明工具面时，这次任务失败并说明原因。不改跑 `codex-direct`。
- `authMode=byok` 时，同一个 `codex-direct` 循环改用 `~/.nema/byok-key` 和 `byokBaseUrl` 调用 Responses。不启动 CLI，失败不改走订阅。

## 非目标

- 不接 Cursor，不做通用 ACP 客户端，不恢复 Codex CLI / `codex app-server`。
- 不按 workspace 选不同适配器，不保存 Claude 会话，不实现 `--resume`。
- 不把 `config.model` 以外的模型发现、effort、`--permission-mode` 做进 Claude 这一档。
- hub 仍不调用模型、不接触凭证。任务仍是 `adapter: "auto"`，由 daemon 按本机配置选择。
- BYOK 不做供应商目录。不接 Anthropic Messages（`x-api-key`），不接只提供 Chat Completions 的网关。那些是另一套请求体，这一版不写。
- 不读取 `OPENAI_API_KEY` 或任何环境变量里的 key。没有写进 `~/.nema/byok-key` 的钥匙不算登录。

## 反目标

- 任务跑起来了，但 Claude 还能用 Bash、读文件、加载用户 MCP 或用户的 `CLAUDE.md`。这和「接上了」同时成立也算失败。
- 静默退回 Codex，或在 Claude 失败时自动再试另一个 runtime。
- 把 setup token 或 API key 打进日志、shell 历史、或 hub。
- BYOK 失败时改走订阅登录，或订阅失败时改走 BYOK。

## 已有决定（沿用，不是这次新定的）

- 默认仍是用户自己的订阅（6.1）。BYOK 是显式打开的按量登录，见下面专节。Claude Code 这一档仍然不走 Anthropic Messages API。
- 服务端不调用模型（6.2）。工具循环或 CLI 都在本机 daemon。
- Room API 是唯一知识入口；CLI 走 `nema mcp`（6.2）。
- 每次运行无状态；全局一次只跑一个任务（4.5）。
- 上限与直连相同：24 轮、60 次工具调用、10 分钟（6.7 第 4 项）。（2026-10-23 开发包修订：开发包生成任务随 `task.assign` 带 `limits`，改为 48 轮、120 次工具调用、20 分钟；`--max-turns` 取 `limits.maxModelCalls`，工具次数与时长也取 `limits`。其余任务不变。）
- 自定义 Claude 配置目录不能复用交互式登录；用一次 `claude setup-token`，令牌交给 `nema` 保管（6.6 的 Claude 行）。

## 这次的决定

以下除标明「沿用」外，都是这次调查后的决定。

### 1. 只加一个适配器

- 名字：`claude-code`。
- `~/.nema/config.json` 的 `adapter` 允许 `codex-direct` 和 `claude-code`。缺省文件、以及未写 `adapter` 的旧文件，仍然是 `codex-direct`。
- `nema config set adapter claude-code` 可以写入。`codex` / `codex-cli` 仍按 6.7 迁移成 `codex-direct` + `authMode=compat`，不迁移成 Claude。
- daemon 两个适配器都注册。hello 里两个名字都有。hub 现有的「必须看到 `codex-direct` 或 `codex-cli`」检查不用改。
- 任务里的 `adapter` 仍由 hub 发 `auto`。daemon 只跑配置里的那一个。配置是 `claude-code` 而进程里没有这个适配器时，失败文案保持现在的「adapter … 不可用」。

### 2. 凭证

- 文件：`~/.nema/claude-code-token`，权限 0600，内容是一行 token，没有别的字段。
- 写入：`nema auth claude` 从 stdin 读这一行（不从参数读，避免进 shell 历史），原子写入。拒绝跟随符号链接。
- 运行时只通过环境变量 `CLAUDE_CODE_OAUTH_TOKEN` 传给子进程。不写进 MCP 配置，不写进 prompt。
- Nema 不刷新这个 token。Claude 报登录失败时，任务失败，提示重新执行 `claude setup-token` 并把新值从 stdin 交给 `nema auth claude`。
- `nema doctor` 在 `adapter=claude-code` 时检查两件事，且都不打印 token：`claude` 是否在 PATH 上；token 文件是否存在且权限是 0600。其他适配器下，缺这两样只是说明，不算失败。

### 3. 进程与目录

每次任务：

- 配置目录：`~/.nema/run/<taskId>/claude-config`，0700，空目录，作为 `CLAUDE_CONFIG_DIR`。不用 `~/.claude`。
- 工作目录：同一次运行下的空 `work/`。不在任何 git 仓库里，里面没有 `CLAUDE.md` / `AGENTS.md`。
- MCP 配置：同一次运行下的 `mcp.json`，0600。形状与退役的 Codex CLI 适配器相同：`mcpServers.room.command` 是当前 Node 可执行文件，`args` 是 `[<本 CLI 入口>, "mcp"]`，`env` 只有 `NEMA_HUB_URL` 和 `NEMA_RUN_TOKEN`。服务器名字只有 `room`。
- 环境从空环境开始，只放入：`PATH`、`LANG`、`LC_ALL`（有则传）、`TERM`（有则传）、`TMPDIR`、`HOME`（指向这次的配置目录）、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_OAUTH_TOKEN`。不继承用户环境里的其他变量。
- 进程结束或失败后删掉整个 `~/.nema/run/<taskId>/`。token 文件不在这里，不删。

### 4. 启动参数

固定参数，不允许配置覆盖：

- `-p`
- `--output-format stream-json`
- `--input-format stream-json`
- `--verbose`
- `--strict-mcp-config`
- `--mcp-config <上面的 mcp.json>`
- `--setting-sources ""`
- `--tools ""`（2026-10-23 验收修订：`--allowedTools` 只预先批准、不移除内置工具。实测 Claude Code 2.1.306 不带此旗标时，init 的 `tools` 列出 Bash、Edit、Read、Write、WebSearch 等，第 5 节的判定每次都失败；带上后内置工具为空，只剩 MCP 工具）
- `--allowedTools mcp__room__list_entries,mcp__room__read_entry,mcp__room__upsert_entry`（2026-10-23 代码库修订：再追加本次任务的插件函数，每个写成 `mcp__room__<name>`。没有插件函数时仍是这三项）
- `--disallowedTools AskUserQuestion`
- `--max-turns 24`

不传：`--permission-mode`（因此也不使用 `bypassPermissions`）、`--dangerously-skip-permissions`、`--resume`、`--append-system-prompt`、`--effort`。

`config.model` 有值时追加 `--model <值>`。没有值时不传 `--model`，用 CLI 自己的默认模型。`reasoningEffort` 不传给 Claude；它继续只影响 `codex-direct`。

实现前用本机 `claude --help` 核对 `--setting-sources`、`--tools` 和 `--allowedTools` 仍存在。若某个旗标不存在，停下来改本说明，不要换成更宽的权限旗标。

prompt 是 hub 下发的 `task.prompt`，作为 stream-json 的一条 user 消息写入 stdin。不在工作目录落任何说明文件。

### 5. 工具面证明

stream-json 的第一条 `type=system, subtype=init` 必须同时满足，否则杀掉进程，任务失败，回复不算数：

- `tools` 存在，且每一项都在允许集合里。允许集合是 `mcp__room__list_entries`、`mcp__room__read_entry`、`mcp__room__upsert_entry`，再加上本次任务的插件函数 `mcp__room__<name>`（2026-10-23 代码库修订）。
- `mcp_servers` 存在，且恰好一个，名字是 `room`。

之后任何 tool 事件的名字不在这个允许集合里，同样杀掉进程并失败。工具调用次数超过 60，或墙钟超过 10 分钟，杀掉进程并失败（开发包任务见 2026-10-23 开发包修订：48 / 120 / 20 分钟）。工具调用次数按 `tool_use` 块计：一条 assistant 消息里并行的 N 个调用算 N 次，每个都以 `tool_call` 事件回传（2026-10-23 验收修订）。

init 里没有 `tools` 或 `mcp_servers` 时，视为无法证明，失败。不根据「旗标已经传了」放行。这是 Codex CLI 隔离失败之后的要求。

最终回复只取结果事件里的文本。中间文本以现有的 `progress` 事件回传。Room 工具的调用以现有的 `tool_call` 事件回传，文本里不包含 token。

### 6. 失败

- 不重试整个 Claude 进程。
- 不回退到 `codex-direct`。
- 保密与否都走同一套限制。`task.confidential` 不放宽、也不额外拒绝 Claude。
- 用户可见的错误是中文短句，包含缺的是二进制、token、旗标，还是工具面。不包含 token、run token、或 prompt 全文。

## BYOK

用户要按量付费、而不是用订阅时，打开这一档。适配器仍是 `codex-direct`。工具由 daemon 进程内调用 Room API，不经过 `nema mcp`，也不启动 `claude` / `codex`。函数列表是 3 个 Room 函数加上本次任务的插件函数（2026-10-23 代码库修订，与 6.7 相同）。

### 1. 怎么打开

- `nema config set authMode byok`，并且 `adapter` 保持 `codex-direct`。
- 未写过的配置、以及从 `codex` / `codex-cli` 迁过来的配置，都不会变成 `byok`。默认仍是 `siwc`。
- `adapter=claude-code` 时忽略 `authMode`。Claude 只用自己的 setup token，不读取 BYOK 的 key。
- 没有 key、没有 `model`、或接口失败时，任务失败。不改跑 `siwc`、`compat` 或 `claude-code`。

### 2. 钥匙和地址

- 文件：`~/.nema/byok-key`，权限 0600，一行 key，没有别的字段。与 `~/.nema/auth.json`、`~/.nema/claude-code-token` 互不覆盖。
- 写入：`nema auth byok` 从 stdin 读这一行，原子写入。拒绝跟随符号链接。空串或含换行则拒绝，且不改已有文件。
- `nema auth logout` 只删除 SIWC 的 `auth.json`，不删除 `byok-key`。换钥匙就是再跑一次 `nema auth byok`。
- 地址：配置项 `byokBaseUrl`。未设置时是 `https://api.openai.com/v1`。允许 `https://` 的任意主机，以及 `http://127.0.0.1` 和 `http://localhost`（可带端口）。其他 `http://` 拒绝保存。
- 请求：`POST {byokBaseUrl}/responses`，头是 `Authorization: Bearer <key>`，再加上现有的 `originator: nema-room` 和 `User-Agent: NemaRoom/<版本>`。不送 `ChatGPT-Account-ID`。不冒充 Codex CLI。
- 不刷新这把 key。401 失败并提示重新执行 `nema auth byok`，不重试，不改 `auth.json`。网络和 5xx 仍按 6.7 第 4 项重试 1 次。
- 读取时与写入时同样检查：文件内容（去掉末尾一个换行后）为空、或含换行 / 控制字符，任务失败并提示重新执行 `nema auth byok`，不发请求。连接失败的提示不带底层错误文本，因为 `fetch` 的错误可能含请求头里的 key（2026-10-23 验收修订）。

### 3. 模型和循环

- `config.model` 必须有值。不拉模型列表，也不代填默认模型名。缺了就失败，文案告诉用户执行 `nema config set model <名称>`。
- `reasoningEffort` 仍按 6.7 放进 Responses 请求。这点和 Claude Code 不同。
- 轮数、工具次数、时长、`store: false`、函数列表，都与 6.7 第 4、5 项相同。函数列表是 3 个 Room 函数加上本次任务的插件函数（2026-10-23 代码库修订）。
- doctor 在 `adapter=codex-direct` 且 `authMode=byok` 时，缺 key、权限不是 0600、或没设 `model`，算失败。其他模式下这三项只是说明。任何 detail 都不打印 key。

## 留给实现者

- stream-json 各事件的字段解析，只要第 5 节的判定不变。
- 杀进程时是否先发 stdin 关闭。
- doctor 文案的具体用词，只要不打印 token 或 key，且失败条件与 Claude 第 2 节、BYOK 第 3 节一致。

## 验证

- Claude：单元测试用一个假的 `claude` 脚本说 stream-json。不启动真 Claude，不读真 token。假脚本若在 init 里多报一个 `Bash`，适配器必须失败，且工作目录被删掉。启动参数的测试断言包含 `--tools ""`。一条消息内并行的多个 Room 调用要分别计数。
- BYOK：单元测试用本地假的 Responses 服务。断言 Bearer 是文件里的 key、请求打到配置的 base URL、401 不刷新、`auth.json` 字节不变、错误文本不含 key；手写进文件的、含换行的 key 不发请求，错误文本也不含它。
- 真机冒烟不在实现计划里自动跑。Claude：用户自己放入 token 后跑一轮。BYOK：用户自己放入 key 和 model 后跑同一轮。两轮都确认 doctor 不打印凭证。

Claude Code 的实现计划是 `docs/superpowers/plans/2026-10-23-claude-code-runtime.md`，不包含 BYOK。BYOK 的实现计划是 `docs/superpowers/plans/2026-10-23-byok.md`。
