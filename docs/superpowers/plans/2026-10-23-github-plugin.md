# Plan D: Read-only GitHub Plugin

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the organizing Agent read-only access to pull requests and issues of a workspace's bound repos, through the official `github-mcp-server`. The plugin is off by default, switched on per workspace, and limited to those repos' GitHub remotes.

**Architecture:**
- The daemon keeps one long-lived MCP client to `github-mcp-server stdio --read-only --toolsets pull_requests,issues`. It starts with the token from `~/.nema/github-token` as its only credential.
- A new `github` manifest (`dataFlow: "external"`, `runsOn: "daemon"`) lists a fixed set of read tools, re-checked against the server's `tools/list` at start.
- The hub's Room plugin route checks each call's `owner`/`repo` (and search qualifiers) against the bound repos' remotes before forwarding.
- This is the first `external` plugin, so it also proves the framework's "off by default, opt in per workspace" path.

**Tech Stack:** TypeScript, zod v4, MCP TypeScript SDK client (`StdioClientTransport`), Hono, Next.js + React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md`, decision 6, plus decision 2 for data flow and defaults.

**Depends on:** the foundation plan (merged) and Plan B Task 4 (`runsOn` on `PluginManifest`). Run after Plan B.

## Global Constraints

- Work on `main`. Don't push. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never call GitHub or start the real server. Use a fake MCP stdio server script.
- Fixed server arguments, which no setting can override: `stdio --read-only --toolsets pull_requests,issues`.
- The child environment is exactly `PATH`, `HOME` (a dir under `~/.nema/run/github/`) and `GITHUB_PERSONAL_ACCESS_TOKEN`.
- The token file is `~/.nema/github-token`: mode 0600, written atomically from stdin, refusing symlinks, rejecting empty values or ones containing control characters. Never printed, logged or put in errors. Reuse the BYOK key helpers by generalizing them, not by copying them.
- The plugin is off by default in every workspace, confidential or not. Only the read tools listed in Task 2 can ever be offered.
- Every call's target must be the GitHub remote (`owner/repo`, case-insensitive) of a repo bound to the calling task's workspace. Anything else is 400 and never forwarded.
- No OAuth in this plan.
- Hub user-facing text is Chinese. Web copy exists in ja / en / zh.

## Review Focus

1. **Search queries.** `search_issues` with no `repo:` qualifier, with `repo:` pointing elsewhere, or with an extra `org:`, `user:` or second `repo:` qualifier is rejected. A query whose only qualifier is `repo:<bound owner>/<bound repo>` passes. Pinned in Task 3.
2. **Remote URL forms.** `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@github.com/o/r` and `https://github.com/O/R` all resolve to `o/r`. A non-GitHub remote (GitLab, a self-hosted host) gives no GitHub target, and the plugin's functions aren't offered for that repo. Pinned in Task 3.
3. **The server binary is missing or the token is absent.** The plugins page shows not installed / not logged in, calls fail with a clear Chinese message, and the daemon doesn't crash or retry in a hot loop. Pinned in Task 2.
4. **The server dies mid-call.** The call fails with `GitHub 插件已停止`, and the next call restarts the server once. Pinned in Task 2.
5. **The server's tool list drifts from the fixed list.** A listed tool the server doesn't have is left out with a logged warning. A server tool not in the list is never offered. Pinned in Task 2.

---

### Task 1: `nema auth github` and shared secret-file helpers

**Files:**
- Create: `apps/cli/src/secrets/file.ts`
- Modify: `apps/cli/src/direct/byok.ts` (use the helpers), `apps/cli/src/index.ts`, `apps/cli/src/doctor.ts`
- Test: `apps/cli/test/secrets/file.test.ts`, `apps/cli/test/direct/byok.test.ts` (unchanged and still passing), `apps/cli/test/doctor.test.ts`

**Interfaces — Produces:**
- `saveSecretLine(file: string, value: string, dirMode = 0o700): void` with BYOK's existing semantics: atomic, 0600, refuses a symlink, rejects empty values and control characters with `必须是一行非空文本`, and leaves an existing file untouched on reject.
- `readSecretLine(file: string, missingMessage: string, invalidMessage: string): string` with BYOK's read semantics: `O_NOFOLLOW`, 0600 check, one trailing newline allowed, and the value never echoed.
- `nema auth github` reads one line from stdin into `~/.nema/github-token`. It prints `已保存 GitHub 令牌`.
- `nema doctor` adds a line for `github-mcp-server`: `可用：<version>` or `未安装`, plus the install hint `https://github.com/github/github-mcp-server/releases`. It adds another for the GitHub token: present and 0600, or missing. Both are informational.

- [ ] **Step 1: Write the failing tests**:
  - `saveSecretLine / readSecretLine round-trip and reject empty, multi-line, control-character and symlink cases`.
  - `nema auth github writes the token 0600 and never prints it`.
  - `doctor reports github-mcp-server and the token without printing it`.
- [ ] **Step 2: Run** `npx vitest run apps/cli/test/secrets apps/cli/test/direct/byok.test.ts apps/cli/test/doctor.test.ts`. Expected: the new tests FAIL; BYOK still passes.
- [ ] **Step 3: Implement.** Move BYOK onto the helpers in the same commit, and keep BYOK's error texts unchanged.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): nema auth github on shared secret-file helpers`.

---

### Task 2: Daemon GitHub MCP client and the `github` manifest

**Files:**
- Modify: `packages/shared/src/plugins.ts`
- Create: `apps/cli/src/github/client.ts`
- Modify: `apps/cli/src/repos/handlers.ts` (route `github__*` in `plugin.call`; extend `plugins.status`), `apps/cli/src/daemon/setup.ts`
- Test: `apps/cli/test/github/client.test.ts`, `apps/cli/test/fixtures/fake-github-mcp.mjs`, `packages/shared/test/plugins.test.ts`

**Verify first:** if `github-mcp-server` is installed locally, run it with `--read-only --toolsets pull_requests,issues` and a dummy token. List its tools with a short MCP client script; this needs no network, since listing tools doesn't call GitHub. Record the exact names and input schemas of the PR and issue read tools. Otherwise use the names from the upstream README (`pull_request_read`, `issue_read`, `list_issues`, `search_issues`, plus `list_pull_requests` / `search_pull_requests` if present) and note that they weren't checked locally.

**Interfaces — Produces:**
- The manifest `{ id: "github", displayName: "GitHub", dataFlow: "external", runsOn: "daemon", scope: "github" }`. Functions are `github__<tool>` for each verified read tool, `readOnly: true`, with the server's input schema. Add `scope: "repo" | "github" | "none"` to `PluginManifest`: `code` is `"repo"`, `diagram` is `"repo"`, `github` is `"github"`.
- `class GithubMcp { constructor(opts: { nemaHome: string; bin?: string; spawnEnv?: … }); status(): Promise<{ installed: boolean; loggedIn: boolean; detail: string }>; call(tool: string, args: object): Promise<unknown>; close(): void }`:
  - The server starts lazily on the first call, using the Global Constraints arguments and environment. Each call has a 60 s timeout.
  - After start, it lists the server's tools. A manifest tool the server lacks is logged once and rejected when called, with `GitHub 插件没有工具 <name>`.
  - When the child exits mid-call, the call fails with `GitHub 插件已停止`. The next call restarts the server once; if that start also fails, calls fail fast for 60 s with the start error (no restart loop).
  - A missing binary fails with `github-mcp-server 未安装`; a missing token with `未保存 GitHub 令牌：请运行 nema auth github`.
  - Results are returned as the MCP content text, capped at 64 KB.
- `plugins.status` adds `github: { installed, detail }`. `installed` is true only when the binary runs and the token exists.

- [ ] **Step 1: Write the failing tests.** The fake server is a small Node MCP stdio server with configurable tools and a crash-on-call mode.
  - `the server is started with only --read-only --toolsets pull_requests,issues and the three env vars`.
  - `a call returns the tool's text, capped at 64 KB`.
  - `a manifest tool missing on the server is rejected; a server-only tool is never callable` (Review Focus 5).
  - `a crash mid-call fails with GitHub 插件已停止 and the next call restarts once` (Review Focus 4).
  - `a missing binary or token gives the Chinese message and does not loop` (Review Focus 3).
- [ ] **Step 2: Run** `npx vitest run apps/cli/test/github packages/shared`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npm run typecheck -w apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): read-only GitHub MCP client behind the plugin call`.

---

### Task 3: Hub scope checks for GitHub calls

**Files:**
- Create: `apps/hub/src/githubScope.ts`
- Modify: `apps/hub/src/roomApi.ts`, `apps/hub/src/plugins.ts`
- Test: `apps/hub/test/githubScope.test.ts`, `apps/hub/test/roomApi.test.ts`, `apps/hub/test/plugins.test.ts`

**Interfaces — Produces:**
- `githubTarget(remoteUrl: string | null): { owner: string; repo: string } | null`. It handles the https, `git@`, `ssh://` and `.git`-suffix forms and lowercases both parts. Any host other than `github.com` gives `null`.
- `checkGithubCall(tool: string, args: Record<string, unknown>, allowed: { owner: string; repo: string }[]): { ok: true } | { ok: false; error: string }`:
  - Tools with `owner` and `repo` arguments must match one allowed pair, else `只能访问本 workspace 绑定仓库的 GitHub：<owner>/<repo>`.
  - Search tools must have a `query` with exactly one `repo:` qualifier naming an allowed pair, and no `org:` or `user:` qualifier, else `搜索必须且只能限定为本 workspace 绑定的仓库（repo:owner/name）`.
  - A tool with neither shape is rejected, `不支持的 GitHub 调用`.
- In the Room plugin route, a `scope: "github"` function skips the `repo` id lookup. It uses `checkGithubCall` against the workspace's bound repos' `githubTarget(remoteUrl)` values, then forwards `{ name, args }` to the daemon with no repo payload.
- `enabledPluginTools` offers `github__*` only when the plugin is enabled and at least one bound repo has a GitHub target. Its tool descriptions list the allowed `owner/repo` values.

- [ ] **Step 1: Write the failing tests**:
  - `githubTarget parses the four URL forms and returns null for gitlab` (Review Focus 2).
  - `owner/repo calls pass only for a bound remote`.
  - `search queries need exactly one bound repo: qualifier and no org: or user:` (Review Focus 1). Cover the five cases from Review Focus 1.
  - `github tools are off by default, also in a confidential workspace, and offered after enabling`.
  - `github tools are not offered when no bound repo has a GitHub remote`.
  - `a rejected call is recorded in plugin_calls and never reaches the daemon`.
- [ ] **Step 2: Run** `npx vitest run apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): limit GitHub calls to the workspace's bound remotes`.

---

### Task 4: Web, README and verification

**Files:**
- Modify: `apps/web/components/PluginsPage.tsx`, `apps/web/components/CodeAndPlugins.tsx`, `apps/web/lib/i18n.tsx`, `README.md`
- Test: `apps/web/test/PluginsPage.test.tsx`, `apps/web/test/CodeAndPlugins.test.tsx`, `apps/web/test/i18n.test.tsx`

**Behaviour:**
- **Plugins page.** GitHub shows the existing `plugins.external` tag, plus a login state of `github.loggedIn` or `github.notLoggedIn`. The second comes with the hint `github.loginHint` and the command `nema auth github` in monospace.
- **Workspace page.** GitHub's toggle starts off and shows `plugins.externalNote`. Under each bound repo, show its GitHub target (`owner/repo`) or `github.noRemote`.
- **i18n**, exact values:

| key | zh | ja | en |
|---|---|---|---|
| `github.loggedIn` | 已保存令牌 | トークン保存済み | Token saved |
| `github.notLoggedIn` | 未保存令牌 | トークン未保存 | No token |
| `github.loginHint` | 在终端运行以下命令，从标准输入粘贴 personal access token | ターミナルで次のコマンドを実行し、標準入力に personal access token を貼り付けます | Run this in a terminal and paste a personal access token on stdin |
| `github.noRemote` | 没有 GitHub 远端 | GitHub リモートなし | No GitHub remote |

- **README.** Add a section "GitHub (read-only)". It covers:
  - installing `github-mcp-server`;
  - `nema auth github` and which token scopes are enough (read access to the repos' contents, pull requests and issues);
  - that the plugin is off by default and sends queries to GitHub;
  - that only bound repos' remotes are reachable.

- [ ] **Step 1: Write the failing tests**:
  - `the plugins page shows GitHub as sends data out, with the login hint when no token`.
  - `the workspace page shows the GitHub target per repo and starts the toggle off`.
  - `every new key exists in ja, en and zh`.
- [ ] **Step 2: Run** `npx vitest run apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement**, and add the README section.
- [ ] **Step 4: Run** `npx vitest run` three times, plus `npx tsc -b`, `npm run typecheck -w apps/cli`, `npm run build -w apps/cli` and `npm run build -w apps/web`. Expected: all PASS every time.
- [ ] **Step 5: Commit** `feat(web): GitHub plugin status and per-repo targets`.
