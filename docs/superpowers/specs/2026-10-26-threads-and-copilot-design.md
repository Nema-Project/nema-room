# Threads and the copilot agent

Draft 2026-10-26. A repositioning of the room agent, not a bolt-on feature.

## Why

Today every chat message is an organize task. The prompt (`apps/hub/src/prompt.ts`) tells the agent to turn every input into entries, to reply only with a summary of what it wrote, and, with grill-me on, the system shows a follow-up question after every turn. The agent cannot simply talk.

The user wants the agent to be an experienced copilot, closer to an architect than a scribe: someone to chat with, think out loud with, argue with. Casual talk often organizes information better than per-message extraction, because an idea takes several turns to settle. Not everything said belongs in project knowledge; sometimes the user only comes back to check a memo ("did we decide X?").

Threads give that talk a place. A thread is a separate conversation with its own context, opened from a message in the main chat, shown in its own window.

## Goals

- The agent judges each message itself: casual talk or a question is answered and nothing is written; definite content (requirement, decision, tradeoff, task, source) is written to knowledge as today.
- Every write is visible in the reply and can be withdrawn in one click.
- Threads: a conversation anchored to one main-chat message, with its own context, in its own window.
- The agent opens a thread on its own when a topic deserves a longer talk; the user can open one explicitly with `/thread`.
- Grill follow-up questions live in threads, not in the main chat.
- One "needs attention" badge leads the user to every unread thread.

## Non-goals

- Running tasks in parallel. Tasks stay serialized per workspace (`claimNextTask`); threads only isolate context.
- PR-style merging of knowledge changes from parallel threads. This is the planned direction once tasks run in parallel: non-conflicting changes land in order, conflicting ones are resolved by the agent and, when needed, by asking the user. Not built now.
- Closing, archiving or "settling" a thread. A thread may end with nothing written; that is normal.
- Nested threads, threads on thread messages, threads across workspaces.
- Multi-user read state. The room is single-user (there is no users table).

## Anti-goals (what would make this a failure even if it works)

1. **Threads contradict each other unnoticed.** Thread A decides "Redis", thread B later decides "local LRU", and both stay active.
2. **The agent in a thread only chats.** It talks well but does not write what the user clearly stated or decided.

Each has a check in "Checks" below.

## The agent

One persona everywhere (main chat and threads): an experienced copilot / architect. It may answer, ask back, propose, disagree. The same knowledge rules apply everywhere; a thread does not relax them.

Prompt changes in `buildPrompt`:

- Replace "把用户输入整理成…条目" with a judgment rule: write entries only for definite content (what the user stated, decided, or asked to record, plus URLs as `source`); casual talk, questions about the project, and memo checks are answered without writing.
- Keep, unconditionally and in both places: what the user clearly stated or decided must be written, with `basis` `stated` / `decided`. Being in a conversation is never a reason to skip it. (Anti-goal 2.)
- Replace "最后的回复只简短总结做了什么" with: reply as the copilot, in the user's language; if entries were written, the reply mentions them briefly (the UI shows the chips anyway).
- Conflict rule, sharpened (anti-goal 1). When the user's message contradicts an active decision:
  - if the user explicitly overrides it ("switch from Redis to LRU", "drop D-3"), supersede it as today (prompt rule 5, Room API 409 check unchanged);
  - otherwise the new decision is not written. The agent opens a `question` in the current thread whose body names the active decision id and quotes the user's new statement (`quotes` + `sourceMessages`), with `related` set to the active decision. The user's answer then supersedes or keeps it.
  Because tasks are serialized, the later task always sees the earlier one's entries in the index.
- The agent's own proposals are never `stated` / `decided`. Only what the user agreed to is `decided`; proposals the user did not take up stay `inferred` or become `question`s. The existing basis rules already say this; the copilot rule must not weaken it.
- New: when a topic needs a longer back-and-forth, open a thread (see "Opening a thread"). The prompt states when: design questions with real options, problems that need several clarifications, anything the agent wants to grill on.
- The grill rule "不要在回复里提问，系统会自动从待确认中挑一个问题展示" is replaced: in a thread the agent asks its follow-up questions in the reply itself, one at a time.

Prompt text stays in Chinese like the rest of `prompt.ts`.

## Threads

### Model

A thread is identified by its anchor: one top-level main-chat message (any role: user, agent, system, report). Messages inside a thread carry `thread_id` = the anchor's message id. Main-chat messages have `thread_id` null.

New migration (next free number after the quote/edit work's `010`):

- `messages.thread_id text null references messages(id)`;
- table `threads(id text primary key references messages(id), workspace_id text, title text not null, opened_by text not null, last_read_seq bigint not null default 0, created_at timestamptz default now())`;
- table `question_threads(workspace_id text, question_id text, thread_id text references threads(id), primary key (workspace_id, question_id))`. Question ids belong to the knowledge store, not a SQL entries table. The association is durable and keeps the first assigned thread; later discussion elsewhere does not move it.

Snapshots (`apps/hub/src/db/snapshot.ts`) carry the column and both tables; an older snapshot imports with no threads. Deleting a workspace deletes its question associations before its threads.

### Opening a thread

- **By the agent.** A new `room` MCP tool (name builder's call, e.g. `open_thread({ title })`) available to organize tasks on a main-chat message. When called, the task's reply is stored as the first message of a new thread anchored to the task's message, not in the main chat. The main chat gets no extra message; the anchor just shows its thread row (below). If the anchor already has a thread, the reply goes into it.
- **By the user.** `/thread <text>` in the composer. It is a real command, not a text insert: the message `<text>` is posted to the main chat as the anchor, a thread is created on it at once with the first line of `<text>` (max 80 code points) as a provisional title, and the task's reply goes into the thread without the agent deciding. The task is told in the prompt that this is a thread the user opened, and that it should call `open_thread` with a better title when the provisional one does not describe the topic.
- A message posted inside a thread window is a normal user message with `thread_id` set; its task runs with thread context and its reply goes to the same thread.
- No "reply in thread" action on arbitrary existing messages in this version; quoting covers pointing back at one. Agent, system and report messages become anchors only through the paths above.

### Context

- Main-chat task: recent messages are main-chat messages only (`thread_id is null`), same 20 as today.
- Thread task: the anchor message, then the thread's messages, up to the latest 50. ponytail: fixed cap; a long thread loses its middle. Upgrade path is a rolling summary if this bites.
- Both get the full entry index, as today. Knowledge is shared across all threads; only conversation is isolated.

### Follow-up questions (grill)

- An open question added or updated by a task is a follow-up candidate. Resolved or dropped questions are excluded. A candidate belongs to that task's conversation: if the task's message is in a thread, the question is asked in that thread; if it is a main-chat message and grill is on, a thread is opened on it (same as the agent opening one) and the question is asked there. The whole reply moves into the thread, nothing stays in the main chat. The prompt tells the agent this, so it phrases a reply that adds a question as a thread opener that asks it.
- The "show the top open question after every turn" fallback (`chooseAskedQuestion(touched, topOpenQuestion)` in `onFinished`) is removed: `askedQuestion` is only an open question this task added or updated. Without this restriction, nearly every main-chat message would move into a thread. Use that same candidate selection for automatic thread creation, so updating a still-open question also moves the reply into a thread. All open questions touched by a thread reply receive a `question_threads` association if missing, atomically with storing the reply; retries preserve the first association.
- Legacy open questions (no thread association, including no thread inferred from the original creating task) are reached from the badge. Jumping to one opens a thread anchored on its first valid main-chat `sourceMessages` message in the same workspace, falling back to the latest main-chat message. If none exists, create a system anchor without queuing a task. In one transaction ensure the thread, insert the association, and add one system-posted asked-question card only if the association was newly inserted. Concurrent clicks and retries reuse the association and do not duplicate cards. The user answers there; the question immediately stops counting as legacy. Conversation context must recognize the system card as the last asked question when no newer agent card exists.
- In a thread, the user answers in the thread composer. `lastAskedQuestion` becomes per conversation: the latest asked-question card on an agent or system message in the same thread (today: the last agent message in the workspace). The `回答 Q-n：` answer box in the main chat is removed; the asked-question card is still shown on the agent message inside the thread.
- Reports (`role = 'report'`) and system requests follow the same rule: a question they produce opens a thread on the report / system message.
- Grill-me off: questions are still written (as today) but no thread is opened just for them.

### Read state and the badge

- A thread is unread when it has a message with `seq > last_read_seq`. After rendering messages when the window is open and focused, the client sends the highest displayed thread message seq as `throughSeq`. The hub validates that seq belongs to this thread and advances `last_read_seq` with `greatest(last_read_seq, throughSeq)`. It never substitutes its current maximum: a message arriving after the rendered batch stays unread. Empty threads need no read request. Stored in the hub so the web and the desktop windows agree.
- The sidebar badge (today: `openQuestions` in `GET /workspaces`) becomes: number of unread threads + open questions not belonging to any thread (pre-existing ones). A question belongs to a thread when `question_threads` has an association; if absent, infer one from the task that added it (`task_changes`) running on a message in that thread or on its anchor. Only open questions with neither association count as legacy.
- Clicking the badge opens the next item needing attention, oldest first: an unread thread opens its window; a legacy open question is attached idempotently to a thread with its asked-question card and opens that thread window. Works for the current workspace too (select the workspace first if it is another one).

## UI

### Thread row in the main chat

Under the anchor message, Google Chat style: thread icon, title, reply count, unread count (red pill), time of last reply. Clicking it opens the thread window. No other main-chat change when a thread is created.

### Thread window

- **Web:** a floating chat window over the workspace page (customer-support-widget style), draggable, closable. The three columns stay as they are. Several may be open; stacking/placement is the builder's call.
- **Desktop:** a real OS window. Same page, opened via `window.open` on a thread route; `apps/desktop/lifecycle.cjs` treats thread URLs like diagram URLs today (`isDiagramWindowUrl` / `openDiagramWindow`): same-origin check, own `BrowserWindow`, same secure options. Opening an already open thread focuses its window.
- One thread view component serves both. Content: header with title and close; the anchor message pinned at the top; the thread messages (same `MessageItem` rendering, including change chips, asked-question cards, work package cards); a composer. `/thread` is not offered inside a thread.
- Closing a window does not end the thread; the row in the main chat reopens it.

### Jumping to a message

Anything that jumps to a message (entry detail "jump to source", search results, quote blocks) opens the thread window when the message is in a thread.

### Withdraw

Each `add` change chip on an agent message (main chat or thread) gets a withdraw action. An `update` chip links to the entry's history (existing history tab) instead of an undo.

- `dropped` is added to the allowed statuses of every entry kind (today only requirements and work packages have it; `packages/shared/src/entry.ts`). Index, panel filters and prompt index lines treat `dropped` like an inactive status.
- A dedicated withdraw endpoint sets `status: dropped` with reason "用户撤回" and leaves `basis` and `confirmed` untouched. It does not reuse `PUT /entries/:eid`, which marks entries user-confirmed.
- A withdrawn question no longer counts for the badge.
- ponytail: withdrawing a decision does not re-activate a decision it superseded in the same task; the user sees that in the `update` chip and history. Upgrade path: record the superseded ids on the change and restore them.

## Relation to quote / edit / search

The quote / edit / search work (spec `2026-10-25-message-quote-edit-search-design.md`, branch `feat/message-quote-edit-search`) is kept and merged before this. Its non-goal "threads" is superseded by this document. Quote and threads coexist: a thread discusses around a message, a quote points at one message from anywhere, including across threads. Adjustments:

- Quoting works inside threads; a quote may point to a message in another thread or the main chat.
- Editing a thread message re-runs the task with thread context, and the reply goes into the same thread.
- Search results and quote blocks that point to a thread message open the thread window.
- Migration numbering continues after its `010_message_versions.sql`.

## Checks

- **Anti-goal 1 (threads conflict):** deterministic hub tests cover the existing Room API 409 guard, question metadata, reply routing, and explicit supersession. They do not prove semantic contradiction detection: a test that manually writes a question only proves that the supplied tool sequence is accepted. Separately run the real agent on a fixed script: thread A decides Redis; thread B says "缓存用本地 LRU" without explicitly overriding A. Assert from the resulting entries and tool trace that A remains the only active decision, no conflicting decision with a new id was created, and B gets a question with `related` pointing to A and `quotes` / `sourceMessages` citing B's user statement. Then explicitly override Redis with LRU and verify supersession and the replacement decision. Record runtime/model, trace and entry ids, and pass/fail; a simulated daemon is not a substitute. Prompt assertions pin the conflict rule and shared index but cannot establish this behavioral check.
- **Anti-goal 2 (agent only chats):** `prompt.test.ts` asserts the thread prompt contains the "stated / decided must be written" rule and the same tool rules as the main-chat prompt. Plus a short fixed script of conversations in `docs/` (or the test dir) for a manual run: one memo check (expect no writes), one clear decision inside a casual thread (expect a `decided` entry).
- Context isolation: `listPromptMessages` test — a main-chat task sees no thread messages; a thread task sees the anchor and only its thread.
- Read state: unread count, monotonic acknowledgements, rejection of another thread's seq, and a concurrent arrival after rendering tested in hub; focused rendering acknowledgements tested in web.
- Legacy questions: conversion persists its association, stops legacy counting, survives snapshot round-trip, and concurrent/repeated clicks create only one card; the first answer receives that question in prompt context.
- Desktop: `lifecycle.test.mjs` case like the diagram one — a same-origin thread URL opens its own window, other popups still denied.

## Constraints

- Code and comments in English; prompt text in Chinese.
- No new dependencies.
- i18n keys in en / ja / zh for: thread row (replies, unread, last reply), window title/close, `/thread` hint, withdraw, badge tooltip.
- README and CHANGELOG updated per project rules.
- Build on main after (1) the in-progress main-chat answer box work (`回答 Q-n：`, uncommitted on main) is committed and (2) `feat/message-quote-edit-search` is merged. This design then removes that answer box from the main chat.

## Decided by the user

- The agent is an experienced copilot / architect that discusses back and forth; not every message goes into knowledge (memo checks are fine).
- The agent decides itself between definite content (→ grill → knowledge) and casual talk.
- Withdraw/correct is important.
- Threads are opened both by the agent (directly, no confirmation) and by the user via `/thread`, which always opens a thread without the agent judging.
- A thread has no forced ending; it may write nothing, or the agent may use all its normal functions (record tasks, decisions, tradeoffs, questions) from inside it.
- Main chat and threads share one agent; the differences are context isolation and (later) async. First version: context isolation only, tasks stay serialized. Later parallel version: conflicts handled PR-style.
- Thread UI: a separate chat window — a floating chat widget on the web, a real OS window on desktop.
- Main-chat entry point: Google Chat style row under the anchor message with unread count; clicking opens the window.
- When the agent opens a thread, its real answer goes into the thread; no extra message in the main chat. The unread indicator leads the user there.
- Clicking the sidebar badge jumps to the next question / unread thread.
- Grill follow-ups go into threads, under the conversation that caused them.
- Failure looks like: threads contradicting each other unresolved; the thread agent not updating knowledge.
- Conflicts: an explicit override supersedes the old decision directly; any other contradiction becomes a question first.
- The quote / edit / search work is kept and lands first.

## Calls made in this design (not discussed)

- Thread id = anchor message id; anchors are main-chat messages only.
- Thread context cap of 50 messages plus the anchor.
- Read state stored in the hub, single-user.
- Badge = unread threads + legacy open questions; jump order oldest first.
- Reports and system requests open a thread when they produce a question; history stays in the main chat, no migration of old messages.
- Withdraw sets `dropped` (added to every kind) via a dedicated endpoint; updates are reviewed through history, not undone; a superseded decision is not restored.
- With grill on, the whole reply moves into the thread when a task adds or updates an open question; the top-open-question fallback is removed; legacy questions open a thread from the badge.
- Quote is kept alongside threads (reverses an earlier suggestion to replace it), since it is built and covers cross-thread references.
- Agent-opened thread uses a new `room` MCP tool; the agent names the thread.
- `/thread` title starts as the first line of the text; the agent renames it on its first reply by calling `open_thread` again.
- Grill-me off opens no thread for questions.

## Left to the builder

Component structure, floating window placement and stacking, the thread route path, MCP tool name and schema, SSE event shapes for thread rows and read state, read endpoint path (the `throughSeq` acknowledgement semantics are fixed), styling of the thread row and window, wording of the copy.
