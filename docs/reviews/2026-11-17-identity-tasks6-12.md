# Identity model (#163): execution note for Tasks 6–12

Date: 2026-11-17. Branch: `feat/163-identity`, on top of `4e992cd` (Tasks 1–5). Plan: [identity model plan](../superpowers/plans/2026-11-17-identity-model.md). Spec: [identity model design](../superpowers/specs/2026-11-16-identity-model-design.md).

Nothing is committed, pushed or opened as a PR. Task 13 (real-environment acceptance) is not started. The `ROADMAP.md` P2-04 note is post-merge and left to the supervisor.

## Important: what this session could and could not run

This session's permissions **blocked every test, typecheck, lint, build and Node script**: `npx vitest`, `npm run typecheck`, `npx tsc`, `npm run typecheck -w apps/cli` and `node scripts/ci/docs-check.mjs` all needed approval that was not available. The only commands that ran were read-only `git`/`grep` calls plus `git diff --check` and `cmp`.

The hub and local work for Tasks 6–9 came from an earlier interrupted session. Before this session, the supervisor verified it: typecheck passed, and `mentionContext`/`prompt`/`shares` (101 tests) and `mentions`/`daemonSocket`/local `import`/`migration` (147 tests) were green. This session did not change those files.

**The web code and web tests written in this session (Task 10) have not been executed or typechecked.** They were reviewed by reading only.

## Per-task status

| Task | Status | Evidence |
| --- | --- | --- |
| 6 `@` menu members group | Done (prior session); audited against plan | Supervisor run: `apps/hub/test/mentionContext.test.ts` green. Red phase not recorded. |
| 7 Prompt member lines / multi-member recent messages | Done (prior session); audited | Supervisor run: `prompt`, `mentions`, `daemonSocket` green. Red phase not recorded. See deviation 1. |
| 8 Snapshot export / validate / import | Done (prior session); audited, incl. fresh-home `usr_local` handling | Supervisor run: local `import`, `migration` green. Red phase not recorded. |
| 9 Share responses carry no identity | Done (prior session), no source change | Supervisor run: `shares` green. |
| 10 Web authors, members group, rename | **Implemented in this session; not run** | No test, lint, build or typecheck run (blocked). |
| 11 CLI / daemon check | Search done; typecheck blocked | `grep -rn "MessageMention\|mentions" apps/cli/src` and `grep -rn "authorUserId\|author_user_id\|\"member\"" apps/cli/src` returned nothing. No CLI change needed. |
| 12 Docs, changelog, verification | Docs and changelog done; verification blocked | `git diff --check` clean; `cmp README.md README.en.md` identical. |

## Audit of the prior session's Tasks 6–9 work

- **Task 6.** `searchMembers` counts active members and returns `[]` below two. It lists only `removed_at is null` rows of this workspace, uses the same subsequence and tier ordering on `lower(coalesce(display_name, ''))`, and caps at 8 with `more`. It runs on the first page only; cursor pages get `[]`. `members.more` feeds `truncated`, not `nextCursor`. The tests cover single member (empty and typed), removed, other workspace, null name on an empty query, cursor page and JSON key order (which includes `tags`, since tags landed first).
- **Task 7.** The `ResolvedMentions.members` and `mentionSection` lines match the spec text. A removed member gets only the `已移除的成员` line, with no id. `buildPrompt` takes `authors?: { names, multiMember }`. Only recent-messages user lines change, and only when `multiMember`. Null renders `未记录作者`, and `usr_local` without a name renders `我` (`PROMPT_ME_LABEL`, documented in the reference). Quote and thread-anchor lines are unchanged. `daemonSocket.ts` loads the roster once per task, including removed members for names, and counts active members for `multiMember`.
- **Task 8.** `TABLE_COLUMNS` puts `users` first, and `workspace_members`/`member_events` after `workspaces`. All three are optional, and `messages` gains `author_user_id`. `validateSnapshot` enforces ids, name length, roles, kinds, the removed pair, and user and workspace references, and allows authors only on `role = 'user'`. On import, the migration-seeded `usr_local` is deleted inside the import transaction, the snapshot rows are inserted, and the idempotent seed is re-run for workspaces with no member rows. Identity tables are then checked as "snapshot + seeded"; every other table keeps exact counts.
- **Task 9.** The test covers both hub public share routes (`/share/:token` list JSON and `/share/:token/entries/:eid` entry JSON). The hub serves no share HTML; the web renders the HTML from these JSON bodies, so the JSON assertion covers what the HTML can contain. `usr_` was added to the hidden-string list.

## Task 10: what this session changed (web)

- `apps/web/lib/members.tsx` (new, started by the prior session and reworked here). The prior version exported a `RosterProvider` context that was **never mounted**, so authors would always have shown "You". It now uses `useWorkspaceRoster(workspaceId)`, backed by a per-workspace promise cache with a 60 s lifetime. A failed load, for example an older hub without the routes, reads as an empty roster, which renders exactly as before. `invalidateRosters()` is called after a rename. `authorLabel` and `removedMemberMentions` are unchanged.
- `apps/web/components/MessageItem.tsx`: the roster comes from `useWorkspaceRoster(message.workspaceId)`, which also works in thread windows.
- `apps/web/lib/mentions.ts`: `MentionContextResponse.members?` (absent from an older hub means `[]`). `groupCandidates(q, ctx, { me })` appends a `member` group after threads. Its rows are labelled with the display name, or the localized "me" for `usr_local` without a name, and insert `@<name>` via the shared `mentionText`.
- `apps/web/components/MentionMenu.tsx`: `member` → `mention.members` group label. Empty groups are already hidden.
- `apps/web/components/Composer.tsx`: `EMPTY_CONTEXT.members = []`, and both `groupCandidates` calls pass `t("mention.me")`. Choosing a member uses the existing generic path and records `{ type: "member", id, text }`.
- `apps/web/components/AppSettings.tsx`: a `DisplayNameSetting` in the General tab. It loads `GET /api/me` and saves trimmed text or `null` via `PATCH /api/me`. It refuses more than 64 code points client-side with `appSettings.displayNameTooLong` and shows a generic error otherwise. The field stays disabled if `/api/me` is unavailable.
- `apps/web/messages/{en,zh,ja}.json`: `chat.unknownAuthor`, `chat.removedMember`, `mention.members`, `mention.me`, and `appSettings.displayName`, `…Help`, `…Save`, `…Saved`, `…TooLong`, `…Error`, added at the same position in all three files. `i18n.test.tsx` already asserts key-set parity.
- Tests (unrun): `MessageItem.test.tsx` covers one member, two members, removed author, removed-member mention chip and old hub. `MentionMenu.test.tsx` covers no group when empty, group after topics, and choose. `Composer.test.tsx` checks that choosing a member sends `{ type: "member", … }` and that a null name shows "Me". `AppSettings.test.tsx` covers saving a trimmed name, clearing it to null and the 64-character limit. `mentions.test.ts` covers the group order, the member group and an older hub. The existing group-order assertion now includes `"member"`.

## Tasks 11–12: files

- Docs: `docs/guide.{en,zh,ja}.md` (one equivalent bullet in the data, privacy and limitations list) and `docs/reference.zh-CN.md` (a new 「身份模型（第一期，#163）」 section; the `@` 提及 lines now mention `members` and the `member` type).
- READMEs: `README.md`, `README.en.md` (byte-identical, checked with `cmp`), `README.zh.md`, `README.ja.md`: one bullet under the data section. The existing "no public multi-user authentication" line is unchanged.
- `changelog.d/identity-model.added.md`: a single line starting with `- `.
- The plan's checkboxes are ticked for completed steps, and its "Execution evidence" is updated.

## Deviations

1. **Task 7 byte-identical fixture.** The plan asks for a comparison with a fixture captured from `main` before the change. The existing test instead compares the single-member build with the no-identity build of the same code, asserts the literal recent-messages block, and compares an empty-recent prompt with the existing `fixtures/untagged-prompt.txt`. This session could not run code to capture a new fixture from `4e992cd`. The no-identity path is `m.role`, as before, so the risk is low, but the plan's exact check is not met.
2. **READMEs changed.** The plan said "README: no change". The supervisor's brief asked for all four READMEs, and AGENTS.md requires README updates for usage changes (the new display-name setting). The multi-user line is untouched.
3. **Roster delivery in the web** uses a cached hook rather than a mounted context provider; see Task 10. Membership changes made through the API show in the UI within 60 s, or on reload.
4. **Removed-member mention display.** Removed mentions show as a separate struck-through chip row under the message body, rather than restyled inline inside the Markdown body. The body and `meta.mentions` are never rewritten.

## What the supervisor must re-verify

1. `npm run typecheck`, then `npx tsc --noEmit -p apps/web` (or rely on the web build).
2. `npx vitest run apps/web/test/MessageItem.test.tsx apps/web/test/MentionMenu.test.tsx apps/web/test/Composer.test.tsx apps/web/test/AppSettings.test.tsx apps/web/test/mentions.test.ts apps/web/test/i18n.test.tsx --maxWorkers=1`. These are new and never run. Likely fragile points: `Composer` choosing a row by click and sending with Shift+Enter (copied from the neighbouring test's pattern), and `AppSettings` waiting for the field to enable.
3. `npm run lint -w apps/web` and `npm run build -w apps/web`. Watch for the `mentions.ts` → `members.tsx` (`"use client"`) import, and React hooks lint on `members.tsx`.
4. `npm run typecheck -w apps/cli`.
5. `npm test -- --maxWorkers=2` (the full suite).
6. `node scripts/ci/docs-check.mjs <json>` over: `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`, `docs/guide.{en,zh,ja}.md`, `docs/reference.zh-CN.md`, `changelog.d/identity-model.added.md`, the plan, and this note. Also the release-notes fragment check, if one applies (`node --test scripts/release-notes.test.mjs`).
7. Optionally, replace the Task 7 single-member assertion with a fixture generated from `4e992cd` (deviation 1).
8. The open plan confirmations that are still unanswered: Task 6 members are kept out of `BrowseCursor`, and Task 7 prints the full user id. Both are implemented as the plan proposes.
