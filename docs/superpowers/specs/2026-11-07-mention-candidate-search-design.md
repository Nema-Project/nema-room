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
- `pg_trgm`、全文检索、分词，或为这次搜索加匹配索引。线性子序列若被选中，会多一次只放函数的迁移；那是下面 D-1 的代价，本文件不先做。
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
| `ILIKE` 把 `%` 和 `_` 当通配符；大小写按数据库 locale。`~` 把参数当正则 | [PostgreSQL 模式匹配](https://www.postgresql.org/docs/current/functions-matching.html) | 字面量用 `strpos`，或把每个码点转义后再交给 `~`。不把用户输入拼进 SQL |
| `pg_trgm` 按连续三个字符建 trigram，并且字符是否算字母取决于 locale | [PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html) | 不用它代替子序列。`发流` 和 `发布流程` 可以没有共同 trigram |

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

[#195](https://github.com/Nema-Project/nema-room/issues/195) 要求开工前先测大工作区上现有上限的实际影响。P2-02 仍是路线图上的待办，这次测量不把它标成完成。合成数据、环境和命令记在 [同日的实验记录](2026-11-07-mention-candidate-search-benchmark.md)。

## 现有匹配，不能静默换成子串

`fuzzyScore`（`packages/shared/src/mentions.ts`）在忽略大小写之后按码点比较。档位从高到低是：最后一个 `/` 段的前缀、任意一段的前缀、按顺序出现的子序列。同一档里更短的字符串排前面。条目的比较文本是 `id + " " + title`，所以标题前缀通常落在子序列档，而不是前缀档；`notes/发布/log` 这种路径会因为段前缀排到更前。精确 id 由调用方另放在所有档之前。空查询保持传入顺序，也就是 SQL 的最近活动顺序。

因此 `发流` 命中 `发布流程`，不命中 `版本发布`。`abc` 命中 `a.b*c`。把匹配改成连续子串会让这些查询失去现在的结果。上一稿把这件事写成已定结论，那个写法撤回。

子序列可以在数据库里做完再只把菜单行送回进程，不必把整个 workspace 读进 hub：

| 做法 | 谓词 | 排序 | 进程收到的行 | 本次合成数据上的结果 |
| --- | --- | --- | --- | --- |
| 子串 | `strpos(lower(列), lower($2)) > 0`。`%` 和 `_` 是字面量 | 精确 id，然后列前缀，然后时间 | 最多 9 或 17 | `发流`、`甲流乙`、`abc` 对 `a.b*c` 都消失。前 8 名经常和全表 `fuzzyScore` 不同 |
| 子序列正则 | 每个码点转义后用 `.*` 连接，整段模式作为参数交给 `~`。不把查询拼进 SQL 文本 | 在 SQL 里复现上面的档、更短优先、时间作平局 | 最多 9 或 17 | 本次 BMP 标题上，三组的前 8 名都和全表 `fuzzyScore` 相同，包括池外的 `甲发中流乙` |
| 子序列线性 | `strpos` 从上次命中之后找下一个字符。安全的形状是一个 immutable 函数，字符只走参数 | 与正则相同 | 最多 9 或 17 | 同样找到池外目标，前 8 名同样一致。函数要一次迁移 |

三条都不把 workspace 载入 hub。分页仍不做：菜单没有「更多」行。`pg_trgm` 不做：它不是这个子序列。把全表读进进程再打分也不做。

大小写和 Unicode 没有被这三条同时保留。JS 的 `toLowerCase("İ")` 是 `i` 加组合点，这次 PostgreSQL 17.11、`en_US.utf8` 的 `lower("İ")` 是 ASCII `i`。查询 `İ`、标题 `İstanbul`：JS 命中，SQL `lower` 两侧的线性函数也命中，用 JS 折叠去配 SQL `lower(列)` 的正则不命中。查询 `İ`、标题 `i`：JS 不命中，线性函数命中。`ß` 在两边都不再展开成 `ss`。汉字、emoji `😀`、以及标题里的换行（`发` 与 `流` 之间）这次正则和线性都与 JS 一致。这些是探针，不是「所有 Unicode 都等价」的证明。

## 设计

### 接口

路径、查询名、成功体不变：

```json
{ "status": "ok", "entries": [], "attachments": [], "threads": [], "truncated": false }
```

行的字段不变。条目是 `id`、`kind`、`title`、`status`。附件是 `id`、`name`、`kind`、`size`、`messageId`、`createdAt`。话题是 `id`、`title`、`lastReplyAt`。没有正文、字节、hash、别的 workspace 的 id。

`q` 仍在 `trim` 之前量长度，超过 200 返回 400，正文仍是 `q is longer than 200 characters`。正文含 NUL（`\0`，包括 `q=%00`）时，在当作 SQL 参数之前返回 400，正文是 `q contains a NUL character`。不把 NUL 交给 `lower($2)`，因为 PostgreSQL 的 text 不接受 NUL，否则会变成 500。`trim` 不删 NUL。`trim` 之后为空，包括只有空白，走空查询。

`truncated` 不再表示「附件超过 50」。它表示：按选定的排序，菜单这 8 行后面还有没交给用户的匹配，包括附件因为 `stat` 预算停住、后面的文件没有看。菜单仍不显示这个字段。空菜单加 `truncated: true` 是「没看完」，不是「没有匹配」。

错误不变。未知 workspace 404 `workspace not found`。装了 `uiAuth` 时凭据不对仍是现有的 401，本路由不单独处理。数据库失败走现有的未捕获错误，菜单用现有的 `mention.lookupFailed`。空匹配是 200 和三个空数组，不是 404。

### 权限与 workspace 隔离

不新增身份、角色或分享范围。

每条 SQL 都把路径里的 workspace id 当作参数，写在 `workspace_id = $1`。先 `getWorkspace`，不存在就 404，不继续查。话题只从 `threads.workspace_id = $1` 出发，消息只按这些话题的 `thread_id` 连接。附件只取 `workspace_id = $1` 且 `status = 'attached'` 且 `message_id is not null`。磁盘 `stat` 只用这个 workspace 的附件目录。

因此：workspace A 的查询不返回 workspace B 的行。测试各插一行同名记录。过滤成立不等于扫描没看见别的 workspace：见「扫描界限」。

桌面网关的 `uiAuth` 仍只证明调用方持有本机网关凭据。它不按人区分 workspace。那是 P2-04，不是本轮。

### 搜索列和菜单行数

这些不依赖 D-1：

- 条目比较 `entry_id || ' ' || title`，和现在的 `fuzzyScore` 用同一串。精确 id 仍是第一档。附件只搜 `name`。话题只搜 `title`。不新增精确 id 语法。
- 非空查询在 SQL 里滤、排、`LIMIT`。hub 不把该 workspace 的全部标题读进进程。空查询不加谓词，按现在的时间顺序取菜单行，不再先取 500 或 50 再丢掉。
- 每组菜单最多 8 行。条目和话题多取 1 行，只用来置 `truncated`，不返回。平局顺序仍是：条目 `updated_at desc, entry_id desc`；附件 `created_at desc, id desc`；话题 `coalesce(最后一条消息的 created_at, threads.created_at) desc, id desc`。
- `MENTION_LIMITS.menuPerGroup` 仍是 8。`attachmentCandidates` 仍是 50，共享测试继续锁这个数；它不再当作搜索窗口。`MENTION_POOL` 离开搜索路径。
- `d-12` 仍把 id 为 `D-12` 的条目放在该组第一，即使另一条标题以 `d-12` 开头。

选定子序列时，排序用现在的档和更短优先，而不是「标题前缀然后按时间」。选定子串时，那个更简单的前缀档会改变谁出现在前 8 名；这是 D-1 的一部分，不是附带细节。

### 附件的磁盘检查有一个硬界限

现在的菜单在排序之前，对最新 50 个已发送附件做 `stat`，缺文件就标 `missing` 并剔除。搜索之后如果只 `stat` 排序结果的前 16 个，再靠第 17 行判断 `truncated`，就会把更后面的可用文件排除掉。

实验记录里的夹具：40 个文件名都匹配 `报告`，最新 16 个文件不存在，从第 17 个起有 24 个文件。只 `stat` 前 16 个时，菜单得到 0 个文件。第 17 个文件是这批里第一个还在的匹配，它既不会被打开，也不会被返回。把第 17 行只当作探测行，同样看不到它。

所以不能写「查询覆盖所有可用附件」。有限次 `stat` 覆盖的是「排序里、预算之内、并且文件还在」的那些。预算用完且后面还有行时，`truncated` 必须为 true；这时菜单可以是空的。缺文件仍标 `missing`，和现在一样。本地临时目录上，16 次缺失 `stat` 的中位是 0.30 ms，50 次存在 `stat` 的中位是 0.69 ms，16 次串行 `missing` 更新的中位是 2.06 ms。这个夹具里菜单为空是因为没往下看，不是因为 `stat` 太慢。

D-2 在下面。无论选哪一个有限预算，上面这句话都成立。

### 菜单、debounce、过期响应

`searchMentionContext(workspaceId, q, signal?)` 把 `AbortSignal` 传给这一次 `fetch`。现有测试断言两个参数的地方改为接受这个可选的第三个参数。

Composer 保持 150ms debounce 和 30 秒缓存。缓存键是 workspace id 加去掉空白后的查询。切换 workspace 后不得复用上一个 workspace 的结果。

查询或 workspace 变化时 abort 上一次请求。响应写回菜单或写入缓存之前，workspace id 和查询必须仍是这次打开的菜单的那一对。过期响应不得覆盖较新的结果，不得刷新该缓存项的时间，也不得在换了 workspace 之后画出来。没有命中缓存时，清空上一次的 `context`，菜单行和 Enter 选择都不得用它，直到这次结果写入；这段时间菜单用现有的 `mention.looking`。缓存命中则立刻用这份属于当前 workspace 和查询的结果。失败只在这次请求仍是当前请求时把状态设为 `failed`，并清空菜单数据。发送和打字不受影响，与现在相同。

`groupCandidates` 继续用 `fuzzyScore` 重排 hub 返回的行，直到 D-1 选定。子串结果是子序列的子集，旧的重排不会丢掉它们。子序列结果如果和现在的打分一致，重排也不会丢掉它们。不在这一步删掉 `fuzzyScore`。不改三份 `messages/*.json`。

### 扫描界限

一次按键仍是三条候选查询，外加一次 workspace 查找，以及每个缺失附件一条 `missing` 更新。`LIMIT` 只限制返回行数。实验里 10000 行的空查询，条目计划是对整表 `Seq Scan`（10000 行，`Rows Removed by Filter` 为 0），`LIMIT 500` 的执行时间 2.19 ms，`LIMIT 9` 是 2.07 ms。话题那条要分组全部话题，两次都在 10 ms 左右。主键 `(workspace_id, entry_id)` 在这次计划里没有被使用。

再装入第二个同样大小的 workspace 之后，查询 `发布` 的正则计划仍是 `Seq Scan`：命中 3000 行，滤掉 17000 行，`shared hit` 从 114 块变成 227 块，`shared read` 仍是 0。返回的 9 行全部属于被查询的 workspace，`foreignWorkspaceRows` 为 0。那两次 explain 的执行时间是 9.84 ms 和 10.37 ms。结果没有串库；扫描读过了另一个 workspace 的页。

这些数字来自一次热缓存运行，见实验记录。它们不是响应时间承诺，也不把 P2-02 标成完成。桌面 PGlite 没有测。

## 回归

实现时用临时库和假数据，不调用模型，不联网。在现有 `apps/hub/test/mentionContext.test.ts` 上加：

- 501 条条目，最旧的那条有独特标题。查询该标题能返回它。另一个 workspace 里的同名条目不出现。只存在于另一个 workspace 的标题在这边是空的 `entries`。
- 501 个话题，同样测最旧的独特标题和另一个 workspace。
- 51 个已发送附件，最旧的独特文件名能被找到。staged、deleted、别的 workspace 的文件仍不出现。
- 40 个同名匹配里，最新 16 个文件缺失、第 17 个起文件还在。断言必须按 D-2 写：固定看前 16 个时菜单为空且 `truncated` 为 true；不能把这个空菜单写成「没有可用附件」。
- `d-12` 把 `D-12` 排在条目前面，即使另一条的标题以 `d-12` 开头。
- `发布` 命中 `发布流程` 和 `版本发布`。`发流` 对 `发布流程`、`甲流乙` 对 `甲发中流乙`、`abc` 对 `a.b*c` 的期望跟 D-1 走：子串断言它们不命中，子序列断言它们命中，并且池外那条 `甲发中流乙` 出现在菜单里。
- 查询 `%`、`_`、`.*` 按字面处理。`.*` 不得匹配所有标题；它匹配含有 `.` 且其后有 `*` 的标题。
- 9 条命中时 `truncated` 为 true 且只返回 8 条。8 条命中时为 false。空查询超过 8 条时为 true。
- 已有的 400、404、已归档仍 200、不调用 daemon、响应不含正文和字节，保持。含 NUL 的 `q`（包括百分号编码的 `%00`）返回 400，正文是 `q contains a NUL character`。

web：

- `apps/web/test/mentions.test.ts` 保持 `groupCandidates` 的现有重排，直到 D-1 改它。
- `apps/web/test/Composer.test.tsx` 增加：较新的查询先返回、较慢的旧查询后返回时，菜单保持较新的查询结果，旧响应也不改写这份缓存；查询还没返回时，Enter 不会选中上一次的行；workspace id 不同的缓存不复用。debounce 仍是 150ms，现有「输入发布后请求 `w1`」的断言保持，并允许第三个 `signal` 参数。

实现 PR 还要改 [技术参考](../../reference.zh-CN.md) 里「`@` 提及」的候选那一段，使它描述搜索而不是 500/50 的池；并加一条 `changelog.d` 片段。用法没有新的安装步骤，README 和 guide 不改。本设计 PR 不改这些文件，因为行为还没落地。

## 兼容

同一响应形状。旧 web 会再用 `fuzzyScore` 滤一次。子串命中一定也是子序列，所以不会被旧 web 丢掉，但 `发流` 这类结果不会出现。子序列命中和现在的打分一致时，旧 web 会留下它们。新 web 配旧 hub 时，菜单仍只看见旧的 500 条池。桌面安装包和 Compose 一起发 hub 与 web，不为此加探测字段。

不改 `messages.meta`。除了 D-1 若选线性函数时的那一次函数迁移，不加表结构迁移。回滚就是回到按池子截断的菜单。已经发出的提及不受影响。

## 待决定的事项

有两项。实现计划等这两项和这份规格一起被验收。下面这些已经定了，不再另开：服务端过滤而不是把 500 调大、每组 8 行、不做分页、附件只搜文件名、话题只搜标题、不新增精确 id 语法、不用 `pg_trgm` 代替子序列、不把整个 workspace 读进 hub、不设毫秒门槛、不改文案、不改 [#195](https://github.com/Nema-Project/nema-room/issues/195) 的 milestone。

### D-1. 保留子序列，还是改成字面子串

本次热缓存、先丢掉一次热身再取 5 次的中位墙钟（条目、话题、附件三条一起，毫秒）：

| 规模 | 查询 | 现实现 | 子串 | 子序列正则 | 子序列线性 |
| --- | --- | --- | --- | --- | --- |
| 500 | `发布` | 2.91 | 0.58 | 1.37 | 1.24 |
| 2000 | `发布` | 2.82 | 1.28 | 4.28 | 3.27 |
| 10000 | `发布` | 8.95（8.86–9.26） | 6.30（6.22–8.35） | 20.33（20.26–20.74） | 14.87（14.55–14.99） |
| 10000 | `最旧独特标题` | 9.33，菜单没有 `D-10000` | 3.90，有 | 5.73，有 | 9.38，有 |
| 10000 | `甲流乙` | 9.15，没有 `D-9999` | 3.86，没有 | 5.03，有 | 8.92，有 |

10000 行里，`发布` 有 3000 个字面命中；`发流` 有 1000 个子序列命中、0 个字面命中；`甲流乙` 只有池外那一条。正则和线性在这次 BMP 数据的每个查询上，三组前 8 名都和全表 `fuzzyScore` 相同。子串只在空查询、零命中、以及唯一标题上一致。

[#195](https://github.com/Nema-Project/nema-room/issues/195) 同时要求找得到第 501 条之后的目标，并且菜单不比现在慢。在这台机器的 10000 行常见查询上，两条子序列都比现实现慢，子串更快，但子串找不到 `甲流乙`。绝对时间仍是几十毫秒量级，而且是热缓存。这不够用来宣布「不值得保留子序列」，也不够用来宣布已经满足「不比现在慢」。

另外两条代价：正则路径要用 JS 折叠去配 SQL `lower`，`İ` 会分叉；线性路径两边都用 SQL `lower`，查询 `İ` 会命中标题 `i`，JS 不会。线性函数是一次迁移。1000 条 500 字的 `a` 重复标题上，200 字查询的正则是 98.54 ms，线性是 355.14 ms，3 秒语句超时都没触发。这只说明这次探针没有爆，不是正则在 200 字以内都安全。

### D-2. 附件 `stat` 在哪里停

夹具已经说明：停在第 16 次时，第 17 个仍在的文件不会出现，菜单是空的，磁盘上还有 24 个匹配文件。

- 固定预算，例如 16 次，用完就停。实现简单。这个夹具的菜单是空的。
- 跳过缺失文件继续往后，直到凑满 8 个或用完一个写明的次数。预算仍是 16 时，这个夹具的菜单还是空的，因为前 16 个都缺。要看见第 17 个，预算至少得超过前面连续缺失的个数。
- 一直 `stat` 到凑满 8 个存在的文件。这个夹具能返回文件。缺失文件排在前面时，`stat` 次数等于那些缺失的个数，没有上限。

前两种有次数上限，都不能说成「覆盖了所有可用附件」。第三种才会在这个夹具里返回文件，同时失去次数上限。

