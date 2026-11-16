# 身份模型与成员提及（D11-A 的后续）

日期：2026-11-16。Issue：[Nema-Project/nema-room#163](https://github.com/Nema-Project/nema-room/issues/163)。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。前置设计：[2026-10-31 提及设计](2026-10-31-mentions-design.md) 的 §7 与 D11（当时选 A：等身份模型再做成员提及）。

**状态**：设计草案。下文的 D-1 到 D-9 全部**待定**，由维护者决定，实现不得自行选择。本文件不改生产代码，没有实施计划。

**设计所对照的 HEAD**：`f21843e830ab4e423731010339e05d09c6fd7280`（`main`，v0.2.6 发布记录合并之后）。标为「已核对」的行为是在这个 SHA 上读代码得到的。

**来源说明**：写本文件的会话没有权限读取 GitHub issue（`gh`、API 与网页抓取都被拒绝）。#163 的正文与评论没有逐字核对。本文的需求来自仓库内记录的同一组前置：[提及设计 §7 / D11](2026-10-31-mentions-design.md)、[v0.2.0 社区做法对照](../../reviews/2026-10-31-v0-2-0-community-practices.md) 与 ROADMAP 的 P2-04。「验收」一节在合并前必须与 #163 的验收条目逐条对照，见该节末尾。

## 如何服务 #45

#45 的判断标准：让人和 agent 能维护一份随项目演进、有证据支撑的共同理解。今天每条用户消息都只记 `role = 'user'`，知识条目的 `sourceMessages` 和 `quotes` 能指回一条消息，却指不回一个人。只要房间里有第二个人，「谁说的」「谁拍板的」就只能靠记忆。

本设计让「谁说的」成为可核对的记录：消息带作者 id，成员的加入与移除有审计行，移除不改写历史。这正是根回し（nemawashi）要留下的东西：谁参与了、谁提出了不同意见、决定前问过谁。

本设计**不**做这些事：不把 Nema Room 变成账号系统、聊天工具或任务派发器；不增加任何把服务暴露给第二台机器的路径（那是 D-5 以及另一份设计）；不把作者 id 当成决定的证据（`basis` 和 `confirmedBy` 的含义不变）；不让提及变成授权或通知。成员提及仍是「用户给 agent 的指针」，不是决定。

## 现状（已核对）

- **没有用户与成员表。** `apps/hub/src/db/migrations` 共 19 个迁移（`001_init.sql` 到 `019_knowledge_shares.sql`），没有 `users`、`members` 或 `workspace_members`。
- **消息只有角色。** `messages.role` 的约束是 `user`/`agent`/`system`/`report`（`008_reports.sql`）。`postUserMessage`（`apps/hub/src/messages.ts`）用 `insertMessage(t, workspaceId, "user", …)` 写入，不记录是谁。web 的 `MessageItem.tsx` 对 `role === "user"` 一律显示 `chat.you`。
- **其他「user」也是角色字面量，不是身份：**
  - `threads.opened_by` 只能是 `agent`/`user`/`grill`（`011_threads.sql`）。
  - 知识库提交信息的 `Author:` 只能是 `agent`/`user`/`system`（`packages/knowledge/src/commitMessage.ts`）。
  - `evidence_events.actor` 有 `check (actor = 'user')`（`012_source_evidence.sql`）。
  - 需求实现与开发包任务的 `confirmedBy` 是 `z.literal("user").nullable()`（`packages/shared/src/report.ts`、`packages/shared/src/entry.ts`）。AGENTS.md 规定只有用户能设它，自动路径和 agent 不能设、改或清除。
- **`uiAuth` 是闸门，不认人。** `AppDeps.uiAuth` 是一个可选的 Hono 中间件，`createApp` 在 `/api/*` 上挂它（`apps/hub/src/app.ts`）。唯一的实现是 `createGatewayUiAuth`（`apps/local/src/gateway.ts`）：用 `timingSafeEqual` 比对请求头 `x-nema-gateway-credential` 里的一份 256 位十六进制凭据，不对就 401。它只在桌面 `runtime.ts` 里装上。Compose 和开发模式的 hub 没有这道门。
- **桌面网关的会话不带身份。** `SessionManager`（`apps/local/src/session.ts`）在内存里存启动票据和会话 token。网关验证 `nema_session_<port>` cookie 后给 `/api/*` 注入网关凭据，不转发 cookie。所有会话共用同一份凭据，hub 分不出是哪个会话。网关只 `listen(port, "127.0.0.1")`。
- **Compose 只绑回环。** `docker-compose.yml` 把 hub 和 web 都发布在宿主机 `127.0.0.1`。web 可以按 `NEMA_WEB_BIND` 绑到局域网地址，但那只服务只读分享页（[分享设计](2026-11-04-readonly-knowledge-share-design.md) D-4），hub 不对外。
- **今天第二个人进不来。** 由上面三条可知：当前代码里没有任何路径能让第二个人以自己的身份使用 `/api`。这件事决定了本设计的分期，见 D-5。
- **提及的契约。** `MessageMention` 是 `entry`/`attachment`/`thread` 三支的 discriminated union（`packages/shared/src/mentions.ts`）。`PostMessageBody.mentions` 用 `MessageMentions` 解析（`apps/hub/src/uiApi.ts`）。所以旧 hub 收到未知的 `type` 会让整次发送 400，而不是丢掉这个字段。提及候选是 `GET /api/workspaces/:id/mention-context`（`apps/hub/src/mentionContext.ts`），返回 `entries`、`attachments`、`threads`，每组最多 8 行。没有成员组。
- **快照拒绝未知表和未知列。** `validateSnapshot`（`apps/hub/src/db/snapshot.ts`）对不在 `TABLE_COLUMNS` 里的表或列直接抛错。只有 `OPTIONAL_TABLES` 里的表可以缺席。
- **分享页不显示人。** 分享设计 D-7 规定公开页只显示 workspace 名称和条目，不显示账号或维护者。`toPublicSummary` / `toPublicEntry`（`apps/hub/src/shares.ts`）是显式白名单。

## 已考虑的做法

1. **推荐：分两期。** 第一期只建模型：`users`、`workspace_members`、成员审计、`messages.author_user_id`，以及一个固定的「本地用户」。`uiAuth` 改成能给出身份的接口，但每一条现有路径都解析成本地用户。成员提及的契约和渲染规则写好，但成员组只在 workspace 有两个及以上**在册**成员时才出现，因此第一期对单用户没有可见变化。第二期另起设计，提供第二个人进入的路径（D-5）。
2. **一次做完，包括多人登录。** 要同时设计登录、密码或 token 发放、会话、CSRF、局域网暴露，再加上 hostGuard 和网关 Host 检查的放宽。这正是 P2-04 说的「不得直接把当前单用户本地服务暴露为多人服务」。不采用。
3. **只加一张显示名表（D11 的 B）。** 2026-10-31 已经否决：名字谁都能写，不能授权、不能审计。不采用。

## 决定（全部待定）

每一项写出选项、分析和推荐。**状态均为待定**，等维护者决定。

### D-1 成员提及的语义

成员提及在 prompt 里表示什么？

- **A：「这条消息是对这个人说的」（addressed to）。** 接近 Slack、GitHub 的 `@人`。
  - 好处：用户熟悉这种写法。以后有了通知，也可以沿用同一条记录。
  - 代价：Nema 的对话是人对 agent。第一期没有通知，被点名的人不会知道。agent 拿到「面向 X」也做不了什么，最多在回复里称呼 X，或把待确认问题标成「需要 X 回答」。后一种做法会让 agent 在知识里写下「谁负责」，这是推断，必须标成 `inferred`。
  - 风险：用户以为对方已经收到通知。界面必须写明不会通知（第一期本来就没有通知）。
- **B：「引用这个人说过的话」（quoting）。** 提及是一个指向「X 在本 workspace 的发言」的指针，agent 据此区分「X 说的」和「当前用户说的」。
  - 好处：直接服务 #45 的「分清来源」，这也是有了作者 id 之后最有价值的用法。比如「按 @张三 上周说的那个约束来」，agent 可以去核对，而不是猜。
  - 代价：要定拉哪些消息、拉多少，以及隐私边界。这就是 D-2。引用别人的话不等于那个人同意了这次用法。prompt 必须写明：被引用者的发言是 `stated` 的来源，不是本次决定。
- **C：只做称呼，不赋予语义。** prompt 里只写「用户提到了成员 X（显示名）」，不拉消息，也不暗示对象。
  - 好处：最小，不会把 agent 引向错误的推断。
  - 代价：与在正文里直接写名字几乎没有区别，结构化记录的价值只剩「名字改了还能对上 id」。

**推荐：B，第一期按 D-2 的推荐只给指针、不展开发言。** 理由：#45 关心的是「谁说的、证据在哪」，而不是「通知谁」。B 是唯一让作者 id 进入 agent 推理的选项。A 在没有通知和旁观者的房间里，会让用户误以为点名有效果。若维护者认为 B 的隐私成本太高，退到 C，不要选 A。

**状态：待定。**

### D-2 成员提及是否把那个人的历史发言带进 prompt，隐私边界在哪里

- **A：不带。** prompt 只写 `成员 @显示名（usr_…）`，以及「需要此人的原话时，请用户引用具体消息」。和话题提及「只给锚点」的做法一致。
- **B：带此人在本 workspace 最近 N 条 `role = 'user'` 的消息。** 比如 N = 5，每条截到 1 KiB，合计 4 KiB，按时间倒序。只取 `author_user_id = 被提及者` 且未删除的消息。
- **C：带此人在当前话题（thread）里的消息。** 主聊天里提及时不带。

分析：

- 隐私：B 与 C 会把 X 的发言送给当前用户选择的模型和账户（多账户路由见 [multi-account routing](2026-10-31-multi-account-routing-design.md)）。X 没有同意过这一次外发。同一 workspace 的成员今天彼此都能看到全部聊天，所以这不是「越权读取」。但发给哪家模型是当前用户选的，不是 X 选的。
- 保密工作区：`confidential` 今天只禁止分享。成员发言外发不属于跨 workspace，不受它约束。如果采用 B 或 C，至少要保证只取**本 workspace** 的消息，绝不跨 workspace。
- 已移除成员（D-7）：B 与 C 要决定是否还拉已移除成员的旧发言。推荐不拉，只给「已移除的成员」一行。
- 准确性：B 拉「最近 N 条」时，取到的未必是用户想引用的那句。引用某条具体消息已经有现成的 `quoteMessageId` 通道，那条路径更准。

**推荐：A。** 第一期成员提及只是带 id 的指针，不扩大外发面。要原话时，用已有的引用消息功能，那会把**一条**具体消息完整送入 prompt（`# 本次消息引用的消息`），来源清楚。B 或 C 留到有真实用例时再定，届时要写明外发提示。

**状态：待定。**

### D-3 本地用户怎么起步

- **A：迁移里建一行固定的本地用户。** `id = 'usr_local'`，`display_name` 为空，界面上用 i18n 的「我 / Me / 自分」显示。迁移把每个现有 workspace 的 `workspace_members` 都插入这一行，角色 `owner`。
- **B：首次启动时生成随机 id。** `usr_` 加 `nanoid(16)`，显示名默认取操作系统用户名。
- **C：A 的 id 加上首次启动时让用户填写显示名。**

分析：

- 固定 id 让快照在两台机器之间搬家时不会冲突，也不用合并「两个本地用户」。代价是：如果将来要把两份快照合并成一个多人实例，两边的 `usr_local` 会撞在一起。合并本来就不支持（快照导入要求空目标），所以这不是今天的问题。
- 拿操作系统用户名当默认显示名，会把它写进快照，还可能进入 prompt（成员提及的 `text`）。这是一条新的个人信息外泄路径。分享页不显示人（分享设计 D-7），但 prompt 会显示。
- 首次启动问名字会让启动多一步，与 P1-10 缩短首屏等待的方向相反。

**推荐：A。** 显示名留空，由界面本地化显示。用户可以在设置里改名，改名后才有一个真实名字进入成员提及的 `text`。

**状态：待定。**

### D-4 旧消息与没有作者的消息怎么显示

`messages.author_user_id` 新增为可空列。`role = 'user'` 的旧行全部是 null。

- **A：保持 null，按「未记录作者」显示。** workspace 只有一个在册成员时，null 仍显示为今天的 `chat.you`，界面不变。有两个及以上成员时，null 显示为「未记录作者」（三语新键），不猜是谁。
- **B：迁移时把旧行回填成 `usr_local`。** 界面最简单，所有旧消息都显示「我」。
- **C：保持 null，永远显示 `chat.you`。**

分析：B 是推断，不是记录。Compose 宿主机或一台共享电脑上，过去的消息未必是同一个人写的。回填后「谁说的」就成了一个看似有据、其实没有出处的字段，正是 #45 的护栏禁止的：没有出处的推断不能当权威。C 在多人工作区里把别人的旧消息显示成「你」，是错的。

**推荐：A。** 迁移不回填。之后新写入的 `role = 'user'` 消息必须带作者：本期每条路径都是 `usr_local`，见「`uiAuth` 演进」。`agent`/`system`/`report` 行的作者永远是 null，用检查约束保证。

**状态：待定。**

### D-5 第二个人从哪里进来

第一期之后，第二个人用什么路径以自己的身份访问 `/api`？

- **A：本设计不定，另起设计。** 第一期只建模型，D-1 的成员组在单成员时不出现，所以没有可见功能。
- **B：Compose 增加按人发放的访问 token。** 管理员在 CLI 里为成员生成 token，浏览器把它当 Bearer 带上。代价：hub 仍只认回环 Host，第二个人也只能在宿主机上用浏览器，等于没有解决多人。
- **C：桌面网关绑到局域网，每人一张启动票据。** 代价：要放宽网关的 Host 检查和 hub 的暴露面，正好撞上 P2-04 的前置约束。

**推荐：A。** 本设计只交付「身份能被记录、能被审计」，不交付「多人能访问」。后者涉及暴露面，必须单独设计和审阅。验收里写明：第一期没有任何新的网络暴露。

**状态：待定。**

### D-6 角色

- **A：只有 `owner` 和 `member` 两种。** owner 能增删成员；member 和今天的用户一样，能做 `/api` 上的一切。
- **B：再加 `viewer`（只读）。** 那要求每条写路由都检查角色。今天 `/api` 不区分任何人，改动面很大。只读需求已经由分享链接覆盖。
- **C：只有一种成员，不分角色。** 谁能加人就成了问题。

**推荐：A。** 第一期唯一的 owner 是 `usr_local`。授权检查只加在成员管理接口上，其他路由不变。

**状态：待定。**

### D-7 移除成员之后，历史怎么办

- **A：软移除。** `workspace_members.removed_at` 与 `removed_by` 写入。`users` 行保留，消息的 `author_user_id` 不改。历史消息照常显示作者名，后面加「（已移除）」。旧消息里对此人的提及照常显示存下的 `text`，样式标成已移除，不改写正文和 `meta.mentions`。已移除成员不再出现在 `@` 候选里。新消息里提及此人，hub 回 400。重放和编辑时，旧消息上已有的提及保留（`keepMentionsFor` 的计数规则不变），prompt 里写「已移除的成员」，不给 id 之外的信息。
- **B：硬删除并匿名化。** 删 `users` 行，消息作者改成 null，提及的 `text` 改成「已删除的成员」。代价：改写了历史，违反 AGENTS.md「更正与撤回要保留历史和来源」；知识条目的 `sourceMessages` 指回的消息也说不清是谁写的了。
- **C：A 加上可选的「抹掉显示名」。** 保留 id 和审计，把 `display_name` 改成固定占位，用于有人要求删除个人信息的场景。

**推荐：A，C 作为后续单独的隐私操作。** 被移除的人以后再被加回来，就是同一行 `workspace_members`：清空 `removed_at`，再写一条审计。审计见下面的数据模型。

**状态：待定。**

### D-8 验收与证据记录要不要带上是哪个成员

`confirmedBy: "user"`、`evidence_events.actor = 'user'`、提交信息 `Author: user` 今天都是角色字面量。

- **A：本期不改。** 这三处仍记「用户」。要知道是哪个成员，从同一请求写入的成员审计或消息作者去查，不在知识文件里新增字段。
- **B：增加 `confirmedByUserId`，以及提交信息里的 `Author-Id:` 行。** 代价：知识格式变化需要兼容和恢复方案。旧 hub 的 `fromFile` 会丢掉未知的 frontmatter 键（`packages/knowledge/src/store.ts` 是逐字段映射），旧 hub 一旦重写这条条目，字段就没了。提交信息由 `parseCommitMessage` 严格解析，加行要先确认旧解析器能容忍。
- **C：把 `"user"` 字面量换成用户 id。** 破坏 AGENTS.md 规定的 `confirmedBy` 两种含义。不可取。

**推荐：A。** 第一期身份只进入数据库（消息作者、成员审计），不进入知识格式。等 D-5 让第二个人真的能进来，再单独设计 B，连同它的兼容方案一起。

**状态：待定。**

### D-9 显示名进入哪些地方

- prompt：成员提及的 `text`（如 `@张三`），以及 D-1 选 B 或 C 时的那一行说明。最近消息段要不要把 `[id] user:` 改成 `[id] user(张三):`？
- 快照：`users.display_name` 随快照导出。
- 分享页：不显示（保持分享设计 D-7）。

**推荐：** 最近消息段在第一期**不改**。单成员时加名字没有信息量，反而会让 prompt 前缀的字节变化影响缓存命中。workspace 有两个及以上在册成员时，才写成 `[id] user(显示名):`，没有作者写成 `[id] user(未记录作者):`。分享页和公开 JSON 继续不含任何用户字段，测试断言 `display_name`、`usr_` 不在公开响应里。

**状态：待定。**

## 数据模型

迁移编号在实现时取当时的下一个号（今天是 `020`）。如果 [knowledge tags](2026-11-16-knowledge-tags-design.md) 先合并，就顺延。

```sql
create table users (
  id text primary key,                       -- 'usr_local' 或 'usr_' || nanoid(16)
  display_name text,                         -- null = 界面用本地化的「我」；去首尾空白后 1–64 个字符
  created_at timestamptz not null default now(),
  check (id ~ '^usr_[A-Za-z0-9_-]{1,32}$'),
  check (display_name is null or char_length(display_name) between 1 and 64)
);

create table workspace_members (
  workspace_id text not null references workspaces(id) on delete cascade,
  user_id text not null references users(id),
  role text not null check (role in ('owner', 'member')),
  added_at timestamptz not null default now(),
  added_by text references users(id),        -- 迁移种入的本地用户为 null
  removed_at timestamptz,
  removed_by text references users(id),
  primary key (workspace_id, user_id),
  check ((removed_at is null) = (removed_by is null))
);
create index workspace_members_user on workspace_members (user_id);

-- 只追加。成员加入、移除、改角色、改名都写一行。
create table member_events (
  id text primary key,                       -- 'mev_' || nanoid(16)
  workspace_id text references workspaces(id) on delete cascade, -- 改名这类全局事件为 null
  user_id text not null references users(id),
  kind text not null check (kind in ('added', 'removed', 'role_changed', 'renamed')),
  actor_user_id text references users(id),   -- 迁移种入时为 null
  detail jsonb,                              -- 如 {"from":"member","to":"owner"}；不存 token、不存凭据
  created_at timestamptz not null default now()
);
create index member_events_workspace on member_events (workspace_id, created_at);

alter table messages add column author_user_id text references users(id);
alter table messages add constraint messages_author_role_check
  check (author_user_id is null or role = 'user');

insert into users (id) values ('usr_local') on conflict do nothing;
insert into workspace_members (workspace_id, user_id, role)
  select id, 'usr_local', 'owner' from workspaces
  on conflict do nothing;
insert into member_events (id, workspace_id, user_id, kind, actor_user_id)
  select 'mev_seed_' || id, id, 'usr_local', 'added', null from workspaces
  on conflict do nothing;
```

- `author_user_id` 不加 `not null`，见 D-4。不回填。
- 新建 workspace（`createWorkspace`）在同一事务里把当前请求的用户插入为 `owner`，并写一条 `added` 审计。
- 删除 workspace 沿用外键级联：`workspace_members`、`member_events` 跟着删。`users` 行不删，因为别的 workspace 的消息可能还指向它。
- 每条 `insert` 都是 `on conflict do nothing`，迁移可以重复跑。迁移种入的 `mev_seed_<workspace id>` 用 workspace id 拼出确定的主键，重复运行不会多出审计行。

## `uiAuth` 的演进：从闸门到身份

hub 不读 cookie，也不认浏览器会话，这一点不变。

```ts
// apps/hub/src/identity.ts（新）
export type Identity = { userId: string };
export type IdentityProvider = (c: Context) => Promise<Identity | null>; // null = 401
```

- `AppDeps.uiAuth` 换成 `AppDeps.identity?: IdentityProvider`。`createApp` 在 `/api/*` 上挂一个中间件：调用 provider，null 时 401，否则 `c.set("identity", …)`。
- **没有传 provider**（Compose、开发模式、测试）时，用 `localIdentity`：每个请求都解析成 `usr_local`。这和今天「没有 `uiAuth` 就不设门」完全等价，不增加也不减少访问面。界面上要说清：这个身份的意思是「本机唯一的使用者」，不是登录。
- **桌面网关**：`createGatewayIdentity(credential)` 保留今天的常量时间比对，通过后返回 `usr_local`。
- 网关凭据仍是每次运行生成一次、所有会话共用。第一期所有会话都是同一个本地用户，所以凭据仍然只映射到 `usr_local`。
- 不新增「由请求头声明用户 id」的通道。如果以后 D-5 需要一个会话对应一个用户，由网关在会话表里记录用户，并为每个用户签发不同的凭据，hub 按凭据查用户。不要让 hub 信任一个 `x-nema-user-id` 头。今天 Compose 的 hub 没有门，任何人都能伪造这样的头。
- `postUserMessage`、`editUserMessage`、新建话题和主聊天发送，都从 `c.get("identity")` 取作者写入 `author_user_id`。`/room`（agent，run token）、`/report`（report token）、系统消息不带作者。
- `editUserMessage` 只允许原作者编辑：`author_user_id` 不等于当前用户时回 403。作者为 null 的旧消息，当前用户是该 workspace 的 `owner` 时才能编辑。单用户时这和今天一样。

## 成员提及

### 契约

```ts
// packages/shared/src/mentions.ts
z.object({ type: z.literal("member"), id: z.string().regex(/^usr_[A-Za-z0-9_-]{1,32}$/), text: MentionText })
```

- 正文里的可读文本是 `@显示名`。显示名为空时用本地化的「我」，例如 `@我`。和其他提及一样，存下的 `text` 必须在正文里出现足够次数。
- hub 校验（`validateMentions`）：`id` 必须是本 workspace 的**在册**成员（`removed_at is null`），否则 400，消息不写入。
- 编辑和重放沿用 `keepMentionsFor` 与 `lockForSend`。重放比较按 `type`、`id`、`text`。

### `@` 菜单

- `mention-context` 增加 `members` 组：`{ id, displayName, role }`，只列 `removed_at is null` 的成员，每组最多 8 行，在 SQL 里按显示名做与其他组相同的子序列匹配。
- 菜单只在 workspace 有两个及以上在册成员时显示成员组。这沿用 2026-10-31 的「成员提及不以假身份充数」：只能选自己的成员组没有意义。
- 顺序：条目、附件、话题、成员。

### prompt

按 D-1、D-2 的推荐，在「本次提及的上下文」里每个成员一行：

```text
## 成员 @张三（usr_ab12…）
这是用户点名的项目成员。提及不是此人的发言，也不代表此人同意；需要此人的原话时，请用户引用具体消息。
```

已移除的成员写 `## 成员 @张三：已移除的成员`。不拉任何发言。

### 兼容

- 新 web 配旧 hub：带成员提及的发送会被 `MessageMentions` 拒绝，返回 400。单成员时成员组不出现，用户不会走到这一步。桌面和 Compose 都把 hub 与 web 一起发布。
- 旧 web 配新 hub：没有成员组，行为不变。

## 撤销与审计

- 移除成员：`POST /api/workspaces/:id/members/:userId/remove`，只有 owner 能调用。在同一事务里写 `removed_at`/`removed_by` 和一条 `removed` 审计。不能移除最后一个 owner，返回 409。
- 加入成员与改角色：只有 owner 能调用，各写一条审计。第一期没有第二个人能登录（D-5），这两个接口只在测试里用到第二个用户。是否在界面上露出，由 D-5 决定。
- 审计列表：`GET /api/workspaces/:id/members/events`，按时间倒序，只有成员能读。审计行不可修改、不可删除，没有对应的写接口。
- 移除之后，历史按 D-7 处理。知识条目、`sourceMessages`、`quotes` 一律不改。

## 快照与恢复

- `users`、`workspace_members`、`member_events` 加入 `TABLE_COLUMNS`，并放进 `OPTIONAL_TABLES`，这样旧快照仍能导入。导入旧快照之后，迁移的种入语句不会再跑（迁移已经执行过），所以导入流程要在插入表数据之后补一次同样的幂等种入：`usr_local` 和每个 workspace 的 owner 行。
- `messages` 的列表加入 `author_user_id`。`validateSnapshot` 检查：`author_user_id` 要么是 null，要么是快照里存在的 `users.id`，并且该行的 `role = 'user'`。
- 新快照导入旧版本会因为未知表或未知列被拒绝。这与当初加 `message_attachments` 时一样，回滚路径仍是「用旧版本导出的快照」。
- 回滚：迁移只新增表和一列可空列，旧 hub 读写 `messages` 时不认识这一列，也不会写它。降级之后，新写入的消息作者为 null，按 D-4 显示。

## 失败与隐私边界

- 不新增网络暴露：hostGuard、网关 Host 检查、绑定地址一律不变。
- 用户 id 和显示名不进入分享页，不进入日志的错误正文，不进入 `task.assign` 之外的任何外发。
- 成员提及不授予被提及者任何访问权，不发通知，不改变任何条目。
- 网关凭据仍然不发给浏览器。身份不来自请求头，只来自 hub 自己对凭据的解析。

## 文档

实现时再改，本 spec 先定：

- 三语 `docs/guide.*.md` 的数据与隐私一节：消息开始记录作者；单用户时界面不变；旧消息不回填作者；还没有多人登录。
- README 第 121 行附近（`README.md`、`README.en.md` 两份逐字节相同）的「no public multi-user authentication」在第一期之后仍然成立，不改。
- `docs/reference.zh-CN.md` 增加身份模型一节。
- ROADMAP 的 P2-04：第一期落地也不标完成，可以链接本 spec。

## 验收

以下是按本设计推出的验收条目。**审阅对照（2026-11-16，审阅者对照 #163 正文）**：issue 的四条验收——身份真正区分人且授权与撤销可验证、提及不泄露对方不该看到的内容、旧消息（无作者）照常显示、文档与 changelog 齐备——前三条分别由本节的迁移/双成员/移除审计条目、prompt 不带发言与分享页不含身份条目、作者为空不回填条目覆盖；第四条是实现阶段的义务，不属于 spec 本身。issue「要做的事」六项（身份模型、消息作者、认证给出身份、提及语义先定、菜单与投递、撤销与审计）在本文均有对应章节或 D 项。

- 迁移在一个有旧消息、旧 workspace 的库上运行后：存在 `usr_local`；每个 workspace 都有一行 `owner`；旧消息的 `author_user_id` 全部为 null；连续运行两次不报错，也不多出行。
- 新发的用户消息（主聊天、话题内、新建话题三个入口）都带 `author_user_id = 'usr_local'`。agent、system、report 消息为 null，检查约束拒绝其他组合。
- 桌面网关：凭据正确时 `/api` 请求得到 `usr_local`，凭据错误仍是 401。Compose 与测试在没有 provider 时得到 `usr_local`。没有任何请求头能改变解析出的用户。
- 单成员 workspace：`@` 菜单没有成员组；聊天里消息仍显示 `chat.you`；prompt 与今天逐字节相同（加一条快照测试）。
- 两个成员（测试中直接插入第二个用户）：菜单出现成员组；带成员提及的消息写入 `meta.mentions`；提及别的 workspace 的成员或已移除的成员时 400，消息不写入；prompt 出现成员行，不含此人的任何发言（D-2 选 A 时）。
- 移除成员：写入审计；历史消息的作者和提及原样保留，并标成已移除；新提及 400；不能移除最后一个 owner。
- 快照：含新表的快照能导入并保留作者；没有新表的旧快照能导入，导入后本地用户和 owner 行齐全；`author_user_id` 指向不存在的用户时快照被拒绝。
- 分享页的公开 JSON 与 HTML 不含 `usr_` 和显示名。
- 没有新的监听地址或 Host 放行（对 hostGuard 和网关 Host 的现有测试保持通过）。

## D 项汇总

| id | 问题 | 选项 | 推荐 | 状态 |
| --- | --- | --- | --- | --- |
| D-1 | 成员提及在 prompt 里的语义 | A 对此人说；B 引用此人的发言；C 只是称呼 | B（第一期只给指针，见 D-2）；不行就 C，不选 A | 待定 |
| D-2 | 提及是否带入此人的历史发言，以及隐私边界 | A 不带；B 带最近 N 条；C 只带本话题内的 | A，原话走现有的引用消息 | 待定 |
| D-3 | 本地用户怎么起步 | A 固定 `usr_local`，显示名留空；B 随机 id 加系统用户名；C A 加首次启动询问 | A | 待定 |
| D-4 | 旧消息与无作者消息怎么显示 | A null 显示为「未记录作者」（单成员仍是「你」）；B 回填本地用户；C 永远显示「你」 | A，不回填 | 待定 |
| D-5 | 第二个人从哪里进来 | A 另起设计；B Compose 按人发 token；C 桌面网关上局域网 | A，第一期不新增暴露 | 待定 |
| D-6 | 角色 | A owner/member；B 再加 viewer；C 不分角色 | A | 待定 |
| D-7 | 移除成员之后的历史与提及 | A 软移除，历史不改；B 硬删并匿名化；C A 加可选的抹名 | A，C 作为以后的隐私操作 | 待定 |
| D-8 | 验收与证据是否记录具体成员 | A 不改知识格式；B 加 `confirmedByUserId` 和提交信息行；C 把字面量换成 id | A | 待定 |
| D-9 | 显示名进入 prompt 的哪些地方 | 最近消息段是否加名字；快照；分享页 | 两个及以上成员时才在最近消息里加名字；分享页永不显示 | 待定 |

## 不在本期

第二个人的登录与访问路径（D-5）、通知、按角色限制写路由、viewer、知识格式中的成员字段（D-8 的 B）、`threads.opened_by` 的成员化、跨实例合并用户、把显示名放进分享页。
