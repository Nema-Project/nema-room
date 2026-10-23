# Task 1 report: disk PGlite validation

## Changes

- Added `createLocalDb(dataDir)` with disk-backed PGlite, startup migrations, cleanup on migration failure, and a per-instance shared close promise for idempotent/concurrent close calls.
- Kept `createTestDb()` and the legacy PostgreSQL path intact.
- Extended `migrate` with an optional migrations directory and filtered AppleDouble `._*.sql` resource forks. Added the same sidecar exclusion to Vitest project discovery so resource metadata is not mistaken for test files.
- Added real application integration coverage for persistence of messages and plugin settings, transaction rollback, distinct concurrent workspace claims, process-crash reopen, failed migration rollback/cleanup, and isolated migration sidecar discovery.

## Verification

- RED: before the factory existed, storage tests failed with `createLocalDb is not a function`. The paired task suite also failed during migration because the repository contains binary `._*.sql` resource forks.
- Targeted storage + task run (`vitest run apps/hub/test/persistentDb.test.ts apps/hub/test/tasks.test.ts --maxWorkers=2`): 21 passed.
- Root typecheck (`npm run typecheck`): passed.
- Hub suite (`vitest run --project @nema/hub --maxWorkers=2`): 247 passed, 2 failed across 22 files. The failures were `test/codebase.e2e.test.ts` at line 217 (expected LF, got CRLF) and `test/workspaces.test.ts` at line 65 (Windows symlink creation returned `EPERM`).

Engine was PGlite 0.5.11 on Node.js 24.22.1. The crash worker committed through `postUserMessage`, exited with code 73 without closing the database, and the parent reopened the same data directory and read the committed message. The concurrent A/B claim check exercises the existing `FOR UPDATE ... SKIP LOCKED` SQL and confirms distinct task and workspace owners under the single local hub runtime. PGlite serializes in-process queries; this does not demonstrate multi-process lock scheduling.

## Scope and concerns

Migration discovery additionally needed the authorized narrow `db.ts` change because AppleDouble binary sidecars have `.sql` suffixes; without exclusion they are sent to PostgreSQL as query text and raise `08P01 invalid message format`. Vitest also needed the authorized `**/._*` exclusion because otherwise sidecar test files are discovered. The broad root baseline is owned by the controller. Commit: pending.
