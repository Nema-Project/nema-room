# 把 CLI 发布到 npm（包名 `nema`）

日期：2026-10-27。实现计划：[2026-10-27-npm-cli-publish.md](../plans/2026-10-27-npm-cli-publish.md)。

**设计所对照的 HEAD**：`a72c4c09999c6d4a9104fe544231569c5ed3a753`（`main`）。对应 issue #42；包名与首发方式已由维护者在 #42 中定下（2026-10-27）。2026-10-27 按 PR #43 的两份 review（维护者与 Sourcery）修订过一轮：标注写法、用户侧版本配对、bundle 方式与发布 job 的权限分离都在本版里处理；第二轮 review 指出的 splitting 会抽走 CLI 自身模块的问题，也在本版定死。

## 意图与原因

现在拿到 Nema CLI 的唯一方式是 clone 仓库、源码安装再链接本地 CLI。README 和 guide 也明确写着不要把 `npx nema` 当作安装方式。Compose 模式下 hub 在 Docker 里、daemon 必须跑在宿主机上（issue #41 发布 hub / web 镜像），daemon 这一半如果还要用户 clone 源码，镜像那一半的便利就白费了。把 CLI 打成独立 npm 包后，用户一行 `npx nema` 或 `npm i -g nema` 就能装上 daemon，不需要这个仓库的源码。受益的是所有 Compose 模式用户和只想试用 CLI 的人。

## 目标

- npm 上有名为 `nema` 的包，内容是 `apps/cli` 的独立构建：内部依赖打进产物，装好后命令是 `nema`。
- 打 `v*` tag 时，在通过 `verify` 的同一提交上自动发布，包版本与该 tag 的桌面版一致。
- 发布走 npm trusted publishing（GitHub Actions OIDC）并带 provenance；仓库里不保存长期 npm token。
- README（中英日，含与英文版字节相同的 `README.md`）、guide 三种语言、`docs/reference.zh-CN.md` 不再写「CLI 不作为独立 npm 包发布」，改为 npm 安装说明。
- 本设计生效后，仓库文档里「CLI 不作为独立包发布」的现行规则被本设计取代（依据是 #42 的维护者决定），不是与之并存；改写文档时按 R-7 一并处理。

## 非目标

- 不把 hub、web 或本地核心（`apps/local`）打进 npm 包。这个包只有 CLI / daemon。
- 不做自动更新。已安装的 `nema` 不检查新版本；升级靠用户重跑 npm 安装。桌面 App 的更新提示是 #35 / PR #38 的范围，不在这里重复。
- 不改 daemon 与 hub 的协议消息形状；版本拒绝时补 hub 版本与安装指引是报错内容的补强（见已定的做法），不算协议变更。
- 不在本仓库内完成 npm 账号注册、首次手动发布或 trusted publisher 配置；这些是维护者在 npm 端的操作，本设计只规定它们的顺序和完成标准（R-8）。

## 反目标

做到了也算失败：

1. 仓库或工作流里出现长期 npm token（例如 `NPM_TOKEN` secret），或发布 job 用密码式凭据登录 npm。
2. 发布产物把 `@nema/shared` 等 monorepo 内部包写成 registry 依赖，或安装时要求用户 clone 本仓库。
3. npm 包版本与同一 tag 的桌面版不一致，或在 `verify` 未通过的提交上发布成功。
4. 把桌面运行时（Node、CPython、Graphify 二进制等）塞进 npm 包，体积涨到桌面载荷的量级。
5. 首次发布是空的占位包：装上后 `nema` 不能真正运行。
6. 为了 npm 包改掉现有 hub 发现与 token 文件契约，让源码安装、桌面内置 CLI 与 npm 安装三条路径行为分叉。
7. 带 OIDC 权限的发布 job 里运行构建、装依赖或冒烟等会执行仓库与依赖脚本的步骤；或 tag 在 verify 之后被移动，发布出去的提交不是验过的那个。

## 约束

- 代码和注释用英文；本设计与计划用中文（知识库语言）。
- 支持的 Node 是 `>=22`，与根 `package.json` 的 `engines` 一致；发布包的 `engines` 写同一范围。
- CLI 里有两处按模块相对路径的查找，打包时不能搬动相关模块的位置：`cliVersion()` 按 `../../package.json` 读版本（daemon 的 hello 上报这个版本，hub 与 CLI 版本不一致会报 `VERSION_SKEW_ERROR`）；report 的安装逻辑按模块相对路径找 `src/report/SKILL.md`。搬动后前者回退成 `0.0.0`、后者找不到文件。（S-4）
- npm provenance 要求发布包的清单带 `repository` 字段、且指向实际发布它的仓库，缺失时 attestation 生成失败，发布达不到 R-5。
- trusted publishing 要求发布 job 有 `id-token: write` 权限、使用支持 OIDC 的 npm CLI（`>=11.5.1`），且在 GitHub 托管 runner 上运行。工作流文件名是 npm 端 trusted publisher 配置的一部分：定名后改名，必须先改 npm 端配置。
- 本仓库工作流的 actions 全部钉全长 commit SHA（`desktop-release.yml` 的现行约定），新工作流照此办理。
- 版本纪律沿用 `scripts/desktop/release-version.mjs`：tag 必须是 `v<严格 SemVer>`，且与包版本相等，不相等就失败关闭。发布门校验的版本不只是 `apps/cli`：`apps/cli`、`apps/desktop`、`apps/local` 三个版本必须彼此一致且等于 tag（桌面发布门现在只查后两者，本设计把 CLI 补进来）。三个包的版本由现有发布流程同步（当前同为 `0.1.3`）。
- `apps/cli/package.json` 本身的 `exports` 映射被 `apps/local` 等仓库内消费者使用，不动它；发布清单的裁剪（见已定的做法）只发生在组装出的副本上。

## 已定的做法

- 包名是 `nema`，命令名也是 `nema`：`npx nema` / `npm i -g nema`。包名与命令一致，不留「包名 ≠ 命令名」的解释成本。[D-1]
- 首次发布由维护者用自己的 npm 账号手动发布一个**可用**的版本（不发空占位包）；之后在该包上配置 trusted publisher，再转为 GitHub Actions 自动发布。[D-2]
- 发布渠道只用 trusted publishing（OIDC）加 provenance。仓库不存任何长期 npm token；trusted publisher 配置完成之后，能往 npm 推包的只有自动发布 job。上一句对首次手动发布不适用：手动首发是配置完成之前的一次性例外，配置完成起例外关闭。[D-3]
- 自动发布只由 `v*` tag 触发，发布前先以该 tag 的提交调用 `verify.yml` 全量通过；包版本取 `apps/cli/package.json` 的版本，并按约束一节的三方一致规则断言与 tag 相等。[D-4]
- 内部依赖只有 `@nema/shared` 一个（它自身只依赖 `zod`），构建时把它打进 CLI 产物、只出现一份，产物里不出现对内部包的外部导入；真正的第三方运行时依赖（`@modelcontextprotocol/sdk`、`commander`、`smol-toml`、`ws`、`zod`）保留为 registry 依赖。依据是两处 `package.json`（`[S-1]`、`[S-2]`）。[D-5]
- bundle 的形状定死：入口是 `apps/cli/dist` 下的每个 `.js` 文件；打包时把 CLI 自身的相对 import 标为 external，CLI 文件原样保留、按原路径互相 import，**只有** `@nema/shared` 被打包，并被抽进公共 chunk、只出现一份。单靠 `splitting` 做不到这一点：被多个入口共享的 CLI 模块同样会被抽进 chunk，`import.meta.url` 随之失效，所以 external 标记是必须的手段，不是可选优化。打包器显式设为 Node 平台与 ESM 输出，不用默认值。这样模块级状态、`instanceof` 与 schema 实例全包只有一份，`cliVersion()` 与 report 安装的相对路径查找也原样成立（`@nema/shared` 自身不使用 `import.meta.url` 相对查找，核对于 2026-10-27）。（S-4）[推断]
- 发布包的清单由组装脚本从 `apps/cli/package.json` 派生：`name: "nema"`、`bin: { "nema": "dist/index.js" }`、`engines: { "node": ">=22" }`、去掉 `private`、补上指向本仓库的 `repository` 字段；**不保留** monorepo 的 `exports` 映射（其中 `development` 条件指向不随包发布的 `src/` 文件），发布包是应用不是库，只承诺 `bin` 入口；`files` 只含实际组装进包的文件（`dist`、`src/report/SKILL.md`、`LICENSE`）。[D-6]
- 发布分两个 job：构建、组装、冒烟在没有 OIDC 权限的 job 里完成，产出 tarball 作为 artifact；发布 job 只下载该 tarball 并执行 `npm publish`，不检出源码、不装依赖、不跑任何构建脚本。verify 与发布用同一个提交：工作流以触发事件的 SHA 检出与校验，发布 job 开始前复核 tag 仍解析到该 SHA，不一致即失败。tag 指向的提交必须已在受保护的 `main` 上（与桌面发布门校验「确切的 main 线提交」一致）；能推 `v*` tag 的人因此也不能把未审过的提交送进 npm。另外留一条演练路径：`workflow_dispatch` 手动触发时在发布 job 之前停住（dry run），只走构建、组装与冒烟。[D-7]
- hub 发现与 token 契约不改，沿用现状：`nema daemon` 用 `--hub <url>`（默认 `http://127.0.0.1:4400`）和 `--token-file <path>`（默认 `defaultTokenFile()`，即 `$NEMA_DATA_DIR` 或 `~/.nema/data` 下）；report / wp 命令的 hub 解析顺序是 `--hub` > `NEMA_HUB_URL` > 正在运行的桌面 App > 默认地址；`nema mcp` 读 `NEMA_HUB_URL` / `NEMA_RUN_TOKEN`。不 clone 仓库的用户同样走这套：token 文件从哪里来写进 guide（见 R-7），机制本身不新增。（S-3）
- 外部工具不进包。`nema doctor` 现在就会逐项检查 git、graphify、codex、claude 等用户机器上的二进制；npm 包不内置它们，缺失时由 doctor 报出。桌面包内置 Graphify 是桌面渠道的事，不复制到 npm 渠道。（S-7）
- npm 版 daemon 与 hub 的版本配对是用户侧契约，靠文档与报错兜住，不靠锁步发版：文档里的安装命令默认写成与 hub 对应的版本（`npx nema@<hub 版本>`、`npm i -g nema@<hub 版本>`），并写明怎么查正在跑的 hub 的版本；只写 latest 装法时，必须同时写明版本要与 hub 一致。版本不一致被 hub 拒绝时，报错要可执行：hub 的拒绝信息里带上 hub 自身的版本，daemon 原样呈现，并据此给出「请安装 `nema@<hub 版本>`」的指引，而不是只报不一致或静默重连。[D-8]
- 打包与冒烟脚本放在新建的 `scripts/npm/`，沿用 `scripts/desktop/` 的 `.mjs` 加 `node --test` 测试模式；发布工作流是新建的 `.github/workflows/npm-publish.yml`，文件名在 trusted publisher 配置完成前定死，之后不改名。[推断]

## 留给实现者

- bundle 工具由实现者选（esbuild 或其他），但必须满足已定的做法里定死的形状：全入口、CLI 相对 import 标为 external、公共 chunk 只含 `@nema/shared` 且只出现一份、显式 Node 平台与 ESM 输出、CLI 文件不搬动。工具作为 devDependency 钉版本并进 `package-lock.json`。
- `vendor/archify`、`vendor/superpowers-rules` 是否被 CLI 在运行时按相对路径读取，由实现者在打包任务中以代码检索核对（检索 `apps/cli/src` 对 `vendor/` 的引用与运行时路径拼装）。核对结论决定是否随包携带：携带则连同其 `LICENSE` / `NOTICE` 一起进包并写进组装脚本的内容断言；不携带则把检索结论写进 PR 说明。
- token 文件在 Compose 模式下由哪一端写入共享数据目录，以 hub 现有代码为准核对后再写 guide 的说明文字；本设计只定契约（路径与读取方式见已定的做法），不定产生端的实现细节。
- hub 的版本从哪条现有路径能被用户查到（发布说明、hub 的状态输出或接口），由实现者在文档任务中以代码与现有文档为准核对后写进 guide；本设计只定「文档必须给出查法」。
- CI 冒烟矩阵的 runner 组合可以按分钟成本裁剪，但 ubuntu、windows、macos 三个平台的 pack + 安装 + `--version` 都必须实际跑过（R-3），连接 hub 的冒烟至少在 ubuntu 上跑（R-2）。

## 验收标准

- R-1：根命令 `cli:pack` 在干净 checkout 上能跑通（先构建 CLI 再组装），产出发布 tarball。`npm pack` 的内容里有 `dist/index.js`、`src/report/SKILL.md`、`LICENSE` 和派生的 `package.json`：`name` 是 `nema`、`bin.nema` 指向 `dist/index.js`、`engines.node` 是 `>=22`、`repository` 指向本仓库、没有残留的 `exports` 映射；依赖列表里没有 `@nema/shared` 等内部包，产物代码里没有对内部包的外部导入，且 `@nema/shared` 的模块体在产物中只出现一次。产物里所有 chunk 文件只包含 `@nema/shared` 的代码，含 `import.meta.url` 的模块（`cliVersion()`、report 安装逻辑）都仍在原路径——这一条要能机检，不只靠装好后实测。装好的 tarball 里 `nema --version` 与 report 安装路径查找都能正常工作（不回退 `0.0.0`、找得到 `SKILL.md`）。
- R-2：在干净目录 `npm install <tarball>` 后，`nema --version` 输出与 `apps/cli/package.json` 的 `version` 相同；对着本地 hub 跑 `nema daemon`，以 hub 发回的 `welcome` 消息为接受证据（daemon 侧要有可观察的接受信号），只看进程活着不算通过。再用一个与 hub 版本不一致的 daemon 连接：连接被拒绝，输出里有可执行的安装指引（`nema@<hub 版本>`），不是静默重连。
- R-3：CI 的 pack 冒烟在 ubuntu、windows、macos 上都通过（pack、干净目录安装、`nema --version`）；连接 hub 的冒烟（含 R-2 的接受证据与版本不一致情形）至少在 ubuntu 上通过。
- R-4：发布只发生在 `v*` tag 上，且全部满足才继续：tag 提交已在受保护的 `main` 上；以该提交调用 `verify.yml` 全量通过；tag 与 `apps/cli`、`apps/desktop`、`apps/local` 三个版本一致；发布 job 开始前复核 tag 仍指向已验过的 SHA。发布 job 本身不检出源码、不装依赖、不跑构建脚本，只发布构建 job 产出的 tarball。非 tag 的构建（包括 `workflow_dispatch` 演练）只做 pack 冒烟，绝不发布。
- R-5：发布 job 用 OIDC（`id-token: write`）执行 `npm publish --provenance`；仓库 secrets 里没有 npm token；发布后 npm 的 `nema` 页面能看到 provenance；工作流文件名与 npm 端 trusted publisher 配置所绑定的文件名一致。
- R-6：发布前打印 tarball 体积（沿用桌面载荷打印体积的习惯）；tarball 里没有 Node、CPython、Graphify 等运行时二进制；vendored 文件按「留给实现者」的核对结论处理，携带时附许可声明。
- R-7：四份 README、三份 guide、`docs/reference.zh-CN.md` 删除或改写「CLI 不作为独立 npm 包发布 / 不要用 `npx nema`」的说法，写明按 hub 版本安装（`npx nema@<hub 版本>` 与 `npm i -g nema@<hub 版本>`）、怎么查 hub 的版本、Node `>=22` 要求、daemon 的 `--hub` 默认值与 token 文件来源。两份英文 README 字节相同。`CHANGELOG.md` 的 `[Unreleased]` 有对应条目。
- R-8：上线顺序有据可查：维护者手动首发一个可用版本（npm 上能装、`nema --version` 能跑）→ 在 npm 为 `nema` 配置 trusted publisher（绑定本仓库与 `npm-publish.yml`）→ 之后第一个 `v*` tag 的 Actions 发布成功且带 provenance。任何一步没完成，下一步不算完成。
