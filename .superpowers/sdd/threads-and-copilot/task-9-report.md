# Task 9 report: conflict regression and thread documentation

## Changes

- Added `apps/hub/test/threadConflict.test.ts` with two real daemon-socket harness cases. The first creates a Redis decision in thread A, confirms an agent-only rewrite in B gets 409, then records a quoted/related question and verifies the B task's agent reply carries that question in thread B while D-1 stays active. The second confirms a user-cited explicit supersession is accepted.
- Added `docs/reviews/2026-10-26-thread-agent-script.md` with the four real-agent conversations, expected entry/message/tool-trace evidence, and the actual runtime blocker below.
- Updated the Chinese, English, and Japanese READMEs and Unreleased changelog for threads, `/thread`, separate windows, unread attention badge, entry withdrawal, copilot behavior, and removal of the main-chat follow-up answer box.
- Completed the `openThread` member on two CLI `RoomApi` test fakes so the requested CLI test typecheck reflects the current tool interface; focused direct-tools tests remain green.

## Focused test and debugging record

`umask 022 && npx vitest run --project @nema/hub threadConflict` passes: 1 file, 2 tests. The regression uses `attachDaemonSocket`, the room API, task tokens, and the daemon `task.finished` message; it does not assert semantic model behavior.

Initial harness attempts timed out because direct `postUserMessage` calls do not emit the `task.updated` event normally emitted by the UI route. The harness now emits that event. A later assertion selected the earlier completed Thread B anchor reply and saw `askedQuestion: null`; matching the message by the B conflict task ID selects the intended reply and confirms its question metadata. No product regression was found and no assertion was weakened.

`umask 022 && npx vitest run --project @nema/cli direct/tools` passes: 1 file, 4 tests.

## Real-agent acceptance attempt

The disposable current runner/hub attempt used `codex-direct / compat`; configuration was written only under a temporary Nema home and read the configured Codex home without modifying it. No model was configured, so provider-default model selection was attempted. User message `m_PJgemD9WfTA-` in disposable workspace `ws_LVwlKi1CNWZN` created task `t_qpvJrdiUCaFB`. The task failed before an agent reply with `模型接口错误：无法连接模型接口（EAI_AGAIN）`. There was no agent message, no knowledge entry, and no tool call. The acceptance scenarios are therefore **not run**; deterministic routing coverage is not semantic acceptance.

## Final checks

- Root typecheck: PASS (`npm run typecheck`; `tsc -b`), log: `artifacts/root-typecheck.log`.
- Full suite: pending; required reaper command and log path: `python .superpowers/sdd/threads-and-copilot/run-with-reaper.py npm test -- --maxWorkers=2`; `artifacts/full-suite.log`.
- CLI test typecheck: pending rerun after completing the two `openThread` fakes; log: `artifacts/cli-typecheck-final.log`.
- Web lint: PASS (`npm run lint -w apps/web`), log: `artifacts/web-lint.log`.
- Web TypeScript: PASS (`npx tsc --noEmit -p apps/web/tsconfig.json`), log: `artifacts/web-tsc.log`.
- Production web build: PASS (`npm run build -w apps/web`), log: `artifacts/web-build.log`.
- Vite printed the existing native config-loader compatibility warning during Vitest runs.

The controller's uncommitted plan checklist and `docs/reviews/2026-10-26-threads-implementation-decisions.md` were preserved and are excluded from the Task 9 commit.
