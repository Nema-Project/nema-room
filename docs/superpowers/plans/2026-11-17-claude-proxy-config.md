# Claude Proxy Config Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were given authorizes it; otherwise leave changes for supervisor review.

**Goal:** A `proxyEnv` config mode (`off` by default, `forward` opt-in) lets the Claude Code child inherit only the eight proxy variables from the daemon env. An API-connection failure is reported as such, and when the mode is off the message points at `proxyEnv`.

**Architecture:** `config.ts` owns the optional enum field. `nema config` exposes it. `ClaudeCodeAdapter.run` passes the mode from the config it already loads into `prepareClaudeLaunch`, which adds the proxy set and echoes the mode on `ClaudeLaunch`. `events.ts` keeps the `result` text of a failed run, and a pure classifier chooses the connection message in `execute`.

**Tech Stack:** Node 22, TypeScript, zod, Vitest.

**Spec:** [Claude proxy config design](../specs/2026-11-17-claude-proxy-config-design.md).

## Global Constraints

- Absent `proxyEnv` behaves exactly like today, and so does omitting the launch option. `DEFAULT_CONFIG` is unchanged.
- Forward only `HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy`. On win32 only, match names case-insensitively. Copy no other variable.
- Never store proxy values. Never echo `result` text or stderr in a user-visible error.
- `config set proxyEnv off` removes the key, so a downgraded strict-schema build still loads `config.json`.
- No changes to `windowsRuntimeEnv`, `gh.ts`, the `mcp.json` room server env, codex-direct, or `apps/local` settings.
- Tests use temporary `nemaHome` directories and fake `claude` binaries. No real models and no real `~/.nema`.

## Review Focus

- A forwarded name must not override `HOME`, `CLAUDE_CONFIG_DIR` or the token (Task 2). The order is: proxy copy, then `Object.assign`.
- Decoys such as `HTTP_PROXY_EXTRA` and `SSL_CERT_FILE` must be absent under `forward` (Task 2).
- An omitted option must equal `off`, byte for byte, in the env (Task 2).
- Connection classification must not swallow 401/429/`error_max_turns` (Task 3).
- The user-visible message contains no part of the `result` text (Task 3).
- `off` removes the key from `config.json` instead of writing `"off"` (Task 1).

---

### Task 1: Config field and `nema config` surface

**Files:** `apps/cli/src/config.ts`, `apps/cli/src/configCommands.ts`, `apps/cli/src/index.ts`, `apps/cli/test/config.test.ts`, `apps/cli/test/indexCommands.test.ts`.

**Interfaces:** Produce `proxyEnv?: "off" | "forward"` on `NemaConfig`, `type ProxyEnvMode`, and `proxyEnvMode(config): ProxyEnvMode`. Add `proxyEnv` to `CONFIG_KEYS` and `ENUMS`.

- [ ] Add failing tests. In `config.test.ts`: load and save accept absent, `"off"` and `"forward"`; they reject `"on"`, `""` and `true` with a `proxyEnv` issue in `configErrorMessage`; `saveConfig(home, { proxyEnv: undefined })` after `forward` leaves no `proxyEnv` key in the file. In `indexCommands.test.ts`: `set proxyEnv forward` writes the value; `set proxyEnv off` removes the key; `set proxyEnv on` returns 1 and leaves the file byte-identical; `get proxyEnv` prints `off` when absent; and `get` with no key lists `proxyEnv=off`.
- [ ] Run `npx vitest run apps/cli/test/config.test.ts apps/cli/test/indexCommands.test.ts` and confirm that the new cases fail.
- [ ] Implement the schema field and helper. In `configSet`, map `off` to `{ proxyEnv: undefined }`. In `configGet`, print `proxyEnvMode(config)` for this key. Update the help strings at `index.ts:153` and `index.ts:160` to include `proxyEnv (off|forward)`; also add `byokBaseUrl` to the `get` help.
- [ ] Rerun the same command and confirm it passes. Run `npx vitest run apps/local/test/settings.test.ts` to confirm that desktop `configPatch` still refuses unknown keys and keeps working.

### Task 2: Launch option and forwarded set

**Files:** `apps/cli/src/claude/launch.ts`, `apps/cli/src/claude/adapter.ts`, `apps/cli/test/claude/launch.test.ts`.

**Interfaces:** Consume `ProxyEnvMode` and `proxyEnvMode` from Task 1. Produce `CLAUDE_PROXY_ENV_KEYS` (readonly, eight names), the option `prepareClaudeLaunch({ …, proxyEnv?: ProxyEnvMode })`, and `ClaudeLaunch.proxyEnv: ProxyEnvMode`.

- [ ] Add failing tests to `launch.test.ts`, reusing its `options()` helper with a `parentEnv` that holds all eight names, `PATH`, and the decoys `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `FOO` and `HTTP_PROXY_EXTRA`:
  - `forward`: each of the eight is present with its value; no decoy is present; `HOME`, `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` keep their launch values even when the parent sets a proxy; `launch.proxyEnv === "forward"`.
  - `off`: no proxy name is present.
  - Option omitted: the env deep-equals the `off` env, and `launch.proxyEnv === "off"`.
  - A parent with only `https_proxy`: only that key is added.
  - Win32-only (`test.runIf(process.platform === "win32")`): `Http_Proxy` is forwarded under its own casing.
- [ ] Run `npx vitest run apps/cli/test/claude/launch.test.ts` and confirm that the new cases fail.
- [ ] Implement the copy loop between `launch.ts:63` and `launch.ts:64`, as described in the spec. Return `proxyEnv` on the launch. In `adapter.ts:160-172`, pass `proxyEnv: proxyEnvMode(config)`.
- [ ] Rerun `launch.test.ts` together with `npx vitest run apps/cli/test/claude/adapter.test.ts apps/cli/test/skills/claudeSkills.test.ts`. Expect every test to pass with no existing assertion changed.

### Task 3: API-connection failure presentation

**Files:** `apps/cli/src/claude/events.ts`, `apps/cli/src/claude/adapter.ts`, `apps/cli/test/claude/events.test.ts`, `apps/cli/test/claude/adapter.test.ts`.

**Interfaces:** Change the `ClaudeLine` variant to `{ kind: "failure"; text: string | null }`. Produce `isApiConnectionFailure(text: string | null): boolean`. Consume `launch.proxyEnv` from Task 2.

- [ ] Add failing tests:
  - `events.test.ts`: the `failure` line returns `result` text when it is a string and `null` otherwise. The classifier is true for `Unable to connect to API`, `Connection error`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPROTO`, `ENOTFOUND` and `EAI_AGAIN` (in mixed case and embedded in an `API Error: …` sentence). It is false for `401 Unauthorized`, `429`, `Overloaded 529`, the `error_max_turns` subtype with no text, and `null`.
  - `adapter.test.ts`: write a fake `claude` the way that file already does (`createAdapter(bin)`) that emits a valid `init` and then `{"type":"result","is_error":true,"result":"API Error: Unable to connect to API (ECONNREFUSED)"}`. With no `proxyEnv` in the temp config, the error equals the `off` message. With `forward` written to the temp `config.json`, it equals the `forward` message. Neither contains `ECONNREFUSED`. A `result` with `is_error` and text `API Error: 401` still equals `RUN_FAILED`.
- [ ] Run `npx vitest run apps/cli/test/claude/events.test.ts apps/cli/test/claude/adapter.test.ts` and confirm that the new cases fail.
- [ ] Implement the parser text, the classifier and two message constants next to `RUN_FAILED` (`adapter.ts:38`). At `adapter.ts:346`, choose the message by classifier and `launch.proxyEnv`. Update any other `kind: "failure"` consumer that the typecheck reports.
- [ ] Rerun and confirm it passes. If the real acceptance in Task 5 captures a different line shape, replace the fixture with the redacted capture and move the parser change to that line type. Record the change in the execution evidence.

### Task 4: Docs, changelog, roadmap and full verification

**Files:** `docs/guide.en.md`, `docs/guide.zh.md`, `docs/guide.ja.md`, `docs/reference.zh-CN.md`, `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`, `changelog.d/claude-proxy-env.added.md`, `ROADMAP.md` (post-merge step only).

- [ ] In the three guides, after the "Configure Claude Code" block (around line 217-223), add `config set proxyEnv forward` / `off`. Cover the default, the eight variables, the fact that the daemon's own environment supplies the values, the credential-in-URL warning, that no CA variables are forwarded, the downgrade step, and that desktop does not expose the setting. Keep the three languages equivalent.
- [ ] In `docs/reference.zh-CN.md`, add one paragraph: the field, the strict-schema rollback rule, the forwarded set and Windows case rule, the connection classification and what it does not cover.
- [ ] Update the four READMEs (`README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`): add a short proxy note to the configuration/usage part — on a machine whose only egress is a proxy, `nema config set proxyEnv forward` lets Claude Code tasks reach the API. AGENTS.md requires configuration changes in all four READMEs; keep `README.md` and `README.en.md` byte-identical (verify with `cmp`) and the language versions equivalent.
- [ ] Write `changelog.d/claude-proxy-env.added.md` with exactly one bullet, for example: `- Claude Code tasks can use the daemon's HTTP(S) proxy settings with \`nema config set proxyEnv forward\`; API-connection failures are now reported as such.`
- [ ] After the implementation PR has merged (not before — the note must not claim a merge that has not happened): at `ROADMAP.md` line 29 (#131), append that the #242 fix is merged (with the PR link) and the Claude-family full run is still pending. Do not mark #131 or S5.2 complete in this task.
- [ ] Run `npm run typecheck`, then `npm run typecheck -w apps/cli`, then `npm test -- --maxWorkers=2`. Expect all of them to pass. Report any failure tied to the environment by name; do not weaken a test to get past it.
- [ ] Docs check: write the changed Markdown paths into a JSON array file, then run `node scripts/ci/docs-check.mjs <that-file>`, `node --test scripts/ci/docs-check.test.mjs` if the checker changed, and `git diff --check`. Expect no errors. Run the CodeRabbit CLI if it is available, and review the final diff.

### Task 5: Real-environment acceptance (separately authorized)

**Needs:** a proxy-only-egress VM, a real logged-in Claude account (`claude setup-token` + `nema auth claude`), and the Compose deployment or the equivalent source deployment used for #131. The daemon is started with `HTTPS_PROXY`/`NO_PROXY` in its environment.

- [x] With `proxyEnv` absent, start a `claude-code` task from a thread. Expect failure with the `off` message. Capture the failing stream-json line (redact hosts and credentials) and compare it with the Task 3 fixture.
- [x] Run `nema config set proxyEnv forward`. Do not restart the daemon. Expect the same task to complete end to end and its reply to appear in the thread.
- [x] Run `nema config set proxyEnv off` and confirm that `config.json` no longer has the key.
- [x] Record the commands, versions, the redacted line and the outcome on #131. Then update `ROADMAP.md` line 29 to close the S5.2 Claude-family gap. This is runtime evidence, not test or acceptance evidence for other items, and it covers Linux only.

## Execution evidence

Tasks 1–4 implemented in PR #246 (merged 2026-11-17, `0c5cbf5`); supervisor-verified locally: typecheck pass, targeted suites 157 passed / 1 skipped (win32-only), full CI green. Task 5 executed 2026-11-17 in the proxy-only-egress VM (source deployment from main `0c5cbf5`, real Claude account): with `proxyEnv` absent the task failed with the new `off` message (the classifier matched the real Claude Code output; the run directory is cleaned on completion, so the raw stream-json line was not retained — the fixture stands as written in Task 3); after `nema config set proxyEnv forward` with no daemon restart, the same task completed end to end and its reply landed in the thread; `config set proxyEnv off` removed the key. Records: #242 comment 6940468232, #131 comment 6940469368; #242 and #131 both closed; the ROADMAP S5 item was ticked in the follow-up docs PR.
