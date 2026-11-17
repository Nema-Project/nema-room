# Knowledge Tags Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were given authorizes it; otherwise leave changes for supervisor review.

**Goal:** Knowledge entries carry normalized `tags` in frontmatter. The panel filters by one tag. The `@` menu offers a tag group, and choosing a tag expands to plain entry mentions of its active entries. The agent sees a budgeted tag vocabulary and per-line tags in the entry index, and may only reuse existing tags. Share pages show tags. From this version on, the knowledge store also keeps frontmatter keys it does not know, so a later format field is not erased by this version.

**Architecture:**
- `packages/knowledge` keeps unknown top-level frontmatter keys from the file on disk when it rewrites an entry (D-8, Task 1, independent of tags).
- `packages/shared` owns `normalizeTag`, `TagSchema` and `TAG_LIMITS`. `EntryFrontmatter.tags` is lenient on read; `UpsertEntryInput.tags` is strict on write.
- The store writes `tags` only when it is non-empty, so untagged files keep their bytes.
- One additive migration adds `entry_index.tags text[]` and `tags_indexed_at`. `indexEntry` writes both in its single upsert.
- A repeatable startup backfill fills rows that are null or stale. The new columns stay out of snapshots.
- The hub's upsert guards enforce the per-workspace limit and the "agent reuses only existing tags" rule under the repository lock.
- `mention-context` adds a `tags` group, and a new route lists a tag's active entries. The web expands them into `entry` mentions; no new mention type is added.
- `buildPrompt` adds the vocabulary section and per-line annotations within byte budgets.
- `toPublicSummary` adds `tags`, and the share page filters by tag on the server.

**Tech Stack:** Node 22, TypeScript, gray-matter, zod, Hono, PostgreSQL / PGlite, Vitest, Next.js (app and pages routers), next-intl message files.

**Spec:** [Knowledge tags design](../specs/2026-11-16-knowledge-tags-design.md). Product rule: [#45](https://github.com/Nema-Project/nema-room/issues/45). Issue: [#162](https://github.com/Nema-Project/nema-room/issues/162).

**How this serves #45:** people and agents get one shared vocabulary that points at the same cross-kind set of entries. Choosing a tag records exactly which entries the user pointed at (D-1 A), so a past message stays checkable. Humans own the vocabulary, and agents only reuse it (D-5 C), so inferred categories are not presented as sourced labels. Tags never change `status`, `basis`, `verified` or `confirmedBy`.

**Estimated size:** 12 tasks (10 implementation, 1 docs + full verification, 1 separately authorized real-environment acceptance). Task 1 is designed to ship as its own PR first.

**Sequencing relative to the [identity model](2026-11-17-identity-model.md):** land **tags first**, with Task 1 (D-8) as the very first PR of either feature. Reasons:
1. D-8 is a compatibility fix that protects every later format change. The sooner it ships, the fewer released versions can still erase unknown keys.
2. The identity spec already expects tags to merge first and to shift its migration number.
3. The two features overlap in `mentionContext.ts`, `prompt.ts`, `Composer.tsx` and `MentionMenu.tsx`. The tags changes there are narrower: no new mention type and no auth change. Identity rebasing onto tags is the cheaper direction.
4. Tags is user-visible. Identity Phase 1 is deliberately invisible for a single user.

## Global Constraints

- **Decided D-items are fixed** (spec, 2026-11-17, all per recommendation). Implement these and nothing else:
  - D-1 A: choosing a tag in `@` expands in the composer into `#tag：[X-n] …`. Each `[X-n]` is an ordinary `entry` mention, and `meta.mentions` never contains a tag. Only active entries (not in `INACTIVE_STATUSES`) are expanded. If the expansion would exceed the remaining mention slots (20 minus the existing mentions), insert nothing and explain why. Never truncate.
  - D-2: `entry_index.tags text[]` plus `tags_indexed_at timestamptz`. No join table.
  - D-3: `normalizeTag` applies, in order:
    1. NFKC.
    2. Trim, then collapse internal whitespace into `-`.
    3. `toLowerCase()`.
    4. Check the charset `^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$`u.
    5. Reject id-shaped tags (`^(r|d|t|q|s|g|w)-[1-9]\d*$`).
    6. Enforce the length limit in code points.
    7. Deduplicate within an entry, keeping the first occurrence.

    Only the folded form is stored. The write path returns 400 and names the tag. The read path drops invalid tags with a warning and never drops the entry.
  - D-4: `TAG_LIMITS = { tagChars: 32, perEntry: 8, perWorkspace: 200 }`.
  - D-5 C: users and agents can both write tags. An agent writing a tag that this workspace does not have yet gets 400 ("新 tag 需要用户先在面板里创建"). Omitting `tags` keeps the stored value, and `[]` clears it.
  - D-6 C:
    - A `# 现有 tags` vocabulary section of at most 2048 bytes.
    - A ` | tags: a, b` annotation on active index lines, at most 96 bytes per line and at most 4096 bytes in total.
    - Budget is allocated from the last (most recent) index line backwards.
    - A trailing notice when any line lost its tags.
    - With no tags in the workspace, the prompt is byte-identical to today's.
  - D-7 A: `PublicSummary` gains `tags`. The share design is updated, and the public list can be filtered by tag through server-side rendering only.
  - D-8 C: from this version on, `fromFile`/`toFile` keep unknown top-level frontmatter keys as read. They are not validated and do not reach `EntrySummary`.
  - D-9 A: the panel filter is single-select. Its state lives only in the component and is cleared when the workspace changes.
- **Migration numbering.** Today the last migration is `020_mention_browse_indexes.sql` (`apps/hub/src/db/migrations/`). Take the next free number at implementation time. This plan assumes tags lands first and uses `021_entry_index_tags.sql`. The identity plan then uses `022_identity.sql`. If identity has already merged with `021_identity.sql`, use `022_entry_index_tags.sql`. Never renumber a migration that is already on `main`: `schema_migrations` tracks applied migrations by file name (`apps/hub/src/db/db.ts:37-45`). Both migrations are additive and independent, so either order applies cleanly.
- **Recorded traps:**
  - Today's (already released) hubs drop unknown frontmatter on rewrite, because `fromFile`/`toFile` map field by field (`packages/knowledge/src/store.ts:105-215`). Downgrade loss of tags is accepted and documented. Task 1 only protects future fields.
  - A parse failure hides the whole entry: `readAll` skips it with a warning (`store.ts:439-458`). Tag validation on the read path must therefore be lenient, and `EntryFrontmatter.tags` must never be strict.
  - An unknown mention `type` returns 400 for the whole send on an old hub. That is why D-1 A uses plain `entry` mentions. Do not add a `tag` mention type.
  - Snapshots reject unknown tables and columns (`apps/hub/src/db/snapshot.ts:81-91`). The two new `entry_index` columns stay **out** of `TABLE_COLUMNS`.
- Tags are navigation. They never set or clear `verified`/`confirmedBy`, and no tag path ever sets `confirmedBy: "user"`.
- Tag values never go into log text. The workspace-limit error states only the limit.
- Tests use temporary data directories, PGlite and fake daemons. No real `~/.nema`, no real models.
- Docs parity:
  - Four READMEs: `README.md` and `README.en.md` byte-identical; `README.zh.md` and `README.ja.md` state the same facts.
  - The three `docs/guide.*.md` files and `docs/reference.zh-CN.md`.
  - The share design amendment.
  - Every new web string in `apps/web/messages/{en,zh,ja}.json`.
  - One `changelog.d` fragment, plus a second one for Task 1 if Task 1 ships as its own PR.

## Review Focus

- Task 1 byte-identity. A file with no unknown keys must rewrite to exactly the bytes it would have had before this change. An unknown key's value must survive `upsert`, `confirm`, `withdraw`, diagram redraw, work-package writes and source re-import. A key the current version knows and deliberately omits (for example a null `basis`) must not be revived from the old file.
- Lenient read versus strict write. A hand-edited invalid tag must never hide an entry (Task 3). Every write path must keep the stored tags (Tasks 3 and 5).
- `indexEntry` must set `updated_at` and `tags_indexed_at` from one timestamp, so the backfill condition `tags_indexed_at < updated_at` holds only for rows written by an old hub (Task 4).
- D-5 C holds only on the room (agent) API. UI edits may introduce new tags. Both paths enforce the 200 limit (Task 5).
- Prompt byte-identity when there are no tags, and the budget arithmetic in UTF-8 bytes: no split characters, no split tags (Task 7).
- D-1 A never partially inserts, and `meta.mentions` contains only `entry` items (Task 10).
- The share projection stays an allow-list. Only `tags` is added (Task 8).

---

### Task 1: Preserve unknown frontmatter keys (D-8 C) — standalone

**Spec:** D-8, §现状 (frontmatter mapping).

**Files:** `packages/knowledge/src/store.ts` (`toFile` `:105-182`, `fromFile` `:184-215`, `writeAndCommit` `:850-890`), `packages/knowledge/test/store.test.ts`. If this task ships alone, also add `changelog.d/knowledge-keep-unknown-frontmatter.changed.md`.

**Interfaces:**
- Produce `KNOWN_FRONTMATTER_KEYS`, a readonly set of the top-level YAML keys this version reads or writes: `id kind title status business_date related source_messages url priority diagram implementation workpackage source_snapshot source_refs confirmed_revision basis ingested_at confirmed_at quotes`. Task 3 adds `tags`.
- Produce `unknownFrontmatter(raw: string): Record<string, unknown>`.
- `toFile(e, preserved = {})` appends the preserved keys after the known ones, in their original order.

**Design choice (no spec change):** carry the unknown keys through the store's write path rather than through `Entry`:
- `writeAndCommit` already reads the previous file content (`store.ts:861-870`). Read it before `toFile`, extract the unknown keys, and pass them in.
- `Entry`, `EntrySummary`, `UpsertEntryResponse` (`packages/shared/src/roomApi.ts:5`) and the share projection therefore never see them. That satisfies "不参与校验，不进入 EntrySummary" without widening any API.
- `recoverUncommitted` commits files as they are on disk, so it needs no change.

- [x] Add failing tests to `store.test.ts`:
  - A legacy fixture with no unknown keys is byte-identical after an `upsert` that changes nothing but the body. Compare with the pre-change output for the same entry.
  - A fixture with `future_field: {a: [1, 2]}` and `x_note: "hi"`. After each of `upsert`, `confirm`, `withdraw`, `confirmImplementation`, `writeDiagram` (diagram fixture), `writeWorkPackageDoc`, `setWorkPackageMeta` (work-package fixture) and `writeImportedSource` (source fixture), the file still has both keys with equal YAML values, after the known keys and in their original order.
  - A file whose `basis: null` was written by hand stays without `basis` after a rewrite. A known key that is omitted is not resurrected.
  - `get()` returns an `Entry` with no unknown key on it, and `summarizeEntry` has none either.
  - A YAML date value under an unknown key round-trips to the same instant. Assert the actual behaviour of gray-matter/js-yaml and document it.
- [x] Run `npx vitest run packages/knowledge/test/store.test.ts` and confirm that the new cases fail.
- [x] Implement it, then rerun. Also run `npx vitest run packages/knowledge/test/history.test.ts apps/hub/test/sourceImport.test.ts apps/hub/test/workpackages.test.ts apps/hub/test/diagrams.test.ts` and `npm run typecheck`. Expect everything to pass with no existing assertion changed.

### Task 2: Shared tag normalization, limits and schema fields

**Spec:** D-3, D-4, §数据模型 / frontmatter.

**Files:** `packages/shared/src/tags.ts` (new; export it from `packages/shared/src/index.ts`), `packages/shared/src/entry.ts` (`EntryFrontmatter` `:185-212`, `EntrySummary` `:216`, `UpsertEntryInput` `:233-258`), `packages/shared/test/tags.test.ts` (new), `packages/shared/test/entry.test.ts`.

**Interfaces:**
- `TAG_LIMITS = { tagChars: 32, perEntry: 8, perWorkspace: 200 } as const`.
- `normalizeTag(raw: string): string | null`.
- `tagError(raw): string | null`, which gives the reason a tag was rejected, for 400 messages.
- `TagSchema`, a zod string that normalizes and refines with that reason.
- `normalizeTagList(raw: unknown): { tags: string[]; dropped: unknown[] }`, the lenient read helper.
- `EntryFrontmatter.tags: z.array(z.string()).default([])`.
- `UpsertEntryInput.tags: z.array(TagSchema).max(TAG_LIMITS.perEntry).optional()`. Deduplicate after normalization, and apply the max to the deduplicated list.
- `EntrySummary.tags: string[]`.

- [ ] Add failing tests:
  - `" ＡＰＩ "` becomes `api`, `Payment Flow` becomes `payment-flow`, and `支付` stays `支付`. A Devanagari tag with combining marks is accepted.
  - `d-12`, `a[b]`, `#x`, `a,b`, `a/b`, `@x`, `-x` and an empty string are rejected, and so is a tag of 33 code points. A 32-code-point tag of astral characters is accepted, because the limit counts code points.
  - `["API", "api"]` keeps one tag. Nine distinct tags fail the max.
  - `EntryFrontmatter.parse` without `tags` gives `[]`.
- [ ] Run `npx vitest run packages/shared/test/tags.test.ts packages/shared/test/entry.test.ts` and confirm that the new cases fail.
- [ ] Implement it, then rerun. Run `npm run typecheck`: `Entry` now requires `tags`, so fix every typed `Entry` literal the typecheck reports in source and tests. In tests use `tags: []`; do not loosen the type.

### Task 3: Store read/write of tags

**Spec:** D-3 (read path), §数据模型 / frontmatter (write paths).

**Files:** `packages/knowledge/src/store.ts` (`toFile`, `fromFile`, `summarizeEntry` `:295`, `upsert` `:522-590`, `writeDiagram` `:593`, `createWorkPackage` `:647`), `packages/knowledge/test/store.test.ts`.

- [ ] Add failing tests:
  - A file with `tags: [Payment Flow, "d-3", 支付, 支付]` reads as `["payment-flow", "支付"]`. It logs one warning that names the file but not the tag values, and the entry stays in `list()`.
  - A non-array `tags: hello` reads as `[]` with a warning.
  - `toFile` omits `tags` when it is empty, so an untagged legacy fixture stays byte-identical across a rewrite.
  - `summarizeEntry` always returns `tags`.
  - Preservation on every write path:
    - `upsert`: omitting `tags` keeps them, and `[]` clears them.
    - `writeDiagram` keeps `existing?.tags ?? []`.
    - `createWorkPackage` writes `[]`.
    - `withdraw`, `confirm`, `confirmImplementation`, `writeWorkPackageDoc` and `setWorkPackageMeta` keep the tags through their `...existing` spread.
  - `tags` is now a known key in Task 1's set: a tagged file is not duplicated as an "unknown" key.
- [ ] Run `npx vitest run packages/knowledge/test/store.test.ts` and confirm that the new cases fail.
- [ ] Implement it, then rerun and confirm it passes.

### Task 4: Migration, `indexEntry` and repeatable backfill

**Spec:** D-2, §数据模型 / `entry_index`, §回填.

**Files:** `apps/hub/src/db/migrations/021_entry_index_tags.sql` (or `022_…`, see Global Constraints), `apps/hub/src/entryIndex.ts` (`indexEntry` `:7-17`), `apps/hub/src/lifecycle.ts` (after `recoverUncommittedEntries` at `:66`, before `reconcileWorkspaceEvidence`/listen), `apps/hub/test/migrations.test.ts`, `apps/hub/test/entryIndex.test.ts`, `apps/hub/test/lifecycle.test.ts`. `apps/hub/src/db/snapshot.ts` must stay **unchanged** for these columns.

**Interfaces:**
- The migration is `alter table entry_index add column if not exists tags text[]; alter table entry_index add column if not exists tags_indexed_at timestamptz;`.
- `indexEntry` takes one timestamp, through a CTE or a `values` row with a single `clock_timestamp()`, and uses it for both `updated_at` and `tags_indexed_at`. It writes `tags = $n::text[]`.
- `backfillEntryTags(db, dataDir, ownedHelpers?)`.

- [ ] Add failing tests:
  - Migration: the columns exist and are null on old rows. Applying it again is a no-op.
  - `indexEntry`: `tags` is written and `tags_indexed_at = updated_at` holds exactly.
  - Backfill:
    - After the first start every row has non-null `tags`. A row whose file is gone gets `'{}'`.
    - A second start selects zero workspaces. Assert the query result, not timing.
    - Simulate an old hub with `update entry_index set updated_at = clock_timestamp()`. The next start re-reads that workspace.
    - A workspace whose repository is unreadable logs a warning and does not block startup or the other workspaces.
  - Snapshot: exported JSON has no `tags`/`tags_indexed_at` keys. An imported database starts with null columns and gets backfilled. Cover this with `apps/local/test/import.test.ts` and `apps/local/test/migration.test.ts`.
- [ ] Run `npx vitest run apps/hub/test/migrations.test.ts apps/hub/test/entryIndex.test.ts apps/hub/test/lifecycle.test.ts apps/local/test/import.test.ts apps/local/test/migration.test.ts` and confirm that the new cases fail.
- [ ] Implement it, then rerun.
- [ ] **Measure:** time the first backfill of a workspace with 1000 entries (a throwaway script or a skipped-by-default bench test) and record the number for the PR description. If it is above 1 s, move the backfill to after `listen`, in the background, and make the `tags` group and the limit count return empty/zero for un-backfilled workspaces until it finishes (spec §回填). Add a test for that mode.

### Task 5: Hub write rules — limits, D-5 C, path coverage

**Spec:** D-4 (workspace limit), D-5, §流程 / 写入, §验收 (write paths).

**Files:**
- `apps/hub/src/tags.ts` (new): `workspaceTags(db, ws)`, `tagGuard(...)`.
- `apps/hub/src/uiApi.ts`: the PUT at `:802-826` passes `guard` as `undefined` today; add the tags guard there.
- `apps/hub/src/roomApi.ts` (`POST /entries` `:123-206`): compose the tags guard with the existing guard.
- `apps/hub/src/sourceImport.ts` (`:104-107`).
- Tests: `apps/hub/test/uiApi.test.ts`, `apps/hub/test/roomApi.test.ts`, `apps/hub/test/sourceImport.test.ts`, `apps/hub/test/diagrams.test.ts`, `apps/hub/test/workpackages.test.ts`.

**Interfaces:**
- `workspaceTags` returns the distinct tags across the workspace's `entry_index` rows where `tags` is not null.
- The guard runs under the repository lock, inside `UpsertGuard`.
- It computes the new tags as the input tags minus the workspace's existing tags.
- Agent path: any new tag throws `UpsertRejected(400, "新 tag 需要用户先在面板里创建")`.
- Both paths: if the existing count plus the new tags exceeds 200, it throws `UpsertRejected(400, …)`. The message states only the limit.

- [ ] Add failing tests:
  - UI PUT normalizes and stores tags. An invalid tag returns 400 naming the tag and the reason. A ninth tag returns 400. The 201st distinct tag in a workspace returns 400, and the message does not list other tags.
  - Room upsert:
    - A tag that does not exist yet returns 400 with the D-5 message.
    - A tag created earlier through the UI succeeds, and the commit's `Author:` is `agent`.
    - Omitting `tags` keeps the stored ones. `[]` clears them.
  - Every hub write path keeps existing tags:
    - Confirm (`:828`), withdraw (`:735`) and implementation confirm (`:844`).
    - Diagram update (`diagrams.ts`).
    - Work-package doc, meta and approve (`workpackages.ts`).
    - Source re-import (`sourceImport.ts`).
    - A UI edit made by the old web, which omits `tags`.
  - `indexEntry` callers write the tags (assert `entry_index.tags` after each path).
- [ ] Run `npx vitest run apps/hub/test/uiApi.test.ts apps/hub/test/roomApi.test.ts apps/hub/test/sourceImport.test.ts apps/hub/test/diagrams.test.ts apps/hub/test/workpackages.test.ts` and confirm that the new cases fail.
- [ ] Implement it, then rerun and confirm it passes.

### Task 6: `@` menu tag group and tag-entries route

**Spec:** §流程 / `@` 菜单的 tag 组, D-1.

**Files:** `apps/hub/src/mentionContext.ts` (`MentionContext` `:16-27`, `mentionContext` `:194-222`, routes `:225-250`), `apps/hub/test/mentionContext.test.ts`.

**Interfaces:**
- `MentionContext.tags: { tag: string; active: number; inactive: number }[]`. It holds at most 8 entries; the query fetches 9 rows so it can set `truncated`. Rows are matched with the existing subsequence pattern and tier order on the tag, and ties are broken by `active desc, tag asc`.
- New route `GET /api/workspaces/:id/tags/:tag/entries` returns `{ entries: { id, kind, title, status }[] }`. It returns active entries only, ordered by kind (as in `KnowledgeStore.listEntries`) and then by number, with no bodies. It runs `normalizeTag` on the path parameter, returns 400 for an invalid tag and 404 for an unknown workspace.

The spec predates the browse cursor (`e75ec4e`, after the spec's HEAD `f21843e`). This plan computes the `tags` group only on the first page (no cursor) and returns `[]` on cursor pages. `tags.more` contributes to `truncated` but not to `nextCursor`. Confirm with the supervisor (see the report).

- [ ] Add failing tests:
  - Counts split into active and inactive. Subsequence matching works for CJK and Latin. Another workspace's tags never appear.
  - An un-backfilled (`null`) row contributes nothing.
  - The group order in the JSON is entries, tags, attachments, threads.
  - A cursor page returns `tags: []`.
  - The tag-entries route excludes `superseded`/`dropped`/`resolved` entries and has the right order. It cannot read across workspaces.
- [ ] Run `npx vitest run apps/hub/test/mentionContext.test.ts` and confirm that the new cases fail.
- [ ] Implement it, then rerun and confirm it passes.

### Task 7: Prompt vocabulary and per-line tags within budget

**Spec:** D-6.

**Files:** `apps/hub/src/prompt.ts` (`indexLine` `:15-20`, the index section at `:181`), `apps/hub/test/prompt.test.ts`.

**Interfaces:** `tagIndex(entries: EntrySummary[]): { vocabulary: string | null; lines: Map<string, string>; omitted: boolean }`. It is pure, has its own unit tests, and is used only for the `# 现有条目索引` section. The edit-cited list at `:217` keeps plain `indexLine`.

- [ ] Add failing tests:
  - With no entry tagged, the prompt is byte-identical to a fixture captured from current `main` before the change.
  - Vocabulary:
    - It comes after the index header, as the spec places it (`# 现有 tags`, one line `#a #b …`).
    - It is ordered by active count descending, then by tag.
    - Its total stays ≤ 2048 UTF-8 bytes.
    - Whatever does not fit becomes ` …（另有 N 个，用 list_entries 查看）`, and no tag is cut.
  - Lines:
    - Only active lines get ` | tags: a, b`.
    - Each annotation is ≤ 96 bytes, and the tags that do not fit become ` +N`.
    - The total across all annotations is ≤ 4096 bytes, allocated from the last line backwards. Older lines lose their tags first.
    - When any line lost tags, the notice line 「部分条目的 tags 未列出，用 list_entries 或 read_entry 查看」 appears.
  - Multi-byte cases: CJK and emoji tags at the exact boundary.
- [ ] Run `npx vitest run apps/hub/test/prompt.test.ts` and confirm that the new cases fail.
- [ ] Implement it, then rerun and confirm it passes. `daemonSocket.ts` already passes `timeline()`, whose summaries now carry `tags`. Run `npx vitest run apps/hub/test/daemonSocket.test.ts` and confirm it still passes.

### Task 8: Share projection, share design update, share-page tag filter (D-7)

**Spec:** D-7, §文档; [share design](../specs/2026-11-04-readonly-knowledge-share-design.md) D-6 (public fields).

**Files:**
- `apps/hub/src/shares.ts` (`PublicSummary` `:32-50`, `toPublicSummary` `:182`).
- `apps/hub/test/shares.test.ts`: the exact-shape assertion at `:143-153`, the hidden list at `:159`, and the route bodies at `:374-386`.
- `docs/superpowers/specs/2026-11-04-readonly-knowledge-share-design.md` (§D-6).
- `apps/web/lib/sharePage.ts` (`loadSharePage`), `apps/web/components/SharePage.tsx`, `apps/web/components/ShareView.tsx`.
- Tests: `apps/web/test/sharePage.test.ts`, `apps/web/test/ShareView.test.tsx`.
- `apps/web/messages/{en,zh,ja}.json`.

**Interfaces:** `PublicSummary.tags?: string[]`, present only when non-empty, like `priority`/`url`. Existing untagged public responses then stay byte-identical, and the exact-shape test at `:143` keeps passing unchanged. `PublicEntry` inherits it. The share page reads `?tag=`, normalizes it with `normalizeTag`, and filters the list on the server. An invalid or unknown tag shows the empty state; it is not an error. The tag links are plain `<a href="?tag=…">` with no client fetch.

- [ ] Add failing tests:
  - Hub: a tagged entry's public list item and entry JSON include `tags`. An untagged one has no `tags` key. Existing hidden-field lists still pass. Add a seeded check that the tags projection did not drag in a neighbouring private field (`sourceMessages`, `messageId`).
  - Web:
    - `?tag=支付` filters the server-rendered list. `?tag=Ｐayment` normalizes.
    - A tag that does not exist shows the empty state.
    - The tag chips are links, and no new client fetch is made.
- [ ] Run `npx vitest run apps/hub/test/shares.test.ts apps/web/test/sharePage.test.ts apps/web/test/ShareView.test.tsx` and confirm that the new cases fail.
- [ ] Implement it.
- [ ] Amend the share design §D-6:
  - Add `tags` (present when non-empty) to the 列表每条 field list.
  - Add one dated note: 「2026-11-17 起按 [knowledge tags](../specs/2026-11-16-knowledge-tags-design.md) D-7 公开 `tags`；公开列表可按 tag 服务端筛选。」
  - Do not edit the 不出现 list except to keep it accurate.
  - Keep the edit to those lines. The share design is a recorded spec, so amend it, do not rewrite it.
- [ ] Rerun the tests, then run `npm run lint -w apps/web`.

### Task 9: CLI — tool schema and old-hub notice

**Spec:** §兼容 (新 CLI、旧 hub; 旧 CLI、新 hub), D-5.

**Files:** `apps/cli/src/direct/tools.ts` (`z.toJSONSchema(UpsertEntryInput)` at `:15-22`, the upsert call at `:162`), `apps/cli/src/mcp/server.ts` (`:77`), `apps/cli/src/room/client.ts` (`:39`), `apps/cli/test/direct/tools.test.ts` or the nearest existing tools test, and `apps/cli/test/mcp/*` if present (find the files with `grep -rln upsert_entry apps/cli/test`).

- [ ] Add failing tests:
  - The generated `upsert_entry` schema contains `tags` (array, `maxItems` 8). It stays valid for both the codex-direct and MCP paths.
  - When an `upsert_entry` call includes `tags` and the hub response's `entry` has no `tags` key, as with an old hub, the tool result text says 「hub 不支持 tags，tags 未写入」. That way the agent does not believe the tags were saved.
  - When the response has `tags`, no notice is added.
- [ ] Run the identified CLI test files with `npx vitest run …` and confirm that the new cases fail.
- [ ] Implement it, then rerun. Run `npm run typecheck -w apps/cli`.

### Task 10: Web — edit tags, panel filter, tag group expansion

**Spec:** D-1, D-9, §流程 / 面板, §流程 / `@` 菜单的 tag 组.

**Files:**
- `apps/web/lib/hub.ts`: `Entry` PUT at `:124`, `searchMentionContext` at `:182`, and a new `tagEntries(id, tag)`.
- `apps/web/lib/mentions.ts`: `MentionContextResponse`, and an expansion helper `expandTag(tag, entries, remaining)` that returns `{ text, mentions } | { error: "tooMany", count }`.
- `apps/web/components/EntryDetail.tsx`: the tag editor, which uses the shared `normalizeTag` for inline errors.
- `apps/web/components/KnowledgePanel.tsx`: the filter bar and the row chips (up to 3, then `+N`).
- `apps/web/components/MentionMenu.tsx`, `apps/web/components/Composer.tsx` (`EMPTY_CONTEXT` `:29`).
- `apps/web/messages/{en,zh,ja}.json`.
- Tests: `apps/web/test/EntryDetail.test.tsx`, `KnowledgePanel.test.tsx`, `MentionMenu.test.tsx`, `Composer.test.tsx`, `mentions.test.ts`, `i18n.test.tsx`.

- [ ] Add failing tests:
  - **EntryDetail:** adding `Payment Flow` previews as `payment-flow`. An invalid tag shows the reason and does not save. Saving sends `tags`. When the server returns 400, the server's message is shown.
  - **KnowledgePanel:**
    - The filter bar lists the tags of the loaded entries, ordered by active count.
    - Choosing one filters both the by-kind and the timeline views. Choosing it again clears the filter.
    - Switching workspace clears the filter.
    - The filter is not written to the URL or to storage.
    - An empty result shows the new empty-state key.
    - Rows show up to three tags, then `+N`.
  - **MentionMenu/Composer:**
    - The tag group comes after entries, with the label `#支付 · 5 条（另有 2 条已失效）` in localized form.
    - Choosing it calls `tagEntries` and inserts `#支付：[D-3] [R-7] [T-2]`, with one `entry` mention per id. `meta.mentions` has no `tag` type.
    - When the count exceeds the remaining slots, the row is disabled, the D-1 notice key shows, and nothing is inserted.
    - A response from an old hub without `tags` behaves like `[]`.
    - Sending the expanded message to a mock old hub still succeeds, because it holds plain entry mentions only.
  - **i18n:** every new key exists in all three files.
- [ ] Run `npx vitest run apps/web/test/EntryDetail.test.tsx apps/web/test/KnowledgePanel.test.tsx apps/web/test/MentionMenu.test.tsx apps/web/test/Composer.test.tsx apps/web/test/mentions.test.ts apps/web/test/i18n.test.tsx` and confirm that the new cases fail.
- [ ] Implement it, then rerun. Run `npm run lint -w apps/web` and `npm run build -w apps/web`.

### Task 11: Docs, changelog, roadmap and full verification

**Spec:** §文档.

**Files:** `docs/guide.en.md`, `docs/guide.zh.md`, `docs/guide.ja.md`, `docs/reference.zh-CN.md` (the entry-format and `@` mention sections), `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md` (feature list), `changelog.d/knowledge-tags.added.md`, `ROADMAP.md` (post-merge note only).

- [ ] **Guides (three languages, equivalent):** how to add tags in the panel, single-tag filtering, what choosing a tag in `@` inserts (only active entries), the 20-mention limit and its notice, that agents may only reuse existing tags, the limits 32/8/200, that share pages show tags, and that downgrading to an older version can drop tags from entries it rewrites (Git history keeps them).
- [ ] **Reference:**
  - The `tags` frontmatter, normalization rules and limits.
  - The lenient-read/strict-write split.
  - The D-8 unknown-key preservation rule, including that it does not protect against already-released versions.
  - The `entry_index` columns and backfill condition, and that the columns stay out of snapshots.
  - The `mention-context` `tags` group, the tag-entries route, and the first-page-only cursor behaviour.
  - The prompt sections and budgets.
- [ ] **READMEs:** add one feature-list line to all four. Keep `README.md` and `README.en.md` byte-identical (`cmp README.md README.en.md`).
- [ ] **Changelog:** write `changelog.d/knowledge-tags.added.md` with one bullet, for example: `- Knowledge entries can carry tags: filter the panel by a tag, pick a tag in @ to mention its active entries, and see tags on share pages.`
- [ ] **Roadmap:** after merge only, add a note to the #162 line in `ROADMAP.md` (`:35`) that implementation merged, with the PR link and the remaining acceptance. Do not mark acceptance that has not happened.
- [ ] **Full verification:**
  - Run `npm run typecheck`, then `npm run typecheck -w apps/cli`, then `npm test -- --maxWorkers=2`, then `npm run lint -w apps/web && npm run build -w apps/web`. Expect all of them to pass. Report any environment-specific failure by name, and do not weaken a test.
  - CI's Windows/macOS job also runs the desktop data-directory upgrade harness, which exercises the migration and the backfill.
- [ ] **Docs check:**
  - Write the changed Markdown paths, including the share design, into a JSON array file and run `node scripts/ci/docs-check.mjs <file>`, then `git diff --check`.
  - Run the CodeRabbit CLI if it is available.
  - Review the final diff against #162's acceptance list (spec §验收).

### Task 12: Real-environment acceptance (separately authorized)

**Needs:**
- A VM with a source deployment of the merged `main` (Compose, or `npm run dev` plus the daemon).
- A real logged-in model account.
- A disposable data directory from the previous release that has a workspace with entries. Never use the user's `~/.nema`.
- Share enabled on the LAN as in the share design's D-4.

This task requires its own authorization.

- [ ] **Upgrade:** upgrade the old data directory. Record the migration and the first-start backfill time. Confirm that untagged entry files are byte-identical before and after one UI edit of another entry, using `git -C <repo> diff` on them.
- [ ] **Create tags in the panel:** add `支付` and `Payment Flow` to two entries in the panel. Expect them stored as `支付` and `payment-flow`, with a commit `Author: user`. Try an invalid tag and expect an inline error.
- [ ] **Filter:**
  - Single-select the tag in the panel. Both views filter. Switching workspace clears the filter.
- [ ] **Mention expansion:**
  - In the composer type `@支` and choose the tag. The body gets `#支付：[…]`, and the stored message's `meta.mentions` contains only `entry` items.
  - Capture the prompt: it has the `# 现有 tags` section and ` | tags:` on the active lines.
  - Ask the agent to tag another entry `支付` and expect success with `Author: agent`.
  - Ask it to use a brand-new tag and expect the 400 explanation in the agent's tool result.
- [ ] **Share:**
  - Create a share link. The share page shows the tags, and `?tag=支付` filters the list on the server. Check this with `curl`, with no script.
- [ ] **Unknown frontmatter:**
  - Hand-add `x_future: 1` to an entry file and commit it.
  - Edit that entry in the UI. The key survives.
- [ ] **Record:** post the commands, versions, timings, redacted prompt excerpts and outcomes as a comment on #162. This is runtime evidence for Linux only. It is not user acceptance, and it is not evidence for other items.

## Execution evidence

Not started.
