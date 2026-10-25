# Task 2 report: Hub thread store and conversation context

Implemented the hub thread store and conversation-aware prompt/history behavior. Threads are created idempotently from main-chat anchors; nested anchors are rejected. Question associations preserve their first thread, question lookup falls back to original task inference, and read acknowledgements validate an actual thread message sequence while advancing monotonically. Thread lists include reply counts, unread counts, and last reply time.

User messages can now be posted into a workspace-owned thread. Main message listings and prompt history exclude thread replies. Thread prompt history starts with its anchor, includes up to 50 own replies, and excludes later queued user messages. Last agent messages and asked-question context are conversation scoped, including system question cards persisted in `askedQuestion` metadata. Existing quote handling remains supported, including legacy positional quote calls.

Changed files:
- `apps/hub/src/threads.ts`
- `apps/hub/src/messages.ts`
- `apps/hub/src/daemonSocket.ts`
- `apps/hub/src/uiApi.ts`
- `apps/hub/test/threads.test.ts`

TDD and verification:
- RED: initially failed module loading because `threads.ts` did not exist.
- A subsequent test run exposed a test fixture placed in main chat while checking a thread; the fixture was corrected and the tests passed.
- `umask 022 && npx vitest run --project @nema/hub threads` — passed, 11 tests.
- `umask 022 && npx vitest run --project @nema/hub` — passed, 24 files and 284 tests.
- `npm run typecheck` — passed (`tsc -b`).
- Captured command summaries and warnings: `task-2-test-evidence.log`.

Self-review: the Task 2 changes do not alter quote excerpt creation or edit/version transactions. The question-card reader expects system cards to retain their typed `askedQuestion` metadata, consistent with the conversion flow. Vitest reports the repository's existing Vite native config-loader warning; no test failures remain.
