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

`npm run up` 用当前检出构建 hub 和 web。Linux 和 macOS 上先执行 `export NEMA_UID="$(id -u)" NEMA_GID="$(id -g)"`，再执行 `npm run up`。Windows 上的 Docker Desktop 不需要这条 export。单独执行 `docker compose up` 会从 GHCR 拉取镜像；仓库树里的 `docker-compose.yml` 是模板，镜像用的是 `${NEMA_IMAGE_TAG:-latest}` 插值，不是安装入口。开发 main 请用 `npm run up` 从源码构建；公开安装请取 Release 上的 `docker-compose.yml` 资产，它由模板按该 Release 的版本渲染、双镜像都钉在那个版本上。这些镜像从 tag `v0.1.4` 起发布（`linux/amd64`；arm64 见 issue #50）。hub 的宿主机端口和容器端口都是 `NEMA_HUB_PORT`（默认 4400）。web 的宿主机端口是 `NEMA_WEB_PORT`（默认 3000），容器内仍是 3000。web 启动时读取 `NEMA_HUB_URL`，compose 默认把它设成 `http://127.0.0.1:$NEMA_HUB_PORT`。

从本仓库跑 Web / Compose 仍走 `node scripts/setup.mjs`。宿主机 daemon 是 npm 包 `@nema-project/nema`，命令名是 `nema`。`@nema-project/nema@0.1.3` 已在 2026-10-27 由维护者账号发布到 npm，这是第一次发布。`v0.1.4` 是受信发布者的第一次发布。开发本仓库时 daemon 仍从当前检出安装。已发布的 hub 按版本安装：`npx @nema-project/nema@<hub 版本>` 或 `npm i -g @nema-project/nema@<hub 版本>`，这个版本号就是所取 `docker-compose.yml` 里两个 `image:` 钉的那个版本：`grep -o 'nema-room-hub:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2` 打印它，`nema-room-web:` 那条必须打印同一个值。从 `v0.1.6` 起，Release 带固定名 `docker-compose.yml` 资产，最新版本在 `https://github.com/Nema-Project/nema-room/releases/latest/download/docker-compose.yml`（`curl` 要带 `-L`）。不克隆时按 README 的五步从该文件读出版本、写进 `.env` 的 `NEMA_IMAGE_TAG`；源码检出里的 `scripts/install/public.mjs` 会解析版本、校验 Compose 资产、两个镜像和 npm 包后，把 `NEMA_IMAGE_TAG` 和配套的 `docker-compose.yml` 一起写入。不要把不带版本的 `npx @nema-project/nema` 写成与任意 hub 都匹配的安装方式。

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
- 用户能感知的行为写成 `changelog.d/<slug>.<category>.md` 片段，不要直接改 [CHANGELOG.md](CHANGELOG.md) 的 `## [Unreleased]`。`category` 是 `added`、`changed`、`fixed`、`removed` 或 `security` 之一，对应标题 Added、Changed、Fixed、Removed、Security。
- 安装、配置或使用方式有变时，同时更新 `README.md`、`README.en.md`、`README.zh.md`、`README.ja.md` 以及对应的 `docs/guide.{en,zh,ja}.md` 章节；两份英文 README 保持一致。
- 界面文案同时改三份 `apps/web/messages/*.json`。
- 开发包的中文格式标记必须保留，例如 `## 已定的做法`、`### 任务 1：`、`- 修改：`、`- 满足：`。知识语言为英文或日文时也一样。
- 不要提交 `.env`、令牌、`auth.json` 或 `~/.nema` 里的内容。示例只用 `example.com`、`YOUR_API_KEY_HERE` 这类占位符。
- `vendor/` 只在升级第三方快照时修改。archify 的替换步骤见 [技术参考](docs/reference.zh-CN.md)。保留上游许可证和 `VENDORED.md`。

## 发布准备

功能 PR 把用户可见变更写成 `changelog.d/<slug>.<category>.md` 片段。两次发布之间以这些片段为准，不要直接改 `## [Unreleased]`。准备发布 PR 时，确认这些片段已经齐，然后在仓库根目录执行：

```bash
npm run release:stamp -- <x.y.z>
npm run release:cut -- <x.y.z>
```

`<x.y.z>` 是严格 SemVer，不带 `v`。`release:stamp` 只改 `apps/cli`、`apps/desktop`、`apps/local` 三个 `package.json` 的 `version`，以及 `package-lock.json` 里对应的三条记录，然后运行自检：`check-tag`、compose 模板的形态断言、以及把该模板按新版本渲染后的版本断言。三条 `package.json` 版本事先不一致，或 `package-lock.json` 里对应记录缺失、不是字符串、或与包版本不同，命令在写入前拒绝。自检在写入后失败时，这四个文件会恢复成执行前的内容。它不改也不生成任何 compose 文件，不 commit、不打 tag、不 publish。

仓库树的 `docker-compose.yml` 是模板，双镜像 `image:` 是 `${NEMA_IMAGE_TAG:-latest}`，发布提交里不再改该文件里的镜像 tag。Release 资产由 `node scripts/images/stamp-compose.mjs <x.y.z>` 从模板渲染；`check-images` 对模板跑形态断言、对资产跑版本断言。细节见 [scripts/npm/RELEASE.md](scripts/npm/RELEASE.md)。

`release:cut` 先把 `changelog.d` 里的片段按 Added、Changed、Fixed、Removed、Security 合并进 `[Unreleased]`（同一分类里原有条目在前，片段按文件名升序接在后面），再把合并后的条目移到 `## [<x.y.z>] - <当天日期>`，紧跟在空的 `[Unreleased]` 标题之后。日期是执行命令时的本地日历日，是截稿日，不是打 tag 的日期。之后不要因为实际发布日不同再改这个日期。合并之后 `[Unreleased]` 仍没有条目时命令拒绝，`CHANGELOG.md` 不变，片段也不删除。只有写入成功之后才删除这次合并掉的片段。

`release:cut` 与 `release:stamp` 共用仓库根目录的排他锁 `.nema-release.lock`，两个命令同时跑时后到的一方最多等五秒，然后非零退出并点名持锁进程的 pid 与开始时间；同一版本不会写出第二份小节，片段也不会被两个进程各删一次。锁不会被自动接管（看起来已退出的 pid 可能只是还没被回收的子进程）；错误里点名的进程确实不在了，就删掉 `.nema-release.lock` 重跑。写 `CHANGELOG.md` 之前，`release:cut` 把本次版本、将要写出的 changelog 的 sha256、以及每个要删片段的文件名与 sha256 记进 `.nema-release-cut.json`，所以「changelog 已写、片段没删完」中断后重跑只补齐删除并清掉该文件，不报「小节已存在」，也不重写内容；中断之后被改过的片段会留着给下一次发布。journal 属于另一个版本时命令拒绝并点名应先跑的命令。这两个文件都在 `.gitignore` 里。

然后写 ROADMAP 记录。tag 仍由维护者在 main 的 CI 已成功的 SHA 上单独创建，不从 CI 创建。

tag 推送触发的 `npm-publish`、`image-publish`、`desktop-release` 三条工作流都结束后，运行只读检查 `npm run release:verify -- <x.y.z>`，把输出和退出码记进该版本的 ROADMAP 记录。退出 0 只表示产物齐全且彼此一致，不是测试、冒烟或验收结果；退出 1 会点名缺的那一项；退出 2 表示有查询没得到答复，稍后重跑，不能当作缺件，也不能当作就绪。三条工作流结束时 npm 尚未发布、两个 GHCR `latest` 未动、Release 仍是 draft，公开安装入口保持上一版；所以晋升前这次检查（带 `GITHUB_TOKEN` 才看得到 draft）预期退出 1，且只点名 npm，这是晋升的起点，不是残缺发布；点名其它项才需要先修。随后从 main 晋升：`gh workflow run release-promote.yml --ref main -f tag=v<x.y.z>`，读该运行的 step summary（翻了哪些指针、没翻哪些）；失败修好原因后重跑，已完成的步骤会被识别并跳过。晋升后再跑一次 `npm run release:verify -- <x.y.z>`，应退出 0，`--pointers` 全部指向新版本。细节见 [scripts/npm/RELEASE.md](scripts/npm/RELEASE.md#after-the-tag-workflows)。

## Pull request

用仓库里的 pull request 模板说明原因和验证方式。一个 pull request 只做一件事。CI 通过后再请求审阅。

## 问题与安全

缺陷、建议和使用问题请用 [issue 模板](https://github.com/Nema-Project/nema-room/issues/new/choose)。模板会要求系统、Node/Docker 版本、运行方式和脱敏后的错误信息。

凭证、路径越界或本地接口方面的问题先读 [SECURITY.md](SECURITY.md)，并通过 [GitHub 私密漏洞报告](https://github.com/Nema-Project/nema-room/security/advisories/new) 提交。不要在公开 issue 或 PR 提交敏感细节。read 权限的非管理员已于 2026-10-27 到达该表单；测试报告于同日关闭且未发布。修复进入 main，并在后续桌面版本中分发，不承诺维护旧发布系列。
