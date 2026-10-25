# Task 4 report: reply routing and follow-ups

## Changed behavior and files

- `apps/hub/src/daemonSocket.ts`: route replies and failure messages to the anchor's existing thread; create a grill thread for newly added or updated open questions; remove global top-question fallback; persist task result, reply, thread, and question associations in one transaction; emit message/thread/task events after commit. Thread context uses anchor plus 50 replies, main chat uses 20. Prompt input carries thread, anchor, and `openedBy` for Task 5.
- `apps/hub/src/messages.ts`: `addMessage` accepts optional `threadId`.
- `apps/hub/src/prompt.ts`: adds optional conversation scaffolding and preserves the anchor plus latest 50 thread messages.
- Tests: daemon harness cases cover thread/main routing, open-thread reuse, add/update/resolved/dropped questions, all associations and no relocation, no fallback, success/failure retries, edit/report anchors, grill off, rollback, and prompt failure; prompt test checks anchor + 50 replies.

## RED / GREEN

- RED against checked-in `HEAD` (`ec188fb`): `npx vitest run --project @nema/hub daemonSocket.test.ts -t 'a main-chat task that adds a question replies in a new thread on its message' --maxWorkers=2` failed at the question association assertion (`expected anchor ID, received null`).
- Focused GREEN: daemon routing/rollback/context selections passed (5/5); latest context-specific command passed (3/3 across prompt and daemon files).
- `umask 022; npx vitest run --project @nema/hub daemonSocket.test.ts --maxWorkers=2`: 41/41 passed after correcting a fixture that had left the anchor's original task queued.

## Verification and concerns

- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Full hub run: 301/302 passed across 24 files; its only failure was the same fixture sequencing issue. After fixing it, the full daemon socket file passed 41/41. The controller asked not to repeat the roughly seven-minute full hub run for this test-only correction; the full aggregate was therefore not rerun to green.
- Vite emitted its existing native config-loader warnings; daemon disconnect cleanup logs appeared during tests.
- TDD note: production edits initially preceded the expanded tests. I restored the changed production files to checked-in `HEAD`, captured the RED result above, restored the implementation, then verified green.
