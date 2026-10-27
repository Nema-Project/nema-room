# 加快 PR CI 门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR 的必过 `CI gate` 只跑分类、文档检查、workflow lint 和 Ubuntu 应用测试与 web build；platform 与 npm pack 按路径表跑；`main` 推送与发布 tag 仍跑完整 `verify.yml`。

**Architecture:** `policy.mjs` 仍是分类与门禁的纯函数。`changes.mjs` 把五个键写进 `GITHUB_OUTPUT`。`verify.yml` 用默认 true 的布尔输入决定是否运行 `test`、`platform`、`npm-pack`，并把四个 job 结果作为可复用工作流输出。`ci.yml` 在 PR 上按分类传输入，在 `main` 推送和 `workflow_dispatch` 上强制全量。桌面与镜像 smoke 不进 `CI gate`。

**Tech Stack:** Node `node --test`、现有的 `yaml` 解析、GitHub Actions。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-pr-ci-fast-gate-design.md`

**Base:** `9980a4a786c50a344db7adfd4a689da120b4c123`。不改产品代码，不调用 ruleset API，不打 tag，不发布，不合并。

## Global Constraints

- 文档白名单的成员与排除项保持基线：根 `*.md`、`docs/` 与 `site/` 的现有扩展名、`.github/workflows/pages.yml` 算文档；`AGENTS.md` / `CLAUDE.md`、可执行文件、`..`、绝对路径不算。空路径列表，以及含 `..`、`.` 段、绝对路径或反斜杠的路径，是 mode `full`。
- `verify.yml` 的 `app_tests`、`platform`、`npm_pack` 默认 true。`npm-publish.yml` 与 `desktop-release.yml` 的 tag 调用不传 false。
- `gatePasses` 不把 `cancelled`、失败、空结果当成通过。空结果不是 `skipped`。
- `desktop-release.yml` 的 `pull_request.paths` 保持 `apps/desktop/**` 与 `scripts/desktop/**`。不创建 `image-publish.yml`。
- 不改 README。两份英文 README 保持字节相同。
- 代码与注释用英文。提交信息用英文。

## Review Focus

1. tag 调用方是否仍跑齐 `workflow-lint`、`test`、`platform`、`npm-pack`。→ 任务 3、任务 4。
2. 必过的重型 job 结果是 `skipped` 时门禁是否失败，docs PR 是否仍能在应用测试被跳过时通过。→ 任务 1。
3. `AGENTS.md` 是否仍是 `app` 而不是 `docs`。→ 任务 1。
4. `cancel-in-progress` 是否只在 `pull_request` 上为 true，`main` 推送是否不会被后来的推送取消正在跑的那次。→ 任务 4。
5. 实现 diff 是否没有 ruleset、tag、发布。→ 任务 6。
6. 只改 `apps/hub/` 或 `apps/web/` 是否不触发 platform / npm pack；只改 lockfile 是否不触发 desktop。→ 任务 1、任务 5。

---

### 任务 1：路径分类与门禁结果表
- 修改：nema-room:scripts/ci/policy.mjs
- 修改：nema-room:scripts/ci/policy.test.mjs
- 修改：nema-room:scripts/ci/changes.mjs
- 满足：R-1、R-2、R-3

- [ ] **Step 1:** 改 `policy.test.mjs` 的断言，先不要改实现。现有 `classifyPaths(...) === 'docs'|'full'` 与只传 `verify` 的 `gatePasses` 断言改成下面的返回值，否则任务做完旧断言仍要求「未知路径 = 整套必跑」。
  - 测试名 `documentation allowlist stays docs and does not request heavy jobs`：`['README.md', 'docs/guide.zh.md']`、`['site/index.html']`、`['.github/workflows/pages.yml']` 的 mode 都是 `docs`，`platform`、`npmPack`、`desktop`、`image` 都为 false。
  - 测试名 `agent instructions stay on the app gate without heavy jobs`：`['AGENTS.md']`、`['CLAUDE.md']`、`['docs/AGENTS.md']`、`['site/nested/CLAUDE.md']` 的 mode 都是 `app`，四个标志都为 false。
  - 测试名 `empty or unsafe paths fail closed onto the full suite`：`[]`、`['docs/../scripts/x.mjs']`、`['/docs/a.md']`、`['docs\\a.md']` 的 mode 是 `full`。
  - 测试名 `path classes match the fast-gate table`：`apps/web/app/page.tsx`、`apps/hub/src/app.ts`、`vendor/rules.md`、`unknown`、`docs/a.js` 是 `app` 且四个标志为 false；`apps/cli/src/index.ts` 使 `platform` 与 `npmPack` 为 true、`desktop` 为 false；`packages/shared/src/index.ts` 只使 `npmPack` 为 true；`packages/knowledge/src/store.ts` 与 `scripts/security/reporting-status.test.mjs` 只使 `platform` 为 true；`apps/desktop/package.json` 与 `scripts/desktop/smoke-desktop.test.mjs` 使 `platform` 与 `desktop` 为 true；`package-lock.json` 使 `platform` 与 `npmPack` 为 true、`desktop` 为 false；`Dockerfile` 与 `scripts/images/smoke-compose.mjs` 只使 `image` 为 true；`.github/workflows/ci.yml`、`.github/workflows/verify.yml`、`scripts/ci/policy.mjs` 使 `platform` 与 `npmPack` 为 true。混合 `['README.md', 'apps/web/app/page.tsx']` 是 `app`。
  - 保留现有非法输入抛错断言（`null`、字符串、`['']`、含 NUL 的路径）。
  - 测试名 `gate accepts a skipped heavy job only when that class was not required`：mode `docs` 且 `lint` 为 `success`、`app`/`platform`/`npmPack` 为 `skipped`、两个 required 为 false 时通过；任一 required 为 true 时失败。mode `app` 且 `app` 为 `success`、`platformRequired` 为 false、`platform` 为 `skipped` 时通过；`platformRequired` 为 true 且 `platform` 为 `skipped` 时失败；`platform` 为 `success` 时无论 required 都通过。mode `full` 要求 `app`、`platform`、`npmPack` 都是 `success`。`lint` 为 `skipped`/`failure`/`cancelled` 时失败。`cancelled`、`failure`、`''`、`undefined`、`unknown` 在必过位置失败。删掉对单一 `verify` 结果的旧循环。
- [ ] **Step 2:** 跑 `node --test scripts/ci/policy.test.mjs` → 新断言 FAIL（返回值仍是字符串，或 `gatePasses` 还不接受新参数）。
- [ ] **Step 3:** 改 `policy.mjs`。文档判定函数保持现有谓词。`classifyPaths` 在全部为文档时返回 mode `docs` 与四个 false；空列表，或任一路径含 `..`、`.` 段、绝对路径、反斜杠时返回 mode `full`；否则 mode `app`，并按规格路径表填布尔值。门禁基础设施路径把 `platform` 与 `npmPack` 设为 true。导出 `gatePasses`，按规格的 docs / app / full 表实现。CLI 入口读 `MODE`、`CLASSIFY`、`DOCS`、`LINT`、`APP`、`PLATFORM`、`NPM_PACK`、`PLATFORM_REQUIRED`、`NPM_PACK_REQUIRED`（后两个 `'true'` 为 true）。不要把空字符串默认成 `skipped`。同一提交里把 `changes.mjs` 写成 `mode=${result.mode}`，不要把对象拼进 `mode=`。四个布尔键留给任务 2。
- [ ] **Step 4:** 跑 `node --test scripts/ci/policy.test.mjs scripts/ci/changes.test.mjs` → PASS。`changes.test.mjs` 仍只断言 diff 路径，不断言新的四个键。
- [ ] **Step 5:** 提交信息：`test(ci): classify heavy jobs and failed-closed skips`

### 任务 2：把分类写进 GITHUB_OUTPUT
- 修改：nema-room:scripts/ci/changes.mjs
- 修改：nema-room:scripts/ci/changes.test.mjs
- 满足：R-1

- [ ] **Step 1:** 扩展 `changes.test.mjs`。在现有临时仓库断言之后，设置 `GITHUB_OUTPUT` 与 `PATH_LIST_FILE` 指向临时文件，用该仓库的 base 与 head 作为参数执行 `scripts/ci/changes.mjs`。断言输出含五行：`mode=` 为 `app`（fixture 同时有 `README.md` 与被删的非文档路径）、`platform=`、`npm_pack=`、`desktop=`、`image=`，值只有 `true` 或 `false`。其中改名两侧都在路径列表里（现有断言），所以 mode 不是 `docs`。再断言缺 `GITHUB_OUTPUT` 时进程非 0。
- [ ] **Step 2:** 跑 `node --test scripts/ci/changes.test.mjs` → FAIL（还没有 `platform=` 等键）。
- [ ] **Step 3:** `changes.mjs` 调用任务 1 的分类，按键名 `mode`、`platform`、`npm_pack`、`desktop`、`image` 追加到 `GITHUB_OUTPUT`。diff 算法保持 `--no-renames -z`。
- [ ] **Step 4:** 跑 `node --test scripts/ci/changes.test.mjs scripts/ci/policy.test.mjs` → PASS。
- [ ] **Step 5:** 提交信息：`ci: write heavy-job flags to the classify output`

### 任务 3：verify 按输入跳过重型 job，默认全开
- 修改：nema-room:.github/workflows/verify.yml
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-4、R-5

- [ ] **Step 1:** 在 `workflows.test.mjs` 改 `reusable verification` 断言，使它先失败：
  - `workflow_call.inputs` 含 `checkout_ref`（required string）以及 `app_tests`、`platform`、`npm_pack`，三者 `type` 为 boolean、`required` 不是 true、`default` 为 true。
  - `workflow-lint` 的 `if` 仍为 undefined。
  - `test` 的 `if` 表达式是 `inputs.app_tests`，`platform` 的是 `inputs.platform`，`npm-pack` 的是 `inputs.npm_pack`。
  - 工作流 `outputs` 的 `lint`、`app`、`platform`、`npm_pack` 分别等于 `jobs.workflow-lint.result`、`jobs.test.result`、`jobs.platform.result`、`jobs.npm-pack.result`。
  - 现有 Ubuntu 命令列表、`docker compose down` 的 `if: always()`、platform 矩阵 `['macos-latest','windows-latest']`、npm pack 矩阵三系统都还在。
  - 读 `npm-publish` 与 `desktop-release` 的 verify `with`：除 `checkout_ref` 外没有 `app_tests: false`、`platform: false`、`npm_pack: false`。
- [ ] **Step 2:** 跑 `node --test scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3:** 给 `verify.yml` 加上面的输入、job `if` 和 outputs。不改 job 内的步骤、timeout、权限或 action pin。不改 `npm-publish.yml` 与 `desktop-release.yml` 的 `with` 块。
- [ ] **Step 4:** 跑 `node --test scripts/ci/workflows.test.mjs` → PASS。用仓库里已有的 actionlint 1.7.12 命令对 `verify.yml` 跑一遍 → 无 finding。
- [ ] **Step 5:** 提交信息：`ci: let callers skip platform and npm pack jobs`

### 任务 4：PR 快门、main 全量、并发只取消 PR
- 修改：nema-room:.github/workflows/ci.yml
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-4、R-5、R-6

- [ ] **Step 1:** 在 `workflows.test.mjs` 的 CI 断言里改成先失败：
  - `on` 含 `pull_request`、`push.branches` 恰好 `['main']`、`workflow_dispatch`。没有 `paths` / `paths-ignore`，没有 `pull_request_target`，没有 `merge_group`。
  - `concurrency.group` 仍是 `ci-${{ github.ref }}`。`cancel-in-progress` 的表达式是 `github.event_name == 'pull_request'`。
  - `verify.uses` 仍是 `./.github/workflows/verify.yml`，`checkout_ref` 仍是 `github.sha`，没有 `secrets`。
  - `verify.if` 仍只依赖 classify 成功（classify 失败时不调用 verify）。
  - `app_tests` 表达式在 mode 不是 `docs` 时为 true；`platform` 在 mode 是 `full` 或输出 `platform == 'true'` 时为 true；`npm_pack` 同理。
  - `push` 与 `workflow_dispatch` 的分类步骤把 `mode=full`、`platform=true`、`npm_pack=true`、`desktop=false`、`image=false` 写入输出，并且仍写今天那份文档路径 JSON。
  - gate 的 `if` 仍是 `always()`。传给 `policy.mjs` 的 env 含 `MODE`、`CLASSIFY`、`DOCS`、`LINT`、`APP`、`PLATFORM`、`NPM_PACK`、`PLATFORM_REQUIRED`、`NPM_PACK_REQUIRED`，分别来自 classify 输出与 verify 的 job 输出 / 分类标志，不是字面量 `success`。
  - `desktop-release` 的 `cancel-in-progress` 表达式仍含 `!startsWith(github.ref, 'refs/tags/')`。
- [ ] **Step 2:** 跑 `node --test scripts/ci/workflows.test.mjs` → FAIL。
- [ ] **Step 3:** 改 `ci.yml` 实现这些触发、并发、输入和 env。分类 shell 在 `push` 与 `workflow_dispatch` 上不调用 `changes.mjs`。PR 路径仍调用 `changes.mjs`。gate job 名保持 `CI gate`。
- [ ] **Step 4:** 跑 `node --test scripts/ci/workflows.test.mjs scripts/ci/policy.test.mjs` → PASS。actionlint 对 `ci.yml` → 无 finding。
- [ ] **Step 5:** 提交信息：`ci: run the full suite on main and a fast gate on pull requests`

### 任务 5：锁住桌面路径，并在镜像工作流已存在时接上 PR 路径
- 修改：nema-room:scripts/ci/workflows.test.mjs
- 满足：R-4

- [ ] **Step 1:** 加测试 `desktop pull request paths stay equal to the policy desktop class`：解析 `desktop-release.yml` 的 `on.pull_request.paths`，断言深比较等于 `['apps/desktop/**', 'scripts/desktop/**']`。用 `classifyPaths` 断言 `apps/desktop/package.json` 与 `scripts/desktop/smoke-desktop.test.mjs` 的 `desktop` 为 true，`package-lock.json` 与 `apps/web/app/page.tsx` 的 `desktop` 为 false。
- [ ] **Step 2:** 加测试 `image smoke paths are fixed and the workflow is not invented`：`classifyPaths(['Dockerfile'])`、`['docker-compose.yml']`、`['docker-compose.build.yml']`、`['scripts/images/smoke-compose.mjs']`、`['.github/workflows/image-publish.yml']` 的 `image` 为 true；`['apps/web/app/page.tsx']` 的 `image` 为 false。若 `.github/workflows/image-publish.yml` 不存在，断言 `existsSync` 为 false 且测试到此结束。若存在，断言 `on.pull_request.paths` 深比较等于 `['Dockerfile', 'docker-compose.yml', 'docker-compose.build.yml', 'scripts/images/**', '.github/workflows/image-publish.yml']`，publish job 的 `if` 表达式含 `github.event_name == 'push'`，且 plan 步骤在 `pull_request` 上不会把 `verification_required` 设为 true（沿用 tag 或 `verify_full` 才为 true 的现有分支）。
- [ ] **Step 3:** 跑 `node --test scripts/ci/workflows.test.mjs` → 桌面断言若与现状一致则 PASS；image 在文件不存在时 PASS。不要为了让测试变红去删工作流。
- [ ] **Step 4:** 若 image 文件不存在，不创建它，任务到此为止。若存在且路径断言 FAIL，只补 `pull_request.paths` 为 Step 2 的列表，不改 publish 的 `if`，不在 `pull_request` 上把 `verification_required` 设为 true。再跑同一条测试 → PASS。actionlint 只在改过该文件时跑。
- [ ] **Step 5:** 有文件改动才提交。提交信息：`ci: lock desktop and image smoke path filters`

### 任务 6：Agent 指南、台账、发布清单与 supersession
- 修改：nema-room:AGENTS.md
- 修改：nema-room:ROADMAP.md
- 修改：nema-room:CHANGELOG.md
- 修改：nema-room:docs/superpowers/specs/2026-10-26-p0-release-assurance-design.md
- 修改：nema-room:scripts/desktop/RELEASE.md
- 修改：nema-room:scripts/npm/RELEASE.md
- 满足：R-7、R-8、R-9

- [ ] **Step 1:** 在 `AGENTS.md` 的 “Working with other developers and agents” 下加一段英文，四条都要在：把 review 修改合成一次推送；该 ref 的进行中 CI 会被取消，被取消的必过 job 让 `CI gate` 失败是故意的；不要空等 CI，用本地检查继续下一项；不要只为了清除旧 SHA 上的红叉再推一次，算数的是最新一次推送。在 “Setup and verification” 里把「只有文档与 Pages 工作流跳过完整套件；Agent 说明走完整套件」改成与本规格一致的一句：文档白名单跳过应用测试与重型 job；`AGENTS.md` / `CLAUDE.md` 走 Ubuntu 快门；platform 与 npm pack 按 `scripts/ci/policy.mjs` 的路径表；`main` 推送与手动 dispatch 跑完整 `verify.yml`。不要写「可以停下来等 CI」。
- [ ] **Step 2:** `ROADMAP.md`：P1-08 状态改为进行中，依据里加上本规格与本计划的相对链接，验收标准不改成已满足。P0-02 保持进行中，加一句：`strict_required_status_checks_policy` 在维护者按规格 D-9 手工改掉之前仍为 true，本项不因此关闭。不要把 P0-01 标成已完成。
- [ ] **Step 3:** 在 P0 规格 “Require branches to be up to date before merging.” 那句后面加一句英文：该 up-to-date 要求由 `docs/superpowers/specs/2026-10-27-pr-ci-fast-gate-design.md` 取代，实现合入且 `main` 全量成功之后由维护者把 strict 改为 false。不改该规格的其余句子。
- [ ] **Step 4:** 在 `scripts/desktop/RELEASE.md` 的 “Before intentionally creating any tag” 之前加一小段：打 tag 前，该 SHA 在 `main` 上的 `CI` 工作流必须已经成功；缺失、进行中、取消或失败都不打 tag。不要改写 rollout commit `2cd05930c34e5bd601a578fbc01a97e28d08401c` 那段历史（当时 `ci.yml` 确实不在 `main` 推送上跑）。在 `scripts/npm/RELEASE.md` 的 “Automatic publish” 列表第 1 条之前加同一条件。若 `scripts/images/RELEASE.md` 存在，加同一句；不存在则不创建。
- [ ] **Step 5:** `CHANGELOG.md` 的 `## [Unreleased]` 下加 `### Changed` 条目：PR 的 `CI gate` 在文档变更上仍跳过重型检查；其他 PR 跑 Ubuntu 测试与 web build，只在相关路径上跑 macOS/Windows 与 npm pack；推送到 `main` 时跑完整验证。不要写 strict 已经关掉。
- [ ] **Step 6:** 跑 `node --test scripts/ci/*.test.mjs scripts/desktop/release-commit.test.mjs` → PASS。对改过的 Markdown 跑 `node scripts/ci/docs-check.mjs`（把路径列表写成临时 JSON）→ 0 errors。`git diff -- README.md README.en.md README.zh.md README.ja.md` 为空。
- [ ] **Step 7:** 提交信息：`docs: tell agents to batch CI pushes and record the fast gate`
- [ ] **Step 8:** 开 PR。说明里写上规格 D-9 的手工步骤（页面路径、只改 `strict_required_status_checks_policy`、检查名仍是 `CI gate`、integration id 15368、先看到 `main` 全量成功再改、不启用 merge queue）。不要调用 ruleset API，不要打 tag，不要发布，不要合并。PR 自己的 Actions 应跑 platform 与 npm pack（因为改了 `scripts/ci/` 与工作流）；把那次运行的 URL 留在 PR 说明里。合入之后的 `main` 运行才是 R-9 的全量证据，strict 在那之前保持 true。
