# 输入框 `@` 提及上下文

- **Issue：** [#136](https://github.com/Nema-Project/nema-room/issues/136)
- **相关：** [#104](https://github.com/Nema-Project/nema-room/issues/104)（聊天附件，本设计只借用它的托盘样式和 prompt 行写法）；[#75](https://github.com/Nema-Project/nema-room/issues/75)（Skills；S6（D-5）定为 `/skill:名字` 手动调用，`@` 留给提及）
- **目标版本：** v0.2.0。用户接受 v0.2.0 因此推迟约一周（2026-10-31）
- **核对基线：** `origin/main` `080e8aa`（Merge pull request #128）
- **决定：** 用户在 2026-10-31 定了 D1–D9，全部按 #136 的推荐，见文末「已决定的事项」和 [#136 的决定记录](https://github.com/Nema-Project/nema-room/issues/136#issuecomment-6526104590)

## 如何服务 #45

按 [#45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准衡量，`@` 提及能让人和 agent 更容易对同一份有依据的理解达成一致：

- **讨论挂在依据上：** 用户可以在一句话里明确指出"按 [D-12] 来"或"看 `web:apps/web/lib/slash.ts`"。agent 拿到的是条目原文和固定在某个提交的文件，不靠猜。
- **可核对：** 提及以结构化记录存在消息上。文件记录发送时的提交号，事后能回答"当时让 agent 看的是哪个版本"。
- **分清来源：** 提及只是用户指定的上下文，不是用户的决定。被提及的条目保持原来的状态和 `basis`，提及动作本身不改变任何条目，也不产生 `verified`。
- **不越权：** 不给 agent 新的读取能力。文件仍只能通过已有的 `code__read` 读取绑定仓库主分支上的内容；web 只拿到文件名。

本设计不把 Nema Room 变成编辑器或通用文件浏览器：不提供工作区文件树页面，不读未提交的改动，不注入目录或整仓内容。

## 现状（已核对）

1. **web 看不到仓库文件。** hub UI API 只有仓库级路由：`GET /workspaces/:id/repos`、`POST /repos/preview`、`POST /repos`（`apps/hub/src/uiApi.ts:381-388`），没有文件列表或文件内容接口。
2. **agent 读代码只走 `code__*`。** 函数清单在 `apps/cli/src/repos/handlers.ts:58`。`code__read` 的参数是 `repo/path/startLine/endLine`（schema 在 `packages/shared/src/plugins.ts:237-251`，解析在 `handlers.ts:137-142`），执行时固定读主分支最新提交（`handlers.ts:193-199` 调 `mainRef` 再调 `readFileAtRef`）。读取上限是 400 行、64 KiB（`apps/cli/src/repos/git.ts:13-14`），会拒绝符号链接（`git.ts:316-330`）。`repo` 参数可以是 id 或 label，由 hub 的 `findRepoForWorkspace`（`apps/hub/src/repos.ts:91`）解析。
3. **"提交在不在主分支上"已有判定。** `isOnMain`（`git.ts:366`）用 `merge-base --is-ancestor`，`changedFiles` 已用它拒绝不在主分支上的提交（`git.ts:380-388`）。`SHA_RE = /^[0-9a-f]{7,40}$/`（`git.ts:15`）。
4. **daemon 仓库 RPC 的命名和注册位置。** 方法统一用单数 `repo.*`（`repo.inspect`、`repo.index`、`repo.changes`……），都在 `registerRepoHandlers`（`handlers.ts:214` 起）里注册。新方法放在这里，不用改 `apps/cli/src/daemon/setup.ts`。
5. **知识条目有类型和状态，没有标签。**
   - 7 种类型：`ENTRY_KINDS`（`packages/shared/src/entry.ts:5`），前缀 R/D/T/Q/S/G/W（`entry.ts:93-101`），id 规则 `ID_RE`（`entry.ts:103`），各类型的状态见 `KIND_STATUSES`（`entry.ts:114`）。
   - web 的 `MARKER = /\[([RDTQSG]-[1-9]\d*)\]/g`（`apps/web/components/Markdown.tsx:9`）漏了 `W`，所以 `[W-n]` 不会变成条目链接。
   - hub 的 `wpFormat.ts:6` 也有一个 MARKER，那是开发包格式协议，本设计不动它。
6. **话题。** `GET /workspaces/:id/threads`（`uiApi.ts:428`），web 端是 `listThreads`（`apps/web/lib/hub.ts:95`）。prompt 已有"当前 thread"锚点段（`apps/hub/src/prompt.ts:180-183`）。
7. **消息怎么存、怎么发。**
   - 三个发消息入口（新建话题 `uiApi.ts:439-445`、话题内回复 `:464-470`、主聊天 `:543-549`）共用 `PostMessageBody`（`uiApi.ts:79-87`），最后都走 `postUserMessage`（`apps/hub/src/messages.ts:161`）。
   - 编辑走 `EditMessageBody = z.strictObject({ content })`（`uiApi.ts:89`）和 `editUserMessage`（`messages.ts:268`）。
   - `messages.meta` 是 `jsonb`（`apps/hub/src/db/migrations/001_init.sql:14`）。`UserMessageMeta` 现在只有 `quote`（`packages/shared/src/workspace.ts:26-28`），这是"结构化引用放在 meta 里"的先例。
8. **prompt 怎么拼。** `buildPrompt`（`prompt.ts:96`）由 `daemonSocket.ts:186` 调用。各段顺序是：规则、Workspace、条目索引（`prompt.ts:178`，只有 id 和标题）、thread 锚点、最近消息、引用消息（`:226-228`）、本次用户消息（`:230-233`）。附件每个一行（`prompt.ts:50-57`）。
9. **输入框。** 普通 `<textarea>`（`apps/web/components/Composer.tsx:205`），`onSend(content, attachmentIds)`（`:33`）。`/` 菜单只认行首（`apps/web/lib/slash.ts:26-31`）。调用方是 `Chat.tsx:355` 和 `ThreadView.tsx:213`。
10. **附件不适合承载提及。** `AttachmentRef` 只有 image/pdf/text 三种，有大小上限，每个任务最多 8 个（`packages/shared/src/attachments.ts:6,9-18`）。附件字节存在 hub，删除后留墓碑（`014_message_attachments.sql`）。

## 社区做法对照（2026-10-30 抓取）

完整表格和一手链接见 [#136](https://github.com/Nema-Project/nema-room/issues/136) 第二节。本设计用到的结论：

- **文件只给引用：** 与 Codex CLI 一致（[PR #1401](https://github.com/openai/codex/pull/1401)，`@` 只插入路径）。Claude Code、Copilot、Gemini CLI 会注入全文，但都要处理"放不下"：Claude Code 以 Read 的 25,000 token 为限，超过 256KB 不放；Copilot 退回大纲，大纲也放不下就不放。Nema 的 agent 本来就通过 `code__read` 读代码，只给引用不会多占上下文。
- **条目内联：** 条目短，是对齐的核心，所以内联正文。这和 Continue.dev 的 context provider 返回 `content` 再注入是同一个思路。
- **一个分组菜单：** Cursor、Zed、Linear、Continue.dev 都是一个 `@` 菜单，按类别分组。Linear 支持 `@ENG-123` 精确引用，这里对应 `@D-12`。
- **结构化存储：** Slack 在正文里存 `<@U…>` 这样的 id，Zed 用结构化提及。Nema 的正文保留可读文本，结构另存在 meta 里（D4）。

### 偏离主流的地方和理由

- **不注入文件全文。** 主流 IDE 会注入，但它们的 agent 在同一台机器上；Nema 的 hub 不持有仓库内容，内联要多一次 daemon 往返和一份 token 预算。日后发现 agent 经常不去读被提及的文件，再加"小文件内联"。
- **不支持目录、符号、diff、URL 和消息。** v0.2.0 只做 D1 定下的三类。

## 设计

### 1. 数据契约（D4、D5）

新文件 `packages/shared/src/mentions.ts`，由 `workspace.ts` 用 `export * from "./mentions.js"` 转出。这样不改 `packages/shared/src/index.ts`（Skills S0 正在改它）。

```ts
export const MENTION_LIMITS = {
  perMessage: 20,
  entryBytes: 4096,
  entriesTotalBytes: 16384,
  fileCandidates: 50,
  menuPerGroup: 8,
  threadAnchorBytes: 1024,
} as const;

export const MessageMention = z.discriminatedUnion("type", [
  z.object({ type: z.literal("entry"), id: z.string().regex(/^(R|D|T|Q|S|G|W)-[1-9]\d*$/), text: MentionTextSchema }),
  z.object({ type: z.literal("file"), repoId: z.string().min(1), path: z.string().min(1).max(1024), commit: z.string().regex(/^[0-9a-f]{40}$/), commitSource: z.enum(["head", "candidate"]).optional(), text: MentionTextSchema }),
  z.object({ type: z.literal("thread"), id: z.string().min(1), text: MentionTextSchema }),
]);
// MentionTextSchema = z.string().min(1).max(4096): the readable text inserted into the body, stored as written
// (room for a 1024-char path and 40-char label inside a code span whose fence outlasts any backtick run in them).
// UserMessageMeta gains: mentions: z.array(MessageMention).max(MENTION_LIMITS.perMessage).optional()
export function mentionText(m: MessageMention, labels: { repoLabel?: string; threadTitle?: string }): string;
export function normalizeMentionPath(p: string): string | null; // rejects "..", absolute paths (including a C: drive root), backslashes, NUL
export function fuzzyScore(query: string, candidate: string): number | null; // null = no match
```

- **正文里的可读文本：**
  - 条目写 `[D-12]`，沿用现有链接渲染。
  - 文件写 `` `label:path` ``；label 或 path 含反引号时，用比其中最长的反引号串更长的围栏（CommonMark 代码段规则）。
  - 话题写 `[话题：标题]`。
  - 正文是给人看的，hub 和 agent 只认 `meta.mentions`。
- **存下可读文本：** 每个提及带 `text`，即插入正文时的原文（由 `mentionText` 生成）。之后仓库 label 或话题标题改了，旧消息的提及仍按当时的 `text` 对应正文，不按现在的名字重建。
- **快照还是最新：**
  - 文件的 `commit` 以 hub **收到发送请求时**为准。web 送来的 `commit` 只是候选列表当时的值，可能已经过期（比如候选被缓存后主分支前进了）。hub 在写入前用 daemon RPC `repo.head` 取每个被提及仓库主分支的当前提交并覆盖它（§2）。daemon 不在线或版本过旧时，保留 web 送来的值，记 `commitSource: "candidate"`，并在 prompt 的文件行注明"提交号来自候选列表，可能早于发送时"。覆盖成功时记 `commitSource: "head"`。`commitSource` 只由 hub 写，web 送来的值会被忽略。
  - 条目和话题在 prompt 构建时取最新内容。
- **出现次数与元数据一一对应：** 一个提及对应正文里的一处 `text`。同一段 `text` 在 `mentions` 里出现 k 次，正文里就必须至少出现 k 次，否则 hub 回 400。构建 prompt 时同一对象只展开一次。
- **校验位置：** hub 在 `postUserMessage` 里校验并写入：
  - 条目必须存在于本 workspace。
  - 话题必须属于本 workspace。
  - 文件的 `repoId` 必须已绑定到本 workspace，`path` 必须通过 `normalizeMentionPath`。
  - 任何一项不通过都回 400，消息不写入。
  - hub 不核对文件是否存在，因为文件可能已在新提交里被删除。这由 `code__read` 在读取时报告。
- **编辑：** `EditMessageBody` 仍只收 `content`。`editUserMessage` 用存下的 `text` 计数：某段 `text` 在新正文里出现 n 次、在原提及里有 k 个，就按原顺序保留前 min(n, k) 个，其余丢弃。所以删掉两处相同提及中的一处，只会去掉一个提及；全部删掉才会全部去掉。重跑的任务按保留下来的提及构建 prompt。web 端的 `syncMentions` 用同一套计数规则。
- **重放：** 带附件的重复发送会走 `lockForSend`（`apps/hub/src/messages.ts:212`）的重放判断，现在比较附件、正文、引用和话题。加入提及后，要把提及也纳入比较：按 `type`、id（文件按 repoId+path）和 `text` 依次比较，不比较文件的 `commit`（它会被 hub 覆盖）。提及不同就按冲突回 409，不当作重放。

### 2. 文件候选（D8）

- **daemon RPC `repo.head`：** 在 `registerRepoHandlers` 里注册。参数是 `RepoCall`，返回 `{ commit: string }`，即 `mainRef` 的完整 SHA。只做 `rev-parse`，不 fetch。hub 在发送时用它固定文件提及的提交（§1）。
- **daemon RPC `repo.files`：** 在 `registerRepoHandlers` 里注册。
  - 参数与 `repo.changes` 相同，即 `RepoCall`。
  - 返回 `{ commit: string; paths: string[]; truncated: boolean }`。
  - 实现：对 `mainRef` 执行 `git --literal-pathspecs ls-tree -r -z <commit>`，复用 `parseLsTree`，只保留普通文件（mode `100644`/`100755`），排除符号链接 `120000` 和子模块 `160000`。
  - 最多 50,000 条，超出时设 `truncated: true`。
  - 按 `repoId + commit` 在内存里缓存最近 8 份。
  - 不 fetch，不读工作区。这和 `code__read` 读到的是同一个提交。
- **hub 路由 `GET /api/workspaces/:id/mention-files?q=<query>`：** 放在新文件 `apps/hub/src/mentionsApi.ts`，像 `attachmentRoutes` 一样在 `apps/hub/src/app.ts` 里挂载，不改 `uiApi.ts`。
  - 对每个绑定仓库并行调用 `repo.files`，每个 5 秒超时。
  - 用 `fuzzyScore` 排序，最多返回 `MENTION_LIMITS.fileCandidates` 条。
  - 返回 `{ status: "ok" | "unsupported" | "offline"; files: Array<{ repoId; label; path; commit }>; truncated: boolean }`。
  - daemon 报"未知方法"时返回 `unsupported`（旧 daemon）；daemon 不在线时返回 `offline`。这两种情况都回 200，由 web 显示原因。
  - `q` 为空时返回空列表，不把整个仓库发下去。
- **模糊规则（`fuzzyScore`）：**
  - 分数从高到低：文件名前缀、路径段前缀、子序列。
  - 不区分大小写。同分时路径短的在前。

### 3. 交给 agent（D2、D3）

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
## 文件 web:apps/web/lib/slash.ts @ 1a2b3c4
需要时用 code__read 读取：repo=<repoId>，path=apps/web/lib/slash.ts，ref=<完整提交号>。
结果里的 commit 与上面不一致或没有 commit 字段时，说明读到的是主分支最新内容。
## 话题「<标题>」
[<锚点消息 id>] <role>: <锚点正文，截断到 1 KiB>
需要更多上下文时请用户在该话题里继续，或引用具体消息。
```

- **条目预算：** 每条 4 KiB，合计 16 KiB。按出现顺序填，超出的条目只给标题和 id。截断不能切断多字节字符。
- **话题：** 只给标题和锚点，不展开整段回复。
- **其他：** 提及的段落不计入附件的数量或大小限制。只有当前这条用户消息的提及会进入 prompt，引用消息和历史消息的提及不会。

### 4. `code__read` 的 `ref`（D5）

- **schema：** `packages/shared/src/plugins.ts` 里 `code__read` 的 properties 加 `ref: { type: "string", pattern: "^[0-9a-f]{7,40}$" }`，仍是可选参数。
- **解析：** `handlers.ts` 把 `ref` 解析为可选字段。
- **执行：** 给了 `ref`，且 `isOnMain(ref, mainRef)` 为真时，读 `ref`；否则读 `mainRef`，并在结果里带 `note: "ref_not_on_main"`。
- **返回：** `FileAtRef` 加 `commit`（实际读的完整 SHA）。
- **版本搭配：**
  - 旧 daemon 会忽略 `ref`，结果里也没有 `commit`。prompt 已说明这种情况。
  - 旧 hub 不会传 `ref`，行为不变。

### 5. W marker（D9）

`Markdown.tsx:9` 改成 `[RDTQSGW]`，`[W-n]` 渲染成 `nema-entry:` 链接，点击行为与其他条目相同。`wpFormat.ts` 的 MARKER 不变，因为那是开发包格式协议（AGENTS.md）。

### 6. 输入框（D6、D7）

- **触发：** 光标前最近的 `@` 位于行首、空白之后，或 `（(「『，。、：` 之后，且 `@` 到光标之间没有空白（最多 100 个字符）时，打开提及菜单。
  - `a@b` 这样的邮箱写法不触发。
  - 光标在 ``` 代码块里时不触发。
  - `/` 菜单仍只在行首触发；两个菜单同一时间只开一个，以包含光标的 token 为准。
- **分组与排序：** 依次是条目、文件、话题，每组最多 8 条。
  - 条目和话题在前端用 `fuzzyScore` 过滤已加载的列表：`listEntries`、`listThreads`，30 秒内复用。
  - 文件调用 `mention-files`，150 ms 防抖，同一个查询 30 秒内复用。缓存只影响候选列表；发送时的提交号由 hub 重新取（§1）。
  - 查询完全等于某个条目 id（如 `D-12`、不区分大小写）时，这个条目排在最前。
  - 查询为空时，条目按最近更新排序，话题按 `lastReplyAt` 排序，文件组提示"输入文件名搜索"。
- **选中：** 把 `@query` 换成可读文本加一个空格，并在本地的提及列表里加一条。
  - 输入框上方的托盘用附件 chip 的样式显示提及，点 × 时同时删掉正文里那段文本。
  - 正文里那段文本被改掉或删掉时，对应的提及自动移除。
- **键盘：** 沿用 `/` 菜单的规则：↑↓ 选择，Enter/Tab 选中，Esc 关闭；菜单关闭时，普通 Enter 换行，Shift+Enter 发送。
- **发送：** `onSend(content, attachmentIds, mentions)`。`/thread` 新建话题时也带上提及。只有提及、没有正文时不能发送（与现在一样，正文不能为空）。
- **不可用时的提示：** `offline` 显示"本机 daemon 不在线，暂时不能提及文件"；`unsupported` 显示"daemon 版本过旧，升级后可提及文件"。条目和话题组照常可用。

## 安全与边界

- web 只得到绑定仓库主分支上的文件路径，拿不到内容。hub 不读文件内容，不存仓库内容。
- 不读工作区、未提交改动、`.git` 内部文件、符号链接或子模块。
- `code__read` 加了 `ref` 之后，仍只能读主分支历史上的提交。不在主分支上的提交会退回主分支，并在结果里注明。
- 提及校验在 hub 端完成，web 传来的 `repoId`、条目 id 和话题 id 都要核对归属。
- 提及不改变条目状态、`basis` 和 `verified`，也不授权任何写入。

## 兼容与恢复

- **数据库：** 不加迁移，`mentions` 存在已有的 `messages.meta` jsonb 里。旧 hub 读到时，`z.object` 会丢掉未知字段，不报错。回滚到旧版只会失去提及，消息本身完好。
- **协议：** `task.assign` 不变，不改 `packages/shared/src/protocol.ts`。
- **版本搭配：**
  - 新 web + 旧 hub：`PostMessageBody` 不是 strict，`mentions` 会被丢弃，消息照常发送。
  - 新 hub + 旧 daemon：文件组显示"版本过旧"，`ref` 被忽略。

## 测试策略

按 TDD 写测试，只用临时数据库、临时 git 仓库和假 daemon，不调用真实模型。

- **shared：** schema 的合法和非法输入；`normalizeMentionPath`；`fuzzyScore` 的排序；`mentionText`。
- **cli：** `repo.head` 返回主分支当前提交；`repo.files` 排除符号链接和子模块、遇到上限截断、缓存命中、不碰工作区（往工作区加一个未提交文件后列表不变）；`code__read` 的 `ref` 在主分支上、不在主分支上、格式非法三种情况。
- **hub：**
  - 路由在 `ok`、`unsupported`、`offline` 下的返回，以及空查询。
  - 三个发送入口都能写入提及，归属不对时回 400。
  - 发送时文件提交号被 `repo.head` 覆盖；daemon 不在线时保留并在 prompt 里注明。
  - 编辑后提及按 `text` 计数过滤，label 或标题改名不影响旧提及。
  - 提及不同的重复发送回 409，不当作重放。
  - prompt 段落的顺序、预算、截断、已删除条目、话题锚点。
- **web：** `@` 触发规则；分组和排序；选中后的正文和 chip；删掉文本后提及移除；`/` 和 `@` 共存；发送带上提及；不可用时的提示；`[W-n]` 渲染成链接。
- **真实环境验收：** 用一次性环境跑两种运行方式，确认 agent 读到了被提及的条目和固定提交的文件。

## 分批计划概要

详见 [实现计划](../plans/2026-10-31-mentions.md)。

- 可以提前做、不碰 Skills 各批文件的：M0 契约、M1 文件候选（daemon RPC + hub 路由）、M2 `code__read` 的 `ref`、M3 W marker。
- 必须在 Skills S6 合并后做的：
  - M4 hub 接收与 prompt：同改 `uiApi.ts`、`daemonSocket.ts`、`prompt.ts`。
  - M5 输入框：同改 `Composer.tsx`、`slash.ts`、`hub.ts`、文案。
  - M6 文档与 changelog：同改 `docs/guide.*.md`。
- 最后是 M7 真实环境验收。
- **工作量：** 约 4.5–5.5 人日。

## 反目标

- 不做文件树页面，不做文件预览，不在 hub 存仓库内容。
- 不注入文件全文，不提及目录、符号、diff、URL 或单条消息（v0.2.0）。
- 不按标签提及，因为条目没有 tag 字段，也不为此加字段。
- 不改 Skills 的 `/` 菜单规则，不改 `wpFormat.ts` 的开发包格式。
- 提及不是决定，不改变任何条目状态。

## 已决定的事项（2026-10-31 JST，用户决定）

用户批准 #136 的 D1–D9，全部按推荐，并接受 v0.2.0 推迟约一周。记录见 [#136 评论](https://github.com/Nema-Project/nema-room/issues/136#issuecomment-6526104590)。

- **D1 范围：** v0.2.0 做文件、知识条目、话题三类，话题留在 v0.2.0。
- **D2 文件交付：** 只给引用（repo + path + 提交号），由 agent 用 `code__read` 读取。
- **D3 条目交付：** 内联正文，每条 4 KiB、合计 16 KiB，超出的只给 id。
- **D4 序列化：** 结构化记录存在 `UserMessageMeta.mentions`，正文保留可读文本。
- **D5 快照/最新：** 文件记录发送时的提交号，`code__read` 加可选 `ref`；条目取 prompt 构建时的最新内容。
- **D6 与附件：** 提及是独立模型，只共用托盘 chip 和 prompt 行的写法。
- **D7 菜单：** 一个 `@` 分组菜单加模糊搜索，支持 `@D-12` 精确输入。
- **D8 文件列表：** daemon RPC 加 hub 侧模糊查询，最多 50 条。#136 里写的 `repos.files` 按现有命名改为 `repo.files`，只是改名，不改变决定。
- **D9 W marker：** `[W-n]` 渲染成链接，也能被提及。
