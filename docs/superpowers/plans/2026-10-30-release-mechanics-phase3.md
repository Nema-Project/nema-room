# 发布机制 第 3 期：整套验证与晋升 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tag 之后用一次整套验证给出「这一版齐没齐」的单一答案，再由 promote 按固定顺序（npm → GHCR `latest` → GitHub Release publish）翻指针。第一步只上线只读的 `verify-release`，指针仍由三条工作流按现行方式翻；至少经历一次真实发布、报告与注册表实际状态一致且无误报之后，第二步才把翻指针移交 `release-promote`。

**Architecture:** 只读部分全部是 `scripts/release/` 下可单测的 Node 脚本：注册表读取器对每一项返回三态（`ok` / `missing` / `unknown`），汇总成四项证据与一条整体结论。写操作只在第二步的工作流里出现，且每一步写之前都重读当前指针、复用既有判定（`check-images.mjs --move-latest`、`check-tag.mjs`、`release-commit.mjs --verify-remote`），不新写比较逻辑。

**Tech Stack:** Node.js 22（内置 `node:test`、`fetch`），GitHub REST API，npm registry JSON，GHCR 匿名 token + OCI distribution API，GitHub Actions（钉 SHA），`gh` CLI，crane `0.22.1`（已在 image-publish 使用）。不新增 npm 依赖。

**North star:** 本计划服务于 [issue #45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准：让人和 agent 更容易对项目保持有证据支撑的共同理解。本期把「v<x.y.z> 是否是一套完整、可推荐安装的版本」从靠人逐个打开 Release、npm、GHCR 核对，变成一条命令给出的、逐项带来源的记录；晋升中途失败时，记录写明哪些指针已翻、哪些没翻，而不是让维护者去猜。这里的「就绪」只断言产物存在且彼此一致，**不是**测试通过、真机验收或 CX 验收（规格反目标 5）。不把 Nema Room 写成编排器或发布平台；不宣称跨注册表原子性。

**Spec:** `docs/superpowers/specs/2026-10-28-release-mechanics-design.md`：第 103–111 行「第 3 期：整套验证与晋升」整节、第 79 行（两步上线）、第 97 行（整套就绪定义）、第 113–118 行（问题 1 **已选 A**：verify 通过后自动翻完三个指针，不另设人工确认格）、第 122–132 行「留给实现者」、验收第 6、7、8、9 条。动手前读全文。另读 [#63](https://github.com/Nema-Project/nema-room/issues/63) 的「发布事务边界」一节与其五个部分失败场景。

**Base:** `4601de5a6f73a726a014ffff073c5bc8e20caf06`（写本计划时的 `origin/main`，Merge pull request #100）。动手前：

```sh
git fetch origin main
git merge-base --is-ancestor 4601de5a6f73a726a014ffff073c5bc8e20caf06 HEAD
git diff --name-only 4601de5a6f73a726a014ffff073c5bc8e20caf06..HEAD -- .github/workflows scripts/images scripts/npm scripts/desktop scripts/install scripts/release
```

ancestry 必须成功。第二条命令若列出下文「核对的代码」里提到的文件，先对照新内容改本计划，再写代码。

## 本期的权限阻塞（先读）

本仓库的自动化凭据（`gh` 的 token）**没有 `workflow` scope**，无法推送任何改动 `.github/workflows/**` 的提交（GitHub 会拒绝整个 push）。本期因此分成两段：

| 部分 | 任务 | 是否改工作流 | 谁能推送 |
| --- | --- | --- | --- |
| 第一步：只读验证 | 任务 1–7 | 否 | agent 可独立完成并开 PR |
| 第二步：晋升的脚本部分 | 任务 8–9 | 否 | agent 可在分支上准备，但**不单独合并**（见下） |
| 第二步：工作流部分 | 任务 10–13 | **是** | **需要维护者用带 `workflow` 权限的凭据推送** |
| 第二步：演练与上线 | 任务 14–15 | 部分是 | 依赖任务 10–13，且依赖下一次真实发布 |

需要维护者提供带 `workflow` 权限推送的步骤，逐一列出：

1. 任务 10：`.github/workflows/npm-publish.yml`（tag 推送不再发布；publish 改由 dispatch 触发并加幂等判定）。
2. 任务 11：`.github/workflows/image-publish.yml`（删除 publish 作业里的 `Move latest for a stable release` 一步）。
3. 任务 12：`.github/workflows/desktop-release.yml`（publish 作业只到 draft，去掉最后的 `gh release edit --draft=false`）。
4. 任务 13：新增 `.github/workflows/release-promote.yml`。
5. 上面四项对应的 `scripts/ci/workflows.test.mjs` 契约更新：它断言工作流内容，必须与工作流同一提交落地，否则 CI 红。所以这一个提交整体需要带 `workflow` 权限的推送。

做法：agent 在第二步分支上提交任务 8–9（纯脚本），并把任务 10–13 的工作流改动与契约测试做成一个**未推送的本地提交**，导出为 `git format-patch` 文件交给维护者；维护者审阅后用自己的凭据推送到同一分支（或授予带 `workflow` scope 的凭据）。在那之前第二步 PR 不合并：任务 8–9 的脚本只有 promote 工作流一个调用者，单独合并会在 main 上留下没有入口的代码。

另外两条与权限无关的上线门：

- 第二步上线前提（规格第 79、118 行）：第一步落地后**至少一次真实发布**（下一个 tag，预计 `v0.1.7`）由维护者跑 `verify-release`，报告与注册表实际状态一致、无误报。对已发布的 `v0.1.6` 回溯运行的结果算演练证据，**不**算这次真实发布。
- 本计划不打 tag、不发版。任务 7、15 里需要真实发布的步骤由维护者在其发布授权内执行。

## 写本计划时核对的代码（4601de5）

下面每条都在基线上读过，或在 2026-10-30 实测过（时间为 Asia/Tokyo）。

- `.github/workflows/npm-publish.yml`（168 行）：`on.push.tags: ['v*']` 与 `workflow_dispatch`（无 inputs）。publish 作业第 115 行起，第 118 行 `if: ${{ github.event_name == 'push' && needs.verify.result == 'success' && needs.build.result == 'success' }}`，所以 dispatch 今天只打包冒烟。publish 步骤两次重取 tag 比对 SHA、查 main 祖先、跑 `check-tag.mjs` 得出 `latest`/`next`，第 168 行 `npm publish --provenance --access public --tag "$dist" "./$tarball"`。**npm 的 `latest` dist-tag 在 publish 的同一刻移动**，没有单独的「翻 npm 指针」动作。
- `.github/workflows/image-publish.yml`（386 行）：publish 作业第 245 行，作业级 `concurrency.group: image-publish-registry`（第 249–250 行）；第 291 行 `Push the verified layouts` 推两个版本 tag；第 310 行 `Move latest for a stable release`（`if: needs.plan.outputs.prerelease == 'false'`）用 `crane config <ref>:latest` 读 `org.opencontainers.image.version` 标签、`check-images.mjs --move-latest` 判定、重验 tag 后 `crane tag`；`MANIFEST_UNKNOWN` 视为空、其它读取错误拒绝移动。
- `.github/workflows/desktop-release.yml`（374 行）：publish 作业第 315 行 `Stamp the Compose asset`、第 322 行 `Verify the complete asset set`、第 331 行拒绝已发布 Release 并校验可复用 draft、第 352 行 `Create or reuse draft, upload, publish`：建/复用 draft → upload → 比对 `expected`/`actual` → 重验 tag → 第 374 行 `gh release edit "$TAG" --draft=false "${flags[@]}"`。预发布带 `--prerelease --latest=false`；稳定版不显式传 `--latest`。
- `scripts/images/check-images.mjs`：第 140 行 `shouldMoveLatest(current, next)`，`current` 为空或不比 `next` 新时返回 true（相等也移动，重跑安全）；CLI `--move-latest <current-or-empty> <next>` 打印 `move`/`keep`（第 172–175 行）。
- `scripts/install/release-set.mjs`（93 行）：`checkReleaseSet` 检查 compose 资产、两个镜像匿名 manifest、npm 版本。**网络错误、超时、JSON 不可解析一律算缺件**（安装器语义：宁可失败不猜）。它不读镜像标签、不读 Release 资产集、不读 provenance。
- `scripts/desktop/release-manifest.mjs`：`collectReleaseManifest` 产出 `release-manifest-<v>.json`（`schemaVersion`、`version`、`prerelease`、`targets`、`build{commit,ref,runId,repository}`、`compose{name,size,sha256}`），并写 `SHA256SUMS-<v>.txt`。manifest 的 `targets` 不列 manifest 自己和合并校验和文件。
- `scripts/ci/workflows.test.mjs`（397 行）：第 182 行「npm publish uses OIDC on a verified tag and skips a dry run」断言 `condition(publish.if, context('workflow_dispatch','success')) === false`、`publish.permissions` 正好是 `contents`+`id-token`；第 233 行「release gates bind all stages…」断言 publish 步骤含 `--draft=false`；第 288 行用 `gh` 桩跑 `Create or reuse draft, upload, publish`，以 `--draft=false` 落下的标记文件判定「已公开」；第 331 行起断言 `Move latest` 一步存在（第 368–373 行）。第二步必须改写这几条，不能删覆盖。
- `.github/workflows/verify.yml` 第 113 行：`node --test scripts/ci/*.test.mjs scripts/images/*.test.mjs … scripts/release/*.test.mjs`。放在 `scripts/release/` 下的新测试自动进 CI，无需改工作流。
- 根 `package.json` 第 29–30 行有 `release:cut`、`release:stamp`，没有 `release:verify`。

2026-10-30 对 `v0.1.6` 的实测（这些是 verify-release 要复现的事实）：

- `gh release view v0.1.6`：`isDraft=false`、`isPrerelease=false`，资产 8 个：`docker-compose.yml`、`Nema-0.1.6-darwin-arm64.dmg`、`Nema-0.1.6-win32-x64.exe`、`Nema-0.1.6-win32-x64.zip`、`release-manifest-0.1.6.json`、`SHA256SUMS-0.1.6-darwin-arm64.txt`、`SHA256SUMS-0.1.6-win32-x64.txt`、`SHA256SUMS-0.1.6.txt`。`release-manifest-0.1.6.json` 的 `build.commit` 是 `280b224589ae13d4db99a4481bcd0baf58cf273d`，`compose.sha256` 是 `a17f6370…b9252`。期望集 = `targets` 里全部名字 + `compose.name` + `SHA256SUMS-<v>.txt` + `release-manifest-<v>.json`，与实际 8 个一致。
- npm：`GET https://registry.npmjs.org/@nema-project/nema/0.1.6` 返回 `version: 0.1.6`、`dist.integrity: sha512-…`、`dist.attestations.url`；`GET /-/package/@nema-project/nema/dist-tags` 返回 `{"latest":"0.1.6"}`。provenance（`/-/npm/v1/attestations/@nema-project%2fnema@0.1.6`，SLSA v1）记录 `workflow.path: .github/workflows/npm-publish.yml`、`ref: refs/tags/v0.1.6`、`resolvedDependencies[0].digest.gitCommit: 280b224…`、`event_name: push`。注意：这是 registry 报告的 provenance 内容，读 JSON **不等于**验证 Sigstore 签名。
- GHCR 匿名：`GET https://ghcr.io/token?service=ghcr.io&scope=repository:nema-project/nema-room-hub:pull` 拿 token，`/v2/nema-project/nema-room-hub/manifests/0.1.6` 返回 200、`application/vnd.oci.image.index.v1+json`。**索引是两层**：顶层 index 的唯一条目没有 `platform`，本身又是一个 index；第二层里是 `linux/amd64` 镜像 manifest 和一个 `unknown/unknown` 的 attestation。`linux/amd64` manifest 的 config blob 里 `Labels` 有 `org.opencontainers.image.version: 0.1.6` 与 `org.opencontainers.image.source`，**没有** `org.opencontainers.image.revision`，所以镜像无法与 tag 提交直接比对。web 同构。`latest` 与 `0.1.6` 解析到同一 digest。
- GitHub API 匿名访问看不到 draft Release；第二步的候选预检要看 draft，必须带 token。

## 与规格不一致、按代码与实测写的地方

1. **镜像版本标签藏在两层索引之下。** 规格第 105 行第 (4) 项写「两镜像的 `org.opencontainers.image.version` 标签」。实测要沿 顶层 index → 无 platform 的子 index → `linux/amd64` manifest → config blob 才读得到；attestation 条目（`unknown/unknown`）必须跳过。读取器按这个结构写，并对「找不到 `linux/amd64`」给出 `missing` 而不是崩溃。
2. **verify-release 用三态，不沿用 release-set 的「网络错误算缺件」。** 安装器把无应答当缺件是对的（拒绝写 `.env`）；报告工具若这样做，一次网络抖动就会报「web 镜像缺失」，正是规格第 141 行要排除的误报。所以 `missing` 只在权威否定时给出（npm/GHCR/GitHub 返回 404 或 `MANIFEST_UNKNOWN`、资产集确实缺名字），其它失败一律 `unknown`，退出码不同（见任务 3）。`release-set.mjs` 不改。
3. **第一步不自动运行。** 规格第 79 行只要求只读验证「只报告、不翻指针」。让它在三条工作流之后自动跑需要新工作流或 `workflow_run` 触发，属于改工作流。第一步改为由维护者在三条工作流结束后手动运行 `npm run release:verify -- <x.y.z>`，写进三份 `RELEASE.md`；自动运行随第二步的 `release-promote.yml` 一起出现。
4. **npm 指针不能独立于发布移动。** `npm publish --tag latest` 本身就是翻指针。规格第 108 行要求「每次移动 npm latest 前重读并禁止倒退」，所以 promote 在发布前读 `dist-tags.latest`，若比本版新，稳定版改用 `--tag maintenance` 发布（`maintenance` 不是合法 SemVer range，npm 接受），不碰 `latest`。预发布仍是 `next`（`check-tag.mjs` 现行规则）。这是规格未写明的具体取值，本计划定下，不留给实现者。
5. **GitHub latest 要显式给。** 现行 desktop-release 稳定版不传 `--latest`，由 GitHub 按默认规则决定。规格第 106 行要求「仅稳定版显式更新 GitHub latest」。promote 的最后一步：稳定且不比当前 latest Release 旧 → `--latest`；稳定但更旧 → `--latest=false`；预发布 → `--prerelease --latest=false`。
6. **npm 已存在时的「一致」判定依赖打包可复现。** 规格第 107 行要求把 registry tarball 的完整性与候选打包产物比较，一致视为完成，不同则拒绝。重跑 promote 会重新打包；若 `npm run cli:pack` 在同一 SHA 上不逐字节可复现，重跑将永远被拒。任务 9 先实测（同一 SHA 打包两次比 `sha512`）。**若不可复现，停下，先改规格再继续**，不在实现里悄悄改成「provenance 里的提交相同就算一致」。provenance 只作为额外证据写进报告。
7. **dispatch 能否被 GITHUB_TOKEN 触发、trusted publisher 是否接受 dispatch 事件，要实测。** GitHub 文档写明 `GITHUB_TOKEN` 触发的事件中只有 `workflow_dispatch` 和 `repository_dispatch` 会创建新运行；npm trusted publisher 绑定的是仓库与工作流文件名（可选 environment），不绑事件类型。两条都是文档结论，任务 10 的第一个 dispatch 演练必须实测记录，任一不成立就停。

## Global Constraints

- 本计划 15 个任务，不超上限。第一步（任务 1–7）一个 PR；第二步（任务 8–15）一个 PR，其中任务 10–13 需维护者推送（见上）。
- 本文件只写计划：不改生产代码、工作流、校验器，不改 `CHANGELOG.md`、`ROADMAP.md`，不关闭 #63。
- 不打 tag，不发版，不从 CI 创建 tag，promote 不合并 PR（规格第 110 行）。
- 不存长期凭据：npm 仍用 OIDC trusted publishing，GHCR 与 Release 仍用 `GITHUB_TOKEN`。不新增 secret。
- 不放宽任何既有 fail-closed 校验（规格非目标第 1 条）：verify 绑同一 SHA、tag 防移动、OCI layout 字节一致、draft 资产集精确比对、`latest` 防倒退全部保留，只移动「翻指针」的时机。
- `npm-publish.yml` 不改名（trusted publisher 绑定）。
- 「就绪」只表示产物存在且一致。报告、summary、文档里不得写成测试通过、真机验收或 CX 验收通过。
- 第一步 verify-release 只读：不调用任何写接口，不需要也不读取 `NPM_TOKEN`；`GITHUB_TOKEN` 只在设置时用于读 draft。
- 代码、注释、提交信息用英文；本文件用中文。工作流 shell 一律 `set -euo pipefail`，Actions 钉完整 SHA。
- 测试一律用注入的 `fetchImpl` 与临时目录，不访问真实注册表；真实注册表只在任务 7、15 的人工演练里读。
- 维护者工具不是用户可见行为：第一步不加 changelog 片段。第二步改变了「Release 何时出现在 latest」这一公开可见时序，加 `changelog.d/release-promote.changed.md`（任务 14）。
- 不碰插件页 #97、MCP 相关文件、证据回流任务 12 相关文件。

## 实现者选择（已定）

1. **模块划分。** `scripts/release/registry-read.mjs`（npm、GHCR、GitHub 三类读取器，全部三态）、`scripts/release/verify-release.mjs`（汇总、判定、报告、CLI）。不把读取器塞进 `scripts/install/`：安装器与报告工具的失败语义不同（见不一致第 2 条）。
2. **三态结果。** 每个读取器返回 `{ state: 'ok' | 'missing' | 'unknown', detail, evidence }`。`missing` 只来自权威否定；超时、5xx、429、JSON 解析失败、token 拿不到一律 `unknown`，`detail` 写原因。每个请求超时 15 秒、对 `unknown` 重试 2 次（间隔 2 秒、4 秒），`missing` 不重试。
3. **退出码。** 0 = 四项全部 `ok`；1 = 至少一项 `missing`（版本不完整）；2 = 没有 `missing` 但至少一项 `unknown`（无法判定，不得当作缺件，也不得当作就绪）；64 = 用法错误。
4. **阶段参数。** `--stage final`（默认）：Release 必须已发布；第一步期间若仍是 draft，**报告注明 draft、不算缺件**（规格第 105 行），该项给 `ok` 并在 evidence 标 `draft`。`--stage candidate`（第二步预检用）：Release 必须是 draft；npm 版本允许不存在，存在时必须与候选一致（任务 9）。
5. **输出。** 默认人读文本，一项一行，`ok`/`MISSING`/`UNKNOWN` 打头，缺项一眼可见；`--json` 输出机器可读结构供 promote 写 summary。
6. **指针读取。** `--pointers` 只读输出当前 `npm dist-tags`、两个 GHCR `latest` 的版本标签、GitHub latest Release 的 tag，以及对给定版本的 `move`/`keep` 判定（复用 `shouldMoveLatest`）。第一步就提供，供维护者核对，也是 promote 防倒退的读取函数。

## Review Focus

1. 网络失败会不会被报成缺件（误报），或者 `unknown` 被当成就绪（漏报）。→ 任务 1–3。
2. 两层索引与 attestation 条目是否处理对，`linux/amd64` 缺失时是否给 `missing` 而不是抛异常。→ 任务 1。
3. 资产集比对是否同时抓「少了」和「多了」，`docker-compose.yml` 是否与 manifest 的 `sha256`、`stamp` 渲染出的版本一致。→ 任务 2。
4. 三处版本、三处提交（tag、Release manifest `build.commit`、npm provenance）是否逐一比对，镜像缺 `revision` 标签这一点是否如实写进报告而不是假装比对过。→ 任务 3。
5. 第一步是否真的只读：代码里不得出现任何写接口。→ 任务 3、5。
6. 第二步每一次翻指针前是否重读、是否复用既有判定，失败后 summary 是否列明已翻与未翻。→ 任务 8、13、14。
7. npm 幂等：已存在且一致 → 跳过；已存在但不同 → 拒绝；查询出错 → 停，不当作不存在。→ 任务 9、10。
8. 工作流改动是否全部列为需维护者推送，是否有任何一条混进 agent 可推送的提交。→ 任务 10–13。

---

## 第一步：只读验证（不改工作流）

### Task 1: npm 与 GHCR 读取器

**Files:**
- Add: `scripts/release/registry-read.mjs`
- Test: `scripts/release/registry-read.test.mjs`

**Interfaces:**
- `readNpmVersion({ fetchImpl, version })`：`GET https://registry.npmjs.org/@nema-project/nema/<version>`。200 且 `body.version === version` → `ok`，evidence 含 `dist.integrity`；404 → `missing`；其它 → `unknown`。
- `readNpmProvenance({ fetchImpl, version })`：读 `/-/npm/v1/attestations/@nema-project%2fnema@<version>`，从 SLSA v1 predicate 取 `workflow.path`、`workflow.ref`、`resolvedDependencies[0].digest.gitCommit`、`event_name`。返回值注明 `signatureVerified: false`。
- `readNpmDistTags({ fetchImpl })`：`/-/package/@nema-project/nema/dist-tags`。
- `readImage({ fetchImpl, repository, reference })`：匿名 token → manifest（`Accept` 同 `release-set.mjs` 的四种类型）→ 若是 index 则递归（最多 3 层）找 `platform.os == 'linux' && platform.architecture == 'amd64'`，跳过 `unknown/unknown` → config blob → `Labels['org.opencontainers.image.version']`。evidence 含顶层 digest、平台 manifest digest、版本标签。manifest 404 / `MANIFEST_UNKNOWN` → `missing`；找不到 `linux/amd64` → `missing`（detail 写明）；标签缺失 → `ok` 但 `label: null`（由任务 3 判不一致）。

- [ ] **Step 1: 写失败测试**：用注入的 `fetchImpl` 返回夹具。夹具照抄 v0.1.6 实测结构（两层 index + attestation 条目，config 有 `version`/`source` 无 `revision`）。用例：npm 200/404/500/超时/坏 JSON 分别得到 `ok`/`missing`/`unknown`/`unknown`/`unknown`；`unknown` 重试 2 次后仍 `unknown`，`missing` 只请求 1 次；GHCR token 失败 → `unknown`；manifest 404 → `missing`；两层 index 读出 `0.1.6`；只有 attestation 条目 → `missing`；provenance 读出 `280b224…` 且 `signatureVerified === false`。
- [ ] **Step 2: 跑** `export PATH=/tmp/node-v22.20.0-linux-x64/bin:$PATH && node --test scripts/release/registry-read.test.mjs` → FAIL。
- [ ] **Step 3: 实现。** 镜像名用 `check-images.mjs` 导出的 `HUB_IMAGE`、`WEB_IMAGE` 推出仓库路径，不再手写一份。
- [ ] **Step 4: 跑** 同一命令 → PASS。
- [ ] **Step 5: Commit** `feat(release): read npm and GHCR release facts with a tri-state result`

### Task 2: GitHub tag 与 Release 读取器

**Files:**
- Modify: `scripts/release/registry-read.mjs`
- Test: `scripts/release/registry-read.test.mjs`

**Interfaces:**
- `readTagCommit({ fetchImpl, token, tag })`：`GET /repos/Nema-Project/nema-room/git/ref/tags/<tag>`，annotated tag 再跟一次 `/git/tags/<sha>`，返回提交 SHA。
- `readRelease({ fetchImpl, token, tag })`：`GET /repos/…/releases/tags/<tag>`。无 token 时 draft 不可见：404 → `missing` 且 detail 写「not published, or a draft that needs a token to see」。返回 `isDraft`、`isPrerelease`、资产名列表、资产下载地址。
- `readReleaseManifest(...)`、`readComposeAsset(...)`：下载 `release-manifest-<v>.json` 与 `docker-compose.yml`（跟随跳转）。
- `expectedReleaseAssets(manifest)`：`targets` 全部名字 + `compose.name` + `SHA256SUMS-<v>.txt` + `release-manifest-<v>.json`。
- 有 `GITHUB_TOKEN` 时带 `Authorization`；没有时匿名。token 只用于读。

- [ ] **Step 1: 写失败测试**：轻量 tag 与 annotated tag 都解析到提交；v0.1.6 的 8 个资产与期望集相等；少一个、多一个各自报出名字；manifest 缺 `compose` 键（v0.1.5 及以前的形态）→ compose 资产 `missing`；compose 资产的 `sha256` 与 manifest 不符 → `missing`（detail 写两个值）；`composeAssetVersion` 读出的版本与给定版本不同 → `missing`。
- [ ] **Step 2–4:** 同任务 1 的跑法，先 FAIL 后 PASS。
- [ ] **Step 5: Commit** `feat(release): read the tag commit and the release asset set`

### Task 3: verify-release 汇总与判定

**Files:**
- Add: `scripts/release/verify-release.mjs`
- Test: `scripts/release/verify-release.test.mjs`

**Interfaces:**
- `verifyRelease({ version, stage = 'final', fetchImpl, token })` → `{ version, stage, items: [{ id, state, detail, evidence }], overall, exitCode }`。
- 四项（规格第 105 行）：
  1. `npm`：版本存在、`integrity` 可读；附 provenance 的工作流路径、ref、提交（只读、未验签）。
  2. `images`：hub 与 web 两个 `<x.y.z>` tag 匿名可读、`linux/amd64` 可解析。
  3. `release`：`v<x.y.z>` 存在，资产集等于期望集且含 `docker-compose.yml`，compose 资产 sha256 与 manifest 相符、双镜像 pin 等于版本。
  4. `consistency`：npm 版本、两镜像 `org.opencontainers.image.version`、Release tag、manifest `version` 全部等于 `<x.y.z>`；tag 提交 = manifest `build.commit` = npm provenance 提交。镜像没有 `revision` 标签：报告写「images carry no revision label; commit not compared」，**不**标 `ok` 为已比对。
- 第一步 `final` 阶段遇到 draft：第 3 项 `ok`，evidence `draft: true`，结论行写「release is still a draft; the GitHub latest pointer has not moved」。
- `overall`：任一 `missing` → `incomplete`（1）；否则任一 `unknown` → `undetermined`（2）；否则 `complete`（0）。
- 模块里不得出现 `method: 'POST'|'PUT'|'PATCH'|'DELETE'`，测试用源码断言守住。

- [ ] **Step 1: 写失败测试**，覆盖 #63 列出的部分失败场景，每个都断言非零退出与点名缺项：只有 hub 镜像（web `missing`，规格验收 6 的例子）；只有桌面 Release（npm 与镜像 `missing`）；npm 未发；镜像不可匿名访问（token 403 → `unknown`，退出 2，**不**报缺件）；Release 缺 `docker-compose.yml`；tag 提交与 manifest `build.commit` 不同；npm provenance 提交不同。完整一套退出 0 并逐项列出四项证据。源码不含写方法。
- [ ] **Step 2–4:** `node --test scripts/release/*.test.mjs`，先 FAIL 后 PASS。
- [ ] **Step 5: Commit** `feat(release): verify a released version as one set`

### Task 4: 指针读取与防倒退判定

**Files:**
- Modify: `scripts/release/verify-release.mjs`
- Test: `scripts/release/verify-release.test.mjs`

**Interfaces:**
- `readPointers({ fetchImpl, token })` → `{ npm: { latest, next }, ghcr: { hub, web }, github: { latest } }`，每个值带三态。GHCR `latest` 的版本取 `linux/amd64` config 的版本标签；`latest` 不存在 → `null`（与 image-publish 对 `MANIFEST_UNKNOWN` 的处理一致）。GitHub latest 用 `GET /repos/…/releases/latest`。
- `pointerDecisions(pointers, version, prerelease)`：对每个指针给 `move`/`keep`/`skip`（预发布对所有稳定指针给 `skip`），比较只调用 `shouldMoveLatest`。任一指针读到 `unknown` → 该指针判定为 `unknown`，promote 遇到它必须停。

- [ ] **Step 1: 写失败测试**：当前 0.1.6、本版 0.1.7 → 全部 `move`；当前 0.1.7、本版 0.1.6 → 全部 `keep`；相等 → `move`；预发布 → `skip`；GHCR `latest` 不存在 → `move`；hub 0.1.7、web 0.1.6（移动 latest 中途失败的残局）→ hub `keep`、web `move`（本版 0.1.7 时两者都 `move`）；dist-tags 请求 500 → `unknown`。
- [ ] **Step 2–4:** 同上。
- [ ] **Step 5: Commit** `feat(release): read the latest pointers and decide without moving them backward`

### Task 5: CLI 与 npm script

**Files:**
- Modify: `scripts/release/verify-release.mjs`
- Modify: `package.json`（新增 `"release:verify": "node scripts/release/verify-release.mjs"`）
- Test: `scripts/release/verify-release.test.mjs`

**Interfaces:**
- `node scripts/release/verify-release.mjs <x.y.z> [--stage final|candidate] [--json]`
- `node scripts/release/verify-release.mjs --pointers [<x.y.z>] [--json]`
- 版本用 `scripts/desktop/release-version.mjs` 的严格 SemVer 解析，带 `v` 前缀、`latest`、空值退出 64。
- 读 `GITHUB_TOKEN` 环境变量（存在时）；不读、不打印其它凭据；token 值不出现在任何输出里。

- [ ] **Step 1: 写失败测试**：`spawnSync` 跑 `--help`、坏版本（64）、未知参数（64）；`GITHUB_TOKEN=secret-value` 时 stdout/stderr 都不含 `secret-value`（用注入 fetch 的模块级测试覆盖，CLI 层只测参数）。
- [ ] **Step 2–4:** 同上。
- [ ] **Step 5: Commit** `feat(release): add the release:verify command`

### Task 6: 文档

**Files:**
- Modify: `scripts/npm/RELEASE.md`、`scripts/images/RELEASE.md`、`scripts/desktop/RELEASE.md`、`CONTRIBUTING.md`（发布一节）
- Modify: `ROADMAP.md`（P1-09 行）

**内容：**
- 三份 `RELEASE.md` 的「tag 之后」加一段：三条工作流都结束后运行 `npm run release:verify -- <x.y.z>`，把输出（含退出码）记进该版的 ROADMAP 记录；退出 1 时点名的缺项就是要处理的部分发布，退出 2 是无法判定、隔一段时间重跑，不得当作缺件或就绪。写明本步只读、指针时机不变，「就绪」不是测试或验收通过。
- `scripts/desktop/RELEASE.md` 的「Anonymous download and hash verification」第 4 条后补一句：`release:verify` 覆盖资产集、manifest 提交与 compose 资产，仍需按原步骤做匿名下载与哈希核对。
- `CONTRIBUTING.md` 发布准备之后的步骤列表加同一条命令。
- ROADMAP P1-09：第 3 期第一步已合入（附 PR 与 SHA）；第二步待维护者推送工作流、且待一次真实发布的只读报告。不标 #63 完成。
- 不加 changelog 片段（维护者工具，不改变用户可见行为）。

- [ ] **Step 1:** 改文档。
- [ ] **Step 2: 跑** `node scripts/ci/docs-check.mjs <paths.json>`（参数是 JSON 数组文件）、`git diff --check`、`cmp README.md README.en.md`（本任务不该动它们，确认没动）。
- [ ] **Step 3: Commit** `docs(release): run release:verify after the tag workflows`

### Task 7: 对真实版本的只读演练

不改文件，产出写进第一步 PR 描述与 ROADMAP。

- [ ] **Step 1:** `npm run release:verify -- 0.1.6`：期望退出 0，四项证据与上文实测一致（8 个资产、`build.commit` 与 provenance 都是 `280b224…`、两镜像标签 `0.1.6`）。
- [ ] **Step 2:** `npm run release:verify -- 0.1.5`：期望退出 1，点名 Release 缺 `docker-compose.yml`（v0.1.5 早于固定名资产）。如实记录其它项的结果。
- [ ] **Step 3:** `npm run release:verify -- 9.9.9`：期望退出 1，四项都 `missing`。
- [ ] **Step 4:** `npm run release:verify -- --pointers 0.1.6`：记录当前指针（应全部为 0.1.6，判定 `move`，即「相等可安全重设」）。
- [ ] **Step 5:** 在没有网络的命名空间里跑一次（`unshare -rn npm run release:verify -- 0.1.6`，本机已确认 `unshare -rn` 可用）：期望退出 2、没有一项是 `missing`。
- [ ] **上线门记录：** 以上是演练。规格要求的「至少一次真实发布」要等下一个 tag 由维护者运行并核对，结果记入 ROADMAP 后，才能开始任务 15。

---

## 第二步：晋升（工作流部分需维护者推送）

第二步开工前提：任务 1–7 已合入 main。上线（任务 15）前提：一次真实发布的只读报告无误报。

### Task 8: promote 编排脚本

**Files:**
- Add: `scripts/release/promote.mjs`
- Test: `scripts/release/promote.test.mjs`

**Interfaces:**
- `promote({ version, tag, commit, prerelease, io, summary })`，`io` 注入全部外部动作（`verify`、`readPointers`、`dispatchNpm`、`waitNpm`、`moveGhcrLatest`、`publishRelease`、`verifyRemoteTag`），测试用桩，工作流里接真实命令。
- 固定顺序：候选预检（`verify-release --stage candidate`）→ npm（发布或确认已存在）→ 完整 verify（`--stage final`，此时要求 npm 存在，Release 仍为 draft 允许）→ 两个 GHCR `latest`（每个移动前重读、`--move-latest` 判定、重验 tag）→ Release publish（重读 GitHub latest，按「不一致第 5 条」给 `--latest` 或 `--latest=false`）。
- 任一步 `missing`/`unknown`/异常即停，后续指针不翻。`summary` 每完成一步追加一行，失败时追加「已翻 / 未翻」两张清单，并标明「部分成功窗口」（npm 与 GHCR 别名可能短暂不一致）。
- 重跑幂等：已完成的步骤由重读结果识别为完成（npm 已存在且一致、`latest` 已等于本版、Release 已发布且是本版），只补未完成的步骤。不回滚不可变包，不强移版本 tag。

- [ ] **Step 1: 写失败测试**（规格验收 7）：全成功的顺序与 summary；npm 一步失败 → GHCR 与 Release 未动、summary 列明；GHCR hub 成功 web 失败 → Release 未动、summary 列明 hub 已翻 web 未翻；任一稳定指针已更高 → 该指针 `keep`、不倒退；预发布 → 不动任何稳定指针、Release 带 `--prerelease --latest=false`；tag 在中途移动 → 停；npm 已存在且一致 → 跳过发布继续；已存在但不同 → 拒绝；npm 成功后 GHCR 失败再重跑 → 不再次发布 npm、补完 GHCR 与 Release。
- [ ] **Step 2–4:** `node --test scripts/release/*.test.mjs`，先 FAIL 后 PASS。
- [ ] **Step 5: Commit** `feat(release): sequence the promote steps with rereads and a pointer record`

### Task 9: npm 已存在时的一致性判定

**Files:**
- Add: `scripts/release/npm-state.mjs`
- Test: `scripts/release/npm-state.test.mjs`

**Interfaces:**
- `npmPublishState({ fetchImpl, version, tarballPath })` → `absent` | `same` | `different` | 抛错。`absent` 只在 registry 对该精确版本返回 404 时给出；网络、鉴权、5xx、解析错误抛错（规格第 107 行：不能当作不存在）。`same` = 本地 tarball 的 `sha512` 与 `dist.integrity` 相等。
- 并发冲突：`npm publish` 失败后调用方必须再调一次本函数，`same` 才算成功。

- [ ] **Step 0: 实测可复现性。** 在同一 SHA 上 `npm run cli:pack` 两次（干净 `dist-npm`），比对两个 tarball 的 `sha512`。记录结果。**不同则停下**，回到规格第 107 行改写判定方式并经维护者确认，再继续（见「不一致」第 6 条）。
- [ ] **Step 1: 写失败测试**：404 → `absent`；200 且 integrity 相等 → `same`；不等 → `different`；500、超时、坏 JSON → 抛错且错误信息说明「cannot tell whether <version> exists」。
- [ ] **Step 2–4:** `node --test scripts/release/npm-state.test.mjs`，先 FAIL 后 PASS。放在 `scripts/release/` 而不是 `scripts/npm/`：基线上没有任何工作流跑 `scripts/npm/*.test.mjs`，而 verify.yml 第 113 行已经跑 `scripts/release/*.test.mjs`。npm-publish 的 publish 作业不 checkout，只用上传的产物，所以任务 10 要把 `scripts/release/npm-state.mjs` 加进 build 作业的 `Upload packed tarball` 路径列表。
- [ ] **Step 5: Commit** `feat(npm): tell an existing identical version from a conflicting one`

### Task 10: npm-publish 改为由 promote 触发（**需维护者 workflow 权限推送**）

**Files:**
- Modify: `.github/workflows/npm-publish.yml`
- Modify: `scripts/ci/workflows.test.mjs`（第 182 行那条用例）

**改动：**
- 保留 `on.push.tags`：tag 推送仍跑 verify 与 build（打包、冒烟、上传 tarball 产物），**publish 作业不再在 push 上运行**。
- `workflow_dispatch` 增加 input `publish`（boolean，默认 false）。publish 作业条件改为 `github.event_name == 'workflow_dispatch' && inputs.publish && github.ref_type == 'tag'` 且 verify、build 成功。默认 dispatch 仍只打包冒烟（保持现行语义）。
- build 作业的 `Upload packed tarball` 路径列表加入 `scripts/release/npm-state.mjs`（publish 作业不 checkout）。
- publish 步骤原有的两次重取 tag、main 祖先、`check-tag.mjs` 全部保留；`npm publish` 之前加 `npm-state.mjs`：`same` → 打印并以 0 结束；`different` → 失败；`absent` → 读 `dist-tags.latest`，稳定版且 latest 更新时用 `--tag maintenance`，否则用 `check-tag` 给出的 dist-tag 发布；发布失败后再查一次，`same` 才算成功。
- 文件名不变。演练（任务 14）必须记录：`GITHUB_TOKEN` 发起的 dispatch 确实创建了运行；trusted publishing 在 dispatch 事件下成功，provenance 的 `event_name` 为 `workflow_dispatch`。
- 契约测试改写为：push 不发布、带 `publish=true` 的 tag 上 dispatch 才发布、非 tag ref 不发布；`permissions` 仍正好是 `contents` + `id-token`；`npm-state` 在 `npm publish` 之前。

- [ ] **Step 1–4:** 先改契约测试使其 FAIL，再改工作流使其 PASS；`node --test scripts/ci/*.test.mjs` 与 `actionlint`。
- [ ] **Step 5: Commit**（本地，不推送）`ci(npm): publish only when release-promote dispatches the tag`

### Task 11: image-publish 不再移动 latest（**需维护者 workflow 权限推送**）

**Files:**
- Modify: `.github/workflows/image-publish.yml`（删除第 310 行起的 `Move latest for a stable release`；头部注释第 11–12 行同步）
- Modify: `scripts/ci/workflows.test.mjs`（第 368–373 行改为断言 publish 作业里**没有** `--move-latest` 与 `crane tag … latest`）
- Modify: `scripts/images/RELEASE.md`（第 14、34、36 行关于 `latest` 时机的描述）

- [ ] **Step 1–4:** 同任务 10 的跑法。版本 tag 推送一步原样不动。
- [ ] **Step 5: Commit**（本地，不推送）`ci(images): leave latest to release-promote`

### Task 12: desktop-release 只到 draft（**需维护者 workflow 权限推送**）

**Files:**
- Modify: `.github/workflows/desktop-release.yml`（第 352 行那一步：保留建/复用 draft、upload、资产集比对、重验 tag；删除第 374 行 `--draft=false`；步骤名改为 `Create or reuse draft and upload`）
- Modify: `scripts/ci/workflows.test.mjs`（第 233 行用例改为断言**不含** `--draft=false`；第 288 行的 `gh` 桩用例改为断言「tag 移动时不报告 draft 已就绪」「未移动时 draft 资产集正确且未公开」）
- Modify: `scripts/desktop/RELEASE.md`

- [ ] **Step 1–4:** 同上。「拒绝覆盖已发布 Release」与 draft 复用规则不变。
- [ ] **Step 5: Commit**（本地，不推送）`ci(desktop): stop at a verified draft`

### Task 13: release-promote 工作流（**需维护者 workflow 权限推送**）

**Files:**
- Add: `.github/workflows/release-promote.yml`
- Modify: `scripts/ci/workflows.test.mjs`（新增用例）

**形态：**
- `on.workflow_dispatch.inputs.tag`（必填）。`concurrency: { group: release-promote, cancel-in-progress: false }`：跨版本串行、不取消进行中的晋升。
- `permissions`：作业级 `contents: write`（Release publish）、`packages: write`（GHCR `latest`）、`actions: write`（dispatch npm-publish）、`id-token` 不给。只用 `GITHUB_TOKEN`。
- 步骤：checkout `refs/tags/<tag>` 的提交 → `release-commit.mjs` 解析不可变提交并查 main 祖先 → `node scripts/release/promote.mjs`，其 `io` 接 `verify-release`、`gh workflow run npm-publish.yml --ref <tag> -f publish=true` 加按 `headSha` 与创建时间轮询 `gh run list`/`gh run view`（超时 60 分钟）、crane（与 image-publish 同版本同校验和）与 `check-images.mjs --move-latest`、`gh release edit`。summary 写 `$GITHUB_STEP_SUMMARY`。
- 契约测试：只有 `workflow_dispatch`；并发组固定且不取消；没有 `NPM_TOKEN` 与 PAT；Actions 钉 SHA；`promote.mjs` 是唯一写指针的入口；不出现 `git tag`、`gh pr merge`。

- [ ] **Step 1–4:** 同上。
- [ ] **Step 5: Commit**（本地，不推送）`ci(release): add release-promote`
- [ ] **Step 6:** 把任务 10–13 合成**一个**提交（契约测试与工作流必须同提交），`git format-patch -1` 导出，连同说明交给维护者推送。agent 不尝试推送它。

### Task 14: 演练、文档与片段

**Files:**
- Modify: 三份 `RELEASE.md`、`CONTRIBUTING.md`（tag 之后改为：三条工作流 → `gh workflow run release-promote.yml -f tag=v<x.y.z>` → 读 summary）
- Add: `changelog.d/release-promote.changed.md`（一条中文 bullet：新版本的 Release 只在 npm 与两个镜像都验证通过后才成为 latest；之前公开入口保持上一版）

- [ ] **Step 1:** 维护者推送任务 10–13 后，在 CI 上跑 `node --test scripts/ci/*.test.mjs scripts/release/*.test.mjs`、actionlint，全部绿。
- [ ] **Step 2:** 不打新 tag 的演练：对已发布的 `v0.1.6` dispatch `release-promote`，期望每一步都识别为「已完成」（npm `same`、两个 `latest` 已是 0.1.6、Release 已发布），summary 全部是「already done」，不写任何东西。这一次同时验证 dispatch 链路与轮询。
- [ ] **Step 3:** npm dispatch 的单独演练：`gh workflow run npm-publish.yml --ref v0.1.6 -f publish=true`，期望 `npm-state` 判 `same` 后以 0 结束、不发布。记录 run 链接。trusted publishing 在 dispatch 事件下的首次真实发布只能在下一次发布时观察，届时记录。
- [ ] **Step 4: Commit** `docs(release): promote after the tag workflows`

### Task 15: 第二步上线（依赖真实发布）

- [ ] **前提核对：** ROADMAP 已记录第一步上线后一次真实发布的只读报告无误报；任务 10–13 已由维护者推送并合入。
- [ ] 下一次发布由维护者打 tag：三条工作流结束时 Release 是 draft、npm 未发布、两个 `latest` 未动——这正是「最终 Release 晋升之前，受支持安装入口保持上一版」（规格第 39 行）。记录 `releases/latest/download/docker-compose.yml` 仍返回上一版资产。
- [ ] 维护者 dispatch `release-promote`，记录 summary 的三步顺序；随后 `npm run release:verify -- <x.y.z>` 退出 0，`--pointers` 全部指向新版本。
- [ ] ROADMAP 记录；验收 1 与 5 的证据齐了再讨论关闭 #63（关闭本身由维护者决定）。

## 本期明确不做

- tag 创建自动化（规格第 148 行）。
- 镜像加 `org.opencontainers.image.revision` 标签：会让 verify-release 能比对镜像提交，但要改 Dockerfile 与 image-publish，另开议题。
- 验证 npm provenance 的 Sigstore 签名（`npm audit signatures` 类做法）：本期只读 registry 报告的内容并如实标注未验签。
- linux/arm64 镜像（#50）。
- 自动在三条工作流之后运行 verify-release（第一步）：需要改工作流，随第二步的 promote 一起出现。
