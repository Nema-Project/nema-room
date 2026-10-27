# 把 CLI 发布到 npm（包名 `nema`）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/cli` 打成名为 `nema` 的独立 npm 包：内部依赖只以一份公共 chunk 进产物，CI 做三平台 pack 冒烟，`v*` tag 在 `verify` 通过的同一提交上用 trusted publishing 自动发布。

**Architecture:** bundle 阶段以 `apps/cli/dist` 的每个 `.js` 为入口做代码分割打包：CLI 文件保持原路径，`@nema/shared` 被抽进公共 chunk 只出现一份，显式 Node 平台与 ESM 输出。组装阶段由 `scripts/npm/stage-package.mjs` 派生发布清单（`name: nema`、带 `repository`、无 `exports`）并 `npm pack`。冒烟以 hub 的 `welcome` 为接受证据，并覆盖版本不一致被拒的情形。发布工作流分两个 job：无 OIDC 的构建 job 产出 tarball，发布 job 只下载并发布，全程钉住触发事件的 SHA。

**Tech Stack:** esbuild（新 devDependency）、Node `.mjs` 脚本加 `node --test`（沿用 `scripts/desktop/` 模式）、Vitest、GitHub Actions、npm trusted publishing。

**Spec:** `docs/superpowers/specs/2026-10-27-npm-cli-publish-design.md`

**Base:** `a72c4c09999c6d4a9104fe544231569c5ed3a753`。不改 daemon 与 hub 的协议消息形状，不改 hub 发现与 token 文件契约，不把外部工具（git、graphify、codex、claude）打进包。

## Global Constraints

- 产物里不能出现对 `@nema/shared` 等内部包的外部导入；`@nema/shared` 的模块体只出现一份；发布清单里不能有内部包依赖，也不能保留 monorepo 的 `exports` 映射。
- CLI 文件不搬动：`cliVersion()` 靠 `../../package.json` 读版本，report 安装靠相对路径找 `src/report/SKILL.md`，文件深度一变两者都坏。
- 带 `id-token: write` 的发布 job 不检出源码、不装依赖、不跑构建脚本，只发布构建 job 产出的 tarball；发布前复核 tag 仍指向已验过的 SHA。
- 仓库里不出现长期 npm token；`.github/workflows/npm-publish.yml` 定名后不改名（npm 端 trusted publisher 按文件名绑定）。
- 代码和注释用英文；两份英文 README 保持字节相同。

## Review Focus

1. bundle 后 `cliVersion()` 与 report 的 `SKILL.md` 查找是否仍成立，而不是回退 `0.0.0` 或找不到文件。→ 任务 1、任务 5。
2. `@nema/shared` 是否只出现一份，模块级状态与 `instanceof` 不跨副本。→ 任务 1。
3. 发布 job 的权限分离与 SHA 钉住：验过的提交与发布的提交必须是同一个。→ 任务 8。
4. 版本三方一致（cli / desktop / local）与用户侧配对（daemon 对 hub）。→ 任务 4、任务 7、任务 10。
5. tarball 内容：内部包依赖、残留 `exports`、缺 `repository`、混进运行时二进制。→ 任务 2、任务 3。

---

### 任务 1：bundle 内部依赖（公共 chunk，文件不搬动）
- 修改：nema-room:apps/cli/package.json
- 修改：nema-room:package-lock.json
- 新建：nema-room:scripts/npm/bundle-cli.mjs
- 新建：nema-room:scripts/npm/bundle-cli.test.mjs
- 满足：R-1

- [ ] **Step 1:** 测试断言：对含 `@nema/shared` 导入的 fixture 产物运行 bundle 后，（a）没有任何文件留下 `from "@nema/shared"` 的外部导入；（b）shared 的特征模块体在全部产物中只出现一次；（c）入口文件仍在原相对路径；（d）产物是 ESM（保留 `import` 语法、无 IIFE 包装）；（e）第三方导入（`zod`、`commander`）保留为外部导入。
- [ ] **Step 2:** 跑 `node --test scripts/npm/bundle-cli.test.mjs` → 新断言 FAIL。
- [ ] **Step 3:** 加 esbuild 为根 devDependency 并更新 `package-lock.json`。实现 `bundle-cli.mjs`：枚举 `apps/cli/dist` 下每个 `.js` 为入口，esbuild 设 `bundle: true`、`splitting: true`、`format: "esm"`、`platform: "node"`，`external` 为全部第三方依赖、只内联 `@nema/shared`，`outbase` 设为 `apps/cli/dist` 使 CLI 文件写回原路径。`apps/cli` 的 `build` 脚本在 `tsc -b` 后调用它。
- [ ] **Step 4:** 跑 `node --test scripts/npm/bundle-cli.test.mjs` PASS；跑 `npx vitest run apps/cli/test` PASS（桌面载荷的 staging 构建仍能完成）。
- [ ] **Step 5:** 提交信息：`build(cli): bundle @nema/shared into a single chunk`

### 任务 2：发布包组装
- 新建：nema-room:scripts/npm/stage-package.mjs
- 新建：nema-room:scripts/npm/stage-package.test.mjs
- 修改：nema-room:package.json
- 满足：R-1、R-6

- [ ] **Step 1:** 测试断言：组装出的 `package.json` 的 `name` 是 `nema`、`private` 已去掉、`bin.nema` 是 `dist/index.js`、`engines.node` 是 `>=22`、`repository` 指向 `https://github.com/Nema-Project/nema-room`、没有 `exports` 键、`version` 与 `apps/cli/package.json` 相同、依赖里没有 `@nema/shared`；组装目录含 `dist/index.js`、`src/report/SKILL.md`、`LICENSE`；含内部包依赖的输入被拒绝。
- [ ] **Step 2:** 跑 `node --test scripts/npm/stage-package.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `stage-package.mjs`：把 `apps/cli/dist`、`apps/cli/src/report/SKILL.md`、仓库根 `LICENSE` 复制到 `dist-npm/nema/`，由 `apps/cli/package.json` 派生发布清单（改名、去 `private`、删内部依赖与 `exports`、补 `repository`），最后 `npm pack` 出 tarball 并打印 `npm package size:` 加 tarball 字节数。根 `package.json` 加脚本 `cli:pack`：先 `npm run build -w @nema/cli`（`tsc -b` 会连带构建其引用的 `@nema/shared` 并跑任务 1 的 bundle），再调用组装脚本，保证干净 checkout 上也能跑通。
- [ ] **Step 4:** 跑 `node --test scripts/npm/stage-package.test.mjs` PASS；删掉 `apps/cli/dist` 后本地跑 `npm run cli:pack` 仍能产出 tarball。
- [ ] **Step 5:** 提交信息：`build(cli): stage the standalone nema package`

### 任务 3：vendored 运行时文件的携带结论
- 修改：nema-room:scripts/npm/stage-package.mjs
- 修改：nema-room:scripts/npm/stage-package.test.mjs
- 满足：R-6

- [ ] **Step 1:** 检索 `apps/cli/src` 对 `vendor/` 的引用与运行时路径拼装（`grep -rn "vendor/" apps/cli/src` 并逐条读上下文），得出结论：CLI 运行时读哪些 vendored 文件，或一个都不读。
- [ ] **Step 2:** 按结论写测试：需要携带的，断言组装目录含该文件及其 `LICENSE` / `NOTICE`；不需要的，断言组装目录不含 `vendor/`。跑测试 → FAIL（若结论是携带）或直接 PASS（若结论是不携带，测试锁定现状）。
- [ ] **Step 3:** 若结论是携带，在 `stage-package.mjs` 里复制对应 vendored 文件与许可；若不携带，不改实现，只保留测试。
- [ ] **Step 4:** 跑 `node --test scripts/npm/stage-package.test.mjs` PASS。把检索结论（读哪些文件、依据哪些代码行）写进本任务所在 PR 的说明。
- [ ] **Step 5:** 提交信息：`build(cli): settle vendored files in the nema package`

### 任务 4：版本拒绝的可执行指引与连接接受信号
- 修改：nema-room:apps/hub/src/daemonSocket.ts
- 修改：nema-room:apps/cli/src/daemon/connection.ts
- 修改：nema-room:apps/cli/test/connection.test.ts
- 新建：nema-room:apps/hub/test/daemonVersionSkew.test.ts
- 满足：R-2

- [ ] **Step 1:** 先读 `apps/hub/src/daemonSocket.ts`，确认 hello 的版本校验与拒绝路径。测试先行：hub 侧断言版本不一致的 hello 被拒、且拒绝信息里带 hub 自身版本；CLI 侧断言（a）收到 `welcome` 时输出一行可观察的接受信号 `[nema] daemon connected to <hubUrl>`；（b）收到带 hub 版本的 skew 拒绝时，除原样呈现 hub 信息外，再输出一行 `run: npm i -g nema@<hub 版本>` 形式的安装指引。
- [ ] **Step 2:** 跑 `npx vitest run apps/cli/test/connection.test.ts apps/hub/test/daemonVersionSkew.test.ts` → FAIL。
- [ ] **Step 3:** 实现：hub 在版本拒绝信息里带上自身版本（从 hub 的包版本读，不写死字符串）；CLI 在 `welcome` 分支打印接受信号，在 `error` 分支识别 skew 拒绝并补安装指引（hub 版本从拒绝信息里取，取不到时指引写成 `nema@<hub 版本>` 占位并提示先查 hub 版本）。协议消息形状不变。
- [ ] **Step 4:** 跑同一条测试 PASS；跑 `npx vitest run apps/cli/test apps/hub/test` PASS。
- [ ] **Step 5:** 提交信息：`feat: actionable version-skew guidance and a daemon connection signal`

### 任务 5：pack 冒烟脚本
- 新建：nema-room:scripts/npm/smoke-pack.mjs
- 新建：nema-room:scripts/npm/smoke-pack.test.mjs
- 满足：R-2

- [ ] **Step 1:** 测试断言：脚本解析出 tarball 路径与可选的 `--hub-url` / `--token-file` / `--expect-skew`；版本比较在相同版本时通过、不同版本时失败并指出两个版本；`--expect-skew` 模式下脚本把已安装副本的 `package.json` 版本改高一位（`cliVersion()` 读的就是这个文件）再启动 daemon。
- [ ] **Step 2:** 跑 `node --test scripts/npm/smoke-pack.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `smoke-pack.mjs`：在临时干净目录 `npm install <tarball>`，跑 `nema --version` 并与 `apps/cli/package.json` 的版本比对，再验证 report 安装路径查找可用（装好的包里按相对路径找得到 `src/report/SKILL.md`）。给了 `--hub-url` 与 `--token-file` 时再跑两个情形：（a）正常连接：`nema daemon` 的输出里在超时前出现任务 4 的接受信号 `[nema] daemon connected to`，超时、提前退出或只重连都算失败；（b）`--expect-skew`：改版副本连接后被拒，输出里有 `nema@<hub 版本>` 安装指引。最后关掉 daemon。
- [ ] **Step 4:** 跑 `node --test scripts/npm/smoke-pack.test.mjs` PASS；本地对任务 2 的 tarball 跑一遍无 hub 模式 PASS。
- [ ] **Step 5:** 提交信息：`test(cli): smoke-test the packed nema tarball`

### 任务 6：CI 三平台 pack 冒烟
- 修改：nema-room:.github/workflows/verify.yml
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-2、R-3

- [ ] **Step 1:** 在 `workflows.test.mjs` 断言：`verify.yml` 有 pack 冒烟 job，矩阵含 `ubuntu-latest`、`windows-latest`、`macos-latest`，步骤含构建、组装（`cli:pack`）、干净目录冒烟；ubuntu 步骤额外准备本地 hub 与 daemon token 文件，并以正常与 `--expect-skew` 两种模式把 `--hub-url` / `--token-file` 传给冒烟脚本。
- [ ] **Step 2:** 跑 `node --test scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3:** 在 `verify.yml` 加该 job（actions 钉全长 SHA，Node 22）。ubuntu 上起 hub 用仓库现有的本地方式，token 文件写到临时 `NEMA_DATA_DIR`，与 daemon 默认路径一致。
- [ ] **Step 4:** 跑 `node --test scripts/ci/workflows.test.mjs` PASS；开 PR 后三平台 job 实际通过，ubuntu 的连接 hub 冒烟两种模式都通过。
- [ ] **Step 5:** 提交信息：`ci: smoke-test the nema package on three platforms`

### 任务 7：tag 与三方版本一致校验
- 新建：nema-room:scripts/npm/check-tag.mjs
- 新建：nema-room:scripts/npm/check-tag.test.mjs
- 满足：R-4

- [ ] **Step 1:** 测试断言：`check-tag.mjs` 用 `release-version.mjs` 的 `readReleaseVersion` 校验 tag，`apps/cli`、`apps/desktop`、`apps/local` 三个版本彼此一致且等于 tag 时通过；任一不一致、tag 非 `v` 前缀、非严格 SemVer 时失败，并指出是哪个版本对不上。
- [ ] **Step 2:** 跑 `node --test scripts/npm/check-tag.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `check-tag.mjs`：读三个 `package.json` 的版本，复用 `readReleaseVersion` 做 tag 形状与相等校验，三方互比，任何一项不符以非零退出并打印三个实际版本。
- [ ] **Step 4:** 跑 `node --test scripts/npm/check-tag.test.mjs` PASS；本地用当前版本拼一个 `v<version>` tag 跑一遍通过，再拼一个错位版本验证失败。
- [ ] **Step 5:** 提交信息：`ci: check release tag against cli, desktop, and local versions`

### 任务 8：npm 发布工作流（双 job、SHA 钉住、演练路径）
- 新建：nema-room:.github/workflows/npm-publish.yml
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-4、R-5

- [ ] **Step 1:** 在 `workflows.test.mjs` 断言：`npm-publish.yml` 的触发只有 `push` 的 `v*` tag 与 `workflow_dispatch`；`verify` job 以事件 SHA 调用 `./.github/workflows/verify.yml`（`checkout_ref` 传该 SHA）；`build` job 没有 `id-token` 权限，产出 tarball artifact；`publish` job `needs` 两者、权限只有 `id-token: write` 与 `contents: read`、步骤里只有下载 artifact、复核 tag、用任务 7 的 `check-tag` 校验、确认 tag 提交是 `origin/main` 的祖先、最后 `npm publish --provenance --access public`，没有检出源码、装依赖或构建步骤；整个文件没有 `NPM_TOKEN` 字样；`workflow_dispatch` 触发时 `publish` job 被 dry-run 条件跳过。
- [ ] **Step 2:** 跑 `node --test scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `npm-publish.yml`：`verify` 与 `build` 都以 `${{ github.sha }}` 检出；`build` 跑 pack 与 ubuntu 冒烟后上传 tarball；`publish` 先 `git ls-remote` 复核 tag 仍指向 `github.sha`，再校验祖先关系与三方版本，最后发布。runner 用 Node 22 并把 npm 升到 `>=11.5.1` 以满足 trusted publishing。
- [ ] **Step 4:** 上述测试 PASS；用 `workflow_dispatch` 演练一遍，流程停在 `publish` 之前，tarball artifact 存在且可下载。
- [ ] **Step 5:** 提交信息：`ci: publish nema to npm from release tags with OIDC`

### 任务 9：发布手册
- 新建：nema-room:scripts/npm/RELEASE.md
- 满足：R-8

- [ ] **Step 1:** 写手册：首次发布由维护者在本地跑 `cli:pack`、用自己的 npm 账号 `npm publish --access public` 发出可用版本，并当场验证 `npx nema --version`；随后在 npm 的 `nema` 包上配置 trusted publisher，绑定仓库 `Nema-Project/nema-room` 与工作流文件名 `npm-publish.yml`；之后打 `v*` tag 即自动发布。写明这是 trusted publisher 配置前的一次性例外、配置完成后手动发布路径关闭；写明失败关闭的行为（verify 不过、tag 被移动、tag 不在 main 上、三方版本不一致、trusted publisher 未配置时发布 job 失败且不会发出包）和「工作流改名必须先改 npm 端配置」。
- [ ] **Step 2:** 核对：手册里的工作流文件名与 `.github/workflows/npm-publish.yml` 一致，手册里的命令与任务 2、任务 7、任务 8 的实际脚本名一致（逐条 `grep` 对照）。
- [ ] **Step 3:** 提交信息：`docs(cli): npm release runbook`

### 任务 10：文档改写
- 修改：nema-room:README.md
- 修改：nema-room:README.en.md
- 修改：nema-room:README.zh.md
- 修改：nema-room:README.ja.md
- 修改：nema-room:docs/guide.en.md
- 修改：nema-room:docs/guide.ja.md
- 修改：nema-room:docs/guide.zh.md
- 修改：nema-room:docs/reference.zh-CN.md
- 修改：nema-room:CHANGELOG.md
- 满足：R-7

- [ ] **Step 1:** 先 `grep` 出各文档里「CLI 不作为独立 npm 包发布 / 不要用 `npx nema`」的现行说法，逐处登记；同时核对 hub 版本的现有查法（hub 的状态输出、接口或发布说明，以代码为准），登记依据。
- [ ] **Step 2:** 改写安装说明：npm 安装成为正式方式，命令默认按 hub 版本写（`npx nema@<hub 版本>`、`npm i -g nema@<hub 版本>`），并写明查 hub 版本的方法、Node `>=22` 要求、版本不一致时按报错指引处理；源码安装保留为开发方式；guide 写明 daemon 的 `--hub` 默认值与 token 文件来源（按 spec「留给实现者」中核对过的产生端事实写）。`CHANGELOG.md` 的 `[Unreleased]` 加条目。
- [ ] **Step 3:** 验证：`cmp README.md README.en.md` 无差异；文档检查不报缺链接；`grep` 不再命中已登记的旧说法。
- [ ] **Step 4:** 提交信息：`docs(cli): document installing nema from npm`
