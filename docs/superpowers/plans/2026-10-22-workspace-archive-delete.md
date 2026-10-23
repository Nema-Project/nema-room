# Workspace 归档与删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左栏 workspace 行的右键菜单可以归档或永久删除，删除是红色并先弹窗。

**Architecture:** `workspaces.archived_at` 表示归档。删除在一个事务里先拒绝排队或运行中的任务，再删掉该 workspace 的聊天、任务、索引和行，然后删除知识仓库和 `~/.nema/ws/<id>`，并且不跟随符号链接。界面的菜单和确认框都在 `Sidebar` 里，`WorkspaceShell` 只负责调用 API 和在当前房间消失时切走。

**Tech Stack:** 现有 Hono、PostgreSQL migration、Next.js、Vitest。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-22-workspace-archive-delete-design.md`

## Global Constraints

- 删除永久去掉该 workspace 的聊天和项目知识，不能恢复。
- 菜单和弹窗里的「删除」用 `--accent`（`#e3241b`）。这是主 spec 4.6「红色只用于需要你处理」的唯一例外。
- 文案用 spec 表里的 ja / en / zh，key 不改。
- id 只有匹配 `^ws_[A-Za-z0-9_-]{1,32}$` 才能拼进路径。
- `fs.rm` 不跟随符号链接。
- 不新增依赖，不改 daemon 协议，不改 README。

## Review Focus

- 删除含有 `task_changes` 的已完成任务时，外键顺序错会 500 且行还在。Task 1 的删除测试先写入一条已完成任务和 `task_changes`。
- `codex-home/auth.json` 是指向用户凭证的符号链接，递归删除若跟随链接会毁掉登录。Task 1 断言链接目标文件仍在。
- 右键不该选中 workspace，取消不该调用删除。Task 2 断言这两点。

---

### Task 1: hub 归档与删除

**Files:**
- Create: `apps/hub/src/db/migrations/003_workspace_archived.sql`
- Modify: `apps/hub/src/workspaces.ts`
- Modify: `apps/hub/src/uiApi.ts`（`HttpError` 的 status 加上 `409`；`PatchWorkspaceBody` 加 `archived`；`DELETE /workspaces/:id`）
- Test: `apps/hub/test/workspaces.test.ts`、`apps/hub/test/uiApi.test.ts`

**Interfaces:**
- Consumes: `createWorkspace`、`postUserMessage`、`claimNextTask`、`finishTask`、`recordTaskChange`、`repoPath`
- Produces:
  - `Workspace` 增加 `archivedAt: string | null`
  - `updateWorkspace(db, id, patch)` 的 patch 增加 `archived?: boolean`。`true` 写 `archived_at = now()`，`false` 写 `null`
  - `deleteWorkspace(db, dataDir, id, nemaHome: string): Promise<void>`
  - 错误文案：`invalid workspace id`、`workspace is busy`、`workspace not found: <id>`
  - `GET /workspaces` 每项多 `archived: boolean`
  - `DELETE /workspaces/:id` → 204 / 400 / 404 / 409 `{ error }`

- [ ] **Step 1: 写失败测试**

`workspaces.test.ts`：

- `archive then unarchive`：`updateWorkspace(..., { archived: true })` 后 `archivedAt` 非空，`listWorkspaces` 仍包含它；再 `{ archived: false }` 后 `archivedAt` 为 `null`。
- `delete removes rows, repo, isolation dir, and does not follow symlinks`：建 workspace，在仓库里放一个指向仓库外文件的符号链接；在 `nemaHome/ws/<id>/codex-home/auth.json` 再放一个指向仓库外另一个文件的符号链接。`deleteWorkspace` 之后：workspace 行没有了，`repos/<id>` 没有了，`nemaHome/ws/<id>` 没有了，两个目标文件都还在。
- `delete rejects a bad id without touching the filesystem`：id 为 `ws_../x` 时抛 `invalid workspace id`。
- `delete and archive refuse a queued or running task`：`postUserMessage` 之后（任务为 queued）`deleteWorkspace` 与 `updateWorkspace(..., { archived: true })` 都抛 `workspace is busy`，行和仓库还在。先归档、再排队、然后 `{ archived: false }` 成功。`finishTask` 之后删除成功。

`uiApi.test.ts`：`DELETE` 不存在的 id 为 404；非法 id 为 400；queued 时 `PATCH { archived: true }` 与 `DELETE` 都是 409 且 `error === "workspace is busy"`；成功删除为 204；`GET /workspaces` 对已归档项给出 `archived: true`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/workspaces.test.ts apps/hub/test/uiApi.test.ts`
Expected: FAIL，`deleteWorkspace` 或 `archived` 不存在。

- [ ] **Step 3: 实现**

`003_workspace_archived.sql` 只有一句：`alter table workspaces add column archived_at timestamptz;`

`deleteWorkspace` 先校验 id。事务内 `select ... for update` 锁住该行；没有行则 not found；存在 `status in ('queued','running')` 的任务则 busy。然后按序删除 `task_changes`、`tasks`、`messages`、`entry_index`、`workspaces`。事务提交后再 `fs.rm(repo, { recursive: true, force: true })` 和 `fs.rm(path.join(nemaHome, "ws", id), { recursive: true, force: true })`。

路由把这三句错误映射为 400 / 409 / 404。`nemaHome` 用 `path.join(os.homedir(), ".nema")`。`GET` 用 `archivedAt != null` 填 `archived`。

- [ ] **Step 4: 再跑 Step 2 的命令**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/db/migrations/003_workspace_archived.sql apps/hub/src/workspaces.ts apps/hub/src/uiApi.ts apps/hub/test/workspaces.test.ts apps/hub/test/uiApi.test.ts
git commit -m "feat(hub): archive and delete workspaces"
```

---

### Task 2: 左栏右键菜单与删除确认

**Files:**
- Modify: `apps/web/lib/types.ts`（`Workspace` 加 `archived: boolean`）
- Modify: `apps/web/lib/hub.ts`（`archiveWorkspace(id, archived)`、`deleteWorkspace(id)`）
- Modify: `apps/web/components/Sidebar.tsx`、`apps/web/components/WorkspaceShell.tsx`、`apps/web/app/globals.css`
- Modify: `apps/web/messages/{en,ja,zh}.json`、`CHANGELOG.md`
- Test: `apps/web/test/Sidebar.test.tsx`、`apps/web/test/WorkspaceShell.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `archived`、`PATCH { archived }`、`DELETE` 204、409 `workspace is busy`
- Produces: `Sidebar` 新增 `onArchive(id: string, archived: boolean): Promise<void>` 与 `onDelete(id: string): Promise<void>`

- [ ] **Step 1: 写失败测试**

在 `Sidebar.test.tsx`，列表里加一个 `archived: true` 的 Delta。默认断言 Delta 不在主列表，按钮名称为 `Archived 1`。

- 右键 Alpha：`fireEvent.contextMenu`，`defaultPrevented` 为 true，出现 `role="menu"`。`onSelect` 未被调用。菜单里的 Delete 计算样式颜色为 `rgb(227, 36, 27)`。
- 点 Delete 出现 `role="dialog"`，文案含 Alpha，焦点在 Cancel。点 Cancel 后面板关闭，`onDelete` 未被调用。再打开并点对话框里的 Delete，`onDelete` 被调用且参数为 `w1`。
- 点 Archive 不出现 dialog，`onArchive("w1", true)`。
- 展开 Archived，右键 Delta，点 Unarchive，`onArchive` 被调用且第二个参数为 `false`。
- Escape 关闭菜单，不调用删除。

`WorkspaceShell.test.tsx`：现有 fixture 补上 `archived: false`。`routeId` 指向一个 `archived: true` 的 workspace、列表里还有一个未归档的时，`replace` 被调用为 `/w/<未归档 id>`，房间标题不是已归档的名字。hub mock 补上 `archiveWorkspace` 与 `deleteWorkspace`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/web/test/Sidebar.test.tsx apps/web/test/WorkspaceShell.test.tsx`

Expected: FAIL，没有菜单，或已归档房间仍被打开。

- [ ] **Step 3: 实现**

菜单和对话框留在 `Sidebar.tsx`。`contextmenu` 调用 `preventDefault`，菜单 `position: fixed`，用 `clientX/clientY`，超出视口就往回翻。点外面或 Escape 关闭。归档直接 `onArchive`。删除只打开对话框；只有红色确认按钮调用 `onDelete`。

`WorkspaceShell`：当前房间只从未归档列表里挑。`routeId` 指向已归档或不存在的 id 时，`replace` 到下一个未归档 workspace；一个都没有就 `replace("/")`。409 时在侧栏已有的 `role="alert"` 上显示 `sidebar.busy`，不把 workspace 清掉。

文案按 spec 表补进三个 `messages` 文件。`CHANGELOG.md` 的 `[Unreleased]` / `Added` 加一句：左栏 workspace 可以右键归档，或经红色确认后永久删除。

样式沿用纸白、1px `--rule` 边、无圆角无阴影。`.ws.archived` 用 `--side-ink-2`。

- [ ] **Step 4: 再跑 Step 2 的命令，再跑 `npx vitest run`**

Expected: Sidebar 测试 PASS，全套 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/types.ts apps/web/lib/hub.ts apps/web/components/Sidebar.tsx apps/web/components/WorkspaceShell.tsx apps/web/app/globals.css apps/web/messages apps/web/test/Sidebar.test.tsx apps/web/test/WorkspaceShell.test.tsx CHANGELOG.md
git commit -m "feat(web): workspace archive and delete menu"
```
