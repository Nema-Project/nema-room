# P0 semantic acceptance, upgrade recovery, and reporting status

Execution: 2026-10-27 (Asia/Tokyo). Design and plan: `docs/superpowers/specs/2026-10-27-p0-semantic-upgrade-reporting-design.md`, `docs/superpowers/plans/2026-10-27-p0-semantic-upgrade-reporting.md`.
Branch: `github-rule/p0-semantic-upgrade-reporting-05b6`, cut from main `2cd0593` (merge of PR #22). The 2026-10-26 release-assurance review is unchanged and is not this result.

No release tag, GitHub release, advisory, ruleset edit, or merge was created. Private vulnerability reporting was not enabled.

## Current status

| Item | Status | What this change actually shows |
| --- | --- | --- |
| P0-03 | 进行中 | Rubric and a blocked-credential spawn pass locally. No Codex or Claude credential exists here, so neither adapter completed the five conversations. |
| P0-04 | 进行中 | Disposable data-directory reopen, pending migration, failed migration, and backup restore passed on this Linux host (Node v22.23.4). Windows and macOS platform logs are not available until CI runs. NSIS/DMG overwrite was not attempted. |
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
- Full `npm test`, web lint/build, Compose, and desktop packaging were not run. A Linux Vitest pass is not Windows or macOS acceptance.

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

Not yet recorded. After CI, link the `verify` platform job for this head on both `windows-latest` and `macos-latest` only if those logs show the upgrade tests passing. A failed or missing job stays 进行中. Do not mark P0-04 已完成 from this Linux run.

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

### P0-04 hosted runners and installer overwrite

Local, not OS acceptance:

```sh
npx vitest run apps/hub/test/upgradeRecovery.test.ts --maxWorkers=1
```

Mark P0-04 已完成 only after both hosted platform runs pass, then say in ROADMAP, CHANGELOG, and the READMEs/guides that the data-directory check passed on those runners. Keep the in-place installer warning until this separate check is done on a disposable machine: quit the tray, back up `~/.nema/desktop`, install the new package over the old one, launch, and check chats, threads, work packages, and knowledge Git history. Separately restore that backup after a simulated failure.

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
