# Threads and the Copilot Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the room agent into a copilot that only writes definite content, and add threads: conversations anchored to a main-chat message, with isolated context, shown in a floating window (web) or an OS window (desktop), where grill follow-ups also live.

**Architecture:** A thread is a `threads` row whose id is its anchor message id; thread messages carry `messages.thread_id`. The hub decides where a task's reply goes when the task finishes (main chat or a thread) and builds prompt context per conversation. The web renders one `ThreadView` both inside a floating window and on a `/w/[id]/t/[tid]` route that the desktop shell opens as its own `BrowserWindow`.

**Tech Stack:** Hono hub on Postgres (pg / pglite in tests), Next.js web, Electron desktop, MCP room server in `apps/cli`, vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-10-26-threads-and-copilot-design.md`

**Base:** main after (1) the main-chat answer box + `/` menu work (`namedAnswerId`, `chooseAskedQuestion`, `apps/web/lib/slash.ts`) is committed and (2) `feat/message-quote-edit-search` is merged, including `010_message_versions.sql`. Verify both prerequisites and a clean `git status` before implementation. The threads migration is `011` only if it is still the next free number; otherwise use the next free number and update references.

## Global Constraints

- Code and comments in English; prompt text in Chinese like the rest of `prompt.ts`.
- No new dependencies.
- Tasks stay serialized per workspace (`claimNextTask` unchanged). No parallel execution.
- Thread context: the anchor plus the latest 50 thread messages. Main-chat context: latest 20 main-chat messages.
- Every knowledge rule applies identically in the main chat and in threads.
- i18n keys in `apps/web/messages/{en,ja,zh}.json` for every new string.
- README (zh, en, ja) and CHANGELOG `## [Unreleased]` updated in the last task.
- npm workspaces; one root vitest with a project per package. Run one file with `npx vitest run --project @nema/<pkg> <file-filter>`. After each task run `npm run typecheck`, the touched projects' tests, and `npm run lint -w apps/web` when web changed; fix before moving on.

## Review Focus

1. A task whose message is in a thread must never post its reply to the main chat, including on failure (`处理失败：` system message goes to the same thread). → Task 4 test `failure message stays in the thread`.
2. The task is retried after a daemon drop (`priorChanges`); a retry must not open a second thread for the same anchor. → Task 3 test `open_thread twice returns the same thread`, Task 4 test `retry reuses thread`.
3. A thread's anchor in the main chat is edited (quote/edit work): the re-run must reply in that anchor's thread, not in the main chat. → Task 4 test `edit of an anchor replies in its thread`.
4. Two thread windows open for the same thread (two tabs, or web + desktop): read state stays consistent because it lives in the hub, and marking read acknowledges only rendered messages and never moves `last_read_seq` backwards or consumes unseen concurrent arrivals. → Task 2 test `markRead never lowers last_read_seq` and `unseen concurrent arrival remains unread`.
5. Archived workspace: posting in a thread or `/thread` is refused with 409 like a main-chat message. → Task 6 test `thread post in archived workspace is 409`.

---

### Task 1: Schema — threads, `thread_id`, `dropped` for every kind

**Files:**
- Create: `apps/hub/src/db/migrations/011_threads.sql`
- Modify: `apps/hub/src/db/snapshot.ts` (columns + optional table)
- Modify: `packages/shared/src/entry.ts` (`KIND_STATUSES`)
- Modify: `packages/shared/src/workspace.ts` (`Thread` type), `apps/hub/src/messages.ts` (`Message.threadId`)
- Test: `packages/shared/test/entry.test.ts`, `apps/local/test/migration.test.ts`, `apps/hub/test/persistentDb.test.ts` (or the snapshot test next to it)

**Interfaces:**
- Produces: `Message.threadId: string | null`; `Message.seq: number` (required in API responses and events for `throughSeq` acknowledgements); `type ThreadOpenedBy = "agent" | "user" | "grill"`; `type Thread = { id: string; workspaceId: string; title: string; openedBy: ThreadOpenedBy; replyCount: number; unread: number; lastReplyAt: string | null; createdAt: string }` exported from `@nema/shared`.
- Produces: `HubEvent` gains `| { type: "thread.updated"; thread: Thread }` (`apps/hub/src/events.ts` and the web's mirror in `apps/web/lib/types.ts`).

- [x] **Step 1: Failing tests**
  - `entry.test.ts`: `it("every kind accepts dropped")` — for each of `ENTRY_KINDS`, the persisted entry status schema accepts `dropped`; validate ordinary upserts where supported and full `EntryFrontmatter` fixtures for dedicated-operation kinds (diagram/workpackage). Preserve their existing upsert restrictions.
  - snapshot test: `it("round-trips threads and thread_id")` — export a workspace with one thread and one thread message, import into a fresh db, both present, including a durable question association; `it("imports a snapshot without threads")` — a snapshot lacking `threads`, `question_threads` and `messages.thread_id` imports, messages get `thread_id = null`.
- [x] **Step 2: Run** `npx vitest run --project @nema/shared entry` and `npx vitest run --project @nema/hub snapshot` → FAIL.
- [x] **Step 3: Implement**
  - `011_threads.sql`:
    ```sql
    alter table messages add column thread_id text null references messages(id);
    create index messages_thread_idx on messages(thread_id, seq);
    create table threads (
      id text primary key references messages(id),
      workspace_id text not null references workspaces(id),
      title text not null,
      opened_by text not null check (opened_by in ('agent','user','grill')),
      last_read_seq bigint not null default 0,
      created_at timestamptz not null default now()
    );
    create table question_threads (
      workspace_id text not null references workspaces(id),
      question_id text not null,
      thread_id text not null references threads(id),
      primary key (workspace_id, question_id)
    );
    ```
  - `KIND_STATUSES`: append `"dropped"` to every kind that lacks it. `INACTIVE_STATUSES` already contains it.
  - Snapshot: `messages` columns gain `thread_id`; add `threads: ["id","workspace_id","title","opened_by","last_read_seq","created_at"]` to `TABLE_COLUMNS` and `OPTIONAL_TABLES`; a missing `thread_id` column imports as null. Add `question_threads: ["workspace_id","question_id","thread_id"]` to both snapshot lists, export after `threads`, restore after messages and threads, and allow older snapshots to omit it. Workspace delete removes `question_threads` before `threads` before `messages`. Import inserts main-chat anchors before thread replies regardless of snapshot row order; validate that anchors are not nested. Add a reversed-message-row regression with an edited anchor.
  - `toMessage` maps `thread_id` → `threadId`; add it to `COLS`.
- [x] **Step 4: Run** both test commands and `npm run typecheck` → PASS.
- [x] **Step 5: Commit** `feat: store threads and allow dropped on every entry kind`

### Task 2: Hub thread store and conversation context

**Files:**
- Create: `apps/hub/src/threads.ts`
- Modify: `apps/hub/src/messages.ts`
- Test: `apps/hub/test/threads.test.ts` (new), `apps/hub/test/messages.test.ts` (or wherever `listPromptMessages` is tested)

**Interfaces:**
- Produces (in `threads.ts`):
  - `ensureThread(db: Db, anchorId: string, title: string, openedBy: ThreadOpenedBy): Promise<Thread>` — insert if missing (`on conflict do nothing`), return the row (an existing row keeps its title and `openedBy`). Throws `MessageOpError(400)` if the anchor itself has a `thread_id` (no nested threads).
  - `associateQuestion(db, workspaceId, questionId, threadId): Promise<{ threadId: string; inserted: boolean }>` — validate thread workspace, insert into `question_threads` on conflict do nothing, return the durable first association; callable within a transaction.
  - `getQuestionThread(db, workspaceId, questionId): Promise<string | null>` — explicit association first, then original creating-task inference; null means legacy.
  - `getThread(db, id): Promise<Thread | null>`
  - `listThreads(db, workspaceId): Promise<Thread[]>` — with `replyCount`, `unread` (messages with `seq > last_read_seq`, any role), `lastReplyAt`.
  - `markThreadRead(db, id, throughSeq: number): Promise<void>` — validate that `throughSeq` is a positive safe integer naming a message in this thread, otherwise `MessageOpError(400)`; set `last_read_seq = greatest(last_read_seq, throughSeq)`. Never read the server maximum as the acknowledgement target.
  - `conversationOf(db, message: Message): Promise<string | null>` — the thread id a message belongs to: its `threadId`, else its own id if a thread is anchored on it, else null.
- Produces (in `messages.ts`):
  - `postUserMessage(db, workspaceId, content, opts?: { quoteMessageId?: string; threadId?: string })` — signature change; callers updated. `threadId` must name a thread of the same workspace (`MessageOpError(400)`).
  - `listMessages` returns main-chat messages only (`thread_id is null`).
  - `listThreadMessages(db, threadId, limit = 200): Promise<Message[]>` — oldest first, excludes the anchor.
  - `listPromptMessages(db, workspaceId, messageId, limit)` and `listRecentMessages(...)` gain the conversation filter: when the message belongs to a thread (via `conversationOf`), return the anchor followed by the latest `limit` thread messages (limit 50 for threads, passed by the caller); otherwise main-chat messages only.
  - `getLastAgentMessage(db, workspaceId, threadId: string | null)` — scoped to the conversation.
  - `getLastAskedQuestion(db, workspaceId, threadId: string | null)` (exported from `threads.ts`) — latest asked-question card in that conversation, including system cards created by legacy conversion. Used to build answer context.

- [x] **Step 1: Failing tests** in `threads.test.ts`:
  - `ensureThread is idempotent` — two calls, one row, same title as the first call.
  - `ensureThread refuses an anchor inside a thread`.
  - `unread counts messages after last_read_seq; markThreadRead clears it`.
  - `markRead never lowers last_read_seq` — set `last_read_seq` above the thread's max seq by hand, acknowledge an existing older thread message, value unchanged.
  - `unseen concurrent arrival remains unread` — render through seq N, insert N+1, acknowledge N; N+1 remains unread.
  - `read rejects a foreign thread seq, nonexistent seq, or invalid number`.
  - `question association is idempotent and workspace-scoped`; `an existing association keeps its first thread`.
  - `getLastAskedQuestion includes a legacy system card and prefers a newer card`.
  - `main-chat prompt context excludes thread messages`; `thread prompt context is the anchor then only its own thread, capped at 50`.
  - `getLastAgentMessage is scoped to the thread`.
- [x] **Step 2: Run** `npx vitest run --project @nema/hub threads` → FAIL.
- [x] **Step 3: Implement** the functions above. `listThreads` is one query grouping `messages` by `thread_id` joined to `threads`.
- [x] **Step 4: Run** `npx vitest run --project @nema/hub` and `npm run typecheck` → PASS (fix existing callers of the changed signatures).
- [x] **Step 5: Commit** `feat(hub): thread store and per-conversation context`

### Task 3: `open_thread` room tool

**Files:**
- Modify: `apps/hub/src/roomApi.ts` (new route)
- Modify: `apps/cli/src/room/client.ts`, `apps/cli/src/direct/tools.ts`, `apps/cli/src/mcp/server.ts`, `apps/cli/src/claude/launch.ts` (`CLAUDE_ROOM_TOOLS`)
- Test: `apps/hub/test/roomApi.test.ts`, `apps/cli/test/direct/*.test.ts` (tool list + dispatch), `apps/cli/test/claude/launch.test.ts`

**Interfaces:**
- Consumes: `ensureThread`, `conversationOf` (Task 2).
- Produces: `POST /room/threads` body `{ title: string (1–80) }` → `{ threadId }`. Anchor = the task's message (`ensureThread(..., "agent")`). If that message is already in a thread, the call renames it to `title` (`renameThread(db, id, title)`, added in `threads.ts`) and returns it. Emits `{ type: "thread.updated", thread }`.
- Produces: `RoomClient.openThread(args: unknown): Promise<RoomResult>`; tool `open_thread` with parameters `{ title: string }` and description `"Move this conversation into a thread anchored on the current message. Use it when the topic needs a longer back-and-forth. Your reply will be posted in the thread."`

- [x] **Step 1: Failing tests**
  - roomApi: `open_thread anchors on the task message`; `open_thread twice returns the same thread`; `open_thread on an existing thread renames it`; `open_thread from a thread task renames that thread`; `title is required`; `empty title is 400`.
  - cli: `roomTools lists open_thread`; `dispatchTool open_thread calls room.openThread`; `CLAUDE_ROOM_TOOLS contains mcp__room__open_thread`.
- [x] **Step 2: Run** `npx vitest run --project @nema/hub roomApi` and `npx vitest run --project @nema/cli` → FAIL.
- [x] **Step 3: Implement.** In `tools.ts` the "is room" check and the allowed-names error list include `open_thread`; the comment "three Room functions" becomes "four".
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** `feat: let the agent open a thread`

### Task 4: Reply routing and follow-ups in threads

**Files:**
- Modify: `apps/hub/src/daemonSocket.ts` (`buildTaskPrompt`, `onFinished`, prompt-failure path)
- Modify: `apps/hub/src/messages.ts` (`addMessage` gains `threadId`)
- Modify: `apps/hub/src/entryIndex.ts` (drop the top-open-question fallback use)
- Test: `apps/hub/test/daemonSocket.test.ts`

**Interfaces:**
- Consumes: Task 2 functions; Task 3 thread rows.
- Produces: `addMessage(db, workspaceId, role, content, opts: { taskId?; meta?; threadId?: string | null })`.
- Routing rule, applied in `onFinished` and in the failure path, computed once per task as `replyThread`:
  1. `conversationOf(taskMessage)` if non-null (message in a thread, or a thread already anchored on it by `open_thread` / `/thread`);
  2. else, grill on and `chooseAskedQuestion(touched, null)` selects an **open question added or updated** by this task → `ensureThread(taskMessage.id, <selected question title>, "grill")`;
  3. else null (main chat).
- Finish the task status transition, ensure the reply thread, insert the reply and record question associations in one database transaction; emit events only after commit. A stale run token must not create a reply or thread. Inject an insert failure in a regression, verify rollback, then retry and assert exactly one reply.
- `askedQuestion` = `chooseAskedQuestion(touched, null)` — exclude resolved/dropped questions; no `topOpenQuestion` fallback. Use this same selection for routing. After resolving `replyThread`, atomically store the reply and associate every open question touched by this task with that thread if not already associated. Include prior changes on retry; never relocate an existing association.
- `buildTaskPrompt`: context via the Task 2 conversation filter (thread limit 50, main 20); `lastAskedQuestion` from `getLastAskedQuestion(db, ws, conversationOf(taskMessage))`; passes `conversation` (Task 5 type) to `buildPrompt`, built from `getThread` and the anchor message; `opened` is the thread's `openedBy`.

- [x] **Step 1: Failing tests** (daemonSocket harness already fakes a daemon):
  - `reply goes to the thread when the task message is in a thread`.
  - `reply goes to the thread opened by open_thread during the task` and the main chat gets no agent message.
  - `a main-chat task that adds a question replies in a new thread on its message`.
  - `a main-chat task that updates an existing open question replies in a thread`; `updating a resolved or dropped question does not open a thread`.
  - `thread reply associates all touched open questions once, including on retry`.
  - `a main-chat task with no question and no open_thread replies in the main chat`.
  - `askedQuestion is null when the task touched no question` (old fallback gone).
  - `failure message stays in the thread`.
  - `retry reuses thread` (interrupt + requeue a task that already called open_thread; one thread, one reply).
  - `edit of an anchor replies in its thread`.
  - `report that adds a question opens a thread on the report`.
  - `grill off: a task that adds a question replies in the main chat`.
- [x] **Step 2: Run** `npx vitest run --project @nema/hub daemonSocket` → FAIL.
- [x] **Step 3: Implement** the rule. Events: `message.created` carries the message (with `threadId`); after a thread message is added also emit `thread.updated` with the fresh `getThread` + counts.
- [x] **Step 4: Run** `npx vitest run --project @nema/hub` and `npm run typecheck` → PASS.
- [x] **Step 5: Commit** `feat(hub): route replies and follow-ups into threads`

### Task 5: Copilot prompt

**Files:**
- Modify: `apps/hub/src/prompt.ts`
- Test: `apps/hub/test/prompt.test.ts`

**Interfaces:**
- Consumes: `conversation` input from Task 4.
- `buildPrompt` input gains `conversation: { kind: "main" } | { kind: "thread"; title: string; anchor: Message; opened: "agent" | "user" | "grill" }` (default main).

Rule changes (Chinese text is the builder's wording; these assertions pin the content):
- Role: "你是这个项目的资深架构师 / copilot" — talk, ask back, propose, disagree.
- Judgment: write entries only for content the user stated, decided or asked to record, and URLs; casual talk, questions about the project and memo checks are answered without writing.
- Unconditional: what the user clearly stated or decided must be written (`stated` / `decided`), in the main chat and in threads alike.
- Agent proposals are never `stated` / `decided`; only what the user agreed to is `decided`.
- Conflict: explicit override → supersede as today; any other contradiction of an active decision → do not write the decision, open a `question` with the active decision in `related`, the user's statement in `quotes` / `sourceMessages`.
- Main chat only: "需要来回讨论时调用 `open_thread`"; with grill on: "新增或更新未解决的追问时，你的回复会被放进 thread，把回复写成开启讨论、提出这个问题的话".
- Thread only: section `# 当前 thread：<title>` with the anchor `[id] role: content`; follow-up questions are asked in the reply, one at a time; `opened: "user"` adds "这是用户主动开的 thread，直接进入讨论。标题目前是用户输入的第一行；如果它不能概括这个话题，调用 `open_thread` 给出更好的标题。"
- Removed: "最后的回复只简短总结做了什么", "不要在回复里提问，系统会自动从待确认中挑一个问题展示".

- [x] **Step 1: Failing tests**
  - `main prompt keeps the must-write rule and offers open_thread`.
  - `thread prompt has the same knowledge rules as the main prompt` — the numbered `# 规则` lines about upsert/basis/question/source/conflict are identical between `{kind:"main"}` and `{kind:"thread"}` builds (anti-goal 2).
  - `thread prompt shows the anchor and title`; `a user-opened thread prompt asks the agent to rename a bad title via open_thread`; `an agent-opened thread prompt does not offer open_thread`.
  - `conflict rule names related and quotes` (anti-goal 1, prompt side).
  - `no summary-only reply rule remains`.
  - Update existing assertions that pinned the removed sentences.
- [x] **Step 2: Run** `npx vitest run --project @nema/hub prompt` → FAIL.
- [x] **Step 3: Implement.** Keep the knowledge rules in one array used by both conversation kinds; only the conversation-specific lines differ.
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** `feat(hub): copilot prompt for the main chat and threads`

### Task 6: UI API — threads, attention badge, withdraw

**Files:**
- Modify: `apps/hub/src/uiApi.ts`, `apps/hub/src/events.ts`, `apps/hub/src/threads.ts`, `packages/knowledge/src/store.ts`
- Test: `apps/hub/test/uiApi.test.ts`, `packages/knowledge/test/store.test.ts`

**Interfaces:**
- Produces (in `threads.ts`): `attentionCount(db, dataDir, workspaceId): Promise<number>`, `attentionCounts(db, dataDir): Promise<Record<string, number>>` (for `GET /workspaces`), `nextAttention(db, dataDir, workspaceId): Promise<string | null>` (thread id).
- Routes:
  - `GET /workspaces/:id/messages/:messageId` → raw `Message`, including numeric `seq` and `threadId`; missing or foreign-workspace message is 404. Keep static `/messages/search` registered first. This resolves source/quote jumps without scanning every thread.
  - `GET /workspaces/:id/threads` → `Thread[]`.
  - `GET /workspaces/:id/threads/:tid/messages` → `{ thread: Thread; anchor: Message; messages: Message[] }`.
  - `POST /workspaces/:id/threads` body `{ content, quoteMessageId? }` → `/thread`: in one transaction post the anchor user message (main chat), `ensureThread(anchor.id, <first line of content, max 80 code points>, "user")`, queue its task. Returns `{ message, thread, task }`.
  - `POST /workspaces/:id/threads/:tid/messages` body `{ content, quoteMessageId? }` → user message in the thread + task.
  - `POST /workspaces/:id/threads/:tid/read` body `{ throughSeq: number }` → 204; calls Task 2 validation and monotonic acknowledgement; emits `thread.updated`. Validate route workspace ownership before any mutation.
  - `POST /workspaces/:id/entries/:eid/withdraw` → entry; `KnowledgeStore.withdraw(id, { author: "user" })` sets `status: "dropped"`, reason `用户撤回`, leaves `basis` and `confirmedAt`; reindex + `knowledge.changed`.
  - `GET /workspaces/:id/attention/next` → `{ threadId: string } | null`. Merge unread threads (timestamp of oldest unread message) and legacy open questions (creation timestamp), sort oldest first across both with a stable id tie-break. Legacy means `getQuestionThread(...)` returns null. For a legacy question, in one transaction lock its workspace row before creating any fallback anchor, recheck its association, choose its first valid main-chat source in this workspace or the latest main-chat message (create a system anchor without a task if neither exists), ensure the thread, and call `associateQuestion`. Only the transaction that inserts the association posts the system `askedQuestion` card with empty `changes`; concurrent/repeated calls return the existing association without another card. Explicit associations take precedence over creating-task inference in all attention queries. All mutations emit events after commit.
- `GET /workspaces` field `openQuestions` is replaced by `attention` = unread threads + legacy open questions (`attentionCount`). Web updated in Task 7.
- `GET /workspaces/:id/messages` returns main-chat messages only (Task 2); the web gets thread rows from `GET /threads`.
- Search covers thread messages too; results carry `threadId` so the web can open the window.

- [x] **Step 1: Failing tests**
  - `slash thread creates anchor, thread and task in one go`.
  - `thread post in archived workspace is 409` (both POST routes).
  - `thread post to another workspace's thread is 400`.
  - `read acknowledges throughSeq and emits thread.updated`; `a message arriving after the rendered seq remains unread`; `read rejects another workspace or thread seq`.
  - `attention counts unread threads plus legacy questions`; `a question added inside a thread is not legacy`; `withdrawn question no longer counts`.
  - `attention/next opens a thread for a legacy question with its card`; `converted question stops counting as legacy even when its original task is not on the chosen anchor`; `concurrent and repeated conversion creates one association and one card`; `empty history creates a system anchor without a task`; `concurrent empty-history conversion creates one anchor, thread and card`; `mixed unread threads and legacy questions are ordered globally oldest first`; `returns null when nothing needs attention`.
  - `answer after legacy conversion receives the system card question as lastAskedQuestion`.
  - store: `withdraw sets dropped and keeps basis`.
- [x] **Step 2: Run** `npx vitest run --project @nema/hub uiApi` and `npx vitest run --project @nema/knowledge store` → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** `feat(hub): thread, attention and withdraw endpoints`

### Task 7: Web — thread row, thread view, floating window, `/thread`, badge, withdraw

**Files:**
- Create: `apps/web/components/ThreadView.tsx` (header, pinned anchor, messages, composer)
- Create: `apps/web/components/ThreadWindows.tsx` (floating windows host in a persistent root client provider, controlled by `WorkspaceShell`)
- Modify: `apps/web/app/layout.tsx` (persistent client provider under i18n, retaining windows across workspace page remounts)
- Create: `apps/web/app/w/[id]/t/[tid]/page.tsx` (full-page `ThreadView`, used by the desktop window)
- Create: `apps/web/lib/threads.ts` — `openThread(workspaceId, threadId, host)`: desktop (`window.nemaWindowControls` present) → `window.open(threadUrl, "_blank")`; web → `host.open(threadId)`.
- Modify: `apps/web/lib/hub.ts`, `apps/web/lib/types.ts`, `apps/web/lib/slash.ts`, `apps/web/components/{Chat,Composer,MessageItem,Sidebar,WorkspaceShell,EntryDetail}.tsx`, `apps/web/app/globals.css`, `apps/web/messages/{en,ja,zh}.json`
- Test: `apps/web/test/ThreadView.test.tsx` (new), `Chat.test.tsx`, `Composer.test.tsx`, `MessageItem.test.tsx`, `Sidebar` test, `slash.test.ts`

**Interfaces:**
- Consumes: Task 6 routes and `thread.updated`.
- `Chat` receives `threads: Map<anchorId, Thread>` and `onOpenThread(threadId)`; `MessageItem` renders `ThreadRow` (title, `n replies`, red unread pill when `unread > 0`, last reply time) under an anchor.
- `SLASH_ITEMS` gains `{ id: "thread", hint: "cmd.thread", insert: "cmd.thread.insert" }`; `Composer` sends via `POST /threads` when the text starts with the inserted `/thread ` prefix (strip it). Not offered inside `ThreadView`.
- Main chat: remove `AnswerBox` and the `回答 Q-n：` send path from `Chat`; `AskedQuestion` shows the card only (inside threads too); thread composer answers.
- Change chips: `add` chips get a withdraw button (`POST /entries/:eid/withdraw`), hidden once the entry is `dropped`; `update` chips open the entry's history tab.
- Sidebar badge shows `attention`; clicking calls `attention/next` and opens the returned thread (selecting the workspace first if needed). Tooltip key `sidebar.attention`.
- `ThreadView` acknowledges read after rendering on open/focus and after each rendered message batch while focused. Send `{ throughSeq }` from the highest displayed thread message, never a later event's seq or the server maximum; skip empty threads and unfocused/background windows.
- Jump-to-message (`EntryDetail` source jump, search hit, quote block) opens the thread when the target message has a `threadId` (or is resolved via `GET /threads/:tid/messages`).

- [x] **Step 1: Failing tests**
  - `ThreadView`: `shows the anchor and thread messages`; `sends in the thread`; `marks rendered messages read on open with throughSeq`; `does not acknowledge an unrendered arrival or background message`; `no /thread in its composer`.
  - `Chat`: `renders a thread row with unread count under the anchor`; `clicking the row opens the thread`; `no answer box in the main chat`.
  - `Composer`: `/thread text posts a new thread`.
  - `MessageItem`: `withdraw on an add chip calls withdraw`.
  - Sidebar: `badge shows attention and opens the next thread`.
  - `openThread uses window.open on desktop and the floating host on web`.
- [x] **Step 2: Run** `npx vitest run --project @nema/web` → FAIL.
- [x] **Step 3: Implement.** Floating window: fixed position bottom-right, stacked to the left for each additional one, header drag moves it, close removes it from the host; keyboard: Escape closes when focused. Follow the existing CSS variables in `globals.css`.
- [x] **Step 4: Run** `npx vitest run --project @nema/web`, `npm run lint -w apps/web` and `npm run typecheck` → PASS.
- [x] **Step 5: Commit** `feat(web): threads in their own window`

### Task 8: Desktop — thread windows

**Files:**
- Modify: `apps/desktop/security.cjs`, `apps/desktop/lifecycle.cjs`, `apps/desktop/window-controls.cjs` (one sender-scoped IPC dispatcher for multiple secure app windows)
- Test: `apps/desktop/test/lifecycle.test.mjs`, `apps/desktop/test/security.test.mjs` (if present), `apps/desktop/test/window-controls.test.mjs` (multiple owners and independent cleanup)

**Interfaces:**
- `THREAD_WINDOW_PATH = /^\/w\/ws_[A-Za-z0-9_-]{1,32}\/t\/m_[A-Za-z0-9_-]{1,32}$/`; `isThreadWindowUrl(url, origin)` same-origin, no hash; optional exactly one `messageId` query with the strict message id pattern is allowed for source navigation. Reject arbitrary, invalid and duplicate query parameters.
- `openThreadWindow(url, origin)`: one window per canonical thread path — focus the existing one if open, delivering/navigating to a new validated `messageId` focus target when supplied. Uses `createSecureWindowOptions(origin)` (the app page, with preload, like the main window), not the diagram options. Its navigation is limited to its own canonical thread path with the same validated optional focus query.
- `setWindowOpenHandler` handles thread URLs before diagrams; everything else unchanged.

- [x] **Step 1: Failing tests:** `opens a same-origin thread URL in its own window`; `a second open of the same thread focuses the existing window`; `thread URL with an arbitrary query is denied`; `valid messageId query focuses the same thread window`; `invalid/duplicate messageId or a hash is denied`; existing diagram and external-link tests stay green.
- [x] **Step 2: Run** `npx vitest run --project @nema/desktop` → FAIL.
- [x] **Step 3: Implement.**
- [x] **Step 4: Run** → PASS.
- [x] **Step 5: Commit** `feat(desktop): open threads in their own window`

### Task 9: Anti-goal checks, docs

**Files:**
- Test: `apps/hub/test/threadConflict.test.ts` (new)
- Create: `docs/reviews/2026-10-26-thread-agent-script.md` (manual run script)
- Modify: `README.md`, `README.en.md`, `README.ja.md`, `CHANGELOG.md`

- [x] **Step 1: Deterministic API and routing test** `threadConflict.test.ts`: workspace with thread A and thread B. Through the room API with a run token of a thread-A task: upsert decision D-1 "缓存用 Redis" (`basis: decided`, source = A message). With a thread-B task: upsert a contradicting decision `id: D-1` rewrite citing only an agent message → 409 (existing guard); then upsert a `question` with `related: ["D-1"]`, quotes from the B user message. Then through the daemon harness finish the B task. Assert: D-1 still `active` and unchanged; the question's reply landed in thread B (`askedQuestion` on the agent message in B). This checks the existing API guard and the supplied question/tool sequence, not semantic conflict detection or rejection of a new conflicting decision id. Second case: B user message "改用本地 LRU，推翻 D-1" → upsert `id: D-1, status: superseded` with `basis: decided` citing it → 200.
- [x] **Step 2: Run** `npx vitest run --project @nema/hub threadConflict` → PASS (it exercises Tasks 2–5; if it fails, fix the owning task's code, not the test).
- [x] **Step 3: Real-agent acceptance script and run** (both anti-goals) in `docs/reviews/2026-10-26-thread-agent-script.md`: four conversations with the expected outcome each — memo check in the main chat (no writes); casual design chat that ends with "就这么定了：用 Redis" in a thread (one `decided` decision); `/thread` brainstorm with no decision (no writes); contradicting decision in a second thread (a question in that thread, no new decision). For the conflict case, first let the real agent record Redis in thread A, then send "缓存用本地 LRU" in B without an explicit override. Inspect the complete resulting decision list, including new ids: Redis stays the only active decision; B gets a question related to Redis and quoting B's user message. Follow with "改用本地 LRU，推翻 D-1" (use the actual id) and check Redis is superseded and LRU becomes active. Run against a real configured runtime/model, record runtime/model, entry/message ids, relevant tool trace and actual pass/fail in the script's results section. Do not hand-author the question tool call in this run. If runtime access is unavailable, record this acceptance check as not run and the concrete blocker; deterministic tests passing does not complete the behavioral validation.
- [x] **Step 4: Docs.** README: threads (agent-opened, `/thread`, windows, badge), withdraw, the copilot behaviour; CHANGELOG Unreleased: Added threads / `/thread` / withdraw / attention badge; Changed agent behaviour and follow-ups move into threads; Removed the main-chat answer box.
- [x] **Step 5: Full check** `npm test`, `npm run typecheck` and `npm run lint -w apps/web` → PASS. Commit `test: thread conflict check, docs for threads`.

## Verification status

Tasks 1–9 are implemented and task-reviewed. Whole-branch Sol review found five integration issues; commits `7469f83` and `bcacd6f` address all five plus both optional minor findings. The scoped Sol review approves the resulting implementation.

The final integrated suite passed 1322 tests (22 skipped), across 119 passing files (one skipped), in 581.19 seconds. That run started before the final narrow Web hash-receiver amendment; the complete Web suite was separately run on `bcacd6f` and passed all 234 tests across 26 files. Root and CLI typechecks, Web TypeScript, Web lint (exit zero with one request-counter cleanup warning), production Web build, and 35 desktop tests passed. Real Chromium passed 16 checks covering routing, events, focus/read state, navigation, withdrawal, small-viewport geometry and repeated same-document message jumps.

The real current-runtime attempt failed before a model reply with `EAI_AGAIN`; semantic acceptance is not run, as recorded in `docs/reviews/2026-10-26-thread-agent-script.md`.
