# Plan B: Review Fixes and archify Diagrams

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open minor findings from the 2026-10-23 review of the codebase foundation and review-decisions work. Then add architecture diagrams: drawn when a repo is bound, stored as archify JSON in the knowledge repo, rendered by the hub, opened in their own window, flagged when the code moves, and updated on request.

**Architecture:**
- Tasks 1–2 are independent fixes in the existing code.
- Diagrams are a new entry kind, `diagram` (prefix `G`). The archify JSON is stored next to the entry file, so it versions with the rest of the knowledge.
- A new hub-side plugin, `diagram`, gives the Agent `diagram__save` and `diagram__read`. The hub validates and renders with a vendored archify, so these calls never reach the daemon.
- Work the system starts itself (draw on bind, update on request) goes through a new `postSystemTask`. Plan C reuses it.

**Tech Stack:** TypeScript monorepo, zod v4, Hono, PostgreSQL/PGlite, git CLI, vendored archify (Node, MIT), Next.js + React, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md`, decision 4 (diagrams) and decision 8 (system-started tasks). Tasks 1–2 come from the review reports in this session; each line there names the defect it closes.

## Global Constraints

- Work on `main`. Don't push. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests never run a real model, real graphify or a network call.
- Diagram JSON is the source of truth and lives in git. HTML is rendered on demand and never committed.
- Only `architecture` is drawn automatically, once per newly bound repo. Every other type is drawn only when the user asks in chat.
- Redrawing never happens automatically. "Update" is a user action: a button, or asking in chat.
- Rendered HTML is served with `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-ancestors 'none'`. Check archify's actual output in Task 3 and relax only the directive it really needs. Note any change in the commit message.
- Hub user-facing text is Chinese. Web copy exists in ja / en / zh.

## Review Focus

1. **Archify rejects the Agent's JSON**: the diagnostics go back to the Agent as the function result, so it can fix and retry. Nothing is written to git. Pinned in Task 4.
2. **A main-branch move that touches no diagram paths** leaves every diagram unflagged. A move touching one node's path flags only that repo's diagrams that cover it. Pinned in Task 6.
3. **The diagram HTML endpoint** cannot be reached from another workspace's id, and always sends the CSP header. Pinned in Task 5.
4. **Binding a second repo** queues exactly one new architecture task, for that repo. Re-binding after an unbind queues a new one. Pinned in Task 5.
5. **A legacy knowledge repo without a `diagrams/` directory** still lists, reads and recovers after upgrade. Pinned in Task 4.

---

### Task 1: Foundation fixes

**Files:**
- Modify: `apps/cli/src/repos/git.ts`, `apps/cli/src/repos/graphify.ts`, `apps/cli/src/repos/handlers.ts`, `apps/cli/src/repos/watcher.ts`, `apps/cli/src/daemon/setup.ts`, `packages/shared/src/workspace.ts`, `apps/hub/src/repos.ts`
- Create: `apps/hub/src/db/migrations/006_repo_label_unique.sql`
- Test: the matching files under `apps/cli/test/repos/`, `packages/shared/test/`, `apps/hub/test/repos.test.ts`

Each item closes one review finding:

- **M-1 `code__changes` reaches beyond main.** `changedFiles` accepts `from`/`to` only when the value is the bound main ref (`mainRef(path, mainBranch)`, not `origin/HEAD`), or a 7–40 hex sha for which `git merge-base --is-ancestor <sha> <mainRef>` succeeds. Otherwise reject with `提交 <x> 不在主分支上`.
- **M-3 Branch names are checked too loosely.**
  - `isBranchName` follows `git check-ref-format --branch` rules. It rejects `HEAD`; a leading `-`; any of `~ ^ : ? * [ \` or a space; `..`; `@{`; a trailing `/` or `.lock`; and an empty segment.
  - The hub also validates the `defaultBranch` that `repo.inspect` returns, and stores `main` instead when it fails.
- **M-6 Labels.** Labels must be unique per workspace: add a unique index on `(workspace_id, label)`, and a duplicate returns 409 `本 workspace 已有用途为 <label> 的仓库`. Labels are 1–40 characters with no control characters; anything else is 400 `用途说明需为 1–40 个字符`.
- **graphify update without `--code-only`.** Pass `--code-only` to `graphify update` as well, after checking the flag is accepted with `graphify update --help` if graphify is installed. If it is not accepted, say so in the commit message and leave the call unchanged.
- **M-2 Environment overrides.** Remove the `NEMA_GRAPHIFY_BIN` and `NEMA_GRAPHIFY_TIMEOUT_MS` environment overrides. Instead, `registerRepoHandlers` and `RepoWatcher` take an optional `graphify?: { bin?: string; timeoutMs?: number }`. Production passes nothing; tests pass a fake binary.
- **M-4 Unbind races a running tick.** After `syncIndex`, `tickRepo` checks the repo is still in `this.repos` before reporting or touching the snapshot. If it was removed, it deletes the snapshot under `withIndexLock`.
- **M-5 Unscoped `repo.moved`.** A `repo.moved` or `repo.fetched` for a `repoId` that no longer exists is ignored: no update, no broadcast.
- **M-7 Repos that contain `~/.nema`.** `inspectRepo` also rejects a repo whose root contains `nemaHome`, with `不能绑定包含 ~/.nema 的目录`.

- [ ] **Step 1: Write the failing tests**, one per item:
  - `code__changes rejects a sha that is not on main, including an unpushed local commit`.
  - `isBranchName rejects HEAD, main~3, x^, a b, a..b, -x, x.lock, x/ and accepts feature/a-b`.
  - `binding a second repo with the same label is 409`.
  - `graphify update is called with --code-only`.
  - `handlers use the injected graphify binary and ignore NEMA_GRAPHIFY_BIN`.
  - `a repo removed during a tick is not reported and its snapshot is gone`.
  - `repo.moved for an unknown repo is ignored without a broadcast`.
  - `inspectRepo rejects a repo whose root contains nemaHome`.
- [ ] **Step 2: Run** `npx vitest run apps/cli packages/shared apps/hub`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `fix: tighten repo refs, branch names and labels; inject graphify`.

---

### Task 2: Knowledge fixes

**Files:**
- Modify: `packages/knowledge/src/store.ts`, `apps/web/lib/types.ts`, `apps/cli/src/direct/tools.ts`, `apps/cli/src/mcp/server.ts`
- Test: `packages/knowledge/test/store.test.ts`, `apps/cli/test/direct/tools.test.ts`, `apps/cli/test/mcp/*.test.ts`

Each item closes one review finding:

- **#6 Recovered files whose name doesn't match their id.** `recoverUncommitted` skips a file whose frontmatter `id` differs from its file name, or whose `kind` differs from its directory, and adds it to `skipped`.
- **#9 Web history type.** `HistoryItem.op` in `apps/web/lib/types.ts` becomes `"add" | "update" | "recover"`.
- **#10 `basis` looks optional to the model.** The tool schema the Agent sees for `upsert_entry` marks `basis` as required. `UpsertEntryInput` itself stays optional, because UI edits set it on the hub. Add `"basis"` to the derived schema's `required` in `upsertParameters()`, and to the MCP `upsert_entry` input schema.

- [ ] **Step 1: Write the failing tests**:
  - `recoverUncommitted skips decisions/D-3.md whose frontmatter id is D-4`.
  - `upsert_entry parameters list basis as required` (direct tools and MCP).
- [ ] **Step 2: Run** `npx vitest run packages/knowledge apps/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `fix: skip mismatched recover files; basis required for the Agent`.

---

### Task 3: Vendor archify and render on the hub

**Files:**
- Create: `vendor/archify/` (source + `LICENSE` + `VENDORED.md`), `apps/hub/src/archify.ts`
- Modify: `Dockerfile` (copy `vendor/`), root `package.json` (if archify needs `ajv` at runtime)
- Test: `apps/hub/test/archify.test.ts`

**Verify first:**
- Take archify from `https://github.com/tt-a1i/archify` at the latest release tag, as a git clone. If the network is unavailable, take the local copy at `~/.claude/skills/archify` (v3.2.0, MIT) and record that it came from there.
- Find out whether `validate` and HTML rendering need a browser (Playwright / Chromium). If they do, stop and report: the hub image must not carry a browser.
- Run `node vendor/archify/bin/archify.mjs validate architecture vendor/archify/examples/<an architecture example>.json --quality showcase --json` and note the receipt shape.

**Interfaces — Produces:**
- `VENDORED.md` records the upstream URL, tag, commit, date and the license line. Copy only the runtime files (`bin/`, `renderers/`, `schemas/`, `assets/`, `locales/`, `brand-marks/` if needed); no tests or docs.
- `validateDiagram(type: DiagramType, spec: unknown): Promise<{ ok: true } | { ok: false; diagnostics: string }>`. It writes the spec to a temp file and runs `validate <type> <file> --quality showcase --json` with a 30 s timeout. `diagnostics` is the receipt's error list, capped at 8 KB.
- `renderDiagram(type: DiagramType, spec: unknown): Promise<string>`. It runs the archify command that writes HTML to a temp path (`deliver`, or `render` if that exists) and returns the HTML.
- `DIAGRAM_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const`, plus any further types the vendored version supports that need no extra runtime. `type DiagramType`.

- [ ] **Step 1: Write the failing tests**:
  - `validateDiagram accepts a vendored architecture example`.
  - `validateDiagram returns diagnostics for a node with no id`.
  - `renderDiagram returns a self-contained HTML document with no external script src`: no `<script src="http`, no `<link href="http`.
- [ ] **Step 2: Run** `npx vitest run apps/hub/test/archify.test.ts`. Expected: FAIL.
- [ ] **Step 3: Vendor and implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `docker compose build hub` if Docker is available, and check the image starts. Skip with a note if Docker is not running.
- [ ] **Step 5: Commit** `feat(hub): vendor archify for diagram validation and rendering`.

---

### Task 4: `diagram` entries and the hub-side `diagram` plugin

**Files:**
- Modify: `packages/shared/src/entry.ts`, `packages/shared/src/plugins.ts`, `packages/knowledge/src/store.ts`, `apps/hub/src/roomApi.ts`, `apps/hub/src/plugins.ts`
- Create: `apps/hub/src/diagrams.ts`
- Test: `packages/shared/test/entry.test.ts`, `packages/knowledge/test/store.test.ts`, `apps/hub/test/diagrams.test.ts`

**Interfaces — Produces:**
- **Entry kind.** `ENTRY_KINDS` gains `"diagram"`, with `KIND_DIR.diagram = "diagrams"`, `KIND_PREFIX.diagram = "G"` and `KIND_STATUSES.diagram = ["active", "superseded"]`.
- **Diagram frontmatter.** `EntryFrontmatter` gains `diagram?: { repoId: string; type: DiagramType; sourceCommits: Record<string, string>; nodePaths: Record<string, string[]> }`. It is required for kind `diagram` and forbidden for every other kind, in the same `refineKind` style as `url`. On disk the keys are `repo_id`, `type`, `source_commits` and `node_paths`, under a `diagram:` mapping.
- **Store.**
  - `KnowledgeStore.writeDiagram(input: { id?: string; title: string; body: string; diagram: DiagramMeta; spec: unknown; reason: string; sourceMessages: string[] }, meta: CommitMeta): Promise<{ entry: Entry; commit: string; op }>`. It writes `diagrams/G-n.md` and `diagrams/G-n.json` (2-space JSON) in one commit.
  - `KnowledgeStore.readDiagramSpec(id): Promise<unknown | null>`.
  - `recoverUncommitted` treats a `.json` next to a recovered `.md` as part of the same entry.
- **Plugin manifest.** `PluginManifest` gains `runsOn: "hub" | "daemon"`, and `code` is `"daemon"`. A new manifest `{ id: "diagram", displayName: "archify", dataFlow: "local", runsOn: "hub" }` has two functions:
  - `diagram__save(repo: string, type: DiagramType, title: string, summary: string, spec: object, nodePaths: Record<string,string[]>, id?: string)`;
  - `diagram__read(id: string)`.

  Both are `readOnly: true`, because they write only into this workspace's knowledge, like `upsert_entry`.
- **`diagrams.ts` and the Room route.** `POST /room/plugins/:name` handles a `runsOn: "hub"` function itself instead of calling the daemon.
  - `diagram__save`:
    - resolves `repo` with `findRepoForWorkspace` (400 when unknown);
    - runs `validateDiagram`. On failure the HTTP status is 200 with `{ result: { ok: false, diagnostics } }`, so the Agent sees the diagnostics as an ordinary result and can retry;
    - sets `sourceCommits = { [repoId]: repo.lastMainSha }`;
    - sets `sourceMessages = [the task's messageId]`;
    - sets the `reason` text to `画图：<title>`;
    - calls `writeDiagram`, indexes the entry and emits `knowledge.changed`;
    - returns `{ ok: true, id }`.
  - `diagram__read` returns `{ entry, spec }`, or 404 for an id that is not a diagram in this workspace.
  - `plugin_calls` rows are recorded for both, as for daemon plugins.

- [ ] **Step 1: Write the failing tests**:
  - `diagram frontmatter round-trips and is rejected on other kinds`.
  - `writeDiagram commits the md and json together; readDiagramSpec returns the json`.
  - `a knowledge repo without diagrams/ still lists and recovers` (Review Focus 5).
  - `diagram__save with invalid spec returns ok:false diagnostics and writes nothing` (Review Focus 1).
  - `diagram__save with a valid spec creates G-1 with sourceCommits from lastMainSha and the task message as source`.
  - `diagram__save with id updates G-1 in place`.
  - `diagram__save for another workspace's repo is 400`.
  - `diagram functions are offered when the workspace has a repo, and never sent to the daemon`.
- [ ] **Step 2: Run** `npx vitest run packages apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use a fake `validateDiagram` / `renderDiagram` injected through hub deps in unit tests, and the real one only in `archify.test.ts`.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc -b`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: diagram entries and the archify plugin`.

---

### Task 5: System-started tasks, draw on bind, update on request, HTML endpoint

**Files:**
- Modify: `apps/hub/src/messages.ts`, `apps/hub/src/repos.ts`, `apps/hub/src/uiApi.ts`, `apps/hub/src/prompt.ts`, `apps/hub/src/daemonSocket.ts`
- Test: `apps/hub/test/messages.test.ts` (create if missing), `apps/hub/test/repos.test.ts`, `apps/hub/test/uiApi.test.ts`, `apps/hub/test/prompt.test.ts`

**Interfaces — Produces:**
- **`postSystemTask(db, workspaceId, content: string): Promise<{ message: Message; task: Task }>`**. It inserts a `system` message and a queued task for it in one transaction. It refuses an archived workspace with the same error as user messages. Plan C reuses this function.
- **Prompt.** When the task's message has role `system`, `buildPrompt` titles the last section `# 本次系统请求` instead of `# 本次用户消息`, and adds the rule `这是系统发起的请求，不是用户说的话：不要把它当作用户的陈述或决定（basis 不能是 stated / decided）。`.
- **Draw on bind.** After a successful bind, `bindRepo` calls `postSystemTask(db, ws, "为仓库 <label>（<repoId>）画架构图：用 code__ 函数读代码，用 diagram__save 保存，type 为 architecture。")` and emits `message.created` and `task.updated`.
- **Update route.** `POST /api/workspaces/:id/diagrams/:gid/update` with `{}`. It runs `postSystemTask(db, ws, "用户要求更新代码图 <gid>：用 diagram__read 读旧图，用 code__changes 看自 <sourceCommit> 以来的改动，只改受影响的节点和连线，再用 diagram__save（带 id）保存。")`. Unknown gid → 404.
- **HTML route.** `GET /api/workspaces/:id/diagrams/:gid.html` renders the stored spec with `renderDiagram`. It caches by `(gid, commit of the json)` in memory, and sends the CSP header from Global Constraints plus `X-Content-Type-Options: nosniff`. A gid that is not a diagram in that workspace → 404.

- [ ] **Step 1: Write the failing tests**:
  - `postSystemTask creates a system message and a queued task`.
  - `the prompt for a system task says 本次系统请求 and forbids stated/decided`.
  - `binding a repo queues one architecture task naming that repo` (Review Focus 4). A second repo queues a second one; an unbind followed by a re-bind queues a new one.
  - `the update route queues a system task naming the diagram and its source commit`.
  - `diagram html is served with the CSP and nosniff headers` (Review Focus 3).
  - `diagram html for another workspace's gid is 404` (Review Focus 3).
- [ ] **Step 2: Run** `npx vitest run apps/hub`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/hub`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(hub): draw on bind, update on request, serve diagram html`.

---

### Task 6: Mark diagrams stale when main moves

**Files:**
- Create: `apps/hub/src/db/migrations/007_diagram_status.sql`
- Modify: `apps/hub/src/diagrams.ts`, `apps/hub/src/repos.ts` (the `repo.moved` hook point from the foundation), `apps/cli/src/repos/handlers.ts`
- Test: `apps/hub/test/diagrams.test.ts`, `apps/cli/test/repos/handlers.test.ts`

**Interfaces — Produces:**
- **Table** `diagram_status(workspace_id text, entry_id text, stale boolean not null default false, checked_sha text, primary key (workspace_id, entry_id))`. It is derived state and never goes into git.
- **Daemon RPC** `repo.changes({ repo, from, to })` returns `changedFiles(...)`, using the Task 1 rules.
- **`onRepoMoved(db, daemon, events, move)`.** For each active diagram whose `diagram.repoId === move.repoId`:
  1. call `repo.changes(sourceCommit, move.to)`;
  2. the diagram is stale when any changed path equals, or is under, any path in `nodePaths`;
  3. upsert `diagram_status`;
  4. emit `knowledge.changed` when the stale flag changes.

  A daemon error leaves the status unchanged and is logged.
- **Clearing.** `diagram__save` resets `stale = false` and `checked_sha = the new source commit`.
- **Summary field.** `EntrySummary` for diagrams carries `stale: boolean`, read from `diagram_status` through the hub's list and timeline routes.

- [ ] **Step 1: Write the failing tests**:
  - `a move touching a node path marks only that repo's covering diagrams stale` (Review Focus 2).
  - `a move touching no node path marks nothing`.
  - `saving the diagram again clears stale`.
  - `a daemon error leaves stale unchanged`.
- [ ] **Step 2: Run** `npx vitest run apps/hub apps/cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat: flag diagrams whose code moved`.

---

### Task 7: Web — the 「代码图」 group, opening in a window, the update button

**Files:**
- Modify: `apps/web/components/KnowledgePanel.tsx`, `apps/web/components/EntryDetail.tsx`, `apps/web/lib/hub.ts`, `apps/web/lib/types.ts`, `apps/web/lib/i18n.tsx`
- Test: `apps/web/test/KnowledgePanel.test.tsx`, `apps/web/test/EntryDetail.test.tsx`, `apps/web/test/i18n.test.tsx`

**Behaviour:**
- **List.** A new group `know.diagrams`, placed after 取舍记录 and before 外部来源. Inside it, diagrams are grouped by repo label: one small label line per repo, then its diagrams. Each row shows the id, title, `diagram.type` and, when stale, the existing 可能过时 tag (`know.stale`). Clicking the title opens the hub's `.html` route in a new window (`window.open(url, "_blank", "noopener")`).
- **Detail.** Shows the type, repo, source commit (7-character sha), node count and a button `diagram.update`. The button calls the update route, then shows `diagram.updateQueued`.
- **i18n**, exact values:

| key | zh | ja | en |
|---|---|---|---|
| `know.diagrams` | 代码图 | コード図 | Code diagrams |
| `diagram.open` | 在新窗口打开 | 新しいウィンドウで開く | Open in new window |
| `diagram.update` | 更新 | 更新 | Update |
| `diagram.updateQueued` | 已排队更新 | 更新をキューに追加しました | Update queued |
| `diagram.sourceCommit` | 画图时的提交 | 作図時のコミット | Drawn from commit |

- [ ] **Step 1: Write the failing tests**:
  - `diagrams are grouped by repo label and open the html route in a new window`.
  - `a stale diagram shows 可能过时`.
  - `the update button posts and shows 已排队更新`.
  - `every new key exists in ja, en and zh`.
- [ ] **Step 2: Run** `npx vitest run apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run apps/web` and `npm run build -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): code diagrams group and update button`.

---

### Task 8: Verification and README

- [ ] **Step 1:** Add a README section "Code diagrams". It covers:
  - the architecture diagram drawn on bind;
  - asking for other types in chat;
  - JSON in git with HTML rendered on demand;
  - the 可能过时 flag;
  - the update button;
  - the vendored archify version and how to upgrade it (replace `vendor/archify/`, update `VENDORED.md`; stored diagrams re-render).
- [ ] **Step 2:** Run `npx vitest run` three times, plus `npx tsc -b`, `npm run typecheck -w apps/cli`, `npm run build -w apps/cli` and `npm run build -w apps/web`. Expected: all PASS every time.
- [ ] **Step 3: Commit** `docs: code diagrams in README`.
