# Phase 2: Work Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nema turns chosen requirements into a work package: one spec and one plan, written after a grill step. The user approves it, a coding agent fetches it with `nema wp get`, and per-task reports drive its status to done.

**Architecture:**
- **Entries.** A work package is a new entry kind, `workpackage` (prefix `W`), stored as `W-n.md`, `W-n.spec.md` and `W-n.plan.md` in the knowledge repo.
- **Writing.** Generation is a system-started task of kind `workpackage` with larger run limits. The organizing Agent writes through new hub-side functions from a built-in `superpowers` plugin. The hub validates every save: source markers in the spec, file paths checked against the repo, and at most 15 tasks.
- **grill-me.** A built-in plugin with workspace settings (strictness, extra rules) that shapes both ordinary organizing and the readiness check.
- **Approval** is UI-only.
- **Handoff.** The coding agent pulls the package through report-token endpoints.
- **Progress.** Task status is set by the hub from report checks, never by the Agent, and the package status is derived from its tasks.

**Tech Stack:** TypeScript monorepo, zod v4, Hono, PostgreSQL/PGlite, git CLI, commander, Next.js + React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-work-packages-design.md` (approved 2026-10-23). It builds on `2026-10-23-codebase-and-plugins-design.md` decisions 5 and 8, as implemented by Plans B and C.

## Global Constraints

- Work on `main`. Don't push. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never call a real model, GitHub or graphify, and never touch the real `~/.claude`, `~/.codex` or `~/.nema`.
- Nema never writes into a user repo. `nema wp get` runs in the coding agent's own process and writes under its cwd.
- Work package statuses are `draft`, `approved`, `in_progress`, `done` and `dropped`. Task statuses are `pending`, `reported`, `verified` and `mismatch`, plus an `inferred` flag.
- Only the user can approve, through a UI route. Any later edit to the spec or plan sets the status back to `draft`.
- `in_progress`, `done` and every task status are set by the hub from report checks or user confirmation, never by the Agent.
- A plan holds at most **15** tasks.
- Work-package generation runs with **48** model calls, **120** tool calls and **20 minutes**. Every other run keeps **24 / 60 / 10 minutes**.
- grill-me extra rules are at most **2000** characters. The rule "uncertain → question entry" stays on even when grill-me is off.
- Fixed Markdown markers that the hub parses, written exactly like this whatever the knowledge language is:
  - Spec section heading: `## 已定的做法`. Every list item under it carries at least one `[R-n]`/`[D-n]`/`[T-n]`/`[Q-n]`/`[S-n]`/`[G-n]` marker, or `[推断]`.
  - Plan task heading: `### 任务 <n>：<title>`.
  - Inside a task: lines `- 修改：<repo label>:<path>` / `- 新建：<repo label>:<path>`, and one line `- 满足：R-3、R-5`.
- superpowers-derived rule text is vendored under `vendor/superpowers-rules/` with the MIT notice (Copyright (c) 2025 Jesse Vincent) and the source version.
- Hub user-facing text is Chinese. Web copy exists in ja / en / zh.

## Review Focus

1. **The user edits an approved package's plan in the UI.** The status drops to `draft`, `nema wp get` stops serving it, and approving again records the new commit. Pinned in Task 7.
2. **A report names `W-2` with a task number that doesn't exist, or a package that isn't approved.** The report is still stored and organized as normal, and no task status changes. Pinned in Task 9.
3. **Two reports for the same task.** A later passing check upgrades `reported` or `mismatch` to `verified`; a later failing one never downgrades a `verified` task. Pinned in Task 9.
4. **A plan line `- 修改：api:src/x.ts` where `src/x.ts` doesn't exist on main.** The save is refused with that line returned. The same path as `- 新建：` passes. An unknown repo label is refused. Pinned in Task 4.
5. **grill-me off.** Organizing still files uncertain things as questions, but the chat no longer shows an asked question, and generation skips the readiness stop. Pinned in Task 5.

---

### Task 1: Shared types — the `workpackage` kind, report task field, task kind and run limits

**Files:**
- Modify: `packages/shared/src/entry.ts`, `packages/shared/src/report.ts`, `packages/shared/src/protocol.ts`, `packages/shared/src/plugins.ts`
- Create: `apps/hub/src/db/migrations/009_workpackages.sql`
- Test: `packages/shared/test/entry.test.ts`, `packages/shared/test/report.test.ts`, `packages/shared/test/protocol.test.ts`

**Interfaces — Produces:**
- `ENTRY_KINDS` gains `"workpackage"`, with `KIND_DIR.workpackage = "workpackages"`, `KIND_PREFIX.workpackage = "W"` and `KIND_STATUSES.workpackage = ["draft", "approved", "in_progress", "done", "dropped"]` (added to `ALL_STATUSES`). `INACTIVE_STATUSES` gains `"dropped"` if it is missing; `done` stays visible.
- The entry field `workpackage?: WorkPackageMeta` is required for that kind and forbidden for others. Its type:

  ```ts
  type WorkPackageMeta = {
    requirements: string[];
    repos: string[];
    approvedAt: string | null;
    approvedCommit: string | null;
    blockedOn: string | null;
    tasks: WpTask[];
  };
  type WpTask = {
    n: number;
    title: string;
    satisfies: string[];
    files: { op: "modify" | "create"; repo: string; path: string }[];
    status: "pending" | "reported" | "verified" | "mismatch";
    inferred: boolean;
    reportMessageId: string | null;
    confirmedBy: "user" | null;
  };
  ```

  `repos` holds repo ids, and `blockedOn` holds a question id or null.
- `ReportInput.entries` accepts `W-n` too (the regex adds `W`). `ReportInput` gains `task: z.number().int().min(1).max(15).optional()`.
- `ReportCheck` gains `touchedFiles: string[]`, the union the check already computes.
- `TaskAssign` gains `limits?: { maxModelCalls: number; maxToolCalls: number; timeoutMs: number }`.
- `WORKPACKAGE_LIMITS = { maxModelCalls: 48, maxToolCalls: 120, timeoutMs: 1_200_000 }`.
- `MAX_WP_TASKS = 15`.
- Migration `009_workpackages.sql`:
  - `alter table tasks add column kind text not null default 'organize' check (kind in ('organize','workpackage'))`;
  - `alter table workspace_plugins add column settings jsonb not null default '{}'::jsonb`.

- [ ] **Step 1: Write the failing tests**:
  - `workpackage meta is required on that kind and rejected elsewhere`.
  - `W-n parses as workpackage`.
  - `ReportInput accepts W-2 and task 3, rejects task 16`.
  - `task.assign with limits parses; without limits parses`.
- [ ] **Step 2: Run** `npx vitest run packages/shared`. Expected: FAIL.
- [ ] **Step 3: Implement.** The daemon's `report.check` must also fill `touchedFiles`; update `apps/cli/src/repos/reportCheck.ts` and its test in this task.
- [ ] **Step 4: Run** `npx vitest run packages apps/cli/test/repos` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): work package kind, report task field and run limits`.

---

### Task 2: Knowledge store for work packages

**Files:**
- Modify: `packages/knowledge/src/store.ts`
- Test: `packages/knowledge/test/store.test.ts`

**Interfaces — Produces** (all under the repo lock, one commit each):
- `createWorkPackage(input: { title: string; requirements: string[]; repos: string[]; reason: string; sourceMessages: string[] }, meta): Promise<Entry>`. Creates `workpackages/W-n.md` with status `draft`, empty tasks and an empty body.
- `writeWorkPackageDoc(id, which: "spec" | "plan", markdown: string, update: { tasks?: WpTask[]; status?: "draft"; blockedOn?: string | null }, reason, sourceMessages, meta)`. Writes `W-n.spec.md` or `W-n.plan.md`. A save of either always sets status to `draft` and clears `approvedAt` / `approvedCommit`.
- `readWorkPackage(id): Promise<{ entry: Entry; spec: string | null; plan: string | null } | null>`.
- `setWorkPackageMeta(id, patch: Partial<Pick<WorkPackageMeta, "approvedAt" | "approvedCommit" | "blockedOn" | "tasks">> & { status?: WorkPackageStatus }, reason, meta)`. Used only by hub code paths, never exposed to the Agent.
- `recoverUncommitted` treats `W-n.spec.md` and `W-n.plan.md` as part of entry `W-n`, as it does for diagram `.json` siblings.
- `history(repoDir, "W-n")` covers commits touching any of the three files.

- [ ] **Step 1: Write the failing tests**:
  - `createWorkPackage makes W-1 as draft`.
  - `writing spec then plan keeps both and resets approval`.
  - `setWorkPackageMeta approves and records the commit`.
  - `a later plan write sets status back to draft and clears approval` (Review Focus 1, store half).
  - `recover handles W-n siblings`.
  - `history of W-1 includes spec and plan commits`.
- [ ] **Step 2: Run** `npx vitest run packages/knowledge`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(knowledge): work package files and metadata`.

---

### Task 3: Spec and plan checks (pure functions)

**Files:**
- Create: `apps/hub/src/wpFormat.ts`
- Test: `apps/hub/test/wpFormat.test.ts`

**Interfaces — Produces:**
- `checkSpec(md: string): { ok: true } | { ok: false; error: string }`.
  - It finds the `## 已定的做法` section, up to the next `## ` heading. Missing section → `spec 缺少「## 已定的做法」一节`.
  - Each list item (`- ` or `* ` or `1. `) in it must contain a marker matching `/\[(?:[RDTQSG]-[1-9]\d*|推断)\]/`.
  - Failures list the offending lines: `以下做法缺少来源标记（[R-3] 等）或 [推断]：\n<lines>`.
- `parsePlan(md: string, repoLabels: string[]): { ok: true; tasks: Omit<WpTask, "status" | "inferred" | "reportMessageId" | "confirmedBy">[] } | { ok: false; error: string }`.
  - Tasks come from `### 任务 <n>：<title>` headings, numbered 1..N in order; a gap or repeat → error.
  - Inside each task, `- 修改：<label>:<path>` gives a modify file and `- 新建：<label>:<path>` a create file. An unknown label → `任务 <n>：未知仓库 <label>`.
  - `- 满足：` holds a comma or `、` separated list of `R-n`.
  - More than 15 tasks → `任务超过 15 个，请拆成多个开发包`.
  - A task with no `满足` line, or with no file lines → error naming the task.
  - Paths must be relative, with no `..` segment.

- [ ] **Step 1: Write the failing tests**:
  - Spec: a passing spec; a missing section; one unmarked line listed; `[推断]` accepted.
  - Plan: a two-task plan parsed into files and satisfies; a numbering gap; 16 tasks; an unknown repo label; a `..` path; a missing `满足` line.
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/wpFormat.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): parse and check work package spec and plan`.

---

### Task 4: The `superpowers` plugin — vendored rules and `workpackage__*` functions

**Files:**
- Create: `vendor/superpowers-rules/LICENSE`, `vendor/superpowers-rules/VENDORED.md`, `vendor/superpowers-rules/spec-rules.md`, `vendor/superpowers-rules/plan-rules.md`, `apps/hub/src/workpackages.ts`
- Modify: `packages/shared/src/plugins.ts`, `apps/hub/src/roomApi.ts` (the hub-side dispatch next to `diagram__*`), `apps/cli/src/repos/handlers.ts` (new RPC), `Dockerfile` (copy `vendor/superpowers-rules`)
- Test: `apps/hub/test/workpackages.test.ts`, `apps/cli/test/repos/handlers.test.ts`

**Rules text.** Rewrite, don't copy, the essentials of superpowers 7.0.0's `brainstorming` "The Written Design" and `writing-plans`, from the local plugin cache at `~/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/` (MIT). `LICENSE` is that MIT text. `VENDORED.md` records the version and the date.
- `spec-rules.md` lists the spec sections in order: 意图与原因, 目标, 非目标, 反目标, 约束, `## 已定的做法` (with the marker rule), 留给实现者, 验收标准 (one group per requirement).
- `plan-rules.md` covers:
  - the header (目标, 架构, 对应 spec, 全局约束, Review Focus);
  - the task format with the exact markers from Global Constraints;
  - each task having test steps with test names and assertions, a verification command and a commit message;
  - the "no TBD / no lines that decide nothing" rule;
  - verifying every `修改` path with `code__read` before writing it;
  - the 15-task limit.
- Each file is under 4 KB.

**Interfaces — Produces:**
- Manifest `{ id: "superpowers", displayName: "superpowers", dataFlow: "local", runsOn: "hub", scope: "none" }`. Its functions, all `readOnly: true` (they write only this workspace's knowledge):
  - `workpackage__read(id)` returns `{ entry, spec, plan, rules: { spec, plan } }`;
  - `workpackage__save_spec(id, markdown)` runs `checkSpec`; on failure it returns `{ ok: false, error }` with HTTP 200, and on success writes, returning `{ ok: true }`;
  - `workpackage__save_plan(id, markdown)` runs `parsePlan` against the workspace's repo labels, then calls daemon RPC `repo.exists({ repo, paths })` per repo for the `modify` paths. Missing paths → `{ ok: false, error: "以下文件在主分支上不存在（新文件请写「新建」）：…" }`. On success it writes the plan and stores `tasks` (status `pending`, `inferred` false);
  - `workpackage__block(id, questionId)` sets `blockedOn`. The question must be an open question in this workspace;
  - `workpackage__request(requirements: string[], title?: string)` lets the chat path start a package (Task 6 implements the queueing);
  - `workpackage__mark_task_inferred(id, task, commits: string[])` sets a pending task to `reported`, with `inferred` true and no report id. This is the only status the Agent may set.

  Every function refuses a W-id that isn't a work package in this workspace (404 `找不到开发包 <id>`). Saves always go through `writeWorkPackageDoc`, so status falls back to draft.
- Daemon RPC `repo.exists({ repo, paths: string[] })` → `{ missing: string[] }`. It uses `git cat-file -e <mainRef>:<path>` with the foundation's path rules (no absolute paths, no `..`).
- The plugin is on by default. When it is off, the `workpackage__*` functions aren't offered, and the UI and chat requests are refused (Task 6).

- [ ] **Step 1: Write the failing tests**:
  - `save_spec with an unmarked decision line returns ok:false listing it and writes nothing`.
  - `save_plan with a modify path missing on main is refused; the same path as 新建 passes; an unknown label is refused` (Review Focus 4).
  - `save_plan stores parsed tasks as pending`.
  - `a save after approval resets the package to draft`.
  - `block requires an open question of this workspace`.
  - `mark_task_inferred only moves pending to reported+inferred`.
  - `the functions are not offered when the plugin is off`.
  - `repo.exists reports missing paths and rejects ..`.
- [ ] **Step 2: Run** `npx vitest run apps/hub apps/cli/test/repos`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: superpowers plugin for writing work packages`.

---

### Task 5: The `grill-me` plugin and settings

**Files:**
- Modify: `packages/shared/src/plugins.ts`, `apps/hub/src/plugins.ts`, `apps/hub/src/prompt.ts`, `apps/hub/src/daemonSocket.ts` (where the asked question is attached), `apps/hub/src/uiApi.ts`
- Test: `apps/hub/test/prompt.test.ts`, `apps/hub/test/plugins.test.ts`, `apps/hub/test/daemonSocket.test.ts`

**Interfaces — Produces:**
- Manifest `{ id: "grill", displayName: "grill-me", dataFlow: "local", runsOn: "hub", scope: "none", functions: [] }`, on by default.
- Settings `{ strictness: "strict" | "lenient", extraRules: string }`, stored in `workspace_plugins.settings`. The defaults are `strict` and `""`. `PATCH /api/workspaces/:id/plugins/grill` accepts `{ settings }`, validates it with zod, and rejects `extraRules` over 2000 characters with 400 `补充追问规则最多 2000 字`.
- Prompt changes in `buildPrompt`, which gets the grill state passed in:
  - **On:** the existing questioning rules stay. Append `追问严格程度：严格——任何会影响实现的问题都先问。` or `追问严格程度：宽松——只有决策互相冲突时才停下来问，其余写进待确认。`. Then, if `extraRules` is non-empty, `# 本 workspace 的补充追问规则\n<extraRules>`.
  - **Off:** keep the "不确定 → question" rule. Drop the behaviour of picking and showing an asked question: `onFinished` sets `askedQuestion: null`.

- [ ] **Step 1: Write the failing tests**:
  - `strict and lenient add their line`.
  - `extra rules are appended under their heading`.
  - `extraRules over 2000 chars is 400`.
  - `with grill-me off the uncertain-to-question rule stays and the finished message has no asked question` (Review Focus 5, organizing half).
- [ ] **Step 2: Run** `npx vitest run apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): grill-me plugin with strictness and extra rules`.

---

### Task 6: Generation — request, workpackage task kind, readiness prompt, larger limits, auto-retry

**Files:**
- Modify: `apps/hub/src/messages.ts` (`postSystemTask` gains `kind`), `apps/hub/src/tasks.ts`, `apps/hub/src/daemonSocket.ts`, `apps/hub/src/prompt.ts`, `apps/hub/src/workpackages.ts`, `apps/hub/src/uiApi.ts`, `apps/cli/src/direct/adapter.ts`, `apps/cli/src/claude/launch.ts`, `apps/cli/src/claude/adapter.ts`, `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md`
- Test: `apps/hub/test/workpackages.test.ts`, `apps/hub/test/prompt.test.ts`, `apps/hub/test/daemonSocket.test.ts`, `apps/cli/test/direct/adapter.test.ts`, `apps/cli/test/claude/launch.test.ts`

**Interfaces — Produces:**
- `requestWorkPackage(db, dataDir, events, workspaceId, { requirements, title? }, sourceMessageId?)`. It checks:
  - the superpowers plugin is on, else 409 `superpowers 插件已关闭`;
  - every id is an active requirement, else 400;
  - the workspace has at least one bound repo, else 409 `请先绑定代码仓库`.

  It then creates `W-n` (title defaults to the first requirement's title) and calls `postSystemTask(db, ws, "为 <W-n> 生成开发包，覆盖 <R 列表>。", { kind: "workpackage" })`.
  - UI: `POST /api/workspaces/:id/workpackages` with `{ requirements, title? }`.
  - Room: `workpackage__request` calls the same function.
- `task.assign` for a `workpackage` task carries `limits: WORKPACKAGE_LIMITS`.
- **Direct adapter:** `limits` overrides `maxModelCalls` / `maxToolCalls` and the run timeout.
- **Claude:** `--max-turns` becomes `limits.maxModelCalls`, and the tool cap and timeout take the limits too. Without `limits`, the current 24 / 60 / 10 min stay.
- **Prompt for a workpackage task.** Add the section `# 开发包 <W-n>`, with the requirement ids, the bound repos (id and label), the grill strictness, and the vendored `spec-rules.md` and `plan-rules.md` texts. Then the steps:
  1. 就绪检查——读相关需求、决策、取舍、待确认与 inferred 内容；有会影响实现的不确定点时，为每个建 question，用 workpackage__block 记录最重要的那个，不要写 spec，回复说明卡在哪里。
  2. 否则先 workpackage__save_spec，再用 code__ 函数核对文件后 workpackage__save_plan；保存被拒时按返回的错误修改再保存。
  3. 回复简短说明开发包的状态和任务数。

  With grill-me off, step 1 is replaced by `不做就绪检查；把所有不确定点写进 spec 的「留给实现者」或「待确认」小节。`. With lenient, step 1 only stops on conflicting decisions.
- **Auto-retry.** When an entry write resolves a question that some `draft` package has as `blockedOn`, the hub clears `blockedOn` and queues the same generation system task once. Hook this into the Room upsert's post-commit bookkeeping, and the UI edit route.
- **Runtime spec amendment** (marked `2026-10-23 开发包修订`): work-package tasks run with 48 / 120 / 20 min.

- [ ] **Step 1: Write the failing tests**:
  - `request creates W-1 and queues one workpackage task`.
  - `request is refused with no repo, with a non-active requirement, and with superpowers off`.
  - `the workpackage task.assign carries the 48/120/20min limits; an organize task does not`.
  - `the direct adapter stops at limits.maxModelCalls`.
  - `claude gets --max-turns 48 for a workpackage task`.
  - `the prompt includes both rule files and the readiness steps; with grill off it skips the stop` (Review Focus 5, generation half).
  - `resolving the blocking question re-queues generation once`.
- [ ] **Step 2: Run** `npx vitest run apps/hub apps/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: generate work packages with a readiness check and larger limits`.

---

### Task 7: Approve, edit, regenerate, drop

**Files:**
- Modify: `apps/hub/src/uiApi.ts`, `apps/hub/src/workpackages.ts`
- Test: `apps/hub/test/workpackages.test.ts`

**Interfaces — Produces** (UI routes, user only):
- `POST /api/workspaces/:id/workpackages/:wid/approve` sets `approved`, `approvedAt = now` and `approvedCommit = the current HEAD of the knowledge repo`. It needs both a spec and a plan, else 409 `开发包还没有 spec 和 plan`, and a status of `draft`.
- `PUT /api/workspaces/:id/workpackages/:wid/spec` and `.../plan` with `{ markdown }` save as author `user`. A plan edit re-runs `parsePlan` and the `repo.exists` check (400 with the error). Both reset to `draft`.
- `POST .../regenerate` queues the generation task again; on a `done` package it is 409.
- `POST .../drop` sets `dropped`.
- `GET /api/workspaces/:id/workpackages/:wid` returns `{ entry, spec, plan }`.
- The Agent has no path to set `approved` / `in_progress` / `done` / `dropped`. Add a test that each `workpackage__*` call leaves those untouched.

- [ ] **Step 1: Write the failing tests**:
  - `approve needs spec and plan and records the commit`.
  - `editing an approved plan resets to draft and approving again records the new commit` (Review Focus 1).
  - `regenerate on done is 409`.
  - `drop sets dropped`.
  - `no workpackage__ function can set approved/in_progress/done/dropped`.
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/workpackages.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): approve, edit, regenerate and drop work packages`.

---

### Task 8: Handoff — `nema wp list` / `nema wp get`

**Files:**
- Modify: `apps/hub/src/reports.ts` (report-token routes), `apps/cli/src/index.ts`, `apps/cli/src/report/SKILL.md`
- Create: `apps/cli/src/wp/commands.ts`
- Test: `apps/hub/test/reports.test.ts`, `apps/cli/test/wp/commands.test.ts`

**Interfaces — Produces:**
- Hub, with the report token, routing by `gitCommonDir` like `/report`:
  - `GET /report/workpackages?gitCommonDir=…` lists the `approved` or `in_progress` packages whose `repos` include the routed repo, as `{ id, title, tasks: n }`;
  - `GET /report/workpackages/:wid?gitCommonDir=…` returns `{ id, title, spec, plan }` for such a package, else 404 `没有可取的开发包 <wid>`.
- `nema wp list` prints `W-2  <title>  (<n> 个任务)` lines, or `当前仓库没有已批准的开发包`.
- `nema wp get <W-n> [--dir <d>] [--stdout] [--force]`:
  - It writes `<dir default: cwd>/.nema/<W-n>/spec.md` and `plan.md`.
  - The plan is prefixed with a fixed block: `> 做完每个任务后运行：nema report --entries <W-n> --task <n> --summary "…" --commits <sha,…> --files <path,…>`.
  - If a target file exists with different content and there is no `--force`: exit 1 `<path> 已存在且内容不同；加 --force 覆盖`.
  - Outside a repo: exit 1 `不在 git 仓库里`.
- `nema report` gains `--task <n>`.
- `SKILL.md` gains: "If `.nema/W-*/plan.md` exists in your working tree, report each finished task with `--entries W-n --task <n>`."

- [ ] **Step 1: Write the failing tests**:
  - Hub: `only approved/in_progress packages for the routed repo are listed and served`, and `a draft package is 404`.
  - CLI: `get writes spec and plan with the report prefix`, `get refuses to overwrite different content without --force`, `--stdout prints without writing`, `list prints the empty message`.
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/reports.test.ts apps/cli/test/wp`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npm run build -w apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: hand work packages to coding agents with nema wp`.

---

### Task 9: Progress from reports

**Files:**
- Modify: `apps/hub/src/reports.ts`, `apps/hub/src/workpackages.ts`, `apps/hub/src/uiApi.ts`
- Test: `apps/hub/test/workpackages.test.ts`, `apps/hub/test/reports.test.ts`

**Interfaces — Produces:**
- `applyReportToWorkPackage(db, dataDir, events, workspaceId, reportMessage)` runs after a report's check is stored, on the first check and on re-checks after main moves. It applies when the report's `entries` include exactly one `W-n` that is `approved` or `in_progress`, and `task` names an existing task. Otherwise it does nothing (Review Focus 2). It sets the task status this way:
  - `verified` when `reportPassed(check)` and at least one of the task's file paths appears in `check.touchedFiles` (paths compared as repo-relative);
  - `mismatch` when commits are missing, `filesOk` is false, or none of the task's paths was touched;
  - `reported` when `onMain` is `not-yet`.

  A `verified` task is never downgraded; a later passing report upgrades `reported` or `mismatch` (Review Focus 3). Each change commits through `setWorkPackageMeta` as author `system`, with reason `上报 <messageId> → 任务 <n>：<status>`.
- **Derived package status.**
  - When any task is no longer `pending` and the package is `approved`, it becomes `in_progress`.
  - When every task is `verified` and the package is not `done`, it becomes `done`. Then every requirement in `requirements` gets `implementation = { status: "verified", evidence: { reportMessageId: <the last task's report>, commits: <union of the tasks' report commits>, inferred: false, note: "开发包 <W-n> 全部任务已核实", confirmedBy: null } }` unless it is already verified. That commit is by `system`.
- `POST /api/workspaces/:id/workpackages/:wid/tasks/:n/confirm` turns a `reported` (including `inferred`) or `mismatch` task into `verified` with `confirmedBy: "user"`, then re-derives the status.
- The report prompt (Plan C) gains `本上报属于开发包 <W-n> 的任务 <n>；任务状态由系统根据核实结果设置，不要用 workpackage__ 函数改它。` when it applies.

- [ ] **Step 1: Write the failing tests**:
  - `a passing report touching the task's file verifies the task and moves the package to in_progress`.
  - `a passing report that touches none of the task's files is mismatch`.
  - `a not-yet report is reported, and a later re-check makes it verified`.
  - `a later failing report does not downgrade verified` (Review Focus 3).
  - `an unknown task number or a draft package changes nothing` (Review Focus 2).
  - `all tasks verified → done, and the requirements become verified with evidence`.
  - `user confirm of an inferred task verifies it`.
- [ ] **Step 2: Run** `npx vitest run apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): work package progress from report checks`.

---

### Task 10: Web — generate, the work package group and detail, settings

**Files:**
- Create: `apps/web/components/WorkPackageDetail.tsx`
- Modify: `apps/web/components/KnowledgePanel.tsx`, `apps/web/components/EntryDetail.tsx`, `apps/web/components/MessageItem.tsx`, `apps/web/components/CodeAndPlugins.tsx`, `apps/web/lib/hub.ts`, `apps/web/lib/types.ts`, and the web message catalogs (`apps/web/messages/{ja,en,zh}.json`, the current i18n source)
- Test: `apps/web/test/WorkPackageDetail.test.tsx`, `apps/web/test/KnowledgePanel.test.tsx`, `apps/web/test/EntryDetail.test.tsx`, `apps/web/test/CodeAndPlugins.test.tsx`, `apps/web/test/i18n.test.tsx`

**Behaviour:**
- **Generating.**
  - Requirement detail gets a `wp.generate` button that requests a package for that one requirement.
  - The requirements group header gets `wp.select`. It turns on checkboxes, with a `wp.generateSelected` button that requests one package for the checked requirements.
  - Hub errors (no repo, superpowers off) show inline.
- **The group.** A new group `know.workpackages`, between 待确认 and 当前需求. A blocked draft shows the tag `wp.blocked`, linking to the question. Statuses use these tags: `wp.status.draft`, `.approved`, `.in_progress`, `.done`, `.dropped`.
- **Detail.** Tabs `wp.tab.overview` / `wp.tab.spec` / `wp.tab.plan` / `wp.tab.history`.
  - Overview: status, covered requirements as links, and one row per task with the implementation status tag style from Plan C, its report link and a `impl.confirm` button where allowed.
  - Spec and Plan: rendered Markdown, where `[R-3]`-style markers are clickable, plus an edit mode (textarea, save → PUT).
  - History: the existing history view.
  - Buttons: `wp.approve` (draft with spec and plan), `wp.regenerate`, `wp.drop`.
- **Chat.** The agent reply that ends a workpackage task shows a card with id, status and task count, or the blocking question.
- **Code & plugins page.** The grill-me row gets a strictness select (`grill.strict` / `grill.lenient`), an extra-rules textarea with a counter out of 2000, and save.
- **i18n**, exact values:

| key | zh | ja | en |
|---|---|---|---|
| `know.workpackages` | 开发包 | 開発パッケージ | Work packages |
| `wp.generate` | 生成开发包 | 開発パッケージを作成 | Generate work package |
| `wp.select` | 选择需求 | 要件を選択 | Select requirements |
| `wp.generateSelected` | 为所选需求生成开发包 | 選択した要件で作成 | Generate for selected |
| `wp.blocked` | 待澄清 | 確認待ち | Needs answers |
| `wp.status.draft` | 草稿 | 下書き | Draft |
| `wp.status.approved` | 已批准 | 承認済み | Approved |
| `wp.status.in_progress` | 进行中 | 進行中 | In progress |
| `wp.status.done` | 已完成 | 完了 | Done |
| `wp.status.dropped` | 已放弃 | 中止 | Dropped |
| `wp.tab.overview` | 概览 | 概要 | Overview |
| `wp.tab.spec` | Spec | Spec | Spec |
| `wp.tab.plan` | Plan | Plan | Plan |
| `wp.tab.history` | 历史 | 履歴 | History |
| `wp.approve` | 批准 | 承認 | Approve |
| `wp.regenerate` | 重新生成 | 再生成 | Regenerate |
| `wp.drop` | 放弃 | 中止 | Drop |
| `wp.edit` | 编辑 | 編集 | Edit |
| `wp.save` | 保存 | 保存 | Save |
| `grill.strict` | 严格：影响实现的问题都先问 | 厳格：実装に影響する点はすべて先に確認 | Strict: ask everything that affects implementation |
| `grill.lenient` | 宽松：只在决策冲突时停下 | 緩め：決定が矛盾するときだけ止まる | Lenient: stop only on conflicting decisions |
| `grill.extraRules` | 补充追问规则 | 追加の確認ルール | Extra questioning rules |

- [ ] **Step 1: Write the failing tests**:
  - `generate from a requirement posts and shows the hub error inline`.
  - `selecting two requirements generates one package`.
  - `the group shows status tags and 待澄清 with the question link`.
  - `detail tabs render spec markers as links, edit saves, approve appears only for a draft with spec and plan`.
  - `task rows show status and confirm`.
  - `the grill settings save and enforce the 2000 counter`.
  - `every new key exists in ja, en and zh`.
- [ ] **Step 2: Run** `npx vitest run apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/web` and `npm run build -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): work packages and grill-me settings`.

---

### Task 11: End-to-end check and README

- [ ] **Step 1: Write the end-to-end test** `apps/hub/test/workpackage.e2e.test.ts`. It uses a real hub on PGlite, a real daemon RPC router, a temp repo with a local bare origin, fake graphify, and a scripted fake model: a fake Responses server whose turns call `workpackage__*` in order. Steps:
  1. bind the repo;
  2. request a package for R-1 and R-2;
  3. the scripted model first blocks on a question;
  4. answer it → generation re-runs and saves spec and plan;
  5. approve;
  6. `nema wp get` writes the files;
  7. commit task 1 to origin/main and `nema report --entries W-1 --task 1`;
  8. task 1 is verified and the package is in_progress;
  9. user-confirm task 2 → done, and R-1 and R-2 are verified.
- [ ] **Step 2: Run it.** Expected: PASS.
- [ ] **Step 3: Add a README section "Work packages"**. It covers:
  - generating;
  - the grill step and its settings;
  - the spec markers and plan format;
  - approval resetting on edits;
  - `nema wp list/get`;
  - reporting per task;
  - how status and done work;
  - the superpowers attribution.
- [ ] **Step 4: Run** `npx vitest run` three times, plus `npx tsc -b`, `npm run typecheck -w apps/cli`, `npm run build -w apps/cli` and `npm run build -w apps/web`. Expected: all PASS every time.
- [ ] **Step 5: Commit** `docs: work packages in README`.
