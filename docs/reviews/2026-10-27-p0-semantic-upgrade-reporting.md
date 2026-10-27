# P0 semantic acceptance, upgrade recovery, and reporting status

Execution: 2026-10-27 (Asia/Tokyo). Design and plan: `docs/superpowers/specs/2026-10-27-p0-semantic-upgrade-reporting-design.md`, `docs/superpowers/plans/2026-10-27-p0-semantic-upgrade-reporting.md`.
Branch: `github-rule/p0-semantic-upgrade-reporting-05b6`, cut from main `2cd0593` (merge of PR #22). Implementation commit: `2e221b8c10a9109d5134630d7bd11bda3a0a2baa`. The 2026-10-26 release-assurance review is unchanged and is not this result.

No release tag, GitHub release, ruleset edit, or merge was created. This agent did not call PUT. The repository owner later enabled private vulnerability reporting. A non-admin collaborator then submitted test advisory GHSA-mgcq-mcqv-75ff; it was closed without publication and without a CVE.

## Current status

| Item | Status | What this change actually shows |
| --- | --- | --- |
| P0-03 | 进行中 | On 2026-10-27 a Windows host ran both adapters at `b158daf`. Each exited 1 with `semantic: evaluated`. Codex passed 5 of 12 on that script. Claude's 6 of 12 is void: the harness launched the runner as the room MCP server, so Claude had no room tools. The harness, prompt, and rubric were then amended. Neither adapter has an exit 0 on the amended script. |
| P0-04 | 已完成 | Disposable data-directory reopen, pending migration, failed migration, and backup restore passed on hosted `windows-latest` and `macos-latest` for head `ef87a29`. On 2026-10-27 the maintainer (NullumNomen) also reported a manual overwrite install on macOS and on Windows; workspace data remained on both. This agent did not run those installers. |
| P0-05 | 已完成 | An earlier read on 2026-10-27 returned `{"enabled":false}`. The owner enabled the setting at about 11:52 Asia/Tokyo. A read at 11:54 returned HTTP 200 `{"enabled":true}`. The signed-out security page links to the form. At 12:18 Asia/Tokyo, collaborator Nullum-ai (`permission: read`, not admin) submitted test report GHSA-mgcq-mcqv-75ff. GitHub accepted it into triage. It was closed at 12:27 Asia/Tokyo (`2026-10-27T03:27:30Z`) with `published_at` null and no CVE. |

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

The first read on 2026-10-27, before the owner enabled the setting, was HTTP 200 `{"enabled":false}`. `node scripts/security/reporting-status.mjs` printed `{"state":"disabled","enabled":false}`. No PUT was sent by this agent. `gh api user` is not used. A 403 there does not change this read.

Later the same day the owner (NullumNomen, repository admin) enabled private vulnerability reporting at about 11:52 Asia/Tokyo. This agent read it again at 11:54 Asia/Tokyo (`Date: Tue, 27 Oct 2026 02:54:54 GMT` on the response):

```sh
gh api -i repos/Nema-Project/nema-room/private-vulnerability-reporting
```

HTTP 200, body:

```json
{"enabled":true}
```

```sh
node scripts/security/reporting-status.mjs
```

```json
{"state":"enabled","enabled":true}
```

The owner also checked that https://github.com/Nema-Project/nema-room/security shows “Report a vulnerability” linking to `security/advisories/new` while signed out. This agent did not repeat that browser check.

`enabled: true` is the repository setting. The interpreter does not treat it as proof that a non-admin reporter opened the form. SECURITY.md, the four READMEs, the three guides, CONTRIBUTING, and the issue chooser now point at https://github.com/Nema-Project/nema-room/security/advisories/new. The non-admin check is recorded below. P0-05 is 已完成 for that check.

## Platform evidence

Head `ef87a295e778c575e641d2aa82576d2d8c7fc531`. [CI run 40440137400](https://github.com/Nema-Project/nema-room/actions/runs/40440137400) completed successfully on 2026-10-27 (Asia/Tokyo), started 11:44. The upgrade step is separate from the earlier platform suite.

| Runner | Job | Upgrade step |
| --- | --- | --- |
| macos-latest | [121978298481](https://github.com/Nema-Project/nema-room/actions/runs/40440137400/job/121978298481) | 11:45 Asia/Tokyo. `upgrade-recovery reopen/migrate/restore darwin arm64 v22.23.3`. 2 files, 8 tests passed. |
| windows-latest | [121978298611](https://github.com/Nema-Project/nema-room/actions/runs/40440137400/job/121978298611) | 11:46 Asia/Tokyo. `upgrade-recovery reopen/migrate/restore win32 x64 v22.23.4`. 2 files, 8 tests passed. |

The same run's full application job [121978298441](https://github.com/Nema-Project/nema-room/actions/runs/40440137400/job/121978298441) reported 122 test files passed and 1 skipped, 1348 tests passed and 23 skipped. Skipped tests are not acceptance evidence. Web lint/build and the Compose readiness check also passed in that job. `CI gate` passed.

[Desktop PR run 40440137237](https://github.com/Nema-Project/nema-room/actions/runs/40440137237) passed Windows NSIS smoke and macOS staged-runtime smoke. Publish was skipped. That smoke does not install over an existing data directory and does not prove DMG installation, Finder startup, or in-place overwrite.

The hosted data-directory acceptance is recorded above. There is no product migration newer than `011_threads.sql`, so the harness reopens current-schema data that already contains a thread, then applies a test-only migration. It does not replay a pre-thread database and it does not replace an installed package.

### Maintainer overwrite install

On 2026-10-27 the maintainer (NullumNomen) reported a separate manual check: a new installer was installed over the existing one on macOS, and the same kind of overwrite was done on Windows. On both platforms, workspace data was still present afterward. This agent did not repeat the install and was not given a package version or commit SHA for the builds that were overwritten. The report does not include a simulated installer failure followed by restoring a backup, and it does not replace the hosted data-directory logs. P0-04 stays 已完成 with both of those records. This note does not change P0-03 or P0-05.

## Maintainer handoff

### P0-03 real-model runs

Recorded 2026-10-27 (Asia/Tokyo) on Windows, Node v26.12.1, commit `b158dafaaa694b4a3e6bb635ca66e78c1e57452d`. No `--model` was passed, so `configuredModel` is null. Both runs exited 1 with `semantic: evaluated`. That is a scored miss, not a blocked run and not a pass. Full JSON stayed outside the repository. Reply text is omitted here; the `design-open-thread` detail in each JSON is reply text, and neither detail contains the tool name `open_thread`.

Codex direct, credential source `codex-compat-auth-file`. Passed: `memo-reply`, `memo-no-write`, `design-one-decided` (`D-1:decided`), `design-reply`, `brainstorm-reply`. Failed: `design-no-early-write`, `design-open-thread`, `design-agent-opened` (`opened by nobody`), `brainstorm-no-write`, `conflict-redis-only-active` (`D-3`), `conflict-question` (`Q-3` related `R-1,D-3`), `override-redis-superseded` (`redis=missing`, active `D-3`).

| Turn | Message | Thread | Task |
| --- | --- | --- | --- |
| memo | `m_3D4_aERwFrtd` | none | `t_hFOzMPr7qmrW` |
| casual-1 | `m_MWXc2Z5cM5I7` | none | `t_JpP9SVY-nmHP` |
| casual-2 | `m_Posrp7NwTVdS` | none | `t_Y8y9pE2rtXzq` |
| decision | `m_e0ZUtBGqzIUW` | none | `t_XvL_nPxjvaiO` |
| brainstorm | `m_DATpfrXKjHfn` | `m_DATpfrXKjHfn` | `t_w65eAvRHVGKb` |
| brainstorm-end | `m_HZIKPSt1tFc6` | `m_DATpfrXKjHfn` | `t_L9-BOgwuzDWo` |
| redis | `m_3P8-ObRoV1Qc` | `m_3P8-ObRoV1Qc` | `t_yVkuHeXkXnp2` |
| conflict | `m_0EXQjBj_i9_Y` | `m_0EXQjBj_i9_Y` | `t_k2VVJdaiubrS` |
| override | `m_167SuzVWTk6f` | `m_0EXQjBj_i9_Y` | `t_CIT3neWAYrnQ` |

Claude Code, credential source `claude-token-file`. Passed: `memo-reply`, `memo-no-write`, `design-no-early-write`, `design-reply`, `brainstorm-reply`, `brainstorm-no-write`. Failed: `design-open-thread`, `design-agent-opened` (`opened by nobody`), `design-one-decided` (`no decision`), `conflict-redis-only-active` (`none`), `conflict-question` (`no question`), `override-redis-superseded` (`redis=missing`, active `none`). No decision or question id was created.

| Turn | Message | Thread | Task |
| --- | --- | --- | --- |
| memo | `m_61EhyMuIJG6m` | none | `t_WI_jDPMNuVp4` |
| casual-1 | `m_SKBKiFi9heuU` | none | `t_28JhRfCeCi8r` |
| casual-2 | `m_eQlZXN63yywM` | none | `t_WRzkdGdO7ztD` |
| decision | `m_3GyqlJNSiw5K` | none | `t_p07NHcwAVHTv` |
| brainstorm | `m_UDdB513MeqUY` | `m_UDdB513MeqUY` | `t_5nMrNI8OEmfC` |
| brainstorm-end | `m_BW35dOv0kEQf` | `m_UDdB513MeqUY` | `t_fGzoCuqzMp51` |
| redis | `m_C75T7lEtHeNQ` | `m_C75T7lEtHeNQ` | `t_FiUEA3BQJVMw` |
| conflict | `m_cToTYgOw_2ZY` | `m_cToTYgOw_2ZY` | `t_uFS3acQKVuNJ` |
| override | `m_ntY6BOubufSZ` | `m_cToTYgOw_2ZY` | `t_LTOn5a4AcXBn` |

P0-03 stays 进行中. The Claude transcript is not a model result. `startDaemon` was called without `cliEntry`, so the daemon used `process.argv[1]` (`threadSemanticRun.js`). Claude's `mcp.json` then ran `node threadSemanticRun.js mcp`. That process entered `main()` and exited with `unsupported adapter: ""`. Claude therefore had no room tools. Codex's 5/12 is a scored miss of the script that was running at `b158daf`. It is not a score for the amended checks.

The amendment requires a real CLI entry, a connected room server that lists all four `mcp__room__*` tools (otherwise the task fails and the run is blocked), threads-table `open_thread` checks, separate workspaces, a seeded Redis decision, `R-*` allowed on the first design turn, an active decided entry, a supersede link on override, and a compare-options prompt. A `grill` thread is recorded and does not count as agent-opened. Timeout and credential text block the run only before turns start. A missing room tool surface stays blocked.

Rerun after `npm run typecheck`. Each adapter twice. Write the JSON outside the repository. Exit 0 is a pass for that adapter only. Exit 1 is a finished transcript that missed a check. Exit 2 is blocked and must not be scored.

```sh
npm run typecheck
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
test -f "$CODEX_HOME/auth.json"
node scripts/acceptance/run-thread-semantic.mjs --adapter codex-direct --out /tmp/nema-p0-03-codex-1.json
node scripts/acceptance/run-thread-semantic.mjs --adapter codex-direct --out /tmp/nema-p0-03-codex-2.json
node scripts/acceptance/run-thread-semantic.mjs --adapter claude-code --claude-token-file "$HOME/.nema/claude-code-token" --out /tmp/nema-p0-03-claude-1.json
node scripts/acceptance/run-thread-semantic.mjs --adapter claude-code --claude-token-file "$HOME/.nema/claude-code-token" --out /tmp/nema-p0-03-claude-2.json
```

Optional `--model` selects a model. P0-03 stays 进行中 until both adapters exit 0 on this script.

### P0-04 installer overwrite

The maintainer overwrite report above is the manual record. It is not a command this agent can rerun. Local replay of the data-directory harness, not a substitute for the hosted logs or the maintainer install:

```sh
npx vitest run apps/hub/test/upgradeRecovery.test.ts --maxWorkers=1
```

### P0-05 non-admin form

The setting was already enabled. No further PUT was sent.

Recorded check: collaborator `Nullum-ai` is not an admin.

```sh
gh api repos/Nema-Project/nema-room/collaborators/Nullum-ai/permission
```

Response: `{"permission":"read"}`.

At 12:18 Asia/Tokyo (`2026-10-27T03:18:36Z`) that account submitted a test report from `https://github.com/Nema-Project/nema-room/security/advisories/new`. GitHub accepted [GHSA-mgcq-mcqv-75ff](https://github.com/Nema-Project/nema-room/security/advisories/GHSA-mgcq-mcqv-75ff) into `triage`. The summary was "Security Advisory Test". No product vulnerability is described.

It was closed at 12:27 Asia/Tokyo (`2026-10-27T03:27:30Z`):

```sh
gh api --method PATCH repos/Nema-Project/nema-room/security-advisories/GHSA-mgcq-mcqv-75ff -f state=closed
```

Response: `state` is `closed`, `published_at` is null, and `cve_id` is null. P0-05 is 已完成 for the private-channel check.
