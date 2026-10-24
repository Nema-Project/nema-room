# Desktop migration baseline

Date: 2026-10-24. Working branch: `feat/local-desktop`, local checkout only.

The incoming Web/Compose work and approved desktop design were checkpointed as `cd9c3d9`. This preserves the previous uncommitted work; it is not a claim of release readiness. A binary diff and untracked-file copy were saved before that checkpoint, without ignored credentials.

## Toolchain

- Cached Node.js 24.22.1 is available by explicit path.
- npm 11.6.2 was restored as a project-local shell tool, without changing the user's global installation/PATH.
- Existing dependency and workspace links point to the local checkout. A fresh `npm ci` has not yet been completed for this baseline; do not equate copied dependencies with a clean-install check.
- CLI test typecheck passed before implementation dispatch.

## Completed baseline run

Command: `node node_modules/vitest/vitest.mjs run --project=@nema/cli --maxWorkers=2 --reporter=verbose`.

Result: **410 passing, 65 failing tests (475 total), 219.91 seconds**. Suite summary: 56 failed, 22 passed. The suite-level failures additionally include binary macOS AppleDouble `._*.test.ts` files discovered as tests; excluding those resource-fork files is a discovery correction and does not resolve the 65 real test failures.

Failures include Windows ACL fixtures and POSIX-only permission expectations, symlink privileges, legacy Codex CLI tests, hook/environment assumptions, line endings, and refresh-lock timing. These must be triaged separately; they are not all harmless test assumptions. No full Windows green result is claimed.

The earlier full multi-project baseline was interrupted without a completed result and remains non-evidence. The new CLI-only run above is the first completed broad baseline after migration to the local directory.

## Execution update

The user replaced the rejected LAN Grok implementation trial with native Luna implementers. The controller owns code review and acceptance. Task 1 covers on-disk PGlite and real queue/transaction/recovery behavior; other migration tasks and clean installation checks remain open. No tags, pushes or Releases have been created.

## Resumption checks

The saved local feature checkout was resumed without discarding incoming work. `node --test scripts/setup.test.mjs` passed all four installer-wizard checks. Scoped product fixes were accepted independently: live-PID refresh-lock safety (`f730a86`, 8 lock tests plus CLI typecheck), Windows PATH Node launcher resolution (`04babca`, 6 platform tests plus CLI typecheck), managed hub lifecycle (`79caccb`, 72 combined hub tests and 6 final lifecycle tests plus root typecheck), and owner-managed runner/model cancellation (`73fda8b`, 9 runner/lifecycle, 25 direct adapter, 15 Claude adapter tests plus CLI typecheck). These are targeted results, not a new full-suite pass.

The paired lock/AuthStore run had 44 passing and 7 failing tests. All eight lock tests passed; the remaining failures concern Windows test setup/capabilities and platform assertions. A scratch-directory diagnosis showed `nativePermissions.expectPrivate` invokes `Get-Acl` through Windows PowerShell with a module path that cannot load `Microsoft.PowerShell.Security`; the production .NET ACL path succeeded. File symlink privilege, POSIX chmod/stat assertions and `mkfifo` are also still unresolved in that suite. No skips or fixture edits were used to claim acceptance.

## Complete repository run after lifecycle work

Command: `npm test -- --maxWorkers=2 --reporter=json --outputFile=.superpowers/sdd/2026-10-24-desktop-implementation/resume-full.json` (through the local npm shim). Result: **957 tests, 891 passing, 66 failing, 0 pending/skipped**, process exit 1. All suites completed and the structured report was generated; this is a complete failing baseline, not an interrupted run or a release pass.

Of the 64 CLI failures, 62 match the earlier 65-failure CLI baseline by test file and normalized full title. Three previous failures no longer fail: the direct adapter's late hub response after timeout, slow auth-refresh lock contention, and slow-holder heartbeat contention. Two directory-privacy assertions now fail in `direct/authStore.test.ts` and `secrets/file.test.ts`; both use `nativePermissions.expectPrivate` and are consistent with the separately reproduced Windows PowerShell `Get-Acl` module-loading failure in this shell environment. They are recorded rather than suppressed. The remaining two repository failures are the previously recorded hub CRLF assertion and missing file-symlink privilege.

The daemon lifecycle, current runner/adapter, packaged MCP argv, GitHub child-exit/startup-close, and graphify child-exit checks did not fail in this full run. Independent review nevertheless found a late socket-event guard gap; it is being fixed and will receive focused re-verification. The root also reverted only daemon setup to the accepted old implementation temporarily and observed the owner-close regression fail (`close()` returned void); the source was restored in `finally`. This is reversion evidence, not an invented original RED run.
