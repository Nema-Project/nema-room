# 只读分享知识库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给一个 workspace 的知识库签发可撤销的只读链接，访客只在 web origin 上阅读公开投影。

**Architecture:** 主人走现有 `/api`（`hostGuard` + 可选 `uiAuth`）。访客打开 `/s/<token>`，Next 服务端用 `node:http` 请求 hub 的 `/share/<token>`，并把 `Host` 设为 `127.0.0.1:<port>`。`hostGuard` 不放宽。token 只以 sha256 入库。

**Tech Stack:** Hono、PostgreSQL/PGlite 迁移、Next.js App Router、现有桌面网关、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-04-readonly-knowledge-share-design.md`

## Global Constraints

- 对照 spec 的 D-1 到 D-10，实现不得改这些选择。
- `hostGuard` 的允许名单仍然只有 `127.0.0.1:<port>` 与 `localhost:<port>`。`/share` 也走它。不把局域网地址加进去。
- 一条链接分享整个知识库（D-1，用户已确认 2026-11-11）。不做部分条目分享。
- 分享页只允许 D-4 的内网来源（用户已确认 2026-11-11）。不支持公网、隧道、反向代理。来源是 TCP 对端，不是 `X-Forwarded-For`。这些转发头出现就拒绝，并且不向 hub 发请求。hub 的宿主机端口保持 `127.0.0.1`。
- 分享 token 不是 `/api`、`/room`、`/report` 的凭据。公开页不 import `@/lib/hub`，HTML 不含 `window.__NEMA_HUB_URL__`。
- 明文 token 只出现在创建响应。不进日志、错误正文、快照。
- `knowledge_shares` 不加入 `TABLE_COLUMNS` / `OPTIONAL_TABLES`。
- 保密工作区不能新建分享；打开保密或归档会在同一事务撤销未撤销的行。取消保密或取消归档不恢复这些行。创建和这次更新都先 `select ... from workspaces where id = $1 for update`，插入或撤销发生在持有该锁的同一事务里。
- `resolveShare` 区分「没有这个哈希」和「哈希在但不可用」。两种对外都是同一种 404。已知哈希（含不可用）走自己的限流桶；未命中走共用桶。
- 公开 404 正文在「无此哈希 / 已撤销 / 已过期 / 保密 / 归档 / 总开关关闭」时相同：`{ "error": "not found" }`，并带 `Cache-Control: no-store`。
- UI 文案同时改 `apps/web/messages/{en,zh,ja}.json`。`README.md` 与 `README.en.md` 逐字节相同。
- 用户可见变化写 `changelog.d/readonly-knowledge-share.added.md`（一条 `- ` 开头的中文 bullet，无标题）。不直接改 `CHANGELOG.md`。
- 代码、注释、提交说明用英文。
- 不新增依赖。限流是进程内 Map。

## File Structure

| 文件 | 职责 |
| --- | --- |
| `apps/hub/src/db/migrations/019_knowledge_shares.sql` | 表与 workspace 索引 |
| `apps/hub/src/shares.ts` | 创建、列表、撤销、按哈希查找、公开投影、限流 |
| `apps/hub/src/shareRoutes.ts` | `GET /share/:token` 与单条；拒绝其他方法 |
| `apps/hub/src/shareAdmin.ts` | 主人的列表、创建、撤销 |
| `apps/hub/src/app.ts` | 挂上 `/share` 的 hostGuard 与两条路由；`sharesEnabled` 依赖 |
| `apps/hub/src/uiApi.ts` | 保密/归档与撤销放进同一事务 |
| `apps/hub/src/lifecycle.ts`、`apps/hub/src/main.ts`、`apps/local/src/runtime.ts` | 总开关进入 `StartHubOptions`。`main.ts` 与 core 内的 `runtime.ts` 都读取。桌面 launcher 的 `childEnvironment` 把 `NEMA_SHARES_ENABLED` 原样复制进 core，包括 `0` |
| `apps/hub/test/shares.test.ts` | 存储、投影、路由、泄露、Host、撤销 |
| `apps/local/test/migration.test.ts` | 快照拒绝 `knowledge_shares` |
| `apps/web/lib/shareHub.ts` | 服务端内部请求；校验 URL；不转发访客头 |
| `apps/web/lib/sharePeer.ts` | 内网来源判断。不读转发头 |
| `apps/web/app/(room)/layout.tsx` | 从根 layout 移来的私有壳 |
| `apps/web/app/(room)/page.tsx` 与 `(room)/w/**` | 现有页面，URL 不变 |
| `apps/web/app/s/layout.tsx`、`s/[token]/page.tsx`、`s/[token]/e/[eid]/page.tsx` | 公开页 |
| `apps/web/components/ShareKnowledge.tsx` | 设置里的创建、复制、撤销 |
| `apps/web/components/ShareView.tsx` | 只读列表与正文 |
| `apps/local/src/gateway.ts` | `/s/...` 无会话转发 |
| `apps/local/src/runtime.ts`、`scripts/desktop/templates/web-parent.mjs` | web 接受 HTTP 之后把回环 URL 交给 web 进程 |
| `docker-compose.yml` | web 的 `NEMA_HUB_INTERNAL_URL`；hub 的 `NEMA_SHARES_ENABLED: ${NEMA_SHARES_ENABLED:-}`，Release 资产保留这一行；web 的 `host_ip` 是 `${NEMA_WEB_BIND:-127.0.0.1}`，hub 宿主机端口仍是 `127.0.0.1` |
| 三语 messages、四份 README、三份 guide、`docs/reference.zh-CN.md`、`SECURITY.md`、`changelog.d/`、`ROADMAP.md` | 文档 |

---

### Task 1: 分享行与公开投影

**Files:**

- Create: `apps/hub/src/db/migrations/019_knowledge_shares.sql`
- Create: `apps/hub/src/shares.ts`
- Test: `apps/hub/test/shares.test.ts`

**Interfaces:**

- Consumes: `Db`、`Workspace`、`Entry`、`KnowledgeStore.listEntries` / `get`
- Produces:
  - `type ShareRow = { id: string; workspaceId: string; note: string | null; expiresAt: string | null; revokedAt: string | null; createdAt: string }`
  - `type CreatedShare = ShareRow & { token: string }`
  - `createShare(db, workspaceId, input: { note?: string; expiresAt?: string | null }, now?: Date): Promise<CreatedShare>`
  - `listShares(db, workspaceId): Promise<ShareRow[]>`
  - `revokeShare(db, workspaceId, shareId): Promise<ShareRow | null>`
  - `revokeActiveShares(db, workspaceId, tx?: Db): Promise<void>`
  - `type PublicSummary` 与 `type PublicEntry`（字段仅限 spec D-6）
  - `toPublicSummary(entry: Entry): PublicSummary`
  - `toPublicEntry(entry: Entry): PublicEntry`
  - `type ShareResolution = { found: false } | { found: true; available: false } | { found: true; available: true; workspaceId: string; workspaceName: string }`
  - `resolveShare(db, token): Promise<ShareResolution>`。不接收 `enabled`。总开关由路由在查库前处理。不可用时不返回 `workspaceId` 或 `workspaceName`。`workspaceId` 只给 `repoPath` 用，不进入公开 JSON。
  - `SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/`

- [ ] **Step 1: 写失败测试**

`apps/hub/test/shares.test.ts` 使用 `makeHubDeps` / `createWorkspace`。断言：

```ts
test("stores only the sha256 of a 43-char token", async () => {
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const created = await createShare(db, ws.id, { note: "  one reader  " });
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(created.note).toBe("one reader");
  const rows = await db.query<{ token_hash: string }>("select token_hash from knowledge_shares");
  expect(rows).toEqual([{ token_hash: createHash("sha256").update(created.token).digest("hex") }]);
  expect(JSON.stringify(rows)).not.toContain(created.token);
});

test("revoke is immediate and does not revive", async () => {
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const a = await createShare(db, ws.id, {});
  const b = await createShare(db, ws.id, {});
  expect(await resolveShare(db, a.token)).toEqual({ found: true, available: true, workspaceId: ws.id, workspaceName: "Alpha" });
  await revokeShare(db, ws.id, a.id);
  expect(await resolveShare(db, a.token)).toEqual({ found: true, available: false });
  expect(await resolveShare(db, b.token)).toEqual({ found: true, available: true, workspaceId: ws.id, workspaceName: "Alpha" });
  await updateWorkspace(db, ws.id, { confidential: false });
  expect(await resolveShare(db, a.token)).toEqual({ found: true, available: false });
  expect(await resolveShare(db, "a".repeat(43))).toEqual({ found: false });
});
```

再写：过期时间为过去则 `createShare` 抛 400；`expiresAt` 已过、保密、归档都是 `{ found: true, available: false }`，不是 `{ found: false }`；`toPublicEntry` 去掉 `messageId`、`snapshotHash`、`sourceMessages`、`repoId`、`files`。总开关不进 `resolveShare`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: FAIL，`createShare` 未定义或表不存在。

- [ ] **Step 3: 写迁移与实现**

迁移用 spec 里的 SQL。`shares.ts` 只按哈希取出一行，可用性在同一条 SQL 里用数据库的 `now()` 算成布尔值，不要把不可用行过滤掉：

```sql
select w.id, w.name,
       (s.revoked_at is null
        and (s.expires_at is null or s.expires_at > now())
        and w.archived_at is null
        and w.confidential = false) as available
from knowledge_shares s
join workspaces w on w.id = s.workspace_id
where s.token_hash = $1
```

没有行就是 `{ found: false }`。有行就是 `{ found: true, available }`，只有 `available` 为真才带 `workspaceId` 和 `workspaceName`。`repoPath` 的第二参是 workspace id（`apps/hub/src/workspaces.ts`），名字不能当目录。`toPublicEntry` 显式构造对象，禁止展开 `Entry`。工作包任务只留 `n`、`title`、`status`。图只留 `diagram.type`。实现状态只留 `implementation.status`。公开状态用条目上的 `dropped`，不要写成 `withdrawn`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/db/migrations/019_knowledge_shares.sql apps/hub/src/shares.ts apps/hub/test/shares.test.ts
git commit -m "feat(hub): store hashed knowledge-share tokens"
```

---

### Task 2: 公开读取路由

**Files:**

- Create: `apps/hub/src/shareRoutes.ts`
- Modify: `apps/hub/src/app.ts`
- Test: `apps/hub/test/shares.test.ts`

**Interfaces:**

- Consumes: `resolveShare`、`toPublicSummary`、`toPublicEntry`、`KnowledgeStore`
- Produces: `shareRoutes(deps: { db: Db; dataDir: string; sharesEnabled: boolean; ownedHelpers?: OwnedHelperScope }): Hono`
- `createApp` 增加可选 `sharesEnabled?: boolean`，默认 true。`/share` 与 `/share/*` 使用和 `/api` 同一个 `hostGuard`。不挂 `uiAuth`。

- [ ] **Step 1: 写失败测试**

在已有 hub 测试应用上播种一条聊天 `"secret-chat-marker"`、一条 quote 文本为 `"public quote"` 的条目、图的 `nodePaths` 含 `secret/path.ts`、工作包任务文件 `secret/file.ts`。然后：

```ts
test("public share omits chat and private entry fields", async () => {
  const res = await app.request(`/share/${token}`, { headers: { host: "127.0.0.1:4400" } });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).not.toContain("secret-chat-marker");
  expect(body).not.toContain("secret/path.ts");
  expect(body).not.toContain("secret/file.ts");
  expect(body).not.toContain("sourceMessages");
  expect(body).not.toContain(ws.id);
  const entry = await app.request(`/share/${token}/entries/${eid}`, { headers: { host: "127.0.0.1:4400" } });
  const entryBody = await entry.text();
  expect(entryBody).toContain("public quote");
  expect(entryBody).not.toContain("messageId");
  expect(entryBody).not.toContain("snapshotHash");
});

test("wrong host is forbidden even with a live token", async () => {
  const res = await app.request(`/share/${token}`, { headers: { host: "evil.example:4400" } });
  expect(res.status).toBe(403);
});

test("share routes reject writes and do not accept the gateway credential", async () => {
  const posted = await app.request(`/share/${token}`, { method: "POST", headers: { host: "127.0.0.1:4400", "content-type": "application/json" }, body: "{}" });
  expect(posted.status).toBe(405);
  expect(posted.headers.get("allow")).toBe("GET, HEAD");
});
```

再断言：撤销后下一次 GET 是 404，正文是 `{"error":"not found"}`；过期、保密、归档、`sharesEnabled: false` 的正文与「没有这个 token」相同；带 `uiAuth` 的应用上，无凭据的 `GET /share/...` 仍是 200，无凭据的 `GET /api/workspaces` 仍是 401。`Host: 192.168.1.5:4400` 与 `Host: hub:4400` 也是 403，hostGuard 不因为 D-4 的局域网来源而放行。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: FAIL，404 或路由不存在。

- [ ] **Step 3: 实现路由**

`shareRoutes` 用同一个处理函数注册 GET 和 HEAD。token 不匹配 `SHARE_TOKEN_RE` 时 404，不查库。总开关关闭时 404，不查库，也不要为了限流去调用 `resolveShare`。`found: false` 与 `available: false` 都是 404，正文都是 `{"error":"not found"}`，都不带工作区名或 workspace id。单条先解析分享，不可用同样 404；可用之后用 `repoPath(dataDir, resolution.workspaceId)` 打开 `KnowledgeStore`，再 `kindFromId(eid)`，失败也是 404。不要调用 `withReportPass`、`sourceEvidenceEntries`、`history`、`blameParagraphs`、`versionAt`。每个响应 `c.header("cache-control", "no-store")`。

`app.ts`：

```ts
app.use("/share", guard);
app.use("/share/*", guard);
app.route("/share", shareRoutes({ db: deps.db, dataDir: deps.dataDir, sharesEnabled: deps.sharesEnabled !== false, ownedHelpers: deps.ownedHelpers }));
```

放在 `uiAuth` 之前或之外，总之不能让 `uiAuth` 包住 `/share`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/shareRoutes.ts apps/hub/src/app.ts apps/hub/test/shares.test.ts
git commit -m "feat(hub): add loopback-only knowledge share reads"
```

---

### Task 3: 主人接口与保密/归档撤销

**Files:**

- Create: `apps/hub/src/shareAdmin.ts`
- Modify: `apps/hub/src/app.ts`、`apps/hub/src/uiApi.ts`、`apps/hub/src/lifecycle.ts`、`apps/hub/src/main.ts`、`apps/local/src/runtime.ts`
- Test: `apps/hub/test/shares.test.ts`、`apps/local/test/runtime.test.ts`

**Interfaces:**

- Consumes: `createShare`、`listShares`、`revokeShare`、`revokeActiveShares`
- Produces: `shareAdminRoutes(deps: { db: Db; sharesEnabled: boolean }): Hono`，挂在 `/api`

- [ ] **Step 1: 写失败测试**

```ts
test("create returns the token once and list never does", async () => {
  const created = await app.request(`/api/workspaces/${ws.id}/shares`, {
    method: "POST", headers: { host: "127.0.0.1:4400", "content-type": "application/json" }, body: JSON.stringify({ note: "ada" }),
  });
  expect(created.status).toBe(201);
  const payload = await created.json();
  const listed = await app.request(`/api/workspaces/${ws.id}/shares`, { headers: { host: "127.0.0.1:4400" } });
  expect(JSON.stringify(await listed.json())).not.toContain(payload.token);
});

test("marking confidential revokes active links in one step", async () => {
  const created = await createShare(db, ws.id, {});
  await app.request(`/api/workspaces/${ws.id}`, {
    method: "PATCH", headers: { host: "127.0.0.1:4400", "content-type": "application/json" }, body: JSON.stringify({ confidential: true }),
  });
  expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
  const again = await app.request(`/api/workspaces/${ws.id}`, {
    method: "PATCH", headers: { host: "127.0.0.1:4400", "content-type": "application/json" }, body: JSON.stringify({ confidential: false }),
  });
  expect(again.status).toBe(200);
  expect(await resolveShare(db, created.token)).toEqual({ found: true, available: false });
});
```

再覆盖：归档同样撤销且取消归档不恢复；保密工作区 POST 创建为 409；`sharesEnabled: false` 时 POST 为 403，GET 列表与 POST revoke 仍 200；重复 revoke 为 200。

桌面 core：`apps/local/test/runtime.test.ts` 在同进程 `startLocalRuntime` 之前把 `NEMA_SHARES_ENABLED` 设为 `0`。`runtimeReadyHookForTests` 要能拿到 `hub.url`。钩子里写入一条分享行，再以回环 Host 请求 `GET /share/<token>`，得到与无效链接相同的 404。测完删掉该变量。这个用例只证明 core 进程里已经有该变量时 hub 会关掉分享。

桌面 launcher：同一文件里已有 bench flag 用例，用 `setEnsureSpawnerForTests` 截获 `ensureLocalRuntime` 的 `spec.env`。`NEMA_SHARES_ENABLED=0` 时该字段必须是 `"0"`；删掉变量后再调一次，该字段必须是 `undefined`。这才经过 `childEnvironment`。同进程用例不能代替它。

并发：同时 `createShare` 和把同一工作区 PATCH 成 `confidential: true`，等两边都结束，再 PATCH 回 `confidential: false`。创建若返回 409，`knowledge_shares` 里不能有 `revoked_at is null` 的行；创建若返回 token，`resolveShare` 必须是 `{ found: true, available: false }`。归档走同一断言。PGlite 一次只跑一个事务（`apps/hub/test/messages.test.ts` 已写明真正的重叠要 PostgreSQL），所以这条不能单独证明两个连接的交错。再用那个文件里的 `record` 包装记下 SQL：`createShare` 与这次限制性 PATCH 的事务里，第一条对 `workspaces` 的语句都是 `select ... for update`，分享行的 `insert` 发生在同一事务、且在锁之后。事务外先读 `confidential` 再插入的写法过不了这条。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现**

`shareAdmin.ts` 按 spec 的状态码。`createShare` 自己开事务，不信任事务外读到的工作区状态：

```ts
await db.tx(async (tx) => {
  const locked = await tx.query<{ confidential: boolean; archived_at: string | null }>(
    "select confidential, archived_at from workspaces where id = $1 for update",
    [workspaceId],
  );
  if (!locked[0]) throw new HttpError(404, "workspace not found");
  if (locked[0].confidential) throw new HttpError(409, "confidential workspace cannot be shared");
  if (locked[0].archived_at) throw new HttpError(409, "archived workspace cannot be shared");
  // insert knowledge_shares on tx, then return the created row
});
```

`uiApi` 的 PATCH 在更新之前锁同一行。限制性更新把撤销放进这个事务；其他 PATCH 也先拿这把锁，避免创建插在更新和撤销之间：

```ts
const updated = await db.tx(async (tx) => {
  const locked = await tx.query<{ id: string }>("select id from workspaces where id = $1 for update", [id]);
  if (!locked[0]) throw new HttpError(404, `workspace not found: ${id}`);
  const row = await updateWorkspace(tx, id, clean);
  if (clean.confidential === true || clean.archived === true) await revokeActiveShares(tx, id);
  return row;
});
```

`deleteWorkspace` 已经用 `select id from workspaces where id = $1 for update`。`updateWorkspace` 只对传入的 `Db` 执行 `query`，把 `tx` 传进去不会再开一个事务。`db.tx` 在 `pg` 和 PGlite 上都会把嵌套调用并进外层事务。不要复制 `updateWorkspace` 的 UPDATE。锁要在读状态和插入之前拿到，并持有到事务提交：先提交的创建会被随后的撤销扫到；先提交的保密或归档会让还在等待的创建看到新状态并返回 409。公开读取时再查一次保密和归档，那不是这把锁的替代。事务只包住这把锁、`updateWorkspace` 和 `revokeActiveShares`。取消归档后通知排队任务，以及 `syncBoundRepos`，仍放在事务提交之后；不要把 daemon 调用放进这把锁。

总开关进 `StartHubOptions`，再由 `startHub` 传给 `createApp`。桌面不走 `main.ts`：core 里的 `apps/local/src/runtime.ts` 直接调用 `startHub`（约第 499 行），现在的选项里没有这个字段。`main.ts` 与 core 内的 `runtime.ts` 都传 `sharesEnabled: process.env.NEMA_SHARES_ENABLED !== "0"`。缺省仍是开启。`NEMA_SHARES_ENABLED=0` 时桌面 hub 上已有链接的公开读取也是 404。

`childEnvironment`（同文件约第 251 行）只复制一份白名单，外加 `NEMA_DESKTOP_BENCH` 为 `1` 时的那一项，以及 Electron 的 `ELECTRON_RUN_AS_NODE`。`ensureLocalRuntime`（约第 586 行）用 `childEnvironment({})` 启动 core。桌面 `apps/desktop/lifecycle.cjs` 走的是 `ensureLocalRuntime`。父进程把 `NEMA_SHARES_ENABLED` 设成 `0` 时，子进程现在看不到它，分享会保持开启。变量有定义时原样复制，包括 `0`。未设置时不写入。不要只在值为 `1` 时复制：那是 bench flag 的写法，用在这里会把 `0` 丢掉。

复用不会把新环境送进旧 core。第一条在 `discoverInstance` 命中时直接返回（约第 571 行）。第二条在新 core 报 `NEMA_LOCAL_OWNER_COLLISION` 之后返回已有实例（约第 675 行）。`instance.json` 不记录总开关。launcher 的 `NEMA_SHARES_ENABLED` 明确为 `0` 时，这两条都不能返回 `reused: true`。先 `shutdownLocalRuntime` 停掉旧 core，再启动，新进程的环境里该变量是 `"0"`。停不掉就抛错，消息写明 sharing remains enabled，不要带着旧 core 继续。未设置与 `0` 必须分开：未设置或 `1` 仍可复用。

`runtime.test.ts` 覆盖这两条。先有一个未设置该变量时就绪的 core，再以 `NEMA_SHARES_ENABLED=0` 调用 `ensureLocalRuntime`。直接命中和碰撞命中都不是 `reused: true` 指向旧 core。停得掉时，新 core 的 `spec.env.NEMA_SHARES_ENABLED` 是 `"0"`。注入的 shutdown 失败时，错误消息包含 `sharing remains enabled`，并且没有返回旧实例。测完恢复环境变量。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/hub/test/shares.test.ts apps/hub/test/uiApi.test.ts apps/local/test/runtime.test.ts`

Expected: PASS。`uiApi.test.ts` 里已有的工作区 PATCH 用例仍通过。

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/shareAdmin.ts apps/hub/src/app.ts apps/hub/src/uiApi.ts apps/hub/src/lifecycle.ts apps/hub/src/main.ts apps/local/src/runtime.ts apps/hub/test/shares.test.ts apps/local/test/runtime.test.ts
git commit -m "feat(hub): manage knowledge share links"
```

---

### Task 4: 限流与快照拒绝

**Files:**

- Modify: `apps/hub/src/shares.ts`、`apps/hub/src/shareRoutes.ts`
- Modify: `apps/local/test/migration.test.ts`
- Test: `apps/hub/test/shares.test.ts`

**Interfaces:**

- Produces: `takeShareSlot(kind: "known" | "unknown", key: string, now: number): boolean`，以及测试用的 `resetShareRateForTests(): void`
- known：120 / 60_000 ms，按哈希。unknown：600 / 60_000 ms，共用一把 key `"unknown"`。

- [ ] **Step 1: 写失败测试**

```ts
test("unknown-token floods do not block a live token", async () => {
  resetShareRateForTests();
  for (let i = 0; i < 600; i++) await app.request(`/share/${"a".repeat(43)}`, { headers: { host: "127.0.0.1:4400" } });
  const blocked = await app.request(`/share/${"b".repeat(43)}`, { headers: { host: "127.0.0.1:4400" } });
  expect(blocked.status).toBe(429);
  const live = await app.request(`/share/${token}`, { headers: { host: "127.0.0.1:4400" } });
  expect(live.status).toBe(200);
});
```

用注入的时钟把一条已知哈希打到 121 次，第 121 次 429，且正文是 `{ "error": "too many requests" }`，`retry-after` 为 `60`。再对一条已撤销的 token 做同样的 121 次：第 121 次仍是 429，而这 121 次不占用 unknown 桶，另一个从未见过的 43 字符 token 仍然是 404。`found: false` 与 `available: false` 的 404 正文相同。

快照：

```ts
expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, knowledge_shares: [{ id: "ks_abcdefghijklmnop" }] } })).toThrow(/table/i);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts apps/local/test/migration.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现**

路由顺序：形状非法 → 404，不查库，不占桶；总开关关闭 → 404，不查库，不占桶；`resolveShare`；`found: false` 计入 unknown 桶，`found: true`（不论 `available`）计入该 token 的 sha256 桶。桶满返回 429。未满时 `available: false` 与 `found: false` 都是同一种 404，`available: true` 才是 200。Map 超过 10_000 个 key 时删掉最旧的。注释写明：进程内、重启丢失、不跨实例。不要在查库之前用 unknown 桶拒绝请求。

不要把 `knowledge_shares` 加入 `snapshot.ts`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/hub/test/shares.test.ts apps/local/test/migration.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/shares.ts apps/hub/src/shareRoutes.ts apps/hub/test/shares.test.ts apps/local/test/migration.test.ts
git commit -m "fix(hub): rate-limit share reads and keep tokens out of snapshots"
```

---

### Task 5: web 公开页

**Files:**

- Create: `apps/web/lib/shareHub.ts`、`apps/web/lib/sharePeer.ts`
- Create: `apps/web/app/s/layout.tsx`
- Create: `apps/web/app/s/[token]/page.tsx`
- Create: `apps/web/app/s/[token]/e/[eid]/page.tsx`
- Create: `apps/web/components/ShareView.tsx`
- Modify: `apps/web/app/layout.tsx`
- Create: `apps/web/app/(room)/layout.tsx`
- Move: `apps/web/app/page.tsx` → `apps/web/app/(room)/page.tsx`
- Move: `apps/web/app/w/**` → `apps/web/app/(room)/w/**`
- Modify: `apps/web/test/page.test.tsx`、`apps/web/next.config.ts`
- Test: `apps/web/test/shareHub.test.ts`、`apps/web/test/sharePeer.test.ts`、`apps/web/test/ShareView.test.tsx`

**Interfaces:**

- Produces: `fetchShare(path: "list" | "entry", token: string, entryId?: string): Promise<{ status: number; body: unknown }>`
- 页面只把 hub 的公开 JSON 交给 `ShareView`。`ShareView` 不得 import `@/lib/hub`。

- [ ] **Step 1: 写失败测试**

`shareHub.test.ts`：

- `http://hub:4400` 被接受，发出的 `Host` 是 `127.0.0.1:4400`，路径是 `/share/<token>`。
- `http://evil.example:4400` 与 `https://hub:4400` 不发起连接。
- 请求头里没有 `cookie` 和 `authorization`。
- token 含 `/` 或长度不是 43 时不发起连接。

用 `node:http` 的测试桩或把 `request` 函数注入 `fetchShare`。不要为了测试去改 hub。

`sharePeer.test.ts` 按 spec D-4 的表断言 `isPrivateSharePeer` 与 `sharePeerDecision(peer, headers)`。允许前缀各至少一个地址。`8.8.8.8`、`172.32.0.1`、`100.64.0.1`、`203.0.113.5`、`2001:db8::1`、`::ffff:8.8.8.8` 是 `reject`。`::ffff:192.168.0.5`、`fd00::1`、`fe80::1`、`fe80::1%eth0`、`::1`、`127.0.0.1` 是 `allow`。对端 `10.1.2.3` 带 `X-Forwarded-For` 是 `reject`。对端 `203.0.113.5` 且头里是 `10.0.0.5` 也是 `reject`，不能按头放行。`sharePeerDecision` 为 `reject` 时页面不调用 `fetchShare`。

`ShareView.test.tsx` 渲染一条条目，断言没有 textbox、没有 button 名称匹配发送/确认/编辑，链接指向 `/s/<token>/e/D-1`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/web/test/shareHub.test.ts apps/web/test/sharePeer.test.ts apps/web/test/ShareView.test.tsx`

Expected: FAIL

- [ ] **Step 3: 实现**

`sharePeer.ts` 导出 `isPrivateSharePeer(address: string): boolean` 与 `sharePeerDecision(peer: string | null | undefined, headers: Headers | Record<string, string | string[] | undefined>): "allow" | "reject"`。转发头名是 `x-forwarded-for`、`forwarded`、`x-real-ip`、`cf-connecting-ip`、`true-client-ip`、`x-forwarded-host`，大小写不敏感，出现即 `reject`，不解析值。不要调用 `NextRequest.ip`。

`shareHub.ts` 用 `node:http`，按 spec 校验 URL 和 2 MiB / 10 秒上限。`next.config.ts` 的 `headers()` 给 `/s/:path*` 加上 spec D-9 的五个响应头。分享页在调用 `fetchShare` 之前先看 `sharePeerDecision`，`reject` 时渲染与无效链接相同的 404，不请求 hub。

根 layout 只留 html、字体、`globals.css`、`I18nProvider`。私有壳移到 `(room)/layout.tsx`。`page.test.tsx` 的 import 改为 `@/app/(room)/page`。

分享 layout：`export const dynamic = "force-dynamic"`，metadata `robots: { index: false, follow: false }`。hub 404 渲染 404；连接失败渲染 503。两种正文都不要包含工作区名以外的后端错误字符串。404 正文不含工作区名。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/web/test/shareHub.test.ts apps/web/test/sharePeer.test.ts apps/web/test/ShareView.test.tsx apps/web/test/page.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/shareHub.ts apps/web/lib/sharePeer.ts apps/web/app apps/web/components/ShareView.tsx apps/web/test apps/web/next.config.ts
git commit -m "feat(web): render a read-only knowledge share page"
```

---

### Task 6: 桌面网关与 Compose 内部地址

**Files:**

- Modify: `apps/local/src/gateway.ts`、`apps/local/test/gateway.test.ts`
- Modify: `apps/local/src/runtime.ts`、`apps/local/test/runtime.test.ts`、`apps/local/test/fixtures/fake-web.mjs`、`scripts/desktop/templates/web-parent.mjs`、`scripts/images/web-entrypoint.sh`
- Modify: `docker-compose.yml`、`scripts/images/check-images.mjs`、`scripts/images/check-images.test.mjs`、`scripts/up.mjs`、`scripts/setup.mjs`

**Interfaces:**

- Consumes: Task 5 的页面路径
- Produces: 网关对合法分享路径跳过会话；`webChild.send({ type: "hub-url", url: hub.url })`

- [ ] **Step 1: 写失败测试**

网关测试沿用 `gateway.test.ts` 的假 upstream：

- 无 cookie 的 `GET /s/${"a".repeat(43)}` 到达 web，状态跟随 web。
- web 收到的请求没有 `cookie`，也没有 `x-nema-gateway-credential`。
- 无 cookie 的 `GET /api/workspaces` 仍是 401，且 hub 收到 0 次请求。
- `GET /s/short` 不联系 web，404。
- `POST /s/${"a".repeat(43)}` 为 405。
- `Host` 不是网关 origin 时仍是 403。网关继续只听 `127.0.0.1`，Host 继续只接受 `127.0.0.1:<gatewayPort>`。
- 回环上的 `GET /s/${"a".repeat(43)}` 只要带了 `X-Forwarded-For`，就是 404，web 收到 0 次。头的值即使是 `10.0.0.1` 也不放行。

`check-images` 断言 web 环境包含 `NEMA_HUB_INTERNAL_URL: http://hub:${NEMA_HUB_PORT:-4400}`，并且原有 `NEMA_HUB_URL` 断言不变。`assertComposeShape` 要求 hub 块包含 `NEMA_SHARES_ENABLED: ${NEMA_SHARES_ENABLED:-}`。`renderComposeAsset` 只替换镜像标签和文件头，Release 资产必须留下这一行。`check-images.test.mjs` 对模板和这份资产都跑 `docker compose config`：环境里 `NEMA_SHARES_ENABLED=0` 时 `services.hub.environment.NEMA_SHARES_ENABLED` 是 `"0"`；未设置时不是 `"0"`。`docker-compose.build.yml` 不覆盖 hub 的 environment，合并后的源码 Compose 做同样的断言。

`assertWebBind` 接受 `127.0.0.1`、`192.168.1.10`、`fd00::10`，拒绝 `0.0.0.0`、`::`、`1.2.3.4`、`example.com`。web 端口改成长写法，`host_ip` 是 `${NEMA_WEB_BIND:-127.0.0.1}`。`NEMA_WEB_BIND=192.168.1.10` 时解析结果的 `host_ip` 是该地址。hub 的发布地址仍是 `127.0.0.1`，模板里不能出现把 web 发布到字面量 `0.0.0.0` 的行。非法绑定在 `npm run up` 之前失败。

`fake-web.mjs` 在 `listen` 之前同步记录收到的 `{ type: "hub-url" }`。runtime 测试断言这条消息在 fixture 开始接受 HTTP 之后才到达，且 `url` 等于这次临时端口 hub 的回环地址。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/local/test/gateway.test.ts apps/local/test/runtime.test.ts && node --test scripts/images/check-images.test.mjs`

Expected: FAIL

- [ ] **Step 3: 实现**

`mappedTarget` 增加 spec 里的两条正则，返回 `{ target: web, ui: true, publicShare: true }`。`handle` 里 `publicShare` 跳过会话检查。非 GET/HEAD 在转发前 405。`/s` 与 `/s/` 在转发前调用 `sharePeerDecision(req.socket.remoteAddress, req.headers)`。结果是 `reject` 时直接 404，`Cache-Control: no-store`，正文 `not found`，不联系 web。网关仍然 `listen(port, "127.0.0.1")`，不读取 `NEMA_WEB_BIND`。

`web-parent.mjs` 与 `scripts/images/web-entrypoint.sh` 在加载 `server.js` 之前包装 `http.Server` 的 `request`：路径是 `/s` 或以 `/s/` 开头时，用 `req.socket.remoteAddress` 和原始头调用同一个 `sharePeerDecision`。`reject` 时写 404 与 `Cache-Control: no-store`，正文 `not found`，不把请求交给 Next，也不请求 hub。其余路径原样交给 Next。不要读 `NextRequest.ip`。容器内 `HOSTNAME` 仍是 `0.0.0.0`；局域网范围只由宿主机的 `host_ip` 和这道对端判断决定。

`web-parent.mjs` 在 `await import("./server.js")` 之前注册监听。今天这个文件只在 import 之后发送 `{ type: "managed-web-ready", port }`，没有入站监听：

```js
process.on("message", (message) => {
  if (message && typeof message === "object" && message.type === "hub-url" && typeof message.url === "string") {
    process.env.NEMA_HUB_INTERNAL_URL = message.url;
  }
});
```

web 端口改为长写法，`host_ip: ${NEMA_WEB_BIND:-127.0.0.1}`，`published: ${NEMA_WEB_PORT:-3000}`，`target: 3000`。`assertWebBind` 放在 `scripts/images/check-images.mjs`，按 D-4 拒绝 `0.0.0.0`、`::`、公网地址和域名。`scripts/up.mjs` 与 `scripts/setup.mjs` 在调用 `devComposeUpArgs()` 之前调用它。hub 的宿主机端口一行不改。

hub 的 environment 增加 `NEMA_SHARES_ENABLED: ${NEMA_SHARES_ENABLED:-}`。Compose 不会把宿主机上没写进 `environment` 的变量送进容器。现在 hub 块没有这一行，操作者设成 `0` 时容器里该变量是未设置，`!== "0"` 仍为真，已有链接还能读。空默认值让未设置保持为空，分享保持开启。不要写成 `:-1`：那会在操作者明确设 `0` 之前就打不开关闭。

`runtime.ts` 不要在 `startHub` 返回时立刻 `webChild.send`。v0.2.4 起 `httpReady` 与 `createLocalDb`、`startHub` 重叠，那个时刻子进程可能还停在 `await import("./server.js")`。已有的 `await webReady` 在 `startHub` 之后，表示子进程已经接受回环 HTTP；监听器又在 import 之前，所以在 `await webReady` 之后发送一次 `{ type: "hub-url", url: hub.url }`。发送失败只记日志，不把 hub URL 写进日志以外的公开响应。`apps/local/test/fixtures/fake-web.mjs` 在开始监听之前同步记下收到的 `hub-url`。runtime 测试断言这条消息在 fixture 接受 HTTP 之后到达，且 `url` 等于这次 `startHub({ port: 0 })` 的回环地址。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/local/test/gateway.test.ts apps/local/test/runtime.test.ts && node --test scripts/images/check-images.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/local/src/gateway.ts apps/local/src/runtime.ts apps/local/test/gateway.test.ts apps/local/test/runtime.test.ts apps/local/test/fixtures/fake-web.mjs scripts/desktop/templates/web-parent.mjs scripts/images/web-entrypoint.sh docker-compose.yml scripts/images/check-images.mjs scripts/images/check-images.test.mjs scripts/up.mjs scripts/setup.mjs
git commit -m "feat(local): serve knowledge shares without a desktop session"
```

---

### Task 7: 设置里的分享控件

**Files:**

- Create: `apps/web/components/ShareKnowledge.tsx`
- Modify: `apps/web/components/WorkspaceSettings.tsx`、`apps/web/lib/hub.ts`
- Modify: `apps/web/messages/en.json`、`zh.json`、`ja.json`
- Test: `apps/web/test/ShareKnowledge.test.tsx`

**Interfaces:**

- Consumes: `GET/POST /api/workspaces/:id/shares` 与 `POST .../revoke`
- Produces: `ShareKnowledge({ workspaceId, confidential, archived }: { workspaceId: string; confidential: boolean; archived: boolean })`

- [ ] **Step 1: 写失败测试**

渲染后出现创建按钮。点击创建，mock 的 `createShare` 返回 token `abc`（测试里用 43 字符）一次；界面出现 `http://localhost/s/<token>`（用 `location.origin`）。再次渲染组件时 mock 的列表没有 token，界面也不再含该 token。点击撤销调用 revoke。`confidential` 为 true 时创建按钮 disabled。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/web/test/ShareKnowledge.test.tsx`

Expected: FAIL

- [ ] **Step 3: 实现**

`hub.ts` 增加 `listShares`、`createShare`、`revokeShare`，都走现有 `request()`。复制用 `navigator.clipboard.writeText`，失败时链接仍留在只读输入框里。

三语至少这些 key（英文如下，zh/ja 译同义）：

- `share.heading`: Share knowledge
- `share.help`: Anyone with the link can read this knowledge base. They cannot see chat, tasks, attachments, or settings. The link works only where this page is reachable.
- `share.note`: Note
- `share.expires`: Expires
- `share.create`: Create link
- `share.revoke`: Revoke
- `share.revoked`: Revoked
- `share.copy`: Copy
- `share.shownOnce`: This link is shown only once.
- `share.confidential`: Turn off confidential to create a link. Turning confidential on revokes existing links.
- `share.archived`: Unarchive this workspace to create a link.
- `share.disabled`: Sharing is turned off on this server.
- `share.unavailable`: This link is unavailable.
- `share.down`: Sharing is temporarily unavailable.
- `settings.confidentialHelp`: 在原意上加上「Turning this on revokes existing knowledge-share links and blocks new ones.」中文与日文同步，不再写「此开关为后续功能预留」作为唯一说明。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/web/test/ShareKnowledge.test.tsx apps/web/test/WorkspaceSettings.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/ShareKnowledge.tsx apps/web/components/WorkspaceSettings.tsx apps/web/lib/hub.ts apps/web/messages apps/web/test/ShareKnowledge.test.tsx
git commit -m "feat(web): create and revoke knowledge share links"
```

---

### Task 8: 文档

**Files:**

- Modify: `README.md`、`README.en.md`、`README.zh.md`、`README.ja.md`
- Modify: `docs/guide.en.md`、`docs/guide.zh.md`、`docs/guide.ja.md`
- Modify: `docs/reference.zh-CN.md`、`SECURITY.md`、`ROADMAP.md`
- Create: `changelog.d/readonly-knowledge-share.added.md`

**Interfaces:**

- Consumes: spec「文档」一节的定稿事实

- [ ] **Step 1: 改文档**

README 英文两份改成同一句：

```text
- **Built for local use.** A share link can grant read-only access to one workspace knowledge base. There is still no public multi-user authentication. Multi-device sync, managed backups, and team accounts are not available yet.
```

用 `cmp README.md README.en.md` 确认逐字节相同。中文与日文 README 写同一事实。

guide 三语按 spec 写操作与边界。reference 写明 `/share` 仍只接受回环 Host。SECURITY 增加 capability URL 边界。ROADMAP 的 P2-04 若已链到本 spec 与本 plan，保持该链接，状态保持「进行中」。

`changelog.d/readonly-knowledge-share.added.md`：

```markdown
- 工作区可以签发只读知识库链接。访客只能阅读知识条目，不能看到聊天、任务、附件或设置；撤销后链接立即失效。默认仍只在本机回环地址开放。
```

- [ ] **Step 2: 检查**

Run: `cmp README.md README.en.md && node --test scripts/images/check-images.test.mjs`

Expected: `cmp` 无输出且退出码 0；镜像形状测试 PASS。

- [ ] **Step 3: Commit**

```bash
git add README.md README.en.md README.zh.md README.ja.md docs/guide.en.md docs/guide.zh.md docs/guide.ja.md docs/reference.zh-CN.md SECURITY.md ROADMAP.md changelog.d/readonly-knowledge-share.added.md
git commit -m "docs: describe read-only knowledge share links"
```

---

### Task 9: 总验证

- [ ] **Step 1: 类型与定向测试**

Run:

```bash
npm run typecheck
npx vitest run apps/hub/test/shares.test.ts apps/hub/test/uiApi.test.ts apps/local/test/migration.test.ts apps/local/test/gateway.test.ts apps/web/test/shareHub.test.ts apps/web/test/sharePeer.test.ts apps/web/test/ShareView.test.tsx apps/web/test/ShareKnowledge.test.tsx apps/web/test/page.test.tsx
npm run lint -w apps/web
```

Expected: 全部 PASS。

- [ ] **Step 2: web 构建**

Run: `npm run build -w apps/web`

Expected: 构建成功。抽查生成的分享路由不依赖 `NEXT_PUBLIC_HUB_URL` 作为公开页的数据源。

- [ ] **Step 3: 不在本期的项保持未做**

确认 diff 里没有 users 表、分享密码、部分条目分享、图 HTML、桌面公网 Host 白名单、桌面局域网绑定、信任 `X-Forwarded-For` 的放行。`ROADMAP.md` 的 P2-04 不是「已完成」。
