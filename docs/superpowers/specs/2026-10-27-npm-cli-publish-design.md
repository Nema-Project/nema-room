# 把 CLI 发布到 npm（包名 `nema`）

日期：2026-10-27。实现计划：[2026-10-27-npm-cli-publish.md](../plans/2026-10-27-npm-cli-publish.md)。

**设计所对照的 HEAD**：`a72c4c09999c6d4a9104fe544231569c5ed3a753`（`main`）。对应 issue #42；包名与首发方式已由维护者在 #42 中定下（2026-10-27）。

## 意图与原因

现在拿到 Nema CLI 的唯一方式是 clone 仓库、源码安装再链接本地 CLI。README 和 guide 也明确写着不要把 `npx nema` 当作安装方式。Compose 模式下 hub 在 Docker 里、daemon 必须跑在宿主机上（issue #41 发布 hub / web 镜像），daemon 这一半如果还要用户 clone 源码，镜像那一半的便利就白费了。把 CLI 打成独立 npm 包后，用户一行 `npx nema` 或 `npm i -g nema` 就能装上 daemon，不需要这个仓库的源码。受益的是所有 Compose 模式用户和只想试用 CLI 的人。

## 目标

- npm 上有名为 `nema` 的包，内容是 `apps/cli` 的独立构建：内部依赖打进产物，装好后命令是 `nema`。
- 打 `v*` tag 时，在通过 `verify` 的同一提交上自动发布，包版本与该 tag 的桌面版一致。
- 发布走 npm trusted publishing（GitHub Actions OIDC）并带 provenance；仓库里不保存长期 npm token。
- README（中英日，含与英文版字节相同的 `README.md`）、guide 三种语言、`docs/reference.zh-CN.md` 不再写「CLI 不作为独立 npm 包发布」，改为 npm 安装说明。

## 非目标

- 不把 hub、web 或本地核心（`apps/local`）打进 npm 包。这个包只有 CLI / daemon。
- 不做自动更新。已安装的 `nema` 不检查新版本；升级靠用户重跑 npm 安装。桌面 App 的更新提示是 #35 / PR #38 的范围，不在这里重复。
- 不改 daemon 与 hub 的协议、hello 的版本一致性检查，或桌面载荷里内置 CLI 的分发方式。
- 不在本仓库内完成 npm 账号注册、首次手动发布或 trusted publisher 配置；这些是维护者在 npm 端的操作，本设计只规定它们的顺序和完成标准（R-8）。

## 反目标

做到了也算失败：

1. 仓库或工作流里出现长期 npm token（例如 `NPM_TOKEN` secret），或发布 job 用密码式凭据登录 npm。
2. 发布产物把 `@nema/shared` 等 monorepo 内部包写成 registry 依赖，或安装时要求用户 clone 本仓库。
3. npm 包版本与同一 tag 的桌面版不一致，或在 `verify` 未通过的提交上发布成功。
4. 把桌面运行时（Node、CPython、Graphify 二进制等）塞进 npm 包，体积涨到桌面载荷的量级。
5. 首次发布是空的占位包：装上后 `nema` 不能真正运行。
6. 为了 npm 包改掉现有 hub 发现与 token 文件契约，让源码安装、桌面内置 CLI 与 npm 安装三条路径行为分叉。

## 约束

- 代码和注释用英文；本设计与计划用中文（知识库语言）。
- 支持的 Node 是 `>=22`，与根 `package.json` 的 `engines` 一致；发布包的 `engines` 写同一范围。
- `cliVersion()` 按相对路径 `../../package.json` 读版本（源码 `src/` 与产物 `dist/` 都在包根下两层），daemon 的 hello 上报这个版本，hub 与 CLI 版本不一致会报 `VERSION_SKEW_ERROR`。打包后的目录布局必须让这个读取仍然成立，否则 `--version` 和 hello 都会报成 `0.0.0`。[S-4]
- trusted publishing 要求发布 job 有 `id-token: write` 权限、使用支持 OIDC 的 npm CLI（`>=11.5.1`），且在 GitHub 托管 runner 上运行。工作流文件名是 npm 端 trusted publisher 配置的一部分：定名后改名，必须先改 npm 端配置。
- 本仓库工作流的 actions 全部钉全长 commit SHA（`desktop-release.yml` 的现行约定），新工作流照此办理。
- 版本纪律沿用 `scripts/desktop/release-version.mjs`：tag 必须是 `v<严格 SemVer>`，且与包版本相等，不相等就失败关闭。`apps/cli` 的版本由现有发布流程与桌面版同步（当前同为 `0.1.3`）。

## 已定的做法

- 包名是 `nema`，命令名也是 `nema`：`npx nema` / `npm i -g nema`。包名与命令一致，不留「包名 ≠ 命令名」的解释成本。[D-1]
- 首次发布由维护者用自己的 npm 账号手动发布一个**可用**的版本（不发空占位包）；之后在该包上配置 trusted publisher，再转为 GitHub Actions 自动发布。[D-2]
- 发布渠道只用 trusted publishing（OIDC）加 provenance。仓库不存任何长期 npm token；自动发布 job 之外没有任何路径能往 npm 推包。[D-3]
- 自动发布只由 `v*` tag 触发，发布前先以该 tag 的提交调用 `verify.yml` 全量通过；包版本取 `apps/cli/package.json` 的版本，并断言与 tag 相等。[D-4]
- 内部依赖只有 `@nema/shared` 一个（它自身只依赖 `zod`）。构建时把它 bundle 进 CLI 产物，产物里不出现对内部包的外部导入；真正的第三方运行时依赖（`@modelcontextprotocol/sdk`、`commander`、`smol-toml`、`ws`、`zod`）保留为 registry 依赖。[D-5] [S-1] [S-2]
- bundle 保持现有 `dist/` 目录布局（入口 `dist/index.js`，文件深度不变），让 `cliVersion()` 的相对路径读取在发布包里原样成立；发布包清单由组装脚本生成：`name: "nema"`、`bin: { "nema": "dist/index.js" }`、`engines: { "node": ">=22" }`、`files` 含 `dist` 与 `src/report/SKILL.md`，并带仓库根 `LICENSE`。[S-4] [推断]
- hub 发现与 token 契约不改，沿用现状：`nema daemon` 用 `--hub <url>`（默认 `http://127.0.0.1:4400`）和 `--token-file <path>`（默认 `defaultTokenFile()`，即 `$NEMA_DATA_DIR` 或 `~/.nema/data` 下）；report / wp 命令的 hub 解析顺序是 `--hub` > `NEMA_HUB_URL` > 正在运行的桌面 App > 默认地址；`nema mcp` 读 `NEMA_HUB_URL` / `NEMA_RUN_TOKEN`。不 clone 仓库的用户同样走这套：token 文件从哪里来写进 guide（见 R-7），机制本身不新增。[S-3]
- 外部工具不进包。`nema doctor` 现在就会逐项检查 git、graphify、codex、claude 等用户机器上的二进制；npm 包不内置它们，缺失时由 doctor 报出。桌面包内置 Graphify 是桌面渠道的事，不复制到 npm 渠道。[S-7]
- 打包与冒烟脚本放在新建的 `scripts/npm/`，沿用 `scripts/desktop/` 的 `.mjs` 加 `node --test` 测试模式；发布工作流是新建的 `.github/workflows/npm-publish.yml`，文件名在 trusted publisher 配置完成前定死，之后不改名。[推断]

## 留给实现者

- bundle 工具由实现者选（esbuild、tsup 或其他），条件只有三条：产物保持 `dist/` 布局、内部包不再以外部导入出现、工具作为 devDependency 钉版本并进 `package-lock.json`。
- `vendor/archify`、`vendor/superpowers-rules` 是否被 CLI 在运行时按相对路径读取，由实现者在打包任务中以代码检索核对（检索 `apps/cli/src` 对 `vendor/` 的引用与运行时路径拼装）。核对结论决定是否随包携带：携带则连同其 `LICENSE` / `NOTICE` 一起进包并写进组装脚本的内容断言；不携带则把检索结论写进 PR 说明。
- token 文件在 Compose 模式下由哪一端写入共享数据目录，以 hub 现有代码为准核对后再写 guide 的说明文字；本设计只定契约（路径与读取方式见已定的做法），不定产生端的实现细节。
- CI 冒烟矩阵的 runner 组合可以按分钟成本裁剪，但 ubuntu、windows、macos 三个平台的 pack + 安装 + `--version` 都必须实际跑过（R-3），连接 hub 的冒烟至少在 ubuntu 上跑（R-2）。

## 验收标准

- R-1：一条命令能从干净 checkout 产出发布 tarball。`npm pack` 的内容里有 `dist/index.js`、`src/report/SKILL.md`、`LICENSE` 和生成的 `package.json`（`name` 是 `nema`、`bin.nema` 指向 `dist/index.js`、`engines.node` 是 `>=22`）；tarball 的依赖列表里没有 `@nema/shared` 等内部包，产物代码里没有对内部包的外部导入。
- R-2：在干净目录 `npm install <tarball>` 后，`nema --version` 输出与 `apps/cli/package.json` 的 `version` 相同；对着本地 hub 跑 `nema daemon`，hello 被 hub 接受，不出现 `VERSION_SKEW_ERROR`，daemon 能保持连接直到被关闭。
- R-3：CI 的 pack 冒烟在 ubuntu、windows、macos 上都通过（pack、干净目录安装、`nema --version`）；连接 hub 的冒烟至少在 ubuntu 上通过。
- R-4：发布 job 只在 `v*` tag 上运行；它以 tag 提交调用 `verify.yml`，全量通过才继续；tag 与 `apps/cli` 版本不一致时失败关闭；非 tag 的构建只做 pack 冒烟，绝不发布。
- R-5：发布 job 用 OIDC（`id-token: write`）执行 `npm publish --provenance`；仓库 secrets 里没有 npm token；发布后 npm 的 `nema` 页面能看到 provenance；工作流文件名与 npm 端 trusted publisher 配置所绑定的文件名一致。
- R-6：发布前打印 tarball 体积（沿用桌面载荷打印体积的习惯）；tarball 里没有 Node、CPython、Graphify 等运行时二进制；vendored 文件按「留给实现者」的核对结论处理，携带时附许可声明。
- R-7：四份 README、三份 guide、`docs/reference.zh-CN.md` 删除或改写「CLI 不作为独立 npm 包发布 / 不要用 `npx nema`」的说法，写明 `npx nema` 与 `npm i -g nema` 两种装法、Node `>=22` 要求、daemon 的 `--hub` 默认值与 token 文件来源。两份英文 README 字节相同。`CHANGELOG.md` 的 `[Unreleased]` 有对应条目。
- R-8：上线顺序有据可查：维护者手动首发一个可用版本（npm 上能装、`nema --version` 能跑）→ 在 npm 为 `nema` 配置 trusted publisher（绑定本仓库与 `npm-publish.yml`）→ 之后第一个 `v*` tag 的 Actions 发布成功且带 provenance。任何一步没完成，下一步不算完成。
