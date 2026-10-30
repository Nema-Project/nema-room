# 输入框 `@` 提及上下文

- **Issue：** [#136](https://github.com/Nema-Project/nema-room/issues/136)
- **相关：** [#104](https://github.com/Nema-Project/nema-room/issues/104)（聊天附件，本设计借用它的投递通道、托盘样式和 prompt 行写法）；[#75](https://github.com/Nema-Project/nema-room/issues/75)（Skills；S6（D-5）定为 `/skill:名字` 手动调用，`@` 留给提及）
- **目标版本：** v0.2.0。用户接受 v0.2.0 因此推迟约一周（2026-10-31）
- **核对基线：** `origin/main` `194ba26`（Merge pull request #141）
- **决定：** 用户在 2026-10-31 定了 D1–D9，全部按 #136 的推荐；同一天 01:34 JST 重新划定了范围（见下）。D10–D12 待定，见文末。

## 范围修订（2026-10-31 01:34 JST）

`@` 提及只针对**工作区里的上下文**，范围不超出 Nema workspace 本身：

- 工作区附件：已经上传并随消息发送过的图片、PDF 和文本文件。
- 知识库条目：右侧知识面板里的条目；以及 tag（现在还没有这个字段，见 D10）。
- 工作区成员（现在还没有成员模型，见 D11）。
- 话题：原 D1 定的第三类。新范围里没有点名，按 D12 待确认。

**取消**「绑定仓库里的文件路径」提及：coding agent 自己能列目录、读文件，仓库文件不属于工作区上下文，也不需要 hub 代它读。原计划里为此新增的 daemon RPC `repo.files`、`repo.head` 和 hub 的 `mention-files` 路由一并取消（`#142` 按用户指示停在原处，不自行关闭），`code__read` 的 `ref` 也取消。

已经合并且与新范围不冲突的：M0 的数据契约骨架（`MENTION_LIMITS`、`MessageMention`、`mentionText`、`keepMentionsFor`、`fuzzyScore`）与 M3 的 `[W-n]` 链接。契约里 `file` 这一支要按新范围改成 `attachment`，作为新的第一批。

## 如何服务 #45

按 [#45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准衡量，`@` 提及能让人和 agent 更容易对同一份有依据的理解达成一致：

- **讨论挂在依据上：** 用户可以在一句话里明确指出"按 [D-12] 来"或"看这张图"。agent 拿到的是条目原文和工作区里已有的文件，不靠猜。
- **可核对：** 提及以结构化记录存在消息上。附件记为附件 id，条目记 id，事后能回答"当时让 agent 看的是哪一份"。
- **分清来源：** 提及只是用户指定的上下文，不是用户的决定。被提及的条目保持原来的状态和 `basis`，提及动作本身不改变任何条目，也不产生 `verified`。
- **不越权：** 不给 agent 新的读取能力。附件仍走已有的投递通道，条目仍走 `read_entry`，都不引入新的访问面。

本设计不把 Nema Room 变成编辑器、文件浏览器或多人服务：不提供文件树，不读仓库内容，不新建身份系统（成员提及要等身份模型，见 D11）。

## 现状（已核对）

1. **附件已经有完整的通道。** `message_attachments`（`apps/hub/src/db/migrations/014_message_attachments.sql`）按 workspace 和 message 存元数据，`status` 有 `staged`/`attached`/`deleted`/`missing`/`expired`；`listAttachmentsForMessages`（`apps/hub/src/attachments.ts:142`）按消息取回，`toAttachmentRef`（`:110`）转成 `AttachmentRef`。投递集合由 `deliverySet(db, taskId)` 决定，`task.assign` 每任务最多 8 个、合计 32 MiB（`ATTACHMENT_LIMITS`，`packages/shared/src/attachments.ts:9-18`）。daemon 用 `loadTaskAttachments` 下载并校验（`apps/cli/src/attachments/fetch.ts:35`）。
2. **条目有类型和状态，没有 tag。** 7 种类型 `ENTRY_KINDS`，前缀 R/D/T/Q/S/G/W（`packages/shared/src/entry.ts:5,93-101`），`ID_RE`（`:103`），状态见 `KIND_STATUSES`（`:114`）。`EntryFrontmatter`（`:175` 起）没有 tag 字段，`entry_index` 也只有 kind/title/status/priority/business_date/updated_at（`apps/hub/src/entryIndex.ts:9-16`），右侧面板按 kind 分组（`apps/web/components/KnowledgePanel.tsx:15`）。
3. **没有成员模型。** 迁移里没有 users / members 表；`messages.role` 只有 `user`/`agent`/`system`/`report`（`001_init.sql:11`），消息上没有用户 id；`threads.opened_by` 是 `user`/`agent`/`grill`。hub 的登录只有一个可选的单用户中间件 `uiAuth`（`apps/hub/src/app.ts:31,83`），`apps/local` 用它挡住网关外的请求。ROADMAP 的 P2-04「团队只读访问」仍是待办，前置是"先设计身份、授权、撤销与审计"。
4. **消息怎么存、怎么发。** 三个发送入口（新建话题 `uiApi.ts:439-445`、话题内回复 `:464-470`、主聊天 `:543-549`）共用 `PostMessageBody`（`uiApi.ts:79-87`），最后都走 `postUserMessage`（`apps/hub/src/messages.ts:161`）。编辑走 `EditMessageBody = z.strictObject({ content })`（`uiApi.ts:89`）和 `editUserMessage`（`messages.ts:268`）。`messages.meta` 是 `jsonb`，`UserMessageMeta` 现在只有 `quote`，是"结构化引用放在 meta 里"的先例。
5. **prompt 怎么拼。** `buildPrompt`（`prompt.ts:96`）由 `daemonSocket.ts:186` 调用。段落顺序：规则、Workspace、条目索引（只有 id 和标题）、thread 锚点、最近消息、引用消息（`:226-228`）、本次用户消息（`:230-233`）。附件每个一行（`prompt.ts:50-57`）。
6. **输入框。** 普通 `<textarea>`（`apps/web/components/Composer.tsx:205`），`onSend(content, attachmentIds)`（`:33`）。`/` 菜单只认行首（`apps/web/lib/slash.ts:26-31`）。调用方是 `Chat.tsx:355` 和 `ThreadView.tsx:213`。
7. **web 看得见什么。** 附件只能按消息取（`GET /api/workspaces/:id/messages` 里带 `attachments`），没有"这个 workspace 发过哪些附件"的列表接口；条目走 `GET /workspaces/:id/entries`（`uiApi.ts:660`）和 `timeline`（`:667`）；话题走 `GET /workspaces/:id/threads`（`:428`）。新范围需要的候选数据，大部分已经在 web 手里，只缺工作区附件列表。

## 社区做法对照（2026-10-30 抓取）

完整表格和一手链接见 [#136](https://github.com/Nema-Project/nema-room/issues/136) 第二节。本设计用到的结论：

- **一个分组菜单：** Cursor、Zed、Linear、Continue.dev 都是一个 `@` 菜单，按类别分组。Linear 支持 `@ENG-123` 精确引用，这里对应 `@D-12`。
- **条目内联：** 条目短，是对齐的核心，所以内联正文；Continue.dev 的 context provider 也是返回 `content` 再注入。
- **结构化存储：** Slack 在正文里存 `<@U…>` 这样的 id，Zed 用结构化提及。Nema 的正文保留可读文本，结构另存在 meta 里（D4）。
- **文件类上下文给引用而非全文：** Codex CLI 的 `@` 只插入路径（[PR #1401](https://github.com/openai/codex/pull/1401)）；Claude Code、Copilot、Gemini CLI 会注入全文，但都要处理"放不下"。Nema 的附件本来就有投递通道（按字节、有上限），所以提及附件等于"把这个已有文件加进本次投递"，不需要新的读取能力。

### 偏离主流的地方和理由

- **只做工作区内的对象。** 主流 `@` 菜单里最大的一类是代码文件；Nema 的 coding agent 在同一台机器上有自己的工具，仓库不在 workspace 里，所以不做。
- **不支持目录、符号、diff、URL 和单条消息。** v0.2.0 只做工作区内的几类对象。
- **成员提及不以"假身份"充数。** 没有身份模型就不显示一个只能选自己的成员组（见 D11）。

## 设计

### 1. 数据契约（D4）

`packages/shared/src/mentions.ts`（M0 已建），由 `workspace.ts` 用 `export * from "./mentions.js"` 转出，不改 `packages/shared/src/index.ts`。

```ts
export const MENTION_LIMITS = {
  perMessage: 20,
  entryBytes: 4096,        // 每条条目正文上限，按 UTF-8 字节
  entriesTotalBytes: 16384,
  attachmentCandidates: 50,
  menuPerGroup: 8,
  threadAnchorBytes: 1024,
} as const;

export const MessageMention = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entry"), id: z.string().regex(/^(R|D|T|Q|S|G|W)-[1-9]\d*$/), text: MentionTextSchema }),
  z.object({ type: z.literal("attachment"), id: z.string().min(1), text: MentionTextSchema }),
  z.object({ type: z.literal("thread"), id: z.string().min(1), text: MentionTextSchema }),
]);
// MentionTextSchema = z.string().min(1).max(256)：附件名最长 200 字符，加 `附件：` 前缀与反引号围栏仍有余量。
// UserMessageMeta gains: mentions: z.array(MessageMention).max(MENTION_LIMITS.perMessage).optional()
export function mentionText(m: MessageMention, labels: { attachmentName?: string; threadTitle?: string }): string;
export function fuzzyScore(query: string, candidate: string): number | null; // null = no match
```

- **正文里的可读文本：**
  - 条目写 `[D-12]`，沿用现有链接渲染。
  - 附件写 `` `附件：截图 1.png` ``；名字含反引号时用更长的围栏（CommonMark 代码段规则，M0 的 `codeSpan` 复用）。
  - 话题写 `[话题：标题]`。
  - 正文是给人看的，hub 和 agent 只认 `meta.mentions`。
- **存下可读文本：** 每个提及带 `text`，即插入正文时的原文。之后附件改名、话题标题改了，旧消息的提及仍按当时的 `text` 对应正文。
- **出现次数与元数据一一对应：** 一个提及对应正文里的一处 `text`。同一段 `text` 在 `mentions` 里出现 k 次，正文里就必须至少出现 k 次，否则 hub 回 400。构建 prompt 时同一对象只展开一次。
- **校验位置：** hub 在 `postUserMessage` 里校验并写入：
  - 条目必须存在于本 workspace。
  - 附件必须是本 workspace 里 `status = attached` 的附件（不接受 staged、已删除或别的工作区的）。
  - 话题必须属于本 workspace。
  - 任何一项不通过都回 400，消息不写入。
- **编辑：** `EditMessageBody` 仍只收 `content`。`editUserMessage` 用存下的 `text` 计数，按原顺序保留前 min(n, k) 个（M0 的 `keepMentionsFor`）。重跑的任务按保留下来的提及构建 prompt。web 端的 `syncMentions` 用同一套规则。
- **重放：** `lockForSend` 的重放比较加入提及：按 `type`、id 和 `text` 依次比较。提及不同就按冲突回 409，不当作重放。

### 2. 候选来源（D7、D8 修订）

新范围不需要 daemon：候选全部在 hub 手里。

- **hub 路由 `GET /api/workspaces/:id/mention-context?q=<query>`**（新文件 `apps/hub/src/mentionContext.ts`，在 `app.ts` 里挂载，不改 `uiApi.ts`）。返回三类候选，各自最多 `MENTION_LIMITS.menuPerGroup` 条：
  - `entries`：本 workspace 的条目摘要（id、kind、title、status），从 `entry_index` 读，按 `fuzzyScore` 排序；查询完全等于某个 id 时该条排第一。
  - `attachments`：本 workspace 里 `status = attached` 的附件（id、name、kind、size、消息 id、时间），按时间倒序，最多 `attachmentCandidates` 条后截断。
  - `threads`：本 workspace 的话题（id、title、`lastReplyAt`）。
  - 返回 `{ status: "ok", entries, attachments, threads, truncated }`。没有 daemon 依赖，所以没有 `offline`/`unsupported`：附件和条目都在 hub 里。
  - 只返回名称和 id，不返回附件字节；`q` 为空时条目按最近更新、附件按时间倒序、话题按 `lastReplyAt`，不返回全量。
- 前端也可以直接用已有的 `listEntries`/`listThreads`，本路由把三类合成一次请求，省得菜单打开时打三个接口；以它为准，30 秒内复用同一查询。

### 3. 交给 agent（D2、D3 修订）

hub 新增 `apps/hub/src/mentions.ts`：

- `validateMentions(...)`：供 `postUserMessage` 调用。
- `resolveMentions(...)`：供 `daemonSocket.ts` 构建 prompt 时调用。

`buildPrompt` 新增可选输入 `mentions`，在"本次消息引用的消息"之后、"本次用户消息"之前加一段：

```
# 本次提及的上下文
以下是用户在本条消息里用 @ 明确指定的上下文。它是用户给的参考，不是用户的决定。
## 条目 [D-12] <标题>（decision，active）
<正文，按 UTF-8 字节截断到 4 KiB；截断时末尾写「（已截断，完整内容用 read_entry D-12 读取）」>
## 条目 [D-13] <标题>：超出本次预算，用 read_entry 读取
## 条目 [R-9]：已不存在
## 附件「截图 1.png」（image，message msg_42）
已随本任务投递，不需要再读取。
## 话题「<标题>」
[<锚点消息 id>] <role>: <锚点正文，截断到 1 KiB>
需要更多上下文时请用户在该话题里继续，或引用具体消息。
```

- **条目预算：** 每条 4 KiB 字节、合计 16 KiB，按出现顺序填；超出的条目只给 id 和标题，由 agent 用 `read_entry` 自己读。截断不能切断多字节字符。
- **附件：** prompt 里只写名字、类型和来源消息 id，字节走已有的 `task.assign.attachments`。
- **话题：** 只给标题和锚点（锚点正文截断到 1 KiB），不展开整段回复。
- **其他：** 提及的段落不计入附件的数量或大小限制；只有当前这条用户消息的提及进入 prompt。

### 4. 附件提及的投递（D2）

被提及的附件**必须真的送到 agent**，否则 prompt 里写着"已投递"就是假的。

- hub 在 `deliverySet` 之外，把本条消息提及的附件按 id 加入本次任务的投递集合，顺序是：本条消息自己的附件，然后按提及顺序。
- 仍然受 `ATTACHMENT_LIMITS`（每任务 8 个、合计 32 MiB）约束。超过时**在发送处回 400**，说明是哪一条附件让总数超限，消息不写入；不静默丢弃，也不截断。
- 附件在发送后被删除（`status = deleted`）时，提及按 `text` 计数照常保留，但投递集合里没有它；prompt 的那一行写「该附件已删除，内容不可用」，与附件的墓碑语义一致。
- 提及不会重复投递同一个附件：本条消息已带的附件再被提及只出现一次。

### 5. W marker（D9，已合并）

`Markdown.tsx:9` 是 `[RDTQSGW]`，`[W-n]` 渲染成 `nema-entry:` 链接，点击行为与其他条目相同（PR #139）。`wpFormat.ts` 的 MARKER 不变，因为那是开发包格式协议（AGENTS.md）。

### 6. 输入框（D6、D7）

- **触发：** 光标前最近的 `@` 位于行首、空白之后，或 `（(「『，。、：` 之后，且 `@` 到光标之间没有空白（最多 100 个字符）时打开菜单。
  - `a@b` 这样的邮箱写法不触发；光标在代码块里不触发。
  - `/` 菜单仍只在行首触发；两个菜单同一时间只开一个。
- **分组与排序：** 依次是条目、附件、话题（成员等 D11），每组最多 8 条；条目和附件在前端用 `fuzzyScore` 过滤。
- **选中：** 把 `@query` 换成可读文本加一个空格，并在本地提及列表里加一条。
  - 托盘用附件 chip 的样式显示提及，点 × 时同时删掉正文里那段文本。
  - 正文里那段文本被改掉或删掉时，对应的提及自动移除。
- **键盘：** 沿用 `/` 菜单：↑↓ 选择，Enter/Tab 选中，Esc 关闭；菜单关闭时 Enter 换行，Shift+Enter 发送。
- **发送：** `onSend(content, attachmentIds, mentions)`；`/thread` 新建话题时也带上提及。只有提及、没有正文时不能发送（与现在一样）。
- **不可用时：** 附件组为空时提示"还没有可提及的附件"；条目组为空时提示"知识库里还没有条目"。成员组在 D11 定下来之前不显示。

### 7. 成员提及（D11 待定）

要能提及成员，先得有身份，现在完全没有。缺的东西：

1. `users`（或 `members`）表：至少 id、显示名；本机单用户场景下由一个"本地用户"起步。
2. `workspace_members`：谁属于哪个 workspace，带角色（现在所有 API 都不区分人）。
3. `messages.author_user_id`（可空，兼容旧消息）：谁发的消息，成员提及才有意义。
4. `uiAuth` 从"单用户闸门"变成能给出身份的认证；`apps/local` 的网关凭据要能映射到用户。
5. 提及语义：成员提及在 prompt 里是"这条消息面向谁"，还是"引用某人说过的话"？前者更接近 Slack 的 `@人`，但 Nema 目前是人和 agent 对话，没有旁观者。

这些属于 ROADMAP 的 P2-04（团队只读访问）前置。推荐这一轮不做（见 D11）。

## 安全与边界

- web 只拿到附件的名字、类型和 id，拿不到内容以外的任何东西；hub 不因为提及而读仓库或文件系统。
- 提及的附件必须属于本 workspace 且已发送，不能引用别人 workspace 的附件 id。
- 提及校验在 hub 端完成，`repoId` 这一类参数已经随文件提及一起退出范围。
- 提及不改变条目状态、`basis` 和 `verified`，也不授权任何写入。
- 投递上限不因为提及而放宽：超过 8 个或 32 MiB 就拒绝发送。

## 兼容与恢复

- **数据库：** 不加迁移，`mentions` 存在已有的 `messages.meta` jsonb 里。旧 hub 读到时会丢掉未知字段，不报错；回滚只会失去提及。
- **协议：** `task.assign` 结构不变；被提及的附件只是让 `attachments` 数组里多几项。
- **版本搭配：** 新 web + 旧 hub：`PostMessageBody` 不是 strict，`mentions` 被丢弃，消息照常发送。旧 web + 新 hub：没有提及，行为不变。

## 测试策略

按 TDD 写测试，只用临时数据库和假数据，不调用真实模型、不联网。

- **shared：** schema 的合法与非法输入；`mentionText`；`fuzzyScore`；`keepMentionsFor`。
- **hub：**
  - 候选路由：三类合并、最多 50 个附件、空查询、别的工作区的附件不出现、不含字节。
  - 三个发送入口都能写入提及；别的工作区的条目、附件、话题回 400 且消息不写入；`text` 出现次数不够回 400。
  - 附件提及进入投递集合；超过 8 个或 32 MiB 回 400；重复提及只投递一次；已删除附件不出现在投递里。
  - 编辑后按 `text` 计数过滤；提及不同时重放回 409。
  - prompt 段落顺序、4 KiB 字节预算、截断不切断多字节字符、已删除条目标注、话题只给锚点。
- **web：** `@` 触发规则；分组和排序；选中后的正文和 chip；删掉文本后提及移除；`/` 与 `@` 共存；发送带上提及。
- **真实环境验收：** 一次性环境，两种运行方式，确认 agent 引用了条目正文里的原句、读到了被提及的附件。

## 分批计划概要

详见 [实现计划](../plans/2026-10-31-mentions.md)。

- **可以提前做**（不碰 Skills 各批文件）：M0a 契约修订（`file` → `attachment`）、M1 候选路由、M2 hub 校验/投递/prompt。
- **必须在 Skills S6 合并后做：** M3 输入框（同改 `Composer.tsx`、`slash.ts`、`hub.ts`、文案），M4 文档与 changelog（同改 `docs/guide.*.md`）。
- **最后：** M5 真实环境验收。
- **工作量：** 约 3–3.5 人日（比原计划少，去掉了 daemon 与仓库文件部分）。

## 反目标

- 不做文件树页面、文件预览、仓库文件提及，不在 hub 存仓库内容。
- 不注入文件全文；附件按既有投递通道送。
- 不提及目录、符号、diff、URL 或单条消息（v0.2.0）。
- 不按 tag 提及，除非 D10 决定先加 tag 字段。
- 不新建身份系统来支撑成员提及；等 P2-04 的身份设计（D11）。
- 不改 Skills 的 `/` 菜单规则，不改 `wpFormat.ts` 的开发包格式。
- 提及不是决定，不改变任何条目状态。

## 已决定的事项

**2026-10-31 JST（用户批准 #136 的 D1–D9，全部按推荐；记录见 [#136 评论](https://github.com/Nema-Project/nema-room/issues/136#issuecomment-6526104590)）**

- **D1 范围：** v0.2.0 做文件、知识条目、话题三类，话题留在 v0.2.0。**（文件一类已由 01:34 的范围修订改为工作区附件。）**
- **D2 文件交付：** 只给引用，由 agent 自己读。**（修订：附件走既有投递通道，真的送到 agent。）**
- **D3 条目交付：** 内联正文，每条 4 KiB 字节、合计 16 KiB，超出的只给 id。
- **D4 序列化：** 结构化记录存在 `UserMessageMeta.mentions`，正文保留可读文本。
- **D5 快照/最新：** 文件记录发送时的提交号，`code__read` 加可选 `ref`。**（已取消：不再有仓库文件提及。）**
- **D6 与附件：** 提及是独立模型，只共用托盘 chip 和 prompt 行写法。**（修订：附件提及复用投递通道。）**
- **D7 菜单：** 一个 `@` 分组菜单加模糊搜索，支持 `@D-12` 精确输入。
- **D8 文件列表：** daemon RPC 加 hub 侧模糊查询，最多 50 条。**（已取消，改为 hub 内的候选路由。）**
- **D9 W marker：** `[W-n]` 渲染成链接，也能被提及（PR #139）。

**2026-10-31 01:19 JST（四个细节，记录见 [#136 评论](https://github.com/Nema-Project/nema-room/issues/136#issuecomment-6527664345)）**

- 发送时 daemon 不在线：附件提及照常（附件在 hub 里），不拒绝发送。
- 知识条目每条按 4 KiB **字节**算；超出的只给 id。
- 话题只带标题和锚点，不带回复内容。
- 文档：guide 与 README 功能列表都要写。

**2026-10-31 01:34 JST（范围修订，记录见 [#136 评论](https://github.com/Nema-Project/nema-room/issues/136#issuecomment-6527997406)）**

- `@` 只针对工作区内的上下文：附件、知识条目与 tag、工作区成员。
- 取消仓库文件路径提及，一并取消 `repo.files`、`repo.head`、`mention-files` 路由和 `code__read` 的 `ref`。

## 待定的事项（需要用户决定）

### D10 知识库 tag

现状：条目和 `entry_index` 都没有 tag 字段，右侧面板只按 kind 分组。

- **A（推荐）：这一轮不加 tag，只按类型和 id 提及。** 理由：加 tag 是数据模型改动，牵涉 `EntryFrontmatter`、迁移、索引、面板筛选、prompt 索引段和导出/导入，和"一个输入框菜单"不是同一件事；先让提及跑起来，tag 单独立项。菜单里条目组按 kind 分组显示，用户输入 `@D-12` 也能精确命中。
- **B：这一轮先给条目加 tag**（frontmatter `tags: string[]`，`entry_index` 加列，面板可筛选，提及菜单加 tag 组）。代价：多一次迁移、多一轮面板改动，v0.2.0 推迟更久。

推荐 A。

### D11 工作区成员提及

现状：没有 users / members 表，消息上没有用户 id，hub 只有一个单用户 `uiAuth`。

- **A（推荐）：这一轮不做成员提及。** 等 ROADMAP P2-04 的身份、授权与审计设计落地后再做，届时补 `users`、`workspace_members`、`messages.author_user_id` 和能给出身份的认证。菜单里不显示成员组，文案也不提；spec 已写清所需的前置（§7）。
- **B：先做一个"本地成员名单"**（一张只有显示名的表，不做认证），菜单里能 `@` 到人，但没有身份校验，任何人写的名字都一样。代价：这只是个标签，不能授权、不能审计，容易让人误以为已经是多人环境；也与 P2-04「不得直接把单用户本地服务暴露为多人服务」相冲突。
- **C：现在就做完整身份模型**（users、members、auth、消息作者），把 P2-04 提前到 v0.2.0。代价：远超提及的范围，v0.2.0 要大幅推迟。

推荐 A。

### D12 话题还算不算一类

新范围点名了附件、条目与 tag、成员，没有点名话题；原 D1 把话题列进 v0.2.0，设计和测试都已成型，成本很低。

- **A（推荐）：保留话题提及**，只给标题和锚点。话题属于 workspace 内的上下文，和"不超出 workspace"的原则一致。
- **B：这一轮去掉话题**，`@` 只有条目和附件；话题提及留到以后。

推荐 A。
