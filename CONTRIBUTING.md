# 参与贡献

English and Japanese readers: the commands below match the READMEs. Issues and pull requests may be written in Chinese, English, or Japanese. This guide is in Chinese.

Nema Room 是在本机运行的需求讨论室，采用 [MIT License](LICENSE)。贡献前请先读 [README](README.zh.md) 和[使用指南](docs/guide.zh.md)。本地与远程编码 Agent 共用根目录的 [AGENTS.md](AGENTS.md)；Claude Code 通过 [CLAUDE.md](CLAUDE.md) 引用同一份规范。当前优先级与验收标准见 [ROADMAP.md](ROADMAP.md)。

## 开发环境

需要 Node.js 22 或更高、npm 和 Git。开发模式只用 Docker 跑 PostgreSQL。

```bash
npm ci
cp .env.example .env
npm run build -w apps/hub
npm run build -w apps/cli
npm run db:up
npm run dev
```

另开一个终端：

```bash
node apps/cli/dist/index.js daemon
```

已有 `.env` 时不要覆盖。开发模式不要同时启动 Compose 里的 hub 和 web，端口会冲突。CLI 不会自动读取根目录 `.env`。

`npm run up` 用当前检出构建 hub 和 web。Linux 和 macOS 上先执行 `export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"`，再执行 `npm run up`。Windows 上的 Docker Desktop 不需要这条 export。单独执行 `docker compose up` 会拉取钉死版本的 GHCR 镜像；在包含镜像发布工作流的第一个 tag 之前，这些镜像还不存在。

从本仓库跑 Web / Compose 仍走 `node scripts/setup.mjs`。宿主机 daemon 是 npm 包 `nema`。第一次发布之前它还不在 npm 上，daemon 从当前检出安装。发布之后按 hub 版本安装：`npx nema@<hub 版本>` 或 `npm i -g nema@<hub 版本>`。不要把不带版本的 `npx nema` 写成与任意 hub 都匹配的安装方式。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/web` | Next.js 界面。用户可见文案在 `apps/web/messages/zh.json`、`en.json`、`ja.json` |
| `apps/hub` | HTTP API、任务与知识 |
| `apps/cli` | `nema` 命令、daemon、模型适配器 |
| `apps/desktop` | Electron 窗口 |
| `apps/local` | 本机运行时、网关和会话 |
| `packages/shared` | 共享类型 |
| `packages/knowledge` | 知识 Git 仓库 |
| `scripts/setup.mjs` | 安装向导 |
| `scripts/desktop/` | 桌面打包 |
| `vendor/` | 第三方快照 |

桌面安装包已发布，支持 Windows x64 与 Apple 芯片；也可从源码构建。当前下载入口与 Web / Compose 安装方式见 README。

## 提交前

按改动范围运行对应检查。所有 pull request 都运行分类、文档检查并输出固定的 `CI gate`。仅明确允许的文档与站点资源、Pages 工作流可跳过重型检查；Agent 指令、可执行文件和混合改动跑完整套件。手动 CI 总是跑完整套件：Windows/macOS 平台检查，Ubuntu 完整测试、web 构建和 Compose。见 [.github/workflows/ci.yml](.github/workflows/ci.yml) 与 [复用套件](.github/workflows/verify.yml)。仓库 required check 需另行启用，未运行不等于通过。

```bash
npm test
npm run typecheck
npm run typecheck -w apps/cli
npm run lint -w apps/web
npm run build -w apps/web
```

根目录 `typecheck` 不包含 web，web 需要单独构建。

## 约定

- 代码、注释和提交说明使用英文。
- 用户能感知的行为写进 [CHANGELOG.md](CHANGELOG.md) 的 `## [Unreleased]`，分类用 Added、Changed、Fixed、Removed 或 Security。
- 安装、配置或使用方式有变时，同时更新 `README.md`、`README.en.md`、`README.zh.md`、`README.ja.md` 以及对应的 `docs/guide.{en,zh,ja}.md` 章节；两份英文 README 保持一致。
- 界面文案同时改三份 `apps/web/messages/*.json`。
- 开发包的中文格式标记必须保留，例如 `## 已定的做法`、`### 任务 1：`、`- 修改：`、`- 满足：`。知识语言为英文或日文时也一样。
- 不要提交 `.env`、令牌、`auth.json` 或 `~/.nema` 里的内容。示例只用 `example.com`、`YOUR_API_KEY_HERE` 这类占位符。
- `vendor/` 只在升级第三方快照时修改。archify 的替换步骤见 [技术参考](docs/reference.zh-CN.md)。保留上游许可证和 `VENDORED.md`。

## Pull request

用仓库里的 pull request 模板说明原因和验证方式。一个 pull request 只做一件事。CI 通过后再请求审阅。

## 问题与安全

缺陷、建议和使用问题请用 [issue 模板](https://github.com/Nema-Project/nema-room/issues/new/choose)。模板会要求系统、Node/Docker 版本、运行方式和脱敏后的错误信息。

凭证、路径越界或本地接口方面的问题先读 [SECURITY.md](SECURITY.md)，并通过 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new) 提交。不要在公开 issue 或 PR 提交敏感细节。read 权限的非管理员已于 2026-10-27 到达该表单；测试报告于同日关闭且未发布。修复进入 main，并在后续桌面版本中分发，不承诺维护旧发布系列。
