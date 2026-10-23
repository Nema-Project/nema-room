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
