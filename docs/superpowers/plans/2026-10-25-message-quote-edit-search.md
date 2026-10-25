# Message quote, edit and search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chat message quote any earlier message, let the user edit their own message (versions kept, agent re-runs on the new text), and let them find a message by keyword.

**Architecture:** The hub stays stateless per task. A quote is metadata on the new user message; the prompt inlines the quoted message's current full text, so the 20-message window does not apply. An edit stores the previous text in `message_versions`, updates `messages.content`, and queues a task of kind `edit` on the same message. Search is one `ILIKE` query.

**Tech Stack:** TypeScript, Hono, Postgres (PGlite in tests), Zod, React/Next.js, vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-message-quote-edit-search-design.md`

## Global Constraints

- Code, comments, and commit messages in English. Prompt text added to `prompt.ts` is Chinese, matching that file.
- No new dependencies. Search uses Postgres `ILIKE` with an explicit escape, no index.
- One quote per message. Excerpt is the first 200 Unicode code points (`Array.from`), stored at send time. The prompt loads the quoted message's current full content.
- Only `user` messages are editable. Agent, system, and report messages can be quoted and cannot be edited.
- An edit is refused while any task for that message id is `queued` or `running`, and in an archived workspace (409, same as posting).
- "旧版本" in an edit prompt is the text immediately before this edit (the highest `message_versions` row after the edit transaction has stored it). No "last successfully processed version".
- Snapshots gain `message_versions` and `messages.edited_at`. A snapshot that lacks the table still validates, with that table empty. A missing `edited_at` stays null.
- Deleting a workspace deletes its versions (`ON DELETE CASCADE`).
- i18n keys exist in `en.json`, `ja.json`, and `zh.json`.
- README.md, README.en.md, README.ja.md, and CHANGELOG.md (`## [Unreleased]` / `Added`) describe the user-visible behavior.

## File structure

- `apps/hub/src/db/migrations/010_message_versions.sql` — versions table, `edited_at`, task kind `edit`.
- `apps/hub/src/messages.ts` — quote on post, edit, versions, search, recent-message window.
- `apps/hub/src/prompt.ts` — quote section and edit section.
- `apps/hub/src/daemonSocket.ts` — pass quote / edit into the prompt; agent reply of an edit task carries the quote.
- `apps/hub/src/roomApi.ts` — entry quotes match current content or any stored version.
- `apps/hub/src/db/snapshot.ts` — optional `message_versions`, `edited_at` column.
- `apps/hub/src/tasks.ts` — `kind` includes `"edit"`.
- `packages/shared/src/workspace.ts` — `MessageQuote`, `UserMessageMeta`, optional `quote` on `AgentMessageMeta`.
- `packages/knowledge/src/store.ts` — `entriesCiting(messageId)`.
- `apps/web/lib/types.ts`, `apps/web/lib/hub.ts` — wire types and client calls.
- `apps/web/components/Chat.tsx`, `MessageItem.tsx`, `Composer.tsx`, `apps/web/app/globals.css` — quote, edit, search UI.
- Tests live next to the existing ones named in each task.

## Review Focus

These are the inputs most likely to be mishandled. Each has a test in the task that owns the code.

1. A `quoteMessageId` from another workspace must be 400 and must not copy that message's text. Task 2.
2. Editing a message whose task is still queued or running must be 409 and must leave `content` unchanged. Task 3.
3. A search query containing `%` or `_` must match those characters literally, not as wildcards. Task 5.
4. An entry quote that appears only in a stored version is accepted; a quote that appears in neither the current text nor any version is 400. Task 4.
5. After an edit task fails, a second edit's prompt "旧版本" is the middle text, not the original. Task 4.

---

### Task 1: Schema, shared quote types, snapshot compatibility

**Files:**
- Create: `apps/hub/src/db/migrations/010_message_versions.sql`
- Modify: `apps/hub/src/tasks.ts` (`Task["kind"]`)
- Modify: `apps/hub/src/messages.ts` (`Message`, `toMessage`, `COLS`)
- Modify: `packages/shared/src/workspace.ts`
- Modify: `apps/hub/src/db/snapshot.ts`
- Test: `apps/hub/test/tasks.test.ts`
- Test: `apps/local/test/migration.test.ts`
- Test: `packages/shared/test/entry.test.ts`
- Modify: `apps/hub/test/prompt.test.ts` (the `msg` helper only, so the new required field typechecks)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Task["kind"]` = `"organize" | "workpackage" | "edit"`
  - `Message.editedAt: string | null` (ISO). `meta` still `AgentMessageMeta | ReportMessageMeta | null` until Task 2.
  - `MessageQuote` = `{ messageId: string; role: "user" | "agent" | "system" | "report"; excerpt: string }`
  - `UserMessageMeta` = `{ quote?: MessageQuote }`
  - `AgentMessageMeta` gains optional `quote: MessageQuote`
  - `validateSnapshot` treats a missing `message_versions` key as `[]`

- [ ] **Step 1: Write the failing tests**

In `apps/hub/test/tasks.test.ts`, import `insertQueuedTask` and add:

```ts
test("a queued edit task is allowed", async () => {
  const { message } = await postUserMessage(db, wsA, "memo");
  const task = await insertQueuedTask(db, wsA, message.id, "edit");
  expect(task.kind).toBe("edit");
  expect((await listMessages(db, wsA))[0]!.editedAt).toBeNull();
});
```

In `apps/local/test/migration.test.ts` add:

```ts
it("accepts a snapshot from before message versions", () => {
  expect(validateSnapshot(empty).tableData.message_versions).toEqual([]);
});

it("rejects a version that cites an unknown message", () => {
  const ws = { id: "ws_abc", name: "A", confidential: true, knowledge_language: "follow" };
  const withVersion = {
    ...empty,
    tableData: {
      ...empty.tableData,
      workspaces: [ws],
      messages: [{ id: "m1", workspace_id: "ws_abc", role: "user", content: "now" }],
      message_versions: [{ message_id: "m_missing", version: 1, content: "old" }],
    },
  };
  expect(() => validateSnapshot(withVersion)).toThrow(/message/i);
});
```

Do not add `message_versions` to the `empty` fixture. In `packages/shared/test/entry.test.ts`, extend the `AgentMessageMeta` test so a meta with `quote: { messageId: "m_1", role: "user", excerpt: "hi" }` parses, and a meta without `quote` still parses.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/hub/test/tasks.test.ts apps/local/test/migration.test.ts packages/shared/test/entry.test.ts`

Expected: FAIL. `insertQueuedTask` rejects `"edit"` (type and/or check constraint). `message_versions` is missing from the snapshot. `AgentMessageMeta` strips or rejects `quote`.

- [ ] **Step 3: Implement the migration, types, and snapshot exception**

`010_message_versions.sql`:

```sql
create table message_versions (
  message_id text not null references messages(id) on delete cascade,
  version integer not null,
  content text not null,
  created_at timestamptz not null default now(),
  primary key (message_id, version)
);
alter table messages add column edited_at timestamptz;
alter table tasks drop constraint tasks_kind_check;
alter table tasks add constraint tasks_kind_check check (kind in ('organize', 'workpackage', 'edit'));
```

`Message.editedAt` is `string | null`. Add `edited_at` to `COLS` and `toMessage` (`edited_at` null → `null`, otherwise `toISOString()`). Every object literal that builds a `Message` in tests gets `editedAt: null` where TypeScript requires it (`prompt.test.ts` `msg`).

In `workspace.ts`, add `MessageQuote` and `UserMessageMeta` as zod objects and inferred types. Add `quote: MessageQuote.optional()` to `AgentMessageMeta`.

In `snapshot.ts`, add `message_versions: ["message_id", "version", "content", "created_at"]` and `"edited_at"` on `messages`. A missing `message_versions` key is `[]`; any other missing table is still an error; an unknown table is still an error. A `message_versions` row whose `message_id` is not in the snapshot's message ids throws the existing missing-message error. `edited_at` absent on a row stays valid (unknown columns are already rejected; missing columns are already allowed).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/hub/test/tasks.test.ts apps/local/test/migration.test.ts packages/shared/test/entry.test.ts apps/hub/test/prompt.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/db/migrations/010_message_versions.sql apps/hub/src/tasks.ts apps/hub/src/messages.ts apps/hub/src/db/snapshot.ts packages/shared/src/workspace.ts packages/shared/test/entry.test.ts apps/hub/test/tasks.test.ts apps/hub/test/prompt.test.ts apps/local/test/migration.test.ts
git commit -m "feat: store message versions and allow edit tasks"
```

---

### Task 2: Quote a message

**Files:**
- Modify: `apps/hub/src/messages.ts`
- Modify: `apps/hub/src/uiApi.ts` (`PostMessageBody`, `POST /workspaces/:id/messages`)
- Modify: `apps/hub/src/prompt.ts`
- Modify: `apps/hub/src/daemonSocket.ts` (`buildTaskPrompt`)
- Test: `apps/hub/test/uiApi.test.ts`
- Test: `apps/hub/test/prompt.test.ts`

**Interfaces:**
- Consumes: `MessageQuote`, `UserMessageMeta` from Task 1.
- Produces:
  - `messageExcerpt(content: string, max = 200): string` — first `max` code points.
  - `postUserMessage(db, workspaceId, content, quoteMessageId?: string)` — same return. When `quoteMessageId` is set, `message.meta` is `UserMessageMeta` with `quote`.
  - `MessageOpError` with `status: 400 | 404 | 409`. Message text for a bad quote: `"quote: message not in this workspace"`.
  - `Message.meta` includes `UserMessageMeta`.
  - `buildPrompt` input gains `quotedMessage?: Message | null`. The section below is inserted immediately before the current-message section.

- [ ] **Step 1: Write the failing tests**

In `uiApi.test.ts`, next to the existing post-message test:

```ts
test("a quote must be a message in this workspace", async () => {
  const first = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "alpha beta" }));
  const other = await json(await req("POST", "/api/workspaces", { name: "B" }));
  const foreign = await json(await req("POST", `/api/workspaces/${other.id}/messages`, { content: "secret" }));
  const bad = await req("POST", `/api/workspaces/${ws}/messages`, { content: "about it", quoteMessageId: foreign.message.id });
  expect(bad.status).toBe(400);
  expect((await json(bad)).error).toBe("quote: message not in this workspace");
  const ok = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "about it", quoteMessageId: first.message.id }));
  expect(ok.message.meta.quote).toEqual({ messageId: first.message.id, role: "user", excerpt: "alpha beta" });
});
```

Add one assertion that quoting `"你".repeat(250)` stores an excerpt of length 200. Also `addMessage` a system message in this workspace and quote it: the stored `quote.role` is `"system"`. A quote of an agent, system, or report message is allowed.

In `prompt.test.ts`:

```ts
test("a quoted message is inlined in full before the current message", () => {
  const quoted = msg(7, "agent");
  quoted.content = "结论是更新代码图";
  const p = buildPrompt({ workspace: ws("follow"), userMessage: msg(999), recentMessages: [], entries, lastAskedQuestion: null, quotedMessage: quoted });
  const section = ["# 本次消息引用的消息", "[m_7] agent: 结论是更新代码图", "本次用户消息是针对这条消息的补充、更正或确认。"].join("\n");
  expect(p).toContain(section);
  expect(p.indexOf(section)).toBeLessThan(p.indexOf("# 本次用户消息"));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/hub/test/uiApi.test.ts apps/hub/test/prompt.test.ts`

Expected: FAIL. `quoteMessageId` is ignored or rejected by the body schema. `buildPrompt` has no `quotedMessage`.

- [ ] **Step 3: Implement quote storage and the prompt section**

`PostMessageBody` gains optional `quoteMessageId: z.string().min(1).optional()`. `postUserMessage` loads that message; if it is missing or its `workspaceId` differs, throw `MessageOpError(400, "quote: message not in this workspace")`. Store `meta: { quote: { messageId, role, excerpt: messageExcerpt(content) } }`. The route maps `MessageOpError` to `HttpError`.

`buildTaskPrompt` reads `userMessage.meta`. When it is a `UserMessageMeta` with `quote`, `getMessage` that id and pass it as `quotedMessage`. If the row is gone, omit the section.

`buildPrompt` prints the section from the spec, role and full `content`, immediately before `# 本次用户消息` / `# 本次系统请求`. A quoted message that is also in the recent list may appear twice.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/hub/test/uiApi.test.ts apps/hub/test/prompt.test.ts`

Expected: PASS. This covers Review Focus 1.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/messages.ts apps/hub/src/uiApi.ts apps/hub/src/prompt.ts apps/hub/src/daemonSocket.ts apps/hub/test/uiApi.test.ts apps/hub/test/prompt.test.ts
git commit -m "feat: quote an earlier message in the next turn"
```

---

### Task 3: Edit a user message

**Files:**
- Modify: `apps/hub/src/messages.ts`
- Modify: `apps/hub/src/uiApi.ts`
- Test: `apps/hub/test/uiApi.test.ts`

**Interfaces:**
- Consumes: `insertQueuedTask(..., "edit")`, `MessageOpError`, `ArchivedWorkspaceError`.
- Produces:
  - `EDIT_BUSY_MESSAGE = "message is still being processed"`
  - `editUserMessage(db, workspaceId, messageId, content): Promise<{ message: Message; task: Task }>`
  - `listMessageVersions(db, messageId): Promise<{ version: number; content: string; createdAt: string }[]>` oldest first, not including the current text.
  - `PATCH /api/workspaces/:id/messages/:messageId` body `{ content }`, response `{ message, task }`, emits `message.updated` then `task.updated`.
  - `GET /api/workspaces/:id/messages/:messageId/versions`

- [ ] **Step 1: Write the failing tests**

In `uiApi.test.ts`:

```ts
test("editing keeps the previous text, queues an edit task, and blocks while that task is open", async () => {
  const posted = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content: "original" }));
  const id = posted.message.id;
  // The original task is still queued.
  const busy = await req("PATCH", `/api/workspaces/${ws}/messages/${id}`, { content: "revised" });
  expect(busy.status).toBe(409);
  expect((await json(busy)).error).toBe("message is still being processed");
  expect((await json(await req("GET", `/api/workspaces/${ws}/messages`))).find((m: { id: string }) => m.id === id).content).toBe("original");
});
```

Finish that task the way other tests in this file finish tasks (`claimNextTask` + `finishTask`), then:

- PATCH to `"revised"` returns 200, `message.content === "revised"`, `message.editedAt` is a string, `task.kind` is not on the UI task, `task.status === "queued"`.
- GET versions returns `[{ version: 1, content: "original" }]`.
- Finish the edit task, PATCH to `"third"`. Versions are `original` then `revised`, in that order.
- PATCH of an agent message (insert one with `addMessage`) is 400, error `"only user messages can be edited"`.
- PATCH in an archived workspace is 409 with `ARCHIVED_MESSAGE`.
- Events for a successful edit are `message.updated` then `task.updated`.
- `deleteWorkspace` after an edit leaves no `message_versions` rows for that message (the workspace delete already removes messages; assert the versions query is empty).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/hub/test/uiApi.test.ts`

Expected: FAIL with 404 on PATCH.

- [ ] **Step 3: Implement `editUserMessage` and the routes**

In one transaction: lock the message row. 404 if it is not in the workspace. `MessageOpError(400, "only user messages can be edited")` if the role is not `user`. `ArchivedWorkspaceError` if the workspace is archived. `MessageOpError(409, EDIT_BUSY_MESSAGE)` if any task with this `message_id` is `queued` or `running`. Reject empty/whitespace content the same way as `postUserMessage`.

Insert one `message_versions` row: `version` is `max(version)+1` or `1`, `content` is the current `messages.content`, `created_at` is `coalesce(edited_at, created_at)` of that message. Then set `content` to the new text and `edited_at` to `clock_timestamp()`, and `insertQueuedTask(..., "edit")`.

Register `GET .../messages/:messageId/versions` and `PATCH .../messages/:messageId` next to the existing messages route. Versions 404 when the message is not in the workspace. Map `MessageOpError` and `ArchivedWorkspaceError` to `HttpError`.

`deleteWorkspace` needs no new statement: `ON DELETE CASCADE` removes versions. The test is what proves it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/hub/test/uiApi.test.ts`

Expected: PASS. This covers Review Focus 2.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/messages.ts apps/hub/src/uiApi.ts apps/hub/test/uiApi.test.ts
git commit -m "feat: edit a user message and keep the previous text"
```

---

### Task 4: Edit prompt, agent reply quote, version-aware entry quotes

**Files:**
- Modify: `apps/hub/src/prompt.ts`
- Modify: `apps/hub/src/messages.ts` (`listRecentMessages`)
- Modify: `apps/hub/src/daemonSocket.ts`
- Modify: `packages/knowledge/src/store.ts`
- Modify: `apps/hub/src/roomApi.ts`
- Test: `apps/hub/test/prompt.test.ts`
- Test: `apps/hub/test/daemonSocket.test.ts`
- Test: `apps/hub/test/roomApi.test.ts`
- Test: `packages/knowledge/test/store.test.ts`

**Interfaces:**
- Consumes: `editUserMessage`, `listMessageVersions`, `MessageQuote`, `entries` index line format already in `prompt.ts`.
- Produces:
  - `listRecentMessages(db, workspaceId, excludeId, limit = 20): Promise<Message[]>` — latest `limit`, oldest first, excluding that id, including later user messages.
  - `KnowledgeStore.entriesCiting(messageId: string): Promise<EntrySummary[]>` — entries whose `sourceMessages` contain that id, same order as `list()`.
  - `buildPrompt` input gains `edit?: { previousContent: string; cited: EntrySummary[] } | null`.
  - On a successful `edit` task, the agent message `meta.quote` points at the edited message. A failed edit task stays a system message with no quote.

- [ ] **Step 1: Write the failing tests**

`prompt.test.ts`: with `edit: { previousContent: "original", cited: entries.slice(0, 1) }` and `userMessage` content `"revised"`, the prompt contains, before `# 本次用户消息`:

```text
# 用户修改了一条消息
[m_999] 旧版本：original
[m_999] 新版本：revised
# 之前依据这条消息写入的条目
R-1 | requirement | active | 流式输出
按新版本更新或作废这些条目；新写入或更新的条目在 sourceMessages 中包含 m_999，quotes 从新版本逐字复制。
```

A second case with `cited: []` contains `（无）` and does not contain an entry line. When both `edit` and `quotedMessage` are set, the edit section comes first, then the quote section, then the current message.

`store.test.ts`: an entry saved with `sourceMessages: [messageId]` is returned by `entriesCiting`; another entry is not.

`roomApi.test.ts`, beside the verbatim-quote test. Use `runningTaskFor` and `upsert` as that test does. Post a user message `"current text"`, insert `message_versions` `(version 1, content "the old wording")` with SQL, then:

- a quote `text: "old wording"` on that message id returns 200;
- a quote `text: "current text"` returns 200;
- a quote `text: "never written"` returns 400 and `quotes: text must be copied verbatim from message <id>`.

`daemonSocket.test.ts`, using the existing daemon client and `task.assign` flow:

- Post `"original"`, claim and finish that task.
- `addMessage` an agent message whose `meta.askedQuestion` is `{ id: "Q-1", title: "进度", body: "到哪了" }`.
- Upsert one entry with `sourceMessages` containing the user message id (so the prompt has a cited line).
- Edit the user message to `"middle"`. Finish that edit task with `{ ok: false, error: "boom" }`. The system message has no `quote`.
- Edit again to `"latest"`. The assigned prompt contains `[<id>] 旧版本：middle` and `[<id>] 新版本：latest`, contains the cited entry id, and does not contain `上一个追问`.
- Before the first edit, post a user message `"later note"` and finish its task. The edit prompt contains `later note` (later user messages stay in the window) and does not contain `上一个追问`.
- Finish the second edit `{ ok: true, reply: "updated" }`. The agent message `meta.quote.messageId` is the edited message and `meta.quote.excerpt` is `messageExcerpt("latest")`.
- Separate case for a quote's current text: post `"first wording"`, finish it, edit it to `"rewritten wording"`, finish that edit task, then post a message that quotes it. That message's assign prompt contains `rewritten wording` under `# 本次消息引用的消息`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/hub/test/prompt.test.ts apps/hub/test/roomApi.test.ts apps/hub/test/daemonSocket.test.ts packages/knowledge/test/store.test.ts`

Expected: FAIL. `buildPrompt` ignores `edit`. Quotes of old text are 400. `entriesCiting` is missing. The edit assign prompt has no `旧版本`.

- [ ] **Step 3: Implement the edit prompt, the reply quote, and version-aware quotes**

`entriesCiting` filters `readAll()` with `sourceMessages.includes(messageId)` and returns `summarize` of those, ordered like `list()`.

`listRecentMessages` is `listPromptMessages` without the "drop later user messages" predicate.

For `task.kind === "edit"`, `buildTaskPrompt` uses `listRecentMessages`, passes `lastAskedQuestion: null`, sets `edit.previousContent` from the highest version row, and sets `edit.cited` from `entriesCiting`. The current-message section still prints `userMessage.content` (the new text).

`buildPrompt` prints the edit section from the spec. Cited lines use the existing index-line format. Empty cited prints `（无）`. Order before the current message: edit section, then quote section.

In `roomApi.ts`, a quote matches when `message.content.includes(quote.text)` or any `message_versions.content` for that id includes it. Still an exact substring. Load the versions for the cited message ids in one query.

In `onFinished`, when `m.ok` and `getTask` says `kind === "edit"`, set `meta.quote` from the edited message (`getMessage(task.messageId)`) using `messageExcerpt`. Do this only for the agent message, not the failure system message.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/hub/test/prompt.test.ts apps/hub/test/roomApi.test.ts apps/hub/test/daemonSocket.test.ts packages/knowledge/test/store.test.ts`

Expected: PASS. This covers Review Focus 4 and 5.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/prompt.ts apps/hub/src/messages.ts apps/hub/src/daemonSocket.ts apps/hub/src/roomApi.ts packages/knowledge/src/store.ts apps/hub/test/prompt.test.ts apps/hub/test/daemonSocket.test.ts apps/hub/test/roomApi.test.ts packages/knowledge/test/store.test.ts
git commit -m "feat: re-run the agent on an edited message"
```

---

### Task 5: Keyword search

**Files:**
- Modify: `apps/hub/src/messages.ts`
- Modify: `apps/hub/src/uiApi.ts`
- Test: `apps/hub/test/uiApi.test.ts`

**Interfaces:**
- Consumes: `Message`.
- Produces: `searchMessages(db, workspaceId, q: string): Promise<Message[]>` and `GET /api/workspaces/:id/messages/search?q=`.

- [ ] **Step 1: Write the failing test**

```ts
test("search matches the current text only, literally, newest first", async () => {
  const post = async (content: string) => {
    const created = await json(await req("POST", `/api/workspaces/${ws}/messages`, { content }));
    const task = (await claimNextTask(db, "d1"))!;
    await finishTask(db, task.id, { ok: true });
    return created.message.id as string;
  };
  const a = await post("100% done");
  const b = await post("100% done too");
  const renamed = await post("100% later");
  expect((await req("PATCH", `/api/workspaces/${ws}/messages/${renamed}`, { content: "renamed" })).status).toBe(200);
  const ids = async (q: string) =>
    (await json(await req("GET", `/api/workspaces/${ws}/messages/search?q=${encodeURIComponent(q)}`))).map((m: { id: string }) => m.id);
  expect(await ids("100%")).toEqual([b, a]);
  expect(await ids("%")).toEqual([b, a]);
  expect(await ids("_")).toEqual([]);
  expect(await ids(" ")).toEqual([]);
});
```

`%` and `_` are literal characters. `"100% later"` was edited to `"renamed"`, so it matches neither query. Blank `q` returns `[]`. `claimNextTask` is already imported in this file.

Register the route so `/messages/search` is not captured as a message id.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/hub/test/uiApi.test.ts`

Expected: FAIL with 404.

- [ ] **Step 3: Implement `searchMessages`**

Trim `q`. Empty result when the trim is empty. Otherwise `content ILIKE $pattern ESCAPE '\'` where the pattern is `'%' + q.trim().replace(/[\\%_]/g, (c) => '\\' + c) + '%'`, `workspace_id = $1`, `order by seq desc limit 50`. Return `Message[]` newest first. Do not search `message_versions`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/hub/test/uiApi.test.ts`

Expected: PASS. This covers Review Focus 3.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/messages.ts apps/hub/src/uiApi.ts apps/hub/test/uiApi.test.ts
git commit -m "feat: search messages in a workspace by keyword"
```

---

### Task 6: Chat UI for quote, edit, and search

**Files:**
- Modify: `apps/web/lib/types.ts`
- Modify: `apps/web/lib/hub.ts`
- Modify: `apps/web/components/Chat.tsx`
- Modify: `apps/web/components/MessageItem.tsx`
- Modify: `apps/web/components/Composer.tsx`
- Modify: `apps/web/app/globals.css`
- Modify: `apps/web/messages/en.json`, `ja.json`, `zh.json`
- Modify: `apps/web/test/Chat.test.tsx`
- Modify: `README.md`, `README.en.md`, `README.ja.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: the HTTP shapes from Tasks 2, 3, and 5.
- Produces: the chat behavior below. No new exports the hub depends on.

- [ ] **Step 1: Write the failing UI test**

Extend `m()` in `Chat.test.tsx` with `editedAt: null`. Mock `editMessage`, `listMessageVersions`, and `searchMessages` on `@/lib/hub`.

```ts
it("quotes a message, edits it, and searches", async () => {
  vi.mocked(hub.postMessage).mockResolvedValue({ message: m("n", "about it"), task: { id: "t", workspaceId: "w1", messageId: "n", status: "queued", error: null } });
  await mount(true);
  await userEvent.click(screen.getByRole("button", { name: "引用" }));
  expect(screen.getByRole("button", { name: "取消引用" })).toBeTruthy();
  await userEvent.type(screen.getByPlaceholderText("随手扔点什么… 会议速记、和 PdM 的聊天、需求变更、链接都可以"), "about it");
  await userEvent.click(screen.getByRole("button", { name: "发送 ⇧↵" }));
  expect(hub.postMessage).toHaveBeenCalledWith("w1", "about it", "a");
});
```

The send button's accessible name is `发送 ⇧↵` (`composer.send`). The composer placeholder is `随手扔点什么… 会议速记、和 PdM 的聊天、需求变更、链接都可以`. Use that placeholder, not `getByRole("textbox")`: the search box is a second textbox. Assert the quote bar can be removed (`取消引用`) and the next send then calls `postMessage` with two arguments.

Second case: a user message with `editedAt` set shows a button named `已编辑`. Clicking it calls `listMessageVersions` and renders the returned content. The edit button saves via `editMessage("w1", "a", "revised")`. A 409 `HubError` whose message is `message is still being processed` shows the zh string `这条消息还在处理，暂时不能编辑`.

Third case: typing `进度` into the search box and pressing Enter calls `searchMessages("w1", "进度")` and renders the result content. Pressing the result's quote button arms the same quote bar.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/Chat.test.tsx`

Expected: FAIL. The quote button is missing.

- [ ] **Step 3: Implement the UI**

Wire types: `Message.editedAt: string | null`, `Message.meta` adds `UserMessageMeta`. Re-export `MessageQuote` and `UserMessageMeta`. `Task` stays without `kind`.

Client:

```ts
postMessage(id: string, content: string, quoteMessageId?: string)
editMessage(id: string, messageId: string, content: string): Promise<{ message: Message; task: Task }>
listMessageVersions(id: string, messageId: string): Promise<{ version: number; content: string; createdAt: string }[]>
searchMessages(id: string, q: string): Promise<Message[]>
```

`postMessage` sends `quoteMessageId` only when it is a non-empty string.

Copy, same keys in en / ja / zh:

| key | en | ja | zh |
|---|---|---|---|
| `chat.quote` | Quote | 引用 | 引用 |
| `chat.quoteRemove` | Remove quote | 引用を外す | 取消引用 |
| `chat.edit` | Edit | 編集 | 编辑 |
| `chat.save` | Save | 保存 | 保存 |
| `chat.cancel` | Cancel | キャンセル | 取消 |
| `chat.edited` | Edited | 編集済み | 已编辑 |
| `chat.versions` | Earlier versions | 以前の版 | 更早的版本 |
| `chat.search` | Search messages | メッセージを検索 | 搜索消息 |
| `chat.noResults` | No matching messages | 一致するメッセージはありません | 没有匹配的消息 |
| `chat.editBusy` | This message is still being processed | このメッセージは処理中のため編集できません | 这条消息还在处理，暂时不能编辑 |
| `chat.role.system` | System | システム | 系统 |
| `chat.role.report` | Report | 報告 | 上报 |

Every message gets a quote button (`chat.quote`). Only a user message gets an edit button (`chat.edit`). Chat holds `quote: Message | null`. The composer shows a bar: the role label for `quote.role` (`chat.you`, `Nema`, `chat.role.system`, `chat.role.report`), the first 200 code points of `quote.content`, and `chat.quoteRemove`. Sending calls `postMessage(workspaceId, content, quote.id)` and clears the quote. The answer box calls `send(content)` with no quote id.

A sent user message with `meta.quote` renders a block (role + excerpt) above its text. Clicking the block calls the existing `scrollToMessage`. An agent message with `meta.quote` renders the same block. If the target node is not in the document, the click does nothing.

Edit replaces the user body with a textarea seeded with `content`, plus save and cancel. Save calls `editMessage`. On success, replace that message in state (do not wait for SSE). On `HubError` 409 with message `message is still being processed`, show `chat.editBusy`. Cancel restores the body.

`editedAt != null` shows a `chat.edited` button. Clicking it loads versions once and toggles a list titled `chat.versions`.

A search box sits above the stream, placeholder `chat.search`. Enter searches; empty input shows nothing. Results list under the box: role, time, and a snippet of 40 characters before the first case-insensitive match through 40 after, with the match in `<mark>`. Clicking the row calls `scrollToMessage`; if that id is not in the document, the row expands to the full `content`. Each result has a quote button that sets the same quote state. No matches shows `chat.noResults`.

Styles go in `globals.css` next to `.memo`, using `--ink`, `--paper-2`, and `--ink-2` only.

README step 1 (讨论 / From discussion to delivery / 議論から実装まで) gains one sentence: you can quote any message, edit your own (the previous text is kept and the agent re-runs), and search the workspace by keyword. CHANGELOG `Added` gets the same fact in English.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/web/test/Chat.test.tsx apps/web/test/MessageItem.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web README.md README.en.md README.ja.md CHANGELOG.md
git commit -m "feat: quote, edit, and search messages in the chat"
```

---

### Task 7: Verify the branch

**Files:** none new.

- [ ] **Step 1: Run the full check**

Run: `npm test` then `npm run typecheck`

Expected: both exit 0. Fix failures that this work caused. Do not edit unrelated failures if they already fail on the parent commit; report those instead.

- [ ] **Step 2: Browser check of the chat**

With the app running, quote a message and send, edit your own message and see "已编辑" plus the old text, and search a word that exists only in an older message (it must not match) and a word in a current message (it must match and the quote button must arm the composer). If the app is not already running, say so and do not start a second stack blindly.

- [ ] **Step 3: No commit** unless Step 1 required a fix. Commit only that fix.
