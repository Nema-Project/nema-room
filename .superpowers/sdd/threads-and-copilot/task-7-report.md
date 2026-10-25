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
