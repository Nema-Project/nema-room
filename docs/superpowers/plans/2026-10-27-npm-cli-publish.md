# 把 CLI 发布到 npm（包名 `nema`）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `apps/cli` 打成名为 `nema` 的独立 npm 包：内部依赖 bundle 进产物，CI 做三平台 pack 冒烟，`v*` tag 在 `verify` 通过的同一提交上用 trusted publishing 自动发布。

**Architecture:** bundle 阶段用 esbuild 对 `tsc` 的每个产物文件就地打包，只把 `@nema/shared` 内联、其余依赖保持外部导入，`dist/` 布局与文件深度不变。组装阶段由 `scripts/npm/stage-package.mjs` 生成发布清单（`name: nema`）并 `npm pack`。冒烟脚本在干净目录安装 tarball、核对 `--version`、连本地 hub。发布是独立工作流 `npm-publish.yml`：先以 tag 提交调用 `verify.yml`，再 OIDC 发布。

**Tech Stack:** esbuild（新 devDependency）、Node `.mjs` 脚本加 `node --test`（沿用 `scripts/desktop/` 模式）、Vitest、GitHub Actions、npm trusted publishing。

**Spec:** `docs/superpowers/specs/2026-10-27-npm-cli-publish-design.md`

**Base:** `a72c4c09999c6d4a9104fe544231569c5ed3a753`。不改 daemon 与 hub 的协议，不改 hub 发现与 token 文件契约，不把外部工具（git、graphify、codex、claude）打进包。

## Global Constraints

- 产物里不能出现对 `@nema/shared` 等内部包的外部导入；发布清单里不能有内部包依赖。
- `dist/` 布局不变：`cliVersion()` 靠 `../../package.json` 读版本，文件深度一变，`--version` 和 daemon hello 都会报 `0.0.0`。
- 仓库和工作流里不出现长期 npm token；发布只用 OIDC 加 `--provenance`。
- `.github/workflows/npm-publish.yml` 定名后不改名（npm 端 trusted publisher 按文件名绑定）。
- 代码和注释用英文；两份英文 README 保持字节相同。

## Review Focus

1. bundle 后 `cliVersion()` 是否仍读到真实版本，而不是回退 `0.0.0`。→ 任务 1、任务 4。
2. tarball 里混进内部包依赖、vendored 运行时或桌面运行时二进制。→ 任务 2、任务 3。
3. 发布 job 在 `verify` 未过、非 tag、或 tag 与版本不一致时仍然发布。→ 任务 6。
4. 工作流文件名与手册里写的 trusted publisher 绑定名不一致。→ 任务 6、任务 7。

---

### 任务 1：bundle 内部依赖，保持 dist 布局
- 修改：nema-room:apps/cli/package.json
- 修改：nema-room:package-lock.json
- 新建：nema-room:scripts/npm/bundle-cli.mjs
- 新建：nema-room:scripts/npm/bundle-cli.test.mjs
- 满足：R-1

- [ ] **Step 1:** 测试断言：对一个含 `@nema/shared` 导入的 fixture 产物运行 bundle 后，输出文件里没有 `from "@nema/shared"` 的外部导入；非内部包导入（`zod`、`commander`）保留；文件相对路径不变。
- [ ] **Step 2:** 跑 `node --test scripts/npm/bundle-cli.test.mjs` → 新断言 FAIL。
- [ ] **Step 3:** 加 esbuild 为根 devDependency 并更新 `package-lock.json`。实现 `bundle-cli.mjs`：枚举 `apps/cli/dist` 下每个 `.js` 作为入口，用 esbuild 逐文件打包（`bundle: true`、`external` 为全部第三方依赖、只内联 `@nema/shared`），原地写回同一路径。`apps/cli` 的 `build` 脚本在 `tsc -b` 后调用它。
- [ ] **Step 4:** 跑 `node --test scripts/npm/bundle-cli.test.mjs` PASS；跑 `npx vitest run apps/cli/test` PASS（桌面载荷的 staging 构建仍能完成）。
- [ ] **Step 5:** 提交信息：`build(cli): bundle @nema/shared into the CLI dist`

### 任务 2：发布包组装
- 新建：nema-room:scripts/npm/stage-package.mjs
- 新建：nema-room:scripts/npm/stage-package.test.mjs
- 修改：nema-room:package.json
- 满足：R-1、R-6

- [ ] **Step 1:** 测试断言：组装出的 `package.json` 的 `name` 是 `nema`、`private` 已去掉、`bin.nema` 是 `dist/index.js`、`engines.node` 是 `>=22`、`version` 与 `apps/cli/package.json` 相同、依赖里没有 `@nema/shared`；组装目录含 `dist/index.js`、`src/report/SKILL.md`、`LICENSE`；含内部包依赖的输入被拒绝。
- [ ] **Step 2:** 跑 `node --test scripts/npm/stage-package.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `stage-package.mjs`：把 `apps/cli/dist`、`apps/cli/src/report/SKILL.md`、仓库根 `LICENSE` 复制到 `dist-npm/nema/`，由 `apps/cli/package.json` 派生发布清单（改名、去 `private`、删内部依赖），最后 `npm pack` 出 tarball 并打印 `npm package size:` 加 tarball 字节数。根 `package.json` 加脚本 `cli:pack` 调用它。
- [ ] **Step 4:** 跑 `node --test scripts/npm/stage-package.test.mjs` PASS；本地跑 `npm run cli:pack` 能产出 tarball。
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

### 任务 4：pack 冒烟脚本
- 新建：nema-room:scripts/npm/smoke-pack.mjs
- 新建：nema-room:scripts/npm/smoke-pack.test.mjs
- 满足：R-2

- [ ] **Step 1:** 测试断言：脚本解析出 tarball 路径与可选的 `--hub-url` / `--token-file`；版本比较在相同版本时通过、不同版本时失败并指出两个版本。
- [ ] **Step 2:** 跑 `node --test scripts/npm/smoke-pack.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `smoke-pack.mjs`：在临时干净目录 `npm install <tarball>`，跑 `nema --version` 并与 `apps/cli/package.json` 的版本比对；给了 `--hub-url` 与 `--token-file` 时，再跑 `nema daemon --hub <url> --token-file <path>`，断言进程保持连接（不立即退出、输出里没有 `VERSION_SKEW_ERROR`），超时或提前退出即失败，最后关掉 daemon。
- [ ] **Step 4:** 跑 `node --test scripts/npm/smoke-pack.test.mjs` PASS；本地对任务 2 的 tarball 跑一遍无 hub 模式 PASS。
- [ ] **Step 5:** 提交信息：`test(cli): smoke-test the packed nema tarball`

### 任务 5：CI 三平台 pack 冒烟
- 修改：nema-room:.github/workflows/verify.yml
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-2、R-3

- [ ] **Step 1:** 在 `workflows.test.mjs` 断言：`verify.yml` 有 pack 冒烟 job，矩阵含 `ubuntu-latest`、`windows-latest`、`macos-latest`，步骤含构建、组装（`cli:pack`）、干净目录冒烟；ubuntu 步骤额外准备本地 hub 与 daemon token 文件，并把 `--hub-url` / `--token-file` 传给冒烟脚本。
- [ ] **Step 2:** 跑 `node --test scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3:** 在 `verify.yml` 加该 job（actions 钉全长 SHA，Node 22）。ubuntu 上起 hub 用仓库现有的本地方式，token 文件写到临时 `NEMA_DATA_DIR`，与 daemon 默认路径一致。
- [ ] **Step 4:** 跑 `node --test scripts/ci/workflows.test.mjs` PASS；开 PR 后三平台 job 实际通过，ubuntu 的连接 hub 冒烟通过。
- [ ] **Step 5:** 提交信息：`ci: smoke-test the nema package on three platforms`

### 任务 6：npm 发布工作流
- 新建：nema-room:.github/workflows/npm-publish.yml
- 新建：nema-room:scripts/npm/check-tag.mjs
- 新建：nema-room:scripts/npm/check-tag.test.mjs
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-4、R-5

- [ ] **Step 1:** 测试断言：`check-tag.mjs` 用 `release-version.mjs` 的 `readReleaseVersion` 校验 tag 与 `apps/cli` 版本，相等时通过，不等、非 `v` 前缀、非严格 SemVer 时失败。`workflows.test.mjs` 断言：`npm-publish.yml` 只由 `v*` tag 触发；先以 tag 提交调用 `verify.yml`，发布 job `needs` 它；发布 job 权限是 `id-token: write` 加 `contents: read`；发布命令是 `npm publish --provenance --access public`；文件里没有 `NPM_TOKEN` 字样。
- [ ] **Step 2:** 跑 `node --test scripts/npm/check-tag.test.mjs scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3:** 实现 `check-tag.mjs` 与 `npm-publish.yml`：触发为 `push` 的 `v*` tag；`verify` job 调用 `./.github/workflows/verify.yml` 并传 `checkout_ref` 为该 tag；`publish` job 先跑 `check-tag`、构建、组装、三平台之外的 ubuntu 冒烟，再发布。runner 用 Node 22 并把 npm 升到 `>=11.5.1` 以满足 trusted publishing。
- [ ] **Step 4:** 上述测试 PASS；用 `workflow_dispatch` 或非发布分支演练时，流程停在 pack 冒烟、不执行发布步骤。
- [ ] **Step 5:** 提交信息：`ci: publish nema to npm from release tags with OIDC`

### 任务 7：发布手册
- 新建：nema-room:scripts/npm/RELEASE.md
- 满足：R-8

- [ ] **Step 1:** 写手册：首次发布由维护者在本地跑组装与 pack、用自己的 npm 账号 `npm publish --access public` 发出可用版本，并当场验证 `npx nema --version`；随后在 npm 的 `nema` 包上配置 trusted publisher，绑定仓库 `Nema-Project/nema-room` 与工作流文件名 `npm-publish.yml`；之后打 `v*` tag 即自动发布。写明失败关闭的行为（verify 不过、tag 与版本不一致、trusted publisher 未配置时发布 job 失败且不会发出包）和「工作流改名必须先改 npm 端配置」。
- [ ] **Step 2:** 核对：手册里的工作流文件名与 `.github/workflows/npm-publish.yml` 一致，手册里的命令与任务 2、任务 6 的实际脚本名一致（逐条 `grep` 对照）。
- [ ] **Step 3:** 提交信息：`docs(cli): npm release runbook`

### 任务 8：文档改写
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

- [ ] **Step 1:** 先 `grep` 出各文档里「CLI 不作为独立 npm 包发布 / 不要用 `npx nema`」的现行说法，逐处登记。
- [ ] **Step 2:** 改写安装说明：npm 安装（`npx nema`、`npm i -g nema`、Node `>=22`）成为正式方式，源码安装保留为开发方式；guide 写明 daemon 的 `--hub` 默认值与 token 文件来源（按 spec「留给实现者」中核对过的产生端事实写）。`CHANGELOG.md` 的 `[Unreleased]` 加条目。
- [ ] **Step 3:** 验证：`cmp README.md README.en.md` 无差异；文档检查不报缺链接；`grep` 不再命中已登记的旧说法。
- [ ] **Step 4:** 提交信息：`docs(cli): document installing nema from npm`
