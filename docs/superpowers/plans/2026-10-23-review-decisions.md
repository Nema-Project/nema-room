# Review Decisions Q2–Q6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the user's answers to review questions Q2–Q6: bounded retry of interrupted tasks, recovery of crash leftovers, a guard on rewriting active decisions, `stated / decided / inferred` basis marking, verbatim quotes, and ingest / last-confirmed times with a "may be outdated" flag.

**Architecture:** New entry fields live in the shared zod schema and the knowledge store's frontmatter. The hub's Room API enforces basis, quotes and the decision guard, so none of it depends on the Agent's goodwill. Task interruption becomes a counted transition in `tasks.ts`. Crash recovery is a `KnowledgeStore` method that the hub calls at startup. The web shows the new fields and a confirm button.

**Tech Stack:** TypeScript monorepo, zod v4, gray-matter, git CLI, Hono, PostgreSQL/PGlite, Next.js + React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-nema-room-design.md` — §3 (quotes are team-visible), §4.1 (source times), §4.2 (Q4 guard), §4.3 (Q5 basis), §4.4 (freshness), §4.5 (Q2 retries, Q3 recovery), §6.3 (frontmatter fields, no backup command).

## Global Constraints

- Work directly on `main` (user's choice). Don't push. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests make no real network or model calls. Run a single test file with `npx vitest run <path>` from the repo root.
- Interrupted tasks: up to **3** automatic retries; the 4th interruption marks the task failed. Only interruptions count; a run that ends with a normal failure is still failed directly.
- Basis values are exactly `stated`, `decided` and `inferred`.
- A stale threshold applies only to `kind: "source"`: **90 days** since `confirmedAt`. No other kind is flagged automatically.
- Recovery commits use author `system`. This adds a third author value next to `agent` and `user`.
- Web copy must exist in all three locales (ja / en / zh) and follow the existing Swiss style. No new colors beyond the existing tokens.
- Hub user-facing error and message text is Chinese, matching the existing hub messages.
- Entries written before this plan have no basis or times. They must keep loading, listing, rendering and updating; their missing values read as `null`.

## Review Focus

1. **Legacy entry files** (no `basis`, `ingested_at`, `confirmed_at` or `quotes`): they load with `null` / `[]`, list fine, and gain times on their next update without rewriting `ingestedAt` to "now". Pinned in Task 2.
2. **Agent changes only the status of an active decision** to `superseded`, with `basis: "inferred"`: the guard must reject it, not just body rewrites, and the file must be byte-identical afterwards. Pinned in Task 4.
3. **Dispatch race vs. real interruption**: a task claimed but never sent (connection changed between claim and assign) is requeued without spending a retry; four real interruptions fail it with a system message. Pinned in Task 6.
4. **Half-written file after a crash**: an untracked entry file that fails to parse is neither committed nor deleted, and parseable siblings are still recovered. Pinned in Task 3.
5. **Quote text with CJK, Markdown and inner whitespace**: an exact substring of the message passes, while the same text with collapsed whitespace is rejected. Pinned in Task 4.

---

### Task 1: Shared entry schema — basis, times, quotes, staleness

**Files:**
- Modify: `packages/shared/src/entry.ts`
- Test: `packages/shared/test/entry.test.ts`

**Interfaces:**
- Produces:
  - `BASIS_VALUES = ["stated", "decided", "inferred"] as const`, `type Basis`.
  - `Quote = z.object({ messageId: z.string().min(1), text: z.string().min(1).max(500) })`, `type Quote`.
  - `EntryFrontmatter` gains:
    - `basis: Basis | null`
    - `ingestedAt: string | null` and `confirmedAt: string | null` (ISO 8601 datetimes, `z.iso.datetime({ offset: true })` or `z.string().datetime()`; pick the one the repo's zod version supports)
    - `quotes: Quote[]`
  - `EntrySummary` gains `basis` and `confirmedAt`.
  - `UpsertEntryInput` gains three optional fields:
    - `basis?: Basis`. It stays optional here; the Room API makes it required in Task 4.
    - `quotes?: Quote[]`, at most 10.
    - `confirmed?: boolean`.
  - `STALE_SOURCE_DAYS = 90`.
  - `isStale(e: Pick<EntrySummary, "kind" | "confirmedAt">, now: Date): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
test("frontmatter accepts basis, times and quotes", () => {
  const fm = EntryFrontmatter.parse({ ...baseDecision, basis: "inferred", ingestedAt: "2026-10-23T01:02:03.000Z", confirmedAt: "2026-10-23T01:02:03.000Z", quotes: [{ messageId: "m_1", text: "先流式" }] });
  expect(fm.basis).toBe("inferred");
});
test("frontmatter rejects an unknown basis", () => {
  expect(EntryFrontmatter.safeParse({ ...baseDecision, basis: "guessed", ingestedAt: null, confirmedAt: null, quotes: [] }).success).toBe(false);
});
test("upsert input rejects a quote longer than 500 characters", () => {
  expect(UpsertEntryInput.safeParse({ ...baseUpsert, quotes: [{ messageId: "m_1", text: "x".repeat(501) }] }).success).toBe(false);
});
test("isStale flags only sources unconfirmed for more than 90 days", () => {
  const now = new Date("2026-10-23T00:00:00Z");
  expect(isStale({ kind: "source", confirmedAt: "2026-07-24T23:59:59Z" }, now)).toBe(true);   // 90 days + 1s
  expect(isStale({ kind: "source", confirmedAt: "2026-07-25T00:00:00Z" }, now)).toBe(false);  // exactly 90 days
  expect(isStale({ kind: "decision", confirmedAt: "2020-01-01T00:00:00Z" }, now)).toBe(false);
  expect(isStale({ kind: "source", confirmedAt: null }, now)).toBe(false);
});
```

`baseDecision` and `baseUpsert` are the fixtures the file already uses (add them if missing). Existing frontmatter fixtures need `basis: null, ingestedAt: null, confirmedAt: null, quotes: []` added.

- [ ] **Step 2: Run** `npx vitest run packages/shared/test/entry.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the schema additions and `isStale`** in `packages/shared/src/entry.ts`. `isStale` returns true when `kind === "source"`, `confirmedAt !== null`, and `now - confirmedAt > 90 × 86_400_000` ms.
- [ ] **Step 4: Run** `npx vitest run packages/shared` and `npx tsc -b`. Expected: shared tests PASS. Type errors in other packages are expected until Task 2; record them, don't fix them here.
- [ ] **Step 5: Commit** `feat(shared): entry basis, times, quotes and staleness`.

---

### Task 2: Knowledge store persists the new fields

**Files:**
- Modify: `packages/knowledge/src/store.ts`
- Test: `packages/knowledge/test/store.test.ts`

**Interfaces:**
- Consumes: Task 1's types.
- Produces:
  - `CommitMeta = { author: "agent" | "user" | "system"; taskId?: string; now?: Date }`. `now` is for tests and defaults to `new Date()`.
  - `KnowledgeStore.confirm(id: string, meta: CommitMeta): Promise<{ entry: Entry; commit: string }>`. Used by Task 5.
  - Frontmatter keys on disk: `basis`, `ingested_at`, `confirmed_at`, `quotes` (a list of `{message_id, text}`). Write these keys only when the value is non-null or non-empty, so legacy files stay diff-free until they are touched.

**Rules in `upsert`:**
- `basis`: the input value, else the existing value, else `null`.
- `quotes`: the existing quotes plus new ones, de-duplicated by `messageId + text`. Like `sourceMessages`, provenance accumulates.
- `ingestedAt`: on add, `now`; on update, the existing value, which stays `null` for a legacy entry.
- `confirmedAt`: on add, or when `input.confirmed === true`, `now`; otherwise the existing value.

**Rules in `confirm`:**
- `basis`: `inferred` becomes `decided` for a decision and `stated` for any other kind. Any other value (including `null`) is kept, except that `null` becomes `decided` / `stated` the same way.
- `confirmedAt` becomes `now`.
- Commit: op `update`, reason `用户确认仍然有效`, no new source messages, and the given meta.

- [ ] **Step 1: Write the failing tests**
  - `round-trips basis, times and quotes through the file`: add an entry with `basis: "inferred"` and a quote at a fixed `now`. Then `get` returns the same values, and `ingestedAt === confirmedAt === now.toISOString()`.
  - `loads a legacy file without the new keys`: write a hand-made file in the pre-plan format and commit it. `get` returns `basis: null, ingestedAt: null, confirmedAt: null, quotes: []`, and `list()` includes it.
  - `update keeps ingestedAt and only refreshes confirmedAt when confirmed is true`: add at T1; update at T2 without `confirmed` (both times stay T1); update at T3 with `confirmed: true` (`ingestedAt` T1, `confirmedAt` T3).
  - `updating a legacy entry leaves ingestedAt null`.
  - `quotes accumulate without duplicates across updates`.
  - `confirm turns inferred into decided for a decision and stated for a requirement, sets confirmedAt, and commits as the given author`. Check the commit message through `history()`: the reason is `用户确认仍然有效`.
- [ ] **Step 2: Run** `npx vitest run packages/knowledge/test/store.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `toFile` / `fromFile` / `summarize` / `upsert` changes and `confirm` in `store.ts`. `confirm` reuses the same locked write-and-commit path as `upsert`. Extract a private helper rather than duplicating the write, commit and rollback block.
- [ ] **Step 4: Run** `npx vitest run packages/knowledge` and `npx tsc -b`. Expected: PASS. Fix any compile errors in hub and web caused by the new required summary fields; adding `null` defaults in test fixtures is fine.
- [ ] **Step 5: Commit** `feat(knowledge): persist basis, times and quotes`.

---

### Task 3: Recover uncommitted changes at hub startup (Q3)

**Files:**
- Modify: `packages/knowledge/src/commitMessage.ts`, `packages/knowledge/src/history.ts`, `packages/knowledge/src/store.ts`, `apps/hub/src/main.ts`
- Test: `packages/knowledge/test/commitMessage.test.ts`, `packages/knowledge/test/store.test.ts`, `packages/knowledge/test/history.test.ts`

**Interfaces:**
- Consumes: Task 2's `CommitMeta` with author `"system"`.
- Produces:
  - `CommitOp = "add" | "update" | "recover"`. `CommitInfo.author` and `HistoryItem.author` / `ParagraphBlame.author` widen to `"agent" | "user" | "system"`.
  - `KnowledgeStore.recoverUncommitted(now?: Date): Promise<{ recovered: Entry[]; skipped: string[] }>`. `skipped` holds repo-relative paths that were left untouched.

**Behaviour:** everything runs under `withRepoLock`.
1. Read `git status --porcelain=v1 -z --untracked-files=all`.
2. Take each modified, added or untracked path that matches `<kind dir>/<ID>.md` with a matching id prefix.
   - If it parses with `fromFile`, commit it alone: `git add -- <rel>`, then `git commit -- <rel>` with `formatCommitMessage({ op: "recover", id, title, reason: "hub 启动时发现的未提交改动（崩溃后恢复）", sourceMessages: [], author: "system" })`. Then push it to `recovered`.
   - If it does not parse, push the path to `skipped`, log a warning, and leave the file as is.
3. Any other path (deletions, non-entry files) goes to `skipped` untouched. The app never deletes entries, so a deletion is not crash output.
4. A clean repo returns `{ recovered: [], skipped: [] }` without committing.

`parseCommitMessage` must accept `recover` heads and the `system` author. Everything it accepted before stays accepted.

**Hub wiring (`main.ts`):** after `migrate` and before `serve`, loop over every workspace, including archived ones. For each, call `new KnowledgeStore(repoPath(dataDir, ws.id)).recoverUncommitted()`, then `indexEntry` each recovered entry. Log `recovered N uncommitted entr(y|ies) in <wsId>` and each skipped path. A failure in one workspace is logged and does not stop the others or the hub. If no exported "list all workspaces including archived" query exists in `workspaces.ts`, add one.

- [ ] **Step 1: Write the failing tests**
  - In `commitMessage.test.ts`: `round-trips a recover commit by system`.
  - In `store.test.ts`:
    - `recovers a modified tracked entry as a system recover commit`: commit an entry, overwrite the file with a valid edited version without committing, call `recoverUncommitted()`. Expect `recovered[0].id`, a clean `git status`, and the `history()` head is `{ op: "recover", author: "system", reason: "hub 启动时发现的未提交改动（崩溃后恢复）" }`.
    - `recovers an untracked new entry file`.
    - `recovers a staged but uncommitted entry`: `git add` without commit.
    - `leaves an unparseable untracked entry file untouched and still recovers a valid sibling` (Review Focus 4). The broken file's bytes are unchanged, it is still untracked, and its path is in `skipped`.
    - `does nothing on a clean repo`: HEAD is unchanged.
  - In `history.test.ts`: `blame attributes a recovered paragraph to system`.
- [ ] **Step 2: Run** `npx vitest run packages/knowledge`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the commit-format widening, `recoverUncommitted`, and the hub startup loop.
- [ ] **Step 4: Run** `npx vitest run packages/knowledge apps/hub` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: recover uncommitted entries at hub startup`.

---

### Task 4: Room API enforces basis, quotes and the decision guard (Q4, Q5, Q6)

**Files:**
- Modify: `apps/hub/src/roomApi.ts`
- Test: `apps/hub/test/roomApi.test.ts`

**Interfaces:**
- Consumes: Task 1's `UpsertEntryInput` (`basis`, `quotes`, `confirmed`), Task 2's store.
- Produces: no new exports. These are new HTTP outcomes of `POST /room/entries`.

**Checks**, in this order, after the existing schema and sourceMessages checks:
1. `basis` missing → 400 `basis: required (stated | decided | inferred)`.
2. Each quote's `messageId` must be in this request's `sourceMessages`; otherwise 400 `quotes: message <id> is not in sourceMessages`. Its `text` must be an exact substring of that message's `content`, with no normalization; otherwise 400 `quotes: text must be copied verbatim from message <id>`. Load the cited messages' `role` and `content` with one query, extending the existing `select id from messages` lookup.
3. **Decision guard.** It applies when the target exists, `existing.kind === "decision"`, `existing.status === "active"`, and the request changes the status away from `active`, changes `title`, or changes `body`. The request then passes only if:
   - `basis` is `stated` or `decided`, and
   - this request's `sourceMessages` include at least one message with `role = 'user'`.

   Otherwise return 409 with exactly: `改写已定决策 <id> 需要用户消息作为依据（basis 为 stated 或 decided，且 sourceMessages 含用户消息）。若只是推断，请不要改它，改为新建一条 question 询问用户。`

   Other kinds, non-active decisions, and updates that touch only `related` / `businessDate` / `quotes` / `confirmed` are not guarded.

Ordering note: until Task 7 lands, the live Agent's prompt does not mention `basis`, so real runs against a hub built from this commit would get 400s. Don't rebuild the compose hub between Task 4 and Task 7.

Ruling recorded here: the spec says "给出依据（用户的哪条消息）". Every upsert already cites the task's message, so the guard ties evidence to Q5: a rewrite must claim `stated`/`decided` and cite a user-role message. An `inferred` rewrite is exactly the "无依据" case the spec wants blocked.

- [ ] **Step 1: Write the failing tests.** Use the file's existing helpers for workspace, message, task and run token.
  - `rejects an upsert without basis` → 400.
  - `rejects a quote whose message is not cited` → 400.
  - `rejects a quote that is not verbatim, including collapsed whitespace` (Review Focus 5): message content `"先流式\n\n  后面再说多轮 **别动** tool"`. The quote `"后面再说多轮 **别动**"` passes; the quote `"先流式 后面再说多轮"` returns 400.
  - `blocks an inferred rewrite of an active decision's body` → 409 with the exact text; the file bytes are unchanged.
  - `blocks an inferred status-only change of an active decision to superseded` (Review Focus 2) → 409; the file is unchanged.
  - `blocks a stated rewrite whose only source is an agent message` → 409.
  - `allows a decided rewrite citing a user message` → 200, and the new body is saved.
  - `does not guard requirements or a superseded decision` → 200 with `basis: "inferred"`.
  - `does not guard a related-only update of an active decision` → 200 with `basis: "inferred"`.
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/roomApi.test.ts`. Expected: the new tests FAIL. Existing tests fail only because they lack `basis`; add `basis: "stated"` to their payloads.
- [ ] **Step 3: Implement** the three checks in `roomApi.ts`.
- [ ] **Step 4: Run** `npx vitest run apps/hub` and `npx vitest run apps/cli`. Expected: PASS. The CLI tool schema is derived from `UpsertEntryInput`, so `basis` / `quotes` / `confirmed` appear in `upsert_entry` automatically. If the CLI's tool-schema tests snapshot the schema, update the snapshot.
- [ ] **Step 5: Commit** `feat(hub): require basis and verbatim quotes; guard active decisions`.

---

### Task 5: UI API — user edits and confirm

**Files:**
- Modify: `apps/hub/src/uiApi.ts`
- Test: `apps/hub/test/uiApi.test.ts`

**Interfaces:**
- Consumes: Task 2's `KnowledgeStore.confirm`.
- Produces:
  - `PUT /api/workspaces/:id/entries/:eid` now overrides `basis` to `"decided"` for a decision and `"stated"` otherwise, and sets `confirmed: true`, whatever the client sent.
  - New `POST /api/workspaces/:id/entries/:eid/confirm` with body `{}`. It returns the confirmed `Entry`, re-indexes it, and emits `knowledge.changed`. Unknown entry → 404. Use the same JSON content-type and host guards as the other mutating routes.

- [ ] **Step 1: Write the failing tests**
  - `a user edit of an inferred decision becomes decided and refreshes confirmedAt`.
  - `a user edit of an inferred requirement becomes stated`.
  - `confirm marks an inferred source stated and sets confirmedAt; history shows author user and reason 用户确认仍然有效`.
  - `confirm on a missing entry is 404`.
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/uiApi.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** both routes.
- [ ] **Step 4: Run** `npx vitest run apps/hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): user edits set basis; confirm endpoint`.

---

### Task 6: Bounded retry of interrupted tasks and the retry prompt (Q2)

**Files:**
- Create: `apps/hub/src/db/migrations/004_task_interruptions.sql` (`alter table tasks add column interruptions int not null default 0;`)
- Create: `apps/hub/src/interrupts.ts`
- Modify: `apps/hub/src/tasks.ts`, `apps/hub/src/daemonSocket.ts`, `apps/hub/src/main.ts`, `apps/hub/src/prompt.ts`
- Test: `apps/hub/test/tasks.test.ts`, `apps/hub/test/daemonSocket.test.ts`, `apps/hub/test/prompt.test.ts`

**Interfaces:**
- Produces:
  - `MAX_INTERRUPT_RETRIES = 3` and `INTERRUPTED_ERROR = "任务被中断，自动重试 3 次后仍未完成。请重新发送这条消息。"` in `tasks.ts`.
  - `interruptRunning(db: Db, scope: { daemonId: string } | { exceptDaemonId: string } | "all"): Promise<{ requeued: string[]; failed: string[] }>`. It runs in one transaction. Each matching `running` row gets `interruptions + 1`.
    - If the new count is ≤ 3: requeue with `status='queued', run_token=null, daemon_id=null, started_at=null`.
    - Otherwise: `status='failed', error=INTERRUPTED_ERROR, run_token=null, finished_at=now()`.
  - It replaces `requeueAllRunning` (startup), `requeueRunningExcept` (hello) and the disconnect use of `requeueDaemonTasks`. Delete the first two.
  - `requeueDaemonTasks` stays, uncounted, for the dispatch-race paths in `dispatchOnce`, where a claimed task never reached the daemon.
  - `announceInterrupted(db: Db, events: EventBus, result: { requeued: string[]; failed: string[] }): Promise<void>` in `interrupts.ts`. For each failed id it adds a system message `"处理失败：" + INTERRUPTED_ERROR` with `{ taskId }` and emits `message.created`. It emits `task.updated` for every id in both lists.
  - `buildPrompt` input gains `priorChanges?: TaskChange[]`. `daemonSocket.buildTaskPrompt` passes `await listTaskChanges(db, task.id)`. When the list is non-empty, insert this section before `# 本次用户消息`:

    ```
    # 本任务中断前已写入
    <op> <entryId> | <kind> | <title>   (one line each)
    这是同一条消息的重试：这些条目已经写入，需要时用 id 更新，不要重复新建。
    ```

  - In `main.ts`, create the `EventBus` before the startup call so `interruptRunning(db, "all")` can be followed by `announceInterrupted`.

- [ ] **Step 1: Write the failing tests**
  - In `tasks.test.ts`:
    - `the fourth interruption fails the task with INTERRUPTED_ERROR`: claim, then `interruptRunning(db, "all")` three times with a re-claim in between; each returns `requeued`. The fourth returns `failed`, and the row has status `failed` and that error.
    - `interruptions are counted per task and scoped by daemon`: `{ daemonId }` touches only that daemon's rows, and `{ exceptDaemonId }` only the others.
    - `a normal failure is not retried`: `finishTask(..., { ok: false })` leaves the status `failed` and `interruptions` at 0.
  - In `daemonSocket.test.ts`:
    - `a dispatch race requeues without spending a retry` (Review Focus 3): use the file's existing race harness, or force `current !== conn` after the claim. `interruptions` stays 0.
    - `four daemon disconnects mid-run post a system failure message`.
  - In `prompt.test.ts`:
    - `lists prior changes on a retry` (exact section text above).
    - `omits the section when there are none`.
- [ ] **Step 2: Run** `npx vitest run apps/hub`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the migration, `interruptRunning`, `announceInterrupted`, the call-site changes and the prompt section.
- [ ] **Step 4: Run** `npx vitest run apps/hub` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): retry interrupted tasks at most 3 times`.

---

### Task 7: Prompt rules for basis, quotes and confirmation

**Files:**
- Modify: `apps/hub/src/prompt.ts`
- Test: `apps/hub/test/prompt.test.ts`

**Interfaces:**
- Consumes: Task 4's server checks; the rules tell the Agent what the server enforces.
- Produces: four rules, inserted after the current rule 3 ("不确定、有歧义…") and renumbered, with this exact text:
  1. `每次 \`upsert_entry\` 都要填写 \`basis\`：用户字面说过的写 \`stated\`，用户明确拍板的写 \`decided\`，你自己推断的写 \`inferred\`。用户没说过的内容只能写成 \`question\` 或标 \`inferred\`，不能写成 \`stated\` / \`decided\`。`
  2. `改写或作废 active 的决策，必须以用户消息为依据（basis 为 \`stated\` 或 \`decided\`，sourceMessages 含该用户消息）。只是推断时不要改它，新建一条 \`question\` 询问用户。`
  3. `需要保留用户原话时，用 \`quotes\`（messageId + 从该消息逐字复制的文本，最多 500 字）。摘录对团队可见，只摘与条目相关的部分。`
  4. `用户确认某条内容仍然有效时，更新该条目并设 \`confirmed: true\`。`
- The entry index line also shows basis when it is `inferred`: append ` | inferred`.

- [ ] **Step 1: Write the failing tests**
  - `includes the basis, decision, quote and confirm rules`: assert each exact string.
  - `marks inferred entries in the index`.
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/prompt.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): prompt rules for basis, quotes and confirmation`.

---

### Task 8: Web — basis, freshness, quotes, confirm, system author

**Files:**
- Modify: `apps/web/components/KnowledgePanel.tsx`, `apps/web/components/EntryDetail.tsx`, `apps/web/components/HistoryTab.tsx`, `apps/web/lib/hub.ts`, `apps/web/lib/i18n.tsx`, the global stylesheet only if a tag class is missing
- Test: `apps/web/test/KnowledgePanel.test.tsx`, `apps/web/test/EntryDetail.test.tsx`, `apps/web/test/HistoryTab.test.tsx`, `apps/web/test/i18n.test.tsx`

**Interfaces:**
- Consumes: Task 1's `isStale`, Task 5's confirm route.
- Produces:
  - `confirmEntry(workspaceId: string, entryId: string): Promise<Entry>` in `lib/hub.ts`.
  - i18n keys, with exact values:

| key | zh | ja | en |
|---|---|---|---|
| `basis.stated` | 用户说过 | 発言あり | Stated |
| `basis.decided` | 用户决定 | 決定済み | Decided |
| `basis.inferred` | 推断 | 推測 | Inferred |
| `know.stale` | 可能过时 | 古い可能性 | May be outdated |
| `detail.basis` | 依据 | 根拠 | Basis |
| `detail.ingestedAt` | 进库时间 | 登録日時 | Added |
| `detail.confirmedAt` | 最后确认 | 最終確認 | Last confirmed |
| `detail.confirm` | 确认仍有效 | 有効と確認 | Confirm still valid |
| `detail.quotes` | 原文摘录 | 原文の抜粋 | Quotes |
| `author.system` | 系统 | システム | System |

**Behaviour:**
- **List row:** when `basis === "inferred"`, show an outlined tag `basis.inferred` after the title. When `isStale(entry, new Date())`, show `know.stale` in the meta line. No tags for `stated` / `decided` or a null basis.
- **Detail, content tab:** show three rows: `detail.basis` (the label, or `detail.noValue` when null), `detail.ingestedAt` and `detail.confirmedAt` (day + time in the locale, or `detail.noValue`). Show quotes as blockquotes under `detail.quotes`; clicking one scrolls chat to its `messageId`, like the existing source links. Show a `detail.confirm` button when the basis is `inferred` or the entry is stale. Clicking it calls `confirmEntry` and refreshes the detail.
- **History:** author `system` renders with the existing outline tag style as `author.system`.

- [ ] **Step 1: Write the failing tests**
  - `KnowledgePanel shows 推断 for an inferred entry and 可能过时 for a source confirmed 91 days ago`. Freeze time with `vi.setSystemTime`. A `stated` entry shows neither tag.
  - `EntryDetail shows basis, times and quotes, and confirm calls the confirm route then shows the updated basis`. Mock `fetch` the way the file already does.
  - `EntryDetail hides confirm for a fresh stated entry`.
  - `HistoryTab labels a system author`.
  - `i18n has every new key in ja, en and zh`. Extend the existing completeness test if there is one.
- [ ] **Step 2: Run** `npx vitest run apps/web`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/web` and `npm run build -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): show basis, freshness and quotes; confirm entries`.

---

### Task 9: Full verification and README

**Files:**
- Modify: `README.md` (one short section, "Knowledge basis and freshness")

- [ ] **Step 1:** Add a short README section. It covers what `stated / decided / inferred` mean, that quotes are team-visible, the 90-day "may be outdated" flag for sources, the 3-retry rule for interrupted tasks, and that crash leftovers become `system` "recover" commits.
- [ ] **Step 2:** Run `npx vitest run`, `npx tsc -b`, `npm run typecheck -w apps/cli` and `npm run build -w apps/cli`. Expected: all PASS.
- [ ] **Step 3: Commit** `docs: knowledge basis, freshness and retries in README`.
