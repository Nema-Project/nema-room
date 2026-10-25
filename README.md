# Nema Room

<img src="docs/design/brand/nema-room-preview.png" width="88" height="88" alt="Nema Room 图标" />

**把零散讨论变成可追溯的需求，再交给编码 Agent 实现。**

简体中文 · [English](README.en.md) · [日本語](README.ja.md)

> **2026-10-24 方向更新**：首版调整为可在本机独立完整使用的桌面应用；多设备同步、备份功能和团队只读查看在本地基本实现完成后再考虑。桌面迁移尚未完成，下文安装方式仍对应现有 Web / Compose 实现。见[首版范围](docs/superpowers/specs/2026-10-24-local-desktop-first.md)。

Nema Room 是在本机运行的需求讨论室。把想法、会议记录和取舍放进聊天，Agent 会整理出需求、决策、问题和来源。知识修改记录在 Git 中；准备开发时生成 spec 和 plan，再根据编码 Agent 上报的提交跟踪进度。

## 功能

- **讨论变知识**：管理需求、决策、取舍、待确认问题、来源、代码图和开发包。
- **追溯依据**：区分用户陈述、用户决定和 Agent 推断，查看原话、历史与修改原因。
- **代码上下文**：绑定本机仓库，读取主分支快照、搜索代码，生成架构图并标记可能过时的图。
- **开发交接**：先澄清问题，再生成开发包；人工批准后交给 Codex 或 Claude Code。
- **实现跟踪**：核对提交、主分支合入情况和文件变动，支持人工确认。
- **三语言界面**：中文、英文、日文；支持知识语言、插件设置和工作区归档。

## 首版范围与环境要求

当前采用**源码安装**，CLI 包标记为 private。不要把 `npx nema` 当作独立的 npm 安装方式。Windows、macOS、Linux 共用 Node.js 安装向导。

| 项目 | 要求 |
| --- | --- |
| 本机工具 | Node.js ≥ 22（含 npm）、Git |
| 容器 | Docker、Docker Compose v2 |
| 模型 | 配置下文的一种运行方式；可用性、额度与费用由服务商决定 |
| 存储 | 建议本机 SSD，不建议把项目、知识 Git 仓库或数据库放在 NAS/SMB 共享盘 |
| 平台 | Windows、macOS、Linux；Windows/macOS 使用 Docker Desktop 的 Linux 容器，Linux 可使用 Docker Engine |

本项目面向本机使用，没有面向公网的多用户认证。hub 和 web 默认只开放回环地址，不要直接暴露到公网。

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

Compose 运行 PostgreSQL、hub 和 web；**daemon 仍在本机运行**，使用本机凭证和仓库路径。

```bash
git clone https://github.com/Nema-Project/nema-room.git
cd nema-room
cp .env.example .env
npm ci
npm run build -w apps/cli
mkdir -p "$HOME/.nema/data"
docker compose up -d --build
```

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

Linux 上若 UID/GID 不是 1000，请在 `.env` 设置 `NEMA_UID` / `NEMA_GID`。自定义目录时先手动创建，并让 `NEMA_DATA_HOST_DIR` 与 daemon 读取的目录一致。

## 模型运行方式

默认适配器 `codex-direct` 使用 Nema 自己的工具循环，不启动 Codex CLI。模型只有 Room 函数和本任务启用的插件函数。

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

## 从讨论到交付

1. **讨论**：发送记录，在知识面板检查、确认或修正 Agent 的理解。
2. **连接代码**：用 `uv tool install graphifyy` 安装 graphify，在设置里绑定本机 Git 仓库。daemon 每 5 分钟检查主分支，读取已提交快照，不包含未提交修改。
3. **生成开发包**：选择 active 需求，开启 `superpowers` 后生成 spec 与 plan。`grill-me` 可因信息不足创建问题并阻塞生成；解决后自动重试。
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

GitHub 插件默认关闭。启用前需安装 `github-mcp-server`，用 `auth github` 保存令牌，再在工作区开启。仅能读取已绑定 GitHub 远端的 PR 和 issue。

## 数据、隐私与已知限制

| 默认位置 | 内容 |
| --- | --- |
| PostgreSQL 的 Compose 卷 `nema-pg` | 聊天、任务、工作区设置、索引等 |
| `~/.nema/data` | daemon token、工作区知识 Git 仓库 |
| `~/.nema` | 本机配置、模型与插件凭证、代码索引快照、上报缓存等 |

**源码仓库的 GitHub 副本不是应用数据备份。** 备份前停止写入，保存 PostgreSQL 导出与实际数据目录，并验证恢复流程。保留数据时不要用 `docker compose down -v`，`-v` 会删除数据库卷。

- 本机存储不等于离线推理：聊天、知识和工具返回的代码会发送给模型服务商；GitHub 插件还会向 GitHub 发送查询。机密工作区不是离线模式或操作系统隔离边界。
- 普通任务上限：24 次模型调用、60 次工具调用、10 分钟；开发包：48 次、120 次、20 分钟。中断最多重试 3 次。
- 启动时可恢复部分未提交知识文件，但 Git 与数据库索引尚无完整的自动一致性修复机制。
- SIWC 刷新失败可能需要重新登录；当前实现检查 ID token 声明，但不做 JWKS 签名校验。
- 凭证在 macOS/Linux 使用 `0600`，Windows 使用私有 ACL，仅允许当前用户、SYSTEM 和管理员；读取时会拒绝宽松权限或符号链接。
- Claude Code 以本机用户身份运行，工具限制不等于独立操作系统沙箱。

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

根目录 typecheck 不包含 web，web 构建需单独执行。升级前备份数据，再 `git pull`、`npm ci`、重建 CLI 和 Compose 镜像，并重启 daemon。hub 与 CLI 应保持版本一致。

端口和目录见 [.env.example](.env.example)。CLI 不自动读取根目录 `.env`：改数据目录时应在 shell 导出 `NEMA_DATA_DIR` 或传 `--token-file` 给 `daemon` / `doctor`；改 hub 端口还需传 `--hub`。`NEXT_PUBLIC_HUB_URL` 改动后需重建 web。

## 品牌与图标

项目采用 **Nema Room** 作为品牌全称，当前图标选用原始设计稿的 **01 / ROOM / N**：以开放空间与负形 N 呼应界面的黑白、暖灰和几何语言。

[品牌素材与使用说明](docs/design/brand/README.md) · [图标 PNG](docs/design/brand/nema-room-icon-01.png) · [设计规格](docs/superpowers/specs/2026-10-25-nema-room-brand-design.md) · [接入计划](docs/superpowers/plans/2026-10-25-nema-room-brand.md)

图标已接入桌面打包、窗口、托盘和浏览器 favicon。平台实机验证状态见品牌素材说明。

## 文档与反馈

- [详细命令与实现参考（中文）](docs/reference.zh-CN.md)
- [变更记录](CHANGELOG.md)
- [设计与实现计划](docs/superpowers/)
- [参与贡献](CONTRIBUTING.md)
- [安全问题](SECURITY.md)：请走私密报告，不要在公开 issue 中粘贴密钥。
- [问题反馈](https://github.com/Nema-Project/nema-room/issues/new/choose)：请使用模板，并提供系统、Node/Docker 版本、运行方式及脱敏后的错误信息。

本项目采用 [MIT License](LICENSE)。第三方组件包括 archify 与改写自 superpowers 的写作规则，许可和来源保留在 [archify](vendor/archify/VENDORED.md) 与 [superpowers-rules](vendor/superpowers-rules/VENDORED.md)；请同时保留其许可证与版权声明。
