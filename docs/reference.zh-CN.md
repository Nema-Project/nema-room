# Nema Room 技术参考（中文）

安装入口为 `node scripts/setup.mjs --lang zh`，适用于 Windows、macOS、Linux。下文的 `0600` / `0700` 为 POSIX 权限表述；Windows 凭证使用私有 ACL，允许当前用户、SYSTEM 和管理员，不以 Node 返回的模拟 POSIX mode 判断安全性。

安装、模型配置、平台限制与数据备份见 [中文 README](../README.zh.md)、[English](../README.en.md)、[日本語](../README.ja.md)。本文保留进阶功能、格式约束和 API 实现说明。

`nema` 是本仓库里的独立 npm 包。第一次发布之前它还不在 npm 上，步骤见 [scripts/npm/RELEASE.md](../scripts/npm/RELEASE.md)。发布之后，在 Node.js ≥ 22 上按正在运行的 hub 版本安装：`npx nema@<hub 版本>` 或 `npm i -g nema@<hub 版本>`。Compose 用 `curl http://127.0.0.1:4400/api/version` 查看版本；桌面版在侧边栏显示，回环地址提供 `GET /_nema/version`。`nema daemon` 的 `--hub` 默认是 `http://127.0.0.1:4400`，token 文件是 `$NEMA_DATA_DIR` 或 `~/.nema/data` 下的 `daemon-token`（hub 启动时写入；Compose 把该目录挂到容器 `/data`）。开发本仓库时仍可在源码检出里构建并链接本地 CLI。

## 知识依据与时效

每条知识有一个依据：`stated` 是用户说过的，`decided` 是用户决定的，`inferred` 是 Agent 推断的。逐字摘录（`quotes`）对团队可见。

来源超过 90 天没有确认，会标成可能过时；其他类型不会。任务中断后最多重试 3 次，第四次中断就失败，并在聊天里留下一条系统消息。崩溃留下的未提交条目，会变成作者为 `system` 的 recover 提交。

## Code repositories and plugins

在 workspace 设置里绑定仓库。daemon 在线时会检查这条路径并建立索引。Graphify 从安装包的 `tools/graphify/` 读取（Windows 为 `graphify.exe`）。未注入路径时，先认 `NEMA_GRAPHIFY_BIN`，否则用 `NEMA_PAYLOAD_ROOT` 或 Node 可执行文件旁边的同一相对路径。不从 PATH 查找，运行时也不下载。`desktop:stage` 会按锁定的 CPython 3.11.17 和 graphifyy 0.9.95 放入这份文件，启动器只用相对路径。打包的解释器是 `python/bin/python3.11`。Tree-sitter 语法保留 JavaScript、TypeScript、TSX、Python、Go、Rust、Java、C、C++、C#、Ruby、PHP、Swift、Kotlin、Bash 和 JSON。这个锁定版本没有 YAML、TOML、HTML、CSS、Markdown 的语法包。缺语法时跳过该文件并警告，提取仍会结束。缺失时 doctor 和插件页显示 `随包的 Graphify 运行环境缺失`。插件页那句写成「可在此修复」，页面上只有这句说明，没有下载或修复操作。

Nema 读的是 `origin/<main>`，不是你当前检出的文件。daemon 不按时钟 fetch。绑定仓库时建一次索引。一次任务第一次调用代码函数时，才对这个仓库执行 `git fetch`，不改动工作区，也不动本地分支。同一次任务里之后的调用沿用这一次的结果。编码 Agent 的钩子仍可通过 `repo.tick` 立刻检查这一个仓库。空闲时不拉取。

graphify 不直接扫检出目录。它在一份私有快照上工作，目录是 `<nema home>/ws/<workspace id>/graphify/<repo id>`。Web / Compose 的 home 是 `~/.nema`，桌面应用是 `~/.nema/desktop`。

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

**30 分钟兜底。** 主分支相对上次记下的提交发生变化时，才会留下一条移动记录。这发生在绑定之后的刷新里：任务第一次读代码，或钩子触发 `repo.tick`。空闲时不去 fetch，也就没有新记录。hub 每 5 分钟查看已经记下、并且超过 30 分钟还没处理的移动。如果这段范围里有提交没有任何上报覆盖，hub 排一个系统任务，列出这些提交，让 Agent 用 `code__changes` / `code__read` 判断它们对应哪些需求。

**推断出来的要你确认。** 仅凭代码推断出的关联，只会标成 `reported`，并注明是推断的。Agent 不能把它设成 `verified`，要你在界面上确认后才会变成 verified。

## Work packages

开发包把你选好的需求变成「一份 spec + 一份 plan」，交给编码 Agent 去做，再用上报推进状态直到完成。

**生成。** 在知识面板里选一条或几条 `active` 的需求，点「生成开发包」（要先绑定代码仓库，并开着 `superpowers` 插件）。hub 新建一条 `workpackage` 条目（编号 `W-n`，存成知识库里的 `W-n.md`、`W-n.spec.md`、`W-n.plan.md`），并排一个系统任务，让 Agent 写 spec 和 plan。这类任务的上限比普通任务大：48 次模型调用、120 次工具调用、20 分钟。写的时候 Agent 用 `workpackage__*` 函数，规则文本在 `vendor/superpowers-rules/`。

**grill 步骤。** 写 spec 之前先做就绪检查：Agent 读相关需求、决策和待确认内容，遇到会影响实现的不确定点，就建 `question` 条目，并用 `workpackage__block` 把开发包卡在最重要的那个问题上，不写 spec。每条仍待确认的追问下面都有回答框，发出去的消息会写明是在回答哪一条。Agent 把它写成决策或需求，并关闭对应的问题。这个问题挡住开发包时，生成会自动重跑一次。`grill-me` 是内置插件，在 workspace 设置里可以调：严格程度（严格 / 宽松，宽松时只有决策互相冲突才停下来），以及额外规则（最多 2000 个字符）。关掉 grill-me 后不再做就绪检查，不确定点写进 spec；但整理时「拿不准就建 question」这条规则始终保留。

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

## GitHub

GitHub 插件让 Agent 查看已绑定仓库在 GitHub 上的 issue、pull request、标签、Actions 运行和 Project，并在你允许时修改它们。调用内容会离开本机，所以每个 workspace 默认关闭，机密 workspace 也一样。在「代码与插件」里手动打开。

**本机 `gh`。** 默认路径是你已经登录的 `gh`，不是 `github-mcp-server`。先在终端执行一次 `gh auth login`。Nema 不要求、也不读取 GitHub 令牌。`nema auth github` 和 `~/.nema/github-token` 还在，默认用不到。`nema doctor` 仍会打印 `github-mcp-server` 和令牌两行；这两行只是提示，缺了也不算失败，不必为此安装。`plugins.status` 会返回本机 `gh` 是否可用、是否已登录 github.com，但插件页和工作区设置都不显示这一行。要确认登录，在终端看 `gh auth status`。

**写入另开一档。** 插件打开后，读取函数可用。`github__gh_write` 还要再打开「允许 agent 修改 GitHub」。用读函数执行写命令会被拒绝。

**只能碰到绑定仓库。** `--repo` 必须是本 workspace 已绑定仓库的 github.com 远端（`origin`，不区分大小写）。`https://github.com/o/r.git`、`git@github.com:o/r.git`、`ssh://git@github.com/o/r` 都算 `o/r`。Project 命令的 `--owner` 必须是这些仓库的所有者。`GH_HOST` 固定为 github.com。不是 github.com 的远端（GitLab、自建）在该仓库下显示「没有 GitHub 远端」，也不会交给 Agent。

**命令是一张固定表。** Agent 没有 shell。`github__gh_read` 和 `github__gh_write` 只接受 `packages/shared/src/ghCommand.ts` 里的子命令，而且只用长参数。读取包括 `issue list|view|status`、`pr list|view|diff|checks|status`、`label list`、`run list|view`、`project list|view|field-list|item-list`。写入包括 `issue create|comment|edit|close|reopen`、`pr comment|edit`、`label create|edit`、`project item-add|item-create|item-edit|item-archive`。没有交给 Agent 的 `gh api`，也没有文件或编辑器参数、merge、delete、auth。`project item-edit` 用全局 node id，执行前无法再把它绑回某个 owner。

另外六个读取函数还在，也由本机 `gh` 执行：`github__pull_request_read`、`github__list_pull_requests`、`github__search_pull_requests`、`github__issue_read`、`github__list_issues`、`github__search_issues`。搜索必须且只能带一个 `repo:owner/name`。

## API 与恢复

### Hub 的本机访问限制

- hub 只接受 `Host` 为 `127.0.0.1:<NEMA_HUB_PORT>` 或 `localhost:<NEMA_HUB_PORT>` 的 `/api`、`/room` 请求，其他 Host 一律 403（防 DNS rebinding）。因此请用这两个名字之一访问 hub；daemon 的 WebSocket `/daemon` 不受影响，仍靠 daemon token 认证。compose 模式下浏览器和 daemon 经由发布到 `127.0.0.1` 的端口访问容器里的 hub，`Host` 依旧是 `127.0.0.1:<端口>` / `localhost:<端口>`，所以容器内端口必须与发布端口一致。`docker-compose.yml` 把宿主机端口、容器端口和 `NEMA_HUB_PORT` 都写成 `${NEMA_HUB_PORT:-4400}`。`NEMA_WEB_PORT`（默认 3000）只改 web 的宿主机端口，容器内仍监听 3000。web 容器启动时读取 `NEMA_HUB_URL`，compose 默认把它设成 `http://127.0.0.1:${NEMA_HUB_PORT:-4400}`。源码构建（`npm run up`，合并 `docker-compose.build.yml`）使用同一组插值，改端口不用重建 web。镜像里的 `NEXT_PUBLIC_HUB_URL` 只是回退值，默认仍是 `http://127.0.0.1:4400`。
- `/api` 下的 POST / PUT / PATCH 必须带 `content-type: application/json`，否则返回 415（挡住跨站的“简单请求”）。
- 用户在界面里修改条目（`PUT /api/workspaces/:id/entries/:eid`）时，请求里的 `basis` 和 `confirmed` 会被忽略：决策写成 `decided`，其他类型写成 `stated`，并刷新确认时间。`POST /api/workspaces/:id/entries/:eid/confirm` 的 body 为 `{}`，返回确认后的条目，重新索引并发出 `knowledge.changed`；条目不存在时返回 404。界面这两条不检查当前任务的用户消息。
- 房间写入：运行中的任务 `POST /room/entries` 时 `basis` 仍必填。新建或更新把条目写成 `stated` / `decided`（标题、正文、状态或 basis 有变化），以及把任一类型从失效状态（`superseded`、`dropped`、`resolved`）改回 `active`，都必须在 `sourceMessages` 里带上**当前任务**的用户消息。否则 409，正文为 `写入 stated 或 decided，或把已失效条目恢复为 active，需要引用当前任务的用户消息。`，并带 `code` `user_basis_evidence`。只引用另一条用户消息，或 agent / system / report 消息，都不够；上报任务本身也不是用户消息。`inferred` 的新建和修改不要求这条，但改写 active 决策的原 409 文案不变。只改 `related`、且标题、正文、状态、basis 都不变时，不要求重新引用。检查和 Git 写入在同一把知识库锁里。同一仓库上重入这把锁会立刻失败，而不是卡住。加锁前看到的条目若在加锁时已经不在，返回 404 `entry not found: <id>`。
- 绑定本机 git 仓库：`GET/POST /api/workspaces/:id/repos`，`PATCH/DELETE /api/workspaces/:id/repos/:repoId`。POST 的 body 是 `{ path, label, mainBranch? }`。daemon 在线时会校验路径，并尝试 `git fetch` 后用 graphify 建索引（不把符号链接展开进快照）。有 origin 且 fetch 成功时快照是 `origin/<main>`；fetch 失败或没有 origin 时快照是本地分支，或仓库里已经有的远程 ref。同一个 git 仓库（相同的 git common dir，即使路径写法不同）不能绑第二次，返回 409，错误信息为 `该仓库已绑定到 workspace <名称>`。用途说明（label）需为 1–40 个字符且不含控制字符，否则 400 `用途说明需为 1–40 个字符`；同一 workspace 内不能重复，否则 409 `本 workspace 已有用途为 <label> 的仓库`。`code__changes` 的 `from`/`to` 只能是主分支 ref 本身，或主分支已包含的提交 sha，否则报 `提交 <x> 不在主分支上`。daemon 未连接、已断开或响应超时时 POST 返回 503，正文就是 `daemon 未连接`、`daemon 已断开` 或 `daemon 响应超时`。仓库路径校验失败返回 400，正文是 daemon 的中文原因。`mainBranch` 不是单个分支名（例如含 `:` 的 refspec）时 POST / PATCH 返回 400 `主分支名称无效`。保存的 origin URL 会去掉 `user:secret@`。仓库不存在时 PATCH / DELETE 返回 404 `找不到仓库：<id>`。Graphify 从安装包的 `tools/graphify/` 读取，不从 PATH 查找。测试通过 daemon 的 `graphify: { bin, timeoutMs }` 选项注入假可执行文件。daemon 不按时钟检查仓库：绑定仓库时建索引；一次任务里第一次调用代码函数时对该仓库 `git fetch` 并在提交变化时更新索引，同一次任务之后的调用不再 fetch。编码 Agent 的钩子仍可通过 `repo.tick` 立即检查一个仓库。hub 在 welcome、绑定变化和删除 workspace 时发送 `repos.sync`，条目含 `lastMainSha`（从未记录时为 null）。绑定后建索引成功时，hub 把索引用的 sha 存为 `lastMainSha`，不发 `repo.moved`。第一次看到 null 只记下当前 sha，不发 `repo.moved`；之后 sha 变了才按变更文件增量更新索引（重命名会删掉旧路径；还没有 `graphify-out/graph.json` 时整份重建），并发送 `repo.moved`。每次这样的检查都发 `repo.fetched`。fetch 失败时保留上次的 sha，索引和 `code__read` 仍用上次的 ref；没有 origin 时跟随本地分支。索引失败（例如随包运行环境缺失）时 daemon 记下错误，仍发送 `repo.moved` 并推进 sha。fetch 失败时 hub 只更新 `last_fetch_error`，`last_fetch_at` 保留上次成功的时间，设置页同时显示失败原因和上次成功时间。`repo.moved` 没发出去（socket 已关、发送失败或回调抛错）时也不推进 sha，下一次检查重试索引和消息。上一轮还没跑完时不会再开一轮。这些操作不改工作区。
- 房间插件：运行中的任务用 run token 调用 `GET /room/plugins` 和 `POST /room/plugins/:name`。GET 返回本 workspace 已开启的工具。代码函数的 POST body 必须带一个本 workspace 已绑定仓库的 `repo`（仓库 id 或标签）。函数未开启返回 403 `函数 <name> 未在本 workspace 开启`。repo 对不上返回 400 `repo 不是本 workspace 绑定的仓库：<value>`。通过这项检查后，hub 把调用转发给 daemon 的 `plugin.call`（带上解析出的仓库路径），成功返回 `{ result }`。daemon 的其它错误返回 502，正文是 daemon 的错误信息；`daemon 未连接`、`daemon 已断开`、`daemon 响应超时` 返回 503，正文就是这一句。只要通过了「函数已开启」这一关，无论后面成功还是失败，都会写一行 `plugin_calls`；没通过则不写。GitHub 函数不带这个 `repo` 字段，范围由上文的 `--repo` / `--owner` 检查。
- daemon 的 `plugin.call` 执行代码函数。`code__search`、`code__explain`、`code__path` 查图；还没有 `graphify-out/graph.json` 时先走和 `repo.index` 相同的建索引。`code__read` 读主分支上已提交的文件（可选 `startLine` / `endLine`，均为 ≥1 的整数）。`code__changes` 比较 `from` 到 `to`，省略 `to` 时用当前主分支 ref 的完整 SHA。缺参数或类型不对返回 `<函数名> 参数无效：<字段>`，未知函数返回 `未知函数 <name>`。查图的 `query`、`symbol`、`from`、`to` 以 `-` 开头时返回 `参数不能以 - 开头：<值>`。`plugins.status` 同时返回代码和 GitHub。代码侧运行随包的 `graphify --version`：成功时 `{ code: { installed: true, detail: "<版本>" } }`，运行环境不在时 `installed` 为 false，`detail` 为 `随包的 Graphify 运行环境缺失`。GitHub 侧是本机 `gh`：`{ github: { installed, loggedIn, detail } }`，不返回令牌。
- 插件设置：`GET /api/plugins` 返回插件注册表，并附带 daemon `plugins.status` 的 `installed` 和 `detail`（daemon 不在线时同样是上面的 503 / 502）。`GET /api/workspaces/:id/plugins` 和 `PATCH /api/workspaces/:id/plugins/:pluginId` 读写该 workspace 的开关和禁用函数。本地插件默认开启，机密 workspace 也一样；没有对应行时不落库。未知插件返回 404 `找不到插件：<id>`。`disabledFunctions` 里出现该插件没有的函数名时返回 400 `未知函数 <name>`。`code` 的函数只有在 workspace 至少绑定了一个仓库时才会交给模型和 `task.assign` 的 `pluginTools`。GitHub 函数要等插件打开，并且至少有一个绑定仓库带 github.com 远端。`readOnly: false` 的函数默认不提供；只有 GitHub 的 `allowWrites` 打开、且该函数没被关掉时，才提供 `github__gh_write`。`repo` 参数的说明会列出已绑定仓库，格式为 `id (label)`。

### 重启与归档

- hub 重启时会中断上一个进程遗留的 `running` 任务并作废其 run token；daemon 连接时也会中断不属于当前连接的 `running` 任务。前三次中断会重新排队，daemon 重连后重新领取执行；第四次中断则让任务失败，并在聊天里留下一条系统消息。
- hub 启动时会检查每个 workspace（含已归档）的知识仓库。未提交的条目文件各自记为一条 system 的 recover 提交；解析不了的文件、删除，以及其他路径都原样留下。
- 只有**正在运行**的任务会阻止归档 / 删除 workspace（返回 409）。删除会一并删掉排队中的任务；归档会保留排队中的任务但暂停领取，取消归档后继续；已归档的 workspace 不能再发消息（409）。


