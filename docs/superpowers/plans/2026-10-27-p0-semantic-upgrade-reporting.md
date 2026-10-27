# P0 Semantic Acceptance, Upgrade Recovery, and Reporting Status Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land honest runners for P0-03 and P0-04, and record the real P0-05 private-reporting read without enabling it.

**Architecture:** A pure rubric scores scripted transcripts. A separate runner drives the hub and daemon only when credentials exist. Upgrade and restore run against a disposable PGlite home in Vitest, including the Windows and macOS platform job. Reporting status is a read-only `gh` command plus a pure interpreter.

**Tech Stack:** Node.js 22, npm workspaces, Vitest, node:test, PGlite, Git, GitHub Actions, `gh`.

**Spec:** [Approved design](../specs/2026-10-27-p0-semantic-upgrade-reporting-design.md).

## Global Constraints

- Do not mark P0-03 passed from rubric unit tests. Codex direct and Claude each need their own real run.
- Do not mark P0-04 passed from a Linux-only run. Windows and macOS platform logs are required. Installer overwrite stays manual.
- Do not PUT private vulnerability reporting, file an advisory, create a tag, publish a release, or merge.
- Keep README.md and README.en.md byte-identical.
- Keep credential material out of logs, fixtures, and commits. Acceptance JSON is written outside the repository.
- Commits may use the Cursor Agent service account. Do not attribute commits to idom-fcui.
- Do not post issue or PR review comments from the agent. Handoff text belongs in the review and the final report.

### Task 1: semantic rubric and credential preflight

**Files:** `apps/local/src/semanticAcceptance.ts`, `apps/local/test/semanticAcceptance.test.ts`

- [ ] Write failing Vitest cases for the five script checks, a transcript that passes, credential preflight (missing file, directory, symlink, unsupported adapter), and blocked-versus-failed error classification.
- [ ] Implement the pure functions. Re-run `npx vitest run apps/local/test/semanticAcceptance.test.ts`.

### Task 2: real-model runner

**Files:** `apps/local/test/threadSemanticRun.ts`, `scripts/acceptance/run-thread-semantic.mjs`

- [ ] Drive the acceptance script through `startHub` and `startDaemon` for `codex-direct` (Codex compat `auth.json`) and `claude-code` (token file copied into a disposable home with the existing saver).
- [ ] Exit 2 before rubric evaluation when preflight or the model connection fails. Exit 1 when every turn finished and a check failed. Exit 0 only when every check passed.
- [ ] Add a Vitest spawn that points `CODEX_HOME` at an empty directory and expects exit 2 with `semantic: "not-run"`. It must not read a real login.

### Task 3: upgrade and backup restore

**Files:** `apps/hub/test/upgradeRecoveryHarness.ts`, `apps/hub/test/upgradeRecovery.test.ts`, `.github/workflows/verify.yml`, `scripts/ci/workflows.test.mjs`

- [ ] Seed chats, a thread, a work package, and knowledge history. Reopen, apply a disposable pending migration, fail a migration, delete the data directory, and restore the backup.
- [ ] Run the Vitest file from the existing Windows and macOS platform job. Assert that wiring in the parsed workflow test.
- [ ] Re-run the Vitest file locally. Local success is not Windows or macOS evidence.

### Task 4: reporting read and honest docs

**Files:** `scripts/security/reporting-status.mjs`, `scripts/security/reporting-status.test.mjs`, SECURITY.md, CONTRIBUTING.md, four READMEs, three guides, issue chooser, CHANGELOG.md, ROADMAP.md, `scripts/desktop/RELEASE.md`

- [ ] Interpret HTTP 200 `{enabled: boolean}` and treat every other response as unknown. The CLI only calls GET.
- [ ] Record the live GET. If it is disabled, say so in the translated security guidance. Do not link the advisory form as a working channel.
- [ ] Remove the blank line that splits the ROADMAP execution-log table. Append a new log row. Leave P0-03/P0-04/P0-05 statuses at the evidence actually in hand.

### Task 5: review record

**Files:** `docs/reviews/2026-10-27-p0-semantic-upgrade-reporting.md`

- [ ] Write commands, local results, the reporting GET, and the maintainer handoff. Link platform runs only after they exist. Do not edit the 2026-10-26 review into this result.

## Self-review

- Spec coverage: rubric and blocked runs → Tasks 1–2; data upgrade and OS split → Task 3; disabled channel → Task 4; evidence → Task 5.
- No task enables repository settings or calls a model.
- Installer overwrite and non-admin form access stay manual when this environment cannot do them.

## Follow-up: scored-run harness fix

The amendment in `docs/superpowers/specs/2026-10-27-p0-semantic-upgrade-reporting-design.md` is the source for this follow-up. P0-03 stays 进行中. Do not merge and do not post a GitHub comment.

- [x] Require `cliEntry` in `createRunner`. Pass `apps/cli/dist/index.js` from the acceptance runner and the real CLI entry from `nema daemon`.
- [x] Fail a Claude task unless the room server is `connected` and all four `mcp__room__*` tools are listed. Cover a failed server in the adapter test.
- [x] Score `design-open-thread` from the threads table (`opened_by` `agent` and the anchor message id). Keep SSE text for display. Use a separate workspace for memo, design, brainstorm, and conflict. Seed one active Redis decision in the conflict workspace and resolve its id with the unique `/Redis/` match.
- [x] Record each turn's `task_changes` and `opened_by`. Allow `R-*` on the first design turn, forbid `D-*` and `Q-*`, require the decided entry to be `active`, and require the override decision's `related` to include the Redis id. Classify tool-surface failures as blocked. Classify timeout and credential text as blocked only before turns start.
- [x] State the compare-options `open_thread` trigger in the prompt and the tool description. Question-shaped ideas and "keep it in the discussion" do not write knowledge. Strict grill does not create a question entry for an undecided comparison.
- [x] Change the brainstorm closing line so it does not ask the model to record the ideas. A `grill` thread is recorded and is not an agent-opened thread.
- [x] Update the 2026-10-27 review with the redacted Windows run, the void Claude score, the fix, and the two-runs-per-adapter handoff. Add unit tests for the required CLI entry, the failed room server, the threads-table check, independent workspaces, and the new rubric clauses.
