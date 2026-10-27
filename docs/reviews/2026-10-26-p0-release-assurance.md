# P0 release assurance execution evidence

Execution: 2026-10-27 (Asia/Tokyo); design dated 2026-10-26. Scope: P0-01, P0-02, P0-05; P0-03/P0-04 remain open.
Design/plan: PR #21, base `d92f95b85cd5d63cee67754a03d401d17bcc28e9`. Execution: Native, isolated branch `codex/p0-release-assurance`.

## Current status

Implementation is in [PR #22](https://github.com/Nema-Project/nema-room/pull/22), under verification. No release tags, releases, advisories or merges were created. Rollout is **not activated**; no deployment SHA exists yet. Code completion is separate from operational acceptance.

| Item | Evidence / remaining work |
| --- | --- |
| P0-01 | Shared complete suite and immutable tag commit gate implemented; local policy/workflow tests pass. Actions and nonpublishing native rehearsal are recorded below. |
| P0-02 | Stable `CI gate` implemented; Live docs success and negative gate checks passed; full-suite result recorded below. Required-check activation awaits separately authorized merge and administration access. |
| P0-05 | Public security form removed and translated guidance corrected. Private reporting enabled state and non-admin reporter access are **unverified/blocked**; issue chooser links to SECURITY.md, not a claimed live private form. |

## Local checks

- Node tests exercised complete Git diffs (>300 files), unusual paths, executable-to-doc renames, all job-result failure modes, local links and security routing, lightweight/annotated/off-main tags, and parsed workflow contracts with mutations for changed checkout refs and missing publication dependencies.
- `actionlint` 1.7.12 was downloaded using the workflow's pinned SHA256 and passed.
- Root `npm run typecheck` passed.
- Initial host `npm test -- --maxWorkers=2` was stopped after environment-specific failures: report token/BYOK mode rejection, Codex grandchild cleanup and Claude process-group cleanup. Host umask 0077 turned requested 0644 fixture modes into 0600; PID 1 did not reap exited orphans. The host uses Node 24. A separate Node 22 container with `--init` and umask 0022 is used for the full suite; it passed **120 test files / 1,339 tests**, with **1 file / 23 tests skipped**, in 586 seconds. Skipped tests are not acceptance evidence. Application code and tests were not weakened.

## Administration and reporting capability

- GitHub connector rejects `GET /repos/Nema-Project/nema-room/private-vulnerability-reporting` as an unsupported endpoint (400 INVALID_ARGUMENT). This establishes **unknown**, not disabled.
- The execution environment's `gh auth status` did not establish a usable CLI login. No replacement credentials or invented account were used.
- No legitimate non-admin reporter session is available, so opening the private form as such a reporter is blocked. No fake advisory was filed.
- Ruleset collection read shows `main` (25809837) disabled and `main pull request` (25873388) active. The active ruleset detail has only a pull_request rule (zero required reviews) and no bypass actors or required status checks. Traditional branch protection and all effective rules must be re-read at activation; these observations alone do not establish complete merge enforcement.

## Post-merge activation handoff

1. Obtain separate authorization to merge the verified implementation; record its actual deployment commit.
2. Run full manual CI on that commit and the deferred `verify_full=true`, `target=all` nonpublishing rehearsal. Confirm exact checkout SHA, Windows NSIS smoke and macOS staged-runtime smoke separately; publication must be skipped.
3. Read current rulesets and traditional branch protection. Preserve PR rules, bypass actors and unrelated protections. Add observed GitHub Actions `CI gate` as required, binding its observed app ID, and require an up-to-date branch. Read back settings.
4. On disposable PRs, confirm failing/missing checks prevent merging and passing up-to-date checks satisfy requirements, without merging; close those PRs.
5. Enable private vulnerability reporting with authorized admin access if needed; verify with a legitimate non-admin reporter without submitting an advisory. Only then change the pending guidance to a live private-report link.
6. Record run URLs, settings evidence and deployment SHA here and in RELEASE.md. Mark each ROADMAP item complete only after its own acceptance; P0-03/P0-04 stay open.

Manual settings if admin tools remain unavailable: Settings → Rules → main ruleset → require the observed GitHub Actions `CI gate` and an up-to-date branch, preserving existing rules and bypasses. Settings → Security → enable private vulnerability reporting. These are requested changes, not claims of applied settings.

## Live PR behavior

Disposable [PR #23](https://github.com/Nema-Project/nema-room/pull/23) was closed without merging after two controlled states:

| Case | Head commit | Run and actual result |
| --- | --- | --- |
| Valid docs link | `8ac4cf703b4edadd88bc8c4e19daef3745e242f6` | [40367197106](https://github.com/Nema-Project/nema-room/actions/runs/40367197106): classify/docs success, full verify intentionally skipped, CI gate success |
| Broken docs link | `39910a82df5b152769813df9283765778155001a` | [40367366177](https://github.com/Nema-Project/nema-room/actions/runs/40367366177): classify success, docs failure, full verify skipped, CI gate failure |

These prove check behavior, not repository-required-check enforcement. One disposable PR was reused for both states to avoid unnecessary branches and runs.

Initial implementation head `2bdc6a0908c5ff1ae1c3abe7e9b4a4a8088de891` ran [full CI 40366935183](https://github.com/Nema-Project/nema-room/actions/runs/40366935183) and [nonpublishing PR desktop builds 40366935185](https://github.com/Nema-Project/nema-room/actions/runs/40366935185). Final results and post-review head are recorded at handoff.

The GitHub connector has no workflow-dispatch operation and the local CLI has no usable authentication. `verify_full=true` manual dispatch is deferred to the post-merge/admin handoff. PR desktop builds are not evidence of release-only source collection, staged-payload upload/validation, or publication asset-set collection: those stages remain tag-only. No production tag was created to exercise them.

## Independent review and decisions

The complete targeted Node suite passed **28/28**, and actionlint passed after fixes. One fresh-context whole-branch review covered base `d92f95b` through `2bdc6a0`. It found a moved-tag publication gap and a Pages URL resolution defect. Both were fixed in one pass with failing regression tests first, then passing tests. The actual publication shell is exercised against a temporary Git remote and a local GitHub CLI stand-in: moving the tag during upload prevents the public transition. The same test fails against the pre-fix workflow. Remote checks reduce the race window; GitHub provides no atomic compare-tag-and-publish operation, so deliberate concurrent writer interference remains outside the approved threat model.

Execution rulings:
- Provider skill helper scripts were unreadable; equivalent task briefs, ledger and RED/GREEN logs were maintained directly. Cost: manual bookkeeping.
- Used a separate worktree on latest main to preserve the older original checkout. Cost: a second workspace/dependency installation.
- Restricted lightweight docs/site paths to explicit document/asset extensions. Executable/unknown paths run full verification. Cost: extra CI for new asset types.
- Kept npm's synchronization of three stale workspace version fields while adding the pinned YAML parser; no other dependency versions were upgraded. Cost: small lockfile metadata diff.
- Used a Node 22 container with init/umask 0022 after diagnosing host-only fixture failures. Cost: an additional full run; original failures remain disclosed.
- Regraded the reviewer's Pages finding from Minor to Important because valid website changes could be blocked and undeployed links could pass; fixed it in the same pass. Cost: project Pages prefix is explicit (`/nema-room/`) and must change if hosting changes.

Review boundaries retained: required-check/private-reporting activation needs real operational evidence; historical or deliberately replaced workflows remain outside scope; manual rehearsal does not prove tag-only source/payload publication validation; native macOS installation, upgrades/recovery and real-model acceptance remain separate; remote URLs, anchors and general Markdown parsing remain outside the focused checker's advertised coverage. These limitations must not be presented as verified acceptance. No deferred Minor findings remain.

## CI-discovered read/write race

The first CI attempt for `df59c83212321b64e2292d181e185fc6ad0dc91d` failed in `apps/hub/test/workpackage.e2e.test.ts`: polling `KnowledgeStore.get` observed missing frontmatter fields during a background update, followed by ENOTEMPTY while cleanup raced with the unfinished Git write. [Run 40368315450, attempt 1](https://github.com/Nema-Project/nema-room/actions/runs/40368315450/attempts/1) correctly failed `CI gate`; it is not passing evidence. Three isolated E2E reruns passed, but a real-store concurrency probe reproduced 39 parse errors across 3,730 reads during 40 normal updates.

Ruling: repair the reproduced underlying read/write race with same-directory temporary files and atomic replacement, including rollback, rather than swallowing schema errors or relying on retries. This is a focused verification-blocking fix, not an application redesign. Preserve existing file permissions and Git rollback behavior; per-file replacement does not promise multi-file transactions or power-loss durability. Cost: one additional storage change and regression in this PR, requiring full CI again.

The regression failed against the old implementation and passed after the fix. Typecheck and 48 focused store/history/workpackage tests passed, including rollback tests. The standalone concurrent-read probe also passes without parse errors after recompilation. A same-SHA failed-job rerun was requested while diagnosing; its result cannot substitute for verification of the fix commit.

Desktop PR run [40368315549](https://github.com/Nema-Project/nema-room/actions/runs/40368315549) passed both native build/smoke jobs on merge commit `6ea28a1ee29da22fd6c2ad50806817ebdc6af25b` (head `df59c83`). Windows NSIS smoke reported passed; macOS staged-runtime smoke succeeded; Publish release was skipped. This precedes the storage fix and is not final-commit desktop evidence.
