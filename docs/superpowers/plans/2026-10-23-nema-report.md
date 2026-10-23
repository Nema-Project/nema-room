# Plan C: nema report and Implementation Status

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let coding agents report finished work to Nema, check each report against the repo's main branch without a model, and track every requirement's implementation as reported → verified, or mismatch. When work lands on main with no report, Nema notices it and asks the Agent to work out what it is; that work reaches "verified" only after the user confirms.

**Architecture:**
- **Hook layer.** A thin hook (Claude Code `Stop` / `SessionEnd`, Codex's equivalent) runs `nema report hook`. It sends only the agent name, cwd, git common dir, branch, HEAD sha, time and session id to a token-protected hub endpoint, and spools locally when the hub is down.
- **Skill layer.** A generic `SKILL.md` asks the coding agent to run `nema report` with a summary, entry ids, commits and files. That arrives as a new `report` chat message.
- **Checking.** The daemon checks each report with git (commits exist, on main by ancestry or patch-id, claimed files touched). The hub then queues an organizing task.
- **Status.** Requirement entries gain an `implementation` field. The Room API allows `verified` only with a passing report.
- **Fallback.** A 30-minute check finds main-branch commits no report covers and starts a system task (reusing `postSystemTask` from Plan B).

**Tech Stack:** TypeScript monorepo, zod v4, Hono, PostgreSQL/PGlite, git CLI, commander (CLI), Next.js + React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md`, decision 5 (with both 2026-10-23 user decisions: `origin/<main>` is the main branch; code-inferred work needs the user's confirm), and decision 8.

**Depends on:** the foundation plan (merged), the review-decisions plan (merged), and Plan B Task 5 (`postSystemTask`). Run Plan B first, or at least its Task 5.

## Global Constraints

- Work on `main`. Don't push. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never touch the real `~/.claude`, `~/.codex` or `~/.nema`. Every path is injectable, and tests use temp dirs.
- Hooks send only `agent`, `cwd`, `gitCommonDir`, `branch`, `head`, `at` and `sessionId`. Nothing else from the agent's hook payload is kept, read or forwarded.
- A hook or report whose repo isn't bound to a non-archived workspace is dropped by the hub. Nothing is stored and the reply is 204.
- Hook timeouts are 0.5 s to connect and 1.5 s in total. A failure never makes the hook exit non-zero, and never prints anything to stdout that the agent would act on.
- The spool `~/.nema/report-spool.jsonl` is 0600. Writing stops at 5 MB. Lines older than 7 days are dropped when the file is next flushed.
- The report token `~/.nema/report-token` is 0600, 32 random bytes as hex. It is never printed and never logged.
- "Done" means on `origin/<main>`, or the local main when there is no origin: the reported commit is an ancestor of main, or main has a commit with the same `git patch-id --stable`.
- The file check only fails when a file the report claims was **not** touched by the reported commits. Extra changes are fine. Merge commits are ignored; renames count by their new path.
- The fallback triggers 30 minutes after a main move that no report covers. The hub checks every 5 minutes.
- `verified` is reachable only from a report whose check passed, or from the user's own confirm in the UI. The Agent can never set `verified` from code inference.
- Hub user-facing text is Chinese. Web copy exists in ja / en / zh.

## Review Focus

1. **The coding agent works in a `git worktree` or a subdirectory of the bound repo.** It still routes to the right workspace through the git common dir. A separate clone does not route, and is caught later by the fallback. Pinned in Task 2.
2. **A squash-merged report.** The reported commits are not ancestors of main, but the squash commit's patch-id equals their combined patch-id, so the check passes. Pinned in Task 3.
3. **A report arrives before the PR is merged**: the commits exist but aren't on main yet. The status stays `reported` with the evidence 尚未合入主分支 (not merged into main yet), and becomes `verified` after a later main move re-runs the check. Pinned in Task 3 and Task 5.
4. **The hub is down while hooks fire.** The events spool, are replayed in order on the next successful send, and a spool over 5 MB stops growing. Pinned in Task 2.
5. **Installing the hook into a `~/.claude/settings.json` that already has other hooks** (Orca's, for one) adds Nema's entries without changing or reordering anything else. Uninstall removes only Nema's. Pinned in Task 6.

---

### Task 1: Shared schemas, the `report` role and the report token

**Files:**
- Create: `packages/shared/src/report.ts`, `apps/hub/src/db/migrations/008_reports.sql`
- Modify: `packages/shared/src/entry.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/index.ts`, `apps/hub/src/messages.ts`
- Test: `packages/shared/test/report.test.ts`, `packages/shared/test/entry.test.ts`

**Interfaces — Produces:**
- `HookSignal = z.object({ agent: z.string().min(1).max(40), cwd: z.string(), gitCommonDir: z.string(), branch: z.string().nullable(), head: z.string().regex(/^[0-9a-f]{40}$/), at: z.string().datetime(), sessionId: z.string().max(200).nullable() })`.
- `ReportInput = z.object({ agent: z.string().min(1).max(40), gitCommonDir: z.string(), summary: z.string().min(1).max(2000), entries: z.array(z.string().regex(/^[RDTQSG]-[1-9]\d*$/)).max(50).default([]), commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).min(1).max(50), files: z.array(z.string().min(1).max(500)).max(500).default([]) })`.
- `ReportCheck = { commitsExist: boolean; missingCommits: string[]; onMain: "yes" | "not-yet" ; filesOk: boolean; untouchedFiles: string[]; checkedAt: string; mainSha: string }`. Overall `passed` = `commitsExist && onMain === "yes" && filesOk`.
- Entry: requirements gain `implementation?: { status: "reported" | "verified" | "mismatch"; evidence: { reportMessageId: string | null; commits: string[]; inferred: boolean; note: string | null; confirmedBy: "user" | null } }`. It is allowed only on `kind: "requirement"`. The on-disk key is `implementation`, with snake_case inner keys.
- The `messages.role` check constraint adds `'report'`. The `Message.role` type gains `"report"`. `messages.meta` holds `{ report: ReportInput, check: ReportCheck | null }` for report messages.
- **Migration `008_reports.sql`.**
  - Alter the role check.
  - `create table report_tokens (hash text primary key, created_at timestamptz default now())`.
  - `create table repo_hooks (id bigserial primary key, repo_id text not null references workspace_repos(id) on delete cascade, agent text not null, branch text, head text not null, session_id text, at timestamptz not null)`.
  - `create table main_moves (id bigserial primary key, repo_id text not null references workspace_repos(id) on delete cascade, from_sha text, to_sha text not null, at timestamptz not null default now(), handled boolean not null default false)`.
- **Protocol.** `hello` gains `reportTokenHash?: string` (sha256 hex of the report token, sent when the file exists).

- [ ] **Step 1: Write the failing tests.**
  - `ReportInput rejects an empty summary, a non-hex commit and more than 50 commits`.
  - `HookSignal accepts only the seven fields and strips anything else`: parse with `.strip()`, and assert a `transcript` key is gone.
  - `implementation is accepted only on requirements and round-trips`.
- [ ] **Step 2: Run** `npx vitest run packages/shared`. Expected: FAIL.
- [ ] **Step 3: Implement.** Also add a knowledge store round-trip for `implementation` in `packages/knowledge/src/store.ts`, written only when present.
- [ ] **Step 4: Run** `npx vitest run packages` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): report schemas and implementation status`.

---

### Task 2: CLI `nema report hook` and `nema report`, plus the spool

**Files:**
- Create: `apps/cli/src/report/token.ts`, `apps/cli/src/report/git.ts`, `apps/cli/src/report/send.ts`, `apps/cli/src/report/commands.ts`
- Modify: `apps/cli/src/index.ts`, `apps/cli/src/daemon/connection.ts` (send `reportTokenHash` in hello)
- Test: `apps/cli/test/report/*.test.ts`

**Interfaces — Produces:**
- `ensureReportToken(nemaHome): string`: create if missing (0600, atomic, refuse symlink), else read and check 0600. `reportTokenHash(nemaHome): string | null`.
- `repoInfo(cwd: string): Promise<{ gitCommonDir: string; branch: string | null; head: string } | null>` uses `git rev-parse --path-format=absolute --git-common-dir`, `git symbolic-ref --short -q HEAD` and `git rev-parse HEAD`, then takes the realpath of the common dir. Outside a repo it returns `null`.
- `sendToHub(hubUrl, path: "/report/hook" | "/report", token, body, opts: { connectMs: 500, totalMs: 1500 }): Promise<"ok" | "dropped" | "failed">`. 2xx is `"ok"`; 204 also counts as `"ok"` (dropped hub-side). Network failure, timeout or 5xx is `"failed"`; 4xx is `"dropped"`.
- **Spool** (`~/.nema/report-spool.jsonl`):
  - `appendSpool(nemaHome, line)` refuses to grow past 5 MB.
  - `flushSpool(nemaHome, send)` replays lines oldest first and stops at the first `"failed"`. It rewrites the rest atomically and drops lines older than 7 days.
- **`nema report hook --agent <name>`.**
  1. Read the agent's hook JSON from stdin (cap 1 MB), take only `cwd` (or `process.cwd()`) and `session_id`, and ignore the rest.
  2. Run `repoInfo`; outside a repo, exit 0 silently.
  3. Build a `HookSignal`, flush the spool, then send it. On `"failed"`, append it to the spool.
  4. Always exit 0, printing nothing to stdout.
- **`nema report --summary <s> --commits <a,b> [--entries R-1,R-2] [--files x,y] [--agent <name>]`.** Values can also come as JSON on stdin with `--json`. It sends a `ReportInput`, spooling on failure.
  - Outside a repo: exit 1, `不在 git 仓库里，无法上报`.
  - On a 4xx: exit 1 with the hub's error text.
  - Success prints `已上报到 Nema`; a spooled report prints `Nema 暂时不可达，已暂存，稍后补发`.
- The hub URL comes from config / `NEMA_HUB_URL`, the same way `nema daemon` resolves it.

- [ ] **Step 1: Write the failing tests** (fake hub HTTP server, temp HOME, temp repos):
  - `hook from a worktree reports the main repo's common dir` (Review Focus 1).
  - `hook strips everything but cwd and session_id from the agent payload`: the body the fake hub receives has exactly the `HookSignal` keys.
  - `hook outside a repo sends nothing and exits 0`.
  - `hook with the hub down spools, and the next successful hook replays the spool first, in order` (Review Focus 4).
  - `spool stops growing at 5 MB`.
  - `spool flush drops lines older than 7 days`.
  - `report sends commits, entries and files and prints 已上报到 Nema`.
  - `report outside a repo exits 1 with 不在 git 仓库里，无法上报`.
  - `the report token file is 0600 and never printed`.
- [ ] **Step 2: Run** `npx vitest run apps/cli/test/report`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npm run typecheck -w apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): nema report and report hook with a local spool`.

---

### Task 3: Daemon report check

**Files:**
- Create: `apps/cli/src/repos/reportCheck.ts`
- Modify: `apps/cli/src/repos/handlers.ts`
- Test: `apps/cli/test/repos/reportCheck.test.ts`

**Interfaces — Produces:**
- `checkReport(repoPath, mainRefName, commits: string[], files: string[]): Promise<ReportCheck>`:
  1. `git cat-file -e <sha>^{commit}` for each sha. Any missing goes into `missingCommits` and `commitsExist=false`.
  2. `onMain = "yes"` when every commit is an ancestor of main (`merge-base --is-ancestor`), or when main's commits since `merge-base(first reported commit, main)` include one whose `git patch-id --stable` equals the combined patch-id of the reported commits (`git diff <oldest>^ <newest> | git patch-id --stable`). Otherwise `"not-yet"`.
  3. Touched files = union of `git diff-tree --no-commit-id --name-only -r -M <sha>` over the non-merge reported commits. `untouchedFiles` = claimed files not in that set; `filesOk = untouchedFiles.length === 0`.
- RPC `report.check({ repo, commits, files })` → `ReportCheck`. It fetches first (`fetchMain`) and uses the bound main ref.
- RPC `repo.uncovered({ repo, from, to, covered: string[] })` returns the non-merge commits in `from..to` on main that are neither in `covered` nor patch-id-equal to any of them.

- [ ] **Step 1: Write the failing tests** (temp repos with a local bare origin):
  - `a merged commit passes`.
  - `a missing sha fails with missingCommits`.
  - `a squash-merged pair of commits passes by patch-id` (Review Focus 2).
  - `an unmerged branch commit is onMain not-yet` (Review Focus 3).
  - `claiming an untouched file fails filesOk; extra touched files are fine`.
  - `a rename counts by its new path`.
  - `repo.uncovered lists main commits not covered by the given shas or their squash`.
- [ ] **Step 2: Run** `npx vitest run apps/cli/test/repos/reportCheck.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): deterministic report checks against main`.

---

### Task 4: Hub report endpoints and routing

**Files:**
- Create: `apps/hub/src/reports.ts`
- Modify: `apps/hub/src/app.ts` (mount `/report`), `apps/hub/src/daemonSocket.ts` (store `reportTokenHash` from hello), `apps/hub/src/prompt.ts`
- Test: `apps/hub/test/reports.test.ts`, `apps/hub/test/prompt.test.ts`

**Interfaces — Produces:**
- Auth: `Authorization: Bearer <token>`, whose sha256 must be in `report_tokens`. On hello with `reportTokenHash`, insert it if new. A wrong or missing token is 401 with no body detail.
- `routeRepo(db, gitCommonDir): Promise<Repo | null>`: the repo with that `git_common_dir`, in a non-archived workspace.
- `POST /report/hook` with a `HookSignal`:
  - No route → 204; nothing stored.
  - Otherwise, insert a `repo_hooks` row and fire daemon RPC `repo.tick({ repoId })`, without awaiting. Add a `repo.tick` handler to the daemon that runs `RepoWatcher.tick` for that one repo.
  - Then 204.
- `POST /report` with a `ReportInput`:
  - No route → 204; nothing stored.
  - Otherwise:
    1. insert a `report` message (content = summary, meta `{ report, check: null }`) and emit `message.created`;
    2. call RPC `report.check` with a 5-minute timeout and store the check in the message meta (on error, `check` stays null with the error in a `checkError` meta field);
    3. queue a task for that message, the same way `postUserMessage` does;
    4. reply 202 `{ messageId }`.
- **Prompt.** For a `report` message the last section is `# 本次 coding agent 上报`. It includes the summary, entries, commits, files, and the check rendered as one line each (`提交存在：是/否`, `已合入主分支：是/尚未`, `文件相符：是/否（未改动：…）`). It adds these rules:
  - `把上报关联到需求，更新需求的 implementation：核实通过（三项都是「是」）设 verified 并引用本上报；已合入主分支为「尚未」时设 reported 并在 note 写「尚未合入主分支」；提交不存在或文件不符时设 mismatch，并新建一条 question 问用户。`
  - `不要仅凭上报内容就认为决策被正确实现；如有疑问用 code__ 函数核对，并新建 question。`

- [ ] **Step 1: Write the failing tests** (fake daemon RPC):
  - `hook without a valid token is 401`.
  - `hook for an unbound or archived repo is 204 and stores nothing`.
  - `hook for a bound repo stores the signal and asks the daemon to tick that repo`.
  - `report creates a report message, stores the check, then queues a task`.
  - `a report check error still queues the task with checkError`.
  - `the prompt for a report task shows the check lines and the implementation rules`.
- [ ] **Step 2: Run** `npx vitest run apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): receive hooks and reports from coding agents`.

---

### Task 5: Implementation status rules, re-check on main moves, the fallback, user confirm

**Files:**
- Modify: `apps/hub/src/roomApi.ts`, `apps/hub/src/reports.ts`, `apps/hub/src/repos.ts` (the `repo.moved` hook point), `apps/hub/src/uiApi.ts`, `apps/hub/src/main.ts`, `packages/knowledge/src/store.ts`
- Test: `apps/hub/test/roomApi.test.ts`, `apps/hub/test/reports.test.ts`, `apps/hub/test/uiApi.test.ts`

**Interfaces — Produces:**
- **Room API rules for `implementation` on upsert** (409 with the exact text in each case):
  - `status: "verified"` requires `evidence.reportMessageId` naming a `report` message in this workspace whose stored check passed. Every `evidence.commits` entry must be among that report's commits. Otherwise `实现状态 verified 需要一条核实通过的上报作为证据（evidence.reportMessageId）。`
  - `evidence.inferred: true` with `status: "verified"` → `代码推断的实现只能由用户确认为 verified。`
  - `evidence.confirmedBy` can't be set by the Agent → `confirmedBy 只能由用户确认设置。`
- **Re-check on main moves.** After storing a `repo.moved`, the hub:
  1. inserts a `main_moves` row;
  2. re-runs `report.check` for each report message of that repo whose stored check has `onMain: "not-yet"` and was created within the last 30 days;
  3. if a re-check now passes, updates the meta and queues a system task (`postSystemTask`): `上报 <messageId> 的提交已合入主分支，核实通过：把相关需求的 implementation 更新为 verified。`.
- **Fallback timer.** `startReportFallback(db, daemon, events, { intervalMs = 300_000, graceMs = 1_800_000 })` is started from `main.ts`. Every tick, for each `main_moves` row with `handled = false` and `at < now − graceMs`:
  1. collect the covered commits (all commits of report messages of that repo with `onMain = "yes"`);
  2. call RPC `repo.uncovered`;
  3. if the result is empty, mark the row handled;
  4. otherwise call `postSystemTask(db, ws, "主分支有新提交但没有收到上报：<sha 列表，每行一个>。用 code__changes / code__read 判断它们对应哪些需求；仅凭代码推断的关联把 implementation 设为 reported，evidence.inferred 为 true，basis 为 inferred。")` and mark the row handled.
  - A daemon error leaves the row unhandled.
- **User confirm.** `POST /api/workspaces/:id/entries/:eid/implementation/confirm` with `{}` sets `implementation.status = "verified"` and `evidence.confirmedBy = "user"`, committed by `user` with reason `用户确认已实现`. It applies only to requirements whose `implementation.status` is `reported` or `mismatch`; otherwise 409 `只能确认已上报或有出入的实现`. Add `KnowledgeStore.confirmImplementation(id, meta)`.

- [ ] **Step 1: Write the failing tests**:
  - `the Agent cannot set verified without a passing report, nor for inferred evidence, nor set confirmedBy` (three cases, exact 409 texts).
  - `the Agent can set verified citing a passing report`.
  - `a main move re-checks a not-yet report and queues the verified system task when it now passes` (Review Focus 3).
  - `the fallback ignores a move younger than 30 minutes, marks a covered move handled, and queues one system task for uncovered commits` (inject the clock).
  - `a fallback daemon error leaves the move unhandled`.
  - `implementation confirm turns an inferred reported requirement into verified by user`.
  - `implementation confirm on a requirement with no implementation is 409`.
- [ ] **Step 2: Run** `npx vitest run apps/hub packages`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): implementation status rules, re-checks and the no-report fallback`.

---

### Task 6: `nema report install` / `uninstall` and the skill

**Files:**
- Create: `apps/cli/src/report/install.ts`, `apps/cli/src/report/SKILL.md` (shipped in the CLI package)
- Modify: `apps/cli/src/index.ts`, `apps/cli/package.json` (files), `apps/cli/src/doctor.ts`
- Test: `apps/cli/test/report/install.test.ts`, `apps/cli/test/doctor.test.ts`

**Verify first:**
- Claude Code: confirm from `claude --help` / the hooks docs that `Stop` and `SessionEnd` are hook events in `~/.claude/settings.json`, using the `{ hooks: { Stop: [{ matcher?, hooks: [{ type: "command", command }] }] } }` shape. Confirm the user skill dir is `~/.claude/skills/<name>/SKILL.md`.
- Codex: confirm whether the installed Codex (`codex --version`) supports hooks, and with which file and events, and where user skills go. If Codex has no hook mechanism, install only the skill for Codex. Record that in the commit message and in `nema report install --agent codex` output: `Codex 不支持钩子，只安装了技能；没有上报时由主分支检查兜底`.

**Interfaces — Produces:**
- `nema report install --agent claude|codex [--home <dir>]`:
  1. `ensureReportToken`;
  2. write the skill to the agent's user skill dir as `nema-report/SKILL.md`;
  3. add hook entries whose command is `<absolute node> <absolute cli entry> report hook --agent <name>`, so it runs without PATH.
  - Edits to JSON settings parse the file, add or replace only entries marked by the command containing ` report hook --agent `, and write atomically, keeping key order and the other hooks untouched.
  - A settings file that isn't valid JSON → exit 1 `无法解析 <path>，未修改`.
  - It prints what changed and that the daemon must be restarted to register the token.
- `nema report uninstall --agent <name>` removes exactly Nema's hook entries and the `nema-report` skill dir, and leaves the token in place.
- `SKILL.md`, a short English instruction:
  - when to report (after finishing a unit of work and committing);
  - the exact command form;
  - "list only files you changed; reference requirement ids like R-7 when you know them; never include secrets".
- `nema doctor` adds `上报钩子：<agent> 已安装 / 未安装` for claude and codex, and `上报令牌：存在 / 不存在`. These are informational, never failures.

- [ ] **Step 1: Write the failing tests** (temp HOME):
  - `install adds Stop and SessionEnd hooks with an absolute command and writes the skill`.
  - `install keeps an existing Orca hook and key order byte-identical except the added entries` (Review Focus 5).
  - `install twice does not duplicate entries`.
  - `uninstall removes only Nema's entries and the skill`.
  - `install refuses a settings file that is not JSON and leaves it unchanged`.
  - `doctor reports hook and token presence without failing`.
- [ ] **Step 2: Run** `npx vitest run apps/cli/test/report apps/cli/test/doctor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npm run build -w apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): install the report hook and skill for coding agents`.

---

### Task 7: Web — report messages, implementation status, confirm

**Files:**
- Modify: `apps/web/components/MessageItem.tsx`, `apps/web/components/KnowledgePanel.tsx`, `apps/web/components/EntryDetail.tsx`, `apps/web/lib/hub.ts`, `apps/web/lib/types.ts`, `apps/web/lib/i18n.tsx`
- Test: the matching `apps/web/test/*.test.tsx`, `apps/web/test/i18n.test.tsx`

**Behaviour:**
- **A `report` message** renders with a label `report.label` and the agent name. Below it: entry ids as links, commits as 7-character shas, and the check as three compact lines (`report.commitsExist`, `report.onMain` / `report.notYet`, `report.filesOk` / `report.untouched` with the list). It uses a muted outline style distinct from user and agent messages, from the existing tokens.
- **The requirement list row** shows a status tag: `impl.reported`, `impl.reportedInferred` (when `evidence.inferred`), `impl.verified` or `impl.mismatch`. Mismatch uses the existing red token.
- **Requirement detail** shows the status, the evidence (a link to the report message, commits, note, and `impl.confirmedByUser` when set) and, for `reported`/`mismatch`, a button `impl.confirm` that calls the confirm route.
- **i18n**, exact values:

| key | zh | ja | en |
|---|---|---|---|
| `report.label` | coding agent 上报 | coding agent の報告 | Coding agent report |
| `report.commitsExist` | 提交存在 | コミットあり | Commits exist |
| `report.onMain` | 已合入主分支 | メインブランチに反映済み | On main |
| `report.notYet` | 尚未合入主分支 | まだメインブランチに未反映 | Not on main yet |
| `report.filesOk` | 文件相符 | ファイル一致 | Files match |
| `report.untouched` | 未改动的文件 | 変更されていないファイル | Files not touched |
| `impl.reported` | 已上报 | 報告済み | Reported |
| `impl.reportedInferred` | 已上报（代码推断） | 報告済み（コードから推測） | Reported (inferred from code) |
| `impl.verified` | 已核实 | 検証済み | Verified |
| `impl.mismatch` | 有出入 | 不一致 | Mismatch |
| `impl.confirm` | 确认已实现 | 実装済みと確認 | Confirm implemented |
| `impl.confirmedByUser` | 由用户确认 | ユーザーが確認 | Confirmed by user |

- [ ] **Step 1: Write the failing tests**:
  - `a report message shows the agent, commits and check lines`.
  - `requirement rows show each implementation tag, inferred distinct from reported`.
  - `the confirm button posts and shows verified with 由用户确认`.
  - `every new key exists in ja, en and zh`.
- [ ] **Step 2: Run** `npx vitest run apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/web` and `npm run build -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): coding agent reports and implementation status`.

---

### Task 8: End-to-end check and README

- [ ] **Step 1: Write the end-to-end test** `apps/hub/test/report.e2e.test.ts`. It uses a real hub on PGlite, a real daemon RPC router, a temp repo with a local bare origin, fake graphify, and no model. Steps:
  1. bind the repo;
  2. `nema report hook` from a worktree → hook stored;
  3. commit on a branch and `nema report` → check `onMain: not-yet`;
  4. merge to origin/main and run one watcher tick → re-check passes and a system task is queued;
  5. push an unreported commit and advance the fallback clock → one fallback system task listing it.
- [ ] **Step 2: Run it.** Expected: PASS.
- [ ] **Step 3: Add a README section "Coding agent reports"**. It covers:
  - install / uninstall;
  - what the hook sends, and that it sends nothing else;
  - `nema report` usage;
  - the three statuses;
  - "done = on origin/main";
  - squash merges;
  - the 30-minute fallback;
  - that inferred work needs your confirm.
- [ ] **Step 4: Run** `npx vitest run` three times, plus `npx tsc -b`, `npm run typecheck -w apps/cli`, `npm run build -w apps/cli` and `npm run build -w apps/web`. Expected: all PASS every time.
- [ ] **Step 5: Commit** `docs: coding agent reports in README`.
