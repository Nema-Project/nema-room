# Codebase Foundation Implementation Plan (repos, plugin framework, graphify)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a workspace bind several local repos, and let the organizing Agent read them through Room-scoped, read-only plugin functions backed by graphify and git, managed from a global plugins page and a per-workspace settings page.

**Architecture:** A plugin registry in `@nema/shared` describes each plugin's data flow and functions. The hub owns bindings and per-workspace plugin settings. It exposes enabled functions to the Agent under the Room API and forwards each call over a new request/response channel on the daemon WebSocket. The daemon executes the call against the repo, since only the daemon can see host paths. graphify always parses a snapshot of `origin/<main>` under `~/.nema/ws/<id>/`, never the user's checkout. Both adapters (`codex-direct`, `claude-code`) and `nema mcp` declare the extra functions from the same list.

**Tech Stack:** TypeScript monorepo, zod v4, Hono, `ws`, PostgreSQL/PGlite, git CLI, graphify CLI (`graphifyy`, Python), MCP TypeScript SDK, Next.js + React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md`. This plan covers decisions 1, 2 and 3, decision 7 (except the diagram group and the implementation-status marks), and the main-branch rule. Follow-up plans cover the rest:
- **Plan B:** archify diagrams (decision 4, plus the right-panel "代码图" group).
- **Plan C:** nema report, implementation status and the no-report fallback (decisions 5 and 8). It depends on `docs/superpowers/plans/2026-10-23-review-decisions.md` (basis + confirm) being merged.
- **Plan D:** the read-only GitHub plugin (decision 6).

Plan B, C and D are written after this plan lands, because they consume its interfaces.

## Global Constraints

- Work on `main`. Don't push. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never run real graphify, git remotes over the network, models or GitHub. Use fake executables, and local bare repos as `origin`.
- The Agent reaches plugins only through Room. There is still exactly one MCP server (`room`), and Claude keeps `--tools ""`.
- Plugin functions are named `<pluginId>__<function>`. The graphify plugin id is `code`, with functions `code__search`, `code__explain`, `code__path`, `code__read` and `code__changes`.
- Only read-only functions can be enabled in v1. `local` plugins are on by default, in confidential workspaces too. `external` plugins are off by default.
- The main branch is `origin/<mainBranch>`. When the repo has no `origin`, fall back to the local `<mainBranch>`.
- The daemon fetches with `git fetch --no-tags origin <mainBranch>` every **5 minutes**. Never touch the working tree or local branches.
- `code__read` returns at most **400 lines** and **64 KB** per call, from `origin/<main>` via `git show`.
- graphify runs only on the snapshot directory, with `--code-only`, `GRAPHIFY_BACKEND=none` and `GRAPHIFY_QUERY_LOG_DISABLE=1`. Its environment starts empty: `PATH`, `LANG`, `HOME=<snapshot root>/home`, plus those two variables. Never run `graphify install`, `graphify <platform> install` or `graphify hook install`.
- The user's repo is never written to. `git fetch` updating `.git` refs and objects is the one allowed exception.
- Hub user-facing error text is Chinese. Web copy exists in ja / en / zh, in the existing Swiss style.

## Review Focus

1. **Path escapes in `code__read`**: an absolute path, `../x`, `a/../../x`, or a path whose blob is a symlink pointing outside the repo are all rejected without reading. Pinned in Task 3.
2. **Daemon offline**: binding a repo, or an Agent calling a plugin function, while no daemon is connected returns a clear Chinese error quickly, not a hang. Hub RPC calls time out after **30 s**. Pinned in Tasks 2 and 5.
3. **The same repo through two paths**: binding `~/dev/x` to two workspaces is rejected, even when the second binding uses a different spelling that resolves to the same git common dir (a symlinked path, or a trailing slash). Pinned in Task 4.
4. **Repo without `origin`, or fetch failing offline**: binding still works on the local branch; the settings page shows "no origin" or the last successful fetch time; the plugin functions keep working on the last known ref. Pinned in Tasks 3 and 7.
5. **The user's repo stays untouched**: after binding, indexing, `code__*` calls and a watcher cycle, the bound repo's `git status --porcelain` output and working-tree file list are identical to before. Pinned in Task 4 (indexing) and Task 9 (end to end).

---

### Task 1: Shared plugin registry and the daemon RPC protocol

**Files:**
- Create: `packages/shared/src/plugins.ts`
- Modify: `packages/shared/src/protocol.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/plugins.test.ts`, `packages/shared/test/protocol.test.ts`

**Interfaces — Produces:**
- `type DataFlow = "local" | "external"`.
- `type PluginFunction = { name: string; description: string; parameters: Record<string, unknown> /* JSON Schema object */; readOnly: boolean }`. `name` is the full `<pluginId>__<fn>`.
- `type PluginManifest = { id: string; displayName: string; dataFlow: DataFlow; functions: PluginFunction[] }`.
- `PLUGINS: readonly PluginManifest[]`. This plan registers only `{ id: "code", displayName: "graphify", dataFlow: "local", functions: [...] }`, with the five `code__*` functions, all `readOnly: true`. Every one requires `repo: string`. Other parameters:
  - `code__search`: `query: string`
  - `code__explain`: `symbol: string`
  - `code__path`: `from: string`, `to: string`
  - `code__read`: `path: string`, `startLine?: integer ≥1`, `endLine?: integer ≥1`
  - `code__changes`: `from: string`, `to?: string` (defaults to the current main ref)
- `pluginFunction(name: string): { plugin: PluginManifest; fn: PluginFunction } | null`.
- `type PluginToolSpec = { name: string; description: string; parameters: Record<string, unknown> }`. This is what an adapter declares to the model.
- Protocol additions:
  - `TaskAssign` gains `pluginTools: PluginToolSpec[]`, required. Hub and CLI ship together; the existing version-skew handling covers old daemons.
  - HubToDaemon `{ type: "rpc.request", id: string, method: string, params: unknown }`.
  - DaemonToHub `{ type: "rpc.response", id: string, ok: true, result: unknown } | { type: "rpc.response", id: string, ok: false, error: string }`.
  - DaemonToHub `{ type: "repo.moved", repoId: string, mainRef: string, from: string | null, to: string }` and `{ type: "repo.fetched", repoId: string, ok: boolean, error?: string, at: string }`, used by Task 7.

- [ ] **Step 1: Write the failing tests**
  - `every registered function is named <pluginId>__<fn> and read-only`.
  - `repo.fetched round-trips through the parser`.
  - `pluginFunction resolves code__read and rejects an unknown name`.
  - `every code__ function requires repo`.
  - `task.assign without pluginTools fails to parse; with [] parses`.
  - `rpc.request / rpc.response / repo.moved round-trip through the parsers`.
- [ ] **Step 2: Run** `npx vitest run packages/shared`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the JSON Schemas as plain literals in `plugins.ts`; they are what the models see.
- [ ] **Step 4: Run** `npx vitest run packages/shared`. Expected: PASS. Compile errors in the hub and CLI from the required `pluginTools` are expected; send `pluginTools: []` from the hub's `task.assign` for now to keep `npx tsc -b` green.
- [ ] **Step 5: Commit** `feat(shared): plugin registry and daemon rpc messages`.

---

### Task 2: Hub ↔ daemon RPC channel

**Files:**
- Create: `apps/hub/src/daemonRpc.ts`, `apps/cli/src/daemon/rpc.ts`
- Modify: `apps/hub/src/daemonSocket.ts`, `apps/hub/src/app.ts`, `apps/hub/src/main.ts`, `apps/cli/src/daemon/connection.ts`
- Test: `apps/hub/test/daemonRpc.test.ts`, `apps/cli/test/rpc.test.ts`, `apps/hub/test/daemonSocket.test.ts`

**Interfaces — Produces:**
- Hub: `interface DaemonRpc { call(method: string, params: unknown, timeoutMs?: number): Promise<unknown> }`. It rejects with `DaemonRpcError` whose `.message` is Chinese:
  - `daemon 未连接` when there is no connection;
  - `daemon 响应超时` after the timeout (default **30 000 ms**);
  - the daemon's error text when it replies `ok: false`;
  - `daemon 已断开` when the connection closes mid-call.
- `AppDeps` gains `daemon: DaemonRpc`. `main.ts` passes a late-bound object, the same pattern as `status`. `attachDaemonSocket` returns `{ isConnected, rpc }`.
- CLI: `type RpcHandler = (params: unknown) => Promise<unknown>` and `class RpcRouter { register(method: string, h: RpcHandler): void; handle(req): Promise<rpc.response> }`. An unknown method replies `ok: false, error: "未知方法 <method>"`. A handler that throws replies `ok: false` with the thrown message.
- RPC requests are handled concurrently with the task runner. They must never be queued behind a running task, because a running Agent waits on them.

- [ ] **Step 1: Write the failing tests**
  - Hub: `call resolves with the daemon's result`; `call rejects with daemon 未连接 when no daemon`; `call rejects with daemon 响应超时 after the timeout` (inject a short timeout); `in-flight calls reject with daemon 已断开 when the socket closes`; `a response with an unknown id is ignored`.
  - CLI: `RpcRouter answers a registered method`; `unknown method returns 未知方法`; `a throwing handler returns ok:false with its message`; `an rpc.request is answered while a task is running` (enqueue a never-ending fake adapter, then send `rpc.request`, and the response arrives).
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/daemonRpc.test.ts apps/cli/test/rpc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The hub keeps a `Map<id, {resolve, reject, timer}>` per connection, and request ids come from `nanoid`. `connection.ts` accepts an optional `rpc: RpcRouter` in `DaemonOpts` and dispatches `rpc.request` to it without going through `runner`.
- [ ] **Step 4: Run** `npx vitest run apps/hub apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: request/response channel between hub and daemon`.

---

### Task 3: Daemon git operations with path safety

**Files:**
- Create: `apps/cli/src/repos/git.ts`
- Test: `apps/cli/test/repos/git.test.ts`

**Interfaces — Produces** (all take an absolute `repoPath`; all run `git -C <repoPath>` with a minimal env and `GIT_TERMINAL_PROMPT=0`):
- `inspectRepo(path: string): Promise<{ root: string; gitCommonDir: string; defaultBranch: string; hasOrigin: boolean; remoteUrl: string | null }>`.
  - It rejects with `不是 git 仓库的根目录` when `path` is not the top level (`git rev-parse --show-toplevel` ≠ the realpath of `path`).
  - It rejects with `不能绑定 ~/.nema 之下的目录` when the path is under the given `nemaHome`.
  - `defaultBranch` comes from `git symbolic-ref --short refs/remotes/origin/HEAD` with `origin/` stripped, else `main`.
- `mainRef(repoPath: string, mainBranch: string): Promise<string>`. Returns `origin/<mainBranch>` if `refs/remotes/origin/<mainBranch>` exists, else `<mainBranch>`.
- `fetchMain(repoPath: string, mainBranch: string): Promise<{ ok: true } | { ok: false; error: string }>`. Runs `git fetch --no-tags origin <mainBranch>` with a **60 s** timeout. It never throws. With no origin it returns `{ ok: false, error: "没有 origin" }`.
- `revParse(repoPath: string, ref: string): Promise<string>`. Returns the full sha.
- `readFileAtRef(repoPath: string, ref: string, relPath: string, range?: { startLine?: number; endLine?: number }): Promise<{ path: string; startLine: number; endLine: number; totalLines: number; text: string; truncated: boolean }>`.
  - Reject before running git with `路径必须是仓库内的相对路径` when `relPath` is absolute, empty, or contains a `..` segment after normalization.
  - Reject with `<path> 是符号链接，已拒绝` when `git ls-tree` reports mode `120000`, and with `<path> 不存在于 <ref>` when it is not a blob.
  - Cap the result at **400 lines** and **65 536 bytes**; set `truncated` when the cap cuts it.
- `changedFiles(repoPath: string, from: string, to: string): Promise<{ status: string; path: string }[]>`. Runs `git diff --name-status -M`; a rename reports the new path. `from` and `to` must match `/^[0-9a-f]{7,40}$/` or equal the current `mainRef`; otherwise reject with `无效的提交 <x>`.
- `exportSnapshot(repoPath: string, ref: string, destDir: string): Promise<void>`. Runs `git archive --format=tar <ref>` piped into `tar -x -C destDir` after emptying `destDir`.

- [ ] **Step 1: Write the failing tests.** Use a temp repo with a local bare repo as `origin`; no network.
  - `inspectRepo reports root, common dir, default branch and origin`.
  - `inspectRepo rejects a subdirectory and a path under nemaHome`.
  - `inspectRepo on a repo without origin reports hasOrigin false and default branch main`.
  - `mainRef prefers origin/<branch> and falls back to the local branch`.
  - `fetchMain picks up a commit pushed to origin without changing the working tree or local branch`: before and after, compare `git status --porcelain`, `git rev-parse main`, and the file list.
  - `fetchMain without origin returns 没有 origin`.
  - `readFileAtRef reads a line range at origin/main, not the working tree`: the working tree has an uncommitted edit, and the result shows the committed text.
  - `readFileAtRef rejects absolute, empty, .. and a/../../x paths` (Review Focus 1).
  - `readFileAtRef rejects a symlink blob` (Review Focus 1).
  - `readFileAtRef caps at 400 lines and 64 KB and sets truncated`.
  - `changedFiles lists added, modified, deleted and renamed paths`.
  - `changedFiles rejects a non-sha ref other than the main ref`.
  - `exportSnapshot writes the ref's tree into destDir and leaves the repo untouched`.
- [ ] **Step 2: Run** `npx vitest run apps/cli/test/repos/git.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `execFile` (no shell) and a fixed env of `PATH`, `HOME` and `LANG`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): read-only git operations for bound repos`.

---

### Task 4: Repo bindings in the hub, and the graphify index on the daemon

**Files:**
- Create: `apps/hub/src/db/migrations/005_repos_plugins.sql`, `apps/hub/src/repos.ts`, `apps/cli/src/repos/graphify.ts`, `apps/cli/src/repos/handlers.ts`
- Modify: `apps/hub/src/uiApi.ts`, `apps/cli/src/daemon/setup.ts`
- Test: `apps/hub/test/repos.test.ts`, `apps/hub/test/uiApi.test.ts`, `apps/cli/test/repos/graphify.test.ts`, `apps/cli/test/repos/handlers.test.ts`

Name the migration `005_…` if `004_task_interruptions.sql` from the review-decisions plan already exists; otherwise use the next free number.

**Schema:**

```sql
create table workspace_repos (
  id text primary key,                -- repo_<nanoid>
  workspace_id text not null references workspaces(id) on delete cascade,
  path text not null,                 -- realpath on the daemon machine
  git_common_dir text not null unique,
  label text not null,
  main_branch text not null,
  has_origin boolean not null,
  remote_url text,
  last_main_sha text,
  last_fetch_at timestamptz,
  last_fetch_error text,
  created_at timestamptz not null default now()
);
create table workspace_plugins (
  workspace_id text not null references workspaces(id) on delete cascade,
  plugin_id text not null,
  enabled boolean not null,
  disabled_functions text[] not null default '{}',
  primary key (workspace_id, plugin_id)
);
create table plugin_calls (
  id bigserial primary key,
  task_id text not null,
  name text not null,
  args_summary text not null,          -- first 200 chars of the JSON args
  ok boolean not null,
  result_bytes int not null,
  ms int not null,
  created_at timestamptz not null default now()
);
```

**Interfaces — Produces:**
- Hub `repos.ts`:
  - `type Repo = { id; workspaceId; path; gitCommonDir; label; mainBranch; hasOrigin; remoteUrl; lastMainSha; lastFetchAt; lastFetchError }`.
  - `listRepos(db, workspaceId): Promise<Repo[]>`.
  - `getRepo(db, repoId): Promise<Repo | null>`.
  - `findRepoForWorkspace(db, workspaceId, ref: string): Promise<Repo | null>`. `ref` is either the id or the label, case-sensitive.
  - `bindRepo(db, daemon, workspaceId, { path, label, mainBranch? }): Promise<Repo>`. It calls daemon RPC `repo.inspect` and stores the row. A duplicate `git_common_dir` rejects with HTTP 409 `该仓库已绑定到 workspace <name>`. It then fires daemon RPC `repo.index` without awaiting it, and logs failures.
  - `updateRepo(db, repoId, { label?, mainBranch? })` and `unbindRepo(db, daemon, repoId)`. Unbinding also fires daemon RPC `repo.forget`.
- UI routes:
  - `GET /api/workspaces/:id/repos`;
  - `POST /api/workspaces/:id/repos` with body `{ path, label, mainBranch? }`;
  - `PATCH /api/workspaces/:id/repos/:repoId`;
  - `DELETE /api/workspaces/:id/repos/:repoId`.

  Without a connected daemon, `POST` returns 503 `daemon 未连接，无法校验仓库`.
- Daemon handlers registered on the `RpcRouter`. `repo` params carry `{ workspaceId, repoId, path, mainBranch }`.
  - `repo.inspect({ path })` → `inspectRepo` result.
  - `repo.index(repo)`:
    1. `fetchMain`;
    2. `exportSnapshot(path, mainRef, <nemaHome>/ws/<workspaceId>/graphify/<repoId>/src)`;
    3. `graphify extract <src> --code-only` (with the env from Global Constraints);
    4. return `{ sha }`.
  - `repo.forget(repo)` removes `<nemaHome>/ws/<workspaceId>/graphify/<repoId>`.
- `apps/cli/src/repos/graphify.ts`:
  - `graphifyEnv(snapshotRoot: string): NodeJS.ProcessEnv`;
  - `buildIndex(snapshotRoot: string): Promise<void>`;
  - `updateIndex(snapshotRoot: string, changed: { status: string; path: string }[], repoPath: string, ref: string): Promise<void>`. It writes changed files from `git show ref:path` into `src/`, deletes removed ones, then runs `graphify update <src>`;
  - `queryIndex(snapshotRoot, kind: "query" | "explain" | "path", args: string[]): Promise<string>`. It runs `graphify query|explain|path …` with `cwd = <snapshotRoot>/src`, maps exit code 3 to `名称不唯一`, maps 4 to `没有匹配`, and caps output at 64 KB.
  - The graphify binary comes from `NEMA_GRAPHIFY_BIN`, else `graphify` on PATH. A missing binary rejects with `graphify 未安装：请运行 uv tool install graphifyy`.

**Verify first:** before Step 3, run `graphify --help` and `graphify extract --help` locally, if installed, to confirm `extract`, `--code-only`, `update`, `query`, `explain`, `path` and the output location inside the snapshot. If a flag differs, use the real one and note it in the commit message. If graphify cannot run offline on a code-only snapshot, stop and report: the spec requires it.

- [ ] **Step 1: Write the failing tests**
  - Hub (fake `DaemonRpc`):
    - `binding stores the inspected repo and fires repo.index`.
    - `binding the same git common dir twice is 409 even through a different path spelling` (Review Focus 3). The fake inspect returns the same `gitCommonDir` for `/a/x` and `/a/x/`.
    - `binding without a daemon is 503 daemon 未连接，无法校验仓库` (Review Focus 2).
    - `unbinding fires repo.forget and deleting the workspace removes its repos`.
    - `findRepoForWorkspace matches id or label and never another workspace's repo`.
  - CLI. A fake graphify is an executable script that records its argv, cwd and env into a file and writes a `graph.json` in a `graphify-out/` under its cwd; point to it with `NEMA_GRAPHIFY_BIN`.
    - `repo.index exports origin/main into the snapshot and runs graphify extract --code-only there`.
    - `graphify runs with only PATH, LANG, HOME=<root>/home, GRAPHIFY_BACKEND=none, GRAPHIFY_QUERY_LOG_DISABLE=1`.
    - `indexing leaves the bound repo's git status and file list unchanged` (Review Focus 5).
    - `queryIndex maps exit 3 to 名称不唯一 and exit 4 to 没有匹配`.
    - `a missing graphify binary gives the install hint`.
    - `updateIndex writes changed files, deletes removed ones and runs graphify update`.
- [ ] **Step 2: Run** `npx vitest run apps/hub apps/cli`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub apps/cli` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: bind repos to workspaces and index them with graphify`.

---

### Task 5: Room plugin endpoints and per-workspace plugin settings

**Files:**
- Create: `apps/hub/src/plugins.ts`
- Modify: `apps/hub/src/roomApi.ts`, `apps/hub/src/uiApi.ts`, `apps/hub/src/daemonSocket.ts`
- Test: `apps/hub/test/plugins.test.ts`, `apps/hub/test/roomApi.test.ts`

**Interfaces — Produces:**
- `workspacePluginState(db, workspaceId): Promise<{ plugin: PluginManifest; enabled: boolean; disabledFunctions: string[] }[]>`. With no row, `enabled = plugin.dataFlow === "local"`.
- `enabledPluginTools(db, workspaceId): Promise<PluginToolSpec[]>`. Includes the functions of enabled plugins that are `readOnly`, not disabled and, for `code`, only when the workspace has at least one bound repo. The `repo` parameter's description lists the bound repos as `id (label)` so the model can pick one.
- `setPluginState(db, workspaceId, pluginId, { enabled?, disabledFunctions? })`. An unknown `pluginId` is 404. Each `disabledFunctions` entry must name one of that plugin's functions, else 400 `未知函数 <name>`. Functions with `readOnly: false` are never offered, whatever the stored state is.
- Room routes, run-token scoped like the existing ones:
  - `GET /room/plugins` → `{ tools: PluginToolSpec[] }`.
  - `POST /room/plugins/:name` with body = the function's arguments. Checks, in order:
    1. the name is in `enabledPluginTools` for this task's workspace, else 403 `函数 <name> 未在本 workspace 开启`;
    2. args are a JSON object with a string `repo` that `findRepoForWorkspace` resolves, else 400 `repo 不是本 workspace 绑定的仓库：<value>`;
    3. forward with `daemon.call("plugin.call", { name, args, repo: { workspaceId, repoId, path, mainBranch } })`;
    4. return `{ result }` (200), or `{ error }` with 502 for a daemon error and 503 for daemon offline or timeout.

    Every call, success or failure after check 1, inserts a `plugin_calls` row.
  - UI routes: `GET /api/plugins` (the registry, plus `installed` status from daemon RPC `plugins.status`, which returns `{ code: { installed: boolean, detail: string } }`); `GET /api/workspaces/:id/plugins`; `PATCH /api/workspaces/:id/plugins/:pluginId`.
- `daemonSocket.buildTaskPrompt` / `task.assign` sends `pluginTools: await enabledPluginTools(db, task.workspaceId)`.

- [ ] **Step 1: Write the failing tests**
  - `local plugins default to enabled, also in a confidential workspace`.
  - `code functions are not offered when the workspace has no repo`.
  - `a disabled function is not offered and calling it is 403`.
  - `a call with another workspace's repo id is 400 and never reaches the daemon`.
  - `a call is forwarded with the resolved repo and recorded in plugin_calls`.
  - `daemon offline gives 503 with daemon 未连接` (Review Focus 2).
  - `task.assign carries the enabled plugin tools`.
- [ ] **Step 2: Run** `npx vitest run apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): room plugin endpoints and workspace plugin settings`.

---

### Task 6: Daemon `plugin.call` for the code functions

**Files:**
- Modify: `apps/cli/src/repos/handlers.ts`, `apps/cli/src/room/client.ts`
- Test: `apps/cli/test/repos/handlers.test.ts`, `apps/cli/test/room/client.test.ts`

**Interfaces — Produces:**
- RPC `plugin.call({ name, args, repo })` dispatches to:
  - `code__search` → `queryIndex(root, "query", [query])`;
  - `code__explain` → `queryIndex(root, "explain", [symbol])`;
  - `code__path` → `queryIndex(root, "path", [from, to])`;
  - `code__read` → `readFileAtRef(path, mainRef, …)`;
  - `code__changes` → `changedFiles(path, from, to ?? mainRef)`.

  Missing or ill-typed args reject with `<name> 参数无效：<field>`. If the snapshot does not exist yet, the graph functions build it first (call `repo.index`), so the first call after binding works. An unknown name rejects with `未知函数 <name>`.
- RPC `plugins.status()` → `{ code: { installed, detail } }`. `installed` comes from running `graphify --version`; `detail` is the version or the install hint.
- `RoomClient.listPluginTools(): Promise<RoomResult>` (GET `/room/plugins`) and `RoomClient.callPlugin(name: string, args: unknown): Promise<RoomResult>` (POST `/room/plugins/:name`).

- [ ] **Step 1: Write the failing tests**
  - `plugin.call code__read returns the committed text at the main ref`.
  - `plugin.call code__search builds a missing index first, then queries`.
  - `plugin.call rejects missing args with the field name`.
  - `plugins.status reports installed with the version, or the install hint`.
  - `RoomClient.callPlugin posts to /room/plugins/<name> with the run token`.
- [ ] **Step 2: Run** `npx vitest run apps/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): execute code plugin functions`.

---

### Task 7: Repo watcher — fetch every 5 minutes, track main, update the index

**Files:**
- Create: `apps/cli/src/repos/watcher.ts`
- Modify: `apps/cli/src/daemon/connection.ts`, `apps/cli/src/daemon/setup.ts`, `apps/hub/src/daemonSocket.ts`, `apps/hub/src/repos.ts`
- Test: `apps/cli/test/repos/watcher.test.ts`, `apps/hub/test/repos.test.ts`

**Interfaces — Produces:**
- The hub sends `repos.sync` RPC on `welcome` and whenever bindings change, with `{ repos: { workspaceId, repoId, path, mainBranch }[] }`. The daemon's `RepoWatcher` keeps that list.
- `class RepoWatcher { constructor(opts: { nemaHome: string; intervalMs?: number /* default 300_000 */; onMoved: (m: { repoId; mainRef; from: string | null; to: string }) => void; onFetch: (r: { repoId; ok: boolean; error?: string; at: string }) => void }); setRepos(list): void; tick(): Promise<void>; start(): void; stop(): void }`. For each repo, each `tick`:
  1. `fetchMain`;
  2. `onFetch`;
  3. `revParse(mainRef)`;
  4. when the sha differs from the last known one, `updateIndex` with `changedFiles(last, new)`, then `onMoved`.

  The first tick after start records the sha without calling `onMoved` when the hub-provided `lastMainSha` is null.
- The daemon forwards `onMoved` as the `repo.moved` message and `onFetch` as the `repo.fetched` message (both from Task 1).
- The hub stores `last_main_sha` on `repo.moved`, and `last_fetch_at` / `last_fetch_error` on `repo.fetched`. Plan B and Plan C subscribe to `repo.moved` in the hub, so emit an internal `events.emitGlobal({ type: "repo.moved", ... })` hook point. A no-op listener is fine for now.

- [ ] **Step 1: Write the failing tests**
  - `tick fetches, detects a new origin/main sha, updates the index with the changed files and reports moved`.
  - `tick with no change reports a fetch but not a move`.
  - `fetch failing offline keeps the last sha, reports the error, and code__read still works on the last known ref` (Review Focus 4).
  - `a repo without origin follows the local branch`.
  - Hub: `repo.moved updates last_main_sha; repo.fetched updates last_fetch_at and last_fetch_error`.
- [ ] **Step 2: Run** `npx vitest run apps/cli/test/repos apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.** Tests drive `tick()` directly; the timer is not exercised in tests.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: watch bound repos' main branch`.

---

### Task 8: Adapters and `nema mcp` declare the plugin functions

**Files:**
- Modify: `apps/cli/src/direct/tools.ts`, `apps/cli/src/direct/adapter.ts`, `apps/cli/src/claude/launch.ts`, `apps/cli/src/claude/events.ts`, `apps/cli/src/claude/adapter.ts`, `apps/cli/src/mcp/server.ts`, `apps/cli/src/doctor.ts`, `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md`
- Test: `apps/cli/test/direct/tools.test.ts`, `apps/cli/test/direct/adapter.test.ts`, `apps/cli/test/claude/*.test.ts`, `apps/cli/test/mcp/*.test.ts`, `apps/cli/test/doctor.test.ts`

**Interfaces — Produces:**
- `roomTools(pluginTools: PluginToolSpec[]): FunctionTool[]` replaces the constant `ROOM_TOOLS`: the 3 Room functions plus one non-strict function per plugin tool.
- `dispatchTool(name, argsJson, room, pluginTools)`. A name in `pluginTools` goes to `room.callPlugin(name, args)`. Any other name not among the 3 Room functions stays unknown (`known: false`), with the error text listing the allowed names.
- Claude:
  - `prepareClaudeLaunch` takes `pluginTools`. `--allowedTools` becomes the 3 Room tools plus `mcp__room__<name>` for each.
  - `roomToolsOk(tools, mcpServers, allowed: Set<string>)` checks init against that exact set.
  - The adapter rejects a later `tool_use` outside the set, as today.
- `nema mcp`: on start, call `room.listPluginTools()` and register each returned tool on the `room` server with its JSON Schema. If the SDK's `registerTool` only accepts zod shapes, use the low-level `Server` with `tools/list` and `tools/call` handlers for those tools. If listing fails, start with the 3 Room tools only and log to stderr.
- `nema doctor` adds `graphify 可用：<version>`, or for a missing binary the install hint. It is informational, never a failure.
- Runtime spec amendment, marked `2026-10-23 代码库修订`:
  - §4: `--allowedTools` = the 3 Room tools plus the task's plugin tools as `mcp__room__<name>`.
  - §5: the allowed set for the init proof and later tool events is that same list.
  - BYOK / §6.7: the function list is the 3 Room functions plus the task's plugin tools.

- [ ] **Step 1: Write the failing tests**
  - `roomTools declares the 3 room functions plus each plugin tool`.
  - `dispatchTool routes a listed plugin tool to callPlugin and treats an unlisted one as unknown`.
  - `direct adapter sends the plugin tools to the model` (fake Responses server: the request's `tools` names).
  - Claude: `--allowedTools includes mcp__room__code__read when given`; `init listing a plugin tool not in the task's list fails the run`; `init listing exactly the room tools plus the task's plugin tools passes`.
  - MCP: `nema mcp lists the plugin tools from GET /room/plugins and forwards calls to POST /room/plugins/<name>` (fake hub).
  - Doctor: `reports graphify version or the install hint without failing`.
- [ ] **Step 2: Run** `npx vitest run apps/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/cli`, `npm run typecheck -w apps/cli` and `npm run build -w apps/cli`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): declare workspace plugin functions to every runtime`.

---

### Task 9: Web — plugins page and the workspace "代码与插件" page

**Files:**
- Create: `apps/web/components/PluginsPage.tsx`, `apps/web/components/CodeAndPlugins.tsx`
- Modify: `apps/web/components/Sidebar.tsx`, `apps/web/components/WorkspaceSettings.tsx`, `apps/web/lib/hub.ts`, `apps/web/lib/types.ts`, `apps/web/lib/i18n.tsx`, routing as the app already does it
- Test: `apps/web/test/PluginsPage.test.tsx`, `apps/web/test/CodeAndPlugins.test.tsx`, `apps/web/test/i18n.test.tsx`

**Behaviour:**
- **Sidebar:** a bottom entry `plugins.nav` opens `PluginsPage`. For each plugin it shows the name, a data-flow tag (`plugins.local` / `plugins.external`; external uses the existing red token), the install status (`plugins.installed` + detail, or `plugins.notInstalled` + hint), and its function list (name + description).
- **Workspace settings:** a new section `code.title` (layout A from the spec):
  - **Repos:** a list of path (monospace), label, main branch and fetch status. The fetch status is `code.fetchedAt` + time, `code.fetchFailed` + error, or `code.noOrigin`. An add form takes path, label and an optional main branch, and shows the hub's error text inline. Each row has edit label / main branch and remove.
  - **Plugins:** a toggle per plugin, with the data-flow tag. `external` plugins show `plugins.externalNote` next to the toggle. Expanding a plugin shows a per-function toggle; read-only functions only.
  - **A fixed note** `code.modelEgress`.
- **i18n keys**, exact values:

| key | zh | ja | en |
|---|---|---|---|
| `plugins.nav` | 插件 | プラグイン | Plugins |
| `plugins.local` | 仅本机 | ローカルのみ | Local only |
| `plugins.external` | 会外发 | 外部送信あり | Sends data out |
| `plugins.installed` | 已安装 | インストール済み | Installed |
| `plugins.notInstalled` | 未安装 | 未インストール | Not installed |
| `plugins.externalNote` | 打开后，调用内容会发送到外部服务 | 有効にすると呼び出し内容が外部サービスに送信されます | When on, call contents are sent to an external service |
| `code.title` | 代码与插件 | コードとプラグイン | Code & plugins |
| `code.repos` | 绑定的仓库 | 連携リポジトリ | Linked repositories |
| `code.addRepo` | 添加仓库 | リポジトリを追加 | Add repository |
| `code.path` | 本地路径 | ローカルパス | Local path |
| `code.label` | 用途 | 用途 | Label |
| `code.mainBranch` | 主分支 | メインブランチ | Main branch |
| `code.fetchedAt` | 最后同步 | 最終同期 | Last fetched |
| `code.fetchFailed` | 同步失败 | 同期失敗 | Fetch failed |
| `code.noOrigin` | 没有 origin，使用本地分支 | origin がないためローカルブランチを使用 | No origin; using the local branch |
| `code.plugins` | 本 workspace 的插件 | この workspace のプラグイン | Plugins for this workspace |
| `code.modelEgress` | Agent 读到的代码片段会随请求发送给模型服务商（OpenAI / Anthropic）。 | Agent が読んだコード片はリクエストとともにモデル提供者（OpenAI / Anthropic）に送信されます。 | Code the Agent reads is sent to the model provider (OpenAI / Anthropic) with each request. |

- [ ] **Step 1: Write the failing tests**
  - `PluginsPage lists graphify as local only with its five functions and install status`.
  - `CodeAndPlugins adds a repo and shows the hub's 409 message inline`.
  - `CodeAndPlugins shows no origin and fetch failure states` (Review Focus 4).
  - `toggling a function sends PATCH with disabledFunctions`.
  - `the model egress note is always shown`.
  - `every new key exists in ja, en and zh`.
- [ ] **Step 2: Run** `npx vitest run apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/web` and `npm run build -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): plugins page and workspace code settings`.

---

### Task 10: End-to-end check and README

**Files:**
- Create: `apps/hub/test/codebase.e2e.test.ts` (or extend the existing server test harness)
- Modify: `README.md`

- [ ] **Step 1: Write an end-to-end test.** Real hub on PGlite, real daemon connection and RPC router, a temp repo with a local bare `origin`, fake graphify. It runs this sequence:
  1. bind the repo;
  2. let the index build;
  3. call `POST /room/plugins/code__read` and `code__search` with a run token;
  4. push a commit to origin and run one watcher `tick`;
  5. assert `last_main_sha` moved and `code__read` returns the new text;
  6. finally assert the bound repo's `git status --porcelain` and file list are identical to the start (Review Focus 5).
- [ ] **Step 2: Run it.** Expected: PASS.
- [ ] **Step 3: Add a README section "Code repositories and plugins".** It covers:
  - installing graphify (`uv tool install graphifyy`);
  - binding a repo in workspace settings;
  - that Nema reads `origin/<main>` and runs `git fetch` every 5 minutes without touching your working tree;
  - that graphify works on a private snapshot under `~/.nema/ws/<id>/graphify/`;
  - which plugin functions the Agent gets;
  - the model-egress note.
- [ ] **Step 4: Run** `npx vitest run`, `npx tsc -b`, `npm run typecheck -w apps/cli`, `npm run build -w apps/cli` and `npm run build -w apps/web`. Expected: all PASS.
- [ ] **Step 5: Commit** `docs: code repositories and plugins in README`.
