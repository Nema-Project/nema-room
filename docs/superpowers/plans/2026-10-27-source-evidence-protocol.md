# 外部来源证据协议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让外部来源以校验过的快照和 `sourceRefs` 进入知识库，用户确认写成独立的 evidence event，导入在 Git 与索引之间失败时可以重试且不复制 `S-n`。不改 `basis` 的三个值，不放宽已定决策保护。

**Architecture:** 类型和纯函数在 `packages/shared`。快照和引用写在知识 Git 的 frontmatter 里，省略空字段以保持旧文件字节。`SourceRef.snapshotHash` 记下引用当时的内容哈希。`evidence_events`、`source_import_receipts`、`source_freshness` 在 hub DB，随快照可选导入。`importSourceSnapshot` 只在 hub 进程内、持有仓库锁时写 Git，不调用会再次加锁的 `upsert`。Room API 在 #28 放进仓库锁的那段守卫里增加外部引用规则：写入前或写入后有 `sourceRefs` 都要查。界面确认先插事件，再 commit，再消费事件。一个数据目录只跑一个 hub。

**Tech Stack:** 现有 TypeScript、zod、gray-matter、Hono、PostgreSQL/PGlite、Vitest。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-27-source-evidence-protocol-design.md`

**Base:** 设计对照 `ca980efe8cac4e4ce30326a5f1676b8ed4fd3235`。动手前 `git fetch` 并核对 HEAD。迁移文件只有在 `012_source_evidence.sql` 仍不存在时才用这个名字，否则用下一个空号并改下面所有引用。ADR-07 仍门控实施：业主还没排期 CX-03 时不要开始写生产代码。[issue #28](https://github.com/Nema-Project/nema-room/issues/28) 是本计划的前置：它合入之前不要开始本计划。本计划不重新实现 #28，也不得删除它合入后的用户 basis 证据检查和失效→active 检查。一个数据目录只跑一个 hub 进程。

## Global Constraints

- 不新增 npm 依赖。`packages/shared` 不引用 `node:crypto`。哈希用 `apps/hub/src/db/snapshot.ts` 的 `sha256`。
- `basis` 只允许 `stated`、`decided`、`inferred`。`isStale` 仍是 source 的 90 天。
- 不把 `source__import` 放进 `PLUGINS` 或 Room 路由。
- 持有 `withRepoLock` 时不得调用 `KnowledgeStore.upsert`、`confirm`、`withdraw`、`writeDiagram`。
- 旧条目文件没有新键时必须能读；不该改写的更新必须字节不变。
- hub 新错误用 spec 里的中文原句。代码注释用英文。
- 不实现 OAuth、MCP、Notion、Google、`PendingWrite`、`workspace_sources`。
- 不实现 [issue #28](https://github.com/Nema-Project/nema-room/issues/28)，也不要在它合入之前开始本计划。#28 把用户 basis 守卫放进仓库锁。任务 6 的外部证据检查写在同一段锁里，禁止在加锁前读 `sourceRefs` 再放行。
- 一个数据目录同时只跑一个 hub。`withRepoLock` 不跨进程。不要加文件锁或数据库租约。
- 不改 README。`docs/reference.zh-CN.md` 只在任务 10 按已实现的行为更新。
- 每个任务结束跑该任务列出的测试和 `npm run typecheck`。web 无改动则不跑 web lint/build。

## Review Focus

1. 旧决策守卫的八个测试和 quote 逐字测试必须不改断言就通过。失败时文件字节不变，409 文案仍是 `改写已定决策 ...需要用户消息作为依据...`。→ 任务 6。
2. 外部证据路径不得借「任意 user 消息」提升 basis。任务消息不是 user、或 quote 只存在于 `message_versions` 时必须 409 新文案。写入前后都没有 `sourceRefs` 的纯聊天路径保持 #28 合入后的行为，包括用户 basis 证据检查和失效→active 检查，本计划不收紧，也不得删除。→ 任务 6。
3. 导入在 `indexEntry` 失败后重试，仍是同一个 `S-n`。→ 任务 5。
4. `revision: null` 和 `timeout` 不得写成 `current`。→ 任务 1 和任务 8。
5. Room JSON 里的 `confirmationEventId` 必须被忽略，且不得消费已有事件。→ 任务 6。
6. `withRepoLock` 重入会死锁。导入路径的测试要能在超时内结束。→ 任务 5。
7. Agent 不能改带快照的 S 条目的 basis，即使有当前用户逐字摘录。清空已有 `sourceRefs` 再提升不能掉进纯聊天路径。→ 任务 6。
8. revision 两边为 `null` 时，`snapshotHash` 与当前 `contentHash` 不同要让 `reviewNeeded` 为真，新鲜度仍是 `unknown`。`unconfirmedSnapshot` 出现在四个读接口。→ 任务 8。

---

### Task 1: shared 类型、规范化 JSON、新鲜度比较

**Files:**
- Create: `packages/shared/src/sourceEvidence.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/entry.ts`
- Test: `packages/shared/test/sourceEvidence.test.ts`（新建）、`packages/shared/test/entry.test.ts`

**Interfaces:**
- Produces: spec「数据契约」里的 `SourceSnapshot`、`SourceExcerpt`、`SourceRef`（含必填 `snapshotHash`，64 位小写 hex）、`SourceFreshness`、`canonicalJson`、`compareFreshness`。
- `EntryFrontmatter` 增加 `sourceSnapshot?`、`sourceRefs`（默认 `[]`）、`confirmedRevision`（默认 `null`）。快照只允许 source。`confirmedRevision` 非 null 只允许带快照的 source。
- `UpsertEntryInput` 只增加可选 `sourceRefs`（最多 10）。不增加快照、`confirmedRevision`、事件 id。
- source 的 refine：有 http(s) `url`，或有 `sourceSnapshot`。二者都没有则失败。有快照且 `canonicalUrl` 为 null 时允许没有 `url`。

- [ ] **Step 1: 写失败测试**

`sourceEvidence.test.ts`：

- `it("canonicalJson sorts object keys and keeps excerpt order")`：`{ b: 1, a: { d: 1, c: 2 } }` 与键序相反的对象得到同一字符串；摘录对调后字符串不同。
- `it("compareFreshness never calls a null revision current")`：`ok + null`、`ok + ("rev", null)` 都是 `unknown` / `incomparable`。
- `it("compareFreshness maps provider outcomes")`：两侧相等 → `current`/`match`；两侧不同 → `changed`/`mismatch`；`not_found` 与 `forbidden` → `unavailable`；`offline` 与 `timeout` → `unknown`，不是 `unavailable`。

`entry.test.ts`：

- `it("accepts a schemaVersion 1 snapshot only on source")`。
- `it("rejects schemaVersion 2, an empty provider, and a 2001-character excerpt")`。
- `it("allows a source snapshot without url when canonicalUrl is null")`。
- `it("still requires url for a source without a snapshot")`。
- `it("rejects a source ref without snapshotHash")`。
- 现有 frontmatter fixture 不传新字段时仍能 parse，`sourceRefs` 为 `[]`，`confirmedRevision` 为 `null`。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/shared sourceEvidence entry` → FAIL。
- [ ] **Step 3: 实现** spec 里的类型和两张比较表。`canonicalJson` 只处理 `null`、布尔、有限数字、字符串、数组和纯对象；其他类型抛 `TypeError`。不要引入 `node:crypto`。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(shared): add source snapshot and freshness comparison`

### Task 2: 知识文件的读写和旧字节

**Files:**
- Modify: `packages/knowledge/src/store.ts`
- Modify: `packages/knowledge/src/commitMessage.ts`
- Test: `packages/knowledge/test/store.test.ts`、`packages/knowledge/test/commitMessage.test.ts`

**Interfaces:**
- `toFile` / `fromFile` 使用 spec 的 snake_case。空 `source_refs`、`null` 的 `confirmed_revision`、缺失的快照都不写出。
- `upsert` 保留已有 `sourceSnapshot` 和 `confirmedRevision`，不从 input 读它们。`sourceRefs === undefined` 保留旧列表，数组则替换。
- `CommitMeta` 增加可选 `evidenceEventIds?: string[]`。有值时 commit 消息多一行 `Evidence-Event: id1,id2`。解析时没有这行则 `evidenceEventIds` 省略。
- 不在本任务写导入。不要从 `upsert` 里调用会再加锁的方法。

- [ ] **Step 1: 写失败测试**

- `it("round-trips a source snapshot and source refs")`：写入后再 `get`，revision `null`、`snapshotHash`、摘录和引用都在。
- `it("keeps a legacy file byte-identical when the new keys are empty")`：用 `store.test.ts` 已有的 `LEGACY` 常量。`upsert` 只改 `related`。读回的文件里没有 `source_refs`、`source_snapshot`、`confirmed_revision`。`ingestedAt` 行为与现有 `"updating a legacy entry leaves ingestedAt null"` 一致。
- `it("preserves a snapshot when the agent upserts other fields")`：先用测试里的直接写文件放好快照（`fromFile` 能读），再 `upsert` 改 `related` 且不传 `sourceRefs`。快照和 `confirmedRevision` 还在，引用还在。
- `it("replaces source refs only when the field is present")`：传 `[]` 后引用为空且文件不再含 `source_refs`。
- `commitMessage.test.ts`：`it("parses a commit without Evidence-Event")` 用一条今天的消息；`it("round-trips evidence event ids")`。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/knowledge store commitMessage` → FAIL。
- [ ] **Step 3: 实现** 映射。`schema_version !== 1` 让 `EntryFrontmatter.parse` 失败，不要吞掉。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(knowledge): persist source snapshots without rewriting legacy files`

### Task 3: 迁移、快照和删除顺序

**Files:**
- Create: `apps/hub/src/db/migrations/012_source_evidence.sql`
- Modify: `apps/hub/src/db/snapshot.ts`
- Modify: `apps/hub/src/workspaces.ts`
- Test: `apps/local/test/migration.test.ts`、`apps/hub/test/workspaces.test.ts`

**Interfaces:**
- 三张表的列和 check 与 spec 的 SQL 一致，含 `consumable`、消费两列同空或同有、`confirm_revision` 必须有 `snapshot_hash`、未消费且 `consumable` 的 `(workspace_id, payload_hash)` 部分唯一索引。新表加入 `TABLE_COLUMNS` 和 `OPTIONAL_TABLES`。
- `validateSnapshot`：旧快照缺这三键时得到空数组；`kind` / `phase` / `freshness` / `reason` 非法、哈希不是 64 位 hex、`workspace_id` 不在快照里、消费两列只填了一边、`confirm_revision` 缺 `snapshot_hash`，都抛错。
- 导入快照时，`consumed_commit is null` 的事件强制 `consumable = false`。已消费行保持快照里的两列。
- `deleteWorkspace` 在 `delete from workspaces` 之前删除这三张表里该 workspace 的行。

- [ ] **Step 1: 写失败测试**

`migration.test.ts`：

- `it("imports a snapshot from before source evidence tables")`：现有 `empty` 对象不带这三键，`validateSnapshot` 成功，三张表为 `[]`。
- `it("rejects an evidence event for an unknown workspace")`。
- `it("rejects a freshness reason that is not in the check list")`。
- `it("rejects confirm_revision without a snapshot hash")`。
- `it("rejects an evidence event with only one consumed column")`。
- `it("marks restored unconsumed events not consumable")`：快照里 `consumed_commit` 为 null 的行，导入后 `consumable` 为 false。
- 现有 `it("rejects report-token hashes...")` 保持不动。

`workspaces.test.ts`：

- `it("delete removes source evidence rows")`：插入三张表各一行后 `deleteWorkspace`，再查行数为 0，且 workspace 行不在。不要依赖数据库级联作为唯一断言。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/local migration` 和 `npx vitest run --project @nema/hub workspaces` → FAIL。
- [ ] **Step 3: 实现** SQL 与快照白名单。`TABLE_ORDER` 把新表放在 `workspaces` 之后（对象字面量里写在后面即可）。不要把快照信封的 `schemaVersion` 改成 2。
- [ ] **Step 4: 跑** 上面两条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): store source evidence events and import receipts`

### Task 4: evidence event 的插入和一次消费

**Files:**
- Create: `apps/hub/src/evidenceEvents.ts`
- Test: `apps/hub/test/evidenceEvents.test.ts`（新建）

**Interfaces:**
- Produces:
  - `insertEvidenceEvent(db, input): Promise<{ id: string; payloadHash: string; reused: boolean }>`。`actor` 固定写 `'user'`。同 workspace、同 `payload_hash`、未消费的行直接返回，`reused: true`。已消费的同哈希不在这里复用（调用方走幂等短路）。
  - `consumeEvidenceEvent(db, workspaceId, id, payloadHash, commit): Promise<boolean>`。只跑 spec 里的那条 UPDATE。0 行返回 `false`。
  - `payloadHashFor(input)` 用 `canonicalJson` + `sha256`。
- 本模块不导出 update 其他列或 delete 的函数。

- [ ] **Step 1: 写失败测试**

- `it("reuses an unconsumed event with the same payload hash")`：两次 insert，一行，同一个 id。
- `it("does not reuse a consumed event")`：消费后再 insert，两行。
- `it("consume is a no-op when the hash or workspace differs")`：`false`，`consumed_commit` 仍为 null。
- `it("consume cannot run twice")`：第二次 `false`，commit sha 仍是第一次的。
- `it("rejects a second unconsumed row with the same payload hash")`：并发或紧挨着的两次 insert 只有一行，第二次 `reused: true`。已消费之后可以再插入新的未消费行。`consumable = false` 的同哈希行不挡住新的现场插入。
- `it("does not consume an event restored as not consumable")`：`consumable` 为 false 时 `consumeEvidenceEvent` 返回 `false`，两列仍为 null。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub evidenceEvents` → FAIL。
- [ ] **Step 3: 实现**。id 用已有 nanoid，前缀 `ev_`。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): append user evidence events`

### Task 5: source__import 和 receipt 对账

**Files:**
- Create: `apps/hub/src/sourceImport.ts`
- Modify: `packages/knowledge/src/store.ts`（增加不自行加锁的写入方法，供已持锁的调用方使用；若做不到就把 Git 写入留在 `sourceImport.ts` 里调用现有的非公开路径。优先在 store 上增加 `writeImportedSource`，并在注释里写明调用方必须已持有该仓库的 `withRepoLock`）
- Test: `apps/hub/test/sourceImport.test.ts`（新建）

**Interfaces:**
- `importSourceSnapshot(db, dataDir, workspaceId, snapshot): Promise<{ entry: Entry; commit: string; alreadyImported: boolean }>`。
- 行为按 spec「source__import」的 1–6 步和失败表。错误文案用 spec 原句：`来源已撤回，不能重新导入`、`导入已写入知识库但索引未完成：<id>`、`导入记录与知识库不一致：<id>`。
- `reconcileSourceImports(db, dataDir, workspaceId): Promise<void>`。
- 新建条目 `basis` 为 `inferred`，正文为 `Imported source. provider=<provider> resource=<resourceId>`。`fetchedAt` 用 hub 时钟。入参哈希与重算不一致时 400，且数据库无 receipt。
- 抛错类型：沿用 hub 已有的 `HttpError` 或在本文件导出一个带 `status` 的错误，Room/UI 本任务先不接。

- [ ] **Step 1: 写失败测试**

- `it("imports a snapshot as an inferred source")`。
- `it("returns the same entry for the same hash without a second commit")`：`alreadyImported` 为 true，`git rev-list --count HEAD` 不变。
- `it("reimport with a new hash keeps the id and the basis")`：先把该条目 `confirm` 成带 `confirmedRevision` 的状态（或直接写文件），再导入新摘录。id 相同，`basis` 和 `confirmedRevision` 不变。
- `it("refuses a dropped source")`。
- `it("reuses the reserved id when git commit fails")`：用 `store.test.ts` 已有的「让 git commit 失败」的 hook 方式。文件回到导入前。修好 hook 后再导入，仍是同一个 id。
- `it("does not allocate a second id when indexing fails")`：注入一个会抛错的 index 函数（参数，不要改全局 `indexEntry` 的生产签名以外的行为）。第一次 500。第二次成功，库里只有一个 `S-*.md`。
- `it("reconciles a reserved receipt whose file is already committed")`：手动把 phase 留在 `reserved` 且文件已在 Git。对账后为 `indexed`，没有新 id。
- `it("finishes without deadlocking")`：上面任一成功用例在 5 秒内返回。这是锁重入的回归。
- `it("reapplies hash A after a null-revision reimport of B")`：revision 都是 null。导入 A，再导入 B，再导入 A。id 不变，文件快照的 `contentHash` 回到 A，不把 B 当成 `alreadyImported`，也不分配新 id。
- `it("restores a committed receipt whose blob still exists")`：phase 为 `committed`，工作区文件删掉，`git cat-file -e <commit>:<path>` 仍成功。对账或重试恢复该 blob 并索引，不分配新 id。
- `it("rewrites the same id when the committed blob is gone")`：blob 不在时，同哈希重试写回同一 `entry_id`。
- `it("conflicts when the path is a different resource")`：路径上已是另一个 `provider + resourceId` 时 409 `导入记录与知识库不一致：<id>`。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub sourceImport` → FAIL。
- [ ] **Step 3: 实现**。校验全部放在加锁之前。DB 事务不要包住 `git commit`：receipt 的 `reserved` 和 id 先提交，再 Git，再标 `committed`，再索引。
- [ ] **Step 4: 跑** `npx vitest run --project @nema/hub sourceImport` 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): import source snapshots idempotently`

### Task 6: Room API 的外部证据规则

**Files:**
- Modify: `apps/hub/src/roomApi.ts`
- Test: `apps/hub/test/roomApi.test.ts`

**Interfaces:**
- 保持 spec「#28 合入后的 POST /entries」全部步骤。第 8 步是 #28（本 PR）合入后的行为：用户 basis 证据检查，以及任一类型从 `INACTIVE_STATUSES`（`superseded`、`dropped`、`resolved`）改回 `active` 的检查。两项都要求引用当前任务的用户消息，否则 409 `user_basis_evidence`。不得删除。本任务不重新实现 #28，也不在没有 `sourceRefs` 的路径上再加逐字摘录。
- 复用 `KnowledgeStore.upsert` 的可选第三个参数 `UpsertGuard`，不要新加锁，也不要在 `upsert` 之外先读一次磁盘再放行。Room 里已经是 `ks.upsert(input, { author: "agent", taskId }, async ({ existing, input: locked }) => { ... })`。回调先跑 `applyActiveDecisionGuard`，再跑 `assertCurrentTaskUserEvidence`。外部证据检查插在这之后、`return` 之前，仍在这把仓库锁里：用 `existing` 读写入前的 `sourceRefs`；要改写入内容时返回新的 input（`id` 和 `kind` 会被钉死）；要拒绝时抛 `UpsertRejected`。同一仓库上再调用 `upsert` / `confirm` / `withdraw` / `writeDiagram` / `withRepoLock(repoDir)` 会立刻抛 `RepoLockReentryError`。导入仍走任务 5 的 `writeImportedSource`，不走这个 guard。
- 增加 spec「加上外部证据之后」的引用校验、改写定义和新 409 文案：`引用外部来源时，把条目标成 stated 或 decided 需要当前这条用户消息里的逐字摘录。外部文档不能代替这个确认。` 写入前或写入后 `sourceRefs` 非空时都要过，含显式清空。这一步不限于 active 决策：basis 是用户 basis，且新建或改了标题、正文、状态、basis、引用时都要过。只改 `related` 时不过。
- 带 `sourceSnapshot` 的 S 条目，请求 basis 与磁盘不同：409 `导入的来源不能由 Agent 改 basis。只有界面的 promote_basis 事件可以。` 当前用户逐字摘录也不放行。标题、正文、状态或 url 有变时仍用 `导入的来源快照不能用 upsert 修改`。
- 引用校验 400 文案用 spec 原句，含 `snapshotHash` 对不上当前 `contentHash`。
- 有快照，或写入前、写入后的 `sourceRefs` 有一边非空时，丢掉 `confirmed: true` 的效果。
- 不读取 `confirmationEventId`。
- 外部证据检查和磁盘上的旧 `sourceRefs` 读取就在上面这个 `UpsertGuard` 里，不要再包一层 `withRepoLock`，也不要在加锁前读一次就放行。

- [ ] **Step 1: 写失败测试** 在 `roomApi.test.ts`。先跑一遍现有 decision 描述块，确认仍是绿的，再加：

- `it("rejects a decided entry with source refs when the quote is only in an old version")`。
- `it("rejects a decided entry with source refs from a system task that cites an older user message")`。
- `it("accepts a decided entry with source refs quoted from the current user message")`。
- `it("accepts an inferred entry with source refs and no quote")`。
- `it("rejects a stated body rewrite of a requirement that keeps source refs")`：没有当前用户逐字摘录时 409 新文案；文件不变。不带 `sourceRefs` 的现有需求用例仍是 200。
- `it("rejects a source ref from another workspace")`。
- `it("rejects a stale source ref revision")`。
- `it("rejects a source ref quote that is not in the excerpt")`。
- `it("does not consume an evidence event supplied by the agent")`：先插入未消费事件，请求体带 `confirmationEventId` 和 `basis: "decided"`。状态 409，事件 `consumed_commit` 仍为 null，决策 basis 不变。
- `it("ignores confirmed:true on a snapshotted source")`：`confirmedAt` 不变。
- `it("refuses agent edits to a snapshotted source body")`。
- `it("rejects an agent basis change on a snapshotted source even with a verbatim user quote")`：409 文案为 `导入的来源不能由 Agent 改 basis。只有界面的 promote_basis 事件可以。` 标题正文可以与磁盘相同。文件不变。
- `it("rejects clearing source refs then promoting without a current quote")`：需求条目已有 `sourceRefs`。POST 送 `sourceRefs: []` 且 `basis: "decided"`，没有当前用户逐字摘录。409 是外部证据那句，不是 200。文件的引用还在。
- 不要改现有八个决策测试和 quote 测试的期望。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub roomApi` → 新用例 FAIL，旧决策用例 PASS。
- [ ] **Step 3: 实现**。在已有 `UpsertGuard` 里，先跑旧的 active 决策守卫，再保留 #28 的 `assertCurrentTaskUserEvidence`（用户 basis 证据检查和失效→active 检查，不得删除），再跑带快照来源的 basis 拒绝，再用「写入前或写入后有 `sourceRefs`」做外部引用一步。读旧引用和写文件在同一把仓库锁里。`getTask` / `getMessage` 只在需要新 409 的分支上查。纯聊天路径保持 #28 合入后的行为，不在没有 `sourceRefs` 时追加逐字摘录。
- [ ] **Step 4: 跑** `npx vitest run --project @nema/hub roomApi` 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): require real confirmation for external evidence`

### Task 7: 界面确认写下事件

**Files:**
- Modify: `apps/hub/src/uiApi.ts`
- Modify: `packages/knowledge/src/store.ts`（`confirm` 在有快照时设置 `confirmedRevision`；通过 `CommitMeta.evidenceEventIds` 写入 commit 消息）
- Test: `apps/hub/test/uiApi.test.ts`

**Interfaces:**
- `PUT` 与 `POST .../confirm` 的 Git 结果保持 #28 合入后的界面 basis 规则（仍不检查当前任务的用户消息，也不走 Room 的 `user_basis_evidence`）。这不删除 `POST /entries` 上的用户 basis 证据检查和失效→active 检查。在 Git 之前插入 spec 规定的事件种类。Git 成功后消费。同一 payload 的重复确认不再产生 commit。
- `PUT` 不接受客户端快照或 `confirmedRevision`。
- 在测试 app 上内联一层与 `createGatewayUiAuth` 相同契约的中间件（检查 `x-nema-gateway-credential`）。不要从 hub 测试 `import` `apps/local`。Room Bearer 调 `POST /api/.../confirm` 得到 401，且没有新的 `evidence_events` 行。不要在 confirm 处理函数里识别 run token。现有不挂 `uiAuth` 的 `uiApi.test.ts` 用例继续走它们今天的调用方式。`PUT` 在写 Git 之前插入 `promote_basis`。同一 payload 的并发确认只有一条事件、一次 commit。

- [ ] **Step 1: 写失败测试**

- `it("confirm of an inferred decision records a consumed promote_basis event")`。
- `it("confirm of a snapshotted source records confirm_revision and does not mark a null revision current")`：不调用 `recordSourceCheck`。条目 `confirmedRevision` 为 null，DB 无 `current` 行。
- `it("replaying confirm does not add a commit or a second event")`。
- `it("a room token cannot confirm through the gated ui route")`：内联 gateway 凭证中间件，不 import `apps/local`。`Authorization: Bearer <run token>` 且不带 `x-nema-gateway-credential`。状态 401，事件行数不变。
- `it("put records a consumed promote_basis event")`：PUT 改标题后，事件 kind 为 `promote_basis`，`consumed_commit` 等于这次提交。
- `it("two concurrent confirms share one event and one commit")`：同一 payload 并发两次，事件一行，commit 数只加 1。
- 现有 confirm / PUT 测试若只断言 basis 和 200，保持它们通过。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub uiApi` → FAIL。
- [ ] **Step 3: 实现**。事件事务先提交，再 Git。Git 失败时不消费。重复请求走 `payload_hash`。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): record ui confirmation as evidence events`

### Task 8: 新鲜度写入和 reviewNeeded

**Files:**
- Create: `apps/hub/src/sourceFreshness.ts`
- Modify: `apps/hub/src/roomApi.ts`（GET 列表和 GET 单条附加字段）
- Modify: `apps/hub/src/uiApi.ts`（条目列表和单条附加字段）
- Test: `apps/hub/test/sourceFreshness.test.ts`（新建）、`apps/hub/test/roomApi.test.ts`

**Interfaces:**
- `recordSourceCheck(db, dataDir, workspaceId, entryId, observed)`。条目不是本 workspace 的带快照 source 时抛 404。写入行必须满足迁移里的 check。
- `attachSourceEvidence(entries, freshnessRows)` 或等价纯函数：返回 `freshness`、`reviewNeeded`、`unconfirmedSnapshot`，规则用 spec。不写文件。四个读接口都带这三个字段：Room 列表、Room GET、UI 列表、UI 单条。非 source 的 `unconfirmedSnapshot` 为 false。
- 没有 Room 或 UI 路由去调用 `recordSourceCheck`。测试直接调函数。

- [ ] **Step 1: 写失败测试**

- `it("stores changed and leaves the decision file untouched")`：决策带一条 `sourceRef`。记录 `changed` 之后读决策文件字节不变，`reviewNeeded` 为 true。
- `it("does not set reviewNeeded when the source has never been checked")`。
- `it("clamps a current row to unknown when the snapshot revision is null")`：即使有人写入非法组合，读路径也不返回 `current`。优先让 `recordSourceCheck` 根本写不进这种行；再断言读路径。
- `it("unknown and timeout do not set reviewNeeded")`。
- `it("a ref revision that differs from the snapshot sets reviewNeeded")`。
- `it("sets reviewNeeded when a null revision snapshot hash changes")`：两边 revision 为 null，`SourceRef.snapshotHash` 与当前 `contentHash` 不同。`reviewNeeded` 为 true，`freshness` 是 `unknown`，决策文件字节不变。
- `it("reports unconfirmedSnapshot after a reimport that keeps basis stated")`：S 的 basis 仍是 `stated`，`unconfirmedSnapshot` 为 true。Room 列表、Room GET、UI 列表、UI 单条都带这个字段。非 source 为 false。

- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub sourceFreshness roomApi` → FAIL。
- [ ] **Step 3: 实现**。GET 用已经列出的条目在内存里算，不要为每条引用再扫一遍磁盘以外的来源。
- [ ] **Step 4: 跑** 同一条 vitest 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): report source freshness without rewriting decisions`

### Task 9: 启动时补齐导入 receipt 和未消费事件

**Files:**
- Modify: `apps/hub/src/lifecycle.ts`
- Modify: `apps/hub/src/sourceImport.ts`（若对账函数已在任务 5 导出，这里只调用）
- Modify: `apps/hub/src/evidenceEvents.ts`（`reconcileUnconsumedEvents`）
- Test: `apps/hub/test/sourceImport.test.ts`、`apps/hub/test/evidenceEvents.test.ts`

**Interfaces:**
- 在 `recoverUncommittedEntries` 之后对每个 workspace（含归档）调用导入对账，再调用事件对账。一个 workspace 抛错只打日志。
- 事件对账：未消费、`consumable` 为 true、该条目文件的最新提交（`git log -1 --format=%H -- <相对路径>`，不是仓库 HEAD）的 `Evidence-Event:` 含该事件 id，且该提交里的文件 payload 与事件一致时，把 `consumed_commit` 设为那个 sha。缺 trailer、payload 不一致、或 `consumable` 为 false，则不动。不得调用 `upsert` 去改 basis。

- [ ] **Step 1: 写失败测试**

- `it("reconcileUnconsumedEvents fills the commit when the entry already matches")`。
- `it("reconcileUnconsumedEvents does not change an entry that does not match")`：文件字节不变，`consumed_commit` 仍为 null。
- `it("does not consume when the commit message has no Evidence-Event trailer")`：payload 即使一致也不填 `consumed_commit`。
- `it("reconcile skips an event restored as not consumable")`：`consumable` 为 false 时对账跳过，basis 不变。
- 任务 5 已有的 reserved receipt 用例若还没经过 lifecycle，补一条直接调用 `reconcileSourceImports` 的断言即可，不必把整个 hub 进程拉起来。

- [ ] **Step 2: 跑** 对应 vitest → FAIL。
- [ ] **Step 3: 实现** 接线。
- [ ] **Step 4: 跑** `npx vitest run --project @nema/hub sourceImport evidenceEvents` 和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): reconcile source imports after startup recovery`

### Task 10: prompt 与技术参考

**Files:**
- Modify: `apps/hub/src/prompt.ts`
- Modify: `docs/reference.zh-CN.md`
- Test: `apps/hub/test/prompt.test.ts`

**Interfaces:**
- `buildPrompt` 的规则数组始终包含 spec 里的那句摘录警告，主聊天和 thread 相同。
- 参考文档用中文补上：确认事件不在 `messages`；新的 400/409 原句（含 Agent 不能改带快照来源的 basis）；Agent 不能改导入快照；`null` revision 不是 `current`；`unconfirmedSnapshot` 的含义。不要写「已经支持 Notion / Google」。不要改 README。不要在这里修 #28。

- [ ] **Step 1: 写失败测试** `it("prompt treats source excerpts as untrusted data")`：断言那句中文同时出现在主聊天 prompt 和 thread prompt。
- [ ] **Step 2: 跑** `npx vitest run --project @nema/hub prompt` → FAIL。
- [ ] **Step 3: 实现** prompt 与 `docs/reference.zh-CN.md` 的 API 小节。对照任务 6、7 的最终文案，不要另写一套。
- [ ] **Step 4: 跑** prompt 测试、`npm run typecheck`、`node --test scripts/ci/docs-check.test.mjs` → PASS。
- [ ] **Step 5: Commit** `docs: describe the source evidence protocol`

---

## 做完之后

- 跑 `npm run typecheck` 和 `npx vitest run --project @nema/shared --project @nema/knowledge --project @nema/hub sourceEvidence entry store commitMessage roomApi uiApi sourceImport evidenceEvents sourceFreshness prompt workspaces`，以及 `npx vitest run --project @nema/local migration`。
- 不要把 CX-03 在 `ROADMAP.md` 标成已完成。P0 验收仍按路线图自己的标准。
- 不要实现 CX-09。`PendingWrite` 的 `failed` / `outcome_unknown` 只留在 spec 的未决问题里。
