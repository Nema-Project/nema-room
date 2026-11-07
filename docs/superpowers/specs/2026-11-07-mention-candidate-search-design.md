# 提及候选的服务端搜索

- **Issue：** [#195](https://github.com/Nema-Project/nema-room/issues/195)。来源是 [v0.2.0 对照报告](../../reviews/2026-10-31-v0-2-0-community-practices.md) 第 2.4 节第 2 条和缺口 J。
- **服务对象：** [#45](https://github.com/Nema-Project/nema-room/issues/45)。人在一句话里点名一条知识、一份已发送的文件或一个话题时，菜单要能找到那一项，包括它不在最近更新的 500 条里的时候。找到的仍是用户指定的指针，不是决定，也不产生 `verified`。
- **核对基线：** `origin/main` `9b8a4287fdde3f3d52721ee43ede19c61b1e0772`（2026-11-07 与 `origin/main` 一致）。开放 PR 只有 [#212](https://github.com/Nema-Project/nema-room/pull/212)（只读分享规格），本设计不改它碰过的文件。
- **版本：** 本轮按 v0.2.4 设计。仓库没有名为 `v0.2.4` 的 milestone（含已关闭的），本设计不创建 milestone，也不改 [#195](https://github.com/Nema-Project/nema-room/issues/195) 现有的 `v0.3.x` milestone。
- **本文件只定行为。** 不包含实现。实现要等这份规格被验收。

## 范围

已批准的最小范围：

- 条目、已发送附件、话题超过现有候选池时，菜单里的查询仍能找到目标。
- 服务端搜索、`@` 菜单接入、大工作区回归。
- 不附带 tag、成员提及、话题或附件的新精确 id 写法。

不在本轮：

- 把 `MENTION_POOL` 从 500 调大，或把 `MENTION_LIMITS.attachmentCandidates` 从 50 调大，当作修复。
- 菜单里的「下一页」。
- `pg_trgm`、全文检索、分词、新索引、新迁移。
- 新的用户可见文案。现有 `mention.looking`、`mention.lookupFailed`、`mention.noMatch`、`mention.emptyEntries`、`mention.emptyAttachments` 够用。
- 发送、编辑、投递、prompt 拼装。那些仍按 [2026-10-31 提及设计](2026-10-31-mentions-design.md) 校验本 workspace 的 id。
- P2-04 的身份模型。工作区隔离是「这条查询只读这一个 workspace」，不是新的多人授权。

## 来源

对照的是菜单怎么在一大堆对象里找，不是把 Nema 做成代码编辑器。

| 做法 | 来源 | 本设计取什么 |
| --- | --- | --- |
| 输入查询后由服务端在调用者有权看见的集合里搜，并限制每页条数；超时用 `incomplete_results` 说明这页不是全集 | [GitHub Search API：Search issues and pull requests](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests)（每页最多 100）；同页「Timeouts and incomplete results」 | 查询在持有数据的 hub 上执行，响应有上限。菜单不拉全集 |
| 指派建议带 `query`，按 login 或显示名搜，而不是先拉完整名单 | [GitHub GraphQL `Assignable.suggestedActors`](https://docs.github.com/en/graphql/reference/issues) | 候选接口继续收 `q`，匹配发生在服务端 |
| 输入 `@` 后出现匹配项；已有的 `@ENG-123` 这种精确 id 继续可用 | [Linear 编辑器](https://linear.app/docs/editor)、[2023-08-30 更新说明](https://linear.app/changelog/2023-08-30-mentions) | 保留条目 id 的精确优先。不给话题和附件新造一套 id 语法 |
| `@` 后面继续打字，菜单给的是匹配建议，不是整棵树 | [Cursor：Prompting agents](https://cursor.com/docs/agent/prompting) | 菜单仍最多每组 8 行。数据在 hub，所以搜索放在 hub，不在浏览器里扫一份池 |
| `ILIKE` 把 `%` 和 `_` 当通配符；大小写按数据库 locale | [PostgreSQL 模式匹配](https://www.postgresql.org/docs/current/functions-matching.html) | 用 `strpos(lower(列), lower(查询))`，`%` 和 `_` 是字面量 |
| `pg_trgm` 按连续三个字符建 trigram，并且字符是否算字母取决于 locale | [PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html) | 不用。一两个汉字是正常查询，trigram 对这么短的串帮助不大，locale 差异也会让桌面 PGlite 和 Compose 的 PostgreSQL 结果不一致 |

`users.list` 先拉整份名单再在客户端筛（[Slack `users.list`](https://docs.slack.dev/reference/methods/users.list)）是现在这个 500 条池的形状。本设计不沿用。

## 现状（`9b8a4287fd`）

路由仍是 `GET /api/workspaces/:id/mention-context?q=`，挂在 `apps/hub/src/app.ts` 的 `/api` 上。装了 `uiAuth` 时它和别的 `/api/*` 一样先过网关凭据（`apps/local/src/gateway.ts` 的 `createGatewayUiAuth`）。没装时与今天的 hub 相同，没有第二套登录。

`apps/hub/src/mentionContext.ts`：

- `MENTION_POOL = 500`。条目按 `updated_at desc, entry_id desc` 先取 500，话题按最近活动先取 500，再在内存里用 `fuzzyScore` 排序，每组留下 `MENTION_LIMITS.menuPerGroup`（8）。
- 附件另有一顶帽子：`MENTION_LIMITS.attachmentCandidates`（50）。`truncated` 只表示附件超过这 50，不表示条目或话题被 500 截掉。
- 空查询不返回全量，只返回上述池子里的最近一项，再切到 8 行。
- 查询在去空白前超过 200 字返回 400。workspace 不存在 404。已归档仍可查。不读 daemon。响应没有条目正文和附件字节。
- 返回前对附件池做磁盘 `stat`，文件没了就标 `missing` 并剔除。

`apps/web/components/Composer.tsx` 已经在查询变化后等 150ms 再请求，同一查询 30 秒内复用。清理 effect 时用 `live` 丢掉过期响应，但没有 `AbortController`。缓存键只有去掉空白后的查询，没有 workspace id。`apps/web/lib/hub.ts` 的 `request` 不接收 `signal`。

`apps/web/lib/mentions.ts` 的 `groupCandidates` 再用 `fuzzyScore` 滤一次、排一次。所以 hub 没放进池子的行，菜单永远看不到。`fuzzyScore` 是子序列：`发流` 能中 `发布流程`。它只被 hub 和这份 web 代码调用。

`truncated` 没有被菜单读。三语文案不必为它改。

[#195](https://github.com/Nema-Project/nema-room/issues/195) 写的「开工前先在大工作区上测现有上限」所提的 P2-02 规模基线仍是路线图上的待办，仓库里没有可复用的计时基线。回归用测试库插入行，不新造基线。

## 三种做法

### A. 在本 workspace 里做有上限的子串搜索（推荐）

非空查询在 SQL 里按 workspace 过滤，用字面子串匹配，按下面的档排序，每组最多回到菜单 8 行。空查询仍是最近 8 行，不再先取 500 或 50。

代价：子序列命中消失。`发流` 不再命中 `发布流程`。连续打出的标题片段和条目 id 仍命中，这是超过 500 条时用户实际会打的东西。

### B. 给菜单加分页

`q` 不变，用 cursor 把 500 的池一页页往后翻。菜单今天没有「更多」行，验收要的是按字找到第 501 条，不是让人翻页。就算加上分页，搜索还是要做。本轮不做分页。

### C. 去掉上限，把整个 workspace 载入内存再跑 `fuzzyScore`

这和把 500 调到一个更大的常数是同一类做法：每次按键的读取量跟着 workspace 涨，响应体也会大。已明确不采用。`fuzzyScore` 继续留在 `packages/shared`，测试仍覆盖它；搜索路径不再调用它。

## 设计

### 接口

路径、查询名、成功体不变：

```json
{ "status": "ok", "entries": [], "attachments": [], "threads": [], "truncated": false }
```

行的字段不变。条目是 `id`、`kind`、`title`、`status`。附件是 `id`、`name`、`kind`、`size`、`messageId`、`createdAt`。话题是 `id`、`title`、`lastReplyAt`。没有正文、字节、hash、别的 workspace 的 id。

`q` 仍在 `trim` 之前量长度，超过 200 返回 400，正文仍是 `q is longer than 200 characters`。正文含 NUL（`\0`，包括 `q=%00`）时，在当作 SQL 参数之前返回 400，正文是 `q contains a NUL character`。不把 NUL 交给 `lower($2)`，因为 PostgreSQL 的 text 不接受 NUL，否则会变成 500。`trim` 不删 NUL。`trim` 之后为空，包括只有空白，走空查询。

`truncated` 改成：任意一组在菜单上限之外还有匹配，则为 `true`。条目和话题以多出来的那一行（`LIMIT 9` 的第 9 行）为准。附件以多出来的探测行（第 17 行）为准，或者剔除缺失文件后仍多于 8 个。它不再表示「附件超过 50」。菜单仍不显示这个字段。旧的「50 个附件不 truncated、51 个 truncated」测试改成按新含义断言。

错误不变。未知 workspace 404 `workspace not found`。装了 `uiAuth` 时凭据不对仍是现有的 401，本路由不单独处理。数据库失败走现有的未捕获错误，菜单用现有的 `mention.lookupFailed`。空匹配是 200 和三个空数组，不是 404。

### 权限与 workspace 隔离

不新增身份、角色或分享范围。

每条 SQL 都把路径里的 workspace id 当作参数，写在 `workspace_id = $1`。先 `getWorkspace`，不存在就 404，不继续查。话题只从 `threads.workspace_id = $1` 出发，消息只按这些话题的 `thread_id` 连接。附件只取 `workspace_id = $1` 且 `status = 'attached'` 且 `message_id is not null`。磁盘 `stat` 只用这个 workspace 的附件目录。

因此：A 的查询不会返回 B 里同名的条目、附件或话题；只存在于 B 的标题在 A 里是空结果。测试要各插一行来钉住这两点。

桌面网关的 `uiAuth` 仍只证明调用方持有本机网关凭据。它不按人区分 workspace。那是 P2-04，不是本轮。

### 匹配、排序、上限

查询参数用 `$2`，不拼进 SQL。匹配是 `strpos(lower(列), lower($2)) > 0`。不用 `LIKE` / `ILIKE`，所以 `%` 和 `_` 不是通配符。`lower` 覆盖 ASCII 大小写；汉字没有大小写，原样匹配。PostgreSQL 的 `strpos` 按字符而不是字节，所以中文和增补平面字符不会被从中间切开。

搜索列：

- 条目：`entry_id` 与 `title` 都参与子串。`lower(entry_id) = lower($2)` 是单独的第一档。
- 附件：只搜 `name`。不把附件 id 当作精确语法。
- 话题：只搜 `title`。不把话题 id 当作精确语法。

非空查询的排序，档位靠前的整档在前：

1. 条目 id 与查询完全相等（忽略大小写）。附件和话题没有这一档。
2. 查询是搜索列的前缀（`strpos` 等于 1）。条目的 id 前缀和标题前缀同一档。
3. 其余子串命中。

同一档内沿用现在的时间顺序：条目 `updated_at desc, entry_id desc`；附件 `created_at desc, id desc`；话题 `coalesce(最后一条消息的 created_at, threads.created_at) desc, id desc`。

每组返回给菜单的行最多 8。条目和话题用 `LIMIT 9`：第 9 行只用来把 `truncated` 设为 true，不返回。附件取 `menuPerGroup * 2 + 1`（17）行。第 17 行不返回，也不做磁盘检查；它存在则 `truncated` 为 true。前 16 行做 `stat`，缺文件的剔除后若仍多于 8 个，`truncated` 也为 true，只返回仍存在的前 8 个。不为了补满 8 行再查第二页。缺文件仍标 `missing`，规则与现在相同。

空查询不加子串条件。条目和话题按上面的时间顺序 `LIMIT 9`，返回 8，第 9 行只贡献 `truncated`。附件的空查询同样先取 17 行，第 17 行只贡献 `truncated`。不再读取 500 或 50 作为中间池。

子序列不再算命中。`发布` 命中 `发布流程` 和 `版本发布`。`发流` 不命中 `发布流程`。`D-12` 与 `d-12` 都把 id 为 `D-12` 的条目放在该组第一。

`MENTION_LIMITS.menuPerGroup` 仍是 8。`MENTION_LIMITS.attachmentCandidates` 仍是 50，共享测试继续锁这个数，但搜索不再用它当窗口。`MENTION_POOL` 从搜索路径删除。

### 菜单、debounce、过期响应

`searchMentionContext(workspaceId, q, signal?)` 把 `AbortSignal` 传给这一次 `fetch`。现有测试断言两个参数的地方改为接受这个可选的第三个参数。

Composer 保持 150ms debounce 和 30 秒缓存。缓存键是 workspace id 加去掉空白后的查询。切换 workspace 后不得复用上一个 workspace 的结果。

查询或 workspace 变化时 abort 上一次请求。响应写回菜单或写入缓存之前，workspace id 和查询必须仍是这次打开的菜单的那一对。过期响应不得覆盖较新的结果，不得刷新该缓存项的时间，也不得在换了 workspace 之后画出来。没有命中缓存时，清空上一次的 `context`，菜单行和 Enter 选择都不得用它，直到这次结果写入；这段时间菜单用现有的 `mention.looking`。缓存命中则立刻用这份属于当前 workspace 和查询的结果。失败只在这次请求仍是当前请求时把状态设为 `failed`，并清空菜单数据。发送和打字不受影响，与现在相同。

`groupCandidates` 不再调用 `fuzzyScore`，也不再按查询丢掉 hub 已经返回的行。它保持 hub 的顺序，映射菜单行，并再次切到 8，作为防御。精确 id 优先和「导出只留下 R-3」改由 hub 测试负责。web 测试改为：给定 hub 的顺序就保持该顺序；多给的行仍被切到 8；行上的 `text` 不变。

不改三份 `messages/*.json`。

### 性能边界

一次 debounced 搜索最多三条带参数且带 `LIMIT` 的候选查询。另外，每次请求还执行一条按 id 的 workspace 检查；每个未通过磁盘检查的附件再执行一条 `missing` 标记更新。附件候选查询最多取 17 行，其中最多 16 行做磁盘检查。响应每组最多 8 行，和现在菜单能画的一样大。空查询不再把 500 行读进 hub 进程。没有 `(workspace_id, updated_at)` 索引时，数据库仍可能先看到该 workspace 的行再取前几名。

没有新扩展、新索引、新迁移。过滤是这个 workspace 上的扫描。`entry_index` 的主键是 `(workspace_id, entry_id)`，没有 `(workspace_id, updated_at)`。扫描变慢时，以后的升级是给这个 workspace 加匹配用的索引，不是把行数上限调大。本轮不给毫秒数：P2-02 没有基线，「不比现在慢」落在相同的 debounce、相同的菜单行数和更小的读取上限上，而不是一个新的计时门槛。

## 回归

实现时用临时库和假数据，不调用模型，不联网。在现有 `apps/hub/test/mentionContext.test.ts` 上加：

- 501 条条目，最旧的那条有独特标题。查询该标题能返回它。另一个 workspace 里的同名条目不出现。只存在于另一个 workspace 的标题在这边是空的 `entries`。
- 501 个话题，同样测最旧的独特标题和另一个 workspace。
- 51 个已发送附件，最旧的独特文件名能被找到。staged、deleted、missing、别的 workspace 的文件仍不出现。
- `d-12` 把 `D-12` 排在条目前面，即使另一条的标题以 `d-12` 开头。
- `发布` 命中 `发布流程` 和 `版本发布`；`发流` 不命中 `发布流程`。
- 查询 `%` 不匹配所有标题。查询 `_` 同理。
- 9 条命中时 `truncated` 为 true 且只返回 8 条。8 条命中时为 false。空查询超过 8 条时为 true。
- 已有的 400、404、已归档仍 200、不调用 daemon、响应不含正文和字节，保持。含 NUL 的 `q`（包括百分号编码的 `%00`）返回 400，正文是 `q contains a NUL character`。

web：

- `apps/web/test/mentions.test.ts` 按上一节改 `groupCandidates`。
- `apps/web/test/Composer.test.tsx` 增加：较新的查询先返回、较慢的旧查询后返回时，菜单保持较新的查询结果，旧响应也不改写这份缓存；查询还没返回时，Enter 不会选中上一次的行；workspace id 不同的缓存不复用。debounce 仍是 150ms，现有「输入发布后请求 `w1`」的断言保持，并允许第三个 `signal` 参数。

实现 PR 还要改 [技术参考](../../reference.zh-CN.md) 里「`@` 提及」的候选那一段，使它描述搜索而不是 500/50 的池；并加一条 `changelog.d` 片段。用法没有新的安装步骤，README 和 guide 不改。本设计 PR 不改这些文件，因为行为还没落地。

## 兼容

同一响应形状。旧 web 把 hub 的结果再滤一次：hub 只返回子串命中时，旧的 `fuzzyScore` 不会丢掉这些行，因为连续子串一定是子序列。旧 web 配新 hub 时，超过 500 的目标也能出现。新 web 配旧 hub 时，菜单仍只看见旧 hub 的 500 条池；桌面安装包和 Compose 一起发 hub 与 web，不为此加探测字段。

不改 `messages.meta`，不加迁移。回滚就是回到按池子截断的菜单。已经发出的提及不受影响。

## 待决定的事项

无。

上面把这些已经定死，不再另开 D 项：子串而不是子序列、每组 8 行而不是分页、附件只搜文件名、话题只搜标题、不新增精确 id 语法、不引入 `pg_trgm` 或索引、不设毫秒门槛、不改文案、不改 [#195](https://github.com/Nema-Project/nema-room/issues/195) 的 milestone。
