# PR #307 spec adjudication, round 2

**Disposition** — 9 HOLDS, including both High findings. The evidence below uses the worktree source. “Original spec” refers to [the spec](../docs/superpowers/specs/2026-11-25-first-run-agent-guidance-design.md) at `42d5e11`, and “revised spec” refers to the same file in this commit. The findings follow `.superpowers/307-fallback-audit.md:3-19`; round 1 recorded the earlier decision boundaries at `.superpowers/307-review-report.md:149-155`.

**NEEDS-CUI** — The proposed wording changes the stated refresh triggers (H2, M6), the permitted remote actions and copy (M3), the zero-workspace card behavior and dismissal key (M7), and the scope of the CLI failure distinction (M9). The respective sections document the choices. The recorded decision and scheduling list is verbatim in the original spec:179-188 and revised spec:189-198.

## H1 — Legacy SIWC readiness

**HOLDS.** Original spec:46-51 and 95 only add a separate legacy check for the non-SIWC modes. `implicitCredentialState` treats any parsed SIWC record as connected. `AuthStore.getAccessToken` requires a non-empty refresh token before proceeding, and `clear(reason)` can save a record with empty tokens. The stored-account path already applies the stricter SIWC predicate. `apps/cli/src/accounts/credentials.ts:159-185,220-226`, `apps/cli/src/direct/authStore.ts:66-72,139,266-288,316-321`.

**Spec change.** Apply `usableSiwcLogin` to the parsed legacy record in readiness. A missing record maps to `missing`. An untrusted or malformed record, wrong mode, or empty refresh token maps to `unusable` and hence `credential_unusable`. Preserve the routing check and its existing errors. Add acceptance coverage for both parsed-but-unusable cases. Revised spec:48,59,99,171,182.

## H2 — Replacement of an online daemon

**HOLDS.** Original spec:90-91,121,125 ties refresh to a false-to-true transition and invalidates responses only after another request. The hub assigns a new connection id, switches `current`, closes the old socket, and emits `connected: true`. The old close handler only emits `false` if that connection was still current. RPC dispatch captures a specific connection. The current event and status snapshot expose only a Boolean to web. `apps/hub/src/daemonSocket.ts:410-442,475-505`, `apps/hub/src/events.ts:13`, `apps/hub/src/uiApi.ts:200`, `apps/web/components/WorkspaceShell.tsx:211-219,230-242`.

**Spec change.** Bind the HTTP metadata to the RPC connection and return 503 if that connection is stale when building the reply. Include connection id in status snapshots and events. On disconnect or replacement, invalidate in-flight results and clear old readiness. Refresh on a new connection even when the Boolean remains true, and accept responses only for the current connection and latest request. The workspace-less view can use the existing status snapshots because it has no event stream. Revised spec:92-97,126,130,172,183-184. `apps/web/lib/useHubEvents.ts:47-64`.

**NEEDS-CUI (D-4).** The connection change becomes an explicit refresh trigger in addition to the recorded false-to-true trigger. Revised spec:125-126.

## M3 — Action policy and dispatch eligibility

**HOLDS.** In original spec:55-62,79-84,97-101,128-132,143, an optional `account` serves several roles, the redacted fallback offers `nema doctor`, the install link is unconditional, and D-9 withholds commands from nonowners. The current hub middleware checks session identity and the existing Components RPC route passes through without a daemon-owner check. Default routing can find zero enabled accounts. In the #167 design, D-5 identifies a daemon's owner and D-6 uses that owner's workspace membership, repository possession and the one-task constraint for dispatch. The viewing user may therefore be eligible to use a daemon owned by another member. `apps/hub/src/app.ts:122-133,147`, `apps/hub/src/components.ts:82`, `apps/cli/src/routing/index.ts:166-179`, `docs/superpowers/specs/2026-11-24-remote-hub-multiuser-design.md:95-97`.

**Spec change.** The hub supplies `access` as `full`, `owner_unknown` or `non_owner`. A full reply can lack an account, including for `not_installed` and `no_enabled_account`. Full replies use the state and account metadata to choose setup actions. Redacted replies may show status, contact guidance and the general guide. Future workspaces aggregate readiness over eligible online daemons, including those owned by other members. Revised spec:57,64,69,97-105,133-137,148,183-184.

**NEEDS-CUI (D-5/D-9).** The proposed redacted policy removes the former doctor fallback, withholds the direct install link and configuration actions, and replaces the unconditional nonowner message with contact guidance. The presence of an eligible daemon determines whether a future workspace is missing one. Revised spec:136-137,148.

## M4 — Claude executable with no enabled account

**HOLDS.** Original spec:39-44,55-62 defines no enabled account for Codex only. When `accounts.json` is absent, `loadRoutingAccounts` builds one implicit account, and `implicitAccount` takes its adapter from the current config. A legacy Claude token therefore supplies no Claude account while Codex is selected. The default branch filters enabled accounts by adapter and chooses by order then id. `apps/cli/src/routing/accountSet.ts:40-55`, `apps/cli/src/accounts/implicit.ts:74-90`, `apps/cli/src/routing/index.ts:166-179`.

**Spec change.** An unreadable account list yields `unknown` for both runtimes. With a readable list, Claude's executable check takes precedence over account checks. Both runtimes use `not_signed_in` with `no_enabled_account` when their account check finds none. Evaluate the switch suggestion against the current account list without synthesizing an alternate account or simulating a config change. Revised spec:44,55-69,135,182.

## M5 — Automatic Composer routes

**HOLDS.** Original spec:44,111,176 keys the hint to the apparent default route and omits explicit automatic routing and auto bindings. The request serializer emits `routing: "auto"` without `accountId`. The resolver recognizes thread and workspace bindings with value `auto` and handles automatic routing ahead of the default branch, including refusal when the switch is off. `apps/web/lib/hub.ts:247-262`, `apps/cli/src/routing/index.ts:120-129,156-179`.

**Spec change.** Limit the hint to the default branch. Suppress it for message-level auto and effective auto bindings, including with the switch off. Preserve the conditional hint when bindings cannot be read and there is no explicit choice. Add acceptance coverage for both binding scopes. Revised spec:115,184. `apps/web/lib/useAccounts.ts:20-26,59-64`.

## M6 — Probe cache ordering and desktop sign-in completion

**HOLDS.** Original spec:121-125 allows a standalone forced probe and success-only caching, with no rule for an older success arriving afterward or for clearing an existing cached success when force fails. Those races follow from the proposed cache rules. The shipped detector starts the version runner directly on each call. Separately, desktop starts login as an asynchronous job and returns 202. SIWC saves credentials before returning from its login operation. The UI observes job success through polling or the initial status read. `apps/cli/src/agentClis.ts:27-46`, `apps/local/src/settings.ts:41-47,210-228,282-290`, `apps/cli/src/direct/siwc.ts:471-477`, `apps/web/components/ModelSettings.tsx:78-85,137-146`.

**Spec change.** Force invalidates the old cache at launch. Only the latest started probe may populate it, and failure leaves it empty. Ordinary requests share the latest in-flight probe for the command. Recheck on the first observation of a successful desktop SIWC login job, including on settings reopen. Specify job kind and instance metadata on the existing status response so repeated reads and successful probe jobs can be distinguished from a new login. Revised spec:127-130,182,184. `apps/local/src/settings.ts:210-222,317-322`.

**NEEDS-CUI (D-4).** A successful desktop SIWC job becomes an explicit refresh trigger. Its completion is observed through the existing job polling path. Revised spec:125,127.

## M7 — Empty-state lifecycle and temporary dismissal

**HOLDS.** Original spec:135-138 leaves the card until workspace creation and keys temporary dismissal on the reason alone. Original spec:148-151 says all guidance disappears at ready. The reason is optional and stripped from redacted replies in original spec:79-81,97-101. The shipped shell has an empty-state placeholder. This finding concerns the proposed card and dismissal contract. `apps/web/components/WorkspaceShell.tsx:521-531`.

**Spec change.** A zero-workspace card becomes a passive status summary at `ready` or after “never prompt again,” and disappears once a workspace exists. The banner and Composer hint retire immediately. Temporary banner dismissal keys on `(runtime, state, reason ?? null)`, so a state change can surface a new step even in a redacted reply. Revised spec:112,140-143,153-157,184.

**NEEDS-CUI (D-6).** The proposal resolves the flow's broader disappearance promise in favor of retaining a passive card until workspace creation and changes the reason-only dismissal key. Revised spec:141-143,155-156.

## M8 — Doctor's stored-account blind spot

**HOLDS.** Original spec:130 recommends `nema doctor` in the stored-account and no-account cases. The command loads `config.json` and passes its adapter, auth mode and model plus the legacy homes into `runDoctor`. Its credential checks look at the legacy SIWC or Codex login and the legacy Claude token. Routing's stored-account diagnostic directs the user to settings. A healthy legacy login can coexist with a missing stored credential. `apps/cli/src/index.ts:73-100`, `apps/cli/src/doctor.ts:59-102`, `apps/cli/src/claude/token.ts:30,66-72`, `apps/cli/src/routing/index.ts:257-277`.

**Spec change.** Direct stored-account fixes to desktop account settings or the guide, depending on deployment. Qualify doctor as supplemental environment and legacy-credential diagnosis and explicitly state that it cannot check the selected stored account. Revised spec:133-137,184.

## M9 — Components compatibility

**HOLDS.** Original spec:70,141 promises to preserve the Components experience and fix its error conflation. `AgentCliStatus` exposes only `installed` as the outcome, every runner exception returns false, and the Components row renders the same missing label and install link for every false value. Sharing a richer executor alone cannot change that rendering. `apps/cli/src/agentClis.ts:9-19,27-44`, `apps/web/components/ComponentsSettings.tsx:494-503`.

**Spec change.** Apply the ENOENT, timeout and other failure classification to `agents.readiness`. Keep `agents.detect` and the Components rendering compatible, and cover the legacy mapping in the acceptance criteria. Revised spec:57,72,146,182.

**NEEDS-CUI (D-7).** The proposal narrows the phrase about fixing error conflation to the readiness endpoint. A distinct timeout display in Components would be a separate contract and UI change. Revised spec:146, with the recorded separate-endpoint decision at revised spec:195.

## Verification

- Ran the CI documentation command, `node scripts/ci/docs-check.mjs "$paths_file"`, with a temporary JSON array containing the spec and this report. Result was 0 errors. The script covers local links, so the `models` anchor was checked directly. `.github/workflows/ci.yml:71-87`, `scripts/ci/docs-check.mjs:35-48,71-76`, `docs/guide.en.md:191`.
- Checked docs classification, the unchanged recorded decision list, all nine report sections, and whitespace with `git diff --check`. Application and native acceptance checks were skipped for this documentation-only change. `scripts/ci/policy.mjs:28-33,48-54`, `AGENTS.md:64`, revised spec:189-198.
