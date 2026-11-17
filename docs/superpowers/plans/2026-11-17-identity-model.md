# Identity Model (Phase 1) Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were given authorizes it; otherwise leave changes for supervisor review.

**Goal:** Every user message records which user wrote it, each workspace has an audited member roster (owner/member, soft removal), `/api` resolves a hub-side identity instead of a bare gate, and a `member` mention exists as a pointer. All of this is invisible in a single-member workspace, and no network exposure is added.

**Architecture:** One additive migration adds `users`, `workspace_members`, `member_events` and `messages.author_user_id`, and seeds `usr_local` as the owner of every existing workspace. `apps/hub/src/identity.ts` replaces `AppDeps.uiAuth` with an `IdentityProvider`. Without a provider, every request resolves to `usr_local`. The desktop gateway provider keeps today's constant-time credential check and resolves to `usr_local`. Message writes take the author from `c.get("identity")`. A new `members.ts` module owns roster reads, the owner-only management routes and the append-only audit. `MessageMention` gains a `member` branch. The hub validates it against the active roster. The prompt renders it as an id pointer with no utterances. The `@` menu offers it only when a workspace has two or more active members. Snapshots carry the three tables as optional, and import re-seeds the local owner after the rows are loaded.

**Tech Stack:** Node 22, TypeScript, Hono, PostgreSQL / PGlite, zod, Vitest, Next.js (web), next-intl message files.

**Spec:** [Identity model design](../specs/2026-11-16-identity-model-design.md). Product rule: [#45](https://github.com/Nema-Project/nema-room/issues/45). Issue: [#163](https://github.com/Nema-Project/nema-room/issues/163).

**How this serves #45:** "who said it" becomes a checkable record (message author ids, membership audit, soft removal that never rewrites history). Mentions of members stay user pointers, not decisions. Author ids never become evidence: `basis` and `confirmedBy` are unchanged.

**Estimated size:** 13 tasks (11 implementation, 1 docs + full verification, 1 separately authorized real-environment acceptance).

**Sequencing relative to [knowledge tags](2026-11-17-knowledge-tags.md):** land **after** the tags plan, or at least after tags Task 1 (the frontmatter-preservation change) and the tags migration. Reasons:
1. The identity spec already plans for tags merging first ("如果 knowledge tags 先合并，就顺延"). If tags goes first, the migration numbers do not need renaming later.
2. Both plans touch `mentionContext.ts`, `mentions.ts`, `prompt.ts`, `Composer.tsx` and `MentionMenu.tsx`. Tags is smaller there: one menu group, and no new mention type. Identity also replaces `uiAuth` across hub, local and five test files. Rebasing the narrower change onto the wider one costs more than the other way round.
3. Identity Phase 1 has no visible change for a single user. Tags has visible user value. Landing tags first does not delay anything a user can see.

Identity does not depend on any tags code. If identity is scheduled first, nothing breaks; follow the migration rule below.

## Global Constraints

- **Decided D-items are fixed** (spec, 2026-11-17, all per recommendation). Implement these and nothing else:
  - D-1 B: a member mention is a pointer to "this person's statements in this workspace". It is not a decision and not consent.
  - D-2 A: no utterances of the mentioned person go into the prompt. Exact words go through the existing `quoteMessageId`. A removed member gets no history either.
  - D-3 A: fixed `usr_local` with a null `display_name`. The UI renders it with a localized "me". No OS user name is read.
  - D-4 A: `author_user_id` is nullable and never backfilled. Null shows as `chat.you` with one active member, and as "author not recorded" with two or more.
  - D-5 A: no path for a second person to log in. Add no listener, Host allowance, bind address or header-declared identity.
  - D-6 A: roles are `owner` and `member` only. Authorization checks go only on the member-management routes.
  - D-7 A: removal is soft (`removed_at`/`removed_by`). Users rows, message authors, stored mention text and knowledge files are never rewritten.
  - D-8 A: the knowledge format does not change. `confirmedBy: "user"`, `evidence_events.actor = 'user'` and commit `Author: user` stay role literals.
  - D-9: the recent-messages prompt section is unchanged with one active member. With two or more, it reads `[id] user(显示名):` (or `user(未记录作者):`). Share pages never show identity.
- **Migration numbering.** Today the last migration is `020_mention_browse_indexes.sql`, so the spec's "today `020`" is stale. Take the next free number at implementation time. This plan assumes the tags migration lands first as `021_entry_index_tags.sql`, and names its own `022_identity.sql`. If identity lands first, use `021_identity.sql`. The tags plan then takes the next number. Never renumber a migration that has already merged to `main`: `schema_migrations` tracks applied migrations by file name (`apps/hub/src/db/db.ts:37-45`).
- **Recorded traps:**
  - An unknown mention `type` makes `MessageMentions` fail the whole send with 400 (`apps/hub/src/uiApi.ts:89-96`). The web must therefore never offer a member mention in a single-member workspace. A new web paired with an old hub must not reach that path.
  - `validateSnapshot` rejects unknown tables and columns (`apps/hub/src/db/snapshot.ts:81-91`). New tables must be optional, and new snapshots will not import into old versions. That is accepted, with the same rollback path as `message_attachments`.
  - Old hubs strip unknown frontmatter on rewrite, and a parse failure hides a whole entry (`packages/knowledge/src/store.ts:184-215`, `:439-458`). This plan writes nothing into knowledge files (D-8 A). Do not add identity fields to `EntryFrontmatter`.
- `verified`/`confirmedBy` are untouched. No agent or automatic path sets `confirmedBy: "user"`. A member mention or author id never implies acceptance.
- Never trust a request header for identity. `x-nema-user-id` or anything similar must have no effect. Add a test for this.
- User ids and display names never appear in share responses, error bodies or logs. Prompts carry them only as specified.
- Tests use temporary data directories and PGlite. No real `~/.nema`, no real models.
- Docs parity: the three `docs/guide.*.md` files and `docs/reference.zh-CN.md`. Web strings go into `apps/web/messages/{en,zh,ja}.json`. README line 125 ("no public multi-user authentication") stays true and stays unchanged, and `README.md`/`README.en.md` stay byte-identical. Add one `changelog.d` fragment.

## Review Focus

- Single-member invisibility. The prompt must be byte-identical to today's for a single-member workspace (Task 7). The `@` menu has no member group (Task 6). The chat still shows `chat.you` (Task 10).
- No access-surface change. `hostGuard` and gateway Host tests must still pass. With no provider, the hub must accept exactly what it accepted with no `uiAuth`. A wrong gateway credential must still return 401 (Task 2).
- The check constraint `author_user_id is null or role = 'user'`. Agent, system and report writes stay null (Tasks 1 and 3).
- Snapshot import on a fresh, migrated PGlite. The migration already seeded `usr_local`. Inserting snapshot rows must not collide with it, and the per-table row-count check must still hold (Task 8). The spec does not cover this case; see Task 8.
- Removed members. Old mentions survive edit and replay. New mentions of a removed member return 400. The prompt line says "已移除的成员" (Tasks 5 and 7).
- The audit is append-only. No update or delete path exists for `member_events` (Task 4).

---

### Task 1: Migration — users, roster, audit, message author

**Spec:** §数据模型, D-3, D-4.

**Files:** `apps/hub/src/db/migrations/022_identity.sql` (or `021_…`, see Global Constraints), `apps/hub/test/migrations.test.ts`. Check `apps/hub/test/upgradeRecovery.test.ts` and `apps/hub/test/upgradeRecoveryHarness.ts` still pass.

**Interfaces:** Produce the exact SQL from the spec: `users` (id check `^usr_[A-Za-z0-9_-]{1,32}$`, `display_name` 1–64 chars or null), `workspace_members` (PK `(workspace_id, user_id)`, `on delete cascade` from `workspaces`, role check, removed pair check), `member_events` (append-only, kind check), `messages.author_user_id` with `messages_author_role_check`, and the three idempotent seed inserts (`usr_local`, one owner row per workspace, `mev_seed_<workspace id>`).

- [x] Add failing tests to `migrations.test.ts`. Seed a DB at the previous migration with two workspaces and user/agent/report messages, then run `migrate`. Expect: `usr_local` exists with null `display_name`; each workspace has exactly one `owner` row for `usr_local`; each has one `mev_seed_<id>` `added` event with null actor; every existing message has `author_user_id is null`. Then rerun the seed statements: no error, and the row counts do not change. Insert a non-user message with an author: rejected by `messages_author_role_check`. A `display_name` of 65 characters or `''` is rejected, and an id `bob` is rejected.
- [x] Run `npx vitest run apps/hub/test/migrations.test.ts` and confirm that the new cases fail.
- [x] Write the migration. Do not add `not null` to `author_user_id`, and do not backfill it.
- [x] Rerun the test above and `npx vitest run apps/hub/test/upgradeRecovery.test.ts apps/hub/test/persistentDb.test.ts`. Expect them to pass.

### Task 2: `uiAuth` becomes an identity provider

**Spec:** §`uiAuth` 的演进, D-5.

**Files:** `apps/hub/src/identity.ts` (new), `apps/hub/src/app.ts` (`AppDeps.uiAuth` at `:33`, mounted at `:95`), `apps/hub/src/lifecycle.ts` (`:29`, `:102`), `apps/local/src/gateway.ts` (`createGatewayUiAuth`, `:66-79`), `apps/local/src/runtime.ts` (`:538`). Tests: `apps/hub/test/identity.test.ts` (new), and the existing `uiAuth` users `apps/hub/test/lifecycle.test.ts:149`, `apps/hub/test/uiApi.test.ts:711`, `apps/hub/test/shares.test.ts:306-320,459`, `apps/hub/test/attachmentRoutes.test.ts:82-83`, `apps/hub/test/mcpRoutes.test.ts:140-143`, `apps/local/test/gateway.test.ts`.

**Interfaces:** Produce `type Identity = { userId: string }`, `type IdentityProvider = (c: Context) => Promise<Identity | null>`, `LOCAL_USER_ID = "usr_local"`, `localIdentity: IdentityProvider`, and a Hono variable typing (`c.get("identity")`). `AppDeps.identity?: IdentityProvider` replaces `uiAuth`. `createGatewayIdentity(credential): IdentityProvider` replaces `createGatewayUiAuth`. It keeps the 64-hex validation and the `timingSafeEqual` comparison.

- [x] Add failing tests:
  - `identity.test.ts`: with no provider, `GET /api/workspaces` succeeds and a probe route sees `usr_local`. A provider that returns null yields 401 `{ error: "unauthorized" }`. Sending `x-nema-user-id: usr_evil` (and `x-nema-user`) changes nothing. `/api/version` stays reachable without identity, as it is today, and `/share/*`, `/room/*` and `/report` are not wrapped.
  - `gateway.test.ts`: the right credential resolves to `usr_local`, and a wrong, malformed or missing credential returns 401.
- [x] Run `npx vitest run apps/hub/test/identity.test.ts apps/local/test/gateway.test.ts` and confirm that the new cases fail.
- [x] Implement. Mount the identity middleware exactly where `deps.uiAuth` is mounted today: after `/api/version`, before `requireJson`. Update the five hub test files to pass `identity:` providers with the same accept/reject behaviour they had with `uiAuth`. Do not touch `hostGuard` or the gateway's Host/listen code.
- [x] Rerun the tests above with `npx vitest run apps/hub/test/lifecycle.test.ts apps/hub/test/uiApi.test.ts apps/hub/test/shares.test.ts apps/hub/test/attachmentRoutes.test.ts apps/hub/test/mcpRoutes.test.ts apps/local/test/runtime.test.ts` and `npm run typecheck`. Expect everything to pass, and expect the existing host-guard assertions to stay unchanged.

### Task 3: Message authorship and owner seeding on create

**Spec:** §`uiAuth` 的演进 (author on write, edit rule), §数据模型 (create workspace), D-4.

**Files:** `apps/hub/src/messages.ts` (`Message` `:21`, `COLS`, `insertMessage` `:142`, `postUserMessage` `:194`, `editUserMessage` `:325`), `apps/hub/src/uiApi.ts` (posts at `:488`, `:513`, `:592`; edit at `:574`; create workspace at `:356-358`), `apps/hub/src/workspaces.ts` (`createWorkspace` `:56`). Tests: `apps/hub/test/messages.test.ts`, `apps/hub/test/uiApi.test.ts`, `apps/hub/test/threads.test.ts`, `apps/hub/test/workspaces.test.ts`.

**Interfaces:** `Message.authorUserId: string | null`. `PostUserMessageOptions.authorUserId: string` (required, because a user message must carry an author). `editUserMessage(db, ws, id, content, actorUserId)`. `createWorkspace(…, ownerUserId = LOCAL_USER_ID)`.

- [x] Add failing tests:
  - All three entry points stamp `author_user_id = 'usr_local'`: main chat (`POST /messages`), new thread (`POST /threads`), and thread reply (`POST /threads/:tid/messages`).
  - `addMessage`, `postSystemTask` and the report insert stay null.
  - An attachment replay (the `lockForSend` path) returns the original message with its author.
  - Edit is checked against a second user inserted directly in the test. A non-author gets 403. On a null-author message, an owner may edit and a `member` gets 403.
  - `createWorkspace` inserts the owner row and one `added` audit event in the same transaction as the workspace row. Force a failure after the workspace insert and assert that neither row remains.
- [x] Run `npx vitest run apps/hub/test/messages.test.ts apps/hub/test/uiApi.test.ts apps/hub/test/threads.test.ts apps/hub/test/workspaces.test.ts` and confirm that the new cases fail.
- [x] Implement:
  - Read the author only from `c.get("identity").userId`, never from the request body.
  - `insertMessage` takes the author as an explicit parameter, and only the `"user"` role passes a non-null value.
  - Wrap the workspace insert and the membership/audit inserts in one `db.tx`. Today `createWorkspace` runs a bare insert after `KnowledgeStore.init()`. Keep the init before the transaction.
- [x] Rerun and confirm it passes.

### Task 4: Members module, management routes and audit

**Spec:** §撤销与审计, D-6, D-7, D-3 (rename).

**Files:** `apps/hub/src/members.ts` (new), `apps/hub/src/uiApi.ts` (or a `memberRoutes` mounted in `apps/hub/src/app.ts` next to `mentionContextRoutes`), `apps/hub/test/members.test.ts` (new).

**Interfaces:** Produce `activeMembers(db, ws)`, `activeMemberCount(db, ws)`, `listMembers(db, ws)` (including removed members with `removedAt`), `addMember`, `changeRole`, `removeMember`, `listMemberEvents`, and `renameUser`. Routes:

| Route | Who | Behaviour |
| --- | --- | --- |
| `GET /api/workspaces/:id/members` | any member | roster incl. removed (`{ userId, displayName, role, removedAt }[]`); needed by the web to render authors and "（已移除）" |
| `POST /api/workspaces/:id/members` | owner | `{ userId, role }`. The user row must already exist: no user creation (D-5). Re-adding a removed member clears `removed_at`/`removed_by` on the same row. Writes `added`. |
| `POST /api/workspaces/:id/members/:userId/role` | owner | writes `role_changed` with `{from,to}`; demoting the last active owner is 409 |
| `POST /api/workspaces/:id/members/:userId/remove` | owner | sets `removed_at`/`removed_by` + `removed` event in one tx; removing the last active owner is 409 |
| `GET /api/workspaces/:id/members/events` | any member | newest first |
| `GET /api/me` | anyone with an identity | `{ userId, displayName }` |
| `PATCH /api/me` | anyone with an identity | `{ displayName: string \| null }`, trimmed, 1–64 chars or null; writes one `renamed` event with null `workspace_id` |

The spec names only the remove and events routes explicitly. The list, add, role, `GET /api/me` and `PATCH /api/me` routes are the minimum that the spec's add/role/audit text, D-3 ("用户可以在设置里改名") and the D-4/D-7 rendering need. The supervisor should confirm them (see the report).

- [x] Add failing tests with a second user (`usr_test2`) inserted directly:
  - A non-owner gets 403 on add, role and remove.
  - Removing writes exactly one audit row, keeps the `users` row and leaves message authors untouched.
  - Removing or demoting the last owner returns 409.
  - Re-adding produces one roster row and a second `added` event.
  - A non-member reading the events route gets 403. In Phase 1 this needs a provider that returns `usr_test2` with no membership.
  - No route can update or delete `member_events`. Assert that the router has no such handlers.
  - Rename writes `renamed`, rejects 65 characters with 400, and `null` resets the name.
  - Error bodies contain no display name.
- [x] Run `npx vitest run apps/hub/test/members.test.ts` and confirm that the new cases fail.
- [x] Implement the module and routes. No route accepts a user id from a header.
- [x] Rerun and confirm it passes.

### Task 5: Shared `member` mention contract and hub validation

**Spec:** §成员提及 / 契约, D-7 (removed members).

**Files:** `packages/shared/src/mentions.ts` (`MessageMention` `:22-33`, `mentionText` `:39-48`), `packages/shared/test/mentions.test.ts`, `apps/hub/src/mentions.ts` (`validateMentions` `:32`), `apps/hub/test/mentions.test.ts`, `apps/hub/test/messages.test.ts`.

**Interfaces:** A new union branch, `z.object({ type: z.literal("member"), id: z.string().regex(/^usr_[A-Za-z0-9_-]{1,32}$/), text: MentionText })`. `mentionText` gains a `memberName?: string` label (`@${memberName}`). The fallback for a null name is supplied by the web from i18n, not by shared code.

- [x] Add failing tests:
  - Shared: the member branch parses, and a bad id (`usr_`, `user_x`, 33 characters) fails.
  - Hub: mentioning an active member of this workspace succeeds. A member of another workspace returns 400, a removed member returns 400, and an unknown id returns 400. In each failing case no message row is written.
  - The existing "text must appear" counting applies to member text.
  - An edit (`editUserMessage`) that keeps a mention of a member removed after the original send still succeeds, and the kept mention stays in `meta.mentions`. Read the edit path first. If it re-runs `validateMentions` on kept mentions, limit the roster check to mentions that are new in this edit.
  - Replay comparison (`lockForSend`) treats `type`, `id` and `text` as the identity of a mention.
- [x] Run `npx vitest run packages/shared/test/mentions.test.ts apps/hub/test/mentions.test.ts apps/hub/test/messages.test.ts` and confirm that the new cases fail.
- [x] Implement it, and fix every exhaustive `switch` the typecheck reports (`npm run typecheck`).
- [x] Rerun and confirm it passes.

### Task 6: `@` menu members group

**Spec:** §成员提及 / `@` 菜单.

**Files:** `apps/hub/src/mentionContext.ts` (`MentionContext` `:16-27`, `mentionContext` `:194`), `apps/hub/test/mentionContext.test.ts`.

**Interfaces:** `MentionContext.members: { id: string; displayName: string | null; role: "owner" | "member" }[]`. It lists only `removed_at is null` rows, holds at most `MENTION_LIMITS.menuPerGroup`, and uses the same SQL subsequence match and tier order on `display_name`. It is **empty unless the workspace has ≥ 2 active members**.

The spec predates the browse cursor (`e75ec4e`, after the spec's HEAD `f21843e`). This plan keeps members out of `BrowseCursor`: the group is computed on the first page (no cursor) only and is `[]` on cursor pages. `members.more` contributes to `truncated` but not to `nextCursor`. Confirm with the supervisor (see the report).

- [x] Add failing tests:
  - With a single member the group is `[]` for both empty and typed queries.
  - With two members (the second inserted directly) the group lists both, and a removed one is absent.
  - Another workspace's members never appear.
  - A null display name is matched as an empty string and is still listed for an empty query.
  - A cursor page returns `members: []`.
  - The JSON key order is entries, attachments, threads, members. This is the menu order when tags is absent; tags inserts its group after entries.
- [ ] Run `npx vitest run apps/hub/test/mentionContext.test.ts` and confirm that the new cases fail.
- [x] Implement it, then rerun and confirm it passes.

### Task 7: Prompt — member mention lines and multi-member recent messages

**Spec:** §成员提及 / prompt, D-1, D-2, D-9.

**Files:** `apps/hub/src/mentions.ts` (`ResolvedMentions` `:95`, `resolveMentions` `:98`, `mentionSection` `:153`), `apps/hub/src/prompt.ts` (recent messages at `:206`), `apps/hub/src/daemonSocket.ts` (`:208-214`), `apps/hub/test/prompt.test.ts`, `apps/hub/test/mentions.test.ts`, `apps/hub/test/daemonSocket.test.ts`.

**Interfaces:** `ResolvedMentions.members: { id; displayName: string | null; removed: boolean }[]`. `buildPrompt` gains an optional `authors?: { names: Map<string, string | null>; multiMember: boolean }`.

- [x] Add failing tests:
  - **Byte-identical snapshot:** build a prompt for a single-member workspace with user, agent and report messages, quotes and entry/thread mentions. Compare it with a fixture captured from the current `main` before this task's change. It must be identical.
  - Two active members: the recent-messages lines become `[id] user(张三):`. A null author becomes `[id] user(未记录作者):`. A `usr_local` author with a null name uses the same localized "me" label that the web uses for mentions. Write that label into `prompt.ts` in Chinese, like the other prompt text, and record it in the reference doc. Agent, system and report lines are unchanged. The thread-anchor and quoted-message lines (`:184`, `:231`) are unchanged, because the spec scopes D-9 to 最近消息.
  - A member mention renders as `## 成员 @张三（usr_…full id…）` followed by the spec's fixed explanation line. A removed member renders as `## 成员 @张三：已移除的成员`. The prompt contains **no** content of any message authored by the mentioned user, except where that message is independently in the recent messages, the quote or the user message. Seed a distinctive marker in an older message by that user to prove this.
  - Mentions are resolved only from this workspace.
- [ ] Run `npx vitest run apps/hub/test/prompt.test.ts apps/hub/test/mentions.test.ts apps/hub/test/daemonSocket.test.ts` and confirm that the new cases fail.
- [x] Implement it. `daemonSocket.ts` loads the active roster once per task. The spec writes the id as `usr_ab12…`; this plan takes the `…` as elision in the example and prints the full id. Flagged in the report.
- [x] Rerun and confirm it passes.

### Task 8: Snapshot export, validation and import

**Spec:** §快照与恢复.

**Files:** `apps/hub/src/db/snapshot.ts` (`TABLE_COLUMNS` `:23-42`, `OPTIONAL_TABLES` `:45`, `validateSnapshot` `:62`), `apps/hub/src/db/export.ts` (`:144-149`), `apps/local/src/import.ts` (`loadDatabase` `:104-162`), `apps/local/test/import.test.ts`, `apps/local/test/migration.test.ts`.

**Interfaces:** Add `users: ["id","display_name","created_at"]`, `workspace_members: [all 7 columns]` and `member_events: [all 7 columns]` to `TABLE_COLUMNS`, and add `author_user_id` to `messages`. All three tables go into `OPTIONAL_TABLES`. `TABLE_ORDER` is the key order and drives the insert order, so put `users` **before** `workspaces` and `messages`, and put `workspace_members`/`member_events` **after** `workspaces`.

**Spec gap handled here:** `createLocalDb` runs `migrate` on the empty staging database (`apps/hub/src/db/pglite.ts:30-34`). The migration's seed therefore already inserts `usr_local` before any snapshot row is loaded. A new snapshot that contains `usr_local` would hit a primary-key conflict. An old snapshot (no `users` table) would fail the per-table row-count check at `import.ts:156-159` (1 ≠ 0). The import must:
1. Delete the migration-seeded `usr_local` row inside the import transaction before inserting rows. The database is empty, so nothing references it yet.
2. Insert the snapshot rows.
3. Run the spec's idempotent seed: `usr_local`, plus an owner row and a `mev_seed_<id>` event for every workspace without one.
4. Compare the identity tables with "snapshot rows + rows the seed inserted". Keep exact counts for every other table.

- [x] Add failing tests:
  - `validateSnapshot` rejects the following: an `author_user_id` that is missing from the snapshot's `users`; a non-null author on a non-`user` row; an unknown role or kind; a member or event referencing a missing workspace or user; a bad user id or display-name length.
  - Import a snapshot exported by the new version: the authors and roster are preserved and no duplicate `usr_local` appears.
  - Import an old-shape snapshot without the three tables and without `author_user_id`: it succeeds, `usr_local` exists, every workspace has an owner row and a seed event, and every author is null.
  - Exporting twice is stable.
  - A new snapshot is rejected by the unchanged old validator. Simulate this by calling the validator with the new keys removed from the allow-list, or document it as the known rollback limit.
- [ ] Run `npx vitest run apps/local/test/import.test.ts apps/local/test/migration.test.ts` and confirm that the new cases fail.
- [x] Implement it, then rerun and confirm it passes.

### Task 9: Share responses carry no identity

**Spec:** §失败与隐私边界, D-9; [share design](../specs/2026-11-04-readonly-knowledge-share-design.md) D-7.

**Files:** `apps/hub/test/shares.test.ts` (`toPublicSummary`/`toPublicEntry` stay explicit allow-lists in `apps/hub/src/shares.ts:182-215`; expect no source change).

- [x] Add a test. Seed a second user with display name `IdentityMarker` and messages authored by both users, then call the public list and entry JSON and the share HTML route. Assert that the bodies contain neither `usr_` nor `IdentityMarker`. Add `usr_` to the existing hidden-string list at `shares.test.ts:159`.
- [x] Run `npx vitest run apps/hub/test/shares.test.ts` and expect it to pass without changing source. If it fails, fix the projection; do not widen the test.

### Task 10: Web — authors, members group, rename

**Spec:** D-3, D-4, D-7, §`@` 菜单, §兼容.

**Files:** `apps/web/lib/hub.ts` (message type, `searchMentionContext` `:182`, new `listMembers`, `getMe`, `updateMe`), `apps/web/lib/mentions.ts` (`MentionContextResponse` and the member-mention insertion text), `apps/web/components/MessageItem.tsx` (`:35`, `:323-326`), `apps/web/components/MentionMenu.tsx`, `apps/web/components/Composer.tsx` (`EMPTY_CONTEXT` `:29`), `apps/web/components/Markdown.tsx` (if mention chips render there), `apps/web/components/AppSettings.tsx` (general tab), `apps/web/messages/{en,zh,ja}.json`. Tests: `apps/web/test/MessageItem.test.tsx`, `MentionMenu.test.tsx`, `Composer.test.tsx`, `AppSettings.test.tsx`, `mentions.test.ts`, `i18n.test.tsx`.

- [x] Add failing tests:
  - **MessageItem with one active member:** null-author and `usr_local`-author messages both show `chat.you`. This is unchanged from today.
  - **MessageItem with two active members:**
    - Your own messages show `chat.you`.
    - Another member's messages show their display name.
    - A null author shows the new "author not recorded" key.
    - A removed author shows the name plus the "(removed)" key.
  - **MentionMenu:** no member group when `members` is empty. When the group is present it comes after threads. Choosing a member inserts `@<name>`, or `@<localized me>` for a null name, and records `{ type: "member", id, text }`.
  - **Stored mention chips:** a mention of a removed member renders the stored `text` with a removed style, and the body is never rewritten.
  - **Old-hub compatibility:** a response without `members` behaves like `[]`.
  - **Settings:** the display-name field saves via `PATCH /api/me`, can be cleared back to null, and shows the 64-character limit error.
  - **i18n:** every new key exists in all three files.
- [ ] Run `npx vitest run apps/web/test/MessageItem.test.tsx apps/web/test/MentionMenu.test.tsx apps/web/test/Composer.test.tsx apps/web/test/AppSettings.test.tsx apps/web/test/mentions.test.ts apps/web/test/i18n.test.tsx` and confirm that the new cases fail.
- [x] Implement it. The new keys are `chat.unknownAuthor`, `chat.removedMember`, `mention.members`, `mention.me`, `appSettings.displayName*` (final names follow the file's conventions). Add each key to all three message files.
- [ ] Rerun, then run `npm run lint -w apps/web` and `npm run build -w apps/web`. Expect everything to pass.

### Task 11: CLI / daemon check

**Spec:** §失败与隐私边界 (ids only inside `task.assign`).

**Files:** none expected. The prompt is built in the hub (`daemonSocket.ts`) and sent as a string. The CLI does not parse `Message.authorUserId` or mention types.

- [x] Search with `grep -rn "MessageMention\|mentions" apps/cli/src` and confirm that no CLI code switches on mention `type`. If some does, add the `member` branch there with a test.
- [ ] Run `npm run typecheck -w apps/cli` and expect it to pass.

### Task 12: Docs, changelog, roadmap and full verification

**Spec:** §文档.

**Files:** `docs/guide.en.md`, `docs/guide.zh.md`, `docs/guide.ja.md` (data and privacy sections), `docs/reference.zh-CN.md`, `changelog.d/identity-model.added.md`, `ROADMAP.md` (post-merge note only). README: no change (see Global Constraints). Verify with `cmp README.md README.en.md`.

- [x] In the three guides, state that messages now record their author, that a single user sees no change, that old messages are not backfilled, that there is still no multi-user login, that a display name can be set in settings and is sent to the model only when a workspace has two or more members, and that share pages never show people. Keep the three languages equivalent.
- [x] In `docs/reference.zh-CN.md`, add an identity-model section: the tables, the `usr_local` seed, `IdentityProvider` resolution (no provider means `usr_local`, the gateway credential maps to `usr_local`, and no header channel exists), the author check constraint, the edit authorization rule, the member mention contract and prompt lines, the roster-of-two rule, the snapshot optional tables and the import re-seed, and the rollback limits.
- [x] Write `changelog.d/identity-model.added.md` with one bullet, for example: `- Messages now record which local user wrote them, and each workspace keeps an audited member list; nothing changes for a single user, and there is still no multi-user login.`
- [ ] After merge only: add a note to the `ROADMAP.md` P2-04 row (`:270`) that Phase 1 of the identity model merged, with the PR link. Do **not** mark P2-04 complete (spec §文档).
- [ ] Run `npm run typecheck`, then `npm run typecheck -w apps/cli`, then `npm test -- --maxWorkers=2`, then `npm run lint -w apps/web && npm run build -w apps/web`. Expect all of them to pass. Report any environment-specific failure by name, and do not weaken a test. Note that CI's Windows/macOS platform job also runs the desktop data-directory upgrade harness, which exercises this migration.
- [ ] Docs check: write the changed Markdown paths into a JSON array file and run `node scripts/ci/docs-check.mjs <file>`, then `git diff --check`. Run the CodeRabbit CLI if it is available, and review the final diff against #163's acceptance list (spec §验收).

### Task 13: Real-environment acceptance (separately authorized)

**Needs:** a VM with a source deployment of the merged `main` (Compose or `npm run dev` plus the daemon), a real logged-in model account, and an existing data directory from the previous release that has workspaces and messages. The data must be disposable, never the user's `~/.nema`. This task requires its own authorization.

- [x] Upgrade the old data directory. Confirm that the migration ran once, that `usr_local` owns every workspace, and that old messages have null authors and still show "you".
- [x] **Single-user invisibility.** In one workspace, check the `@` menu (no member group), the chat (unchanged) and a captured prompt (the daemon task log or a debug capture). Compare the prompt with the pre-upgrade build for the same message, and record whether they are byte-identical.
- [x] **Member mention contract at the prompt level.** Seed a second user and roster row directly in the database (`psql`), as Phase 1 has no invite path. Write a distinctive message as that user (SQL insert with `author_user_id`). Then, from the browser, `@`-mention that member and send. Expect:
  - The member group appears.
  - `meta.mentions` holds the `member` record.
  - The captured prompt shows `## 成员 @…` and `user(name):` in the recent messages.
  - The distinctive older message is absent unless it falls inside the recent window.
  - The agent reply does not claim the member was notified or agreed.
  - Remove the member through the API: a new mention returns 400, the old message still renders the mention as removed, and editing the old message keeps it.
  - [ ] Browser-literal remainder (pending a browser-equipped local deployment, 2026-11-18): pick the member in the real `@` menu and send; confirm the single-member workspace shows no member group in the real menu; confirm the removed member's mention renders as removed in the chat UI. The API- and prompt-level contract above was verified with the composer's exact payload and the mention-context responses the menu renders (see the #163 acceptance comment); the hub-side invariant for the last point (the stored mention is kept and the roster marks the member removed) is verified, the visual rendering is not.
- [x] Export a snapshot and import it into a fresh desktop home (or the equivalent import path). Expect the authors and roster to survive.
- [x] Confirm that there is no new listener: `ss -ltnp` shows the same ports and bind addresses as before the upgrade.
- [x] Record the commands, versions, redacted prompt excerpts and outcomes as a comment on #163. This is runtime evidence for Linux only. It is not user acceptance, and it is not evidence for other items.

## Execution evidence

- Tasks 1–5: commit `4e992cd`.
- Tasks 6–12: commit history on `feat/163-identity`, merged as PR #254 (`04e2a07`); see [execution note](../../reviews/2026-11-17-identity-tasks6-12.md). The supervisor re-ran the blocked checks before merging (typecheck, 600+ hub/local tests, full web suite 611, lint, build, docs check — all green; one stale group-order assertion fixed).
- Task 13: executed 2026-11-18 under the maintainer's authorization; full record on [#163](https://github.com/Nema-Project/nema-room/issues/163#issuecomment-6952474813), and #163 is closed. Method notes: the run began on real PostgreSQL 16, but the VM was replaced mid-run and the database was lost, so the full sequence was re-run on the product's own PGlite stack (desktop local-runtime database, same hub code and migrations); the second user was seeded with a PGlite script (no `psql` on the VM image); the member mention was sent with the composer's exact API payload because no browser can reach the VM loopback (the same substitution recorded on #162); the old-vs-new prompt comparison is not literally byte-identical — the only differences are the conversation's own growth (history window and message ids), with zero identity-attributable differences.
