# Codex Direct Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户的 Codex 运行不再启动 Codex CLI，而是在本机 `nema` daemon 内运行 Nema 自己的工具循环，用用户的 ChatGPT 订阅 OAuth（先官方 SIWC）调用 Responses API；模型只拿得到 3 个 Room 函数。第一步先加护栏：保密 workspace 拒绝使用 `codex-cli`。

**Architecture:** 新增 `apps/cli/src/direct/`：凭证存储（文件锁 + 刷新）、SIWC 登录、Responses 流式传输、工具循环与 `CodexDirectAdapter`。Room API 客户端从 `nema mcp` 中抽出复用。hub 只改协议：派发 `adapter: "auto"` 并带上 `confidential`，由 daemon 按本机配置选适配器。

**Tech Stack:** TypeScript（Node ≥ 22）、现有 monorepo、`zod`（含 `z.toJSONSchema`）、Node 内置 `fetch` / `http` / `crypto`、Vitest；不新增运行时依赖（如确需，先在报告中说明理由）。

**Spec:** `docs/superpowers/specs/2026-10-21-nema-room-design.md` §6.2、§6.7（2026-10-23 修订）。调研笔记：`docs/reviews/2026-10-23-codex-direct-research.md`（常量与来源出处）。

## Global Constraints

- hub 不调用模型、不接触用户凭证（spec 6.2）。所有 OAuth 与模型调用只在本机 daemon / `nema` CLI 内。
- Nema 单独登录，凭证存 `~/.nema/auth.json`（文件 0600、目录 0700、原子写入、`auth.lock` 文件锁）；**不读取、不导入、不链接 `~/.codex/auth.json`**（spec 6.7 第 2 项）。
- 刷新在过期前 120 秒进行，必须在锁内：加锁 → 重读 → 若刷新令牌已被别的进程换掉则直接采用 → 否则请求 → 写盘成功后才释放锁；写盘失败视为不可恢复（spec 6.7 第 2 项）。
- 不可恢复错误（`invalid_grant`、`invalid_token`、`refresh_token_reused`、`refresh_token_expired`、`refresh_token_invalidated`、刷新返回 401/403）：清掉本地令牌、记录 `lastAuthError`，任务失败并提示「直连登录已失效，请在终端运行 nema auth login」，不重试。
- 请求一律标识为 Nema：`originator: nema-room`，`User-Agent: NemaRoom/<cli 版本>`；**不冒充 `codex_cli_rs`**。
- 只向模型声明 `list_entries`、`read_entry`、`upsert_entry` 三个函数；不声明任何其他工具（含 web_search 等内置工具）。
- `store: false`、`stream: true`；无状态重放完整输入项；content 一律用 typed parts；`call_id` ≤ 64 字符且单次请求内唯一。
- 运行上限：24 次模型调用、60 次工具调用、10 分钟；不完整输出最多续写 3 次；网络 / 5xx 重试 1 次；401 强制刷新后重试 1 次（spec 6.7 第 4 项）。
- 不静默回退：直连失败不自动改用 `codex-cli`（spec 6.7 第 6 项）。
- `codex-cli` 对 `confidential: true` 的任务拒绝运行（spec 6.7 第 6 项；DC-1 未完成，隔离未通过验证）。
- SIWC 的刷新接口若无法从官方文档或实测确认，**不得猜测实现**，停下报告（spec 6.7 第 8 项）。
- 实现与测试不调用真实 OpenAI 接口；只有 Task 3 的人工关口和 Task 8 冒烟由用户本人登录后进行。
- 全局串行保持不变（Runner 一次一个任务）。

## Review Focus

1. **两个进程同时刷新令牌**（daemon 与 `nema auth status` / `probe` 并发）：期望只有一个进程真正请求刷新，另一个采用新令牌；绝不重放已用过的刷新令牌。→ Task 2 用两个真实子进程测试。
2. **`~/.nema/auth.json` 损坏、权限过宽或被替换为符号链接**：期望拒绝使用并提示重新登录，不跟随符号链接写入。→ Task 2 测试。
3. **模型请求了未声明的函数或参数不是合法 JSON**：期望返回错误输出给模型、计数，超过 5 次失败，绝不执行任何别的东西。→ Task 5 测试。
4. **额度用尽 / 订阅不可用（429 / 503）出现在流中途（`response.failed`）**：期望任务失败并显示中文原因与恢复时间（若有），已写入的条目保持不变。→ Task 4、Task 5 测试。
5. **保密 workspace 的任务被派到 `codex-cli`**（含旧名 `codex` 别名与 `auto`）：期望一律拒绝并给出切换指引，不启动 Codex。→ Task 1 测试。

---

## File Structure

```
packages/shared/src/protocol.ts          task.assign: adapter 改为 string，新增 confidential
apps/hub/src/daemonSocket.ts             派发 adapter:"auto" 与 workspace.confidential
apps/cli/src/config.ts                   ~/.nema/config.json：adapter / model / reasoningEffort / authMode
apps/cli/src/daemon/runner.ts            AgentAdapter.name: string；auto/别名解析
apps/cli/src/codex/adapter.ts            CodexCliAdapter（name "codex-cli"），保密拒绝
apps/cli/src/room/client.ts              Room API 客户端（从 mcp/server.ts 抽出）
apps/cli/src/mcp/server.ts               改用 room/client.ts
apps/cli/src/direct/authStore.ts         凭证文件、锁、刷新、错误分类
apps/cli/src/direct/lock.ts              跨进程文件锁
apps/cli/src/direct/jwt.ts               只解码 payload（不验签），取 exp 与账号 claim
apps/cli/src/direct/siwc.ts              SIWC 登录（PKCE 回调）、动态注册、刷新器、端点常量
apps/cli/src/direct/transport.ts         Responses 流式请求、SSE 解析、错误映射、模型列表
apps/cli/src/direct/loop.ts              工具循环（无状态重放、上限、续写）
apps/cli/src/direct/tools.ts             3 个函数的 JSON schema 与分发
apps/cli/src/direct/adapter.ts           CodexDirectAdapter
apps/cli/src/direct/compat.ts            （仅 Task 7 条件执行）兼容模式登录与传输配置
apps/cli/src/index.ts                    nema auth login/status/logout/probe、nema config get/set
apps/cli/src/doctor.ts                   新增「直连登录」检查
README.md                                直连模式说明、登录步骤、风险
```

---

### Task 1: 护栏与适配器选择管线

**Files:**
- Modify: `packages/shared/src/protocol.ts`, `packages/shared/test/protocol.test.ts`, `apps/hub/src/daemonSocket.ts`, `apps/hub/test/daemonSocket.test.ts`, `apps/cli/src/daemon/runner.ts`, `apps/cli/src/codex/adapter.ts`, `apps/cli/src/index.ts`
- Create: `apps/cli/src/config.ts`, `apps/cli/test/config.test.ts`
- Test: `apps/cli/test/runner.test.ts`（新建或并入 connection.test.ts）, `apps/cli/test/codexAdapter.test.ts`

**Interfaces:**
- Produces:
  - `task.assign` schema：`adapter: z.string().min(1)`，新增 `confidential: z.boolean()`（必填）
  - `type NemaConfig = { adapter: "codex-direct" | "codex-cli"; model?: string; reasoningEffort: "low"|"medium"|"high"; authMode: "siwc" | "compat" }`
  - `loadConfig(nemaHome: string): NemaConfig`（缺文件 → 默认值；本任务默认 `adapter: "codex-cli"`，Task 6 改为 `"codex-direct"`）、`saveConfig(nemaHome, patch: Partial<NemaConfig>): NemaConfig`（0600，原子写入，未知键拒绝）
  - `AgentAdapter.name: string`
  - `resolveAdapterName(requested: string, config: NemaConfig): string`：`"auto"` → `config.adapter`；`"codex"` → `"codex-cli"`（别名）；其余原样
- Consumes: hub 现有 `getWorkspace`

固定文案：`codex-cli` 拒绝保密任务时的错误为
`"codex-cli 适配器在保密 workspace 中被禁用（隔离未通过验证）。请改用 codex-direct：nema config set adapter codex-direct，或在 workspace 设置中关闭保密。"`

- [ ] **Step 1: 写失败测试**：protocol 接受 `adapter:"auto"` 与 `confidential`，缺 `confidential` 抛错；hub 派发的 assign 含 `adapter:"auto"` 且 `confidential` 等于 workspace 的设置（保密 / 非保密各一）；`resolveAdapterName("auto", {adapter:"codex-cli"}) === "codex-cli"`、`("codex", …) === "codex-cli"`；Runner 对 `confidential:true` + 解析为 `codex-cli` 的任务返回上面的固定错误且不调用 adapter.run（用假 adapter 断言未被调用）；`loadConfig` 缺文件返回默认值，`saveConfig` 拒绝未知键、文件权限 0600。
- [ ] **Step 2: 运行** `npx vitest run packages/shared apps/hub/test/daemonSocket.test.ts apps/cli` → FAIL
- [ ] **Step 3: 实现**：保密检查放在 `CodexCliAdapter.run` 开头（与 Runner 无关，任何入口都拦截）；Runner 只负责名称解析。
- [ ] **Step 4: 运行** 同上 → PASS；全量 `npx vitest run`、`npx tsc -b`、`npm run typecheck -w apps/cli` 通过
- [ ] **Step 5: Commit** `feat: refuse codex-cli for confidential workspaces; daemon-side adapter selection`

---

### Task 2: 凭证存储、跨进程锁与刷新

**Files:**
- Create: `apps/cli/src/direct/lock.ts`, `apps/cli/src/direct/jwt.ts`, `apps/cli/src/direct/authStore.ts`
- Test: `apps/cli/test/direct/authStore.test.ts`, `apps/cli/test/direct/lock.test.ts`, `apps/cli/test/fixtures/refresh-worker.mjs`

**Interfaces:**
- Produces:
  - `withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts?: {timeoutMs?: number /* 15000 */; pollMs?: number /* 50 */; staleMs?: number /* 30000 */}): Promise<T>`：用 `open(lockPath, "wx")` 写入 `{pid, at}` 实现；持有者进程不存在或超过 `staleMs` 视为陈旧并接管；超时抛 `LockTimeoutError`
  - `decodeJwtPayload(token: string): Record<string, unknown>`（不验签）；`jwtExp(token): number | null`
  - `type StoredAuth = { version: 1; mode: "siwc" | "compat"; clientId: string; tokens: { access_token: string; refresh_token: string; id_token?: string }; accountId?: string; lastRefresh: string; lastAuthError?: { code: string; message: string; at: string } }`
  - `type Refresher = (auth: StoredAuth) => Promise<{ access_token: string; refresh_token?: string; id_token?: string }>`（失败时抛 `RefreshError{status: number; code?: string; retryAfterS?: number}`）
  - `class AuthStore { constructor(nemaHome: string, refresher: Refresher, now?: () => number); read(): StoredAuth | null; save(auth: StoredAuth): void; clear(reason?: {code; message}): void; getAccessToken(opts?: {force?: boolean}): Promise<{ accessToken: string; auth: StoredAuth }> }`
  - 错误类：`ReloginRequiredError`（消息固定为「直连登录已失效，请在终端运行 nema auth login」）、`AuthRateLimitedError{retryAfterS?}`、`TransientAuthError`
- 规则（来自 Global Constraints）：skew 120 s；锁内重读并采用他人已换的令牌；返回无新 refresh_token 时保留旧的；`TERMINAL_CODES = ["invalid_grant","invalid_token","refresh_token_reused","refresh_token_expired","refresh_token_invalidated"]` 或 401/403 → 清令牌（仅当磁盘上仍是失败的那个刷新令牌）并记 `lastAuthError` → 抛 `ReloginRequiredError`；429 → `AuthRateLimitedError`；其余 → `TransientAuthError`；写盘失败 → 视为不可恢复（`ReloginRequiredError`，`lastAuthError.code = "credential_persist_failed"`）。
- 文件安全：读之前 `lstat`，是符号链接、不是普通文件、或权限不是 0600 → 视为不可用（`read()` 返回 null 并提示重新登录）；目录 0700。

- [ ] **Step 1: 写失败测试**：
  - 未过期直接返回，不调用 refresher；距过期 < 120 s 时刷新并保存新对（含 refresh_token 轮换与"无新 refresh_token 保留旧值"）
  - 锁内采用：磁盘上的 refresh_token 已与内存不同 → 不调用 refresher，返回磁盘上的令牌
  - 终止错误（每个 TERMINAL_CODE、401、403）→ 令牌被清、`lastAuthError` 记录、抛 `ReloginRequiredError`；磁盘上已是更新的令牌时不清
  - 429 / 5xx 分类正确；写盘失败（目录设为只读）→ `credential_persist_failed`
  - 符号链接 / 权限 0644 / 损坏 JSON → `read()` 为 null
  - **两个真实子进程**（`refresh-worker.mjs` 通过 `node --import tsx` 或预先构建后的 dist 运行）同时 `getAccessToken({force:true})`，refresher 用一个本地 HTTP 计数服务模拟：断言服务只收到 1 次刷新、两个进程拿到相同的新 access_token
  - `withFileLock`：陈旧锁（不存在的 pid）被接管；超时抛 `LockTimeoutError`
- [ ] **Step 2: 运行** `npx vitest run apps/cli/test/direct` → FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 运行** → PASS（连跑 3 次确认无抖动）；全量通过
- [ ] **Step 5: Commit** `feat(cli): locked auth store with refresh rotation for direct Codex`

---

### Task 3: SIWC 登录、探针命令与人工关口

**Files:**
- Create: `apps/cli/src/direct/siwc.ts`, `apps/cli/test/direct/siwc.test.ts`
- Modify: `apps/cli/src/index.ts`（`nema auth login|status|logout|probe`）
- Test: `apps/cli/test/direct/authCommands.test.ts`

**Interfaces:**
- Produces:
  - `SIWC` 常量对象（全部取自官方文档并在注释中写明 URL）：动态注册客户端 `dynamic_agent_client`、`agent_name_hint`（`"Nema Room"`）、`ext_agent_host_id`（本机稳定随机 id，存 `~/.nema/host-id`）、authorize URL、token URL、resource `https://api.openai.com/v1`、scopes `offline_access resource.invoke chatgpt.tokens.use.direct`、回调 `http://127.0.0.1:<port>/auth/callback`
  - `siwcLogin(opts: {nemaHome: string; openBrowser: (url: string) => void; port?: number /* 1455 */; timeoutMs?: number /* 300000 */}): Promise<StoredAuth>`：PKCE（S256）+ `state` 常数时间比较，监听只绑 `127.0.0.1`，换取令牌，保存 `mode:"siwc"` 与返回的 `oaiapp_` client id
  - `siwcRefresher: Refresher`
  - CLI：`nema auth login`（按 `config.authMode`，本任务只支持 `siwc`，`compat` 提示尚未实现）、`nema auth status`（模式、账号 id 末 4 位、过期时间、`lastAuthError`；**不输出任何令牌**）、`nema auth logout`、`nema auth probe`（列出模型名，并做一次不带工具的最小 Responses 调用「只回复 ok」，打印模型与结果）

- [ ] **Step 1: 读官方文档**：developers.openai.com/siwc 下的 quickstart、token-sharing-open-source/sign-in、models-and-inference、errors-and-recovery（URL 见调研笔记 §0）。把 authorize / token 请求的确切参数、动态注册流程、**刷新请求的端点与参数**、模型列表与错误码记录到 `siwc.ts` 顶部注释（每条附 URL）。**若找不到刷新接口的权威说明：实现登录与 probe，`siwcRefresher` 抛 `ReloginRequiredError` 并在报告中写明「刷新接口待确认」，状态报 DONE_WITH_CONCERNS，不得自行猜测参数。**
- [ ] **Step 2: 写失败测试**：本地假 OAuth 服务模拟授权码回调与 token 交换：成功登录保存 0600 文件且 `mode:"siwc"`、client id 被记录；`state` 不匹配拒绝；回调端口只绑 127.0.0.1；超时报错；`auth status` 输出不含令牌字符串（断言 stdout 不包含 access_token/refresh_token 的值）；`logout` 删除文件。
- [ ] **Step 3: 运行** → FAIL；**Step 4: 实现**；**Step 5: 运行** → PASS，全量通过
- [ ] **Step 6: Commit** `feat(cli): SIWC login, auth status/logout/probe`
- [ ] **Step 7: 人工关口（控制者执行，不派子 Agent）**：请用户在自己的终端运行 `npm run build -w apps/cli && npx nema auth login` 与 `npx nema auth probe`，并在一段时间后（或用 `--force-refresh` 调试开关，若 Step 1 已确认刷新接口）验证刷新。按结果记录：
  - SIWC 登录、probe、刷新都成功 → 跳过 Task 7。
  - 账号无法开通 SIWC（登录被拒 / 无 plan usage 权限 / probe 返回不可用）→ 执行 Task 7（用户已接受风险，spec 6.7 第 8 项），之后的任务以 compat 模式验证。
  - 刷新接口无法确认 → 停下向用户报告，等待决定。

---

### Task 4: Responses 流式传输与错误映射

**Files:**
- Create: `apps/cli/src/direct/transport.ts`, `apps/cli/test/direct/transport.test.ts`, `apps/cli/test/fixtures/fake-responses-server.ts`

**Interfaces:**
- Consumes: Task 2 `AuthStore.getAccessToken`
- Produces:
  - `type TransportProfile = { baseUrl: string; extraHeaders(auth: StoredAuth): Record<string,string>; modelsPath: string; parseModels(json: unknown): string[] }`；`SIWC_PROFILE`（baseUrl `https://api.openai.com/v1`，模型 `GET /models` 过滤 `visibility === "list"`）
  - `type ResponsesRequest = { model: string; instructions: string; input: InputItem[]; tools: FunctionTool[]; reasoning: {effort: string; summary: "auto"}; sessionId: string }`
  - `streamResponse(req, ctx: {auth: AuthStore; profile: TransportProfile; version: string; signal: AbortSignal; onTextDelta?: (t: string) => void}): Promise<CollectedResponse>`；`type CollectedResponse = { status: "completed" | "incomplete"; items: OutputItem[]; incompleteReason?: string }`
  - `listModels(ctx): Promise<string[]>`
  - 错误：`ModelQuotaError{resetsAt?: number}`（429 `usage_limit_reached` / `subscription_sharing_usage_limit_exceeded` / `usage_not_included` / `insufficient_quota`，503 `subscription_sharing_usage_unavailable`，以及以 `response.failed` 携带这些码的情形）、`ModelApiError{status?; code?; message}`、Task 2 的 `ReloginRequiredError`
- 请求：`POST {baseUrl}/responses`，头 `Authorization: Bearer`、`Content-Type: application/json`、`Accept: text/event-stream`、`originator: nema-room`、`User-Agent: NemaRoom/<version>`、`session_id`，加 `profile.extraHeaders`；体 `{model, instructions, input, store:false, stream:true, tools, tool_choice:"auto", parallel_tool_calls:false, reasoning, include:["reasoning.encrypted_content"]}`（不发送 `max_output_tokens`、`prompt_cache_retention`、`previous_response_id`）
- 解析：按 SSE 帧解析；以 `response.output_item.done` 组装 items（全部带 `output_index` 时按其排序，否则按到达顺序）；补齐已 `added` 但未 `done` 的 function_call；`response.output_text.delta` → `onTextDelta`；终止事件 `response.completed` / `response.incomplete` / `response.failed`；`error` 帧抛错；只有推理项而无文本 / 函数调用的 completed 视为 `incomplete`
- 重试：连接错误 / 5xx 重试 1 次；401 → `getAccessToken({force:true})` 后重试 1 次，仍 401 → `ReloginRequiredError`

- [ ] **Step 1: 写失败测试**（假 SSE 服务）：文本流 + completed；函数调用（added → arguments.delta → done）组装出 `{type:"function_call", call_id, name, arguments}`；`output_index` 乱序到达仍按序；completed 但 `output` 为空时仍以 done 项为准；reasoning-only → incomplete；`response.incomplete`；401 → 强制刷新一次后成功；连续 401 → `ReloginRequiredError`；429 `usage_limit_reached`（含 `resets_at`）→ `ModelQuotaError.resetsAt`；流中途 `response.failed` 携带 `subscription_sharing_usage_limit_exceeded` → `ModelQuotaError`；503 → 同上；5xx 一次后成功；断言请求头含 `originator: nema-room`、不含 `codex_cli_rs`，请求体 `store:false` 且无 `max_output_tokens`。
- [ ] **Step 2: 运行** → FAIL；**Step 3: 实现**；**Step 4: 运行** → PASS
- [ ] **Step 5: Commit** `feat(cli): streaming Responses transport with error mapping`

---

### Task 5: Room 客户端抽取、工具循环与 CodexDirectAdapter

**Files:**
- Create: `apps/cli/src/room/client.ts`, `apps/cli/src/direct/tools.ts`, `apps/cli/src/direct/loop.ts`, `apps/cli/src/direct/adapter.ts`
- Modify: `apps/cli/src/mcp/server.ts`（改用 room/client）
- Test: `apps/cli/test/room/client.test.ts`, `apps/cli/test/direct/loop.test.ts`, `apps/cli/test/direct/adapter.test.ts`（现有 `mcpServer.test.ts` 必须继续通过）

**Interfaces:**
- Consumes: Task 4 `streamResponse`；Task 2 错误类；Task 1 `AgentAdapter`
- Produces:
  - `class RoomClient { constructor(hubUrl: string, runToken: string); listEntries(); readEntry(id: string); upsertEntry(input: unknown): Promise<RoomResult> }`；`type RoomResult = { ok: true; json: unknown } | { ok: false; status: number; error: string }`
  - `ROOM_TOOLS: FunctionTool[]`（3 个，`strict: false`，参数 schema：`list_entries` 无参数；`read_entry {id}`；`upsert_entry` 由 `z.toJSONSchema(UpsertEntryInput)` 生成）；`dispatchTool(name: string, argsJson: string, room: RoomClient): Promise<{output: string; known: boolean}>`（未知函数 / 非法 JSON → `{output: JSON.stringify({error: "..."}), known: false}`）
  - `runToolLoop(opts: {instructions: string; userText: string; call: (input: InputItem[]) => Promise<CollectedResponse>; room: RoomClient; onProgress: (text: string) => void; limits?: {maxModelCalls: number /* 24 */; maxToolCalls: number /* 60 */; maxUnknownTools: number /* 5 */; maxContinuations: number /* 3 */}}): Promise<{ reply: string }>`
  - `class CodexDirectAdapter implements AgentAdapter { name = "codex-direct"; constructor(opts: {nemaHome: string; version: string; profile?: TransportProfile; timeoutMs?: number /* 600000 */; now?: () => number }) }`
- 循环规则：
  - 输入：`instructions` = hub 下发的 prompt；首个输入项为 user 消息 `[{type:"input_text", text: "请按上面的指令处理本次用户消息，并只通过提供的函数读写项目知识。"}]`
  - 每轮把模型输出中的 reasoning 项（去掉 `id`）、message 项、function_call 项追加到历史；对每个 function_call 执行 `dispatchTool` 并追加 `function_call_output`（同 `call_id`）；`call_id` 超过 64 字符时替换为 `call_<sha256 前 32 位>`，单次请求内重复时追加 `_dup<n>`
  - 无函数调用且为 completed → 返回最后一条 assistant 文本作为 reply（为空则失败「Agent 没有返回回复」）；incomplete → 追加 user 消息「请继续。」续写，最多 3 次
  - 超限错误文案：`"Agent 超出单次运行上限（模型调用 24 次）"`、`"Agent 超出单次运行上限（工具调用 60 次）"`、`"Agent 多次请求未提供的工具，已中止"`、超时 `"Codex 直连运行超时"`
- adapter：`run(task, onEvent)` → 从 `AuthStore` 取令牌（无登录 → `{ok:false, error:"未登录直连 Codex，请在终端运行 nema auth login"}`）→ 模型取 `config.model` 或 `listModels` 第一个，均不可得时 `"gpt-5.5"` → `runToolLoop` → 映射错误：`ReloginRequiredError` → 其固定消息；`ModelQuotaError` → `"订阅额度已用完" + (resetsAt ? "，预计 <本地时间> 恢复" : "")`；`ModelApiError` → `"模型接口错误：" + message`；文本增量节流后以 `{type:"agent_message", text}` 进度事件回传

- [ ] **Step 1: 写失败测试**：RoomClient 带 `Authorization: Bearer <runToken>`、非 2xx 返回 `{ok:false}`（mcpServer 测试不变通过）；`dispatchTool` 对未知名 / 非法 JSON 返回 known:false 且不访问 hub；循环：一次 upsert + 最终回复；多个函数调用按 call_id 配对；call_id 超长替换与重复改名；incomplete 续写成功、续写 3 次仍不完整失败；24 / 60 / 5 次上限各一测试；adapter：无登录、`ReloginRequiredError`、`ModelQuotaError`（含 resetsAt 格式化）、超时文案；断言请求的 `tools` 恰为 3 个函数且无其他类型。
- [ ] **Step 2: 运行** → FAIL；**Step 3: 实现**；**Step 4: 运行** → PASS，全量通过
- [ ] **Step 5: Commit** `feat(cli): codex-direct tool loop and adapter over Room API`

---

### Task 6: 接线、配置命令、doctor 与 README

**Files:**
- Modify: `apps/cli/src/index.ts`, `apps/cli/src/config.ts`（默认 adapter 改为 `codex-direct`）, `apps/cli/src/doctor.ts`, `README.md`
- Test: `apps/cli/test/config.test.ts`, `apps/cli/test/doctor.test.ts`, `apps/cli/test/indexCommands.test.ts`

**Interfaces:**
- Produces：`nema config get [key]` / `nema config set <key> <value>`（键：`adapter`、`model`、`reasoningEffort`、`authMode`；非法值报错）；`nema daemon` 同时注册 `CodexDirectAdapter` 与 `CodexCliAdapter`，hello 上报两者；`nema doctor` 新增一行 `✓/✗ 直连登录：<已登录（模式, 到期时间）| 已失效，请运行 nema auth login | 未登录>`（当 `adapter` 为 `codex-direct` 时未登录记为 ✗，为 `codex-cli` 时记为提示但不判失败）
- README：新增「Codex 直连（默认）」一节：`npx nema auth login`、`nema auth status`、`nema config set adapter …`；说明 `codex-cli` 在保密 workspace 被禁用；说明 SIWC 与兼容模式的风险（照 spec 6.7 第 3、8 项与 §7）

- [ ] **Step 1: 写失败测试**：默认配置 adapter 为 `codex-direct`；`config set` 非法键 / 值报错；doctor 三种登录状态输出与判定；daemon 启动时 Runner 含两个 adapter（以可注入的工厂测试）。
- [ ] **Step 2: 运行** → FAIL；**Step 3: 实现**；**Step 4: 运行** → PASS；全量、`npx tsc -b`、cli typecheck、`npm run build -w apps/cli` 通过
- [ ] **Step 5: Commit** `feat(cli): make codex-direct the default adapter; auth/config commands; doctor`

---

### Task 7（条件执行）: 兼容模式

**仅当 Task 3 Step 7 判定用户账号无法开通 SIWC 时执行。**

**Files:**
- Create: `apps/cli/src/direct/compat.ts`, `apps/cli/test/direct/compat.test.ts`
- Modify: `apps/cli/src/index.ts`（`authMode=compat` 的登录）, `README.md`

**Interfaces:**
- Produces（常量取自调研笔记 §1a、§2、§3，注释写明出处）：
  - 设备码登录 `compatDeviceLogin(...)`：`POST https://auth.openai.com/api/accounts/deviceauth/usercode {client_id: "app_EMoamEEZ73f0CkXaXp7hrann"}`（429 退避 `min(Retry-After ?? 2**n, 60)`，最多 4 次）→ 提示用户打开 `https://auth.openai.com/codex/device` 输入 `user_code` → 每 `max(3, interval || 5)` 秒轮询 `POST .../deviceauth/token {device_auth_id, user_code}`（403/404 为等待中，15 分钟超时）→ `POST https://auth.openai.com/oauth/token`（form：`grant_type=authorization_code`、`code`、`redirect_uri=https://auth.openai.com/deviceauth/callback`、`client_id`、`code_verifier`；仅在连接错误时重试）
  - `compatRefresher`：`POST https://auth.openai.com/oauth/token` form `grant_type=refresh_token&refresh_token&client_id`
  - `COMPAT_PROFILE`：baseUrl `https://chatgpt.com/backend-api/codex`；extraHeaders：`ChatGPT-Account-ID`（access_token JWT 中 `https://api.openai.com/auth`.`chatgpt_account_id`）、存在时 `x-openai-internal-codex-residency`（`chatgpt_data_residency` 或 `chatgpt_compute_residency`）；模型 `GET /models?client_version=99.0.0`（400 时回退 `0.0.0`），过滤 `visibility` 为 `hide`/`hidden`、按 `priority` 排序
- [ ] **Step 1: 写失败测试**（假服务）：设备码各分支（等待、429 退避、超时）、交换、刷新、COMPAT 头部、模型列表回退；
- [ ] **Step 2–4:** FAIL → 实现 → PASS
- [ ] **Step 5: Commit** `feat(cli): compat (Codex-client) mode for direct adapter`

---

### Task 8: 真实冒烟（控制者 + 用户）

- [ ] **Step 1:** `npm run build -w apps/cli`；用户已登录（Task 3 Step 7）；`npx nema doctor` 全部 ✓（直连登录 ✓）。
- [ ] **Step 2:** 启动 compose 栈（`npm run up`）与 `npx nema daemon`；新建**保密** workspace，发送一条随手记录；期望：直连适配器处理，产生条目与恰好一张追问卡片，git 提交存在。
- [ ] **Step 3:** 回答追问；期望对应 question 变为 resolved。
- [ ] **Step 4:** `nema config set adapter codex-cli` 后在同一保密 workspace 发消息 → 期望任务失败并显示 Task 1 的固定文案、未启动 codex 进程；改回 `codex-direct`。
- [ ] **Step 5:** 检查本机：无 `nema-run-*` 临时目录新增、无 codex 子进程、`~/.codex/auth.json` 未被修改（比较修改时间）。
- [ ] **Step 6:** 记录结果；如有缺陷，派实现者修复并审查后重跑相关步骤。
