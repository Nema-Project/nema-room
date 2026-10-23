# Local storage validation

Validated the local desktop database path on Windows with Node.js 24.22.1 and `@electric-sql/pglite` 0.5.11. `createLocalDb(dataDir)` opens a disk-backed database at the requested directory, applies pending migrations, and returns the existing `Db` query and transaction interface plus an idempotent `close()`. Concurrent close calls share the same shutdown promise. A migration failure closes the instance before the error is rethrown. Tests used per-test directories under `C:\Users\Nokk\AppData\Local\Temp\nema-pglite-*`; the same directory was passed to the child and parent for the crash recovery check.

The tests use the real application migrations and helpers. They cover message and plugin setting persistence across close/reopen, rollback of a transaction with multiple writes, failed migration DDL rollback, real `claimNextTask` SQL (including `FOR UPDATE ... SKIP LOCKED`) with two claims for two distinct workspaces, and recovery after a child process exits with code 73 immediately after committing application data. Migration discovery also has an isolated regression for a binary AppleDouble `._*.sql` sidecar. Such files are excluded from SQL migrations and Vitest test discovery.

The application uses one local hub process as the database owner. PGlite serializes its in-process query work, so these checks establish the application's observed claim invariants on the supported single-owner runtime. They do not demonstrate lock scheduling across multiple independent PGlite processes. The legacy PostgreSQL factory and SQL path remain unchanged.

## Verification

- Targeted storage and task tests: 21 passed.
- Root typecheck (`npm run typecheck`): passed.
- Hub suite (`vitest run --project @nema/hub --maxWorkers=2`): 247 passed, 2 failed across 22 files. The failures are inherited Windows environment cases: `test/codebase.e2e.test.ts` expected LF but received CRLF at `test/codebase.e2e.test.ts:217`, and `test/workspaces.test.ts` could not create a symlink (`EPERM`) at `test/workspaces.test.ts:65`.
