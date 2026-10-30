# 聊天附件：图片、PDF 与文本类文件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：可实现。** D-1 到 D-4 已由用户在 2026-10-30 选定（D-1 A、D-2 A、D-3 A、D-4 B），见 spec 的「用户的决定」。实现不得改变这些选择。

**Goal:** 用户可以在聊天（含 thread 回复）里附加图片、PDF 和文本类文件；hub 在本机保存并只经鉴权接口提供；daemon 按任务凭据取回附件，按适配器能力交给 agent，交不了时给出具体原因；消息历史里能看到附件，用户能删除附件并留下墓碑。

**Architecture:** 字节存 `<dataDir>/attachments/<workspaceId>/<附件id>`，元数据存新表 `message_attachments`（D-1 A）。上传是一条单独的原始字节路由，发消息只带附件 id。hub 在 `task.assign` 里只放附件引用；daemon 用 `runToken` 调 `GET /room/attachments/:id` 取字节，再由各适配器组装成原生内容块或带随机边界的文字块。能力表只在 daemon 里，经一个只读 RPC 和一个 UI 路由给输入框用；只有 `native` 的组合发原生块，其余明确拒绝（D-2 A）。附件只属于消息（D-3 A）。删除留墓碑（D-4 B）。

**Tech Stack:** TypeScript、Hono、`pg` / PGlite、`ws`、zod、Next.js、Vitest。不新增依赖。

**Spec:** [聊天附件设计](../specs/2026-10-30-chat-attachments-design.md)。本计划的每一条行为都来自 spec；spec 与本计划冲突时以 spec 为准，先改本计划。

**Issue:** [#104](https://github.com/Nema-Project/nema-room/issues/104)。

**Base:** 代码核对在 `141cecb`（Merge pull request #103）上做；提交本计划时 `origin/main` 是 `6a7b701`（合并了 #97 和 spec #105），其间 #97 改了 `uiApi.ts`、`plugins.ts`、`web/lib/hub.ts`、`globals.css`、i18n 和文档，但没有改下文「核对的代码」列出的行为。每一批动手前 `git fetch origin main`，用 `git diff --name-only 6a7b701..origin/main -- <本批文件>` 看本批文件有没有被别人改过；有改动先重读，与下文「核对的代码」不一致时先改本计划。

## 如何服务 #45

判断标准见 [#45](https://github.com/Nema-Project/nema-room/issues/45)。本计划把 spec「如何服务 #45」落到可验证的行为上：附件带 sha256 留在消息里，能追到 agent 当时看到的原件；所有类型的附件都以「数据、推断」的身份交给 agent，不会变成用户陈述或决定；agent 看不到某个附件时，用户一定看得到原因，不会出现「以为 agent 看过了」。

## 写本计划时核对的代码（`141cecb`）

- `apps/hub/src/app.ts`：`/api/*` 依次经过 `hostGuard`、CORS、可选 `uiAuth`、`requireJson`（POST/PUT/PATCH 只收 `application/json`），再挂 `uiRoutes`。`/room` 挂 `roomRoutes`。
- `apps/hub/src/uiApi.ts`：`PostMessageBody = { content 非空, quoteMessageId?, threadId? }`，主消息路由 `POST /workspaces/:id/messages` 和 thread 路由 `POST /workspaces/:id/threads/:tid/messages`（及新建 thread 的路由）共用。`body()` 用 `c.req.json()` 解析。
- `apps/hub/src/messages.ts`：`postUserMessage(db, workspaceId, content, opts)` 拒绝空白 `content`，事务里 `insertMessage` 再 `insertQueuedTask`。`COLS`、`toMessage`、`listMessages`、`listThreadMessages`、`getMessage` 都只读 `messages` 表。
- `apps/hub/src/prompt.ts`：`buildPrompt` 把最近消息、thread 锚点全文、被引用消息、本次消息都写成 `[id] role: content` 文本。
- `apps/hub/src/daemonSocket.ts`：握手时带发布版本号的 hub 要求 `hello.version` 完全一致；`dispatchOnce` 组好 `task.assign`（无附件字段）后发送。
- `apps/hub/src/roomApi.ts`：`resolveRunToken` 只认 `status = 'running'` 的任务，`Auth = { taskId, workspaceId }`。
- `apps/hub/src/workspaces.ts`：`deleteWorkspace` 事务里 `select … for update` 锁 workspace 行，删各表，提交后删 `repos/<id>`。
- `apps/hub/src/db/db.ts`：`migrate` 按文件名顺序执行 `migrations/*.sql`，记在 `schema_migrations`。现有最后一个是 `013_task_skill_offers.sql`。
- `packages/shared/src/protocol.ts`：`hello = { token, version, adapters, reportTokenHash? }`；`task.assign` 无附件字段；zod 对象默认丢弃未知字段。
- `apps/cli/src/daemon/connection.ts`：`hello` 在 socket `open` 时发送；`task.assign` 解析失败时回 `task.finished ok:false`。
- `apps/cli/src/daemon/setup.ts`：`startDaemon` 里 `registerExtensionHandlers`、`registerRepoHandlers` 和几个 `rpc.register`。
- `apps/cli/src/room/client.ts`：`RoomClient.call` 只处理 JSON。
- `apps/cli/src/claude/adapter.ts`：`userMessage(prompt)` 只生成一个 `text` 块；`launch.ts` 用 `--tools ""`。
- `apps/cli/src/direct/transport.ts`：`InputTextPart`、`InputItem` 的用户内容只有 `input_text`。`direct/loop.ts` 的 `userMessage(text)`、`runToolLoop({ userText })`；`direct/adapter.ts` 把 `task.prompt` 放进 `instructions`，`userText` 固定为 `DIRECT_USER_TEXT`。
- `apps/local/src/gateway.ts`：代理到 hub 的 POST/PUT/PATCH 不是 `application/json` 就回 415；请求体用 `http.request` 转发。
- `apps/web/lib/hub.ts`：`request<T>()` 只发 JSON；`LOCAL_HUB_MODE` 下走同源 `/api`。
- `apps/web/components/Composer.tsx`：`send()` 在去掉空白后为空时直接返回；`onSend(content: string)`。
- `apps/web/components/MessageItem.tsx`：`UserMessage` 只渲染 `Markdown`。
- 测试位置：`apps/hub/test/*.test.ts`（`helpers.ts` 有临时数据库和 app 工厂）、`apps/cli/test/claude/adapter.test.ts`（假 `claude` 可执行文件）、`apps/cli/test/direct/*.test.ts` 与 `apps/cli/test/fixtures/fake-responses-server.ts`、`apps/local/test/gateway.test.ts`、`apps/web/test/Composer.test.tsx`、`apps/web/test/MessageItem.test.tsx`、`packages/shared/test/*.test.ts`。

## 与正在进行的工作的重叠

正在进行的两条线：

- **MCP 线**（[#97](https://github.com/Nema-Project/nema-room/pull/97) 已在 `9c50307` 合并，接下来做 MCP 的 CLI、hub 路由和插件页）：会改 `apps/cli/src/extensions/handlers.ts`、`apps/cli/src/extensions/store.ts`、`apps/cli/src/daemon/setup.ts`、`apps/hub/src/plugins.ts`、`apps/hub/src/uiApi.ts`、`apps/web/components/PluginsPage.tsx`、`apps/web/messages/{en,zh,ja}.json`。#97 合并时改过 `apps/web/lib/hub.ts`、`apps/web/app/globals.css`、guide、`docs/reference.zh-CN.md`，MCP 线可能继续改。
- **#63 第 3 期**：`scripts/release/**`、`scripts/*/RELEASE.md`、`CONTRIBUTING.md`。

本计划对重叠文件的处理：

| 文件 | 哪一批会动 | 重叠对象 | 处理 |
| --- | --- | --- | --- |
| `apps/hub/src/uiApi.ts` | B2 | MCP 线 | 只改 `PostMessageBody` 和三处发消息路由的参数传递，不新增路由；新路由放新文件 `attachmentRoutes.ts`。合并前 merge 最新 main，冲突只可能在这几行 |
| `apps/cli/src/daemon/setup.ts` | B3 | MCP 线 | 只加一行 `registerAttachmentHandlers(rpc, o.nemaHome)` 和一行 import |
| `apps/web/lib/hub.ts` | B6 | #97、MCP 线 | 新函数追加在文件末尾；`Message` 类型改在 `lib/types.ts` |
| `apps/web/messages/{en,zh,ja}.json` | B6、B7 | MCP 线 | 新键统一用 `attach.` 前缀，加在文件末尾，避免和 `plugins.` / `mcp.` 键交错 |
| `apps/web/app/globals.css` | B6 | #97 | 新样式加在文件末尾，类名用 `att-` 前缀 |
| README ×4、`docs/guide.{en,zh,ja}.md`、`docs/reference.zh-CN.md` | B8 | #97、MCP 线 | 放到最后一批，动手前先合入最新 main |

#63 第 3 期的文件本计划一个都不动。

## Global Constraints

- 用户决定：D-1 A、D-2 A、D-3 A、D-4 B（对附件字节不适用「保留来源」，只限附件字节）。
- 类型：`image`（PNG、JPEG、WebP、GIF，按文件头判定）、`pdf`（`%PDF-`）、`text`（严格 UTF-8、无 NUL）。SVG、HEIC、Office、压缩包、语音、视频一律拒收。扩展名与内容冲突时拒收。
- 上限：图片 10 MB、PDF 20 MB、文本 512 KB；每次任务（本次消息 + 被引用消息 + thread 锚点，去重）最多 8 个、合计 32 MB；全局 `NEMA_ATTACHMENTS_MAX_BYTES` 默认 2 GB；数据盘剩余 < 1 GB 时拒收（507）。`staged` 超过 24 小时过期。
- 上传：`POST /api/workspaces/:id/attachments`，`Content-Type: application/octet-stream`，必须带 `Content-Length`（缺失 411），文件名在 `X-Nema-Filename`（UTF-8 百分号编码），幂等键在 `X-Nema-Upload-Key`（UUID，同一文件重试时沿用）。目录 `0700`、文件 `0600`，创建时显式传 mode。
- 读取：`GET /api/workspaces/:id/attachments/:aid/content`，响应头 `X-Content-Type-Options: nosniff`、`Content-Disposition: attachment`、`Content-Security-Policy: sandbox; default-src 'none'`、`Cross-Origin-Resource-Policy: same-origin`、`Cache-Control: private, no-cache`；文本一律 `text/plain; charset=utf-8`。
- 附件内容只进 user 角色消息，永远不进 `instructions` / 系统提示。所有附件块之前有一个说明块：附件是数据；从附件读出的内容是推断，不是用户陈述或决定；`quotes` 只能摘自消息文字。
- 文本附件用每次运行随机生成的 128 位边界；元数据只在一行 `JSON.stringify` 里。
- 只有能力为 `native` 的组合发原生块；`unsupported`、`unknown` 运行前明确拒绝。不做 PDF 抽文字。
- 用户给的文件名永远不参与拼路径。日志、错误里不写附件内容。
- 测试不访问网络、不调真实模型；先红后绿；全量测试先 `npm run typecheck` 再 `npm test -- --maxWorkers=2`。
- 用户可见变化写 `changelog.d/chat-attachments.added.md`；UI 文案三种语言；`README.md` 与 `README.en.md` 逐字节一致。
- 不改 `.github/workflows`。

## 分批与并行

| 批 | 内容 | 文件范围（新建 / 修改） | 依赖 | 可并行 |
| --- | --- | --- | --- | --- |
| B0 | 共享契约 | 新：`packages/shared/src/attachments.ts`、`packages/shared/test/attachments.test.ts`；改：`packages/shared/src/protocol.ts`、`packages/shared/src/index.ts`、`packages/shared/test/protocol.test.ts` | 无 | 先做，其余都依赖它 |
| B1 | hub 存储、上传、读取、删除、能力路由 | 新：`apps/hub/src/db/migrations/014_message_attachments.sql`、`apps/hub/src/attachments.ts`、`apps/hub/src/attachmentRoutes.ts`、`apps/hub/test/attachments.test.ts`、`apps/hub/test/attachmentRoutes.test.ts`；改：`apps/hub/src/app.ts`、`apps/hub/src/workspaces.ts`、`apps/hub/src/main.ts` | B0 | 与 B3、B5 并行 |
| B2 | hub 发消息绑定、提示、任务下发、Room 取附件 | 改：`apps/hub/src/messages.ts`、`apps/hub/src/uiApi.ts`（重叠）、`apps/hub/src/prompt.ts`、`apps/hub/src/daemonSocket.ts`、`apps/hub/src/roomApi.ts`；测试：`apps/hub/test/messages.test.ts`、`prompt.test.ts`、`daemonSocket.test.ts`、`roomApi.test.ts`、`uiApi.test.ts` | B0、B1 | 与 B3、B4、B5 并行 |
| B3 | daemon 核心：能力表、取附件、组块、hello 特性 | 新：`apps/cli/src/attachments/capabilities.ts`、`fetch.ts`、`blocks.ts`、`handlers.ts`、`apps/cli/test/attachments/*.test.ts`；改：`apps/cli/src/daemon/connection.ts`、`apps/cli/src/room/client.ts`、`apps/cli/src/daemon/setup.ts`（重叠，一行） | B0 | 与 B1、B2、B5 并行 |
| B4 | 两个适配器接入，最后打开 `attachments` 特性 | 改：`apps/cli/src/claude/adapter.ts`、`apps/cli/src/direct/transport.ts`、`apps/cli/src/direct/loop.ts`、`apps/cli/src/direct/adapter.ts`、`apps/cli/src/attachments/capabilities.ts`（只改 `DAEMON_FEATURES` 一行）；测试：`apps/cli/test/claude/adapter.test.ts`、`apps/cli/test/direct/{adapter,loop,transport}.test.ts`、`apps/cli/test/connection.test.ts` | B0、B3 | 与 B1、B2、B5 并行；Claude 与 Direct 两部分文件不交叉，可再拆成 B4a / B4b 并行 |
| B5 | 桌面网关放行上传 | 改：`apps/local/src/gateway.ts`、`apps/local/test/gateway.test.ts` | B0 | 与 B1–B4 并行 |
| B6 | web：输入框、hub 客户端、类型 | 新：`apps/web/components/AttachmentTray.tsx`、`apps/web/lib/attachments.ts`、`apps/web/test/AttachmentTray.test.tsx`；改：`apps/web/components/Composer.tsx`、`apps/web/lib/hub.ts`（重叠）、`apps/web/lib/types.ts`、`apps/web/messages/*.json`（重叠）、`apps/web/app/globals.css`（重叠）、`apps/web/test/Composer.test.tsx` | B0；接口形状按 B1、B2 | 可与 B1–B5 并行开发（测试里 mock fetch），合并排在 B2 之后 |
| B7 | web：消息里显示与删除附件 | 新：`apps/web/components/AttachmentList.tsx`、`apps/web/test/AttachmentList.test.tsx`；改：`apps/web/components/MessageItem.tsx`、`apps/web/test/MessageItem.test.tsx`、`apps/web/messages/*.json`（重叠） | B6 | 与 B6 共用 i18n 文件，排在 B6 之后 |
| B8 | 文档、changelog、真实模型验收记录 | `README.md`、`README.en.md`、`README.zh.md`、`README.ja.md`、`docs/guide.{en,zh,ja}.md`、`docs/reference.zh-CN.md`（均重叠）、`changelog.d/chat-attachments.added.md`、spec 的能力表 | B1–B7 全部合并 | 最后做 |

并行建议：B0 合并后，开 4 条线同时做 B1、B3、B5、B6；B1 合并后接 B2；B3 合并后接 B4（可拆 B4a Claude / B4b Direct）；B6 合并后接 B7；全部合并后 B8。B6 可以和 B1–B5 同时开发，但要等 B1、B2 都合并后再合并：附件按钮在 `GET /api/daemon/attachment-capabilities` 返回 404 时隐藏，而这条路由由 B1 提供，B1 合并后按钮就会出现，此时发消息要能带 `attachmentIds`（B2）。daemon 侧在 B3、B4 合并前不广播 `attachments` 特性，hub 会让带附件的任务明确失败，不会悄悄丢掉附件。

每批是一个 PR。每个 PR：先红后绿；本批的定向测试；`npm run typecheck`；涉及 CLI 时 `npm run typecheck -w apps/cli`；涉及 web 时 `npm run lint -w apps/web` 和 `npm run build -w apps/web`；合并前 `npm test -- --maxWorkers=2`。

---

### Task B0：共享契约

**Files:**
- Create: `packages/shared/src/attachments.ts`
- Create: `packages/shared/test/attachments.test.ts`
- Modify: `packages/shared/src/protocol.ts`、`packages/shared/src/index.ts`、`packages/shared/test/protocol.test.ts`

**Interfaces:**
- Produces:
  - `type AttachmentKind = "image" | "pdf" | "text"`
  - `type AttachmentStatus = "staged" | "attached" | "deleted" | "missing" | "expired"`
  - `const ATTACHMENT_LIMITS = { imageBytes: 10 * 1024 * 1024, pdfBytes: 20 * 1024 * 1024, textBytes: 512 * 1024, perTaskCount: 8, perTaskBytes: 32 * 1024 * 1024, stagedTtlMs: 24 * 3600 * 1000, minFreeBytes: 1024 * 1024 * 1024, defaultGlobalBytes: 2 * 1024 * 1024 * 1024 } as const`
  - `function sniffAttachment(bytes: Uint8Array, name: string): { ok: true; kind: AttachmentKind; mime: string } | { ok: false; reason: "unsupported_type" | "extension_mismatch" | "not_utf8" | "empty" | "too_large" }`
  - `function sanitizeAttachmentName(raw: string): string | null`（去掉路径部分和控制字符，截到 200 个字符，空则 `null`）
  - `type AttachmentRef = { id: string; kind: AttachmentKind; mime: string; name: string; size: number; sha256: string; messageId: string }`
  - `type AttachmentView = AttachmentRef & { status: AttachmentStatus; deletedAt: string | null }`
  - `type AttachmentSupport = "native" | "text" | "unsupported" | "unknown"`
  - `type AttachmentCapabilities = { adapter: string; image: AttachmentSupport; pdf: AttachmentSupport; text: AttachmentSupport }` 及其 zod schema `AttachmentCapabilitiesSchema`
  - `function messageHasBody(content: string, attachmentIds: readonly string[]): boolean`（`content.trim() !== "" || attachmentIds.length > 0`）
  - `protocol.ts`：`hello` 增加 `features: z.array(z.string()).optional()`；`task.assign` 增加 `attachments: z.array(AttachmentRefSchema).optional()`。

- [ ] **Step 1：写失败测试** `packages/shared/test/attachments.test.ts`，表驱动：

```ts
import { describe, expect, it } from "vitest";
import { ATTACHMENT_LIMITS, messageHasBody, sanitizeAttachmentName, sniffAttachment } from "../src/attachments.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = new TextEncoder().encode("GIF89a....");
const webp = Uint8Array.from([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")]);
const pdf = new TextEncoder().encode("%PDF-1.7\n...");

describe("sniffAttachment", () => {
  it.each([
    [png, "a.png", "image", "image/png"],
    [jpeg, "a.jpg", "image", "image/jpeg"],
    [gif, "a.gif", "image", "image/gif"],
    [webp, "a.webp", "image", "image/webp"],
    [pdf, "a.pdf", "pdf", "application/pdf"],
    [new TextEncoder().encode("hello\n"), "a.log", "text", "text/plain"],
    [new TextEncoder().encode("{\"a\":1}"), "a.json", "text", "text/plain"],
  ])("accepts %#", (bytes, name, kind, mime) => {
    expect(sniffAttachment(bytes, name)).toEqual({ ok: true, kind, mime });
  });
  it("rejects a PDF named .png", () => expect(sniffAttachment(pdf, "a.png")).toEqual({ ok: false, reason: "extension_mismatch" }));
  it("rejects SVG even though it is text", () => expect(sniffAttachment(new TextEncoder().encode("<svg/>"), "a.svg")).toEqual({ ok: false, reason: "unsupported_type" }));
  it("rejects invalid UTF-8", () => expect(sniffAttachment(Uint8Array.from([0xc3, 0x28]), "a.txt")).toEqual({ ok: false, reason: "not_utf8" }));
  it("rejects NUL bytes", () => expect(sniffAttachment(Uint8Array.from([0x61, 0x00]), "a.txt")).toEqual({ ok: false, reason: "not_utf8" }));
  it("rejects empty", () => expect(sniffAttachment(new Uint8Array(), "a.txt")).toEqual({ ok: false, reason: "empty" }));
  it("rejects oversize text", () => expect(sniffAttachment(new Uint8Array(ATTACHMENT_LIMITS.textBytes + 1).fill(0x61), "a.txt")).toEqual({ ok: false, reason: "too_large" }));
});

describe("sanitizeAttachmentName", () => {
  it("drops directories and controls", () => expect(sanitizeAttachmentName("../../etc/pa\u0000ss\nwd.txt")).toBe("passwd.txt"));
  it("handles backslashes", () => expect(sanitizeAttachmentName("C:\\x\\y.png")).toBe("y.png"));
  it("caps length", () => expect(sanitizeAttachmentName("a".repeat(300) + ".txt")!.length).toBe(200));
  it("rejects blank", () => expect(sanitizeAttachmentName(" / ")).toBeNull());
});

describe("messageHasBody", () => {
  it("allows attachment-only", () => expect(messageHasBody("  ", ["a"])).toBe(true));
  it("rejects fully empty", () => expect(messageHasBody(" ", [])).toBe(false));
});
```

`protocol.test.ts` 加两条：带 `features: ["attachments"]` 的 `hello` 能解析；带 `attachments` 的 `task.assign` 能解析，`sha256` 不是 64 位十六进制时解析失败。

- [ ] **Step 2：确认失败**：`npx vitest run packages/shared/test/attachments.test.ts packages/shared/test/protocol.test.ts`，预期因模块不存在或字段被丢弃而失败。
- [ ] **Step 3：实现** `attachments.ts`。文本类允许的扩展名列一个常量集合（`txt md markdown log csv tsv json jsonl yaml yml toml ini xml html css js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh sql diff patch`，以及无扩展名）；不在集合里的扩展名一律 `unsupported_type`。UTF-8 用 `new TextDecoder("utf-8", { fatal: true })`。图片 / PDF 的扩展名集合分别是 `png jpg jpeg gif webp` 与 `pdf`，与判定结果不符时 `extension_mismatch`。大小按 kind 对照 `ATTACHMENT_LIMITS`。
- [ ] **Step 4：确认通过**：同上命令全绿；`npm run typecheck`。
- [ ] **Step 5：提交并开 PR**。

---

### Task B1：hub 存储、上传、读取、删除、能力路由

**Files:**
- Create: `apps/hub/src/db/migrations/014_message_attachments.sql`（动手时若 `014` 已被占用，用下一个空号）
- Create: `apps/hub/src/attachments.ts`、`apps/hub/src/attachmentRoutes.ts`
- Create: `apps/hub/test/attachments.test.ts`、`apps/hub/test/attachmentRoutes.test.ts`
- Modify: `apps/hub/src/app.ts`、`apps/hub/src/workspaces.ts`、`apps/hub/src/main.ts`

**Interfaces:**
- Consumes: B0 的 `sniffAttachment`、`sanitizeAttachmentName`、`ATTACHMENT_LIMITS`、`AttachmentView`、`AttachmentCapabilitiesSchema`。
- Produces（`attachments.ts`）：
  - `class AttachmentStore { constructor(db: Db, dataDir: string, opts?: { maxGlobalBytes?: number; freeBytes?: () => Promise<number> }) }`
  - `upload(workspaceId: string, name: string, contentLength: number, body: AsyncIterable<Uint8Array>): Promise<AttachmentView>`（抛 `AttachmentError(status, message)`，status ∈ 400/404/411/413/415/507）
  - `open(workspaceId: string, id: string): Promise<{ view: AttachmentView; stream: NodeJS.ReadableStream }>`（404 / 410）
  - `bind(t: Db, workspaceId: string, messageId: string, ids: string[]): Promise<AttachmentView[]>`（条件更新，行数不等即抛 409）
  - `listForMessages(db: Db, messageIds: string[]): Promise<Map<string, AttachmentView[]>>`
  - `remove(workspaceId: string, id: string): Promise<AttachmentView>`（墓碑）
  - `sweep(now?: Date): Promise<void>`（过期、已删除残留文件、孤儿文件、`attached` 但文件不在 → `missing`）
  - `readBytes(workspaceId: string, id: string): Promise<Buffer>`（B2 的 Room 路由用）
- Produces（`attachmentRoutes.ts`）：`attachmentRoutes(deps: { store: AttachmentStore; db: Db; daemon: DaemonRpc; events: EventBus }): Hono`，路由：
  - `POST /workspaces/:id/attachments`
  - `GET /workspaces/:id/attachments/:aid/content`
  - `DELETE /workspaces/:id/attachments/:aid`
  - `GET /daemon/attachment-capabilities`（daemon 离线 503；返回值不符合 `AttachmentCapabilitiesSchema` 时 502）

迁移内容：

```sql
create table message_attachments (
  id text primary key,
  workspace_id text not null references workspaces(id),
  message_id text references messages(id),
  kind text not null check (kind in ('image','pdf','text')),
  mime text not null,
  name text not null,
  size bigint not null check (size > 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  upload_key uuid not null,
  status text not null check (status in ('staged','attached','deleted','missing','expired')),
  created_at timestamptz not null default now(),
  attached_at timestamptz,
  deleted_at timestamptz,
  -- staged / expired rows belong to no message; every other status does.
  check ((status in ('staged', 'expired')) = (message_id is null))
);
create unique index message_attachments_upload_key_idx on message_attachments (workspace_id, upload_key);
create index message_attachments_message_idx on message_attachments (message_id);
create index message_attachments_staged_idx on message_attachments (status, created_at) where status = 'staged';
```

- [ ] **Step 1：写失败测试** `apps/hub/test/attachments.test.ts`（用 `helpers.ts` 的临时数据库和临时 `dataDir`；`freeBytes` 注入假函数）：
  - 上传 PNG 成功：返回 `status: "staged"`、正确 `sha256`；文件在 `<dataDir>/attachments/<ws>/<id>`；`.staging` 下没有残留。
  - 同一 `upload_key` 重试、内容相同：返回原记录（200），记录只有一条，`.staging` 无残留，全局已用量不增加；内容不同 → 409。
  - 权限（POSIX 上运行，Windows 跳过）：附件目录 `0700`、文件 `0600`，即使测试里把 umask 设成 `0o000`；启动 `sweep` 把预先放宽成 `0755` / `0644` 的目录和文件改回来。
  - 文件名含 `../` 时磁盘路径仍是 `<id>`，`name` 是清洗后的值。
  - 不存在的 workspace → 404，`.staging` 无残留。
  - 413：单文件超限，且写入中途中止（body 迭代器在超限后不再被读取）。
  - 411：`contentLength` 为 `NaN`；实际字节超过 `contentLength` → 400。
  - 507：全局已用 + 预留超过 `maxGlobalBytes`；`freeBytes()` 返回 < 1 GB。两个并发上传各占上限的 60%：只有一个成功。
  - `bind`：只能绑本 workspace 的 `staged`；绑别的 workspace 的 id → 409，消息事务回滚；`bind` 与 `sweep` 并发（把 `created_at` 改到 25 小时前）只有一方成功。
  - `remove`：之后 `open` 得 410，文件不在，记录 `status = "deleted"`、`deleted_at` 非空、`name`/`sha256` 仍在。
  - `sweep`：删掉过期 `staged`；删掉状态为 `expired` / `deleted` 但文件还在的残留；删掉没有记录的孤儿文件；`attached` 但文件不在 → `missing`。
  - 与 `deleteWorkspace` 并发：先拿到 workspace 锁的一方赢；删除后 `<dataDir>/attachments/<ws>` 不存在，且没有新文件出现。

  `apps/hub/test/attachmentRoutes.test.ts`（用 `createApp`）：
  - 上传 `Content-Type: application/json` → 415；`application/octet-stream` 通过；缺 `X-Nema-Filename` 或百分号解码失败 → 400；缺 `X-Nema-Upload-Key` 或不是 UUID → 400；错误 Host → 403（`hostGuard`）；配置了 `uiAuth` 时未带凭证 → 401。
  - 读取响应头逐项断言（见 Global Constraints）；文本附件的 `Content-Type` 是 `text/plain; charset=utf-8`；跨 workspace → 404。
  - 其它 `/api` POST 仍然要求 JSON（`requireJson` 只为上传路由放开）。
  - 能力路由：假 `DaemonRpc` 返回合法对象 → 200；返回缺字段 → 502；`daemonStatus` 为 false → 503。

- [ ] **Step 2：确认失败**：`npx vitest run apps/hub/test/attachments.test.ts apps/hub/test/attachmentRoutes.test.ts`。
- [ ] **Step 3：实现**。要点：
  - 上传顺序严格按 spec：进程内计数器原子预留 `contentLength` → 检查全局上限和剩余空间 → 写 `.staging/<随机>` 并边写边计数、边算 sha256 → fsync 文件 → `sniffAttachment`（对前 512 KB 判定文件头；文本类要求整份 ≤ 512 KB 再解码）→ 开事务 `select id from workspaces where id = $1 and archived_at is null for share` → 第一次时创建 `<ws>` 目录并 fsync `attachments/` → rename → fsync `<ws>` 目录（`process.platform === "win32"` 时跳过）→ insert → commit；任何失败都删掉临时文件或已改名的文件，并释放预留。
  - 读取用 `createReadStream`；文件不在时把记录标成 `missing` 并返回 410。
  - `app.ts`：`requireJson` 改为对 `POST` 且路径匹配 `^/api/workspaces/[^/]+/attachments$` 的请求放行 `application/octet-stream`；在 `app.route("/api", uiRoutes(deps))` 之前 `app.route("/api", attachmentRoutes(...))`。
  - `workspaces.ts`：`deleteWorkspace` 事务里加 `delete from message_attachments where workspace_id = $1`，提交后 `fs.rm(path.join(dataDir, "attachments", id), { recursive: true, force: true })`。
  - `main.ts`：启动时 `await store.sweep()`，之后每小时一次；读取 `NEMA_ATTACHMENTS_MAX_BYTES`。
- [ ] **Step 4：确认通过**：上面两个文件全绿；`npx vitest run apps/hub/test/workspaces.test.ts apps/hub/test/server.test.ts`；`npm run typecheck`。
- [ ] **Step 5：提交并开 PR**。

---

### Task B2：hub 发消息绑定、提示、任务下发、Room 取附件

**Files:**
- Modify: `apps/hub/src/messages.ts`、`apps/hub/src/uiApi.ts`（重叠：只改 `PostMessageBody` 与发消息的三处调用）、`apps/hub/src/prompt.ts`、`apps/hub/src/daemonSocket.ts`、`apps/hub/src/roomApi.ts`
- Test: `apps/hub/test/messages.test.ts`、`prompt.test.ts`、`daemonSocket.test.ts`、`roomApi.test.ts`、`uiApi.test.ts`

**Interfaces:**
- Consumes: B1 的 `AttachmentStore.bind / listForMessages / readBytes`；B0 的 `messageHasBody`、`AttachmentRef`。
- Produces:
  - `postUserMessage(db, workspaceId, content, opts: { quoteMessageId?; threadId?; attachmentIds?: string[]; attachments?: AttachmentStore })`
  - `Message`（hub 返回值）增加 `attachments: AttachmentView[]`
  - `function deliverySet(db: Db, taskId: string): Promise<AttachmentRef[]>`（本次消息 + 被引用消息 + thread 锚点，去重、按出现顺序）
  - `task.assign.attachments`
  - Room：`GET /room/attachments/:id` 返回原始字节和 `Content-Type`；不在投递集合 → 404；已删除或丢失 → 410

- [ ] **Step 1：写失败测试**：
  - `messages.test.ts`：只有附件的消息能发；全空仍拒；本次 + 被引用 + 锚点合计超 32 MB 或超 8 个 → 400，提示原文含「合计超过 32 MB」；同一请求重试（附件 id 集合与已绑定集合完全相等，且文字、被引用消息 id、thread 目标都一致）返回原消息和原任务，不新增任务；集合不同、引用不同、thread 不同或部分已绑定 → 409；两次发同样的纯文字消息 → 两条消息；`listMessages` / `listThreadMessages` 带出 `attachments`，旧消息为 `[]`。
  - `uiApi.test.ts`：三条发消息路由都接受 `attachmentIds`。
  - `prompt.test.ts`：最近消息里带附件的一条追加 `[附件：name（mime，大小）]`；只有附件时写「（用户只发了附件）」；条目写入规则里有「从附件读出的内容是推断，`quotes` 只能摘自消息文字」。
  - `daemonSocket.test.ts`：带附件的任务派发时 `task.assign.attachments` 等于投递集合；daemon `hello` 没有 `features: ["attachments"]` 时，带附件的任务直接失败，系统消息含「当前 daemon 不支持附件」，不带附件的任务照常派发。
  - `roomApi.test.ts`：用任务 `runToken` 能取投递集合里的附件，字节一致；同 workspace 但不在集合里 → 404；已删除 → 410；任务结束后（`status != running`）→ 401。
- [ ] **Step 2：确认失败**：`npx vitest run apps/hub/test/messages.test.ts apps/hub/test/prompt.test.ts apps/hub/test/daemonSocket.test.ts apps/hub/test/roomApi.test.ts apps/hub/test/uiApi.test.ts`。
- [ ] **Step 3：实现**。`PostMessageBody` 改成 `content: z.string()`、`attachmentIds: z.array(z.string().min(1)).max(8).optional()`，再 `.refine((b) => messageHasBody(b.content, b.attachmentIds ?? []))`。`postUserMessage` 在同一事务里 `insertMessage` → `store.bind` → 合计检查 → `insertQueuedTask`。`daemonSocket.ts` 在 `conn` 上记住 `features`，`dispatchOnce` 里 `deliverySet` 非空且无 `attachments` 特性时走 `saveTaskFailure`。
- [ ] **Step 4：确认通过**：同上命令全绿；`npm run typecheck`；`npm test -- --maxWorkers=2`。
- [ ] **Step 5：合入最新 main（`uiApi.ts` 可能与 MCP 线冲突，用 merge 解决），提交并开 PR**。

---

### Task B3：daemon 核心

**Files:**
- Create: `apps/cli/src/attachments/capabilities.ts`、`fetch.ts`、`blocks.ts`、`handlers.ts`
- Create: `apps/cli/test/attachments/capabilities.test.ts`、`fetch.test.ts`、`blocks.test.ts`
- Modify: `apps/cli/src/daemon/connection.ts`、`apps/cli/src/room/client.ts`、`apps/cli/src/daemon/setup.ts`（重叠，一行注册 + 一行 import）
- Test: `apps/cli/test/connection.test.ts`

**Interfaces:**
- Consumes: B0 的类型；`loadConfig(nemaHome)` 的 `adapter`、`authMode`、`byokBaseUrl`。
- Produces:
  - `function attachmentCapabilities(config: NemaConfig): AttachmentCapabilities`。表：`claude-code` → `{ image: "native", pdf: "unknown", text: "text" }`；`codex-direct` + `siwc` → `{ image: "native", pdf: "native", text: "text" }`；`codex-direct` + `byok` 且 `byokBaseUrl` 为默认值 → 同 `siwc`；`byok` 其他地址 → `{ image: "unknown", pdf: "unknown", text: "text" }`；`compat` → `{ image: "unknown", pdf: "unknown", text: "text" }`。真实模型验收（B8）通过后才把 `unknown` 改成 `native`。
  - `function refusal(caps: AttachmentCapabilities, refs: AttachmentRef[]): string | null`：只要有一个 ref 的 kind 不是 `native` 或 `text`，返回具体中文原因（含适配器名、文件名和可选的办法），否则 `null`。
  - `RoomClient.fetchAttachment(id: string): Promise<{ ok: true; bytes: Buffer; mime: string } | { ok: false; status: number; error: string }>`
  - `function fetchAttachments(client: RoomClient, refs: AttachmentRef[]): Promise<LoadedAttachment[]>`（逐个校验 `size` 与 `sha256`，不符或 404 / 410 时抛出含文件名的错误）
  - `type LoadedAttachment = AttachmentRef & { bytes: Buffer }`
  - `function attachmentPreamble(): string`（说明块全文）
  - `function textAttachmentBlock(a: LoadedAttachment, random: () => string = defaultRandom): string`（随机边界，内容里出现边界时重新生成；元数据行 `JSON.stringify({ name, type, sha256, size })`）
  - `function registerAttachmentHandlers(router: RpcRouter, nemaHome: string): void`（注册 `attachments.capabilities`）
  - `export const DAEMON_FEATURES: readonly string[] = []`（在 `capabilities.ts`），`connection.ts` 的 `hello` 带 `features: [...DAEMON_FEATURES]`。B3 合并时列表**为空**：适配器还没接入，此时广播 `attachments` 会让附件被悄悄丢掉。B4 的最后一步才把它改成 `["attachments"]`。

- [ ] **Step 1：写失败测试**：能力表每种组合一条；`refusal` 的文案包含适配器名和文件名；`textAttachmentBlock`：注入固定随机值并在内容里预先放这个边界串，断言会换一个；文件名含 `"` 和换行时只出现在 JSON 行里且被转义；`fetchAttachments`：sha256 不符、404、410 各一条；`connection.test.ts` 断言 `hello.features` 等于 `DAEMON_FEATURES`（B3 合并时为空数组）。
- [ ] **Step 2：确认失败**：`npx vitest run apps/cli/test/attachments apps/cli/test/connection.test.ts`。
- [ ] **Step 3：实现**。随机边界用 `randomBytes(16).toString("hex")`。
- [ ] **Step 4：确认通过**：同上；`npm run typecheck -w apps/cli`；`npm run typecheck`。
- [ ] **Step 5：合入最新 main（`setup.ts` 可能与 MCP 线冲突），提交并开 PR**。

---

### Task B4：适配器接入（可拆 B4a Claude / B4b Direct）

**Files:**
- B4a Modify: `apps/cli/src/claude/adapter.ts`；Test: `apps/cli/test/claude/adapter.test.ts`
- B4b Modify: `apps/cli/src/direct/transport.ts`、`apps/cli/src/direct/loop.ts`、`apps/cli/src/direct/adapter.ts`；Test: `apps/cli/test/direct/adapter.test.ts`、`loop.test.ts`、`transport.test.ts`

**Interfaces:**
- Consumes: B3 的 `attachmentCapabilities`、`refusal`、`fetchAttachments`、`attachmentPreamble`、`textAttachmentBlock`。
- Produces:
  - Claude：`userMessage(prompt: string, attachments: LoadedAttachment[]): string`，内容顺序：`text(prompt)`、`text(preamble)`、每个附件一个块（图片 `{ type: "image", source: { type: "base64", media_type, data } }`；PDF `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`；文本 `{ type: "text", text: textAttachmentBlock(a) }`）。
  - Direct：`InputContentPart = InputTextPart | { type: "input_image"; image_url: string } | { type: "input_file"; filename: string; file_data: string }`；`runToolLoop({ userText, userParts?: InputContentPart[] })`，第一条 user 消息为 `[input_text(userText), input_text(preamble), ...附件块]`，文本附件用 `input_text`。
  - Direct 请求体上限：`transport.ts` 导出 `MAX_DIRECT_REQUEST_BYTES = 48 * 1024 * 1024`；每次发请求前对 `JSON.stringify(body)` 的 UTF-8 字节数检查，超过就不发请求，抛出带固定原文的错误，`runToolLoop` 把它变成任务失败。

- [ ] **Step 1：写失败测试**：
  - B4a：假 `claude` 记录 stdin，断言收到的 JSON 内容块顺序与类型；说明块在所有附件块之前；能力为 `unknown` 的 PDF 时任务在启动 `claude` 之前就失败，错误是 `refusal` 的原文；没有附件时 stdin 与改动前逐字节相同。
  - B4b：用 `fake-responses-server.ts` 断言请求体：附件只在 `input` 的 user 消息里，`instructions` 不含任何附件字节或边界串；图片是 `data:image/png;base64,…`；PDF 是 `input_file` + `file_data`；工具调用后的第二次请求仍带附件（spec 已接受重发）；`compat` 下有图片时运行前失败；请求体超过 48 MB（测试里把上限注入为小值，或用一个足够大的文本附件加长历史）时假服务器收不到任何请求，任务失败原文含「超过模型一次请求的上限」；第一轮未超、工具调用后第二轮超限时同样在第二次请求前失败；没有附件时请求体与改动前相同。
- [ ] **Step 2：确认失败**：`npx vitest run apps/cli/test/claude/adapter.test.ts`、`npx vitest run apps/cli/test/direct`。
- [ ] **Step 3：实现**：两个适配器在 `run()` 开头：`refs = task.attachments ?? []`；非空时算能力、`refusal` 有值就直接 `return { ok: false, error }`；否则用 `new RoomClient(task.hubUrl, task.runToken, signal)` 取字节，失败同样返回明确错误。
- [ ] **Step 4：确认通过**：同上；`npm run typecheck -w apps/cli`。
- [ ] **Step 5：打开特性**：B4a、B4b 都通过后（拆成两个 PR 时，由后合并的那一个做），把 `DAEMON_FEATURES` 改成 `["attachments"]`，同时把 `connection.test.ts` 的断言改成含 `"attachments"`；再跑 `npx vitest run apps/cli/test/connection.test.ts apps/cli/test/attachments`。
- [ ] **Step 6：提交并开 PR**。

---

### Task B5：桌面网关放行上传

**Files:**
- Modify: `apps/local/src/gateway.ts`
- Test: `apps/local/test/gateway.test.ts`

**Interfaces:**
- Consumes: B0 的 `ATTACHMENT_LIMITS`（单文件上限取三者最大值 20 MB）。

- [ ] **Step 1：写失败测试**：`POST /api/workspaces/w1/attachments` 带 `application/octet-stream` 和有效会话 cookie 时转发到 hub，hub 端收到的字节与请求一致，且网关转发了网关凭据；同一路径没有会话 cookie → 401；`PUT` 同路径或其他 `/api` 路径用 `application/octet-stream` → 仍然 415；`Content-Length` 超过 20 MB → 413 且没有向上游发请求；声明的长度不超但实际超出 → 中止转发。
- [ ] **Step 2：确认失败**：`npx vitest run apps/local/test/gateway.test.ts`。
- [ ] **Step 3：实现**：在现有 415 判断前加一个只匹配 `POST` 与 `^/api/workspaces/[^/]+/attachments$` 的分支；请求体照旧 `pipe` 给 `http.request`，中间加计数，超限 `upstream.destroy()` 并回 413。
- [ ] **Step 4：确认通过**：同上；`npm run typecheck`。
- [ ] **Step 5：提交并开 PR**。

---

### Task B6：web 输入框与 hub 客户端

**Files:**
- Create: `apps/web/components/AttachmentTray.tsx`、`apps/web/lib/attachments.ts`、`apps/web/test/AttachmentTray.test.tsx`
- Modify: `apps/web/components/Composer.tsx`、`apps/web/lib/hub.ts`（重叠，末尾追加）、`apps/web/lib/types.ts`、`apps/web/messages/{en,zh,ja}.json`（重叠，`attach.` 前缀）、`apps/web/app/globals.css`（重叠，末尾追加 `att-` 样式）
- Test: `apps/web/test/Composer.test.tsx`

**Interfaces:**
- Consumes: B1 / B2 的接口形状；B0 的 `ATTACHMENT_LIMITS`、`AttachmentView`、`AttachmentCapabilities`。
- Produces:
  - `hub.ts`：`uploadAttachment(workspaceId, file: File): Promise<AttachmentView>`（`fetch` 原始字节，`Content-Type: application/octet-stream`，`X-Nema-Filename: encodeURIComponent(file.name)`，`X-Nema-Upload-Key`：每个托盘项创建时 `crypto.randomUUID()` 一次，重试沿用，走与 `request` 相同的 base 和 `credentials`）、`attachmentCapabilities(): Promise<AttachmentCapabilities | null>`（404 时返回 `null`）、`fetchAttachmentBlob(workspaceId, id): Promise<Blob>`、`deleteAttachment(workspaceId, id): Promise<AttachmentView>`；`postMessage`、`postThreadMessage`（及新建 thread 的函数）增加可选 `attachmentIds`，只在非空时放进请求体。
  - `Composer` 的 `onSend(content: string, attachmentIds: string[])`；`onThread` 同理。
  - `Message`（`lib/types.ts`）增加 `attachments: AttachmentView[]`。

- [ ] **Step 1：写失败测试**：粘贴图片、拖放文件、文件选择三种入口都会调用 `uploadAttachment`；上传中显示进度且发送按钮不可用；上传完成后显示预览（图片缩略图用 `URL.createObjectURL`，测试里 mock）和移除按钮；只有附件、没有文字时能发送，`onSend` 收到 `("", [id])`；超限文件在前端直接提示且不上传；能力为 `unsupported` / `unknown` 的类型显示具体提示并禁止发送；`attachmentCapabilities()` 返回 `null` 时附件入口不显示；发送失败时文字和附件都保留；三种语言的 `attach.*` 键齐全（`i18n.test.tsx` 现有的键对齐检查会覆盖）。
- [ ] **Step 2：确认失败**：`npx vitest run apps/web/test/Composer.test.tsx apps/web/test/AttachmentTray.test.tsx`。
- [ ] **Step 3：实现**。
- [ ] **Step 4：确认通过**：同上；`npm run lint -w apps/web`；`npm run build -w apps/web`；`npx vitest run apps/web/test/i18n.test.tsx`。
- [ ] **Step 5：合入最新 main（`hub.ts`、i18n、`globals.css` 可能冲突），提交并开 PR**。

---

### Task B7：web 消息里的附件显示与删除

**Files:**
- Create: `apps/web/components/AttachmentList.tsx`、`apps/web/test/AttachmentList.test.tsx`
- Modify: `apps/web/components/MessageItem.tsx`、`apps/web/messages/{en,zh,ja}.json`（重叠）
- Test: `apps/web/test/MessageItem.test.tsx`

**Interfaces:**
- Consumes: B6 的 `fetchAttachmentBlob`、`deleteAttachment`、`AttachmentView`。

- [ ] **Step 1：写失败测试**：图片附件用 `fetchAttachmentBlob` 拿到 blob 后显示缩略图（`<img src="blob:…">`，不直接用 hub 地址）；PDF 和文本显示文件卡片（名字、类型、大小），点击下载；`status = "deleted"` 显示「附件已删除」和删除时间、sha256 前 12 位；`missing` 显示「附件文件已丢失」；删除按钮先弹确认，确认文案含「已经发给 agent 或模型的内容无法撤回」，确认后调用 `deleteAttachment` 并用返回值替换显示；只有附件的用户消息不渲染空的 Markdown 块。
- [ ] **Step 2：确认失败**：`npx vitest run apps/web/test/AttachmentList.test.tsx apps/web/test/MessageItem.test.tsx`。
- [ ] **Step 3：实现**。组件卸载时 `URL.revokeObjectURL`。
- [ ] **Step 4：确认通过**：同上；`npm run lint -w apps/web`；`npm run build -w apps/web`。
- [ ] **Step 5：提交并开 PR**。

---

### Task B8：文档、changelog、真实模型验收

**Files:**
- Create: `changelog.d/chat-attachments.added.md`
- Modify: `README.md`、`README.en.md`（逐字节一致）、`README.zh.md`、`README.ja.md`、`docs/guide.{en,zh,ja}.md`、`docs/reference.zh-CN.md`、`docs/superpowers/specs/2026-10-30-chat-attachments-design.md`（能力表）、`apps/cli/src/attachments/capabilities.ts`（仅当验收结论改变能力表）

- [ ] **Step 1**：文档写：支持的类型与上限；附件存哪（`<dataDir>/attachments`，Compose 下是宿主 `~/.nema/data/attachments`，备份要连同数据库卷一起）；会发给所选的模型提供方；各适配器能用哪些类型；删除只删字节、留墓碑、已发出的无法撤回；`NEMA_ATTACHMENTS_MAX_BYTES`。
- [ ] **Step 2**：真实模型验收（在一次性环境里人工执行，不进自动化测试）：`claude-code` 发一张图、一份 PDF；`codex-direct`（`siwc`）同样；有条件时 `compat` 也做。每项记录：日期、CLI 版本、模型、结论（回复内容确实来自附件 / 被拒或被忽略）。把结论写回 spec 能力表，把对应的【推断】改成实测；通过的组合在 `capabilities.ts` 从 `unknown` 改为 `native`，并补一条单元测试。
- [ ] **Step 3：验证**：`node scripts/ci/docs-check.mjs <改动文件的 JSON 数组>`；`cmp README.md README.en.md`；若改了 `capabilities.ts`，`npx vitest run apps/cli/test/attachments` 与 `npm run typecheck -w apps/cli`。
- [ ] **Step 4：合入最新 main，提交并开 PR**。合并后更新 #104 的验收清单。

## 验收对照（#104）

| #104 验收项 | 由哪一批交付 |
| --- | --- |
| 输入框支持粘贴、拖放、文件选择，可预览、可移除，三种语言 | B6 |
| hub 端强制上限，只经鉴权路由提供 | B1、B2、B5 |
| 每个适配器拿到能用的形式，或用户看到具体原因，不静默丢弃 | B2（特性检查）、B3、B4 |
| 消息历史里显示附件 | B7 |
| 测试离线、先红后绿、changelog、README / guide 三语言 | 每批；B8 |

## Review Focus

- 附件字节、边界串是否出现在 `instructions`、日志或错误信息里。
- 任何读取路径是否绕过 workspace / 投递集合的限定。
- 上传路径之外的 `/api` 写请求是否仍然只收 JSON（hub 和网关两处）。
- 状态变化是否都是条件更新，失败路径是否都清理了文件和预留。
- 能力为 `unknown` 的组合是否真的被拒绝，而不是被原生发送。
