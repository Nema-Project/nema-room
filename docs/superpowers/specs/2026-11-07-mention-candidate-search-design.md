# 提及候选的服务端搜索

- **Issue：** [#195](https://github.com/Nema-Project/nema-room/issues/195)。来源是 [v0.2.0 对照报告](../../reviews/2026-10-31-v0-2-0-community-practices.md) 第 2.4 节第 2 条和缺口 J。
- **服务对象：** [#45](https://github.com/Nema-Project/nema-room/issues/45)。人在一句话里点名一条知识、一份已发送的文件或一个话题时，菜单要能找到那一项，包括它不在最近更新的 500 条里的时候。找到的仍是用户指定的指针，不是决定，也不产生 `verified`。
- **核对基线：** `origin/main` `9b8a4287fdde3f3d52721ee43ede19c61b1e0772`（2026-11-07 与 `origin/main` 一致）。开放 PR 只有 [#212](https://github.com/Nema-Project/nema-room/pull/212)（只读分享规格），本设计不改它碰过的文件。
- **版本：** 本轮按 v0.2.4 设计。仓库没有名为 `v0.2.4` 的 milestone（含已关闭的），本设计不创建 milestone，也不改 [#195](https://github.com/Nema-Project/nema-room/issues/195) 现有的 `v0.3.x` milestone。
- **本文件定行为。** 2026-11-09 用户定了匹配和附件检查。实现步骤在 [同日的计划](../plans/2026-11-09-mention-candidate-search.md)。本文件没有产品代码。

## 范围

已批准的最小范围：

- 条目、已发送附件、话题超过现有候选池时，菜单里的查询仍能找到目标。
- 服务端搜索、`@` 菜单接入、大工作区回归。
- 不附带 tag、成员提及、话题或附件的新精确 id 写法。

不在本轮：

- 把 `MENTION_POOL` 从 500 调大，或把 `MENTION_LIMITS.attachmentCandidates` 从 50 调大，当作修复。
- 菜单里的「下一页」。
- `pg_trgm`、全文检索、分词，或为这次搜索加匹配索引。不加函数迁移。
- 除下面这一句之外的新文案。查找中、失败、没有匹配，仍用现有的 `mention.looking`、`mention.lookupFailed`、`mention.noMatch`。
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

`truncated` 今天没有被菜单读。找完的空结果仍用 `mention.noMatch`。附件预算用尽且后面还有行时，菜单改用下面定的那句，不再用 `mention.noMatch`。

[#195](https://github.com/Nema-Project/nema-room/issues/195) 要求开工前先测大工作区上现有上限的实际影响。P2-02 仍是路线图上的待办，这次测量不把它标成完成。合成数据、环境和命令记在 [同日的实验记录](2026-11-07-mention-candidate-search-benchmark.md)。

## 现有匹配，不能静默换成子串

`fuzzyScore`（`packages/shared/src/mentions.ts`）在忽略大小写之后按码点比较。档位从高到低是：最后一个 `/` 段的前缀、任意一段的前缀、按顺序出现的子序列。同一档里更短的字符串排前面。条目的比较文本是 `id + " " + title`，所以标题前缀通常落在子序列档，而不是前缀档；`notes/发布/log` 这种路径会因为段前缀排到更前。精确 id 由调用方另放在所有档之前。空查询保持传入顺序，也就是 SQL 的最近活动顺序。

因此 `发流` 命中 `发布流程`，不命中 `版本发布`。`abc` 命中 `a.b*c`。2026-11-09 定了保留这种子序列，不改成连续子串。

子序列在数据库里做完，只把菜单行送回进程。不把 workspace 载入 hub。分页不做。`pg_trgm` 不做。

谓词是正则，不加迁移。hub 先用 SQL `select lower($1)` 折叠查询，不用 `String.prototype.toLowerCase`。再把折叠结果的每个码点转义（`\^$.*+?()[]{}|`），用 `.*` 连接，整段作为绑定参数交给 `lower(列) ~ $3`。查询文本不拼进 SQL。列和参数因此用同一种折叠。空查询不加这条谓词。

实验记录里的「子序列正则」列用的是 JS `toLowerCase` 再转义，不是这个谓词。对那次的 ASCII 和汉字查询，两种折叠相同，那些计时仍可引用。`İ` 的分叉不在那张表里。

不改用线性函数。那次探针里 `bench_subseq(lower(列), lower(查询))` 和 JS 的差别，与两侧都用 SQL `lower` 的正则相同：查询 `İ`、标题 `i` 时 SQL 命中、JS 不命中。线性函数消不掉这个差别，还要一次迁移。1000 条 500 字的 `a` 重复标题上，200 字查询的正则是单次 109.25 ms，线性是单次 359.68 ms，都是 `count(*)` 的一行合计，不是中位数，3 秒语句超时都没触发。这不是「200 字以内的正则都安全」。200 字上限和 NUL 拒绝仍然留着；数据库错误仍走现有的 `mention.lookupFailed`，不加新的超时。

和 `fuzzyScore` 的一致性：

- 查询 `İ`、标题 `İstanbul`：这次 PostgreSQL 17.11、`en_US.utf8` 上 `lower('İ')` 是 ASCII `i`，`lower('İstanbul')` 是 `istanbul`，SQL 命中。JS `toLowerCase('İ')` 是 `i` 加组合点，也命中，原因不同。用 JS 折叠去配 `lower(列)` 会漏掉这一对，所以模式必须来自 SQL `lower`。
- 查询 `İ`、标题 `i`：SQL 命中，JS 不命中。新 web 不因为 `fuzzyScore` 为 null 丢掉这一行。
- `ß`：这次 JS 和 SQL 都不把 `ß` 展开成 `ss`。查询 `ss` 不中 `straße`，查询 `ß` 中。这不是所有 locale 的证明。
- 非 BMP：匹配按码点。正则的 `.` 是一个字符，转义用 `Array.from` 的一个码点。实验里 `😀` 和标题中的换行与 JS 一致。这不是所有 Unicode 的证明。
- 更短优先用 UTF-16 代码单元，不用 `char_length`。SQL 是 `(octet_length(convert_to(folded, 'UTF16')) - 2) / 2`，减掉 `convert_to` 前面的 2 字节 BOM。同一档里 `abcd`（长度 4）排在 `a😀😀`（长度 5）前面。实现测试必须对上 JavaScript 的 `String.length`。对不上就改这个式子，不改回 `char_length`，也不为此换线性函数。

菜单顺序就是这个 SQL 顺序。新 web 不再用 `fuzzyScore` 重排或过滤。重排只能排已经返回的行，救不回 `LIMIT` 留在页外的行，还会丢掉查询 `İ`、标题 `i`。空查询仍保持 SQL 的时间顺序，web 不再另排一次。

## 设计

### 接口

路径和查询名不变。成功体多一个布尔字段：

```json
{ "status": "ok", "entries": [], "attachments": [], "threads": [], "truncated": false, "attachmentBudgetExhausted": false }
```

行的字段不变。条目是 `id`、`kind`、`title`、`status`。附件是 `id`、`name`、`kind`、`size`、`messageId`、`createdAt`。话题是 `id`、`title`、`lastReplyAt`。没有正文、字节、hash、别的 workspace 的 id。

`q` 仍在 `trim` 之前量长度，超过 200 返回 400，正文仍是 `q is longer than 200 characters`。正文含 NUL（`\0`，包括 `q=%00`）时，在当作 SQL 参数之前返回 400，正文是 `q contains a NUL character`。不把 NUL 交给 `lower($2)`，因为 PostgreSQL 的 text 不接受 NUL，否则会变成 500。`trim` 不删 NUL。`trim` 之后为空，包括只有空白，走空查询。

`truncated` 不再表示「附件超过 50」。它表示：按上面的排序，菜单这 8 行后面还有没交给用户的匹配，或者附件的 `stat` 预算用尽且后面还有行。响应多一个布尔字段 `attachmentBudgetExhausted`。它只在附件预算用尽且后面还有行时为 true；这时 `truncated` 也是 true。旧 web 忽略这个字段。

菜单仍不把 `truncated` 画成一列。三组都没有行、而且 `attachmentBudgetExhausted` 为 true 时，用新键 `mention.notFinished`，不用 `mention.noMatch`：

| 键 | zh | en | ja |
| --- | --- | --- | --- |
| `mention.notFinished` | 已检查 50 个文件，尚未查完，请输入更具体的关键词。 | Checked 50 files and have not finished. Please enter a more specific keyword. | 50件のファイルを確認しましたが、まだ探し終わっていません。より具体的なキーワードを入力してください。 |

任一有行时只显示那些行，不显示这句，也不显示 `mention.noMatch`。找完了的空结果仍用 `mention.noMatch`。请求还在飞用 `mention.looking`，失败用 `mention.lookupFailed`。

`attachmentBudgetExhausted` 为 true 的响应不写入 30 秒缓存。只因为超过 8 行而 `truncated` 为 true、预算没耗尽的结果仍可缓存。没有这个字段的旧 hub 响应，新 web 把它当作 false。

错误不变。未知 workspace 404 `workspace not found`。装了 `uiAuth` 时凭据不对仍是现有的 401，本路由不单独处理。数据库失败走现有的未捕获错误，菜单用现有的 `mention.lookupFailed`。找完的空匹配是 200、三个空数组，并且 `attachmentBudgetExhausted` 为 false，不是 404。

### 权限与 workspace 隔离

不新增身份、角色或分享范围。

每条 SQL 都把路径里的 workspace id 当作参数，写在 `workspace_id = $1`。先 `getWorkspace`，不存在就 404，不继续查。话题只从 `threads.workspace_id = $1` 出发，消息只按这些话题的 `thread_id` 连接。附件只取 `workspace_id = $1` 且 `status = 'attached'` 且 `message_id is not null`。磁盘 `stat` 只用这个 workspace 的附件目录。

因此：workspace A 的查询不返回 workspace B 的行。测试各插一行同名记录。过滤成立不等于扫描没看见别的 workspace：见「扫描界限」。

桌面网关的 `uiAuth` 仍只证明调用方持有本机网关凭据。它不按人区分 workspace。那是 P2-04，不是本轮。

### 搜索列和菜单行数

- 条目比较 `entry_id || ' ' || title`，和现在的 `fuzzyScore` 用同一串。精确 id 仍是第一档：`lower(entry_id) = lower(查询)`。附件只搜 `name`。话题只搜 `title`。不新增精确 id 语法。
- 非空查询在 SQL 里滤、排、`LIMIT`。档位是：精确 id，最后一个 `/` 段的前缀，任意一段的前缀，子序列。前缀用 `strpos` 对 `lower` 之后的文本，把查询当字面量。同一档里 UTF-16 代码单元更少的排前面。平局：条目 `updated_at desc, entry_id desc`；附件 `created_at desc, id desc`；话题 `coalesce(最后一条消息的 created_at, threads.created_at) desc, id desc`。
- hub 不把该 workspace 的全部标题读进进程。空查询不加谓词，按现在的时间顺序取菜单行，不再先取 500 再丢掉。
- 每组菜单最多 8 行。条目和话题多取 1 行，只用来置 `truncated`，不返回。
- `MENTION_LIMITS.menuPerGroup` 仍是 8。`attachmentCandidates` 仍是 50，现在是附件 `stat` 的次数上限，不再是「先取 50 个文件名再在内存里搜」。`MENTION_POOL` 离开搜索路径。
- `d-12` 仍把 id 为 `D-12` 的条目放在该组第一，即使另一条标题以 `d-12` 开头。

### 附件的磁盘检查有一个硬界限

2026-11-09 定了：按排序取出匹配的附件名，最多 `stat` 50 次。缺文件就标 `missing` 并跳过，继续往后，直到凑满 8 个还在的文件，或用满 50 次。SQL 多取 1 行（最多 51 个名字），用来知道第 50 次之后还有没有行；这一行没被 `stat` 之前不返回。

用满 50 次且后面还有行时，`attachmentBudgetExhausted` 和 `truncated` 都是 true。这 50 次不是全部可用附件。名字匹配可以多于 50，更后面的文件这次不会被打开。

实验夹具是 40 个同名文件、最新 16 个缺失。预算 50 大于 40，所以会跳过那 16 个，返回后面还在的文件，直到 8 个。若最新 50 个都缺失且第 51 个还在，菜单的附件组是空的，`attachmentBudgetExhausted` 为 true，不把这说成没有匹配。缺文件仍标 `missing`，沿用 `available` 的单行更新，不改它给别的调用方的含义。本地临时目录上，16 次缺失 `stat` 的中位是 0.30 ms，50 次存在 `stat` 的中位是 0.71 ms。次数上限解决的是「后面的文件永远看不到」，不是把 `stat` 变成瞬时的。

### 菜单、debounce、过期响应

`searchMentionContext(workspaceId, q, signal?)` 把 `AbortSignal` 传给这一次 `fetch`。现有测试断言两个参数的地方改为接受这个可选的第三个参数。

Composer 保持 150ms debounce 和 30 秒缓存。缓存键是 workspace id 加去掉空白后的查询。切换 workspace 后不得复用上一个 workspace 的结果。

查询或 workspace 变化时 abort 上一次请求。响应写回菜单或写入缓存之前，workspace id 和查询必须仍是这次打开的菜单的那一对。过期响应不得覆盖较新的结果，不得刷新该缓存项的时间，也不得在换了 workspace 之后画出来。没有命中缓存时，清空上一次的 `context`，菜单行和 Enter 选择都不得用它，直到这次结果写入；这段时间菜单用现有的 `mention.looking`。缓存命中则立刻用这份属于当前 workspace 和查询的结果。失败只在这次请求仍是当前请求时把状态设为 `failed`，并清空菜单数据。发送和打字不受影响，与现在相同。

`groupCandidates` 保持 hub 返回的顺序，不再调用 `fuzzyScore`。空查询也不再按 `lastReplyAt` 在浏览器里重排。三组都空且 `attachmentBudgetExhausted` 为 true 时，菜单用 `mention.notFinished`。这个响应不进 30 秒缓存。缓存键仍是 workspace id 加去掉空白后的查询。

### 扫描界限

一次按键仍是三条候选查询，外加一次 workspace 查找，以及每个缺失附件一条 `missing` 更新。`LIMIT` 只限制返回行数。实验里 10000 行的空查询，条目计划是对整表 `Seq Scan`（10000 行，`Rows Removed by Filter` 为 0），`LIMIT 500` 的执行时间 2.21 ms，`LIMIT 9` 是 2.06 ms。话题那条要分组全部话题，两次的执行时间是 10.62 ms 和 9.60 ms。主键 `(workspace_id, entry_id)` 在这次计划里没有被使用。

再装入第二个同样大小的 workspace 之后，查询 `发布` 的正则计划仍是 `Seq Scan`：命中 3000 行，滤掉 17000 行，`shared hit` 从 114 块变成 227 块，`shared read` 仍是 0。返回的 9 行全部属于被查询的 workspace，`foreignWorkspaceRows` 为 0。那两次 explain 的执行时间是 10.00 ms 和 10.82 ms。结果没有串库；扫描读过了另一个 workspace 的页。

这些数字来自一次热缓存运行，见实验记录。它们不是响应时间承诺，也不把 P2-02 标成完成。桌面 PGlite 没有测。

## 回归

实现时用临时库和假数据，不调用模型，不联网。在现有 `apps/hub/test/mentionContext.test.ts` 上加：

- 501 条条目，最旧的那条有独特标题。查询该标题能返回它。另一个 workspace 里的同名条目不出现。只存在于另一个 workspace 的标题在这边是空的 `entries`。
- 501 个话题，同样测最旧的独特标题和另一个 workspace。
- 51 个已发送附件，最旧的独特文件名能被找到。staged、deleted、别的 workspace 的文件仍不出现。
- 40 个同名附件，最新 16 个文件缺失、第 17 个起还在。菜单返回后面还在的文件，直到 8 个；不把菜单空着。`stat` 次数不超过 50。
- 最新 50 个同名附件都缺失，第 51 个文件还在。附件组为空，`attachmentBudgetExhausted` 和 `truncated` 都是 true。响应里没有第 51 个文件。不能把这写成「没有可用附件」。
- 同名附件恰好 50 个且全部缺失，没有第 51 个。`attachmentBudgetExhausted` 为 false。条目和话题也没有命中时，这是找完的空结果。
- `d-12` 把 `D-12` 排在条目前面，即使另一条的标题以 `d-12` 开头。
- `发布` 命中 `发布流程` 和 `版本发布`。`发流` 命中 `发布流程`，并让池外的 `甲发中流乙` 出现在菜单里。`甲流乙` 命中 `甲发中流乙`。`abc` 命中 `a.b*c`。
- 查询 `%` 和 `_` 不匹配所有标题。查询 `.*` 命中 `a.b*c`，也命中含连续 `.*` 的标题，不匹配所有标题。
- 同一档里 `abcd` 排在 `a😀😀` 前面。查询 `İ` 同时返回标题 `i` 和 `İstanbul`。查询 `ß` 命中 `straße`，查询 `ss` 不命中。
- 9 条命中时 `truncated` 为 true 且只返回 8 条，`attachmentBudgetExhausted` 为 false。8 条命中时 `truncated` 为 false。空查询超过 8 条时为 true。
- 已有的 400、404、已归档仍 200、不调用 daemon、响应不含正文和字节，保持。含 NUL 的 `q`（包括百分号编码的 `%00`）返回 400，正文是 `q contains a NUL character`。模式参数不是由 JS `toLowerCase` 生成的。

web：

- `apps/web/test/mentions.test.ts`：非空查询保持 hub 的顺序，不丢掉 `fuzzyScore` 会拒绝的行。空查询不再按 `lastReplyAt` 重排。
- `apps/web/test/Composer.test.tsx`：较新的查询先返回、较慢的旧查询后返回时，菜单保持较新的查询结果，旧响应也不改写这份缓存；查询还没返回时，Enter 不会选中上一次的行；workspace id 不同的缓存不复用。`attachmentBudgetExhausted` 为 true 时不写入 30 秒缓存；只因超过 8 行而 `truncated` 的结果仍写入。三组都空且该字段为 true 时，菜单是 `mention.notFinished`，不是 `mention.noMatch`。debounce 仍是 150ms，现有「输入发布后请求 `w1`」的断言保持，并允许第三个 `signal` 参数。

实现 PR 还要改 [技术参考](../../reference.zh-CN.md) 里「`@` 提及」的候选那一段，使它描述搜索而不是 500/50 的池；并加一条 `changelog.d` 片段。用法没有新的安装步骤，README 和 guide 不改。本设计 PR 不改这些文件，因为行为还没落地。

## 兼容

成功体多了 `attachmentBudgetExhausted`。旧 web 忽略它，仍会用 `fuzzyScore` 滤一次：子序列命中且 JS 也承认的行会留下，`发流` 对 `发布流程` 仍在；查询 `İ`、标题 `i` 会被丢掉。改新 web 补不了已经发出的旧 web。新 web 配旧 hub 时，菜单仍只看见旧的 500 条池，并把缺省的该字段当作 false。桌面安装包和 Compose 一起发 hub 与 web。

不改 `messages.meta`。不加表结构迁移，也不加函数迁移。回滚就是回到按池子截断的菜单。已经发出的提及不受影响。

## 已定结论

2026-11-09 定了这两项。实现按 [计划](../plans/2026-11-09-mention-candidate-search.md) 做，不再把它们当开项。

- 匹配是服务端子序列。模式来自 SQL `lower` 之后的逐码点转义，作为参数交给 `~`。不改成字面子串，不加线性函数。菜单顺序是 SQL 顺序，更短优先用 UTF-16 代码单元。新 web 不重排。
- 附件最多 `stat` 50 次，跳过缺失文件，直到 8 个还在的文件或用满 50 次。用满且后面还有行时 `truncated` 和 `attachmentBudgetExhausted` 为 true。这种响应不进 30 秒缓存。三组都空时用 `mention.notFinished`，不用 `mention.noMatch`。

同时已经定了、不再另开：服务端过滤而不是把 500 调大、每组 8 行、不做分页、附件只搜文件名、话题只搜标题、不新增精确 id 语法、不用 `pg_trgm` 代替子序列、不把整个 workspace 读进 hub、不设毫秒门槛、不改 [#195](https://github.com/Nema-Project/nema-room/issues/195) 的 milestone。10000 行常见查询上，子序列比现实现慢，绝对时间仍是热缓存上的几十毫秒。这不构成「不比现在慢」的验收。

