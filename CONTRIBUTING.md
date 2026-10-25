# 参与贡献

English and Japanese readers: the commands below match the READMEs. Issues and pull requests may be written in Chinese, English, or Japanese. This guide is in Chinese.

Nema Room 是在本机运行的需求讨论室，采用 [MIT License](LICENSE)。贡献前请先读 [README](README.md) 里的首版范围、模型运行方式和已知限制。

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

用户安装走 `node scripts/setup.mjs`。CLI 包是 private，不要把 `npx nema` 写成独立的 npm 安装方式。

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

桌面迁移尚未完成。安装说明仍以 README 中的 Web / Compose 路径为准。

## 提交前

按改动范围运行对应检查。推送和 pull request 上的 CI 会在 Windows、macOS、Linux 上跑类型检查和平台测试，并在 Ubuntu 上跑完整测试、web 构建和 Compose。

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
- 安装、配置或使用方式有变时，同时更新 `README.md`、`README.en.md`、`README.ja.md`。
- 界面文案同时改三份 `apps/web/messages/*.json`。
- 开发包的中文格式标记必须保留，例如 `## 已定的做法`、`### 任务 1：`、`- 修改：`、`- 满足：`。知识语言为英文或日文时也一样。
- 不要提交 `.env`、令牌、`auth.json` 或 `~/.nema` 里的内容。示例只用 `example.com`、`YOUR_API_KEY_HERE` 这类占位符。
- `vendor/` 只在升级第三方快照时修改。archify 的替换步骤见 [技术参考](docs/reference.zh-CN.md)。保留上游许可证和 `VENDORED.md`。

## Pull request

用仓库里的 pull request 模板说明原因和验证方式。一个 pull request 只做一件事。CI 通过后再请求审阅。

## 问题与安全

缺陷、建议和使用问题请用 [issue 模板](https://github.com/Nema-Project/nema-room/issues/new/choose)。模板会要求系统、Node/Docker 版本、运行方式和脱敏后的错误信息。

凭证、路径越界或本地接口方面的问题按 [SECURITY.md](SECURITY.md) 使用安全 issue 模板。只写影响，不要附密钥或利用步骤。
