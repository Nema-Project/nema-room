# P0 semantic acceptance, upgrade recovery, and reporting status

Execution: 2026-10-27 (Asia/Tokyo). Design and plan: `docs/superpowers/specs/2026-10-27-p0-semantic-upgrade-reporting-design.md`, `docs/superpowers/plans/2026-10-27-p0-semantic-upgrade-reporting.md`.
Branch: `github-rule/p0-semantic-upgrade-reporting-05b6`, cut from main `2cd0593` (merge of PR #22). Implementation commit: `2e221b8c10a9109d5134630d7bd11bda3a0a2baa`. The 2026-10-26 release-assurance review is unchanged and is not this result.

No release tag, GitHub release, advisory, ruleset edit, or merge was created. Private vulnerability reporting was not enabled.

## Current status

| Item | Status | What this change actually shows |
| --- | --- | --- |
| P0-03 | 进行中 | Rubric and a blocked-credential spawn pass locally. No Codex or Claude credential exists here, so neither adapter completed the five conversations. |
| P0-04 | 已完成 | Disposable data-directory reopen, pending migration, failed migration, and backup restore passed on hosted `windows-latest` and `macos-latest` for head `ef87a29`. The seeded home already uses the current schema, including threads. NSIS/DMG overwrite was not attempted and stays unverified. |
| P0-05 | 阻塞 | `GET` on 2026-10-27 returned `{"enabled":false}`. The setting was not changed. No non-admin reporter opened the form. |

P0-01 and P0-02 stay 进行中. This change does not activate the required `CI gate`.

## Local checks

Host: Linux, Node v22.23.4. Times below are Asia/Tokyo on 2026-10-27.

- `npm run typecheck` (`tsc -b`) passed.
- `npx vitest run apps/local/test/semanticAcceptance.test.ts apps/hub/test/upgradeRecovery.test.ts --maxWorkers=1` passed: 2 files, 8 tests, about 7 seconds, started 11:41. Five rubric tests (one golden transcript, one mutation table, credential preflight, error classification, and a spawn with empty `CODEX_HOME` / `HOME` / `USERPROFILE`). Three upgrade tests (reopen, pending `012_upgrade_probe.sql`, failed `999_fail.sql` plus restore).
- `node --test scripts/security/reporting-status.test.mjs scripts/ci/workflows.test.mjs` passed: 5 tests. The workflow test asserts the platform job runs the upgrade and rubric Vitest files and `scripts/security/reporting-status.test.mjs`, and that the Ubuntu job runs the reporting test as its own step.
- `README.md` and `README.en.md` compare equal.
- `node scripts/ci/docs-check.mjs` on the changed Markdown reported 0 errors. Anchors and remote URLs are outside that checker.
- actionlint 1.7.12 passed on `.github/workflows/verify.yml` and `.github/workflows/ci.yml`.
- Full `npm test`, web lint/build, Compose, and desktop packaging were not run on this host. The pull-request CI section below is that evidence. A Linux Vitest pass by itself is not Windows or macOS acceptance.

The empty-home spawn exited 2. Its JSON status is blocked and `semantic` is `not-run`. That is the intended blocked path. It is not a model failure and not a model pass.

## Reporting read

Raw API, exit 0:

```sh
gh api repos/Nema-Project/nema-room/private-vulnerability-reporting
```

```json
{"enabled":false}
```

Interpreter, exit 0:

```sh
node scripts/security/reporting-status.mjs
```

```json
{"state":"disabled","enabled":false}
```

`gh api user` is not used. A 403 there does not change this read. No PUT was sent.

User-facing copy now says the channel is disabled as of this read. The issue chooser still points at `SECURITY.md`, not `https://github.com/Nema-Project/nema-room/security/advisories/new`. That advisory URL is the intended form after an admin enables the setting. It is not a live form today.

## Platform evidence

Head `ef87a295e778c575e641d2aa82576d2d8c7fc531`. [CI run 40440137400](https://github.com/Nema-Project/nema-room/actions/runs/40440137400) completed successfully on 2026-10-27 (Asia/Tokyo), started 11:44. The upgrade step is separate from the earlier platform suite.

| Runner | Job | Upgrade step |
| --- | --- | --- |
| macos-latest | [121978298481](https://github.com/Nema-Project/nema-room/actions/runs/40440137400/job/121978298481) | 11:45 Asia/Tokyo. `upgrade-recovery reopen/migrate/restore darwin arm64 v22.23.3`. 2 files, 8 tests passed. |
| windows-latest | [121978298611](https://github.com/Nema-Project/nema-room/actions/runs/40440137400/job/121978298611) | 11:46 Asia/Tokyo. `upgrade-recovery reopen/migrate/restore win32 x64 v22.23.4`. 2 files, 8 tests passed. |

The same run's full application job [121978298441](https://github.com/Nema-Project/nema-room/actions/runs/40440137400/job/121978298441) reported 122 test files passed and 1 skipped, 1348 tests passed and 23 skipped. Skipped tests are not acceptance evidence. Web lint/build and the Compose readiness check also passed in that job. `CI gate` passed.

[Desktop PR run 40440137237](https://github.com/Nema-Project/nema-room/actions/runs/40440137237) passed Windows NSIS smoke and macOS staged-runtime smoke. Publish was skipped. That smoke does not install over an existing data directory and does not prove DMG installation, Finder startup, or in-place overwrite.

P0-04 is marked 已完成 for the data-directory acceptance only. There is no product migration newer than `011_threads.sql`, so the harness reopens current-schema data that already contains a thread, then applies a test-only migration. It does not replay a pre-thread database and it does not replace an installed package.

## Maintainer handoff

### P0-03 real-model runs

Needs `npm ci` and `npm run typecheck` so `apps/local/dist` exists. Do not commit the JSON files.

```sh
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
test -f "$CODEX_HOME/auth.json"
node scripts/acceptance/run-thread-semantic.mjs --adapter codex-direct --out /tmp/nema-p0-03-codex.json
node scripts/acceptance/run-thread-semantic.mjs --adapter claude-code --claude-token-file "$HOME/.nema/claude-code-token" --out /tmp/nema-p0-03-claude.json
```

Optional `--model`. Exit 0 is a pass for that adapter only. Exit 1 is a finished transcript that missed a check. Exit 2 is blocked and must not be scored. Copy a redacted summary (commit, adapter, model, check names, message ids, knowledge ids) into this review. Leave discussion text and any home path out of the repository.

### P0-04 installer overwrite

The hosted data-directory runs above are recorded. This remaining check is still manual, on a disposable machine: quit the tray, back up `~/.nema/desktop`, install the new package over the old one, launch, and check chats, threads, work packages, and knowledge Git history. Separately restore that backup after a simulated failure. Keep the in-place installer warning until that check is recorded. It is not part of the P0-04 data-directory acceptance.

Local replay, not a substitute for the hosted logs:

```sh
npx vitest run apps/hub/test/upgradeRecovery.test.ts --maxWorkers=1
```

### P0-05 enablement and non-admin form

Do not run the PUT from an unprivileged automation account. An administrator enables the setting, then reads it back:

```sh
gh api repos/Nema-Project/nema-room/private-vulnerability-reporting
gh api --method PUT repos/Nema-Project/nema-room/private-vulnerability-reporting -f enabled=true
gh api repos/Nema-Project/nema-room/private-vulnerability-reporting
node scripts/security/reporting-status.mjs
```

Settings → Code security → Private vulnerability reporting → Enable.

Non-admin check: sign in as a user who is not an admin. `gh api repos/Nema-Project/nema-room/collaborators/LOGIN/permission` should show that they are not an admin. Open `https://github.com/Nema-Project/nema-room/security/advisories/new` and confirm the form renders. Do not submit. Only then point SECURITY.md and the issue chooser at that live URL.

Until both the enabled read and the non-admin form check exist, P0-05 stays 阻塞.
