# 晋升前后的 npm registry 可见性有界等待 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `release-promote` 在 npm 发布子运行成功之后，对「精确版本 + integrity」和「预期 channel dist-tag」做有上限的只读重查，而不是只读一次；`v0.2.0` 那次因为索引延迟而误失败、要维护者重跑的情况不再发生。超时仍然非零退出且不翻后续任何指针。

**Architecture:** 只改 `scripts/release/` 下的可单测 Node 脚本，不动工作流：

- `npm-state.mjs` 把「一次读」与「判定」分开：新增 `probeNpmVersion()` 返回带分类的答案（`same` / `absent` / `different` / `denied` / `untrusted` / `transient`），现有 `npmPublishState()` 变成它的严格包装（非 definitive 一律抛错，行为与错误文字不变）。仍然是同一个读取器、同一套 `absent`/`same`/`different` 词汇，**不新建平行发布器**。
- `verify-release.mjs` 把 dist-tag 的解析抽成 `npmPointers(io)`（一次 dist-tags 读取得到 `latest` / `next` 两个指针），`readPointers()` 复用它；没有行为变化。
- `promote.mjs` 新增并导出 `awaitNpmVisibility()`：一个共享预算内按固定间隔重查，**只读**，绝不再次 dispatch 或 publish；`promote()` 在 `waitNpm` 成功之后调用它，用它的结论决定「已可见 / 维护版 / 超时 / 未知」。
- `promote.mjs` 的 `io` 契约改为：`npmState` 返回带分类的对象，新增 `npmPointers()`、`sleep()`、`now()`。`realIo` 与测试桩同步。

**Tech Stack:** Node.js 22（`node:test`、`fetch`）、现有 `scripts/release/*` 工具。不新增依赖，不改工作流，不改 tag 或任何已发布产物。

**Spec:** [发布机制设计](../specs/2026-10-28-release-mechanics-design.md) 第 106–107 行（promote 的顺序、失败即停、summary 记录已翻/未翻）与第 39 行（不承诺跨注册表原子性，重跑向前恢复）。

**Issue:** [#158](https://github.com/Nema-Project/nema-room/issues/158)，milestone v0.2.x。证据：晋升运行 [41170238828](https://github.com/Nema-Project/nema-room/actions/runs/41170238828) attempt 1 在 npm 子运行 [41170270882](https://github.com/Nema-Project/nema-room/actions/runs/41170270882) 成功约 18 秒后停止，报 `npm publish run finished but the registry does not hold the expected tarball`；随后独立读取同一 URL 得到 HTTP 200 且 integrity 一致，只重跑失败的 job 即成功。

**Base:** 写本计划时的 `origin/main` 是 `e1786e8`（Merge pull request #160）。动手前 `git fetch origin main`，再看：

```
git diff --name-only e1786e8..origin/main -- scripts/release/promote.mjs scripts/release/npm-state.mjs scripts/release/verify-release.mjs scripts/release/registry-read.mjs scripts/release/promote.test.mjs .github/workflows/release-promote.yml scripts/npm/RELEASE.md
```

有改动就先重读这些文件；与下文「核对的代码」不一致时先改本计划，再照着旧行号改代码。

## 如何服务 #45

[#45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准是：这是否让人和 agent 更容易对项目保持有证据支撑的共同理解。这次改动只碰一件事——**「这一版在 npm 上到底写进去没有」这个问题的答案，要和 registry 的实际答复对齐**：可见就写下「已确认可见」，答复一直是 404 就写「确认未写入」，答复读不到就写「未知」，绝不把「读不到」当成「没写」。晋升仍然是一次可重跑的操作，记录里写的每一项都能回去核对。

## Global Constraints

- **只重查，不重发。** 等待期间不再次 dispatch `npm-publish`、不 `npm publish`、不改 dist-tag。整个 `promote()` 里 npm dispatch 至多一次。
- **分类不吞。** `different`（integrity 不一致）立即失败，一秒不等；`denied`（401/403）、`untrusted`（200 但版本/完整性不可信、或无法解释的状态码）立即失败；`absent` 与「合法但尚未推进的旧 dist-tag」才进等待；瞬时网络/超时/429/5xx 在预算内可以重查，但**结束时若最后一次答复仍不确定，终态是「未知」，不是「未写入」**。
- **dist-tag 侧只有 ok/missing/unknown 三态**（`registry-read.mjs` 的既有语义），分不出 401 与 503。因此 dist-tag 的 unknown 一律在预算内重查，耗尽后以「未知」停止——停法与原代码一致（不翻任何后续指针），只是不再一秒内误判。
- **预期 channel 与既有判定一致。** 稳定版看 `latest`：读到本版即翻；读到更新版本即「维护版」合法保留（与 `pointerDecisions` 的 `keep` 等价）；读到 absent 或更旧版本才等待。预发布看 `next`，只接受本版；`next` 读到更新版本是矛盾（不是延迟），立即停止。
- **超时 = 非零退出 + 不翻后续指针。** GHCR `latest` 与 GitHub Release 都不动。
- **保留既有全部约束：** 稳定/预发布隔离、防版本倒退（发布前指针更新、发布后却被写成旧版 → 停并要求 `npm dist-tag add` 恢复）、精确 tag/SHA 与 integrity 绑定、重跑幂等、写入后读回、每个写前重验 tag。
- **不访问网络。** 测试用桩 `fetchImpl` / 假时钟，不真等 2 分钟。
- **代码、注释、提交说明用英文**；错误消息与 summary 文案可保留英文原文（发布日志本来就是英文）。
- **用户/维护者可见的变化** 写 `changelog.d/release-promote-visibility-wait.fixed.md`（一条 `- ` bullet，不加标题）。
- **全量测试** `npx vitest run --maxWorkers=2`；release 脚本另跑 `node --test scripts/release/*.test.mjs`、`npm run typecheck`。

## 核对的代码（e1786e8）

- `scripts/release/npm-state.mjs`（81 行）：`npmPublishState({ version, expectedIntegrity, fetchImpl })` 一次 `fetch`；404 → `{state:'absent'}`；非 200 → 抛 `cannot tell whether …: HTTP <n>`；`json()` 失败、`body.version` 不符或缺 `dist.integrity` → 抛 `cannot tell whether …: …`；integrity 相等 → `same`，否则 `different`。**没有任何重试**。CLI 退出码 0/3/2 被 `npm-state.test.mjs` 与 `npm-publish.yml` 依赖。
- `scripts/release/verify-release.mjs:161` `readPointers(io)`：一次 `readNpmDistTags`，用内部 `npmPointer(name)` 把 `latest` / `next` 解析成 `version` / `absent` / `unknown`；另有 GHCR 两个与 GitHub latest。`pointerDecisions` 用 `shouldMoveLatest` 给出 `move` / `keep` / `unknown` / `skip`。
- `scripts/release/promote.mjs`：`npmBefore = io.npmState(...)` → `same` 分支只读 dist-tags 判定、`absent` 分支 dispatch + `waitNpm` → **单次** `published()` 读回（第 126–132 行），读回不是 `same` 就 `PromoteStop('npm publish run finished but the registry does not hold the expected tarball')`；随后**单次** `readPointers()` 读 dist-tag（第 133 行）决定 `flipped` / 维护版 / 停止。`realIo.npmState` 返回 `(await npmPublishState(...)).state`，即只有字符串，没有分类。
- `.github/workflows/release-promote.yml`：`Promote` 一步跑 `node scripts/release/promote.mjs "$TAG" "$COMMIT"`，作业 `timeout-minutes: 90`；`GITHUB_STEP_SUMMARY` 由 `main()` 的 `summary` 写。
- 既有测试：`promote.test.mjs` 的 `world()` 桩里 `npmState` 返回字符串、`waitNpm` 直接把 registry 置成 `same` 并推进 dist-tag，所以**当前没有任何测试能表达「先 absent 后 same」**；`after the npm publish, an unreadable, absent or lagging dist-tag stops before GHCR` 用 `latestAfterPublish` 固定一个值，同样无法表达延迟。

## 文件结构

- `scripts/release/npm-state.mjs`：新增 `probeNpmVersion()`；`npmPublishState()` 改为严格包装。
- `scripts/release/npm-state.test.mjs`：为分类补测试；既有严格行为测试不动。
- `scripts/release/verify-release.mjs`：抽出并导出 `npmPointers(io)`；`readPointers()` 复用。
- `scripts/release/promote.mjs`：`NPM_VISIBILITY_BUDGET_MS` / `NPM_VISIBILITY_POLL_MS`、`awaitNpmVisibility()`、发布后改用它、三态 summary 行、`realIo` 新契约。
- `scripts/release/promote.test.mjs`：`world()` 增加读序列、假时钟；四条验收各一条测试。
- `scripts/npm/RELEASE.md`：promote 段落补一句「发布后对 registry 可见性的有界重查」。
- `changelog.d/release-promote-visibility-wait.fixed.md`。

## Task 1: 读取器给出分类

**Files:** `scripts/release/npm-state.mjs`、`scripts/release/npm-state.test.mjs`

**Interfaces:**
- `probeNpmVersion({ version, expectedIntegrity, fetchImpl })` → `{ state, integrity?, detail? }`，`state ∈ same | absent | different | denied | untrusted | transient`。除 `same`/`absent`/`different` 外，`detail` 一律以 `cannot tell whether @nema-project/nema@<version> exists: ` 开头，便于调用方原样上抛。
- `npmPublishState()` 不变：`same`/`absent`/`different` 原样返回，其余抛出 `detail`。

映射（写进注释）：网络错误/超时、429、≥500 → `transient`；401/403 → `denied`；其它非 200、JSON 不可解析、版本不符、缺 integrity → `untrusted`。

- [ ] **Step 1: 先写测试**：每个分类一条断言（同一组桩 `fetchImpl`，从现有 `an unanswered or unreadable registry throws` 拆出来），并断言严格包装仍抛同样的 `cannot tell whether …` 文案。
- [ ] **Step 2: 跑红** `node --test scripts/release/npm-state.test.mjs`。
- [ ] **Step 3: 实现**，再跑到全绿。
- [ ] **Step 4: Commit** `refactor(release): classify one npm registry read instead of only throwing`

## Task 2: dist-tag 指针可单读

**Files:** `scripts/release/verify-release.mjs`

**Interfaces:** `npmPointers(io)` → `{ latest, next }`，与 `readPointers()` 里同名指针逐字段相同（`version` / `absent` / `unknown`）。

- [ ] **Step 1: 实现**（`readPointers` 调它，行为不变；`npm-state`/`verify-release` 既有测试必须全绿）。
- [ ] **Step 2: 跑** `node --test scripts/release/*.test.mjs`。
- [ ] **Step 3: Commit** `refactor(release): read the two npm channel pointers from one dist-tags answer`

## Task 3: 有界可见性等待

**Files:** `scripts/release/promote.mjs`、`scripts/release/promote.test.mjs`

**Interfaces:**
```js
export const NPM_VISIBILITY_BUDGET_MS = 120_000;
export const NPM_VISIBILITY_POLL_MS = 5_000;
export async function awaitNpmVisibility({ version, prerelease, expectedIntegrity, io, budgetMs, pollMs })
//  -> { ok: true, pointer, maintenance, waitedMs, reads: { package, tag } }
//   | { ok: false, outcome, reason, waitedMs, reads, last }
//     outcome ∈ not-visible | unknown | different | denied | untrusted | tag-unknown | tag-moved
```
`io` 需要 `npmState({expectedIntegrity})`（Task 1 的对象形状）、`npmPointers()`、`sleep(ms)`、`now()`。

逻辑：
1. 一个 `deadline = now() + budgetMs`，两个阶段共用。
2. 包阶段：`same` → 通过；`different` / `denied` / `untrusted` → 立刻 `{ok:false}`（零 sleep）；`absent` / `transient` → 预算内 `sleep(min(pollMs, 剩余))` 后重读；耗尽时 `absent` → `not-visible`，`transient` → `unknown`（`last.detail` 原样带上）。
3. dist-tag 阶段：指针等于本版 → `{ok:true}`；稳定版且指针更新（`shouldMoveLatest` 为 false）→ `{ok:true, maintenance:true}`；预发布且指针更新 → 立刻 `tag-moved`；absent/更旧/unknown → 预算内重读；耗尽时 unknown → `tag-unknown`，否则 `not-visible`。
4. 每阶段至少读一次；返回 `waitedMs`（含包与 tag）与各阶段读取次数。

`promote()` 改动：`npmBefore` 用 `.state`；`published()` 用 `.state`；`waitNpm` 成功后调用 `awaitNpmVisibility`（包在 `step('npm visibility after publish', …)` 里）；`!ok` → `PromoteStop(reason)`；`maintenance` → 保留原有「published under maintenance」记录；否则 `flipped.push(npmName)`，记录里带上等待时长；发布前的 `keep` 与发布后读到本版的矛盾 → 保留原有「moved backwards」停止。删掉发布后那次单独的 `read npm dist-tags after publish`（等待已给出该指针）。catch 块在本次确实发布过时追加一行三态之一：`npm registry after publish: confirmed visible (after Ns)` / `not written — 404 for the exact version through the Ns budget` / `unknown — last answer …; whether the package is published is not confirmed`。

- [ ] **Step 1: 先写测试**（`promote.test.mjs`）：
  - 桩：`world()` 的 `npmState` 返回对象；新增 `npmReads`（dispatch 之后依次返回，最后一项重复并被写回 `state.npm`）与 `tagReads`（`npmPointers()` 依次返回，同样收敛到 state）；新增假时钟 `state.clock` + `state.sleeps`。
  - 验收 1：`npmReads: [absent, same]`、`tagReads: [ABSENT, v('0.1.7')]` → 成功；`state.writes` 里 npm dispatch 恰好一次；后续 GHCR/Release 照常翻。
  - 验收 2：`npmReads:[same]`、`tagReads:[v('0.1.6'), v('0.1.6'), v('0.1.7')]` → 成功，仍只 dispatch 一次，sleep 了两次。
  - 验收 3：`npmReads:[{state:'different',…}]` → 失败，`state.sleeps` 为空，`writes === ['npm dispatch']`，文案点名 registry 的 integrity。
  - 验收 4a：`npmReads:[absent]` → 失败，`sleeps` 合计恰好 120000，`writes === ['npm dispatch']`，文案说明「404 through the budget / not written」。
  - 验收 4b：`npmReads:[same]`、`tagReads:[v('0.1.6')]` → 失败，合计 120000，`writes === ['npm dispatch']`，文案 `npm latest still reads 0.1.6`。
  - 分类：`transient` 一次后 `same` → 成功；一直 `transient` → 失败且文案写「unknown」，**不得**出现「not written」；`denied`/`untrusted` → 零 sleep 失败。
  - tag unknown 耗尽 → 失败且写「unknown / cannot be read」。
  - 预发布 `next` 在等待中读到 rc.2 → 零 sleep 失败，文案点名 next 已更新。
  - 维护版与「发布后倒退」两条既有测试必须仍绿。
- [ ] **Step 2: 跑红**，再实现，再全绿。
- [ ] **Step 3: 证伪**：分别删掉「absent 等待」「different 立即失败」「预算判断」各一处实现，确认对应用例变红，逐一记录。
- [ ] **Step 4: Commit** `fix(release): wait for npm registry visibility within a bounded budget`

## Task 4: 文档与片段

**Files:** `scripts/npm/RELEASE.md`、`changelog.d/release-promote-visibility-wait.fixed.md`

- [ ] **Step 1:** promote 段落补一句：发布子运行成功后，promote 会在 2 分钟预算内重读精确版本与预期 dist-tag；404 或尚未推进的旧 dist-tag 会被重查，integrity 不一致、鉴权失败、不可信答复立即停止；预算耗尽仍以非零退出并如实写明「未写入」或「未知」。
- [ ] **Step 2:** 片段一条 bullet，英文。
- [ ] **Step 3: Commit** `docs(release): describe the bounded npm visibility wait`

## 验收对照

| issue 验收 | 测试 |
| --- | --- |
| npm job 成功，先 absent 后 same，dist-tag 随后可见；同一次晋升成功、只 dispatch 一次 | Task 3 验收 1 |
| 包可见但 dist-tag 延迟；有界等待后继续，不重复发布 | Task 3 验收 2 |
| integrity 不一致立即失败、不等待、不推进其它指针 | Task 3 验收 3 |
| 持续 absent 或旧 dist-tag 到预算耗尽，明确超时且不动其它指针 | Task 3 验收 4a / 4b |
| 错误分类与 summary fail-closed；写入成功但读回未知不被记成「确认无变化」 | Task 3 分类用例 + catch 块三态行 |
| 既有维护版/更高版本/预发布/重跑幂等仍通过；注入 sleep/clock，不真等 | 既有 37 条 + 假时钟 |

## 不做的事

- 不改 `.github/workflows/**`（不动 workflow 触发、超时、参数）。
- 不重跑任何晋升、不改 tag、不发 release、不重发 npm。
- 不加跨注册表事务或回滚；不改 GHCR / GitHub Release 的等待策略（本次只处理 npm 侧可见性）。
- 不给 `npm-publish.yml` 加任何逻辑。
