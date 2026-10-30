# Nema Room 使用指南

[返回 README](../README.zh.md) · [English](guide.en.md) · [简体中文](guide.zh.md) · [日本語](guide.ja.md)

桌面应用与 Web / Compose 的详细安装、配置和操作说明。产品介绍与下载入口见 README。

- [桌面应用（预览）](#desktop)
- [Web / Compose 环境要求](#requirements)
- [快速开始](#source-installation)
- [模型运行方式](#models)
- [从讨论到交付](#workflow)
- [数据、隐私与已知限制](#data)
- [开发与升级](#development)

<a id="desktop"></a>

## 桌面应用（预览）

桌面应用把整套服务放进一个本机程序：磁盘上的 PGlite 数据库、单实例本机核心、受保护的同源网关，以及随包的 Node。它使用你电脑上已经装好的 Git（2.31 或更新）。在 Mac 上，从访达打开时也会找到 Homebrew 和 MacPorts 的 Git。没有 Git 或版本太旧时，启动会说明原因，并给出 https://git-scm.com/downloads。不需要 Docker 或数据库服务器。**桌面版本已发布**，提供 Windows x64 和 Apple 芯片版本：[下载](https://github.com/Nema-Project/nema-room/releases/latest)。Windows 上在安装包和便携 ZIP 里选一个。

| 项目 | 状态 |
| --- | --- |
| Windows x64 | NSIS 安装包（`.exe`）或便携 ZIP（`.zip`）。二选一 |
| macOS | 提供 DMG，仅 Apple 芯片（arm64）。Intel Mac 不是目标 |
| Linux | 不提供桌面安装包 |
| 签名与更新 | Windows **未签名**；macOS 使用**临时签名，未经公证**。应用可以发现更新的稳定版并打开发布页。不会自动下载或安装 |
| 公开发布 | [最新发布](https://github.com/Nema-Project/nema-room/releases/latest)。Node（MIT）、Inter 与 JetBrains Mono（OFL）、Electron 的 ffmpeg（LGPL，独立库）随应用里的许可声明一起发布 |

**构建（Windows x64）**：`npm ci` 后运行 `npm run desktop:make -- --platform win32 --arch x64`，产物在 `dist/desktop-artifacts/win32-x64/`：`Nema-<版本>-win32-x64.exe`（NSIS 安装包）和 `Nema-<版本>-win32-x64.zip`（便携应用，压缩包根上是 `Nema.exe`）。构建只支持当前系统，且需要本机 C 编译器（Windows 需要 Clang，见 [scripts/desktop/README.md](../scripts/desktop/README.md)）。

**首次启动与系统提示**：只打开你自己构建或已核对过的文件。Windows 的 SmartScreen 会提示“Windows 已保护你的电脑”，点“更多信息”，再点“仍要运行”。macOS 包尚未验证；按系统惯例，未公证的应用需要在“系统设置 → 隐私与安全性”里选“仍要打开”。

**数据位置**：默认在 `~/.nema/desktop`（`db/` 数据库、`data/` 知识 Git 仓库、`instance.json` 运行状态）。它不读取 Compose 的数据库，也不使用旧的 `~/.nema/data`。

**Windows 便携 ZIP**：解压 `Nema-<版本>-win32-x64.zip` 后运行 `Nema.exe`。没有快捷方式，也没有卸载程序；删掉该文件夹即移除这份便携副本。它和 NSIS 安装使用同一个 `~/.nema/desktop`。两者同时运行时共用这个目录：后启动的那一个会连到已经在跑的核心。删掉 ZIP 目录不会卸载 NSIS，卸载 NSIS 也不会删除解压出来的文件夹或 `~/.nema/desktop`。

**窗口、托盘与浏览器模式**
- 关闭窗口只关窗口，核心继续在托盘里运行；点托盘图标可重新打开。托盘菜单的 `Quit Nema` 才会退出，并等待后台任务清理完毕。
- 也可以用浏览器访问同一个核心：安装目录 `resources\payload` 里有 `Nema Browser.cmd`（macOS 为 `Nema Browser.command`，Linux 为 `nema-browser`），它启动或复用核心，并用一次性链接在浏览器里打开。加 `--no-open` 只打印链接，加 `--quit` 请求退出。界面进程异常退出后，也可以用它继续访问。
- **开机自启动**在桌面应用的**应用设置 → 通用**。浏览器或 Compose 会话里这一项仍会显示，并说明这里改不了。

**模型与 GitHub**
- 模型在侧栏的**应用设置 → 模型**里选择，不需要终端。提供方只有一层：ChatGPT 订阅、Claude 订阅或 API 密钥。ChatGPT 订阅可选浏览器登录或本机已有的 Codex 登录；Claude 订阅填写本机 Claude Code 令牌；API 密钥填写密钥和可选的 Responses API 地址。连上之后，从该提供方返回的列表里选模型，没有手填模型 ID 的栏。列表还在加载时，下拉框写明正在加载，并且先打不开。Claude 用官方别名，不选时沿用账号默认。每个提供方的登录各自保留。同一页可以设推理强度。没有单独的 Agent 运行时开关。
- GitHub 插件默认关闭。在工作区的“代码与插件”里打开后，Agent 使用本机已登录的 `gh`（先在终端执行一次 `gh auth login`）。Nema 不要求也不保存 GitHub 令牌。读取随插件打开；修改 GitHub（创建和评论 issue、改标签、操作 Project）还要再打开同一页上的允许开关。Agent 只能访问该工作区绑定的 github.com 仓库。

**编码 Agent 的上报钩子**：`nema report install` 写入的钩子（安装包版没有把 `nema` 放进 PATH：在安装目录的 `resources\payload` 文件夹里运行 `Nema CLI.cmd report install --agent claude`，macOS 为 `Nema CLI.command`，Linux 为 `nema-cli`；写入的钩子指向随包的 Node 与 CLI 绝对路径）使用用户级的 `~/.nema/report-token`，桌面应用启动时把它登记给本机核心。应用运行时，钩子会自动找到并验证它；**新装钩子后需要重启桌面应用**，令牌才会被登记。应用没有运行时，上报进入本地缓存（最多 5 MB、保留 7 天），下次上报时补发。

**从 Web / Compose 版迁移**：目前只有库接口，没有命令行或界面入口。`exportSnapshot`（`apps/hub/src/db/export.ts`）从你指定的 PostgreSQL 连接导出，`importLegacySnapshot`（`apps/local/src/import.ts`）导入到一个**空的、未运行**的桌面数据目录。导入先在暂存目录里完整验证，失败时不改动目标；中断后用 `recoverInterruptedImport` 恢复。凭证不会被导出或导入，需要重新登录。

**升级**：桌面应用不会自动下载或安装。启动约 15 秒后，以及大约每天一次，它向 GitHub 查询更新的稳定版。托盘和应用内横幅会链到发布页。`Check for Updates` 会立刻查一次。**应用设置 → 关于**里的「自动检查更新」（`~/.nema/desktop/update-check.json` 里的 `updateCheck.enabled`）关掉定时检查。失败、草稿和预发布版本都不会提示。先用托盘的 `Quit Nema` 退出，备份 `~/.nema/desktop`，再安装新版本；启动时会自动应用数据库迁移。2026-10-27 的托管 Windows 与 macOS 运行器已通过一次性数据目录的重新打开、待应用迁移、失败回滚和备份恢复。同日维护者在 macOS 与 Windows 上分别用新安装包覆盖旧安装，workspace 数据均完整。升级前仍请先备份 `~/.nema/desktop`。

当前稳定化优先级与验收证据见[项目路线图](../ROADMAP.md)。下方历史验证记录仅适用于当时记录的提交与环境。

**验证记录（2026-10-24）**：后台工具进程的清理保证目前只在 Windows 上实现（POSIX 尚未证明）；Windows 本机全量测试为 0 失败，但有 23 个测试因条件限制被跳过（这不算 Windows 验收），POSIX 与 CI 尚未复跑。详见[验证记录](reviews/2026-10-24-desktop-validation.md)。

<a id="requirements"></a>

## Web / Compose 环境要求

宿主机 daemon 是 npm 包 `@nema-project/nema`，命令名是 `nema`（Node.js ≥ 22）。`@nema-project/nema@0.1.3` 已于 2026-10-27 发布到 npm，这次手动的第一次发布记录在 [scripts/npm/RELEASE.md](../scripts/npm/RELEASE.md)。`v0.1.4` 是受信发布者的第一次发布。安装与正在运行的 hub 相同的版本：

```sh
npx @nema-project/nema@<hub 版本> --version
npm i -g @nema-project/nema@<hub 版本>
```

上面命令里的版本，就是所取 `docker-compose.yml` 里两个 `image:` 钉的那个版本：`grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2` 打印它，`nema-room-web:` 那条必须打印同一个值。源码检出从这棵树构建 daemon，不这样选版本。源码检出里也带 `scripts/install/public.mjs`：它解析一个已发布的版本，校验该版本的 Compose 资产、两个镜像和 npm 包都在，然后把 `NEMA_IMAGE_TAG` 和配套的 `docker-compose.yml` 一起写进目标目录；先加 `--check` 跑一遍只校验不写盘。它读的是该 Release 自己的 `docker-compose.yml` 资产，资产缺席就拒绝安装——目前还没有任何已发布的 Release 带这份资产，所以在这样的版本出现之前，仍请从取到的文件里读版本。

Compose：`curl http://127.0.0.1:4400/api/version` 返回 `{"version":"..."}`。桌面版在**应用设置 → 关于**里显示版本，应用源地址提供 `GET /_nema/version`。版本不一致时，daemon 会打印 hub 的错误和 `run: npm i -g @nema-project/nema@<版本>`，然后停止，不会继续重连。

`nema daemon` 的 `--hub` 默认是 `http://127.0.0.1:4400`。token 文件是 `$NEMA_DATA_DIR` 或 `~/.nema/data` 下的 `daemon-token`（`defaultTokenFile()`）。hub 启动时若文件不存在就写入它。Compose 把容器的 `NEMA_DATA_DIR` 设为 `/data`，并把宿主机数据目录挂到那里（默认 `~/.nema/data`，或 `NEMA_DATA_HOST_DIR`），因此宿主机 daemon 与容器 hub 共用同一个 token 文件。

从本仓库运行 Web / Compose 仍使用下面的源码向导。Windows、macOS、Linux 共用这套 Node.js 安装。不要安装不带版本的 `@nema-project/nema` 并假定它与 hub 一致。

| 项目 | 要求 |
| --- | --- |
| 本机工具 | Node.js ≥ 22（含 npm）、Git |
| 容器 | Docker、Docker Compose v2 |
| 模型 | 配置下文的一种运行方式；可用性、额度与费用由服务商决定 |
| 存储 | 建议本机 SSD，不建议把项目、知识 Git 仓库或数据库放在 NAS/SMB 共享盘 |
| 平台 | Windows、macOS、Linux；Windows/macOS 使用 Docker Desktop 的 Linux 容器，Linux 可使用 Docker Engine |

本项目面向本机使用，没有面向公网的多用户认证。hub 和 web 默认只开放回环地址，不要直接暴露到公网。

<a id="source-installation"></a>

## 快速开始

在 PowerShell、Terminal 或 Linux 终端执行：

```text
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
node scripts/setup.mjs --lang zh
```

向导检查 Node/npm、Git、Docker 和 Compose，保留已有 `.env`，安装依赖、构建 CLI 并启动服务；接着引导选择模型、验证连接，最后可在当前终端启动 daemon。支持重新执行；不会自动安装系统软件、删除应用数据或覆盖已有配置文件。选择模型方式会更新对应本机模型配置。

只检查环境而不安装：`node scripts/setup.mjs --lang zh --check`。已有 npm 时也可用 `npm run setup -- --lang zh`。`--check` 会检查 Docker 是否运行，不发送模型请求。

### 手动安装（Bash）

Compose 运行 PostgreSQL、hub 和 web；**daemon 仍在本机运行**，使用本机凭证和仓库路径。daemon 不在镜像里。开发本仓库仍从当前检出构建。tag `v0.1.4` 是第一次发布镜像的版本。

```bash
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
cp .env.example .env
npm ci
npm run build -w apps/cli
mkdir -p "$HOME/.nema/data"
# 仅 Linux 和 macOS。Windows 上的 Docker Desktop 不需要这一行。
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"
npm run up
```

`npm run up` 用当前检出构建 hub 和 web。在 Linux 和 macOS 上，上面的 `export` 把容器用户设成当前主机用户，UID/GID 不是 1000 时也一样。Windows 上的 Docker Desktop 不需要这条 export。`NEMA_HUB_PORT`（默认 4400）同时是宿主机发布端口和 hub 的监听端口。`NEMA_WEB_PORT`（默认 3000）只改宿主机端口。web 容器启动时读取 `NEMA_HUB_URL`；compose 把它设为 `http://127.0.0.1:$NEMA_HUB_PORT`。

不克隆、直接拉取钉死镜像，从 tag `v0.1.4` 开始。这个 tag 包含镜像发布工作流，也是这些镜像的第一次发布（`linux/amd64`；arm64 见 [issue #50](https://github.com/Nema-Project/nema-room/issues/50)）。本仓库树里的 `docker-compose.yml` 是模板，hub 与 web 的 `image:` 用 `${NEMA_IMAGE_TAG:-latest}` 插值，树里没有可用的版本；当前发布工作流发一个版本时，也会附上一份渲染好的 `docker-compose.yml`、双镜像都钉在那个版本上，安装时把这个版本锁进本地 `.env` 的 `NEMA_IMAGE_TAG`。目前还没有任何已发布的 Release 带这份资产，所以从 tag `v0.1.5` 取 [`docker-compose.yml`](https://github.com/Nema-Project/nema-room/blob/v0.1.5/docker-compose.yml)（`curl -fsSLO https://raw.githubusercontent.com/Nema-Project/nema-room/v0.1.5/docker-compose.yml`），它把双镜像钉在 `0.1.5`。这份 tag 上的文件不是发布页附件。Linux 和 macOS 上同样导出 `NEMA_UID` 和 `NEMA_GID`。Windows 上的 Docker Desktop 不需要这条 export。然后执行 `docker compose up -d`。宿主机端口跟随 `NEMA_HUB_PORT`（默认 4400，容器监听同一端口）和 `NEMA_WEB_PORT`（默认 3000，容器内仍监听 3000）。发布的 web 镜像在启动时读取 `NEMA_HUB_URL`。compose 默认把它设为 `http://127.0.0.1:$NEMA_HUB_PORT`，所以改端口不用重建镜像。

公开安装请使用上面链接的、与你所装版本对应的 Compose 文件，并安装同版 daemon，版本就是该文件里两个镜像钉住的版本。main 可能领先于已发布产物；开发请用 `npm run up` 从源码构建。产物发布不代替真机或功能验收。

首次使用先配置模型。使用默认认证时：

```bash
node apps/cli/dist/index.js auth login
node apps/cli/dist/index.js auth probe
node apps/cli/dist/index.js doctor
node apps/cli/dist/index.js daemon
```

打开 [localhost:3000](http://localhost:3000)，创建工作区并发送讨论。daemon 需要保持运行，离线时新任务会排队。`auth probe` 会发送一次最小模型请求，消耗所选服务额度。

```bash
npm run logs   # 查看 hub / web 日志
npm run down   # 停止容器，保留数据库卷
```

在 Linux 和 macOS 上，上面的命令对任何主机用户都用 `id` 导出 `NEMA_UID` 和 `NEMA_GID`。Windows 上的 Docker Desktop 不需要这条 export。也可以把同样的值写进 `.env`。自定义目录时先手动创建，并让 `NEMA_DATA_HOST_DIR` 与 daemon 读取的目录一致。

<a id="models"></a>

## 模型运行方式

默认适配器 `codex-direct` 使用 Nema 自己的工具循环，不启动 Codex CLI。模型只有 Room 函数和本任务启用的插件函数。下面四行是界面里三个提供方保存下来的配置；界面不显示这些内部名字。

| 方式 | 配置与限制 |
| --- | --- |
| Sign in with ChatGPT（默认 `siwc`） | `auth login` 后用 `auth probe` 验证账号访问权限；不保证所有订阅或组织账号可用 |
| BYOK API key | Responses API 兼容端点，必须设置 model，按服务商规则计费 |
| Codex 兼容登录 | `config set authMode compat`；只读 `$CODEX_HOME/auth.json`，默认 `~/.codex/auth.json`，不刷新或改写。使用非公开后端接口，可能失效或违反服务条款 |
| Claude Code | `config set adapter claude-code`；需要本机 `claude`、`claude setup-token` 和 `auth claude` |

改用 BYOK 的示例：

```bash
node apps/cli/dist/index.js config set authMode byok
node apps/cli/dist/index.js config set model YOUR_MODEL
# 使用其他兼容服务时可设置：
# node apps/cli/dist/index.js config set byokBaseUrl https://your-provider.example/v1
node apps/cli/dist/index.js auth byok
```

`auth byok` 从标准输入读取一行密钥，粘贴后按回车。终端可能回显，请在私人终端操作。`auth claude` 和 `auth github` 同样读取标准输入；不要把真实密钥写进命令参数、仓库或 issue。

Claude Code 配置：

```bash
node apps/cli/dist/index.js config set adapter claude-code
claude setup-token
node apps/cli/dist/index.js auth claude
```

认证或调用失败时不会静默切换运行方式。用 `config get`、`auth status` 查看配置与登录状态，不显示令牌。

<a id="workflow"></a>

## 从讨论到交付

1. **讨论**：发送记录，在知识面板检查、确认、修正或撤回 Agent 的理解。可以引用任意一条消息，修改自己的消息（旧内容会保留，Agent 会按新内容重新整理），或按关键词搜索这个工作区。输入 `/` 打开命令菜单。图的类型直接列在里面，例如 `/diagram:sequence`，继续打字会收窄列表。输入 `/thread` 可开始新的长讨论；当你要求比较方案或权衡利弊且尚未决定时，Agent 会先把当前对话移到 thread 里讨论。thread 在独立窗口中打开，侧栏未读徽标会带你跳到下一个待处理 thread。Agent 像 copilot 同事一样交流：memo 检查、闲聊、疑问句式的想法和询问优缺点只回答、不写入知识；把内容留在讨论或 thread 里也是不写入。主聊与 thread 使用相同的记录规则。比较方案且尚未决定时不新建 question 条目。没有明确决定时会先提问；若用户没有明确推翻已有决定，Agent 保留原决定并在当前 thread 中追问。明确推翻时，旧决定标记为已取代并记录新决定。也可以问进度，或更新已有的图。
2. **连接代码**：在设置里用系统文件夹选择器绑定本机 Git 仓库。选中后先显示远程地址和识别到的主分支，名字用文件夹名，不用手填；名字冲突时才改。对话框由本机 daemon 打开。Windows 用资源管理器式的选择器。Graphify 从安装包的 `tools/graphify/` 读取，不从 PATH 安装，也不在运行时下载。`desktop:stage` 按锁定的 CPython 3.11.18 和 graphifyy 0.9.95 放入这份文件，启动器只用相对路径。打包的解释器是 `python/bin/python3.11`。Tree-sitter 语法保留 JavaScript、TypeScript、TSX、Python、Go、Rust、Java、C、C++、C#、Ruby、PHP、Swift、Kotlin、Bash 和 JSON。这个锁定版本没有 YAML、TOML、HTML、CSS、Markdown 的语法包。缺语法时跳过该文件并警告，提取仍会结束。缺失时索引和代码搜索会报 `随包的 Graphify 运行环境缺失`，插件页显示同一句说明，但没有修复按钮。绑定仓库时会建一次索引。完整提取可能要几分钟。索引进度会显示在聊天里，结束后说明可以开始问代码。架构图在这次索引结束后才画，画的时候也有进度。之后 daemon 不按时钟 `git fetch`：一次任务第一次读取该仓库的代码时才拉取主分支，并读取已提交快照，不包含未提交修改。同一次任务里之后的读取沿用这一次的结果。
3. **生成开发包**：选择 active 需求，开启 `superpowers` 后生成 spec 与 plan。`grill-me` 可因信息不足创建问题并阻塞生成。在聊天里那条追问下回答后，生成自动重试。
4. **批准与交接**：人工审阅批准，再由编码 Agent 获取。编辑或重新生成会撤销批准。
5. **上报与核验**：记录 `reported`、`verified`、`mismatch`。**verified 表示 Git 证据通过或用户确认，不代表测试通过、功能正确或需求验收完成。**

开发包当前有固定的中文格式标记，即使知识语言为英文或日文也必须保留，例如 `## 已定的做法`、`### 任务 1：`、`- 修改：`、`- 满足：`。完整约束见技术参考。

在其他仓库使用 `nema` 命令前，先在本项目根目录链接 CLI（可能需要将 npm 全局 bin 加入 PATH）：

```bash
npm link --workspace @nema/cli
```

然后在绑定的代码仓库中：

```bash
nema wp list
nema wp get W-1
nema report --entries W-1 --task 1 --summary "Implement task 1" --commits COMMIT_SHA --files src/example.ts
```

可选上报 hook：`nema report install --agent codex` 或 `--agent claude`。这会修改对应 Agent 的用户级 hook 配置并安装 `nema-report` skill；卸载用 `nema report uninstall --agent <agent>`。

GitHub 插件默认关闭。打开方式、`gh` 登录和写入开关见上面的桌面应用一节；Web / Compose 用的也是同一条路径。命令白名单和六个原有读取函数见技术参考。`nema auth github` 仍可把令牌写入 `~/.nema/github-token`，默认路径不读取它。

插件页（左下角设置里的「插件」）给每个扩展一个「停用」/「启用」按钮，点了立刻生效，不用重启。停用一个扩展后，它的函数不再出现在 Agent 的工具清单里，直接调用会被拒绝；这个开关是整台安装的，工作区里另有一套开关，两者都要开。内置扩展停用后只记一行覆盖，出厂定义不变。Nema 自己安装的扩展旁边有「卸载」，会把它的目录一起删掉；在 Nema 之外发现的扩展只有「移出列表」，只摘掉列表里的那条记录，原件不动。内置扩展不提供卸载，只能启停。细节见技术参考的「启用、停用与卸载扩展」。

安装 Skill：在插件页顶部「安装 Skill」里贴入 GitHub 仓库、指向其中某个目录或 `SKILL.md` 的链接，或者 skills.sh 页面，点「预览」。预览会显示来源固定到的提交、GitHub 报告的许可证，以及找到的每个 Skill 和它将安装到的目录；装不了的会写明原因。点「安装」只复制这个 Skill 在该提交里的目录，下面一行显示已完成的文件数和总数，安装中可以「取消安装」。安装失败时，那一行显示原因并提供「重试安装」，按同一个提交重新安装。目前只支持公开仓库。细节见技术参考的「安装 Skill」。

<a id="data"></a>

## 数据、隐私与已知限制

| 默认位置 | 内容 |
| --- | --- |
| PostgreSQL 的 Compose 卷 `nema-pg` | 聊天、任务、工作区设置、索引等 |
| `~/.nema/data` | daemon token、工作区知识 Git 仓库 |
| `~/.nema` | 本机配置、模型与插件凭证、代码索引快照、上报缓存等 |
| `~/.nema/desktop` | 桌面应用的数据库、知识 Git 仓库和运行状态，与上面的 Compose 数据相互独立 |

**源码仓库的 GitHub 副本不是应用数据备份。** 备份前停止写入，保存 PostgreSQL 导出与实际数据目录，并验证恢复流程。保留数据时不要用 `docker compose down -v`，`-v` 会删除数据库卷。

- 本机存储不等于离线推理：聊天、知识和工具返回的代码会发送给模型服务商。GitHub 插件打开后，查询经本机 `gh` 发往 GitHub；写入还要在工作区单独打开。机密工作区不是离线模式或操作系统隔离边界。
- 普通任务上限：24 次模型调用、60 次工具调用、10 分钟；开发包：48 次、120 次、20 分钟。中断最多重试 3 次。
- 启动时可恢复部分未提交知识文件，但 Git 与数据库索引尚无完整的自动一致性修复机制。
- SIWC 刷新失败可能需要重新登录；当前实现检查 ID token 声明，但不做 JWKS 签名校验。
- 凭证在 macOS/Linux 使用 `0600`，Windows 使用私有 ACL，仅允许当前用户、SYSTEM 和管理员；读取时会拒绝宽松权限或符号链接。
- Claude Code 以本机用户身份运行，工具限制不等于独立操作系统沙箱。

<a id="development"></a>

## 开发与升级

开发模式只把 PostgreSQL 放进 Docker：

```bash
npm ci
cp .env.example .env  # 已有配置时不要覆盖
npm run build -w apps/hub
npm run build -w apps/cli
npm run db:up
npm run dev
```

另开终端启动 `node apps/cli/dist/index.js daemon`。不要同时运行 Compose 的 hub/web，端口会冲突。

```bash
npm test
npm run typecheck
npm run typecheck -w apps/cli
npm run lint -w apps/web
npm run build -w apps/web
```

根目录 typecheck 不包含 web，web 构建需单独执行。升级源码检出前先备份数据，再 `git pull`、`npm ci`、重建 CLI、执行 `npm run up`，并重启 daemon。daemon 应使用 `GET /api/version` 给出的 hub 版本。版本不一致时会打印 `run: npm i -g @nema-project/nema@<版本>` 并且不再重连。源码检出仍从这棵树构建 daemon，且不用 `NEMA_IMAGE_TAG` 选版本。`@nema-project/nema@0.1.3` 自 2026-10-27 起已在 npm 上。

端口和目录见 [.env.example](../.env.example)。CLI 不自动读取根目录 `.env`：改数据目录时应在 shell 导出 `NEMA_DATA_DIR` 或传 `--token-file` 给 `daemon` / `doctor`；改 hub 端口还需传 `--hub`。Compose 读取 `NEMA_HUB_PORT`（默认 4400，宿主机和容器使用同一端口）和 `NEMA_WEB_PORT`（默认 3000，容器内仍是 3000）。web 容器启动时读取 `NEMA_HUB_URL`。Compose 默认把它设为 `http://127.0.0.1:$NEMA_HUB_PORT`。只有浏览器从别的地址访问 hub 时才设置 `NEMA_HUB_URL`。`NEXT_PUBLIC_HUB_URL` 是 `npm run dev` 读取的值，在镜像里只是烘焙进去的回退地址。

## 安全报告

安全问题请通过 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new) 提交，并先读 [安全策略](../SECURITY.md)。不要在公开 issue 或 PR 提交敏感详情。read 权限的非管理员已于 2026-10-27 到达该表单；测试报告于同日关闭且未发布。修复进入 main 并在后续桌面版本分发，不承诺维护旧发布系列。
