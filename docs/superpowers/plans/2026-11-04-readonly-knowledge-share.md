# 只读分享知识库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给一个 workspace 的知识库签发可撤销的只读链接，访客只在 web origin 上阅读公开投影。

**Architecture:** 主人走现有 `/api`（`hostGuard` + 可选 `uiAuth`）。访客打开 `/s/<token>`，Next 服务端用 `node:http` 请求 hub 的 `/share/<token>`，并把 `Host` 设为 `127.0.0.1:<port>`。`hostGuard` 不放宽。token 只以 sha256 入库。

**Tech Stack:** Hono、PostgreSQL/PGlite 迁移、Next.js App Router、现有桌面网关、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-04-readonly-knowledge-share-design.md`

## Global Constraints

- 对照 spec 的 D-1 到 D-10，实现不得改这些选择。
- `hostGuard` 的允许名单仍然只有 `127.0.0.1:<port>` 与 `localhost:<port>`。`/share` 也走它。
- 分享 token 不是 `/api`、`/room`、`/report` 的凭据。公开页不 import `@/lib/hub`，HTML 不含 `window.__NEMA_HUB_URL__`。
- 明文 token 只出现在创建响应。不进日志、错误正文、快照。
- `knowledge_shares` 不加入 `TABLE_COLUMNS` / `OPTIONAL_TABLES`。
- 保密工作区不能新建分享；打开保密或归档会在同一事务撤销未撤销的行。取消保密或取消归档不恢复这些行。
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
| `apps/hub/src/main.ts` | 从 `NEMA_SHARES_ENABLED` 读总开关 |
| `apps/hub/test/shares.test.ts` | 存储、投影、路由、泄露、Host、撤销 |
| `apps/local/test/migration.test.ts` | 快照拒绝 `knowledge_shares` |
| `apps/web/lib/shareHub.ts` | 服务端内部请求；校验 URL；不转发访客头 |
| `apps/web/app/(room)/layout.tsx` | 从根 layout 移来的私有壳 |
| `apps/web/app/(room)/page.tsx` 与 `(room)/w/**` | 现有页面，URL 不变 |
| `apps/web/app/s/layout.tsx`、`s/[token]/page.tsx`、`s/[token]/e/[eid]/page.tsx` | 公开页 |
| `apps/web/components/ShareKnowledge.tsx` | 设置里的创建、复制、撤销 |
| `apps/web/components/ShareView.tsx` | 只读列表与正文 |
| `apps/local/src/gateway.ts` | `/s/...` 无会话转发 |
| `apps/local/src/runtime.ts`、`scripts/desktop/templates/web-parent.mjs` | hub 起来后把回环 URL 交给 web 进程 |
| `docker-compose.yml` | `NEMA_HUB_INTERNAL_URL` |
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
  - `resolveShare(db, token, opts: { enabled: boolean }): Promise<{ workspaceName: string } | null>`
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
  expect(await resolveShare(db, a.token, { enabled: true })).toEqual({ workspaceName: "Alpha" });
  await revokeShare(db, ws.id, a.id);
  expect(await resolveShare(db, a.token, { enabled: true })).toBeNull();
  expect(await resolveShare(db, b.token, { enabled: true })).toEqual({ workspaceName: "Alpha" });
  await updateWorkspace(db, ws.id, { confidential: false });
  expect(await resolveShare(db, a.token, { enabled: true })).toBeNull();
});
```

再写：过期时间为过去则 `createShare` 抛 400；`expiresAt` 已过则 `resolveShare` 为 null；`enabled: false` 为 null；保密或归档为 null；`toPublicEntry` 去掉 `messageId`、`snapshotHash`、`sourceMessages`、`repoId`、`files`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: FAIL，`createShare` 未定义或表不存在。

- [ ] **Step 3: 写迁移与实现**

迁移用 spec 里的 SQL。`shares.ts` 的查找只认这一条：

```sql
select w.name
from knowledge_shares s
join workspaces w on w.id = s.workspace_id
where s.token_hash = $1
  and s.revoked_at is null
  and (s.expires_at is null or s.expires_at > now())
  and w.archived_at is null
  and w.confidential = false
```

`enabled === false` 时不查库，直接 null。`toPublicEntry` 显式构造对象，禁止展开 `Entry`。工作包任务只留 `n`、`title`、`status`。图只留 `diagram.type`。实现状态只留 `implementation.status`。

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

再断言：撤销后下一次 GET 是 404，正文是 `{"error":"not found"}`；过期、保密、归档、`sharesEnabled: false` 的正文与「没有这个 token」相同；带 `uiAuth` 的应用上，无凭据的 `GET /share/...` 仍是 200，无凭据的 `GET /api/workspaces` 仍是 401。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: FAIL，404 或路由不存在。

- [ ] **Step 3: 实现路由**

`shareRoutes` 用同一个处理函数注册 GET 和 HEAD。token 不匹配 `SHARE_TOKEN_RE` 时 404，不查库。总开关关闭时 404，不查库。`resolveShare` 为 null 时 404。单条先解析分享，再 `kindFromId(eid)`，失败也是 404。不要调用 `withReportPass`、`sourceEvidenceEntries`、`history`、`blameParagraphs`、`versionAt`。每个响应 `c.header("cache-control", "no-store")`。

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
- Modify: `apps/hub/src/app.ts`、`apps/hub/src/uiApi.ts`、`apps/hub/src/main.ts`
- Test: `apps/hub/test/shares.test.ts`

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
  expect(await resolveShare(db, created.token, { enabled: true })).toBeNull();
  const again = await app.request(`/api/workspaces/${ws.id}`, {
    method: "PATCH", headers: { host: "127.0.0.1:4400", "content-type": "application/json" }, body: JSON.stringify({ confidential: false }),
  });
  expect(again.status).toBe(200);
  expect(await resolveShare(db, created.token, { enabled: true })).toBeNull();
});
```

再覆盖：归档同样撤销且取消归档不恢复；保密工作区 POST 创建为 409；`sharesEnabled: false` 时 POST 为 403，GET 列表与 POST revoke 仍 200；重复 revoke 为 200。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现**

`shareAdmin.ts` 按 spec 的状态码。`uiApi` 的 PATCH 在 `confidential === true` 或 `archived === true` 时：

```ts
const updated = await db.tx(async (tx) => {
  const row = await updateWorkspace(tx, id, clean);
  if (clean.confidential === true || clean.archived === true) await revokeActiveShares(tx, id);
  return row;
});
```

`updateWorkspace` 已经接受 `Db`。确认 `db.tx` 传出的客户端满足 `updateWorkspace` 的查询接口；若事务客户端类型不同，给 `updateWorkspace` 的 `db` 参数用已有的事务类型，不要复制一份更新 SQL。

`main.ts`：`sharesEnabled: process.env.NEMA_SHARES_ENABLED !== "0"`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/hub/test/shares.test.ts apps/hub/test/uiApi.test.ts`

Expected: PASS。`uiApi.test.ts` 里已有的工作区 PATCH 用例仍通过。

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/shareAdmin.ts apps/hub/src/app.ts apps/hub/src/uiApi.ts apps/hub/src/main.ts apps/hub/test/shares.test.ts
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

用注入的时钟把一条已知哈希打到 121 次，第 121 次 429，且正文是 `{ "error": "too many requests" }`，`retry-after` 为 `60`。

快照：

```ts
expect(() => validateSnapshot({ ...empty, tableData: { ...empty.tableData, knowledge_shares: [{ id: "ks_abcdefghijklmnop" }] } })).toThrow(/table/i);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/hub/test/shares.test.ts apps/local/test/migration.test.ts`

Expected: FAIL

- [ ] **Step 3: 实现**

路由顺序：形状非法 → 404；总开关关闭 → 404；按哈希查库；未命中计入 unknown 桶，命中计入 known 桶。桶满返回 429，否则继续原来的 404 或 200。Map 超过 10_000 个 key 时删掉最旧的。注释写明：进程内、重启丢失、不跨实例。

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

- Create: `apps/web/lib/shareHub.ts`
- Create: `apps/web/app/s/layout.tsx`
- Create: `apps/web/app/s/[token]/page.tsx`
- Create: `apps/web/app/s/[token]/e/[eid]/page.tsx`
- Create: `apps/web/components/ShareView.tsx`
- Modify: `apps/web/app/layout.tsx`
- Create: `apps/web/app/(room)/layout.tsx`
- Move: `apps/web/app/page.tsx` → `apps/web/app/(room)/page.tsx`
- Move: `apps/web/app/w/**` → `apps/web/app/(room)/w/**`
- Modify: `apps/web/test/page.test.tsx`、`apps/web/next.config.ts`
- Test: `apps/web/test/shareHub.test.ts`、`apps/web/test/ShareView.test.tsx`

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

`ShareView.test.tsx` 渲染一条条目，断言没有 textbox、没有 button 名称匹配发送/确认/编辑，链接指向 `/s/<token>/e/D-1`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/web/test/shareHub.test.ts apps/web/test/ShareView.test.tsx`

Expected: FAIL

- [ ] **Step 3: 实现**

`shareHub.ts` 用 `node:http`，按 spec 校验 URL 和 2 MiB / 10 秒上限。`next.config.ts` 的 `headers()` 给 `/s/:path*` 加上 spec D-9 的五个响应头。

根 layout 只留 html、字体、`globals.css`、`I18nProvider`。私有壳移到 `(room)/layout.tsx`。`page.test.tsx` 的 import 改为 `@/app/(room)/page`。

分享 layout：`export const dynamic = "force-dynamic"`，metadata `robots: { index: false, follow: false }`。hub 404 渲染 404；连接失败渲染 503。两种正文都不要包含工作区名以外的后端错误字符串。404 正文不含工作区名。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/web/test/shareHub.test.ts apps/web/test/ShareView.test.tsx apps/web/test/page.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/shareHub.ts apps/web/app apps/web/components/ShareView.tsx apps/web/test apps/web/next.config.ts
git commit -m "feat(web): render a read-only knowledge share page"
```

---

### Task 6: 桌面网关与 Compose 内部地址

**Files:**

- Modify: `apps/local/src/gateway.ts`、`apps/local/test/gateway.test.ts`
- Modify: `apps/local/src/runtime.ts`、`scripts/desktop/templates/web-parent.mjs`
- Modify: `docker-compose.yml`、`scripts/images/check-images.mjs`、`scripts/images/check-images.test.mjs`

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
- `Host` 不是网关 origin 时仍是 403。

`check-images` 断言 web 环境包含 `NEMA_HUB_INTERNAL_URL: http://hub:${NEMA_HUB_PORT:-4400}`，并且原有 `NEMA_HUB_URL` 断言不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run apps/local/test/gateway.test.ts && node --test scripts/images/check-images.test.mjs`

Expected: FAIL

- [ ] **Step 3: 实现**

`mappedTarget` 增加 spec 里的两条正则，返回 `{ target: web, ui: true, publicShare: true }`。`handle` 里 `publicShare` 跳过会话检查。非 GET/HEAD 在转发前 405。

`web-parent.mjs` 在 `import("./server.js")` 之前：

```js
process.on("message", (message) => {
  if (message && typeof message === "object" && message.type === "hub-url" && typeof message.url === "string") {
    process.env.NEMA_HUB_INTERNAL_URL = message.url;
  }
});
```

`runtime.ts` 在 hub 启动成功后发送 `{ type: "hub-url", url: hub.url }`。发送失败只记日志，不把 hub URL 写进日志以外的公开响应。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run apps/local/test/gateway.test.ts && node --test scripts/images/check-images.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/local/src/gateway.ts apps/local/src/runtime.ts apps/local/test/gateway.test.ts scripts/desktop/templates/web-parent.mjs docker-compose.yml scripts/images/check-images.mjs scripts/images/check-images.test.mjs
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
npx vitest run apps/hub/test/shares.test.ts apps/hub/test/uiApi.test.ts apps/local/test/migration.test.ts apps/local/test/gateway.test.ts apps/web/test/shareHub.test.ts apps/web/test/ShareView.test.tsx apps/web/test/ShareKnowledge.test.tsx apps/web/test/page.test.tsx
npm run lint -w apps/web
```

Expected: 全部 PASS。

- [ ] **Step 2: web 构建**

Run: `npm run build -w apps/web`

Expected: 构建成功。抽查生成的分享路由不依赖 `NEXT_PUBLIC_HUB_URL` 作为公开页的数据源。

- [ ] **Step 3: 不在本期的项保持未做**

确认 diff 里没有 users 表、分享密码、部分条目分享、图 HTML、桌面公网 Host 白名单。`ROADMAP.md` 的 P2-04 不是「已完成」。
