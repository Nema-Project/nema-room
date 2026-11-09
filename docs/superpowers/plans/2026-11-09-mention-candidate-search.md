# 提及候选的服务端搜索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：未动手。** 本文件写在设计 PR 里。设计 PR 不改产品代码。下面的批次等规格被按这个计划实现时再做。

**Goal:** `@` 菜单在条目、话题或已发送附件超过现有池时仍能按子序列找到目标。匹配在 hub 的 SQL 里完成。附件最多 `stat` 50 次，跳过缺失文件。没找完的结果不进 30 秒缓存，也不显示成没有匹配。

**Architecture:**

- **hub：** `mentionContext` 不再先取 500/50 再在进程里打分。非空查询用 SQL `lower`、转义后的子序列正则和 UTF-16 长度排序，每组最多返回 8 行。附件按这个顺序最多 `stat` 50 次。
- **web：** `groupCandidates` 保持 hub 的顺序。Composer 用 workspace 加查询做缓存键，abort 过期请求，并且不缓存 `attachmentBudgetExhausted`。空菜单在没找完时用 `mention.notFinished`。

**Tech Stack:** TypeScript、Hono、Next.js、Vitest、现有的 PGlite 测试库。不新增依赖，不加数据库迁移。

**Spec:** [提及候选的服务端搜索](../specs/2026-11-07-mention-candidate-search-design.md)。实验记录在 [同日基准](../specs/2026-11-07-mention-candidate-search-benchmark.md)。

**Issue:** [#195](https://github.com/Nema-Project/nema-room/issues/195)。PR 正文用 `Refs #195`，不用 `Fixes`。不改这个 issue 的 milestone。

**Base:** 设计核对的 `origin/main` 是 `9b8a4287fdde3f3d52721ee43ede19c61b1e0772`。动手前先 `git fetch origin main`，再看这些文件有没有改动：

```
git diff --name-only 9b8a4287fdde3f3d52721ee43ede19c61b1e0772..origin/main -- apps/hub/src/mentionContext.ts apps/hub/src/attachments.ts apps/hub/test/mentionContext.test.ts apps/web/lib/mentions.ts apps/web/lib/hub.ts apps/web/components/Composer.tsx apps/web/components/MentionMenu.tsx apps/web/messages/en.json apps/web/messages/zh.json apps/web/messages/ja.json docs/reference.zh-CN.md
```

有改动就先重读。和规格「现状」不一致时，先改本计划再动手。

## 如何服务 #45

人在一句话里点名一条知识、一份已发送的文件或一个话题时，菜单要能找到那一项，包括它不在最近 500 条里。找到的仍是用户指定的指针，不是决定，也不产生 `verified`。

## Global Constraints

- 不实现 tag、成员提及、话题或附件的新精确 id 语法。
- 不加 `pg_trgm`、全文检索、匹配索引、函数迁移或表迁移。不把整个 workspace 读进 hub 进程。
- 查询文本不拼进 SQL。NUL 和超过 200 字的 `q` 在进 SQL 之前拒绝。模式不用 `String.prototype.toLowerCase` 构造。
- 不改 `apps/hub/src/attachments.ts` 里 `available` 对其他调用方的含义。提及路径按 id 逐个调用它，自己数到 50 次为止。
- 不碰只读分享那一支改过的 `ROADMAP.md`、`docs/superpowers/plans/2026-11-04-readonly-knowledge-share.md`、`docs/superpowers/specs/2026-11-04-readonly-knowledge-share-design.md`。
- 不把 P2-02 标成完成。基准数字不是响应时间承诺，也不是「不比现在慢」的验收。
- 测试不联网，不调用模型，只用临时库和假文件。hub 批次跑 `npx vitest run apps/hub/test/mentionContext.test.ts`。web 批次跑对应的 Vitest 文件，再跑 `npm run lint -w apps/web`。
- 新文案只加规格里的 `mention.notFinished`，三种语言一起改。README 和 guide 不改。
- 提交说明用英文。

## 文件结构

| 文件 | 职责 | 批次 |
| --- | --- | --- |
| `apps/hub/test/mentionContext.test.ts` | 池外目标、隔离、子序列、折叠、附件预算 | M1 |
| `apps/hub/src/mentionContext.ts` | SQL 搜索、`stat` 预算、`attachmentBudgetExhausted` | M1 |
| `apps/web/test/mentions.test.ts` | 菜单保持 hub 顺序 | M2 |
| `apps/web/test/Composer.test.tsx` | abort、缓存键、不缓存没找完的结果、新句子 | M2 |
| `apps/web/lib/mentions.ts` | 响应字段；`groupCandidates` 不再打分 | M2 |
| `apps/web/lib/hub.ts` | `searchMentionContext` 接受 `AbortSignal` | M2 |
| `apps/web/components/Composer.tsx` | debounce、abort、缓存 | M2 |
| `apps/web/components/MentionMenu.tsx` | 没找完的空菜单 | M2 |
| `apps/web/messages/{en,zh,ja}.json` | `mention.notFinished` | M3 |
| `docs/reference.zh-CN.md` | 候选一段改成搜索 | M3 |
| `changelog.d/mention-candidate-search.changed.md` | 用户可见行为 | M3 |

## M1：hub

测试先写，看到失败再改 `mentionContext.ts`。

- [ ] **失败的测试。** 在 `mentionContext.test.ts` 加上规格「回归」里的 hub 条。至少包括：501 条里最旧的独特标题；另一个 workspace 的同名行不出现；`发流` 命中池外的 `甲发中流乙`；`abc` 命中 `a.b*c`；`.*` 同时命中 `a.b*c` 和含连续 `.*` 的标题，不命中无关标题；`%` 和 `_` 不匹配所有标题；查询 `İ` 返回标题 `i` 和 `İstanbul`；查询 `ß` 命中 `straße`，查询 `ss` 不命中；同一档 `abcd` 在 `a😀😀` 前面；40 个附件里最新 16 个缺失时能返回后面的文件且不超过 8 个；最新 50 个缺失且第 51 个还在时附件组为空、两个标志都是 true，响应里没有第 51 个 id；恰好 50 个全部缺失时 `attachmentBudgetExhausted` 为 false；9 条命中只返回 8 条且该字段为 false；NUL 仍是 400。跑 `npx vitest run apps/hub/test/mentionContext.test.ts`，新断言失败。
- [ ] **SQL。** 非空查询先 `select lower($1)`，用返回字符串的每个码点做转义，`.*` 连接后作为参数。列侧是 `lower(比较文本) ~ $3`。比较文本：条目 `entry_id || ' ' || title`，附件 `name`，话题 `title`。精确 id 是 `lower(entry_id) = lower($1)`，排在档位之前。段前缀用 `strpos`，不是正则。更短优先是 `(octet_length(convert_to(folded, 'UTF16')) - 2) / 2`。同一条测试断言这个数等于 JavaScript 对 `abcd` 和 `a😀😀` 的 `String.length`。PGlite 上对不上就改式子，不改回 `char_length`，也不换线性函数。
- [ ] **行数。** 条目和话题 `LIMIT 9`，多出的一行只用来置 `truncated`，不返回。空查询不加谓词，按现有时间顺序取 8 行，条目和话题超过 8 时 `truncated` 为 true。`MENTION_POOL` 不再出现在这条路径上。
- [ ] **附件。** 按同一排序取最多 51 个已发送附件的 id。从前往后调用现有的 `available(workspaceId, [id])`，缺的跳过，凑满 8 个还在的文件或调用满 50 次就停。第 51 个只在前 50 次用完之后用来判断后面还有没有行，不对它 `stat`，也不返回它。用满 50 次且还有剩余行时，`truncated` 和 `attachmentBudgetExhausted` 都是 true。否则该字段为 false。`truncated` 在任一组还有没返回的匹配时也为 true。
- [ ] 再跑上面的 Vitest 文件，新断言通过。不改发送、编辑和 prompt。

## M2：web

测试先写，看到失败再改菜单。

- [ ] **失败的测试。** `mentions.test.ts`：hub 给出的非空顺序原样变成菜单，包括 `fuzzyScore` 会给 null 的行；空查询不再按 `lastReplyAt` 重排。`Composer.test.tsx`：缓存键含 workspace id；较慢的旧查询不能覆盖较新结果，也不能写入缓存；未返回时 Enter 不选上一次的行；`searchMentionContext` 的第三次参数是 `AbortSignal`，查询变化时 abort；`attachmentBudgetExhausted: true` 不进缓存；只因超过 8 行而 `truncated: true` 的结果仍进缓存；三组都空且该字段为 true 时菜单文本是 `mention.notFinished`，不是 `mention.noMatch`。先跑这两个测试文件，新断言失败。
- [ ] **顺序。** `MentionContextResponse` 增加 `attachmentBudgetExhausted: boolean`。`groupCandidates` 对空查询和非空查询都按响应里的数组顺序取，每组最多 8 行，不调用 `fuzzyScore`。
- [ ] **请求。** `request` 增加可选的 `signal`，只有提及这条调用传它，别的调用不变。`searchMentionContext(id, q, signal?)` 把 signal 交给 `fetch`。
- [ ] **Composer。** 缓存键是 workspace id 加 `trim` 后的查询。未命中时先清空上一次的 context。150ms 之后发请求。effect 清理时 abort。响应写菜单或缓存之前，workspace 和查询必须仍是这一对。`attachmentBudgetExhausted` 为 true 时不 `cache.set`。失败只在这次请求仍是当前请求时把状态设为 `failed`。
- [ ] **菜单。** `MentionMenu` 在没有任何行、查询非空、且 `attachmentBudgetExhausted` 为 true 时用 `mention.notFinished`。找完的空结果仍用 `mention.noMatch`。加载中和失败不变。有行时只渲染那些行。
- [ ] 再跑这两个测试文件，新断言通过。

## M3：文案和参考

- [ ] 三份 `apps/web/messages/*.json` 加上同一键，句子与规格表格一致，不改别的键：
  - zh：`还在检查「{query}」的文件，这不是一份找完的结果。`
  - en：`Still checking files for “{query}”. This is not a finished result.`
  - ja：`「{query}」のファイルをまだ確認しています。これは探し終わった結果ではありません。`
- [ ] `docs/reference.zh-CN.md` 的「`@` 提及」候选段改成：查询在 SQL 里按子序列搜索，不再先取 500 或 50；`truncated` 表示菜单不是全部匹配，或附件 `stat` 用满 50 次且后面还有行；`attachmentBudgetExhausted` 只表示后一种；返回前对排序后的附件最多 `stat` 50 次，跳过缺失文件，直到 8 个还在的文件。不写响应时间承诺。
- [ ] 新增 `changelog.d/mention-candidate-search.changed.md`，一段中文，说明超过原来的候选池仍能用 `@` 搜到条目、话题和已发送的文件，缺失文件会跳过，没找完时菜单不会说成没有匹配。
- [ ] `npm run lint -w apps/web`。README、guide、milestone、tag 都不改。
