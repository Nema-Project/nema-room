# Message quote, edit and search

Approved 2026-10-25. Three chat features, shipped together.

## Why

The organize prompt only carries the last 20 messages (`listPromptMessages`). Once a message falls out of that window the agent can no longer see it, and the user has no way to point back at it. Example: the user asked for project progress, a system request then asked to update code diagram G-1, and the user wanted to say "what I want is an architecture diagram" about that exact message. Today they can only send a loose new message with no link to the old one.

The user wants:

- to reply to any older message (theirs, the agent's, a system one) and keep talking about it, even if that breaks the strict question/answer rhythm of the chat;
- to edit their own messages, have the agent re-run on the new text, and have new entries cite the edited text;
- to find an old message by keyword.

Anti-goal: an edit or a quote must never make information disappear. Old text stays readable and entry quotes taken from it stay valid.

## Goals and non-goals

Goals: quote any message, edit own messages with version history and an automatic re-run, keyword search over the current workspace.

Non-goals: editing agent, system or report messages; deleting messages; threads or nested replies (the chat stays one time-ordered stream); fuzzy, full-text or cross-workspace search; giving the agent a history-search tool; paging older messages into the chat.

## Quote

Any message (user, agent, system, report) shows a quote action. Clicking it puts a quote bar above the composer showing the quoted message's role and the start of its text, with a remove button. Sending posts a normal user message with the quote attached. Only one quote per message.

Storage: user messages get a meta (today always null), `UserMessageMeta = { quote?: { messageId, role, excerpt } }`. `excerpt` is the first 200 code points of the quoted message's content at send time, so the chat can render the quote block without loading the quoted message. `POST /workspaces/:id/messages` accepts an optional `quoteMessageId`; the hub rejects it (400) if that message does not exist in the same workspace.

Rendering: the new message shows a quote block (role + excerpt) above its text. Clicking the block scrolls to the quoted message if it is loaded in the chat; otherwise nothing happens. (Builder's call: a "not loaded" hint is fine.)

Prompt: when the task's message has a quote, `buildPrompt` adds a section before the current message:

```
# 本次消息引用的消息
[<id>] <role>: <full current content of the quoted message>
本次用户消息是针对这条消息的补充、更正或确认。
```

The full content is fetched at prompt time with `getMessage`, so it is present regardless of the 20-message window. If the quoted message is also in the recent list it may appear twice; that is accepted.

The existing rule that a user message after an agent follow-up is the answer to it (`lastAskedQuestion`) is unchanged.

## Edit

Only `user` messages are editable, only by the UI, and not in an archived workspace (409 like posting). An edit is refused (409) while the message's own original task, or a previous edit task for it, is still queued or running.

An edited message shows "edited" next to its time. Clicking it lists the earlier versions with their times. The current text stays in `messages.content`.

Storage: new migration `010_message_versions.sql`:

- table `message_versions(message_id, version, content, created_at)`, primary key `(message_id, version)`; version 1 is the original text, written on the first edit;
- column `messages.edited_at timestamptz null`.

Snapshots (`apps/hub/src/db/snapshot.ts`, used by desktop export, import and migration) carry `message_versions` and `messages.edited_at`. A snapshot made before this change, with no `message_versions` table and no `edited_at` column, still imports: the table is treated as empty and the column as null. Deleting a workspace deletes its versions.

Edit = one transaction: insert the previous content as the next version, update `content` and `edited_at`, insert a queued task of a new kind `edit` for that message (`tasks.kind` check gains `'edit'`), emit `message.updated`.

Prompt for an `edit` task: same rules and context as a normal organize task, plus:

```
# 用户修改了一条消息
[<id>] 旧版本：<previous content>
[<id>] 新版本：<current content>
# 之前依据这条消息写入的条目
<index lines of entries whose sourceMessages contain <id>, or （无）>
按新版本更新或作废这些条目；新写入或更新的条目在 sourceMessages 中包含 <id>，quotes 从新版本逐字复制。
```

"旧版本" is always the text immediately before this edit, even if an earlier edit's task failed and the agent never saw it. The listed entries are the ground truth of what was recorded, and the instruction is to make them match the new version, so no "last successfully processed version" is tracked.

The current-message section shows the new version. Recent messages for an edit task are the latest 20 of the workspace excluding the edited message (the re-run happens now, not at the original time). `lastAskedQuestion` is not set for edit tasks.

The agent's reply is a normal agent message at the end of the chat. Its meta gets the same `quote` shape pointing at the edited message, so the chat renders it with the quote block and the user sees which edit it answers.

Quote verification in `roomApi.ts` (`message.content.includes(quote.text)`) also accepts text found in any stored version of that message, so quotes taken before an edit stay valid and new ones must match the new text by the prompt rule.

## Search

A search box in the chat header. `GET /workspaces/:id/messages/search?q=` returns up to 50 messages whose current content contains `q` case-insensitively (`ILIKE` with `%` `_` `\` escaped), newest first. Empty or whitespace-only `q` returns an empty list. Old versions of edited messages are not searched.

Results show role, time and a snippet around the first match with the match highlighted. Each result has a quote action (same as in the chat). Clicking a result scrolls to it if loaded in the chat; otherwise it expands to show the full message in the result list.

## Copy

New i18n keys in en / ja / zh, wording builder's call, matching existing tone: quote action, quote bar remove, edit action, save, cancel, "edited", version list title, search placeholder, no results, edit refused while processing.

## Constraints

- Code and comments in English; prompt text in Chinese like the rest of `prompt.ts`.
- No new dependencies. Plain Postgres `ILIKE`, no index (a workspace's message count is small).
- README and CHANGELOG updated per project rules.

## Decided by the user

- Quote and edit both ship; quoting is for continuing the conversation about any message, including agent conclusions.
- Agent messages are never edited.
- Editing a user message re-runs the agent automatically, and the agent cites the edited text.
- Search is plain keyword matching.

## Calls made in this design (not discussed)

- Edits keep versions instead of overwriting, to keep entry quotes valid.
- One quote per message; the excerpt is a snapshot, the prompt gets the full current text.
- System and report messages can be quoted.
- Edit refused while the message's task is queued or running.
- Edit task context uses the latest 20 messages; the agent's reply quotes the edited message.
- The edit prompt's old version is the immediately previous text; no tracking of which version the agent last processed.
- Snapshots carry versions; older snapshots import with no versions.
- No paging: jumping only works for messages already loaded (latest 200); search results show the full text otherwise.

## Left to the builder

Component structure, where the version list and search results are shown (popover, panel), snippet length, exact SSE handling for edits beyond `message.updated`, and how to find entries citing a message (scan the store list or add a helper).
