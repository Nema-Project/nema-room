# Room API 用户 basis 证据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Room API 写入用户 basis，或把 superseded 决策恢复为 active 时，必须引用当前任务的用户消息；检查和写入在同一把仓库锁里。

**Architecture:** `KnowledgeStore.upsert` 增加可选 guard，在它已持有的 `withRepoLock` 内读完条目再决定写不写。Room 的 `POST /entries` 把今天的 active 决策守卫和本 issue 的用户证据都放进这个回调。不传 guard 的调用保持原样。CX-03 任务 6 以后在同一个回调里追加外部证据检查，不另加锁。

**Tech Stack:** 现有 TypeScript、zod、Hono、Vitest、`withRepoLock`。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-user-basis-evidence-design.md`

**Base:** `dce99af412e4c80547d144928a5378d65083f877`（`main`，PR #27 已合入）。不要实现 CX-03，不要改 `docs/superpowers/specs/2026-10-27-source-evidence-protocol-design.md` 或它的 plan。

## Global Constraints

- 不新增 npm 依赖，不建 `evidence_events`，不改条目文件格式。
- `withRepoLock` 不可重入。guard 内不得调用同一仓库的 `upsert`、`confirm`、`withdraw`、`writeDiagram`，也不得 `withRepoLock(repoDir)`。
- 不传 guard 的 `upsert` 行为不变。界面 `PUT` / `confirm` 不传 guard。
- 旧的 active 决策 409 原文不变，且先于新 409。新 409 原文和 `code` 以 spec 为准。
- 代码注释用英文。hub 面向调用方的新错误用 spec 里的中文原句。
- 不改 README、`ROADMAP.md`、CX-03 文档。
- 每个任务结束跑该任务列出的测试和 `npm run typecheck`。web 无改动，不跑 web lint / build。

## Review Focus

1. 新建、需求改正文、只引用另一条用户消息的 active 决策改正文，在没有当前任务用户消息时必须是 409 `user_basis_evidence`，文件不变。→ 任务 2。
2. superseded → active 即使 basis 为 `inferred` 也要当前任务用户消息。停在 superseded 的 `inferred` 改正文仍是 200。→ 任务 2。
3. 只引用 agent 消息的 active 决策改写仍是旧 409 文案，没有 `code`。→ 任务 2。
4. 两个 guard 在同一仓库上串行，后一个看到前一个写入后的标题。拒绝不写文件，并且之后还能再写。→ 任务 1。
5. guard 的返回值能替换写入内容，包括压掉 `confirmed: true`。CX-03 任务 6 必须能沿 spec 里的回调往下加，而不是在锁外读一次再放行。→ 任务 1、任务 2。

---

### Task 1: `upsert` 的锁内 guard

**Files:**

- Modify: `packages/knowledge/src/store.ts`
- Modify: `packages/knowledge/src/index.ts`
- Test: `packages/knowledge/test/store.test.ts`

**Interfaces:**

- Produces: spec「锁内接口」的 `UpsertRejected`、`UpsertGuardContext`、`UpsertGuard`，以及 `KnowledgeStore.upsert(rawInput, meta, guard?)`。
- guard 在读完 `existing`、分配好 id 之后、`writeAndCommit` 之前运行。抛 `UpsertRejected` 则不写。返回的 input 在钉死锁内 `id` 和 `kind` 后重新 parse，并用于后面的写入。
- 注释写明：调用方必须尚未持有该 `repoDir` 的仓库锁；guard 自己也不得再取这把锁。CX-03 任务 6 复用第三个参数，不新加方法。

- [ ] **Step 1: 写失败测试** 在 `store.test.ts`：

- `it("rejects an upsert from the guard without writing, then accepts a later upsert")`：先写入 `R-1`。guard 抛 `UpsertRejected(409, "no", "user_basis_evidence")`。条目标题仍是原来的。接着一次不带 guard 的 upsert 能写成新 id。
- `it("runs upsert guards one at a time and shows the previous write")`：先写入标题 `v1`。第一个 guard 记下 `existing.title` 后停住；此时第二个 guard 还没进入。放开之后，第二个 guard 看到的标题是第一个请求要写的 `v2`，不是 `v1`。
- `it("writes the input returned by the guard and can keep confirmedAt")`：更新时请求带 `confirmed: true`，guard 返回另一标题且 `confirmed: false`。标题是 guard 的，`confirmedAt` 仍是更新前的值。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/knowledge store` → 新用例 FAIL。
- [ ] **Step 3: 实现** spec 的签名和行为。不改 `writeAndCommit` 的锁策略。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(knowledge): add locked upsert guard`

### Task 2: Room API 在 guard 里检查用户证据

**Files:**

- Modify: `apps/hub/src/roomApi.ts`
- Modify: `apps/hub/test/roomApi.test.ts`
- Modify: `CHANGELOG.md`
- Modify: `docs/reference.zh-CN.md`

**Interfaces:**

- `POST /entries` 调用 `ks.upsert(input, { author: "agent", taskId }, guard)`。
- guard 内顺序：`applyActiveDecisionGuard`（今天第 145–163 行的规则，改用锁内 `existing`），然后 `assertCurrentTaskUserEvidence`。后者只在 spec 的三种「需要证据」情况查询 `getTask` / `getMessage`。
- 回调末尾 `return` 调整后的 input。注释按 spec 写明 CX-03 任务 6 插在这个 `return` 之前。
- `UpsertRejected` 映射为 HTTP 状态。`code` 只在有值时出现。未知 id 的 404 仍在加锁前。
- quote 两个正向用例的 `sourceMessages` 加上当前任务用户消息 id。断言不改。

- [ ] **Step 1: 写失败测试** 在 `roomApi.test.ts`。先确认现有 decision 描述块仍然只依赖当前任务用户消息或 `inferred`。再加 spec「测试」一节列出的拒绝、通过和系统任务用例。不要改那八个决策测试的期望。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub roomApi` → 新用例 FAIL，旧决策和 quote 用例 PASS。
- [ ] **Step 3: 实现**。删除锁外那次用于 basis 判断的 `ks.get`（404 的存在性检查可以留下）。不要在 guard 里调用 `upsert`。
- [ ] **Step 4: 补** `CHANGELOG.md` 的 `[Unreleased]` 和 `docs/reference.zh-CN.md` 的 API 小节。409 原文和 `code` 与 spec 一致。
- [ ] **Step 5: 跑** `npx vitest run --project @nema/hub roomApi`、`npx vitest run --project @nema/knowledge store` 和 `npm run typecheck` → PASS。
- [ ] **Step 6: Commit** `fix(hub): check user basis inside repo lock`

---

## 不在本计划里

- CX-03 的表、导入、`sourceRefs`、界面事件。任务 6 的插入点只写在注释和 spec 里，不实现。
- 可重入的 `withRepoLock`。
- prompt 改写。服务端拒绝会回到 Agent，prompt 里已有的句子不用再抄一遍。
