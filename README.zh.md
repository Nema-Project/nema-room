<div align="center">

<img src="docs/design/brand/nema-room-preview.png" width="96" height="96" alt="Nema Room" />

<h1>Nema Room</h1>

<p><strong>从讨论到代码，让上下文一路可追溯。</strong></p>

<p>
<a href="https://github.com/Nema-Project/nema-room/releases/latest"><img src="https://img.shields.io/github/v/release/Nema-Project/nema-room?style=flat-square&color=555" alt="Latest release" /></a>
<a href="https://github.com/Nema-Project/nema-room/actions/workflows/ci.yml"><img src="https://github.com/Nema-Project/nema-room/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-555?style=flat-square" alt="License: MIT" /></a>
</p>

<p>
<a href="https://github.com/Nema-Project/nema-room/releases/latest">下载</a> ·
<a href="#快速开始">快速开始</a> ·
<a href="#从讨论到交付">工作流</a> ·
<a href="#文档与反馈">文档</a> ·
<a href="ROADMAP.md">路线图</a>
</p>

<p><strong>简体中文</strong> · <a href="README.md">English</a> · <a href="README.ja.md">日本語</a></p>

</div>

Nema Room 是一个在本机运行的 AI 需求讨论室。把想法和取舍整理成有来源、有 Git 历史的需求与决策，审阅 spec 和 plan 后，交给 **Codex 或 Claude Code** 实现。

<img src="docs/screenshots/room.png" width="1100" alt="账单导出的示例讨论，右侧知识面板显示需求、决策和待确认问题。" />

<p align="center"><sub>一段示例讨论，以及可以检查、修正、追溯的知识条目。</sub></p>

<a id="功能"></a>

## 为什么用 Nema Room

- **保留决策依据。** 需求、决策、取舍和待确认问题都有来源，用户陈述与 Agent 推断明确区分。
- **让知识有版本。** 修改记录在 Git 中；修正或撤回条目时，历史与来源仍然保留。
- **带着代码讨论。** 绑定本机仓库，搜索主分支的已提交快照，生成代码图并提示可能过时的内容。
- **明确交接内容。** 生成开发包、澄清阻塞问题，人工批准 spec 和 plan 后再交给编码 Agent。
- **跟踪实现证据。** 把提交上报关联到需求，查看提交、文件变动和主分支合入情况。

中文、英文、日文界面 · 明暗主题 · 独立讨论线程

<details>
<summary>展开查看：一条需求的依据</summary>

每条需求都能回到原话，查看记录原因，区分用户陈述与 Agent 推断。

<img src="docs/screenshots/entry.png" width="1100" alt="需求条目展示用户原话、记录原因和依据类型。" />

</details>

## 快速开始

<a id="桌面应用预览"></a>

### 桌面应用

从[最新发布页](https://github.com/Nema-Project/nema-room/releases/latest)下载一个桌面版本。Windows 上两个下载里选一个。

| 平台 | 下载 |
| --- | --- |
| Windows x64 | `.exe` 安装包，或 `.zip` 便携应用 |
| macOS · Apple 芯片 | `.dmg` |
| Linux / Intel Mac | 使用下方 Web / Compose 方式 |

Windows 的 `.exe` 是 NSIS 安装包：会建立快捷方式，可以卸载，也可以覆盖升级。`.zip` 是解压即可运行的程序目录：解压后运行 `Nema.exe`，没有快捷方式，也没有卸载程序，并且避开安装器里的重复拷贝。两者都使用 `~/.nema/desktop`。选其中一个。

1. 安装 [Git 2.31 或更新版本](https://git-scm.com/downloads)，然后安装并打开 Nema Room，或解压便携 ZIP 后运行 `Nema.exe`。Node 和本地数据库已随包提供，无需 Docker。
2. 在**模型设置**中连接 ChatGPT 订阅、Claude 订阅或兼容 Responses API 的 API 密钥。可用性与费用由服务商决定。
3. 创建工作区，开始讨论；需要代码上下文时，再绑定本机仓库。

> **预览版本。** Windows 安装包和便携 ZIP 都未签名，macOS 使用临时签名且未经公证。请按发布页的校验和核对下载。应用不会自动下载或安装。它会向 GitHub 查询更新的稳定版并链到发布页；可在侧栏关掉「自动检查更新」。升级前从托盘退出并备份 `~/.nema/desktop`。2026-10-27 的托管 Windows 与 macOS 运行器已通过一次性数据目录迁移和备份恢复。同日维护者在 macOS 与 Windows 上分别用新安装包覆盖旧安装，workspace 数据均完整。首次启动与已知限制见[桌面使用指南](docs/guide.zh.md#desktop)。

<a id="首版范围与环境要求"></a>

### Web / Compose

只装 Docker 和 Docker Compose v2 时，可以不克隆仓库，用钉死版本的镜像启动 PostgreSQL、hub 和 web。daemon 不在这些镜像里，仍在本机运行。独立 npm 包可用之前，daemon 仍从源码安装。源码安装还需要 **Node.js ≥ 22** 和 **Git**，系统可以是 Windows、macOS 或 Linux。

```sh
mkdir -p "$HOME/.nema/data"
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/Nema-Project/nema-room/v0.1.3/docker-compose.yml
docker compose up -d
```

当前检出的 compose 文件把镜像钉在 `ghcr.io/nema-project/nema-room-hub:0.1.3` 和 `ghcr.io/nema-project/nema-room-web:0.1.3`。镜像要等包含镜像发布工作流的第一个 `v*` tag 进入 main 之后才存在。`v0.1.3` 早于该工作流，所以上面的拉取会失败，直到出现更新的 tag。把 URL 里的 tag 换成那个 tag。然后打开 [localhost:3000](http://localhost:3000)。发布镜像忽略 `NEMA_HUB_PORT`，hub 固定在 4400。

从检出构建仍然可用。向导会用当前源码构建镜像：

```sh
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
node scripts/setup.mjs --lang zh
```

向导检查依赖、构建 CLI、从源码启动服务，并引导配置模型。保持本机 daemon 运行。已有 `.env` 会保留。`npm run up` 是同一条源码构建，会带上 `--build`。单独的 `docker compose up` 拉取钉死镜像。发布用的 compose 文件没有构建步骤，对它执行 `docker compose up --build` 不适用。

[手动安装与配置](docs/guide.zh.md#source-installation) · 只检查环境：`node scripts/setup.mjs --lang zh --check`

CLI 包为 private，随源码安装；`npx nema` 不是独立的安装方式。

## 从讨论到交付

1. **讨论** — 发送想法和取舍，检查 Agent 的理解；用 `/thread` 开启独立讨论。
2. **连接** — 绑定本机仓库，把已提交的代码带入讨论。
3. **整理** — 开启 `superpowers`，选择 active 需求，生成包含 spec 和 plan 的开发包，回答阻塞问题。
4. **批准** — 人工审阅后交给编码 Agent 获取；编辑或重新生成会撤销批准。
5. **跟踪** — 查看提交上报，以及实现与需求之间的证据。

```text
讨论 → 需求与决策 → 已批准的 spec + plan → 编码 Agent
          ↑                                  │
          └────────── 提交上报 ──────────────┘
```

源码安装后，先在 Nema Room 根目录执行一次 `npm link --workspace @nema/cli`，再进入已绑定的代码仓库：

```sh
nema wp list
nema wp get W-1
```

通过 [CLI 上报与 hooks](docs/guide.zh.md#workflow)，把实现进度带回讨论室。桌面安装使用[随包的 CLI 启动器](docs/guide.zh.md#desktop)。

**`verified` 表示 Git 证据通过或用户确认。** 它不代表测试通过或需求验收完成。

<a id="数据隐私与已知限制"></a>

## 数据与边界

- **本机存储。** 桌面数据位于 `~/.nema/desktop`；Web / Compose 使用 PostgreSQL 和本机知识 Git 仓库。
- **模型会收到上下文。** 聊天、知识和工具读取的代码会发送给所选模型服务商。本机存储不等于离线推理。
- **按需连接 GitHub。** 插件使用本机已登录的 `gh`，仅访问绑定仓库；写入需在工作区单独开启。
- **面向本机使用。** 没有面向公网的多用户认证，暂不提供多设备同步、自动备份或团队只读访问。

详见[存储、备份与已知限制](docs/guide.zh.md#data)。源码仓库的副本不是应用数据备份。

<a id="模型运行方式"></a>
<a id="开发与升级"></a>

## 文档与反馈

[模型配置](docs/guide.zh.md#models) · [开发与升级](docs/guide.zh.md#development)

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/guide.zh.md) | 安装、模型配置、桌面操作、CLI、备份与升级 |
| [技术参考](docs/reference.zh-CN.md) | 命令、开发包格式、插件与实现细节 |
| [Agent 开发规范](AGENTS.md) | 本地与远程编码 Agent 共用的协作、实现和验证约定 |
| [参与贡献](CONTRIBUTING.md) | 开发环境、目录结构与检查命令 |
| [桌面构建指南](scripts/desktop/README.md) | 本机构建、随包工具与打包 |
| [项目路线图与验收台账](ROADMAP.md) | 稳定化优先级、TODO 与验收证据 |
| [变更记录](CHANGELOG.md) | 各版本的改动 |
| [安全策略](SECURITY.md) | 报告说明与安全边界 |

发现问题或有新想法？[提交 issue](https://github.com/Nema-Project/nema-room/issues/new/choose)，附上操作系统、安装方式和脱敏后的错误信息。欢迎使用中文、英文或日文参与贡献。

安全问题请通过 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new) 提交，并先读 [安全策略](SECURITY.md)。不要在公开 issue 或 PR 提交敏感详情。read 权限的非管理员已于 2026-10-27 到达该表单；测试报告于同日关闭且未发布。修复进入 main 并在后续桌面版本分发，不承诺维护旧发布系列。

---

[MIT](LICENSE) © Nema-Project contributors。第三方许可与来源：[archify](vendor/archify/VENDORED.md) · [superpowers rules](vendor/superpowers-rules/VENDORED.md)。
