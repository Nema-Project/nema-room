# P0 Release Assurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver P0-01/P0-02/P0-05: exact-commit release verification, an enforceable PR check, and private security reporting.

**Architecture:** Extract one reusable full suite, wrap it with a path-aware PR gate, and invoke it unconditionally for tag releases. Keep repository-setting activation separate from code changes and record operational evidence. Reuse existing desktop publication validators.

**Tech Stack:** Node.js 22, npm workspaces, node:test, Git, GitHub Actions, actionlint, GitHub rulesets/private vulnerability reporting.

**Spec:** [Approved design](../specs/2026-10-26-p0-release-assurance-design.md). Approved by the user on 2026-10-26; plan awaits review.

## Global Constraints

- Scope: ROADMAP P0-01, P0-02, P0-05. P0-03 and P0-04 remain unchanged.
- Keep the current npm/Node 22 workflow, pinned action SHAs, platform checks, full Ubuntu tests/web/Compose checks, and desktop release validators.
- Ordinary main pushes still do not repeat the full suite.
- No automatic tags, production releases, real advisories, or PR merges during verification.
- Stable required check name: "CI gate". Manual CI dispatch always runs the full suite.
- Fork PRs must not receive secrets or use pull_request_target to execute their code.
- Failed, cancelled, skipped, or absent required verification cannot publish.
- Keep README.md and README.en.md identical.
- Preserve existing ruleset protections and bypass policy; actual activation requires available administration access.
- Use isolated branches, refresh base/head before writes, and preserve other contributors' changes. Every implementation commit includes Co-authored-by: Codex <noreply@openai.com>.
- The rollout commit is recorded after deployment; pre-rollout tags are unsupported and outside the new workflow's enforcement guarantee.
- No implementation begins before plan review. An unavailable executor blocks local execution, not permission to invent passing results.

## Review Focus

1. Renames from executable paths into docs, arbitrary filenames, and very large diffs must not bypass full checks — Task 1.
2. Classifier failure, cancelled dependencies, and unexpected skipped reusable jobs must fail the stable gate — Tasks 1 and 2.
3. Annotated tags, moved refs, and non-main commits must not substitute a different checked-out commit — Task 3.
4. Fork permissions and manual/nonpublishing runs must retain safe behavior without secrets — Tasks 2 and 3.
5. Admin-only access to a reporting page and an absent required check must not be mistaken for operational activation — Tasks 4 and 6.

## File map and execution order

New:
- scripts/ci/policy.mjs, policy.test.mjs: pure classification and result policy.
- scripts/ci/changes.mjs, changes.test.mjs: complete Git diff collection and CLI output.
- scripts/ci/docs-check.mjs, docs-check.test.mjs: focused changed-document/link/security checks.
- scripts/ci/workflows.test.mjs: parsed YAML wiring regression tests.
- scripts/desktop/release-commit.mjs, release-commit.test.mjs: commit resolution and main ancestry.
- .github/workflows/verify.yml: reusable complete suite.
- docs/reviews/2026-10-26-p0-release-assurance.md: execution and activation evidence.

Modify:
- .github/workflows/ci.yml and desktop-release.yml.
- package.json/package-lock.json only if adding a direct YAML parser for structural workflow tests (use npm install --save-dev --save-exact yaml; do not upgrade other dependencies).
- SECURITY.md, CONTRIBUTING.md, .github/ISSUE_TEMPLATE/config.yml; delete .github/ISSUE_TEMPLATE/security.yml.
- README.md, README.en.md, README.zh.md, README.ja.md and affected docs/guide.{en,zh,ja}.md security references.
- scripts/desktop/RELEASE.md, AGENTS.md CI guidance, CHANGELOG.md [Unreleased], ROADMAP.md.

Tasks 1 → 2 → 3 share interfaces. Task 4 can follow independently; Task 5 verifies the integrated branch; Task 6 is the post-merge operational checkpoint. Each task gets a focused commit. Do not include unrelated application refactors.

### Task 1: testable classification, gate policy and lightweight checks

**Interfaces:**
- policy.mjs exports classifyPaths(paths: string[]): 'docs' | 'full'.
- policy.mjs exports gatePasses({mode, classify, docs, verify}): boolean; result values are GitHub job result strings or undefined.
- changes.mjs exports changedPaths({cwd, base, head}): Promise<string[]> and CLI `node scripts/ci/changes.mjs <base-sha> <head-sha>`; emits mode to GITHUB_OUTPUT and full path array to a temporary JSON file for the docs checker.
- docs-check.mjs exports checkDocs({root, paths}): Promise<string[]> (errors), with CLI accepting the path-list JSON file. Nonempty errors exit 1.

- [ ] Write failing node:test cases with these assertions:
  - classifyPaths(['README.md','docs/guide.zh.md']) === 'docs'.
  - classifyPaths(['README.md','apps/hub/src/app.ts']) === 'full'.
  - classifyPaths(['AGENTS.md']), ['CLAUDE.md'], ['docs/AGENTS.md'], ['vendor/rules.md'], ['package-lock.json'], ['.github/workflows/ci.yml'] each return 'full'.
  - ['site/index.html'] and ['.github/workflows/pages.yml'] return 'docs', retaining the approved allowlist.
  - Empty/invalid/unrecognized input is not an opportunity to skip verification: empty list selects full; malformed list throws.
  - gatePasses({mode:'docs', classify:'success', docs:'success', verify:'skipped'}) is true.
  - Full mode passes only with classify/docs/verify all success; docs mode permits verify success or intentional skipped. Every failure/cancelled/missing result needed for the chosen mode returns false.
- [ ] Write Git fixture tests for changedPaths: complete diff of more than 300 files; Unicode/spaces/newlines in names; deletion; executable-to-doc rename. Use `git diff --no-renames --name-only -z <base> <head>` so a rename contributes deletion and addition paths. Use execFile argument arrays, validate commit IDs, and never interpolate filenames into shell.
- [ ] Write docs-check fixture tests: relative link resolves from document directory; root-relative repo link; missing target fails; fragment-only/external URLs and code fences are not treated as files; deleted documents are skipped, but links in changed docs to deleted files fail. Scan inline Markdown links in changed Markdown files, not the entire historical docs tree; report unsupported syntax without claiming complete link coverage. Add changed HTML local href/src checks for site files without fetching remote resources.
- [ ] Add security-routing consistency cases: no public security issue form/link in active entrypoints after migration; both English READMEs byte-identical. Enable this final-state assertion with Task 4, not before migration.
- [ ] Run `node --test scripts/ci/policy.test.mjs scripts/ci/changes.test.mjs scripts/ci/docs-check.test.mjs`; expect initial FAIL from missing exports.
- [ ] Implement the interfaces with built-in Node modules. Unknown paths use full checks. Git fetch/parse errors fail classification, rather than reporting docs.
- [ ] Rerun the same command; expect PASS. Commit focused helper code/tests.

### Task 2: reusable suite and stable PR gate

**Interfaces:**
- verify.yml: workflow_call with required string input checkout_ref; jobs workflow-lint, platform, test retain existing checks. Every checkout uses checkout_ref and persist-credentials:false.
- ci.yml jobs: classify, docs, verify, gate. gate display name is exactly "CI gate".
- Consumes Task 1 policy, changedPaths and docs checker.

- [ ] Add direct YAML parser only if no direct supported parser is already available. Write workflows.test.mjs using parsed YAML, not whole-file substring checks. Assert CI has unfiltered pull_request and workflow_dispatch; no pull_request_target; stable gate uses always(); verify calls ./ .github workflow via the actual valid path `./.github/workflows/verify.yml`; verification retains Windows/macOS matrix and Ubuntu full test/web/Compose steps.
- [ ] Run `node --test scripts/ci/workflows.test.mjs`; expect FAIL for missing workflow/contracts.
- [ ] Extract existing jobs into verify.yml without dropping commands, limits, pinned actions, Compose teardown, or build-before-tests ordering. Add Task 1/3 helper and workflow tests to its Ubuntu test job once those files exist.
- [ ] Replace ci.yml workflow paths-ignore with classifier. Checkout complete history or explicitly fetch immutable event base/head SHAs; classify the complete base-to-head diff. For PR execution verify checkout_ref is the GitHub PR merge SHA (github.sha); classification uses pull_request.base.sha/head.sha. Do not confuse this with release verification.
- [ ] On workflow_dispatch, select full directly. Run docs checker on all current active documentation entrypoints for dispatch; for PRs use changed paths. Both branches must set explicit mode.
- [ ] Add lightweight docs job and full verify call conditioned on full mode. Transfer changed-path data safely via output/artifact, not shell expansion; artifact failure fails the job. Keep the path list complete.
- [ ] Make gate always run after all three jobs, invoke gatePasses with explicit needs results, and exit 1 unless allowed. Use read-only contents permission; no inherited secrets; concurrency scoped to the wrapper/ref so tag verification cannot cancel it.
- [ ] Run helper/structure tests and `actionlint -color`; expected PASS and exit 0. Review fork execution using a read-only token configuration; do not add a privileged trigger to solve checkout problems.
- [ ] Commit reusable workflow and PR gate. Workflow tests must catch mutation of a required job result/condition rather than only a matching check name.

### Task 3: exact-commit publication prerequisite and safe rehearsal

**Interfaces:**
- release-commit.mjs exports resolveReleaseCommit({cwd, ref, mainRef}): Promise<string>. Ref is resolved with git rev-parse --verify <ref>^{commit}; require git merge-base --is-ancestor <resolved> <mainRef>, return full SHA.
- CLI: `node scripts/desktop/release-commit.mjs <ref> <main-ref>`; writes SHA to stdout, fails nonzero for invalid or off-main refs.
- desktop-release.yml plan outputs commit and verification_required. verify consumes plan.commit via verify.yml checkout_ref.
- Add workflow_dispatch boolean input verify_full, default false; true is a nonpublishing full rehearsal. Tag events always require full verification.

- [ ] Write Git-fixture tests: lightweight and annotated local tags on main resolve to the same SHA; an ancestor resolves; off-main tag, missing main ref, malformed ref fail. All tags exist only in temporary local repositories.
- [ ] Extend workflow structural tests: tag preflight produces immutable commit; all tag build/publish checkouts use plan.commit; build depends on plan+verify and blocks non-success when verification_required=true; publish requires successful verify and build. Manual verify_full=false permits deliberate verify skip for build only, never publication.
- [ ] Run release-commit and workflow tests; expect FAIL before implementation.
- [ ] Implement release-commit helper and preflight fetch of origin/main. Compare resolved tag commit with the triggering event commit to reject a moved tag. For branch/PR/manual nonrelease builds use their immutable triggering SHA without requiring main ancestry.
- [ ] Add verify reusable call with required checkout_ref. Put expensive builds after successful required verification. Explicitly handle the manual intentionally-skipped verify path; never use unconditional success/continue-on-error to bypass it.
- [ ] Keep publish tag-only, directly dependent on successful verification and all build jobs; preserve every existing payload, source, license, version, changelog and asset validator. checkout_ref must also reach the publish checkout and recorded build metadata.
- [ ] Run `node --test scripts/desktop/release-commit.test.mjs scripts/ci/workflows.test.mjs scripts/desktop/release.test.mjs scripts/release-notes.test.mjs` and actionlint; expect PASS.
- [ ] Add a fixture mutation test changing checkout_ref to main and removing verify from publication dependencies; policy verification must reject both mutations. Failure/cancelled/skipped/missing verification cases must never satisfy publication preconditions.
- [ ] Update RELEASE.md: full tag verification, verify_full rehearsal, accurate installer-only assets and Windows NSIS/macOS staged-runtime coverage. Document pre-tag rollout ancestry check using the recorded deployment commit; until deployment, explicitly state rollout not activated. No placeholder SHA may be treated as valid.
- [ ] Commit release gate and its runbook.

### Task 4: private reporting entrypoints and honest support policy

**Interfaces:**
- Intended private URL: https://github.com/Nema-Project/nema-room/security/advisories/new.
- .github/ISSUE_TEMPLATE/config.yml contact link replaces public security.yml.
- docs-check final-state security assertions become active in this task.

- [ ] Read current enabled status using a supported GitHub admin tool/API if available; GET /repos/Nema-Project/nema-room/private-vulnerability-reporting is the intended REST query. A 403/404 or unsupported connector endpoint means unknown, not disabled. Record safe evidence only.
- [ ] If access permits, activate the selected feature using PUT on that endpoint or authenticated repository settings, and re-read enabled status. Scope authorization is from the approved spec; no changes to unrelated security settings.
- [ ] Verify the private form using a legitimate non-admin reporter session if available, without filing an advisory. If unavailable, record that validation as blocked; do not invent an account or treat the admin page as reporter evidence.
- [ ] Add failing docs-check fixtures for remaining public security issue links, stale private-repo/no-desktop-release claims in active security guidance, and mismatched English READMEs. Run docs-check tests; expect FAIL before migrated fixtures/entrypoints are corrected.
- [ ] Remove security.yml. If the enabled private channel is verified, point chooser to the private URL. If channel availability is unknown, point chooser to SECURITY.md, which describes pending availability and prohibits sensitive public submissions; keep the target private URL documented as intended, not live. This fallback implements the spec's unavailable-channel behavior.
- [ ] Update SECURITY, CONTRIBUTING, four READMEs and affected guide sections consistently: supported desktop/main-source policy, safe report contents, private redacted reproductions, no credentials/user data, no invented security email, no promised historical release backports.
- [ ] Run docs-check against the changed docs and `node --test scripts/ci/docs-check.test.mjs`; expect PASS. Check translated meaning manually. Record activation separately from documentation completion.
- [ ] Commit security routing and documentation. Leave P0-05 blocked if enabled-status or reporter-access evidence is missing.

### Task 5: integrated review and nonpublishing verification

**Files:** CHANGELOG.md, ROADMAP.md, AGENTS.md, CONTRIBUTING.md, docs/reviews/2026-10-26-p0-release-assurance.md; existing implementation PR.

- [ ] Refresh upstream/base/head; reconcile concurrent workflow or documentation edits before final verification. Read AGENTS.md and PR template again.
- [ ] Update active CI documentation to describe stable gate/lightweight docs path; add [Unreleased] change notes. Update ROADMAP only to implementation/verification status actually reached.
- [ ] Run targeted node:test commands from Tasks 1–4 and actionlint. Run the preserved full suite through the implementation PR CI, with exact commit/run links recorded. Local equivalent, if needed: npm ci; npm run typecheck; npm test -- --maxWorkers=2; hub/cli builds; web lint/build; setup check and Compose readiness/teardown as in verify.yml.
- [ ] Use disposable PRs based on the implementation branch to exercise one docs-only success and one intentional failure (e.g. broken local documentation link); inspect actual "CI gate" conclusions. Do not mutate application behavior to generate a failure. Close disposable PRs after recording results.
- [ ] Exercise a full nonpublishing desktop rehearsal when workflow_dispatch is available. GitHub may require the workflow to exist on default branch first; if so, defer dispatch to Task 6 and record that dependency. Never create a release tag to circumvent dispatch availability.
- [ ] Confirm exact checkout SHA in verification/build logs; publication is skipped on rehearsal; existing artifact/payload checks remain intact. Record Windows packaged and macOS staged-runtime evidence separately.
- [ ] Request one whole-branch review of implementation and failure cases. Resolve actionable feedback, rerun affected checks, then commit evidence/docs using the repository PR template.
- [ ] Report implementation-ready status and the concrete merge/activation prerequisites. Do not merge or claim P0 closure here.

### Task 6: post-merge activation and operational closure

**Files:** docs/reviews/2026-10-26-p0-release-assurance.md, scripts/desktop/RELEASE.md, ROADMAP.md; repository settings.

**Prerequisite:** separately authorized merge of verified implementation. If no authorization, stop at the ready-to-activate handoff; preceding implementation work remains complete.

- [ ] Record actual main deployment SHA and verify the deployed workflows match reviewed changes. Run manual full CI on that SHA; finish any deferred nonpublishing rehearsal before closure.
- [ ] Read current effective rulesets and traditional protection where accessible. Save before state. If access is missing, provide exact manual settings below and mark P0-02 blocked.
- [ ] Discover the successful "CI gate" check context and GitHub Actions app ID from actual check-run metadata. Add required_status_checks with that context/integration and strict_required_status_checks_policy=true to the existing main ruleset, preserving all unrelated rules and bypass actors. Do not replace the entire ruleset from stale data.
- [ ] Read back settings. In disposable PRs, verify failing/missing checks prevent merging and passing up-to-date checks satisfy requirements; inspect mergeability without attempting a merge. Close test PRs.
- [ ] Reconfirm private reporting state and non-admin form access, or carry forward the exact blocker from Task 4. No fake advisory is necessary.
- [ ] Fill in the rollout commit in RELEASE.md and final evidence in the review record. Mark each ROADMAP item done only when its own operational acceptance passes; P0-03/04 stay open.
- [ ] Commit final evidence through a normal PR with Codex attribution. Do not create a release.

**Manual activation handoff if administration is unavailable:** repository Settings → Rules → main ruleset: preserve PR rule, require observed GitHub Actions "CI gate", require up-to-date branch; repository Settings → Security: enable private vulnerability reporting. Provide observed current values and requested deltas, not a claim that settings are already active.

## Self-review and handoff

- Spec coverage: exact-commit/full-suite and historical-tag boundary → Task 3; stable PR gate and classification → Tasks 1–2; protections → Task 6; private reporting → Task 4; evidence and honest completion → Tasks 5–6.
- Interfaces: checkout_ref is shared across both callers; plan.commit is the sole tag checkout input; mode/result policy is shared by classifier and gate tests.
- Review Focus conditions each have tests or explicit operational checks in their owning tasks.
- Implementation tests are behavior/policy tests plus parsed workflow wiring and live Actions evidence, not substitutes for one another.
- Current execution/admin/reporter capability must be checked at execution time. No checks in this document have been run merely by writing the plan.
- Recommended execution: Native (inline), because Tasks 1–3 share policy/workflow interfaces and a final independent review can assess the integrated publication boundary. Subagent-driven remains available if the user prefers task-by-task independent review.
