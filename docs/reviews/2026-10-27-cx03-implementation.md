# CX-03 implementation verification

Date: 2026-10-27. Base: `0bd830a`. Product implementation through `d1372fb`; Web fixture compatibility through `7b3548b`.

## Implemented scope

All ten tasks in `docs/superpowers/plans/2026-10-27-source-evidence-protocol.md` are implemented: shared snapshot/ref contracts; compatible knowledge serialization; optional snapshot tables and migration; evidence events; idempotent hub-only import; Room evidence checks; UI confirmation audit/replay; read-only freshness projections; startup reconciliation; prompt and API reference.

The existing #28 user-basis and inactive-to-active checks remain inside the repository lock. External excerpts are not messages or user authority. No connector providers, OAuth, new UI, or external write capability were added.

## Review and regression fixes

Each task received separate spec/quality review. Independent whole-branch review identified two additional Important issues, both fixed with failing regressions before implementation:

- `2e9aafc`: derive freshness from the stored observation against the snapshot being read, rather than reusing a comparison against an older imported revision. Covers reimports, null revisions, and Git-success/index-failure reads and retries. Thirty focused tests and root typecheck passed.
- `d1372fb`: reconcile committed pending confirmation events inside the existing UI write lock before replay detection. Covers post-commit consumption failure and partial consumption of a source's two events. Seventy-seven UI/event tests and root typecheck passed.

Task review also fixed incomplete snapshot-confirm replay, discarded metadata edits during PUT replay, and client-controlled Reason provenance.

## Implementation ruling

An additive, server-selected `UI-Action: edit|confirm` Git trailer distinguishes an actual confirmation from an edit during promotion-event replay. Reason is client-selected and cannot establish provenance. The client cannot choose UI-Action. Old commits remain readable; an old commit without this marker may require a fresh confirmation audit event. If that compatibility choice is unsuitable, replay provenance will need a protocol revision.

## Verification

- Root `npm run typecheck`: passed after the final code fix.
- `npm run typecheck -w apps/cli`: passed.
- `npx tsc --noEmit -p apps/web/tsconfig.json`: initially found three typed fixtures missing the new default fields; fixture-only fix `7b3548b` passed this check and 26 targeted Web tests. No product UI or assertions changed.
- Local migration and actual backup import: 27 tests passed, 2 files, with sandbox restrictions lifted. Restored unconsumed events are nonconsumable; consumed rows retain their state.
- Final feature combination: 231 tests passed, 10 files. Command: `npx vitest run --project @nema/shared --project @nema/knowledge --project @nema/hub sourceEvidence entry store commitMessage roomApi sourceImport sourceFreshness prompt workspaces --maxWorkers=2 --hookTimeout=60000`.
- Final UI/events: 77 tests passed, 2 files. Together with local migration/import, 335 backend/import targeted tests passed across 14 files; with 26 Web compatibility tests, 361 targeted tests passed across 17 files.
- Complete full suite: `npm test -- --maxWorkers=2 --hookTimeout=60000` exited 1: 1486 passed, 23 skipped, 7 failed; 123 files passed, 1 skipped, 5 failed. Duration: 644.46s. It started with product code at `d1372fb`; the later three Web fixture defaults were separately verified. All seven failures reproduced on the base, as detailed below.

Earlier restricted runs encountered `spawnSync which EPERM` and blocked loopback listeners. They are not passing evidence. Two preliminary full runs and duplicate feature runs were interrupted; only completed runs count below. Vite native-config warnings remain.

Completed-run logs: `/tmp/cx03-final-feature-unrestricted.log`, `/tmp/cx03-final-local-unrestricted.log`, `/tmp/cx03-final-complete-suite.log`, `/tmp/cx03-baseline-cli-unrestricted.log`, `/tmp/cx03-baseline-runtime-permissions.log`. Documentation link validation and its test passed; diff whitespace checks passed.

## Baseline comparison

The original base was checked out separately at `/tmp/cx03-baseline`, reusing installed dependencies and built workspace exports. With restrictions lifted, five unchanged CLI test files produced 67 passes and these six failures:

- `apps/cli/test/report/report.test.ts`: `a report token file that is not 0600 is refused`.
- `apps/cli/test/direct/byok.test.ts`: `requires an existing mode-0600 key file`.
- `apps/cli/test/codexAdapter.test.ts`: `grandchild-hang: whole process tree is killed`; `grandchild-foreign: whole process tree is killed`.
- `apps/cli/test/claude/adapter.test.ts`: `owner cancellation kills an active fake Claude child and waits for its close`; `kills Claude's process group on failure and on success`.

The same six CLI failures appeared in the implementation's complete final run. Its seventh failure was `apps/local/test/runtime.test.ts`: `rejects daemon-token permissions before database creation`. Running that exact test against the base also failed with the same resolved-runtime-vs-rejection mismatch (1 failed, 23 skipped). All seven full-suite failures therefore reproduced on the base. This comparison establishes reproduction in this environment, not acceptance on Windows/macOS or a diagnosis of each failure.

No desktop packaging, native platform acceptance, or real-model semantic checks were performed for this backend protocol change. CX-03 remains in progress in ROADMAP pending final acceptance; P0 status is unchanged.
