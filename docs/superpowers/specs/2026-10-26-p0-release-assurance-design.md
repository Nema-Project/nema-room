# P0 release assurance design

Date: 2026-10-26 (Asia/Tokyo)
Status: Draft for design approval; implementation has not started.
Baseline: main d07d256dee32b65243f0f96cc8f6b4b74edf9711.
Scope: ROADMAP P0-01, P0-02, P0-05.

## Intent and selected approach

Make publication depend on full verification of the exact released commit, enforce a stable PR check without making documentation-only PRs wait forever, and replace the obsolete public security-issue route with verified private reporting.

The user selected approach A: deliver these three related GitHub release safeguards together. Approach B would also include real-model semantic acceptance (P0-03) and native upgrade/recovery acceptance (P0-04); it was not selected because those require separate model credentials, disposable data, and Windows/macOS environments. Those items remain open.

Implementation choices below are the designer's recommendations, subject to approval. Keep the current npm/Node 22 workflow, pinned action SHAs, platform checks, full Ubuntu tests/web/Compose checks, and desktop release validators. Do not redesign application code, add automatic tags, publish a release, or merge a PR as part of verification.

## Observed current behavior

- ci.yml runs on selected PR paths and manual dispatch, not main pushes. Workflow-level paths-ignore suppresses the entire workflow for documentation PRs.
- Desktop release publication depends on packaging jobs and payload validation, but not the application CI suite. The v0.1.2 application test run failed while its release run succeeded.
- The active main pull request ruleset was previously observed to require a PR without required status checks. Re-read it before implementation; the traditional protection endpoint was inaccessible to the integration. Do not infer complete effective protection from a single endpoint.
- SECURITY.md and both security issue entrypoints still describe a private repository and route users to public issues. The repository is now public.
- scripts/desktop/RELEASE.md contains outdated first-release and ZIP-smoke claims. Update these against current workflow behavior.
- The selected executor still fails to start. GitHub access supports design work, but local tests and administrative capabilities are not established.

## P0-01: one suite, verified release commit

Extract the existing full verification jobs into a reusable workflow. Call the same suite from the PR wrapper and desktop tag release workflow, using local workflow references so the definition is versioned with the caller. Preserve the existing checks; this change must not silently shrink test coverage.

For tag publication:
1. Resolve the tag to a commit (including annotated tags), record its SHA, and require that it is reachable from fetched origin/main. A main ancestor is eligible only if it includes the deployed gate implementation; a commit on an unmerged branch is not. Record the gate rollout commit in the release runbook and require supported release targets to descend from it.
2. Run the complete reusable suite against that exact commit. Do not substitute a PR merge commit, another main commit, a green check by name, or a previous build artifact.
3. Require successful verification and existing version/changelog preflight before expensive installer builds. The publish job must depend on successful verification as well as all build and payload-validation jobs.
4. Failed, cancelled, skipped, or absent required verification cannot publish. No continue-on-error or success fallback.
5. Preserve strict version matching, changelog validation, license/source validation, asset checksums, draft handling and refusal to overwrite a published release.

Trust boundary: GitHub executes the workflow stored at the tagged commit. A new workflow cannot retroactively protect old commits. Tags pointing before the gate rollout commit are unsupported, must not be created, and are outside this workflow's enforcement guarantee. Existing historical tags/releases are untouched. This batch does not claim protection against a repository writer deliberately tagging old or modified workflows; organization-wide immutable policy would be a separate project. The release runbook must check rollout ancestry before creating a tag, and acceptance is scoped to commits containing the deployed gate.

The modest extra cost is one full verification per release tag. This deliberately avoids querying old runs and reasoning about stale status provenance. Ordinary main pushes still do not repeat the full suite. Existing manual desktop builds remain nonpublishing; a release rehearsal may request full verification without creating a tag or release.

Use least-privilege permissions: verification is read-only; only the existing publication job receives contents:write. Fork PRs must not receive secrets or use pull_request_target to execute their code. Reusable workflow permissions cannot exceed the caller.

## P0-02: a stable merge gate

The PR workflow starts for every PR. Replace workflow-level path exclusion with an explicit change-classification job and one final stable check named "CI gate".

- Documentation-only PRs can skip expensive application jobs but must complete the classifier and lightweight documentation validation.
- Initially preserve the established lightweight allowlist: root Markdown, docs/**, site/** and the Pages-only workflow. Root/embedded agent instructions and any executable workflow, script, dependency, source, or vendor-product change not explicitly allowed take the full path. A mixed PR takes the full path.
- Classification uses the complete base-to-head PR diff, including both names of renamed files. No silent API pagination or file-count truncation. Uncertain classification runs the full suite; an unrecoverable classifier failure blocks the gate.
- The lightweight validator verifies affected repository links and security-routing consistency; implementation may use a small focused checker instead of introducing a general documentation framework.
- Manual CI dispatch always runs the full suite.
- The final gate runs even after dependency failure and explicitly checks all required results. It accepts intentional heavy-job skips only when successful classification selected documentation-only and the lightweight check passed. Full-suite failure/cancellation/skips or classification errors fail the gate.
- Concurrency cancels superseded PR runs, not unrelated tag verification.

After the check exists and has run successfully, configure the default-branch ruleset to require "CI gate" from GitHub Actions, retaining existing PR requirements and bypass policy. Bind the app identity using the observed GitHub Actions integration, not an invented ID. Require branches to be up to date before merging. Do not require variable matrix names or filtered desktop jobs.

Rollout order: prepare and verify workflow PR; after its separately authorized merge, confirm the gate on the default-branch workflow; apply the additive ruleset change and verify effective settings. No enforcement toggle before the check is available. Record the exact before/after ruleset and check context.

Repository settings are a concrete delivery step, not a claimed effect of YAML changes. Inspect available administrative access. If unavailable, provide exact settings instructions and record P0-02 as blocked pending activation. Do not overwrite unrelated protections.

## P0-05: private security reporting

The intended channel is GitHub private vulnerability reporting at https://github.com/Nema-Project/nema-room/security/advisories/new.

- Inspect whether private reporting is enabled; enable it with authorized repository administration access if available.
- Verify access to the private report form with an appropriate non-admin reporter session when available. Do not submit a fabricated advisory or expose a real vulnerability merely to test the channel.
- Remove the public security issue form and replace its chooser entry with a contact link to private reporting.
- Update SECURITY.md, CONTRIBUTING.md, affected security references in all four READMEs and three language guides, and the release checklist. Keep README.md and README.en.md identical.
- State current distribution/support policy: desktop releases and main source exist; fixes land on main and are distributed in a subsequent release; no promise to maintain old release lines. Do not make unverified claims about signatures or installers.
- Document safe report contents: affected version/commit, OS, impact and redacted reproduction in the private channel; never credentials or actual user data.
- Do not invent an email address or use public issues as the fallback for sensitive reports. If private reporting cannot yet be activated, explicitly mark it unavailable and permit only a non-sensitive request for a private contact route.

Prefer activating and verifying private reporting before merging documentation that presents it as available. When configuration access or reporter validation is missing, retain an honest blocked status and a ready-to-apply change; a URL alone is not evidence of a working channel.

## Acceptance and evidence

Record results in docs/reviews/2026-10-26-p0-release-assurance.md with commit SHAs, run URLs, settings evidence, and blocked checks.

| Area | Required evidence |
| --- | --- |
| Release logic | Tests for lightweight/annotated tags, main ancestor success, off-main rejection; exact checkout SHA; a failed/cancelled/missing verification result cannot reach publication |
| Workflow structure | actionlint plus focused policy tests verifying reusable-suite dependency and gate result handling |
| PR behavior | Documentation-only PR returns a successful gate without heavy checks; application/workflow PR runs full suite; a controlled failed-check case returns a failing gate |
| Merge enforcement | Effective required check and up-to-date rule are recorded; a disposable failing PR is blocked and a passing PR satisfies checks, without actually merging it |
| Private reporting | Enabled setting and form accessibility evidence, or explicit blocked status; no public security issue form remains |
| Documentation | Valid relevant links, translated security references, identical English READMEs, accurate release checklist |

Negative verification must never create a production release or push a release tag. Use fixture tests and nonpublishing workflow rehearsal on disposable branches/PRs; close temporary PRs after capturing evidence. Prefer one controlled rehearsal to repeated expensive runs. Do not mark an item complete from tests that merely search for a string without exercising its policy.

P0-01 is complete only after verified workflow behavior is deployed and its exact-commit/no-publish failure evidence is recorded. P0-02 additionally requires actual repository enforcement. P0-05 additionally requires an available private channel. Before merge/activation, label implementation complete separately from operational closure. P0-03 and P0-04 remain unchanged.

## Delivery and remaining choices

One spec and one implementation plan cover this batch. Use focused commits and a reviewable PR, with Codex co-author trailers. Update ROADMAP with partial progress and evidence, not blanket completion. Actual merge and release publication are not included in this design approval.

The builder may choose helper filenames, fixtures and reusable-workflow job IDs while preserving the contracts above. Repository-settings activation for the specified additive protections and private reporting is part of the selected scope, subject to available permissions; unrelated settings must not change. Missing executor/admin/reporter access is an operational blocker to record, not grounds to fabricate acceptance.

## Builder review

A fresh reviewer identified the historical-tag trust boundary. The design now explicitly restricts supported release targets to descendants of the gate rollout commit and limits enforcement claims to workflow-bearing commits; existing historical releases remain unchanged. No remaining product choice requires expanding the selected scope.
