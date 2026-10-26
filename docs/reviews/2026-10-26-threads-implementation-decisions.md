# Threads and copilot implementation decisions

Implemented from the approved spec and plan using Luna low workers and Sol high reviewers. These decisions resolve gaps found during implementation; the spec remains authoritative.

## Decisions recorded during implementation

- Ruling: start from origin/main ff025a5 in a linked worktree — both predecessor changes are present there — costs a local isolated checkout; original work checkout stays untouched.

- Ruling: skill shell helper resources were unavailable from skills.read; create equivalent briefs, ledger and review diff packages locally — preserve required artifacts and task isolation — no product behavior cost.

- Ruling: Task 1 updates affected Message fixtures and type mirrors so its typecheck passes — required threadId field otherwise breaks existing callers — mechanical scope only.

- Ruling: Task 4 may introduce optional conversation input/type scaffolding in prompt.ts; Task 5 owns actual prompt behavior — planned dependency points forward — small preparatory edit.

- Ruling: use user-requested Luna low for all implementation and Sol high for reviews, including final review — explicit model preference takes priority over skill default tier selection — additional fix iterations may be needed.

- Ruling: legacy conversion and reply writes must compose in one DB transaction; preserve first association with conflict-safe insert — retries/concurrent clicks require durable ownership — DB helper API may accept a transaction Db.

- Ruling: root typecheck excludes web; Task 7 and final validation also run web build or web tsc — CONTRIBUTING requires separate web validation — additional verification time.

- Ruling: continue planned feature work with recorded baseline failures — unrelated CLI permissions/process-tree tests predate changes — final validation must explicitly distinguish them. Use umask 022 in test shells; no product permission relaxation.

- Ruling: Task 1 every-kind dropped acceptance is checked using persisted Entry schema for diagrams; UpsertEntryInput tests cover upsertable kinds only — existing diagram__save-only restriction is intentional and withdraw will use dedicated store mutation — no expanded diagram upsert permissions.

- Task 1: review Important — snapshot restore assumes anchor appears before reply; row order is not guaranteed. Fix round 1/5 dispatched to original Luna worker; FIX_BASE 9bdaebd. Ruling: fix import order independent of export order, regression in local/import tests — required snapshot portability — minor import implementation expansion.

- Ruling: Task 4 should store finishTask status transition, selected replyThread creation, reply message and question associations in one Db transaction; only emit events after commit — token-stale completion and DB failures must not leave a finished task without its reply or empty spurious thread — one slightly larger transaction, consistent with existing nested tx support.

- Ruling: Task6 legacy conversion must serialize competing conversions in the same workspace before creating a fallback system anchor (for example SELECT workspace FOR UPDATE inside the conversion transaction), then recheck association — conflict-safe association insertion alone could still leave duplicate empty anchors/threads when history is empty — single-user workspace permits brief conversion serialization. Regression should assert one fallback anchor/thread/card on concurrent conversion, not only one mapping.

- Ruling: add GET /workspaces/:id/messages/:messageId returning raw Message (including threadId), 404 for missing or foreign-workspace message — source/quote jumps only know a message id and no existing single-message GET can resolve its thread — minimal read-only API completes required cross-thread navigation without scanning every thread. Register static /messages/search before dynamic route. Task6 adds route/tests; Task7 adds web getMessage helper and jump routing.

- Ruling: Task7 badge/source navigation must retain the target workspaceId through any asynchronous workspace selection, and open ThreadView with that target (not stale selectedId from the click closure). Add a cross-workspace badge regression that verifies the requested thread is loaded under the target workspace. Floating host state or a pending-open effect may implement this; preserve the explicit workspace in the transition.

- Ruling: expose required seq:number on Message DTO and web mirror, populate through COLS/toMessage/getLastAgentMessage so GET and message.created events carry read acknowledgement positions — client cannot implement throughSeq from DTO without it — mechanical fixture updates and one route numeric-seq assertion required; database/snapshot seq unchanged. Task6 owns DTO integration; Task7 consumes it.

- Ruling: Web floating windows need per-thread active/focus state; document.hasFocus alone must not mark every open floating thread read. Only active thread plus focused document acknowledges rendered seq. Standalone desktop route may use its own OS-window focus. Test background/unfocused thread arrival with two floating windows.

- Ruling: Task8 accepts only an optional single messageId query parameter matching the strict m_ id pattern, in addition to exact same-origin thread paths; all other/duplicate/invalid query keys and all hashes remain denied. Task7 source navigation uses this focus target, while original Task8 blanket query rejection would break required desktop source jumps. Canonical window identity is origin+thread path (ignore valid focus query); reopening same thread with another focus target reuses/focuses that OS window and delivers/navigates to the validated target. Navigation stays within its own canonical thread. Cost: narrowly expanded URL shape, covered by positive/negative security tests.

- Ruling: Task7 fixwave uses one shared EventSource subscription per workspace per browser window through existing useHubEvents hook signature. Every frame dispatches losslessly to all subscriber callbacks; ThreadView and chip status subscribers use this hook. Reconnect fanout reloads authoritative state while preserving newer in-flight events. This addresses retained cross-workspace views and prevents per-chip EventSource exhaustion of HTTP1 connection slots; no new dependency.

- Ruling: move floating-window ownership above the remounting workspace page into a persistent client provider under RootLayout/I18nProvider; WorkspaceShell controls the shared host instead of owning its component state. Preserve positions/active windows across route changes and badge opens; use current shell navigation registration or a real main-message fallback for host callbacks. Spec leaves component structure to builder; page-owned host mandated by plan proved incorrect in actual Next navigation. Cost: small provider/layout integration, no new dependency. Test remounting workspace page under persistent provider; controller verifies real routing.

- Ruling: Task8 thread windows use the same frameless secure app preload, so registerWindowControls must support multiple live windows. Existing code installs ipcMain.handle on fixed channels per registration, which would throw/overwrite when a child is registered. Refactor to one IPC dispatcher per ipcMain with a registry keyed by exact sender webContents; validate each owner mainFrame/origin, dispose only that owner, and remove shared handlers only after last window closes. Keep preload channel/API stable. Add multi-window own-controls and cleanup tests; modify window-controls.cjs and its existing test as necessary. This is required for working secure thread titlebars, not extra scope.

## Browser verification

Real Chromium exercised main-chat isolation from thread replies, lossless rapid event delivery, active-window read acknowledgements, dragging, retaining windows across actual workspace navigation, and rejecting a foreign focus-message target. Six core checks passed. Four additional checks passed: preserving textarea focus, sending `/thread` through the actual composer, opening an attention target in another workspace while retaining windows, and withdrawing a newly added knowledge entry.

The browser transport fixture used a fake daemon and does not establish model behavior. Real-model acceptance results are recorded separately in the agent acceptance script.

## Review notes for the final gate

- Check slash command insertion uses its locale key.
- At a 780 × 437 viewport, cascading multiple windows can place headers above the viewport. The browser badge timeout came from clicking through a covering window; a 1440 × 1000 run passed. Assess window placement and recovery in the final review.
