# Task 7 report: Web threads UI

## Behavior and files

- Added reusable `ThreadView`, standalone `/w/[id]/t/[tid]` route, and `ThreadWindows` host with drag, close, Escape, active-window focus, and target-message navigation.
- Added thread APIs and `openThread`; Chat now shows unread thread rows, supports `/thread`, navigates search/quote/source jumps, and no longer presents the main-chat AnswerBox.
- Added thread-aware read acknowledgements through the highest rendered sequence; background floating threads stay unread until active and focused.
- Added attention badge navigation with target workspace preserved, withdraw and history chip actions, and English/Japanese/Chinese labels.
- Changed files: `apps/web/app/globals.css`, `apps/web/app/w/[id]/t/[tid]/page.tsx`, `apps/web/components/{Chat,Composer,EntryDetail,MessageItem,Sidebar,ThreadView,ThreadWindows,WorkPackageDetail,WorkspaceShell}.tsx`, `apps/web/lib/{hub,slash,threads,types}.ts`, `apps/web/messages/{en,ja,zh}.json`, and web tests for Chat, Composer, MessageItem, Sidebar, ThreadView, ThreadWindows, page, slash, and `openThread`.

## RED / GREEN

- RED: `npx vitest run --project @nema/web apps/web/test/ThreadView.test.tsx` — failed before implementation because `@/components/ThreadView` did not exist (0 tests collected).
- GREEN: `npx vitest run --project @nema/web` — 24 files passed, 201 tests passed.
- Focused regression tests also passed for cross-workspace loading, two-window read focus, standalone entry/history/source actions, thread creation through the Chat POST path, and attention navigation.

## Verification

- `npm run lint -w apps/web` — passed.
- `npm run typecheck` — passed.
- `npx tsc --noEmit -p apps/web/tsconfig.json` — passed.
- `npm run build -w apps/web` — passed; includes `/w/[id]/t/[tid]`.
- `git diff --check` — passed.

## Concerns

- Vitest prints the existing Vite `configLoader: 'native'` CommonJS/ESM warning; tests pass.
- Browser smoke is pending the controller's planned run.

## Round 1 fixes (review base `4251e22`)

### Findings and regressions

1. **Main-chat thread leakage:** `Chat` filters both fetched and SSE-delivered main messages to `threadId === null`, while task completion handling remains workspace-wide. `Chat.test.tsx` forwards a thread reply and verifies it is absent from the main stream.
2. **Keyboard command filter:** `Composer` now uses the same `availableCommands` list for display, arrows, Enter, and Tab. Tests cover `/` + Enter and a typed `/thread` + Enter in thread mode.
3. **Jump destinations:** thread targets are searched only inside their owning view and scrolled after render; fetched same-thread messages are appended only after validating membership. Entry overlays close before navigation. Standalone main-message jumps route through the main workspace URL, which resolves and displays the target. Tests cover existing/fetched same-thread targets and standalone-to-main routing.
4. **Source target retention:** `WorkspaceShell` passes the resolved message ID through `openTargetThread`. The shell regression verifies target ID survives into the thread host.
5. **Cross-workspace floating subscriptions:** `useHubEvents` now multiplexes one EventSource per workspace per browser window and fans out frames synchronously to all mounted subscribers. Floating and standalone ThreadViews subscribe to their own workspace. Tests assert two workspaces have distinct sources and the retained workspace receives events.
6. **Reconnect resync:** reconnect callbacks fan out through the shared hook; Chat reloads main messages, active task, and thread rows; each ThreadView reloads its thread and merges state by event versions so newer in-flight events win. Tests cover Chat row refresh, standalone and floating reload, and preservation of a newer event.
7. **Read retry/deduplication:** acknowledgements track pending, in-flight, and confirmed sequence values; rejected POSTs are caught and retry on focus or reconnect. A successful repeated sequence does not loop after `thread.updated`. Tests cover failed POST/focus retry and feedback-loop suppression.
8. **Deep-link membership:** fetched focus targets must match both workspace and thread before entering message state; missing/mismatched targets show a localized jump error. Tests reject main, foreign-thread, and foreign-workspace targets.
9. **Window stacking:** active z-index exceeds all inactive indices. Three-window regression focuses the first window and checks its stacking order.
10. **Withdraw synchronization:** each mounted change chip subscribes through the shared multiplexed hook and refreshes on matching `knowledge.changed`; request generations prevent older fetches overwriting newer status. Two mounted copies both hide Withdraw after a status change.
11. **Lossless SSE fanout:** the host's single-event React state mailbox was removed. Event callbacks run for each parsed frame synchronously. Rapid created/created/thread.updated regression verifies both replies arrive and background windows remain unread.

### RED / GREEN

- RED: before implementation, ran `npx vitest run --project @nema/web apps/web/test/Chat.test.tsx apps/web/test/Composer.test.tsx apps/web/test/ThreadView.test.tsx apps/web/test/ThreadWindows.test.tsx apps/web/test/MessageItem.test.tsx apps/web/test/WorkspaceShell.test.tsx apps/web/test/useHubEvents.test.tsx`. The new behavioral cases failed against the reviewed implementation: thread replies leaked into main chat; keyboard selection picked hidden `/thread`; same-thread/main-target jumps did not navigate; target IDs were dropped; host events could not reach retained workspace windows; reconnect left thread lists/views stale; failed reads did not retry; foreign targets were accepted; background windows acknowledged messages; stacked active windows could remain underneath; duplicate chips stayed stale; and a rapid event burst lost an intermediate frame. The first run also exposed a test setup import typo, corrected before implementation verification.
- GREEN focused: `npx vitest run --project @nema/web apps/web/test/useHubEvents.test.tsx apps/web/test/Chat.test.tsx apps/web/test/Composer.test.tsx apps/web/test/ThreadView.test.tsx apps/web/test/ThreadWindows.test.tsx apps/web/test/MessageItem.test.tsx apps/web/test/WorkspaceShell.test.tsx` — 7 files / 77 tests passed. After adding explicit successful-ack feedback-loop coverage, `npx vitest run --project @nema/web apps/web/test/ThreadView.test.tsx` — 1 file / 18 tests passed.

### Final verification

- `npx vitest run --project @nema/web` — 25 files / 220 tests passed (existing Vite config-loader warning only).
- `npm run lint -w apps/web` — passed with no warnings after removing obsolete directives and fixing the touched Chat/MessageItem lint errors.
- `npm run typecheck` — passed.
- `npx tsc -p apps/web/tsconfig.json --noEmit` — passed.
- `npm run build -w apps/web` — passed; includes `/w/[id]/t/[tid]`.
- `git diff --check` — passed.

### Concerns

- Browser smoke remains controller-owned and was not run here. The pre-fix controller browser findings are covered by added behavioral regressions; the controller should still perform the planned final smoke.
- Vitest prints the pre-existing Vite `configLoader: 'native'` CommonJS/ESM warning; all tests pass.
