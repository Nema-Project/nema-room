# 只读分享知识库（P2-04 第一期）

日期：2026-11-04。Issue：[Nema-Project/nema-room#165](https://github.com/Nema-Project/nema-room/issues/165)。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。

**状态**：设计。D-2、D-3、D-5 到 D-10 已按审阅修订。D-1 与 D-4 已由用户在 2026-11-11 确认。实现不得改这些选择。本文件不改生产代码。实施计划见 [plan](../plans/2026-11-04-readonly-knowledge-share.md)。

**设计所对照的 HEAD**：`1bb9389b66f086b0ad27879851b3a6a9cfcebda5`（`origin/main`）。标为「已核对」的行为是在这个 SHA 上读代码得到的。2026-11-10 复核时，main 上已有 v0.2.4 的桌面启动重叠，以及 [#219](https://github.com/Nema-Project/nema-room/pull/219) 的提及候选搜索。main 没有名为 v0.2.5 的发布记录。

## 如何服务 #45

判断标准见 #45：让人和 agent 能维护一份随项目演进、有证据支撑的共同理解。第一期分享的是已经整理进知识库的条目（标题、状态、正文、依据、引用摘录），不是聊天原文。拿到链接的人看到的是同一份知识，而不是一份另写的摘要。

本设计不把 Nema Room 变成多人协作、账号系统或讨论工具。没有用户表，没有登录，没有成员，不能在分享页发言或派任务。链接即权限，撤销即失效。

## 现状（已核对）

- 没有分享实现。`apps/hub/src` 与 `apps/web` 里没有公开知识链接。
- 知识在每个 workspace 自己的 Git 仓库里，`KnowledgeStore`（`packages/knowledge/src/store.ts`），路径是 `repoPath(dataDir, workspaceId)`（`apps/hub/src/workspaces.ts`）。
- 已登录 UI 用 `GET /api/workspaces/:id/entries` 与 `GET /api/workspaces/:id/entries/:eid`（`apps/hub/src/uiApi.ts`）。两条都先经 `sourceEvidenceEntries`。列表再收成 `sourceEvidenceSummary`（摘要加上 `freshness`、`reviewNeeded`、`unconfirmedSnapshot`）并带 `isNew`。单条保留条目本身和同一组来源证据。两条都经 `withReportPass`，从 `messages` 里 `role = 'report'` 的行补报告是否通过。这两条响应都不能原样公开。
- `hostGuard`（`apps/hub/src/app.ts`）只允许 `Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`。它防的是 DNS rebinding：恶意页把域名重新解析到 `127.0.0.1` 时，浏览器仍发送 `Host: evil.example:<port>`。Node 的 `fetch` 不允许调用方改 `Host`。它挂在 `/api/*`、`/room/*`、`/report` 与 `/report/*`，不是全局中间件，所以 `/share` 要单独再挂同一个函数。
- `uiAuth` 只在桌面网关下挂在 `/api/*` 上（`apps/local/src/gateway.ts` 的 `createGatewayUiAuth`）。它比对一份 256 位十六进制共享凭据，不认人。Compose 的 hub 没有这道门。`/room` 用任务 run token，`/report` 用 report token。
- `report_tokens`（`apps/hub/src/db/migrations/008_reports.sql`）只存 sha256。明文 token 不入库。快照导入拒绝未知表，因此 `report_tokens` 进不了快照（`apps/local/test/migration.test.ts`）。
- 桌面只有一个回环入口。网关要求会话 cookie（`nema_session_<port>`，`Path=/`，HttpOnly，SameSite=Strict），并自己再查一次 Host 必须是 `127.0.0.1:<gatewayPort>`。`/api/*` 才注入网关凭据。cookie 不会被转发给上游（`sanitizedHeaders` 丢掉 `cookie`）。`mappedTarget` 只放行 `/`、`/w/...`、`/w/.../t/...` 和少量静态文件。
- 桌面仍先拉起 web 进程，hub 端口仍是临时端口（`apps/local/src/runtime.ts` 里 `startHub({ port: 0 })`），web 进程启动时还不知道 hub 端口。v0.2.4 之后这不再是「等 web 的 HTTP 就绪，再启动 hub」：`spawnWeb` 之后，`httpReady` 与 `createLocalDb`、`startHub` 重叠，15 秒预算从数据库和 hub 这段结束才开始计。托管 web 的父进程仍是 `scripts/desktop/templates/web-parent.mjs`（`stdio` 含 `ipc`）。它今天只在 Next 开始服务之后向外发送 `{ type: "managed-web-ready", port }`，自己没有 `message` 监听。没有监听器时，已经派发的 `message` 不会被保留。
- 提及候选已经是服务端查询：`GET /api/workspaces/:id/mention-context`（`apps/hub/src/mentionContext.ts`）。`apps/web/lib/hub.ts` 的 `searchMentionContext` 只多了一个 `AbortSignal`。该路由在 `/api` 下：桌面仍走网关和 `uiAuth`，Compose 仍用 `hubUrl()` 跨源。公开页不调用它。这是 [#195](https://github.com/Nema-Project/nema-room/issues/195) / [#219](https://github.com/Nema-Project/nema-room/pull/219)，不是 [#163](https://github.com/Nema-Project/nema-room/issues/163) 的成员提及。
- Compose 把 hub、web 都只绑在宿主机 `127.0.0.1`（`docker-compose.yml`）。浏览器跨源直连 hub（`apps/web/lib/hub.ts` 的 `hubUrl()`）。web 容器里的 `127.0.0.1:4400` 不是 hub。hub 在容器内监听 `0.0.0.0`，`NEMA_HUB_PORT` 与发布端口相同，所以宿主机上的 Host 仍然是 `127.0.0.1:<port>`。
- `workspace.confidential` 今天只是侧栏标记。设置文案写明第一版没有跨项目功能，开关是预留（`apps/web/messages/en.json` 的 `settings.confidentialHelp`）。
- 根 layout（`apps/web/app/layout.tsx`）对所有页面注入 `window.__NEMA_HUB_URL__`、标题栏、更新横幅和 `ThreadWindowsProvider`。分享页如果挂在这棵树下，会把私有壳和 hub 地址送进公开 HTML。
- `Markdown` 不启用原始 HTML，图片只留下 alt，链接只保留 `http:`、`https:`、`mailto:`（`apps/web/components/Markdown.tsx`）。
- README 现在写的是没有公开多用户认证，团队访问还没有（`README.md` 与 `README.en.md` 第 121 行，两份英文逐字节相同）。

## 已考虑的做法

1. **推荐：公开页只在 web origin，hub 的分享接口仍只认回环 Host。** 访客打开 `{web origin}/s/<token>`。这个 origin 只在回环或局域网，见 D-4。Next 服务端用 `node:http` 请求 hub 的 `/share/<token>`，并把 `Host` 设为 `127.0.0.1:<hub 端口>`。`hostGuard` 一行不放宽。浏览器不连接 hub，也不持有 `uiAuth` 凭据。桌面网关把 `/s/...` 加入白名单且不要求会话。这是下面采用的做法。
2. **给 `/share` 单独放开 hostGuard，让浏览器直连 hub。** 公开链接就能打到 hub 端口。hub 一旦被发布到公网，分享接口和错误配置的其他路由暴露面绑在一起。DNS rebinding 的防护也会变成「这条前缀例外」。不采用。
3. **hub 再监听一个只提供分享的端口。** 多一个必须保持回环或被误发布的端口，HTML 还要在 hub 里重做一套。不采用。

不采用的原因都是同一个：第一期不得把现在这个单用户本地服务改成对公网开放的 hub。

## 决定

### D-1 分享粒度

用户已确认 2026-11-11。一条链接分享该 workspace **当前知识库的全部条目**。不做部分条目分享，也不按 kind 过滤。不存在「父条目公开、子条目未公开」。

### D-2 有效期与撤销

- 创建时可带 `expiresAt`（带时区的 ISO 时间），必须晚于创建时的数据库 `now()`。不带则一直有效，直到撤销。
- 不做「N 天后」的第二种存储。界面可以把「7 天」算成一个时间戳再提交。
- 撤销写 `revoked_at`。不删除行，这样主人还能看见曾经发出过链接。没有暂停、没有「保留链接但暂时打不开」的第三态。
- 取消保密、取消归档、把环境变量从关闭改回打开，都**不会**恢复已撤销的行。要再分享就新建一条。
- 每次公开读取都查库。不缓存「这份知识是否仍在分享」的结果，不用 CDN。

### D-3 不要密码

第一期是纯 capability URL。不加口令、不加口令错误计数。

### D-4 对外暴露

用户已确认 2026-11-11。分享页只允许内网或局域网访问。不支持公网，不做隧道，不做公网转发。

访客仍只打开 **web 的 origin**。分享 URL 是 `{web origin}/s/{token}`，由主人浏览器的 `location.origin` 拼出来，不写进 hub。主人若从 `127.0.0.1` 打开设置，复制出去的就是回环 URL，只能在那台机器上打开。hub 的宿主机端口保持 `127.0.0.1`，没有把 hub 改到局域网或公网的变量。浏览器不连接 hub。

`hostGuard` 只做最小放行：允许名单不增加地址，仍然只有 `127.0.0.1:<port>` 与 `localhost:<port>`，并且 `/share` 也走这道检查。用局域网地址、`Host: hub:4400` 或任何外部域名访问 `/share` 仍然 403。桌面网关的 Host 检查也不放宽，仍然只接受 `127.0.0.1:<gatewayPort>`。

来源看接受访客连接的那个 TCP 对端，不看转发头。判断前去掉 IPv6 zone id（`fe80::1%eth0` 按 `fe80::1`）。不解析域名。允许：

- IPv4：`127.0.0.0/8`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`169.254.0.0/16`。
- IPv6：`::1/128`、`fc00::/7`、`fe80::/10`。
- IPv4 映射地址 `::ffff:0:0/96` 先取出末 32 位，再按 IPv4 名单判断。`::ffff:8.8.8.8` 拒绝，`::ffff:10.0.0.1` 允许。

其余拒绝。其中包括 `0.0.0.0/8`、`100.64.0.0/10`（CGNAT）、多播、保留、广播、未指定地址 `::`、文档网段（`192.0.2.0/24`、`198.51.100.0/24`、`203.0.113.0/24`、`2001:db8::/32`）、全局单播，以及 6to4、Teredo、NAT64。

绑定：

- `NEMA_WEB_BIND` 默认 `127.0.0.1`，只决定 web 宿主机端口的 `host_ip`。hub 的宿主机端口不读它，仍然是 `127.0.0.1:${NEMA_HUB_PORT:-4400}:${NEMA_HUB_PORT:-4400}`。
- 值必须是上面名单里的一个具体地址，不带方括号、不带端口。拒绝 `0.0.0.0`、`::`、公网地址、域名和空字符串。启动检查 `assertWebBind` 失败时不把 Compose 拉起来。
- `docker-compose.yml` 的 web 端口用长写法：`host_ip: ${NEMA_WEB_BIND:-127.0.0.1}`，`published: ${NEMA_WEB_PORT:-3000}`，`target: 3000`。这样 IPv6 地址不必先加方括号。容器内 Next 仍听 `0.0.0.0:3000`（`scripts/images/web-entrypoint.sh` 把 `HOSTNAME` 设成 `0.0.0.0`）。那是容器自己的套接字，不是宿主机暴露。
- 桌面网关继续 `listen(port, "127.0.0.1")`（`apps/local/src/gateway.ts`）。本期不把桌面绑到局域网。桌面分享只在本机回环可用。

转发头：

- 不读取 `X-Forwarded-For`、`Forwarded`、`X-Real-IP`、`CF-Connecting-IP`、`True-Client-IP`、`X-Forwarded-Host` 的内容，也不用它们把来源改写成私网地址。
- 这些头出现任何一个就拒绝。局域网代理、隧道或伪造的 `X-Forwarded-For: 10.0.0.1` 都不能把公网来源变成允许。
- 不用 `NextRequest.ip`。Next 会用 `X-Forwarded-For` 填充它。

Docker 默认的 userland-proxy 会把 web 进程看到的对端换成桥网关。桥地址落在私网里，第二道判断会误放行。本期不在 web 前面加代理，包括这层代理、反向代理和隧道。把 `NEMA_WEB_BIND` 设成局域网地址之前，操作者必须在 Docker 守护进程关闭 userland-proxy，让 iptables 保留访客来源。仓库里的检查不能替守护进程关闭它。对端不在允许名单时，运行时仍然拒绝。

拒绝行为：在向 hub 发请求之前完成。不查分享表，不占 hub 的限流桶。HTTP 404，`Cache-Control: no-store`，正文与无效链接相同，不用单独的 403 文案，避免向公网扫描者确认路径或 token。包装层在 Next 处理 `/s` 与 `/s/` 之前读 `req.socket.remoteAddress`。`apps/web/lib/sharePeer.ts` 是纯函数。`web-parent.mjs` 与 `web-entrypoint.sh` 在加载 `server.js` 之前装上这层判断。

测试要覆盖：允许前缀各至少一个地址；`8.8.8.8`、`172.32.0.1`、`100.64.0.1`、`203.0.113.5`、`2001:db8::1`、`::ffff:8.8.8.8` 拒绝；`::ffff:192.168.0.5`、`fd00::1`、`fe80::1`、`::1`、`127.0.0.1` 通过；`fe80::1%eth0` 按链路本地通过。对端是 `10.1.2.3` 且带 `X-Forwarded-For` 仍拒绝。对端是 `203.0.113.5` 且头里写着 `10.0.0.5` 仍拒绝，不能按头放行。公网对端即使 token 有效也不调用 hub。桌面网关上，回环请求 `/s/...` 只要带了 `X-Forwarded-For` 就是 404，web 收到 0 次。`Host: 192.168.1.5:<port>` 与 `Host: hub:4400` 访问 hub 的 `/share` 都是 403。`assertWebBind` 接受 `127.0.0.1`、`192.168.1.10`、`fd00::10`，拒绝 `0.0.0.0`、`::`、`1.2.3.4`、`example.com`。`NEMA_WEB_BIND=192.168.1.10` 时解析后的 web `host_ip` 是该地址，hub 的发布地址仍是 `127.0.0.1`。

### D-5 限流

hub 进程内记忆，单进程，重启清空。不做成配置项。

- 总开关关闭时直接 404，不查库。开关是操作者配置，不是要隐藏的秘密。
- 形如合法 token 时先按哈希查库。查库结果要分开表示「没有这个哈希」和「哈希在，但已撤销、过期、归档或保密」。没有这个哈希：所有未命中共用一个桶，60 秒最多 600 次，超过返回 429。有这个哈希（不论是否已撤销、过期、归档、保密）：这个哈希自己一个桶，60 秒最多 120 次。两种结果的 HTTP 正文仍然相同，不透露是哪一种。
- 未命中的洪水不能把一条有效链接的桶打满，所以不能在查库之前用未命中桶拒绝请求。
- 合法 token 的形状检查失败（长度或字符不对）直接 404，不查库，不计入桶。
- 429 的正文是 `{ "error": "too many requests" }`，带 `Retry-After: 60`。日志不写 token，也不写哈希。

天花板：多实例不共享计数；本仓库的 hub 是单进程。要换成共享计数再另做。

### D-6 公开哪些字段，以及保密工作区

公开投影只有知识本身，并且每次都从 `KnowledgeStore` 读当前文件，不读 `messages`、`tasks`、附件、线程、插件、仓库、设置。

列表每条只有：`id`、`kind`、`title`、`status`、`businessDate`、`basis`、`confirmedAt`，加上存在时的 `priority`、`url`、`related`、`implementationStatus`（`reported` | `verified` | `mismatch`）、`diagramType`、`workpackage: { blockedOn, taskCount }`。

单条在列表字段之外再加上：`body`、`quotes: { text }[]`（去掉 `messageId`）、`sourceRefs: { sourceEntryId, locator?, quote? }[]`（去掉 `revision` 与 `snapshotHash`）、工作包任务的 `{ n, title, status }[]`。

这些字段不出现在公开 JSON 里，测试要断言它们的名字和播种的私有字符串都不在响应正文中：

- `sourceMessages`、`messageId`、聊天正文、任务、附件名
- `snapshotHash`、`revision`、`sourceSnapshot`、`resourceId`、来源快照的 `canonicalUrl` 与 excerpts
- `reportMessageId`、`commits`、`reportEvidence`、`repoId`、`sourceCommits`、`nodePaths`
- 工作包任务的 `files`、`repos`、`reportMessageId`
- workspace id、分享备注、token、哈希
- 历史、blame、旧版本、图的渲染 HTML、新鲜度、`withReportPass` 的结果

`quotes.text` 和 `sourceRefs.quote` 原样公开。它们是知识条目里的证据摘录，不是整段聊天。摘录里没有的聊天句子不得因为分享而出现。

图只公开 `diagramType` 和条目正文，不渲染 archify HTML。

**保密工作区不能分享。** `confidential = true` 时创建返回 409。把工作区改成保密或归档时，同一事务里把该工作区所有 `revoked_at is null` 的行写成已撤销。创建和这次更新必须先锁同一行 `workspaces`（`select ... for update`，与 `deleteWorkspace` 已用的锁相同）。插入分享行、更新工作区、撤销分享都在持有该锁的同一事务里完成，不能先读 `confidential` / `archived_at` 再在锁外插入。先提交的一方胜出：先插入的行会被这次更新撤销；更新先提交则创建返回 409，不插入。公开读取在撤销之外再检查一次：工作区保密、已归档，或行已撤销、已过期，都是同一种 404。这次检查不能代替上面的锁。取消保密或取消归档不会把这些行改回有效，包括在这个窗口里插进去、又被撤销的行。

这改变了 `confidential` 今天「只是预留标记」的行为。三语文案要改成：打开保密会立刻撤销已发出的分享链接，并且不能新建。它仍然不是操作系统隔离，也不是离线模式。

### D-7 页面上显示谁

公开页只显示 **workspace 名称** 和条目。不显示账号、维护者、备注、分享创建时间。备注只在主人的设置里可见。没有用户名可显示，也不要从 Git 提交作者里推断一个。

### D-8 token

- `randomBytes(32).toString("base64url")`，43 个字符，字符集 `[A-Za-z0-9_-]`。
- 库里只存 sha256 十六进制（64 位）。没有明文列。
- 明文只在创建响应里出现一次。列表接口不返回 token，也不返回哈希。
- 不进日志、错误正文、快照、快照校验允许的表。
- 一个工作区可以有多行。撤销一行不影响其他行。
- 分享 token 不是 `/api`、`/room`、`/report` 的凭据。桌面网关的 report 转发只接受 `Bearer` 加 64 位十六进制，base64url token 到不了 hub。`uiAuth` 不挂在 `/share` 上，分享读取也不接受网关凭据。

### D-9 会话 cookie 与页面隔离

分享路由不读 cookie，也不把 cookie 当成登录。

- 桌面网关对 `/s/...` 不要求会话，不注入网关凭据。`sanitizedHeaders` 已经丢掉 cookie，这条要保持，并加测试。
- 公开页不请求 `/api`、`/_nema`、`/room`、`/report`。组件不得 import `@/lib/hub`。
- 根 layout 不再挂标题栏、更新横幅、`ThreadWindowsProvider` 和 hub URL 脚本。这些移到 `app/(room)/layout.tsx`。分享页不在这个组里，因此 HTML 里没有 `window.__NEMA_HUB_URL__`。
- 响应头：`Cache-Control: no-store`、`X-Robots-Tag: noindex, nofollow`、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'none'`。`connect-src 'none'` 用来挡住页面脚本再去请求 hub 或 `/api`。不把 `/s/` 写进 `robots.txt`（爬虫读不到 noindex 时，robots 禁抓反而可能让外链被索引）。
- 第一期不改现有会话 cookie 的名字、Path 或 `__Host-` 前缀。网关已经不把 cookie 转给 Next，公开页自己也不读它。

### D-10 总开关

`NEMA_SHARES_ENABLED` 未设置或为 `1` 时允许分享。设为 `0` 时：创建返回 403，公开读取返回与无效链接相同的 404，已有行不删除。列表和撤销仍然可用，方便关掉之后把链接作废。桌面与 Compose 都读这个变量。测试通过 `createApp` 的依赖注入，不依赖进程环境。

变量必须真的到达 hub 进程。Compose 的 hub `environment` 写成 `NEMA_SHARES_ENABLED: ${NEMA_SHARES_ENABLED:-}`。仓库模板和 `renderComposeAsset` 生成的 Release `docker-compose.yml` 都保留这一行：操作者设成 `0` 时容器里是 `0`，未设置时不是 `0`。桌面 launcher 的 `childEnvironment`（`apps/local/src/runtime.ts`）在变量有定义时原样复制进 core，包括 `0`。`apps/desktop/lifecycle.cjs` 调用的 `ensureLocalRuntime` 用的就是这份过滤后的环境。同进程的 `startLocalRuntime` 读得到当前进程的变量，但不能代替这次复制。

## 数据

新迁移 `apps/hub/src/db/migrations/019_knowledge_shares.sql`：

```sql
create table knowledge_shares (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  token_hash text not null unique,
  note text,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index knowledge_shares_workspace on knowledge_shares (workspace_id);
```

`id` 是 `ks_` 加 `nanoid(16)`。`note` 去掉首尾空白后最长 200，空串存 null。

不把 `knowledge_shares` 加入 `TABLE_COLUMNS` 或 `OPTIONAL_TABLES`。未知表已经被 `validateSnapshot` 拒绝。补一条与 `report_tokens` 相同的测试，防止以后有人把它放进可导入表。旧库没有这张表时，迁移照常补上；没有分享行的工作区行为不变。

删除工作区沿用外键级联，不另写清理。

## 接口

### 主人，仍在 `/api` 下

经过现有的 `hostGuard`、CORS、可选 `uiAuth`、`requireJson`。桌面访客没有会话就到不了这里。

- `GET /api/workspaces/:id/shares`  
  返回 `{ shares: [{ id, note, expiresAt, revokedAt, createdAt }] }`，按 `created_at` 降序。不含 token 与哈希。
- `POST /api/workspaces/:id/shares`  
  正文 `{ note?: string, expiresAt?: string }`。成功 201：`{ id, token, note, expiresAt, createdAt }`。  
  保密 409 `{ error: "confidential workspace cannot be shared" }`。  
  归档 409 `{ error: "archived workspace cannot be shared" }`。  
  总开关关闭 403 `{ error: "sharing disabled" }`。  
  `expiresAt` 可以不带。带了但不是带时区的 ISO 时间，或不晚于数据库 `now()`：400。`note` 超长：400。
- `POST /api/workspaces/:id/shares/:shareId/revoke`  
  正文 `{}`。该工作区的行存在则 200，并保证 `revokedAt` 非空（重复撤销仍是 200）。别的工作区或不存在：404。

`PATCH /api/workspaces/:id` 在把 `confidential` 设为 true 或 `archived` 设为 true 时，先对 `workspaces` 行 `for update`，再与工作区更新同一事务撤销该工作区全部分享。`updateWorkspace` 已接受 `Db`，调用方把事务客户端传进去，不另写一条更新 SQL。

### hub 公开读取，只给 Next 服务端

`/share` 与 `/share/*` 只挂 `hostGuard`。不挂 `uiAuth`，不挂 CORS，不挂 `requireJson`。

- `GET /share/:token` → `{ workspaceName, entries: PublicSummary[] }`
- `GET /share/:token/entries/:eid` → `PublicEntry`
- 路由内部保留 workspace id，只把它交给 `repoPath(dataDir, workspaceId)`。公开 JSON 不包含这个 id。
- 只允许 GET 与 HEAD。其他方法 405，`Allow: GET, HEAD`。没有写入路由。
- token 形状不对、哈希不存在、已撤销、已过期、工作区保密或已归档、总开关关闭、条目 id 不存在：一律 404 `{ error: "not found" }`。不区分原因，正文也不含工作区名称。
- 有效 token 下的条目 id 形状不合法，同样 404，不先透露 token 有效。
- 以上响应都带 `Cache-Control: no-store`。

条目顺序与 `KnowledgeStore.listEntries()` 相同（按 kind，再按编号，不过滤状态）。`KnowledgeStore.withdraw()` 写入的状态值是 `dropped`；`packages/shared/src/entry.ts` 的 `KIND_STATUSES` 也只有 `dropped`，没有 `withdrawn`。状态为 `dropped` 的条目照样列出，状态字段可见。

### web 页面

- `GET /s/:token` 列表。
- `GET /s/:token/e/:eid` 单条。条目之间的链接用这个路径，不用 `/api`。
- 页面是服务端渲染。Markdown 只用现有 `Markdown`，不传 `onOpenEntry`（那会变成按钮并依赖私有导航）。正文里的 `[D-1]` 保持文字；同页列表已经能打开每条。
- 无效链接与 hub 404：HTTP 404，文案只说链接不可用，不出现工作区名称。
- hub 连不上、内部 URL 缺失或非法：HTTP 503，文案只说分享暂时不可用。
- `export const dynamic = "force-dynamic"`。

内部 URL 来自 `NEMA_HUB_INTERNAL_URL`，每次请求读取。

- 未设置时默认 `http://127.0.0.1:4400`。
- 只接受 `http`、没有用户信息、主机名是 `localhost`、`127.0.0.1`，或单个 DNS 标签 `^[a-z0-9-]{1,63}$`（Compose 的服务名 `hub` 可以，带点的公网主机名不可以）。端口必填或默认 4400，范围 1–65535。非法配置按 503，不发起请求。
- 用 `node:http` 连接该 URL，`Host` 固定为 `127.0.0.1:<URL 端口>`，路径只允许编码后的 `/share/<token>` 与 `/share/<token>/entries/<eid>`。不转发访客的 cookie、Authorization、Host。
- 响应体上限 2 MiB，超出按 503。超时 10 秒。

Compose 的 web 服务增加：

```yaml
NEMA_HUB_INTERNAL_URL: http://hub:${NEMA_HUB_PORT:-4400}
```

保留现有 `NEMA_HUB_URL`（那是浏览器用的地址）。`scripts/images/check-images.mjs` 现有断言继续成立，并增加对这一行的断言。

桌面：`web-parent.mjs` 在 `await import("./server.js")` 之前监听 IPC `{ type: "hub-url", url }`，写入 `process.env.NEMA_HUB_INTERNAL_URL`。`runtime.ts` 在已有的 `await webReady` 之后才 `webChild.send({ type: "hub-url", url: hub.url })`，只发一次。不要在 `startHub` 一返回就发：那时 `httpReady` 还可能在和 hub 启动重叠，子进程可能还没注册监听器。`webReady` 表示子进程已经在回环地址上接受 HTTP；监听器又写在 import 之前，所以此时发送不会落空。发送失败只记日志，不把 hub URL 写进公开响应。hub 尚未通知时，分享页 503。`hub.url` 已是回环地址，符合上面的 URL 规则。

开发模式（web 与 hub 都在宿主机）不设变量，默认 `http://127.0.0.1:4400` 即可。

### 桌面网关

`mappedTarget` 增加分享页，且只在路径完全匹配时视为 UI：

```text
^/s/[A-Za-z0-9_-]{43}/?$
^/s/[A-Za-z0-9_-]{43}/e/(R|D|T|Q|S|G|W)-[1-9]\d*/?$
```

匹配的 GET/HEAD 不检查会话，转发到 web，不注入网关凭据。其他方法 405。形状不对的 `/s/...` 保持今天的 404，并且不联系 web。`/api` 仍要会话。网关自己的 Host 检查不放宽。

## 主人界面

工作区设置抽屉增加「分享知识库」一节，放在保密开关下面。

- 列出已有分享：备注、创建时间、过期时间、已撤销。没有明文。
- 创建：可选备注、可选到期日。成功后只在这一次显示完整 URL（`location.origin + /s/ + token`）和复制按钮。离开或再次打开设置不再显示 token。
- 每一行有撤销。撤销后立刻从「有效」变成「已撤销」，公开页下一请求就是 404。
- 工作区已保密或已归档时，创建控件不可用，并说明原因。
- 总开关关闭时显示「分享已关闭」，不发创建请求。列表和撤销仍可用。检测方式：创建返回 403 时进入该状态；另一次打开设置时如果 GET 成功而 POST 被 403，也进入该状态。不新增探测接口。

三语 key 见 plan。公开页文案也进这三份 `messages`。公开页用现有 `I18nProvider`（不访问网络）。

## 文档

实现时改这些文字，本 spec 先定稿：

- `README.md` 与 `README.en.md` 第 121 行改成同一句英文：分享链接可以只读查看一个工作区的知识库；仍然没有公开的多用户认证，没有多设备同步、托管备份或团队账号。两份文件保持逐字节相同。`README.zh.md`、`README.ja.md` 表达同一事实。
- `docs/guide.{zh,en,ja}.md` 的数据与隐私一节写：如何创建、如何撤销、对方能看到知识条目（含摘录）、看不到聊天、任务、附件和设置；链接即权限，泄露链接等于泄露这份知识库；默认只在本机回环打得开；局域网只通过 `NEMA_WEB_BIND` 绑定 web，不支持公网、隧道和反向代理；hub 不公布；保密工作区不能分享，打开保密会撤销已有链接；`NEMA_SHARES_ENABLED=0` 关闭新建和公开读取。
- `docs/reference.zh-CN.md` 的 Host 一段补上：`/share` 同样只接受回环 Host；web 服务端用内部 URL 连接，并自己发送 `Host: 127.0.0.1:<port>`。不要写成 hostGuard 已对公网放行。
- `SECURITY.md` 的已知边界加一条：分享链接是 capability URL；持有链接即可读取该知识库的公开投影；撤销后的下一次请求必须失败。分享页只接受 D-4 的内网来源，不信任转发头，hub 不对局域网或公网发布。能绕过撤销、用分享页读到聊天或附件、借公开页把 `/api` 暴露到非回环 Host、或从公网来源读到分享页，才是漏洞。
- `changelog.d/readonly-knowledge-share.added.md`，一条中文 bullet。
- `ROADMAP.md` 的 P2-04 仍是「进行中」，直到验收证据落地。可以链接本 spec，不能标已完成。

## 验收

- 创建之后数据库没有明文 token，只有 sha256。
- 撤销、过期、归档、保密、删除工作区之后，下一次公开读取是 404，不需要重启。另一条未撤销的链接仍是 200。
- 创建与「改为保密或归档」叠在一起时，两者都结束后再把该标志改回去，公开读取仍是 404，且不留下 `revoked_at is null` 的分享行。hub 测试用的 PGlite 一次只跑一个事务，所以这条用同时发起的两个调用，加上对 `for update` 锁语句的断言；真正的语句重叠只在 PostgreSQL 的两个连接上发生。
- 公开响应的正文不含本 spec「不出现」清单里的字段和播种字符串。`POST/PUT/PATCH/DELETE /share/...` 为 405，且知识文件与分享行都不变化。
- `Host` 不是回环时，有效 token 也是 403。`Host: 192.168.1.5:<port>` 同样 403。`uiAuth` 缺失不阻止 `/share`，也不让分享 token 调用 `/api`。
- 公网对端、带转发头的请求、以及 `NEMA_WEB_BIND` 的非法值，按 D-4 的测试表拒绝。公网对端不产生 hub 请求。
- 桌面网关：无 cookie 的合法 `/s/<token>` 到达 web；无 cookie 的 `/api/workspaces` 仍是 401；cookie 没有被转发；错误形状不到达 web。
- 分享页 HTML 不含 `__NEMA_HUB_URL__`，含 `noindex`，并带 `connect-src 'none'`。
- 无效链接的 404 正文在「没有这个哈希」「已撤销」「已过期」「已保密」「已归档」五种情况下相同。
- 含 `knowledge_shares` 的快照被拒绝。没有这张表的旧库迁移后，现有工作区仍能打开。
- `README.md` 与 `README.en.md` 逐字节相同。

## 不在本期

账号、登录、成员表、`messages.author_user_id`、按人授权、成员提及（#163）、分享密码、部分条目分享、图的 HTML、历史与 blame、桌面公网 Host 白名单、桌面局域网绑定、隧道、反向代理、信任 `X-Forwarded-For`、跨进程限流、把会话 cookie 改成 `__Host-`。
