# 知识条目 tag（D10-A 的后续）

日期：2026-11-16。Issue：[Nema-Project/nema-room#162](https://github.com/Nema-Project/nema-room/issues/162)。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。前置设计：[2026-10-31 提及设计](2026-10-31-mentions-design.md) 的 D10（当时选 A：tag 单独立项）与 [提及候选的服务端搜索](2026-11-07-mention-candidate-search-design.md)。相关：[身份模型](2026-11-16-identity-model-design.md)（#163）。

**状态**：设计已定案。D-1 到 D-9 已于 2026-11-17 由维护者全部按本文推荐决定（逐项见下），实现按决定执行，不得自行更改。本文件不改生产代码，实施计划另行编写。

**设计所对照的 HEAD**：`f21843e830ab4e423731010339e05d09c6fd7280`（`main`，v0.2.6 发布记录合并之后）。标为「已核对」的行为是在这个 SHA 上读代码得到的。

**来源说明**：写本文件的会话没有权限读取 GitHub issue（`gh`、API 与网页抓取都被拒绝）。#162 的正文与评论没有逐字核对。本文的范围来自 [提及设计 D10 的 B 选项](2026-10-31-mentions-design.md)：frontmatter `tags: string[]`、`entry_index` 加列、面板筛选、提及菜单加 tag 组，以及 D10-A 里点名的迁移、prompt 索引段、导出与导入。「验收」一节在合并前必须与 #162 的验收条目逐条对照。

## 如何服务 #45

#45 的判断标准：让人和 agent 能维护一份随项目演进、有证据支撑的共同理解。条目今天只能按 kind 和 id 找。一个跨类型的主题，比如「支付」相关的需求、决策、取舍和待确认问题，只能靠记忆或全文搜标题。tag 让人和 agent 用同一个词把这些条目指出来：面板能筛，`@` 能点名，agent 能在索引里看到同一组标签。

tag 是导航用的标签，不是知识本身。它不改变条目的 `status`、`basis`、`verified` 或 `confirmedBy`。选中一个 tag 交给 agent 时，交出去的仍是「用户指定的指针，不是决定」（[提及设计](2026-10-31-mentions-design.md) 的原则，`packages/shared/src/mentions.ts` 的注释也这样写）。谁加的 tag 由知识库 Git 提交的 `Author:` 记录。agent 自己加的 tag 是推断，D-5 决定它能做到哪一步。

本设计不做全文检索、不做分类树、不做 tag 层级或别名，也不把 tag 当成权限边界或分享范围。

## 现状（已核对）

- **条目没有 tag。** `EntryFrontmatter` 和 `UpsertEntryInput`（`packages/shared/src/entry.ts`）都是非 strict 的 `z.object`，没有 `tags`。`EntrySummary` 也没有。
- **frontmatter 逐字段映射，丢弃未知键。** `fromFile` 用 gray-matter 读出 `data`，再逐个字段交给 `EntryFrontmatter.parse`；`toFile` 也只写已知字段（`packages/knowledge/src/store.ts`）。所以今天的 hub 读到含 `tags:` 的文件不会报错，但只要它重写这条条目，`tags` 就从文件里消失。这决定了跨版本的风险，见「兼容」与 D-8。
- **解析失败会让整条条目消失。** `readAll` 对解析失败的文件只打警告并跳过（`store.ts`）。如果 tag 校验写进 `EntryFrontmatter` 并且严格，一个手改坏的 tag 就会让这条条目从面板、索引和 prompt 里全部消失。
- **`entry_index` 的列**：`workspace_id, entry_id, kind, title, status, priority, business_date, updated_at`，主键 `(workspace_id, entry_id)`，没有外键（`001_init.sql`）。唯一的写入是 `indexEntry`：一条 `insert … on conflict do update`（`apps/hub/src/entryIndex.ts`）。调用方有 `roomApi.ts`、`uiApi.ts`（编辑、确认、撤回）、`diagrams.ts`、`workpackages.ts`、`sourceImport.ts`，以及启动时 `lifecycle.ts` 的 `recoverUncommittedEntries`。
- **读 `entry_index` 的查询：**
  - `mentionContext.ts`：按 `workspace_id` 取，在 `lower(entry_id || ' ' || title)` 上做子序列正则，`limit 9`。
  - `mentions.ts` 的 `validateMentions`：`entry_id = any($2)`。
  - `entryIndex.ts` 的 `timeline` 与 `topOpenQuestion`、`openQuestionCounts`。
  - `threads.ts` 与 `diagrams.ts` 按 kind 和 status 取。
- **知识面板不读 `entry_index` 做筛选。** `KnowledgePanel.tsx` 的「按类型」视图调 `GET /api/workspaces/:id/entries`，那条路由每次从 `KnowledgeStore.listEntries()` 读全部文件（`uiApi.ts`）。「按时间」视图调 `timeline`：顺序来自 `entry_index`，内容仍从文件补全。分组和 active/inactive 的划分都在浏览器里完成。所以面板的 tag 筛选需要的是 `EntrySummary.tags`，不需要数据库列。
- **prompt 的条目索引没有字节预算。** `buildPrompt`（`apps/hub/src/prompt.ts`）的 `# 现有条目索引` 对 `timeline` 返回的每一条写一行 `id | kind | status | title`（另附 priority 与 inferred），条目再多也不截断。`daemonSocket.ts` 把完整的 `timeline` 传进去。
- **提及只有三种类型，并且旧 hub 会拒绝新类型。** `MessageMention` 是 `entry`/`attachment`/`thread` 的 discriminated union。`PostMessageBody.mentions` 用 `MessageMentions` 解析，未知 `type` 让整次发送 400。每条消息最多 20 个提及，条目正文每条 4 KiB、合计 16 KiB（`MENTION_LIMITS`）。
- **agent 的工具 schema 由共享类型生成。** `apps/cli/src/direct/tools.ts` 用 `z.toJSONSchema(UpsertEntryInput)` 生成 `upsert_entry` 的参数。CLI（npm 包）与 hub 各自带一份 `@nema/shared`。hub 的 room API 用 `UpsertEntryInput.safeParse` 解析，未知字段被静默丢弃。
- **快照：** `entry_index` 在 `TABLE_COLUMNS` 里（`apps/hub/src/db/snapshot.ts`），只列出今天的 8 列。导出只选列出的列（`export.ts`），导入也只插入列出的列（`apps/local/src/import.ts`，它已经能处理数组类型）。知识文件随 Git bundle 原样搬运，所以 frontmatter 里的 tag 会跟着快照走，`entry_index` 里的派生数据不需要跟着走。未知表、未知列都会让 `validateSnapshot` 拒绝整份快照。
- **分享的公开投影是白名单。** `toPublicSummary`（`apps/hub/src/shares.ts`）逐字段复制，不会自动带上新字段。

## 决定（2026-11-17 已全部定案）

### D-1 选中一个 tag 交给 agent 的语义

在 `@` 菜单里选中一个 tag，消息里记录什么？

- **A：在输入框里展开成逐条的条目提及。** 选中 `#支付` 时，web 取该 tag 下的条目，把 `#支付：[D-3] [R-7] [T-2]` 插入正文，每个 `[X-n]` 都是一个普通的 `entry` 提及，存进 `meta.mentions`。tag 本身只是正文里的可读文字，不进 `meta`。
- **B：新增 `tag` 提及类型。** `meta.mentions` 存 `{ type: "tag", id: "支付", text: "#支付" }`，hub 在拼 prompt 时才把它解析成当时带这个 tag 的条目。

按仓库原则「提及是用户的指针，不是决定」来比较：

- **A 记录的是用户实际指的东西。** 发送那一刻用户看到的就是这几条，消息上存的也正是这几条。事后能回答「当时让 agent 看的是哪一份」，这是提及设计在 #45 下写明的可核对性。之后有人给别的条目加了 `#支付`，这条旧消息的含义不变。
- **B 记录的是一个查询，解析结果由系统决定。** 重试、编辑后重跑（`editUserMessage` 会按保留的提及重新拼 prompt）时，同一条消息可能交给 agent 一组不同的条目，而用户从没指过那些条目。这把「用户的指针」变成了「系统在之后某个时刻的选择」。要让它可核对，就得把每次解析结果存下来，那又回到了 A。
- **兼容：** A 对 hub 来说只是普通的条目提及，旧 hub 照常接受。B 在新 web 配旧 hub 时让发送 400（见「现状」）。
- **上限：** A 受每条消息 20 个提及的限制，超出时必须明确告诉用户，不能悄悄截掉（[#192/#193 的提示设计](2026-11-02-skill-limits-and-mention-notice-design.md) 也是这个立场）。B 没有这个限制，但条目正文仍受 16 KiB 合计预算约束，超出的条目只给 id。所以「一个 tag 能带进更多正文」对 B 不成立。
- **正文可读性：** A 的正文更长。B 的正文更短，可读性更好。

**推荐：A。** 展开的范围与上限：

- 只展开 active 条目，也就是不在 `INACTIVE_STATUSES`（superseded、dropped、resolved）里的条目。菜单行显示 `#支付 · 5 条（另有 2 条已失效）`。
- 展开后的条目数超过本条消息剩余的提及名额（20 减去已有的提及）时，菜单行不可选，并提示「`#支付` 有 23 条，超过一条消息的 20 个提及上限」（三语新键）。不部分插入，不静默截断。
- 顺序按 kind（同 `KnowledgeStore.listEntries`），再按编号。

**状态：已决定（2026-11-17，维护者按推荐定案）：选 A（选中 tag 时在输入框展开成逐条条目提及；只展开 active 条目，超名额不插入并提示）。**

### D-2 `entry_index` 用数组列还是关联表

把两种做法放到现有的查询和写入上逐项比较：

| 方面 | 数组列 `entry_index.tags text[]` | 关联表 `entry_tags(workspace_id, entry_id, tag)` |
| --- | --- | --- |
| 写入 | 在 `indexEntry` 现有的那一条 upsert 里多写一列，原子性不变 | 要在事务里先删后插。`indexEntry` 今天有些调用点直接拿 `db` 而不是事务，要逐个改 |
| `@` 菜单的 tag 组（去重、计数、子序列匹配） | `from entry_index, unnest(tags) t where workspace_id = $1 and t ~ $3 group by t` | `from entry_tags where workspace_id = $1 and tag ~ $3 group by tag` |
| D-1 A 的展开（tag 到条目） | `where workspace_id = $1 and $2 = any(tags)` | 主键前缀 `(workspace_id, tag)` 可以走索引 |
| 现有的条目搜索、`timeline`、`validateMentions` | 不变，多一列不影响 | 不变 |
| 面板筛选 | 不用（面板读文件） | 不用 |
| 删除 workspace | `deleteWorkspace` 已经删了 `entry_index` 行，不用再改 | 要加一行删除，或加外键级联 |
| 快照 | 不把新列放进 `TABLE_COLUMNS`，导出导入都不带，启动时回填 | 不把新表放进 `TABLE_COLUMNS`，同样启动时回填 |
| 每个 workspace 的规模 | [候选搜索的实验记录](2026-11-07-mention-candidate-search-benchmark.md) 里 1 万行的 `entry_index` 本来就是顺序扫描，数组的 `unnest` 在这个量级没有区别 | 有索引，但要多维护一张表 |

**推荐：数组列。** 现有查询都按 `workspace_id` 顺序扫描，每个 workspace 有上限 200 个不同的 tag（D-4），关联表的索引优势用不上；数组列却让写入保持一条语句，删除也不用改。以后某个 workspace 真的大到需要索引，可以加 `gin (tags)`，不必换结构。

**状态：已决定（2026-11-17，维护者按推荐定案）：选数组列（`entry_index.tags text[]`，加 `tags_indexed_at`）。**

### D-3 规范化

用一个共享函数 `normalizeTag(raw): string | null` 处理，web、hub 和 CLI 共用（`packages/shared`）：

1. `normalize("NFKC")`：把全角的 `ＡＰＩ` 变成 `API`，输入法打出的全角字符与半角不会成为两个 tag。
2. 去掉首尾空白；内部连续的空白换成一个 `-`。`@` 菜单的触发规则要求 `@` 到光标之间没有空白，所以 tag 里不能有空格。
3. 大小写：用 `toLowerCase()` 折叠。它与区域设置无关，存的就是折叠后的值，显示也用这个值。
4. 字符集：折叠后必须匹配 `^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$`（`u` 标志）。`\p{M}` 留给天城文、泰文等要组合符号的文字。`[` `]` 会和 `[D-12]` 的链接渲染冲突，`#` `@` `,` `/` 会和输入、展开文字冲突，都不允许。
5. 不能长得像条目 id：`^(r|d|t|q|s|g|w)-[1-9]\d*$` 拒绝，避免和菜单里的精确 id 匹配混淆。
6. 长度上限见 D-4，按码点计。
7. 同一条目内按规范化后的值去重，保留第一次出现的顺序。

校验失败的处理：写入路径（`UpsertEntryInput`：UI 编辑和 agent 工具）返回 400，并说明是哪一个 tag、什么原因，不静默改写。读取路径（`fromFile`）不能因为 tag 让整条条目解析失败：不合法的 tag 丢掉、打警告，条目照常读出。下一次写入时，文件里就只剩合法的 tag。

需要决定的点：大小写是折叠成小写，还是保留首次输入的大小写、只在比较时折叠（那就要多存一个显示形式）。

**推荐：** 按上面的 1 到 7，折叠后只存一种形式。

**状态：已决定（2026-11-17，维护者按推荐定案）：按推荐（只存折叠后的一种形式：NFKC、全角转半角、小写折叠、字符集限制）。**

### D-4 上限

| 上限 | 建议值 | 理由 |
| --- | --- | --- |
| 单个 tag 长度 | 1–32 个码点 | 标签是一个词，不是一句话。32 个汉字已经很长。汉字按 UTF-8 是 3 字节，最坏 96 字节，prompt 索引的逐行预算（D-6）能放下一个完整的 tag |
| 每条条目最多几个 tag | 8 | 与菜单每组 8 行（`MENTION_LIMITS.menuPerGroup`）同一个量级。超过 8 个，通常说明 tag 被当成了关键词堆砌 |
| 每个 workspace 最多几个不同的 tag | 200 | 面板的筛选条要能一眼看完；D-6 的 tag 词表要能放进 2 KiB 左右的预算；agent 自由造词时（D-5），这道上限能挡住词表膨胀 |

workspace 上限的执行：hub 在 upsert 的守卫里（已经在仓库锁内），把这次写入后会出现的新 tag，与 `entry_index` 里本 workspace 已有的不同 tag 合起来数，超过 200 回 400。`entry_index` 只在提交后的补记失败时才落后于文件，这种情况下计数可能少算。这一点写进文档，不另加锁。

常量放进 `packages/shared`：`TAG_LIMITS = { tagChars: 32, perEntry: 8, perWorkspace: 200 }`。

**状态：已决定（2026-11-17，维护者按推荐定案）：按推荐数值（单个 tag 32 码点 / 每条 8 个 / 每 workspace 200 个）。**

### D-5 谁能写 tag，出处怎么记

- **A：只有用户（UI 编辑）。** agent 的 `upsert_entry` 不接受 `tags`：`tools.ts` 生成 schema 时去掉这个字段，room API 收到时回 400。
- **B：用户和 agent 都能写，不加限制。** 出处只靠 Git 提交的 `Author: agent`。
- **C：用户和 agent 都能写，但 agent 只能用已有的 tag。** 一个 tag 第一次出现必须来自用户（UI 编辑）。agent 写入本 workspace 还没有的 tag 时，room API 回 400：「新 tag 需要用户先在面板里创建」。

分析：B 最方便，但 agent 会按自己的措辞造出 `支付`、`付款`、`payment` 三个 tag，词表很快失去「共同的词」的意义。按 #45 的护栏，这还会把推断出来的分类摆成看似有出处的标签。A 最干净，但用户说「把这几条都标成支付」时，agent 做不了。C 让词表由人决定，打标签这件重复的活可以交给 agent。代价是 tag 第一次出现时要先去面板里加一次，这比较别扭。

无论选哪个，`upsert_entry` 省略 `tags` 时保留原值（与 `related` 相同），传 `[]` 时清空。

**推荐：C。**

**状态：已决定（2026-11-17，维护者按推荐定案）：选 C（agent 只能用已有的 tag；新 tag 须用户先在面板创建）。**

### D-6 tag 进不进 agent 看得到的索引，预算和截断规则

- **A：不进。** agent 要看 tag 时用 `list_entries`（它返回 `EntrySummary`，加上 `tags` 之后就能看到）。
- **B：只进一行词表。** `# 现有 tags` 段列出本 workspace 的不同 tag。
- **C：词表加逐条标注。** 词表段，再在 `# 现有条目索引` 的每一行后面加上该条的 tag。

**推荐：C，带下面的预算。** 如果 D-5 允许 agent 写 tag，它就需要看到词表，才能复用已有的 tag 而不是造近义词。逐条标注让「哪些条目是 `#支付`」不需要再调一次工具。

预算按 UTF-8 字节计，截断不切断字符，也不切断单个 tag。复用 `cutBytes` 的思路，但以整个 tag 为单位：

- **词表段**：`# 现有 tags` 下一行，`#a #b #c …`，按带该 tag 的 active 条目数降序，再按 tag 字典序。最多 2048 字节。放不下的部分写成 ` …（另有 N 个，用 list_entries 查看）`。
- **逐行**：只给 active 条目（不在 `INACTIVE_STATUSES` 里）的行加 ` | tags: a, b`。每行的 tag 部分最多 96 字节，放不下的 tag 写成 ` +N`。
- **逐行合计**：所有行的 tag 部分合计最多 4096 字节。分配顺序从索引的**最后一行往前**：`timeline` 按 `business_date asc, updated_at asc` 排序，最后的是最近的。预算用完后，更早的行不再加 tag，行本身照常保留。只要有一行被省掉了 tag，就在索引末尾加一行「部分条目的 tags 未列出，用 list_entries 或 read_entry 查看」。
- **没有任何 tag 时**：prompt 与今天逐字节相同，两段都不出现。要有测试。
- 最坏情况下这些规则一共给 prompt 增加约 6 KiB。条目索引本身今天没有预算，那不在本设计范围内（见「不在本期」）。

**状态：已决定（2026-11-17，维护者按推荐定案）：选 C（词表 + 逐条标注；预算 词表 2 KiB、逐行 96 B、合计 4 KiB，从最近条目往前分配）。**

### D-7 分享页公开不公开 tag

- **A：公开。** `PublicSummary` 增加 `tags`。tag 是对条目的标注，分享出去的标题和正文已经比 tag 多得多。
- **B：不公开。** tag 可能含内部代号或客户名。

分析：分享设计 D-6 公开了标题、正文和引用摘录，tag 不会增加新类别的信息。但公开投影是白名单，加字段等于修改那份设计已经审过的范围，测试里的「不出现」清单也要改。

**推荐：A，** 并在分享设计里补一行；公开页的列表可以用 tag 筛选（纯服务端渲染，不加脚本请求）。

**状态：已决定（2026-11-17，维护者按推荐定案）：选 A（公开，并同步更新分享设计）。**

### D-8 降级与旧 hub 改写导致 tag 丢失

今天的 hub 一旦重写带 `tags:` 的条目，就会把它删掉（见「现状」）。新版本无法改变已经发出去的旧版本。

- **A：接受，写进文档。** 降级后被旧 hub 改过的条目会失去 tag，Git 历史里还有，可以手工恢复。
- **B：A，再加一个新版本的「从历史恢复 tag」检查。** 启动回填时，如果某条目在 Git 历史中曾有 tag、而删掉 tag 的那次提交来自不认识 tag 的版本，就提示用户。代价：要读每条条目的历史，启动变慢，判断「哪个版本写的」也没有可靠的依据（提交信息里没有版本号）。
- **C：A，再让本版本起 `fromFile`/`toFile` 原样保留未知的顶层 frontmatter 键。** 这样下一个新字段不会被本版本删掉。它修不了今天已经发布的版本，但能让以后的格式扩展不再重复这个问题。

**推荐：C。** 未知键按读到的样子写回（只限顶层，保持 YAML 原值），不参与校验，不进入 `EntrySummary`。

**状态：已决定（2026-11-17，维护者按推荐定案）：选 C（本版起保留未知 frontmatter 键）。**

### D-9 面板筛选：单选还是多选

- **A：单选。** 筛选条上点一个 tag，「按类型」和「按时间」两种视图都只显示带这个 tag 的条目；再点一次取消。
- **B：多选，取交集。**
- **C：多选，取并集。**

**推荐：A。** 先确认人们怎么用，再决定要不要组合。筛选状态只放在组件里，切换 workspace 时清空，不写进 URL 或存储。

**状态：已决定（2026-11-17，维护者按推荐定案）：选 A（面板单选筛选）。**

## 数据模型

### frontmatter

```yaml
tags:
  - 支付
  - api
```

- `EntryFrontmatter.tags: z.array(z.string()).default([])`。读取时由 `fromFile` 先按 D-3 宽松清洗再交给 schema。`toFile` 只在非空时写 `tags`，这样没有 tag 的旧文件保持逐字节不变（与 `quotes` 的做法相同）。
- `UpsertEntryInput.tags: z.array(TagSchema).max(8).optional()`，按 D-3 严格校验。
- `EntrySummary.tags: string[]`，`summarizeEntry` 总是给出（可能是空数组）。
- 写入路径逐个核对：
  - `upsert` 写成 `tags: input.tags ?? existing?.tags ?? []`。
  - `writeDiagram` 保留 `existing?.tags ?? []`。
  - `createWorkPackage` 写 `[]`。
  - `withdraw`、`confirm`、`writeWorkPackageDoc`、`setWorkPackageMeta` 都从 `...existing` 展开，自然保留。
  - `sourceImport.ts` 从 `existing` 起 `EntryFrontmatter.parse`，同样保留。
  - 每一条都要有测试断言 tag 不丢。

### `entry_index`（按 D-2 的推荐）

```sql
alter table entry_index add column if not exists tags text[];
alter table entry_index add column if not exists tags_indexed_at timestamptz;
```

- `tags` 为 null 表示「还没从文件读过」，`'{}'` 表示「读过，没有 tag」。
- `indexEntry` 在同一条 upsert 里写 `tags = excluded.tags` 和 `tags_indexed_at = clock_timestamp()`，并让 `updated_at` 与它取同一个时刻（同一语句里两次 `clock_timestamp()` 不保证相等，所以用一个 CTE 或 `values` 先取一次再用）。
- 两列都**不**加进 `TABLE_COLUMNS`：快照不带它们，导入后它们是 null，由回填补上。新旧快照因此互相兼容，不会因为未知列被拒绝。

### 回填（可重复）

hub 启动时，在 `recoverUncommittedEntries` 之后、开始服务之前：

```sql
select distinct workspace_id from entry_index
 where tags_indexed_at is null or tags_indexed_at < updated_at;
```

- 对每个选出的 workspace，读一次 `KnowledgeStore.listEntries()`。这与面板打开一次的读取量相同。对需要的行按文件写 `tags` 与 `tags_indexed_at`。文件已不存在的行写 `'{}'`，以免下次启动再查。
- 新库、新导入的快照、降级回来的库，第一次启动都会走一遍；之后这条查询为空，启动只多一条 SQL。
- 旧 hub 在降级期间写过的行：旧 `indexEntry` 会更新 `updated_at` 但不碰 `tags_indexed_at`，于是满足 `tags_indexed_at < updated_at`，再次升级时会被重新读取。
- 一个 workspace 回填失败只记日志，不阻止启动。这与 `recoverUncommittedEntries` 和 `reconcileWorkspaceEvidence` 的处理方式相同。那个 workspace 的 tag 组和上限计数会暂时偏少。
- 桌面启动在意时长（P1-10）。实现时要在一个有 1000 条条目的 workspace 上量一次首次回填的耗时，记在 PR 里。超过 1 秒就改成服务开始后在后台跑，并让 tag 组在回填完成前返回空。

## 流程

### 写入（UI 与 agent）

- UI 编辑（`PUT /api/workspaces/:id/entries/:eid`）和 room `upsert_entry` 都走 `UpsertEntryInput`。规范化与单条上限在 schema 里检查，workspace 上限与 D-5 的规则在 hub 的 upsert 守卫里检查（仓库锁内）。
- 提交信息不新增字段。tag 的变化就是这次提交的文件差异，`Author:` 记录是谁。

### 面板

- 「按类型」和「按时间」视图的上方加一条筛选条：本 workspace 已加载条目里出现过的 tag，按 active 条目数降序。筛选在浏览器里对 `EntrySummary.tags` 进行，不加接口。
- 条目行在标题下用小号字显示该条的 tag，最多 3 个，其余写成 `+N`。
- 三语文案：筛选条标题、清除筛选、空结果。

### `@` 菜单的 tag 组

- `mention-context` 的成功体增加 `tags: { tag, active, inactive }[]`。每组最多 8 行，多取 1 行用来置 `truncated`。匹配复用现有的子序列正则与档位（对 tag 本身），平局时按 `active desc, tag asc`。旧 web 忽略这个字段。
- 组的顺序：条目、tag、附件、话题。
- 选中后按 D-1 的推荐展开：web 调 `GET /api/workspaces/:id/tags/:tag/entries`，返回 `{ entries: { id, kind, title, status }[] }`，只含 active 条目，按 kind 再按编号排序，不含正文。拿到的数量超过剩余的提及名额时，不插入，并给出 D-1 的提示。这条路由与 `mention-context` 一样在 `/api` 下，受同样的 workspace 隔离。
- 不新增 `#tag` 精确语法：在 `@` 后输入 tag 的文字，就按上面的匹配找到。

### 导出、导入与快照恢复

- 快照：tag 在知识文件里，随 Git bundle 搬运；`entry_index` 的两列不进快照，导入后由回填补上。
- 公开分享：按 D-7。
- 来源导入（`sourceImport.ts`）：重新导入同一来源时保留已有的 tag。

## 兼容

| 组合 | 行为 |
| --- | --- |
| 新 hub、旧文件 | 没有 `tags`，读成 `[]`；文件不被改写 |
| 旧 hub、新文件 | 读取时丢掉 `tags`，不报错；一旦改写这条条目，`tags` 从文件里消失（D-8） |
| 新 web、旧 hub | 编辑时带上的 `tags` 被丢弃；`mention-context` 没有 `tags` 组；D-1 的 A 只发普通条目提及，可以正常发送 |
| 旧 web、新 hub | 编辑时不带 `tags`，按「省略即保留」处理，不会清空 |
| 新 CLI、旧 hub | agent 传的 `tags` 被 `safeParse` 丢弃，返回的条目里也没有 `tags`。CLI 发现返回体里没有 tags 时，在工具结果里写明「hub 不支持 tags」，不让 agent 以为已经写进去了 |
| 旧 CLI、新 hub | agent 的工具里没有 `tags`，省略即保留 |

回滚：迁移只新增两列可空列，旧 hub 不读也不写它们。

## 失败与隐私边界

- tag 不授予任何访问权，也不改变分享范围。分享仍是整个知识库（分享设计 D-1）。
- tag 不进入日志正文。workspace 上限的错误信息只说上限，不列出其他 tag。
- 回填只读本 workspace 的知识仓库，不跨 workspace。
- 筛选和菜单只用 `entry_index` 与文件里已有的数据，不向 daemon 或模型发请求。

## 文档

实现时再改，本 spec 先定：

- 三语 `docs/guide.*.md` 写：怎么加 tag、面板筛选、在 `@` 里选 tag 会展开成哪些条目、20 个提及的上限、降级会丢 tag。
- README 的功能列表（`README.md` 与 `README.en.md` 逐字节相同，`README.zh.md`、`README.ja.md` 表达同一事实）。
- `docs/reference.zh-CN.md` 的条目格式与 `@` 提及两节。
- D-7 选 A 时，在分享设计的公开字段清单里补上 `tags`。
- `changelog.d` 片段在实现 PR 里写，不在本设计里写。

## 验收

以下是按本设计推出的验收条目。**审阅对照（2026-11-16，审阅者对照 #162 正文）**：issue 的四条验收——旧数据与旧快照能正常读回（要有能证伪的测试）、迁移可重复执行、`@` 菜单能按 tag 选中并把正确内容投递到 prompt、文档与 changelog 齐备——前三条分别由本节的无 tag 文件逐字节不变/旧快照导入/跨版本发送条目、回填幂等条目、tag 组展开与 prompt 预算条目覆盖；第四条是实现阶段的义务，不属于 spec 本身。issue「要做的事」六项（frontmatter 加 tag、索引加列、写入与导入导出、面板可筛、提及菜单 tag 组、prompt 索引段）在本文均有对应章节或 D 项。

- 规范化：`" ＡＰＩ "` 存成 `api`；`Payment Flow` 存成 `payment-flow`；`d-12`、`a[b]`、`#x`、33 个码点的 tag 都在写入时 400；同一条目里 `API` 与 `api` 只留一个。
- 上限：第 9 个 tag 400；第 201 个不同的 tag 在 workspace 内 400。
- 手改文件里放一个非法 tag：条目照常出现在面板、`timeline`、`list_entries` 里，非法 tag 被丢掉并打警告。
- 每条写入路径（UI 编辑、agent upsert、确认、撤回、开发包文档、开发包元数据、重画代码图、来源重新导入）都保留已有的 tag。agent 省略 `tags` 不会清空。
- 没有 tag 的旧文件读写一轮后逐字节不变。
- 回填：迁移后第一次启动，`entry_index` 的每一行都有非 null 的 `tags`；第二次启动没有行需要回填；模拟旧 hub 改动 `updated_at` 之后，再启动会重新读取。从快照导入的库启动后，tag 与文件一致。
- 快照：含 tag 的知识库导出后，导入到同版本，tag 保留；旧版本导出的快照能导入新版本；`entry_index` 的新列不在导出的 JSON 里。
- 面板：选中一个 tag 后两种视图都只剩带它的条目；切换 workspace 后筛选清空。
- `@` 菜单：tag 组按子序列匹配；选中后正文写入 `#tag：[…]`，`meta.mentions` 里只有 `entry` 类型；超过剩余名额时不插入，并显示提示；别的 workspace 的 tag 不出现。
- prompt：没有 tag 时与今天逐字节相同；有 tag 时词表不超过 2048 字节、逐行合计不超过 4096 字节，截断不切断字符或 tag，并出现「部分条目的 tags 未列出」那一行。
- D-5 选 C 时：agent 写入新 tag 回 400；写入已有的 tag 成功，提交的 `Author:` 是 `agent`。
- 跨版本：新 web 配旧 hub 时，带展开提及的消息照常发送。

## D 项汇总

| id | 问题 | 选项 | 推荐 | 状态 |
| --- | --- | --- | --- | --- |
| D-1 | 在 `@` 里选中 tag 交给 agent 什么 | A 在输入框里展开成逐条的条目提及；B 新增 `tag` 提及类型，发 prompt 时再解析 | A（只展开 active 条目，超过名额就不插入并提示） | 已决定（2026-11-17，按推荐） |
| D-2 | `entry_index` 的存法 | 数组列 `tags text[]`；关联表 `entry_tags` | 数组列，加 `tags_indexed_at` | 已决定（2026-11-17，按推荐） |
| D-3 | 规范化 | NFKC、去空白、空白换 `-`、小写折叠、字符集、禁止 id 形状、去重；或保留显示大小写 | 只存折叠后的一种形式 | 已决定（2026-11-17，按推荐） |
| D-4 | 上限 | 单个 tag 32 码点 / 每条 8 个 / 每个 workspace 200 个，或其他数值 | 32 / 8 / 200 | 已决定（2026-11-17，按推荐） |
| D-5 | 谁能写 tag | A 只有用户；B 用户和 agent 都能写；C agent 只能用已有的 tag | C | 已决定（2026-11-17，按推荐） |
| D-6 | tag 进不进 agent 的索引 | A 不进；B 只进词表；C 词表加逐条标注 | C：词表 2 KiB，逐行 96 B，合计 4 KiB，从最近的条目往前分配 | 已决定（2026-11-17，按推荐） |
| D-7 | 分享页公开 tag 吗 | A 公开；B 不公开 | A，同时更新分享设计 | 已决定（2026-11-17，按推荐） |
| D-8 | 旧 hub 改写时 tag 丢失 | A 接受并写进文档；B 加从历史恢复的检查；C 从本版本起保留未知的 frontmatter 键 | C | 已决定（2026-11-17，按推荐） |
| D-9 | 面板筛选 | A 单选；B 多选取交集；C 多选取并集 | A | 已决定（2026-11-17，按推荐） |

## 不在本期

tag 的重命名与合并、别名、层级、按 tag 授权或分享、`#tag` 精确语法、tag 的全文检索、给条目索引本身加字节预算（今天的 `# 现有条目索引` 没有预算，这是已有的问题，应该单独立项）、从 Git 历史自动恢复 tag。
