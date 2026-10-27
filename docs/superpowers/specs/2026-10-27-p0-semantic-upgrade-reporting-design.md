# P0 semantic acceptance, upgrade recovery, and reporting status

Date: 2026-10-27 (Asia/Tokyo)
Status: Approved by the task request on 2026-10-27; implementation follows this spec.
Baseline: main after PR #22 (`aa2accfaa84f45712947a89aa4aa302493816064` and later main).
Scope: ROADMAP P0-03, P0-04, and the remaining P0-05 channel check. P0-01 and P0-02 stay at their post-#22 status.

## Intent

Finish the P0 items left open by [the release-assurance review](../../reviews/2026-10-26-p0-release-assurance.md): real-model thread acceptance, desktop data upgrade and backup restore, and an honest read of private vulnerability reporting.

This environment can build the runners and can read GitHub settings. It cannot complete every acceptance itself. A missing credential, a Linux-only process, or a disabled admin setting is recorded as blocked. It is not a pass.

## P0-03: thread semantic acceptance

The conversations and expected results are the ones in [the thread acceptance script](../../reviews/2026-10-26-thread-agent-script.md). Codex direct and Claude are separate runs. A pass for one adapter does not cover the other.

The runner sends the scripted user messages through the hub and the real daemon adapter. It records the git commit, adapter, configured model (or provider default when unset), message ids, knowledge entries, and task progress text. Progress text is the tool trace the hub already emits (`调用 open_thread`, `mcp__room__open_thread`, and the other tool names).

Checks below are the original script. The amendment at the end of this document supersedes the shared workspace, the progress-text `open_thread` check, the casual-turn write rule, and the timeout classification.

1. Memo: the agent replies, and the knowledge entry list and git HEAD do not change.
2. Design chat: casual turns do not write knowledge. The trace includes `open_thread`. The deciding user message sits in an agent-opened thread. That turn adds exactly one decision, `basis: decided`, whose `sourceMessages` include that user message.
3. `/thread` brainstorm: the agent replies, and knowledge does not change.
4. Conflict: after the Redis decision, a second thread that says to use a local LRU does not add another active decision. Redis stays the only active decision. The agent asks a question in that second thread. The question `related` includes the Redis id, and a quote has that user message id and the exact user text.
5. Override: the follow-up names the Redis id. Redis becomes `superseded`. Exactly one decision stays active, with `basis: decided`, `LRU` in the title or body, and `sourceMessages` containing the override message.

Exit 0 is a pass for that adapter only. Exit 1 is a completed run that missed a check. Exit 2 is blocked: missing credentials, model connection failure, login rejection, or timeout. Exit 2 does not evaluate the rubric and is not a semantic failure of the model. The runner writes the JSON outside the repository and does not print credential contents or home paths.

No model credentials are available in this implementation environment. P0-03 stays 进行中 until both adapters have a recorded exit 0, with the JSON summary copied into the review. Deterministic rubric tests do not count as that run.

## P0-04: data-directory upgrade and backup restore

Desktop data lives in a home directory: `db/` (PGlite) and `data/repos/<workspace>` (knowledge Git). Startup applies pending SQL migrations. The published schema already includes threads (`011_threads.sql`). There is no newer product migration.

The harness builds a disposable home with the current schema and this data:

- a main-chat user message and agent reply
- a user-opened thread and a reply
- a requirement, a work package, and a decided decision, so the knowledge repository has more than one commit after `init`

It then:

1. Reopens the home and requires the same messages, thread, entries, and commit ids.
2. Applies one extra test-only migration (`workspaces.upgrade_probe`) and requires the same data plus that column. The extra file is not a product migration.
3. Takes a directory backup, runs a migration that fails SQL execution, and requires the failed name to be absent and the previous data to remain. It then deletes `db/` and `data/`, restores the backup, and requires the original snapshot.

Windows and macOS evidence is the platform job in `verify.yml` on `windows-latest` and `macos-latest`. A Linux run is useful and is not that evidence. P0-04 is 已完成 only after both hosted platform logs show this test passing, and the review links those runs.

Installing a new NSIS or DMG package over an older install is not this test. The README and guides keep the in-place installer warning. That overwrite check stays a manual handoff on a disposable machine.

## P0-05: private reporting status

The intended channel remains `https://github.com/Nema-Project/nema-room/security/advisories/new`. Public issue forms stay removed.

`GET /repos/Nema-Project/nema-room/private-vulnerability-reporting` is the status read. `enabled: false` means disabled. `enabled: true` means the setting is on and still does not prove a non-admin reporter can open the form. Any other result is unknown, not disabled. This batch does not call PUT, does not file an advisory, and does not invent a reporter account.

While the setting is disabled, SECURITY.md, the issue chooser, CONTRIBUTING, the four READMEs, and the three guides say the channel is off. They do not offer the advisory URL as a live form. P0-05 stays 阻塞 until an administrator enables the setting and a signed-in user who is not a repository admin opens the form without submitting it.

## Evidence and non-goals

Record results in `docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md` with commit SHAs, commands, and links. Do not rewrite the 2026-10-26 review as if it were this run.

Out of scope: release tags, GitHub releases, advisories, merges, ruleset changes, enabling private reporting, real-model runs without credentials, and NSIS/DMG overwrite. Do not claim those as done.

## Amendment: harness, prompt, and rubric after the scored runs

Recorded 2026-10-27 (Asia/Tokyo), after the maintainer Windows runs at `b158daf` (Codex 5/12, Claude 6/12, both exit 1). Line numbers in the task note refer to `17db281`. This amendment is the behavior to implement. It does not mark P0-03 已完成. Both adapters must be rerun twice on this behavior before that status can change.

The Claude score is void. `threadSemanticRun` called `startDaemon` without `cliEntry`, so `createRunner` fell back to `process.argv[1]` (the runner). Claude's `mcp.json` then started `node threadSemanticRun.js mcp`. That process entered `main()` and exited with `unsupported adapter: ""`. Claude had no room tools. A transcript from that launch is not a model result.

### Harness

- `createRunner` / `startDaemon` require `cliEntry`. A missing value throws. Production `nema daemon` passes the real CLI entry. The acceptance runner passes `apps/cli/dist/index.js`.
- Claude init passes only when the single MCP server is named `room` with status `connected`, and the tool list contains every `mcp__room__list_entries`, `mcp__room__read_entry`, `mcp__room__upsert_entry`, and `mcp__room__open_thread`. An empty tool list or a server that is not `connected` fails the task at once. The runner records that failure as blocked (exit 2), including after turns have started. Plugin tools that the task allowed may also be present. Any other tool still fails the task.
- `design-open-thread` reads the `threads` table. The design thread id is the first design user message ("给小工具加缓存"), and `opened_by` must be `agent`. Progress text is display only and is not a check. A thread with `opened_by` `grill` is recorded in the check detail and does not count as agent-opened.
- Memo, design, brainstorm, and conflict each use their own workspace. Override reuses the conflict workspace. That workspace is seeded with one active decision whose title and body contain `Redis` before any conflict turn. `redisId` is that decision only when it is the unique active decision matching `/Redis/`. The script does not ask the model to create the Redis decision.
- Each turn in the output JSON includes `task_changes` as `{ entry, kind, op }` and the thread's `opened_by` when the turn is in a thread, including `grill`. Rubric details name the entries that were added or updated.
- `design-one-decided` also requires `status` `active`.
- Override requires the single remaining active decision to include the Redis id in `related` (there is no separate supersede column), with Redis `superseded`.
- `classifyRunError` takes a phase. Preflight and the connection phase are blocked for connection, login, timeout, and credential failures. After the first turn starts, those words in a task error are a finished failure (exit 1), not blocked. The room tool-surface failure stays blocked in either phase.

### Prompt and tool text

- Main chat calls `open_thread` when the user asks to compare options or weigh tradeoffs and has not decided, then discusses inside the thread. The `open_thread` tool description says the same thing.
- A question-shaped idea (`你觉得…？`) or a request for pros and cons is not a statement and is not written. Only an explicit statement or an explicit decision is written. Saying to keep something in the discussion or the thread means do not write knowledge.
- While grill strictness is strict, comparing options or weighing tradeoffs before a decision does not create a new question entry. The discussion stays in the thread. That exception is part of the strictness line and does not remove the existing strictness sentence.

### Rubric and script line

- The brainstorm closing line does not tell the model to record the ideas. It is `这些先留在讨论里，暂不记录，之后再决定。` The no-write check stays.
- The first design turn may add or update requirement entries whose ids start with `R-`. It must not add or update `D-*` or `Q-*`. The second design turn, which asks a question, must not change knowledge.
- `design-one-decided` is exactly one added decision, `basis` `decided`, `status` `active`, and `sourceMessages` containing the deciding user message.
