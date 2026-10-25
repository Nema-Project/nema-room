# Desktop validation record

Dates: 2026-10-24 to 2026-10-25 (Asia/Tokyo). Branch history: `feat/local-desktop`, squash-merged to `main` as `d472767` (PR #1).

This is the evidence summary for the local desktop app as of the end of Task 9a and the start of Task 9b. It states what was run, what it proves, and what it does not. It is not a release readiness claim: no tag was created and no GitHub Release was published.

Earlier records, kept as written: [desktop baseline](2026-10-24-desktop-baseline.md), [local storage validation](2026-10-24-local-storage-validation.md), [custom window chrome acceptance](2026-10-25-custom-window-chrome.md). [Cross-platform readiness](2026-10-24-cross-platform-readiness.md) describes the superseded Web / Compose scope.

## What was verified

Everything below ran on one Windows 11 machine unless stated otherwise.

| Area | Evidence |
| --- | --- |
| On-disk database | PGlite on disk survives process exit and a forced core crash; the queue, transactions and recovery behave as the PostgreSQL-backed hub does (Task 1, `50f5da0`). |
| Hub and daemon lifecycle | A hub can start on a dynamic port and drain on shutdown; the daemon cancels and drains owner-managed model runs and helpers (Tasks 2 and 3). |
| Single owner and discovery | One kernel-level owner per home; a descriptor is trusted only after the owner proves its identity with the descriptor secret; forged descriptors, control addresses and reparse points are refused (Task 4, 22 instance tests). |
| Protected gateway | One-time launch ticket becomes an HttpOnly session cookie; the ticket never reaches a referer or an upstream; the hub is unreachable without the gateway's private credential (Task 5, checked in a real browser). |
| Model setup | Settings and sign-in jobs run without a terminal; secrets are cleared from the UI after saving; jobs can be cancelled (Task 6). |
| Packaging | A self-contained runtime (Next standalone output, compiled core, bundled Node and Git) is staged from a sanitized source snapshot with no `.git` or `.env*`; the packaged core starts with a restricted `PATH` from a path containing spaces and Japanese characters (Task 7). |
| Electron app | Windows x64 NSIS installer and portable ZIP; copied-app smoke covers readiness, CSS and fonts, a persisted workspace and chat against a local fake provider, close-to-tray and reopen, browser fallback after an Electron main-process exit, and data after an authenticated core restart (Task 8). |
| Window chrome | One custom title bar; minimize, maximize and close; the user confirmed mouse dragging and edge resizing (Task 8c). |
| Workspace creation and connection settings | Creation feedback, and the Agent runtime / model service / sign-in organization, in English, Japanese and Chinese (Tasks 8d, 8e). |
| GitHub | The Agent runs scoped `gh` commands through two brokered tools; scope, allowlist, opt-in writes and redacted errors are covered by tests that use a fake `gh` (Task 8f). |
| Snapshot export and import | Round trip of rows, sequences, dates, Git history and settings; refusal of tampered, partial or unexpected snapshots, a non-empty destination, a running instance and a junction-redirected `knowledge/` directory; interrupted activation and its recovery (Task 9a, 12 tests). |
| Report hooks | The CLI finds a running desktop app only after the app proves its identity; the gateway forwards only the fixed report routes with the caller's bearer token; the same identity protocol is exercised against a real lease (Task 9b, first slice). |

Final Windows artifacts recorded at the end of Task 8c (`dist/desktop-artifacts-8c-final/win32-x64`):

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| Nema-0.1.0-win32-x64.zip | 353688538 | 96D95A1783872CFD70D2FDB4998F1961531617058D3079A8599D6A7464D344FF |
| Nema-0.1.0-win32-x64.exe | 214693850 | CE53DAE5F0FAABFD6C93B76E060A34A197837890580250DD224693145BFBF26A |

These predate Tasks 8d to 8f, the brand assets and 9a/9b.

Rebuilt on 2026-10-25 from commit `f8f42ef` (the 9b branch, forked from `main` `48cbb8a`, with the CI fixes and README changes on top; the extension-management work and other uncommitted files were not included). The build ran on the same Windows 11 machine, from a `git archive` of that commit extracted to an ordinary folder, with Clang from the LLVM-MinGW package for the owned-helper guardian and the pinned Node and Git archives from the existing SHA-256-verified tool cache:

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| Nema-0.1.0-win32-x64.zip | 354028850 | AEE719637D0A1E9EC08B4D6D31D38E537B00F7969F5010BE02DE6FB88D693DCA |
| Nema-0.1.0-win32-x64.exe | 214875171 | 6C788B97CD7B7CBEF5A1E8C7292AF00724623DBD3FF98EFB85DBDE6BCE73EB2 |

How it was built: `npm run desktop:make -- --platform win32 --arch x64` run from the worktree failed before staging with `Unsafe Electron MIT license parent path`, because in that worktree `node_modules` is a junction into another checkout and the staging safety check refuses links. That refusal is the intended behavior, not a defect, so it was not relaxed. Instead a local wrapper (kept outside the repository) extracted the commit into a plain folder, copied the two Electron notice files into its `node_modules/electron/dist`, and called `stageRuntime` and electron-builder with the same configuration `make.mjs` uses (NSIS and ZIP targets, unsigned). Two earlier wrapper attempts failed on the junctioned tool-cache path and on the Git Bash `tar`; both were environment problems in the wrapper. The installer and ZIP therefore come from the repository's own staging and packaging code, but `desktop:make` itself was not run end to end.

Checks on these artifacts:

- `desktop:smoke` on the new ZIP: passed. It extracted into a UUID-scoped temp path with spaces and Japanese characters, used a temporary Electron profile and local-core home, and covered the packaged title-bar preload and owner validation, readiness, production CSS and font, one persisted workspace and chat against the local fake provider (one request, fake key only), the Electron notice files, browser fallback after the Electron main process exited, and the same core data after an authenticated quit and restart. The script leaves the final copied app and core running; they were stopped by hand afterwards and the temp tree was removed.
- `desktop:smoke-runtime` on the staged payload: passed. Fake Responses provider, workspace and knowledge Git history, graceful shutdown by stdin close, a forced core crash, and the Next listener refusing requests after its owner exited.

What this does not cover: the NSIS installer was built but **not installed, launched or uninstalled**; only the portable ZIP was run. Nothing was visually inspected, and no signing, SmartScreen, upgrade or clean-machine behavior was checked. `desktop:validate-release` was not run, so the pending source-correspondence entries still block a release.

## Test and CI status

- Local Windows, CLI project baseline before the migration work: 410 passing, 65 failing (475 total). Local Windows, full repository after the lifecycle work: 957 tests, 891 passing, 66 failing. The failures are Windows ACL fixtures, POSIX-only permission expectations, symlink privileges, line endings and timing; they were triaged and not all are test-only problems. The list is in the local ledger (`baseline-cli-failures.json`).
- Local Windows, full repository, 2026-10-25 after the Windows test fixes: before 1162 tests, 1097 passing, **65 failing**, 0 skipped; after 1165 tests, 1142 passing, **0 failing, 23 skipped**. The 23 skips are deliberate gates and are **not** Windows acceptance:
  - 18 tests of the retired `codex-cli` adapter and its isolation (10 in `codexAdapter.test.ts`, 8 in `isolation.test.ts`). They need a `/bin/sh` wrapper and a file symlink for `auth.json`; the active direct adapter has its own native tests.
  - 4 tests that plant a file symlink (`authStore`, `byok`, `claude/token`, `secrets/file`). A file symlink needs admin or Developer Mode on Windows and junctions cannot point at files, so these run only on a host that can create one (the probe is `apps/cli/test/links.ts`). **Run them on a privileged Windows runner before calling Windows green.** Two more symlink cases inside `authStore.test.ts` are conditional blocks, not skips, and are likewise not exercised here.
  - 1 POSIX-only end-to-end run with a fake `git` shell script (`git.test.ts`); on Windows the same env contract is asserted on `commandEnv()` instead.
  - What changed: directory links use junctions; symlink blobs for git tests are planted with git plumbing when no file symlink is possible; hand-written secret files get a real private DACL; env, hook, ACL-wording and CRLF assertions are platform-aware; fake graphify/git fixtures are Node scripts instead of `/bin/sh`.
  - Product fix: `exportSnapshot` now runs the Windows `tar.exe` from System32 on Windows. With Git for Windows' GNU tar first on PATH it failed with "Cannot connect to C:" and broke every repo index (the three hub e2e "timeout: index" failures and most of `repos/handlers` and `watcher`). A regression test puts a failing `tar.exe` first on PATH.
  - Test fixes that corrected the test rather than the host: the `@nema/local` control-collision test expected a message no code path emits and asserted discovery of an owner that never published (now asserts the collision message and that the owner still holds the control port); the daemon-token permission test never widened the DACL; the graphify SIGTERM test required the child to outlive a response that the product only sends after exit; the managed incremental update test required the graphify path in argv, which is true only when it is launched through node.
  - Typecheck (`npx tsc -b`, `npm run typecheck -w apps/cli`) passes. The POSIX behavior of the last two fixes was reasoned from the code, not run; no POSIX host was available.
  - Not fixed, recorded as findings: `prepareClaudeLaunch` sets no DACL on the run directory or `mcp.json` (which holds the run token) on Windows, so the 0700/0600 modes are asserted on POSIX only; `git archive` follows the user's `core.autocrlf`, so snapshots may carry CRLF (tests now compare content); `prepareIsolation` of the retired adapter needs a file symlink and cannot work for an unprivileged Windows user; graphify and GitHub MCP children still inherit `USERPROFILE` and related variables (see the triage report).
- CI on PR #1 and on `main` after the merge was **red**:
  - Ubuntu and macOS platform checks passed.
  - The Windows platform job failed in "Native credentials, command execution, and authentication" (Claude adapter tests: a missing temp file and a `kill ESRCH`).
  - The full Ubuntu test job failed with 18 failing tests of 1162. Most were `@nema/local` fixtures that start a child process which imports `@nema/*` from compiled output, which a clean checkout lacks until `tsc -b` has run. Two were regressions from the `gh` work (the MCP client counted the new `gh_read` and `gh_write` tools as missing server tools; a POSIX test seam returned the wrong process shape).
  - The two regressions and the build-before-test ordering are fixed on the 9b branch; the Windows job and the remaining failures are open.
  - Reading the tests for the Ubuntu failures (logs were lost, nothing re-run on POSIX): the graphify SIGTERM test and the managed incremental update test have deterministic POSIX failures explained above and are fixed. `direct/adapter.test.ts` "late hub response" depends on a 250 ms run budget against a 600 ms hub delay and on how quickly the first model request is issued, so it is timing sensitive under load (it passed in both Windows runs here). `persistentDb.test.ts` "process crash reopens" and the CLI exit-73 expectation are the same worker (`persistentDbCrashWorker.ts`, exits 73 after one stdout line) and require `stderr` to be exactly empty, so any warning from `tsx`, Node or PGlite on a runner fails it; the cause is unknown without the logs.
- Web lint was already failing on `main` before this work (8 `react-hooks` errors); it was fixed in the PR.

## Not verified

- **macOS.** Build configuration exists for DMG and ZIP with ad-hoc signing; nothing was built or run on a Mac. Native macOS process ownership, icon template checks and Gatekeeper behavior are open.
- **The rebuilt NSIS installer was never installed or run**, and no first download or first install on a clean machine, including the SmartScreen prompt for an unsigned installer and an installer-driven uninstall.
- **In-place upgrade** over an earlier installer, and migration of a real user's Web / Compose data. Import was exercised only with generated fixtures.
- **A real `gh` login and GitHub account.** The `gh` tools were tested with fake executables.
- **A real PostgreSQL server for export.** Export was tested through a PGlite-backed connection stand-in.
- **A real model provider.** Smoke runs use a local fake Responses provider.
- **POSIX helper ownership.** The guardian and cleanup guarantee exist only for Windows.
- **Source correspondence and redistribution review** for bundled Node, Git for Windows components, Electron and the generated fonts. The publication validator fails closed while any entry is pending, so a release cannot be cut from the current state.
- **Full Windows acceptance of the file-symlink and retired-adapter tests.** The local Windows run is green with 23 gated skips (see Test and CI status); the gated tests have not run on a host with symlink privilege, and nothing has run on POSIX or in CI after these changes.

## Open gates before any release

1. Green CI on all three platforms, including the Windows platform job.
2. Install and run the rebuilt NSIS installer (the ZIP smoke passed on 2026-10-25; the installer itself was only built).
3. macOS build and native checks.
4. Source-correspondence review complete and `desktop:validate-release` passing.
5. A first-install and upgrade check on a clean machine.
