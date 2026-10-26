# P0 release assurance execution evidence

Date: 2026-10-26 (Asia/Tokyo). Scope: P0-01, P0-02, P0-05; P0-03/P0-04 remain open.
Design/plan: PR #21, base `d92f95b85cd5d63cee67754a03d401d17bcc28e9`. Execution: Native, isolated branch `codex/p0-release-assurance`.

## Current status

Implementation is under verification. No release tags, releases, advisories or merges were created. Rollout is **not activated**; no deployment SHA exists yet. Code completion is separate from operational acceptance.

| Item | Evidence / remaining work |
| --- | --- |
| P0-01 | Shared complete suite and immutable tag commit gate implemented; local policy/workflow tests pass. Actions and nonpublishing native rehearsal pending. |
| P0-02 | Stable `CI gate` implemented; docs/full/negative live PR checks pending. Required-check activation awaits separately authorized merge and administration access. |
| P0-05 | Public security form removed and translated guidance corrected. Private reporting enabled state and non-admin reporter access are **unverified/blocked**; issue chooser links to SECURITY.md, not a claimed live private form. |

## Local checks

- Node tests exercised complete Git diffs (>300 files), unusual paths, executable-to-doc renames, all job-result failure modes, local links and security routing, lightweight/annotated/off-main tags, and parsed workflow contracts with mutations for changed checkout refs and missing publication dependencies.
- `actionlint` 1.7.12 was downloaded using the workflow's pinned SHA256 and passed.
- Root `npm run typecheck` passed.
- Initial host `npm test -- --maxWorkers=2` was stopped after environment-specific failures: report token/BYOK mode rejection, Codex grandchild cleanup and Claude process-group cleanup. Host umask 0077 turned requested 0644 fixture modes into 0600; PID 1 did not reap exited orphans. The host uses Node 24. A separate Node 22 container with `--init` and umask 0022 is used for the full suite; its final result is recorded below when available. Application code and tests were not weakened.

## Administration and reporting capability

- GitHub connector rejects `GET /repos/Nema-Project/nema-room/private-vulnerability-reporting` as an unsupported endpoint (400 INVALID_ARGUMENT). This establishes **unknown**, not disabled.
- The execution environment's `gh auth status` did not establish a usable CLI login. No replacement credentials or invented account were used.
- No legitimate non-admin reporter session is available, so opening the private form as such a reporter is blocked. No fake advisory was filed.
- Ruleset collection read shows `main` (25809837) disabled and `main pull request` (25873388) active. Complete effective protection and current rules must be read again at activation; one collection response cannot establish merge enforcement.

## Post-merge activation handoff

1. Obtain separate authorization to merge the verified implementation; record its actual deployment commit.
2. Run full manual CI on that commit and the deferred `verify_full=true`, `target=all` nonpublishing rehearsal. Confirm exact checkout SHA, Windows NSIS smoke and macOS staged-runtime smoke separately; publication must be skipped.
3. Read current rulesets and traditional branch protection. Preserve PR rules, bypass actors and unrelated protections. Add observed GitHub Actions `CI gate` as required, binding its observed app ID, and require an up-to-date branch. Read back settings.
4. On disposable PRs, confirm failing/missing checks prevent merging and passing up-to-date checks satisfy requirements, without merging; close those PRs.
5. Enable private vulnerability reporting with authorized admin access if needed; verify with a legitimate non-admin reporter without submitting an advisory. Only then change the pending guidance to a live private-report link.
6. Record run URLs, settings evidence and deployment SHA here and in RELEASE.md. Mark each ROADMAP item complete only after its own acceptance; P0-03/P0-04 stay open.

Manual settings if admin tools remain unavailable: Settings → Rules → main ruleset → require the observed GitHub Actions `CI gate` and an up-to-date branch, preserving existing rules and bypasses. Settings → Security → enable private vulnerability reporting. These are requested changes, not claims of applied settings.
