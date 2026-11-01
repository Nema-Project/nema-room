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

桌面应用把整套服务放进一个本机程序：磁盘上的 PGlite 数据库、单实例本机核心、受保护的同源网关，以及 Electron 自带的 Node。它使用你电脑上已经装好的 Git（2.31 或更新）。在 Mac 上，从访达打开时也会找到 Homebrew 和 MacPorts 的 Git。没有 Git 或版本太旧时，启动会说明原因，并给出 https://git-scm.com/downloads。不需要 Docker 或数据库服务器。**桌面版本已发布**，提供 Windows x64 和 Apple 芯片版本：[下载](https://github.com/Nema-Project/nema-room/releases/latest)。Windows 上在安装包和便携 ZIP 里选一个。

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

**编码 Agent 的上报钩子**：`nema report install` 写入的钩子（安装包版没有把 `nema` 放进 PATH：在安装目录的 `resources\payload` 文件夹里运行 `Nema CLI.cmd report install --agent claude`，macOS 为 `Nema CLI.command`，Linux 为 `nema-cli`；写入的钩子指向 Electron 可执行文件（带 `ELECTRON_RUN_AS_NODE=1`）与 CLI 绝对路径。升级后，仍指向已删除的 `runtime/<target>/node` 的钩子会在下次由 Electron 启动核心时改写）使用用户级的 `~/.nema/report-token`，桌面应用启动时把它登记给本机核心。应用运行时，钩子会自动找到并验证它；**新装钩子后需要重启桌面应用**，令牌才会被登记。应用没有运行时，上报进入本地缓存（最多 5 MB、保留 7 天），下次上报时补发。

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

上面命令里的版本，就是所取 `docker-compose.yml` 里两个 `image:` 钉的那个版本：`grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2` 打印它，`nema-room-web:` 那条必须打印同一个值。源码检出从这棵树构建 daemon，不这样选版本。源码检出里也带 `scripts/install/public.mjs`：它解析一个已发布的版本，校验该版本的 Compose 资产、两个镜像和 npm 包都在，然后把 `NEMA_IMAGE_TAG` 和配套的 `docker-compose.yml` 一起写进目标目录；先加 `--check` 跑一遍只校验不写盘。它读的是该 Release 自己的 `docker-compose.yml` 资产，资产缺席就拒绝安装；`v0.1.6` 之前的 Release 都没有这份资产。

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

不克隆、直接拉取钉死镜像，从 tag `v0.1.4` 开始。这个 tag 包含镜像发布工作流，也是这些镜像的第一次发布（`linux/amd64`；arm64 见 [issue #50](https://github.com/Nema-Project/nema-room/issues/50)）。本仓库树里的 `docker-compose.yml` 是模板，hub 与 web 的 `image:` 用 `${NEMA_IMAGE_TAG:-latest}` 插值，树里没有可用的版本。从 `v0.1.6` 起，每个 Release 都附上一份渲染好的 `docker-compose.yml`，hub 与 web 镜像都钉在该 Release 的版本上。它是该 Release 的固定名资产，所以当前版本始终在 [`releases/latest/download/docker-compose.yml`](https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml)；安装时把它的版本锁进本地 `.env` 的 `NEMA_IMAGE_TAG`。不克隆的安装步骤：

```sh
# 1. fetch the compose asset. With no NEMA_IMAGE_TAG in .env this is the
#    current supported release; an existing lock keeps its own version
#    (0.1.4 and 0.1.5 have no release asset, so their tag file is used).
NEMA_FETCHED= NEMA_LOCKED= NEMA_UP= NEMA_INSTALLED=
NEMA_PIN=$(sed -n 's/^NEMA_IMAGE_TAG=//p' .env 2>/dev/null | tail -1)
NEMA_URL=https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml
test -n "$NEMA_PIN" \
  && NEMA_URL=https://github.com/Nema-Project/nema-room/releases/download/v$NEMA_PIN/docker-compose.yml
{ curl -fsSL -o docker-compose.yml.download "$NEMA_URL" \
  || { test -n "$NEMA_PIN" && curl -fsSL -o docker-compose.yml.download \
    "https://raw.githubusercontent.com/Nema-Project/nema-room/v$NEMA_PIN/docker-compose.yml"; }; } \
  && mv docker-compose.yml.download docker-compose.yml && NEMA_FETCHED=1

# 2. read the one version both images are pinned to; hub and web must agree
NEMA_VERSION=$(grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2)
WEB_VERSION=$(grep -o 'nema-room-web:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2)
test -n "$NEMA_FETCHED" && test -n "$NEMA_VERSION" && test "$NEMA_VERSION" = "$WEB_VERSION" \
  && echo "$NEMA_VERSION"

# 3. lock it in a local .env; an existing NEMA_IMAGE_TAG stays as it is,
#    and the last assignment, the one Compose uses, must equal that version
test -n "$NEMA_FETCHED" && test -n "$NEMA_VERSION" && test "$NEMA_VERSION" = "$WEB_VERSION" \
  && { test -n "$NEMA_PIN" || printf '\nNEMA_IMAGE_TAG=%s\n' "$NEMA_VERSION" >> .env; } \
  && test "$(sed -n 's/^NEMA_IMAGE_TAG=//p' .env | tail -1)" = "$NEMA_VERSION" \
  && NEMA_LOCKED=$NEMA_VERSION && echo "locked $NEMA_LOCKED"

# 4. start the stack; each later step runs only if the one before succeeded.
#    If .env sets NEMA_HUB_PORT or NEMA_DATA_HOST_DIR, export the same values first.
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"   # Linux and macOS only
NEMA_DIR=${NEMA_DATA_HOST_DIR:-$HOME/.nema/data}
test -n "$NEMA_LOCKED" && mkdir -p -m 700 "$NEMA_DIR" && test -w "$NEMA_DIR" \
  && NEMA_IMAGE_TAG=$NEMA_LOCKED docker compose up -d --wait && NEMA_UP=1

# 5. install the host daemon at the locked version
test -n "$NEMA_UP" && npm i -g "@nema-project/nema@$NEMA_LOCKED" && NEMA_INSTALLED=1

# 6. start the host daemon and keep it running; Compose does not run it.
#    It reads the daemon-token the hub wrote in the data directory.
test -n "$NEMA_INSTALLED" \
  && NEMA_DATA_DIR=$NEMA_DIR nema daemon --hub "http://127.0.0.1:${NEMA_HUB_PORT:-4400}"
```

第 1 步读取 `.env` 里最后一条 `NEMA_IMAGE_TAG`，也就是 Compose 实际使用的那条。没有锁时，它从 `releases/latest/download/` 取当前版本；已有锁时沿用它，改从 `releases/download/v<locked>/docker-compose.yml` 取该版本的资产。`0.1.4` 和 `0.1.5` 没有发布资产，那次下载 404 之后，它改取该 tag 自己的文件 `raw.githubusercontent.com/Nema-Project/nema-room/v<locked>/docker-compose.yml`，这份文件把双镜像钉在那个版本上。latest 会随每次发布变化，带版本的地址在该 Release 存在期间不变。第 2 步只在 hub 和 web 钉在同一个版本上时打印该版本；第 3 步只在这个版本也是实际生效的锁时打印 `locked <版本>`。任何一步没打印就停下。后面每一步只在前一步成功后才执行，所以下载、检查、启动或安装任何一步失败，后面都会停下，不会拿旧文件或旧版 `nema` 接着跑。第 4 步先用你自己的用户建好数据目录（安装向导也这样做）并确认可写；它把锁定的版本显式传给 Compose，shell 里 export 的 `NEMA_IMAGE_TAG` 无法覆盖；`--wait` 要等服务健康才返回，那时 hub 已经为第 6 步写好 `daemon-token`。第 1、3 步只认 `NEMA_IMAGE_TAG=<版本>` 这种纯文本行，`.env` 是手改过的（带引号、注释或 CRLF）时会停下。这种情况，或者同一目录可能有两次安装同时进行时，请在源码检出里用 `scripts/install/public.mjs`：它按 Compose 的方式读取这个值，并在锁文件保护下把 `.env` 和 `docker-compose.yml` 一起写入。v0.1.6 的资产开头仍是仓库模板的注释，说它是模板、不是可安装的版本；这条注释已经过时，以两行钉住版本的 `image:` 为准，v0.1.6 之后的 Release 开头会写明自己的版本。agent 任务需要第 6 步的 daemon 一直在跑。Release 刚发布时，镜像或 npm 包可能还在发布中；第 4 步拉不到镜像或第 5 步找不到该版本时，请稍等后重跑这些步骤，或在源码检出里先跑 `node scripts/install/public.mjs --check`，它在安装前校验 Compose 资产、两个镜像和 npm 包都在。`-L` 不能省，发布页下载地址会跳转。Windows 上的 Docker Desktop 不需要第 4 步的 export。

**升级到更新的次版本要显式做。** 依赖写成指向较旧次版本的 caret 范围时，`npm update` 不会解析到更新的次版本，`npx`/`npm i -g` 不带版本也会停在较旧的次版本。npm 装的 daemon 要显式装：`npm i -g @nema-project/nema@<版本>`。Compose 侧把 `.env` 里的 `NEMA_IMAGE_TAG` 改成 `<版本>`，并按第 1 步改取 `releases/download/v<版本>/docker-compose.yml`（不再是 `latest` 资产），再按第 4 步启动；hub、web 和宿主机 daemon 必须同一版本。不会自动升级，切换之前旧版本照常可用。

宿主机端口跟随 `NEMA_HUB_PORT`（默认 4400，容器监听同一端口）和 `NEMA_WEB_PORT`（默认 3000，容器内仍监听 3000）。发布的 web 镜像在启动时读取 `NEMA_HUB_URL`。compose 默认把它设为 `http://127.0.0.1:$NEMA_HUB_PORT`，所以改端口不用重建镜像。

公开安装请使用你所装 Release 的 Compose 资产，并安装同版 daemon，版本就是该文件里两个镜像钉住的版本。main 可能领先于已发布产物；开发请用 `npm run up` 从源码构建。产物发布不代替真机或功能验收。

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

<a id="accounts"></a>

### 多个账户与自动路由

同一种运行方式可以配多个账户，例如两把不同的 API 密钥，或一个 ChatGPT 订阅加一个 OpenRouter 密钥。每个账户是「一个凭据 + 一个服务地址 + 一个默认模型」。账户在桌面应用的**应用设置 → 模型**页底部的**账户**里管理；Web / Compose 页面没有这块设置。

- **存放位置**：账户列表以及工作区、thread 上的选择存在 Nema 主目录的 `accounts.json`（单条消息的选择只记在那次任务上，不写进这个文件），凭据存在 `secrets/accounts/<账户 id>/`（桌面应用的主目录是 `~/.nema/desktop`）。权限与其他凭据相同：macOS/Linux 上是 `0600`，Windows 上是私有 ACL。账户和凭据都不进数据库，也不会发给 hub。「现有 Codex 登录」类型的账户不保存凭据，只读取 `~/.codex/auth.json`，Nema 不会修改它。
- **只有一个账户时**：列表里只有一行**当前设置**，就是原来的模型设置，界面上不出现账户选择器。第一次新建或修改账户时，原来的单个凭据会移进那个账户的目录。
- **删除**：账户仍被某个工作区或 thread 选着时不能删除，先把那些选择改掉。最后一个启用的账户不能删除，也不能停用。删除会删掉这个账户的凭据目录；「现有 Codex 登录」账户没有凭据目录，`~/.codex` 不受影响。

**选哪个账户**：输入框、thread 标题栏和工作区设置各有一个账户选择器。优先级是：本条消息 > thread > 工作区 > 全局默认。全局默认是当前运行方式下、列表里排在最前且已启用的账户。消息和 thread 的空选项是**跟随 workspace**；工作区的空选项是**全局默认**。点名的账户即使已停用也照样使用，停用只是不再作为默认和自动选择的候选。点名的账户不存在、属于另一种运行方式、没有可用的凭据或没有可用的模型时，任务在发出请求前就失败并说明原因，不会改用默认账户。`accounts.json` 读不了（内容损坏、权限过宽或是符号链接）时也一样：任务失败，不会退回旧的单个凭据。回复下方会写明这次用了哪个账户、哪个模型，以及为什么选它。

**自动路由**默认关闭。在账户设置里打开**自动路由**后，工作区、thread 和单条消息的选择器里会多出**自动**。打开开关本身不会改变任何已有选择。选了「自动」的任务，开始时按以下顺序选账户：你排的顺序 → 成本档位（省 → 标准 → 强）。之后：

- **会换账户的情况**：首选账户被限流（429）、额度用尽、提供商返回 5xx，或提供商明确报上下文超长。这时改用下一个候选，切换会写进任务进度，回复下方也会列出试过哪些账户、为什么没用上。被限流的账户 1 分钟内不再被自动选中，5xx 的 30 秒；额度用尽的到提供商给出的额度重置时间为止，没给就是 15 分钟。限流时目前不读取 HTTP `Retry-After`。换账户之后，上一个账户产生的推理内容不再发给模型。
- **不会换账户的情况**：认证失败、提供商的内容策略拒绝、请求本身有错、回答已经开始输出，以及原因不明的失败（例如重试一次后仍连不上、没有状态码）。换账户会掩盖凭据问题，或者绕过提供商的策略。
- **只有 Nema 直连的账户（ChatGPT 订阅、现有 Codex 登录、API 密钥）会在运行中切换。** Claude Code 账户只在任务开始时选一次，运行中不换。
- **成本档位**只影响排序。Nema 不知道真实价格，也不做预算控制。
- **带图片或 PDF 的任务**：只有能处理这类文件的账户才会被自动选中。判断顺序是：账户里对该模型的声明 → 账户设置里的**声明的能力** → 运行方式本身是否支持（Claude Code 能否收 PDF 未确认，按未声明处理）。设置页上「未声明」和「不支持」分开显示。没有合适账户时任务失败，不会改用一个可能不支持这类文件的账户。手动点名的账户不做这项检查。

**回退到 0.2.0**：旧版本不读 `accounts.json`，只按 `config.json` 运行，看不到其他账户。如果原来的凭据已经移进账户目录，旧版本会显示未登录，需要在旧版本里重新登录或重新保存密钥。

真实账户上的切换（真实限流、额度用尽）还没有验收记录。现有证据是假提供商上的自动化测试。

<a id="attachments"></a>

### 各运行方式的附件支持

图片和 PDF 按提供商自己的原生格式发送（Responses API 的 `input_image` / `input_file`，Claude 的 `image` 块），Nema 不转换，也不改走别的格式。提供商或模型读不读、怎么读，由提供商决定。文本文件一律作为文字放进消息。

| 运行方式 | 图片 | PDF | 文本文件 | 依据 |
| --- | --- | --- | --- | --- |
| Claude Code | 原生 | 发送前拒绝：尚未确认 Claude Code 会把 PDF 块交给模型 | 转成文字 | 文档：图片按官方 stream-json 示例。未实测 |
| ChatGPT 登录（`siwc`） | 原生 | 原生 | 转成文字 | 文档：OpenAI Responses API。未实测 |
| BYOK，默认地址 `https://api.openai.com/v1` | 原生 | 原生 | 转成文字 | 文档：同上。未实测 |
| BYOK，其他 `byokBaseUrl`（OpenRouter、自建服务等） | 原生 | 原生 | 转成文字 | 取决于提供商。实测（2026-10-30，OpenRouter `:free` 模型）：视觉模型读到了图片；纯文字模型收到图片时 OpenRouter 返回 404，Nema 如实报错。PDF 未实测 |
| Codex 登录兼容（`compat`） | 原生 | 原生 | 转成文字 | 非公开后端，没有文档。未实测 |

**提供商拒绝时**：如果提供商返回 4xx、内容指向这个文件，任务失败，提示「你的提供商或模型拒绝了这份 PDF」（或「这张图片」），附上提供商的原文。Nema 不重试，不降级，也不把 PDF 转成文字。提供商指出是哪一块内容时，只列出那个文件；有多个附件而提供商没有指出时，会说明「提供商没有指出是哪一个」。其他错误照提供商的原话显示。带图片或 PDF 的请求遇到 5xx 或连接中断时也不自动重试，因为提供商可能已经处理过这份文件并计费。不过开启自动路由时，回答文字到达之前的 5xx 仍可能让任务换到另一个账户，这份文件会再发给那个账户一次。

**风险**：有些兼容服务不认识文件块时不报错，而是悄悄丢掉。这时模型照常回答，但其实没读到文件，Nema 无从察觉。对结果要紧时，先用一份含有只在文件里出现的词的小文件试一下。

**费用**：有的提供商会在服务端解析 PDF，这是提供商自己的行为，Nema 不干预。例如 OpenRouter：模型不能原生读文件时，默认用付费的 OCR 引擎解析，BYOK 也照收；引擎和价格见 [OpenRouter PDF Inputs](https://openrouter.ai/docs/features/multimodal/pdfs)。

**需要第三方 PDF 解析时**，可以自行安装相关的 MCP 服务或 Skills。

真实模型的逐次记录见[验收记录](reviews/2026-10-30-attachments-model-acceptance.md)。

- **类型**按文件内容判断，扩展名必须与内容一致：PNG、JPEG、WebP、GIF、PDF，以及严格 UTF-8、不含 NUL 的文本。文本文件还要求没有扩展名或扩展名是以下之一：txt, md, markdown, log, csv, tsv, json, jsonl, yaml, yml, toml, ini, xml, html, css, js, mjs, cjs, ts, tsx, jsx, py, rb, go, rs, java, kt, swift, c, h, cc, cpp, hpp, cs, php, sh, bash, zsh, sql, diff, patch。扩展名和内容冲突的拒收；SVG、HEIC、Office 文档、压缩包、音频、视频也拒收。
- **上限**：图片 10 MB，PDF 20 MB，文本文件 512 KB。一次任务最多 8 个、合计 32 MB，本条消息、它引用的消息和 thread 的第一条消息一起算。所有附件合计受 `NEMA_ATTACHMENTS_MAX_BYTES` 限制（默认 2 GB），上传后数据盘剩余会不足 1 GB 时拒收。选了但没发出的文件 24 小时后清除。
- **元数据**：图片和 PDF 按原始字节发送，文件里自带的元数据也会一起发给提供商，例如照片 EXIF 里的拍摄位置、PDF 的作者信息。不想发出去的话，先自行去掉再上传。
- **模型被告知的内容**：附件是数据；从附件读出的内容是模型的推断，不是你说过或决定过的事；它解读里的引文只能摘自消息文字。
- **删除**附件（在卡片上点删除并确认）会立刻删掉文件，消息里保留删除记录：名称、类型、大小、sha256 和删除时间。磁盘上丢失的文件显示为「附件文件已丢失」。

<a id="workflow"></a>

## 从讨论到交付

1. **讨论**：发送记录，在知识面板检查、确认、修正或撤回 Agent 的理解。可以引用任意一条消息，修改自己的消息（旧内容会保留，Agent 会按新内容重新整理），或按关键词搜索这个工作区。输入 `@` 打开提及菜单：按顺序是知识条目、已经发送过的文件、话题。选中一项会把可读的写法插进正文——条目是 `[D-12]`，文件是 `附件：截图 1.png`，话题是 `[话题：标题]`——并在输入框上方出现一个 chip；点它的 × 会连同正文里的那段一起删掉，手动删掉正文里那段时 chip 也会消失。`@D-12` 这样直接打出条目 id 时，这一条排在最前。`@` 只在行首、空白之后或 `「『（` 和 `，。、：` 之后打开，`a@b` 和代码块里不打开；`/` 菜单的规则不变，两个菜单不会同时出现。发送时被提及的条目正文会随消息交给 Agent（每条最多 4 KiB、合计 16 KiB，超出的只给 id 让它自己读），被提及的文件和本条消息自己的附件一样随任务发送（仍受每任务 8 个、32 MB 的限制），话题只给标题和开头一段。每条消息最多 20 个提及；提及只是你指定的上下文，不会改变条目的状态。保存编辑后，如果正文改动让提及失效，会显示一行「已移除 N 个失效的提及」，保存不会被拦住。输入 `/` 打开命令菜单。图的类型直接列在里面，例如 `/diagram:sequence`，继续打字会收窄列表。输入 `/thread` 可开始新的长讨论；当你要求比较方案或权衡利弊且尚未决定时，Agent 会先把当前对话移到 thread 里讨论。thread 在独立窗口中打开，侧栏未读徽标会带你跳到下一个待处理 thread。Agent 像 copilot 同事一样交流：memo 检查、闲聊、疑问句式的想法和询问优缺点只回答、不写入知识；把内容留在讨论或 thread 里也是不写入。主聊与 thread 使用相同的记录规则。比较方案且尚未决定时不新建 question 条目。没有明确决定时会先提问；若用户没有明确推翻已有决定，Agent 保留原决定并在当前 thread 中追问。明确推翻时，旧决定标记为已取代并记录新决定。也可以问进度，或更新已有的图。
2. **连接代码**：在设置里用系统文件夹选择器绑定本机 Git 仓库。选中后先显示远程地址和识别到的主分支，名字用文件夹名，不用手填；名字冲突时才改。对话框由本机 daemon 打开。Windows 用资源管理器式的选择器。Graphify 从安装包的 `tools/graphify/` 读取，不从 PATH 安装，也不在运行时下载。`desktop:stage` 按锁定的 CPython 3.11.18 和 graphifyy 0.9.95 放入这份文件，启动器只用相对路径。打包的解释器是 `python/bin/python3.11`。Tree-sitter 语法保留 JavaScript、TypeScript、TSX、Python、Go、Rust、Java、C、C++、C#、Ruby、PHP、Swift、Kotlin、Bash 和 JSON。这个锁定版本没有 YAML、TOML、HTML、CSS、Markdown 的语法包。缺语法时跳过该文件并警告，提取仍会结束。缺失时索引和代码搜索会报 `随包的 Graphify 运行环境缺失`，插件页显示同一句说明。那里的「修复」只会重新检查，不能补回运行环境。绑定仓库时会建一次索引。完整提取可能要几分钟。索引进度会显示在聊天里，结束后说明可以开始问代码。架构图在这次索引结束后才画，画的时候也有进度。之后 daemon 不按时钟 `git fetch`：一次任务第一次读取该仓库的代码时才拉取主分支，并读取已提交快照，不包含未提交修改。同一次任务里之后的读取沿用这一次的结果。
3. **生成开发包**：选择 active 需求，开启 `superpowers` 后生成 spec 与 plan。`grill-me` 可因信息不足创建问题并阻塞生成。在聊天里那条追问下回答后，生成自动重试。
4. **批准与交接**：人工审阅批准，再由编码 Agent 获取。编辑或重新生成会撤销批准。
5. **上报与核验**：记录 `reported`、`verified`、`mismatch`。**引用的每条上报都通过 Git 核对时，`verified` 显示为「提交已核对」，不代表测试通过、功能正确或需求验收完成；你自己确认需求后显示为「验收已确认」。** 「提交已核对」的需求可以由你确认。之后所引上报的核对变了，需求会标出需要复审，「仍确认」只清掉这个标记。你确认的开发包任务显示「任务已完成并确认」，这不是需求验收。聊天里每条上报把 agent 的声称和 hub 的核实分开显示（Git 三项、提交作者、GitHub 读取；失败的 check run 标红）。

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

进行中的工作可以先发一条进行中上报：`nema report --progress in_progress --summary "…"`（用 `--json` 时写 `"progress":"in_progress"`）。它可以没有提交，不会推进开发包任务；完成后再发 `completed` 上报（至少一个提交）。

GitHub 插件默认关闭。打开方式、`gh` 登录和写入开关见上面的桌面应用一节；Web / Compose 用的也是同一条路径。命令白名单和六个原有读取函数见技术参考。`nema auth github` 仍可把令牌写入 `~/.nema/github-token`，默认路径不读取它。

插件页（左下角设置里的「插件」）给每个扩展一个「停用」/「启用」按钮，点了立刻生效，不用重启。停用一个扩展后，它的函数不再出现在 Agent 的工具清单里，直接调用会被拒绝；这个开关是整台安装的，工作区里另有一套开关，两者都要开。内置扩展停用后只记一行覆盖，出厂定义不变。Nema 自己安装的扩展旁边有「卸载」，会把它的目录一起删掉；在 Nema 之外发现的扩展只有「移出列表」，只摘掉列表里的那条记录，原件不动。内置扩展不提供卸载，只能启停。「已安装」区会写出不可用的数量，点一下只留下这些。Skill 会标明某个运行时缺少什么，以及名称与目录不一致；`/` 菜单也写这两句。细节见技术参考的「启用、停用与卸载扩展」。

安装 Skill：在插件页顶部「安装 Skill」里贴入 GitHub 仓库、指向其中某个目录或 `SKILL.md` 的链接，或者 skills.sh 页面，点「预览」。预览会显示来源固定到的提交、GitHub 报告的许可证，以及找到的每个 Skill 和它将安装到的目录；装不了的会写明原因。点「安装」只复制这个 Skill 在该提交里的目录，下面一行显示已完成的文件数和总数，安装中可以「取消安装」。安装失败时，那一行显示原因并提供「重试安装」，按同一个提交重新安装。目前只支持公开仓库。细节见技术参考的「安装 Skill」。

Skill 的用法：Agent 先看到每个已启用 Skill 的名字和说明，需要时才读取正文（Nema 内置 Agent 用只读工具 `read_skill`；Claude Code 用它自己的 Skill 加载，需要 v2.1.309 或更新），正文里提到的资源文件也要用同样的方式按需读取。在 thread 里用过的 Skill，这个 thread 接下来的任务会先把它按当前版本载入正文，不必再读一次，总共不超过 32 KB；停用或卸载了的会跳过，主聊天不这样做。

也可以直接在聊天里说，比如「从 anthropics/skills 安装 pdf skill」。Agent 会像「预览」按钮一样把来源固定到一个提交，并在回复下方放一张卡片，写明 Skill 的名称、说明、仓库、提交、许可证和安装目录。Agent 自己装不了任何东西：只有你在卡片上点「安装」才会安装，走的是和插件页同一个安装服务，同样显示进度和「取消安装」。来源里有多个 Skill 时，Agent 会问你要哪一个。只有你自己发的消息才会出现安装卡片，系统请求和 coding agent 的上报不会。

页面分两部分。「已安装」列出现有的全部扩展：内置项、Nema 安装的 Skill（安装失败的也留在这里，显示原因和「重试安装」）以及在 Nema 之外发现的项。「发现与安装」里是「安装 Skill」，以及安装被取消的记录，可以在这里重新安装。两部分上方的「类型」（全部、Skills、MCP、插件）和搜索框同时筛选两部分；搜索匹配名称、说明、来源或 id，不区分大小写。「在这台电脑上找到」里的文件夹也按同样方式筛选（匹配名称、说明、路径或 id；它们都是 Skill，所以选 MCP 或插件时不显示）。筛选和搜索只改变页面显示，不向 hub 发请求。

仓库里的 Skill：在「代码与插件」里，每个绑定的仓库都有「信任此仓库的 Skills」开关，默认关闭。打开前会提示：仓库主分支上已提交的 `.agents/skills`、`.claude/skills` 里的说明会交给 agent，仓库的任何提交者都能改这些内容。打开后从下个任务起生效。daemon 每次任务开始前拉取主分支（同一仓库 5 分钟内最多一次），只读已提交的内容，未提交的改动不算。两个目录有同名 Skill 时用 `.agents/skills` 那个。与你自己装的 Skill 或其他仓库的 Skill 重名时，仓库的那个改叫 `<仓库名>:<名字>`。

手动调用 Skill：消息以 `/名字` 开头时，这个 Skill 的说明会放进本次任务，后面的文字作为它的参数（正文里的 `$ARGUMENTS` 会换成这些文字）。在消息开头输入 `/`，菜单在内置命令下面列出「Skills」组，按名字或说明过滤。内置命令优先：与内置命令重名的 Skill 显示为 `/skill:名字`，选中时填入这种写法；其他 Skill 用 `/名字`，也可以写 `/skill:名字`。仓库里的 Skill 在菜单里显示为 `/skill:<仓库名>:名字`，两种写法都接受。标了不让模型自动使用的 Skill 也能这样调用。写在消息中间的 `/名字` 不算调用。

「发现与安装」下的「在这台电脑上找到」列出 `~/.claude/skills`、`~/.codex/skills` 和 `~/.agents/skills` 里直接包含的 Skill 文件夹。Nema 只打开每个文件夹的 `SKILL.md`（最多 256 KiB），只使用其中的 front matter；隐藏文件夹会跳过，指向所在位置之外的链接只列出并说明，不会读取。位置存在但读不了时会直接说明；某个 `SKILL.md` 读不了时只标出那一项。「接入」把文件夹的真实路径记录为在 Nema 外发现的扩展，并直接启用。不复制任何文件，之后「从列表移除」也只删除这条记录。其他位置的文件夹可以输入路径，或用「选择…」选取，再同样接入。`SKILL.md` 没有 name 和 description、名称已被内置项或其他扩展占用，或文件夹已经接入时，会拒绝接入并在原处说明原因。

MCP 服务器在「发现与安装」里用「添加 MCP 服务器…」添加。stdio 服务器要填命令、每行一个参数，可选绝对路径的工作目录和环境变量行；HTTP 服务器要填地址（https；明文 http 只允许 127.0.0.1、::1 或 localhost），可选请求头行。每一行是 `NAME=value`、从 daemon 环境变量取值的 `NAME=env:VAR`，或使用已保存凭据的 `NAME=secret:REF`（值本身以这些前缀开头时写 `NAME=value:…`）。名字像凭据的变量或请求头（含 token、key、secret、password、auth、cookie、session 或 credential）必须写成引用，直接写值保存时会被拒绝，错误里只出现字段名，不出现值。保存后，服务器那一行显示连接状态（未连接、连接中、已连接、需要登录、连接异常）、「启动」或「停止」、「编辑」、最近一次错误、服务器自己报告的名称和版本，以及它提供的工具。每个 `secret:` 引用有一个只写的输入框：「保存」写入值并清空输入框，「清除」删除它，行里只显示「已设置」或「未设置」。运行中的服务器会用新值重启。修改命令、参数、工作目录或地址会删除已保存的凭据，凭据不会跟着换到新的目标。停用或卸载 MCP 服务器会先把它停掉；daemon 关闭时（包括收到 Ctrl+C、SIGTERM 或 SIGHUP；再按一次 Ctrl+C 立即退出）会停掉所有 MCP 服务器，之后不会自动重新启动。在 macOS / Linux 上自己启动的 `nema daemon` 如果是被强制结束或崩溃的，下一次启动的 daemon 在启动任何 MCP 服务器之前，会先尝试停掉上一个 daemon 记录为运行中的 stdio 服务器（无法核实的记录会保留到下次再处理），那一行会提示已停掉上一个 daemon 遗留的副本；需要时点「启动」重新运行。不自动启动是有意的（理由已于 2026-11-02 补记）：本版本不把 MCP 工具交给 Agent，服务器运行起来没有使用方；stdio 服务器会以你的身份、带着你的凭据执行你配置的命令，每次启动都应由你本人发起，桌面应用随登录启动时也不例外；崩溃后自动恢复还可能把导致崩溃的问题再重演一遍。等 MCP 工具交给 Agent 时会重新评估，届时考虑按服务器单独开启、默认关闭的自动启动。保存中途被打断或 `mcp.json` 在 Nema 之外被改动时，下次启动后那一行会提示配置已损坏：点「编辑」用同一个 ID 重新填写，或点「卸载」删除服务器和它的凭据。本版本不会把 MCP 工具交给 Agent。

终端里也能做同样的事：`nema mcp add <id> --name <name> --command <cmd> [--arg …] [--env NAME=…]`（HTTP 用 `--url` 和 `--header`）、`nema mcp edit`、`nema mcp list`、`nema mcp status <id>`、`nema mcp start <id>`、`nema mcp stop <id>`、`nema mcp secret set <id> <name>`（从标准输入读值）和 `nema mcp secret clear <id> <name>`。不带子命令的 `nema mcp` 仍然是 Codex 和 Claude 启动的 Room MCP 服务器。桌面应用的 hub API 需要应用内登录，所以那里请用插件页；`nema mcp secret set|clear --desktop` 直接写桌面应用的凭据文件。`nema mcp add` 会拒绝已存在的 ID，`secret set` 按输入原样保存这一行。

每个内置项都有「修复」，已经正常时显示为「重新检查」。对 graphify，它会运行随包 Graphify 的版本检查：通过时显示「已检查：可以使用。」；运行环境缺失或无法运行时，会说明情况，并提示重新安装 Nema 即可恢复。对 GitHub，它会询问 GitHub CLI（`gh`）是否已安装、是否已登录 github.com，并说明缺的是哪一项。其他内置项是应用本身的一部分，检查后确认可用。检查结果会保存，页面显示最近一次检查的结果，而不是出厂默认值。「修复」不会运行任何包管理器。

<a id="data"></a>

## 数据、隐私与已知限制

| 默认位置 | 内容 |
| --- | --- |
| PostgreSQL 的 Compose 卷 `nema-pg` | 聊天、任务、工作区设置、索引等 |
| `~/.nema/data` | daemon token、工作区知识 Git 仓库、聊天附件（`attachments/`） |
| `~/.nema` | 本机配置、模型与插件凭证、代码索引快照、上报缓存等 |
| `~/.nema/desktop` | 桌面应用的数据库、知识 Git 仓库、聊天附件（`data/attachments/`）和运行状态，与上面的 Compose 数据相互独立 |

**源码仓库的 GitHub 副本不是应用数据备份。** 备份前停止写入，保存 PostgreSQL 导出与实际数据目录，并验证恢复流程。保留数据时不要用 `docker compose down -v`，`-v` 会删除数据库卷。

- 本机存储不等于离线推理：聊天、知识和工具返回的代码会发送给模型服务商。GitHub 插件打开后，查询经本机 `gh` 发往 GitHub；写入还要在工作区单独打开。机密工作区不是离线模式或操作系统隔离边界。
- 附件随用到它的任务发给模型服务商。删除只删掉文件，无法撤回模型已经收到的内容；引用一条消息时，它的附件随引用一起发送。备份时把 `attachments/` 和数据库一起备份：只有记录没有文件的附件会显示为丢失。
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
