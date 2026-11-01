<div align="center">

<img src="docs/design/brand/nema-room-preview.png" width="96" height="96" alt="Nema Room" />

<h1>Nema Room</h1>

<p><strong>让项目保持对齐，从讨论直到交付。</strong></p>

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

Nema Room 是在本机运行的项目对齐副驾。需求、约束和取舍很容易散落，同一条需求也可能被读成不同的意思。在这里和 Agent 一起讨论：保留来源和 Git 历史，分清你的原话和 Agent 的推断，冲突在写进计划之前先澄清。批准 spec 和 plan 后交给 **Codex 或 Claude Code**，提交上报再回到讨论里。

<img src="docs/screenshots/room.png" width="1100" alt="账单导出的示例讨论，右侧知识面板显示需求、决策和待确认问题。" />

<p align="center"><sub>一段示例讨论，以及可以检查、修正、追溯的知识条目。</sub></p>

<a id="功能"></a>

## 为什么用 Nema Room

- **把理解对齐。** 把散落的记录收成同一份。新的说法和已有决策冲突时，副驾会在线程里提问，并等你来定。
- **保留决策依据。** 需求、决策、取舍和待确认问题都有来源，用户陈述与 Agent 推断明确区分。
- **让知识有版本。** 修改记录在 Git 中；修正或撤回条目时，历史与来源仍然保留。
- **带着代码讨论。** 绑定本机仓库，搜索主分支的已提交快照，生成代码图并提示可能过时的内容。
- **明确交接内容。** 生成开发包、澄清阻塞问题，人工批准 spec 和 plan 后再交给编码 Agent。
- **把证据带回讨论。** 把提交上报关联到需求，在讨论里查看这些 Git 证据。

**为什么叫 Nema？** 这个名字来自日语「根回し」（nemawashi），指在决定之前先把理解和顾虑理清。Nema Room 把这种协调留在明处：不同意见保持可见，决定则带着证据。

<sub>中文、英文、日文界面 · 明暗主题 · 独立讨论线程</sub>

<details>
<summary>展开查看：一条需求的依据</summary>

每条需求都能回到原话，查看记录原因，区分用户陈述与 Agent 推断。

<img src="docs/screenshots/entry.png" width="1100" alt="需求条目展示用户原话、记录原因和依据类型。" />

</details>

## 快速开始

<a id="桌面应用预览"></a>

### 桌面应用

| 平台 | 从[最新发布页](https://github.com/Nema-Project/nema-room/releases/latest)下载 |
| --- | --- |
| Windows x64 | `.exe` 安装包，或 `.zip` 便携应用（解压后运行 `Nema.exe`），二选一 |
| macOS · Apple 芯片 | `.dmg` |
| Linux / Intel Mac | 使用 [Web / Compose](#web--compose) |

1. 安装 [Git 2.31 或更新版本](https://git-scm.com/downloads)，然后安装并打开 Nema Room。Node 和数据库已随包提供，无需 Docker。
2. 在**应用设置 → 模型**中连接 ChatGPT 订阅、Claude 订阅或兼容 Responses API 的 API 密钥。
3. 创建工作区，开始讨论；需要代码上下文时，再绑定本机仓库。

> **预览版本。** Windows 版本未签名，macOS 使用临时签名且未经公证，请按发布页的校验和核对下载。应用会提示新版本，但不会自动安装。升级前请备份 `~/.nema/desktop`。首次启动、便携 ZIP 与已知限制见[桌面使用指南](docs/guide.zh.md#desktop)。

<a id="首版范围与环境要求"></a>

### Web / Compose

PostgreSQL、hub 和 web 运行在容器里，daemon 运行在本机。需要 **Node.js ≥ 22**、**Git**、**Docker** 和 **Docker Compose v2**，系统可以是 Windows、macOS 或 Linux。

```sh
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
# 仅 Linux 和 macOS。Windows 上的 Docker Desktop 不需要这一行。
export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"
node scripts/setup.mjs --lang zh
```

向导检查依赖、从源码构建并启动服务，再引导配置模型；已有 `.env` 会保留。保持本机 daemon 运行，然后打开 [localhost:3000](http://localhost:3000)。只检查环境：`node scripts/setup.mjs --lang zh --check`。

**不克隆安装。** 从 `v0.1.6` 起，每个 Release 都附带一份 `docker-compose.yml`，hub 与 web 镜像（`linux/amd64`）钉在该版本上。宿主机 daemon 用 `npm i -g @nema-project/nema@<版本>` 安装同一版本：hub、web 和 daemon 必须一致，且不会自动升级。分步脚本、升级方法和端口说明见[安装指南](docs/guide.zh.md#source-installation)与 [Web / Compose 环境要求](docs/guide.zh.md#requirements)。

## 从讨论到交付

交付是一条回路：提交上报会回到讨论里。

1. **讨论** — 发送想法和取舍，检查 Agent 的理解；用 `/thread` 开启独立讨论。
2. **连接** — 绑定本机仓库，把已提交的代码带入讨论。
3. **整理** — 开启 `superpowers`，选择 active 需求，生成包含 spec 和 plan 的开发包，回答阻塞问题。
4. **批准** — 人工审阅后交给编码 Agent 获取；编辑或重新生成会撤销批准。
5. **跟踪** — 把提交上报和对应的 Git 证据带回讨论。

```text
讨论 → 需求与决策 → 已批准的 spec + plan → 编码 Agent
          ↑                                  │
          └────────── 提交上报 ──────────────┘
```

在已绑定的代码仓库里，编码 Agent 用 `nema wp list` 和 `nema wp get W-1` 获取开发包。详见 [CLI 上报与 hooks](docs/guide.zh.md#workflow)；桌面安装使用[随包的 CLI 启动器](docs/guide.zh.md#desktop)。

> **`verified` 分两种。** *提交已核对*：所引提交存在、已在主分支上、改过声称的文件，不代表测试通过。*验收已确认*：你自己确认了这条需求。

<a id="数据隐私与已知限制"></a>

## 数据与边界

- **本机存储。** 桌面数据位于 `~/.nema/desktop`；Web / Compose 使用 PostgreSQL 和本机知识 Git 仓库。
- **模型会收到上下文。** 聊天、知识、附件和工具读取的代码会发送给所选模型服务商。本机存储不等于离线推理。
- **扩展由你开关。** 在插件页启用、停用、安装或移除扩展、Skill 和 MCP 服务器。已安装区会标出不可用的数量。Skill 会标明某个运行时缺少的能力，以及名称与目录不一致。本版本不会把 MCP 工具交给 Agent。
- **按需连接 GitHub。** 插件使用本机已登录的 `gh`，仅访问绑定仓库；写入需在工作区单独开启。
- **面向本机使用。** 没有面向公网的多用户认证，暂不提供多设备同步、自动备份或团队访问。

更多：[存储、备份与已知限制](docs/guide.zh.md#data) · [插件、Skill 与 MCP](docs/guide.zh.md#models) · [附件](docs/guide.zh.md#attachments)。源码仓库的副本不是应用数据备份。

<a id="模型运行方式"></a>
<a id="开发与升级"></a>

## 文档与反馈

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/guide.zh.md) | 安装、模型配置、桌面操作、CLI、备份与升级 |
| [技术参考](docs/reference.zh-CN.md) | 命令、开发包格式、插件与实现细节 |
| [参与贡献](CONTRIBUTING.md) | 开发环境、目录结构与检查命令 |
| [Agent 开发规范](AGENTS.md) | 本地与远程编码 Agent 共用的约定 |
| [桌面构建指南](scripts/desktop/README.md) | 本机构建、随包工具与打包 |
| [路线图](ROADMAP.md) | 稳定化优先级与验收证据 |
| [变更记录](CHANGELOG.md) | 各版本的改动 |

发现问题或有新想法？[提交 issue](https://github.com/Nema-Project/nema-room/issues/new/choose)，附上操作系统、安装方式和脱敏后的错误信息。欢迎使用中文、英文或日文参与贡献。

安全问题请通过 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new) 提交，并先读[安全策略](SECURITY.md)。不要在公开 issue 或 PR 提交敏感详情。

---

[MIT](LICENSE) © Nema-Project contributors。第三方许可与来源：[archify](vendor/archify/VENDORED.md) · [superpowers rules](vendor/superpowers-rules/VENDORED.md)。
