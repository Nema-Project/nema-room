# 同一供应商多账户与自动路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：可实现。** D-1 到 D-8 已由用户在 2026-10-31 全部定为推荐 A（spec 第 7、10 节），实现不得改变这些选择。某项在当前代码或当前 provider 上做不到时（例如声明的能力无法核对），停下报告，不悄悄换成另一个选项。

**Goal:** 让同一台机器上可以为同一供应商配多个账户（各自的 key / 项目 / 工作区、各自的默认模型与能力声明），按 workspace / thread / 本条消息选用，并在显式开启后按能力、限流与成本档位自动选择与切换；每次选择（用了哪个账户、哪个模型、为什么）写进消息元数据并在回复下方显示。

**Architecture:**
- **daemon 侧（`apps/cli`）：** 账户是「一个凭据 + 一个终点 + 一个默认模型」的记录，存在 `<nemaHome>/accounts.json`（0600），凭据在 `<nemaHome>/secrets/accounts/<id>/`（0700 / 0600）。`accounts.json` 不存在时从 `config.json` 与旧凭据读时合成一个隐式账户，用户第一次改账户设置才落盘（D-6）。`AuthStore` 接受自定义 base 目录，`siwc` 账户各自一把刷新锁。
- **设置服务（`apps/local`）：** 新增 `/_nema/accounts*` 一组接口，挂在现有 settings `dispatch` 上，沿用它的会话校验、单飞任务、`mutation_conflict` 与 `scrubbedError`。响应只加字段，不改已有字段含义。
- **协议（`packages/shared`）：** `task.assign` 加可选 `accountId` / `routing` / `threadId`；`task.finished` 的成功分支加可选 `route`；`AgentMessageMeta` 加可选 `route`。三个都可选，旧的一方忽略即可。
- **路由（`apps/cli`）：** 候选集按适配器、作用域、启用状态、凭据可用性、冷却、能力声明过滤，再按 `order` → `costTier` → `id` 排序；换账户只发生在两次模型调用之间，换后丢弃上一轮的 `encrypted_content`。
- **界面（`apps/web`）：** 设置页账户块、三处账户选择器、回复下方的一行路由信息。

**Tech Stack:** TypeScript、zod、Node.js `fs`、Vitest、Next.js、Hono。不新增运行时依赖（不引分词器、不引价格目录）。

**Spec:** [同一供应商多账户与自动路由设计](../specs/2026-10-31-multi-account-routing-design.md)。下文「§n」指该 spec 的第 n 节。调研背景见 [社区做法调研](../../reviews/2026-10-31-multi-account-routing-research.md)。

**Issue:** [#131](https://github.com/Nema-Project/nema-room/issues/131)，milestone v0.2.1。

**Base:** 写本计划时的 `origin/main` 是 `3582e1b`（Merge pull request #156）。动手前 `git fetch origin main`，再看：

```
git diff --name-only 3582e1b..origin/main -- apps/cli/src/config.ts apps/cli/src/direct apps/cli/src/secrets apps/cli/src/claude apps/cli/src/daemon apps/cli/src/attachments apps/cli/src/localSettings.ts apps/local/src/settings.ts apps/local/src/gateway.ts apps/web/lib/modelSettings.ts apps/web/components/ModelSettings.tsx apps/web/messages packages/shared/src/protocol.ts packages/shared/src/workspace.ts apps/hub/src/daemonSocket.ts apps/hub/src/messages.ts apps/hub/src/prompt.ts
```

有改动就先重读这些文件；与 spec「现状」不一致时先改本计划，不照着旧行号改代码。

## 如何服务 #45

[#45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准见 spec「如何服务 #45」。本计划每一批都守那三条：账户能力来自声明而不是猜测；每次路由决策可追溯（`meta.route`）；换账户改变的是账单与限额，所以默认不自动换（D-3），换的时候写出来。

## Global Constraints

- **不向 `config.json` 加任何键（D-6）。** `ConfigSchema` 是 `.strict()`；多一个键会让 0.2.0 读配置直接失败。全局默认账户从 `accounts.json` 里 `order` 最小的启用账户推出；`config.json` 的 `adapter` / `authMode` / `model` / `byokBaseUrl` 是它的**投影**，由设置页写回。
- **凭据只用现有私有文件机制。** 读写一律走 `apps/cli/src/secrets/file.ts` 的 `saveSecretLine` / `readSecretLine` 与 `apps/cli/src/secrets/permissions.ts` 的 `openPrivateFile` / `protectPrivatePath` / `privateModeMatches`。目录 0700、文件 0600，Windows 走私有 DACL。**凭据不进数据库、不进日志、不进错误文字、不进 `meta.route`。**
- **换账户只发生在两次模型调用之间。** 每次模型调用是独立请求；换账户就是下一条请求换凭据与终点。已经产生的对话历史继续用，但上一轮的 `encrypted_content` 整段丢掉（`apps/cli/src/direct/loop.ts:92`）。输出已经开始（收到过 `output_text` 增量）就不再换。
- **能力来自声明，不从模型名猜。** 没声明支持的账户不进自动候选；`unknown` 与 `false` 在自动模式下同样排除，只在界面上分别显示「未声明」与「不支持」。
- **不建用量或价格表（D-8）。** 不按价格排序、不做预算封顶、不算钱。`meta.route.usage` 只记 provider 自报的数字，没有就留空，绝不估算。
- **兼容：** 旧客户端（`ModelSettingsDto` 形状）读新响应不能报错；新前端对 `/_nema/accounts` 的 404 隐藏账户块，退回原来的四下拉界面。`task.assign` 三个新字段全部可选。
- **用户能感知的变化要写 `changelog.d/<slug>.<category>.md`**（`category` ∈ `added` / `changed` / `fixed` / `removed` / `security`，一条 `- ` 开头的中文 bullet，不加标题），不直接改 `CHANGELOG.md`。
- **测试不访问网络。** 只用临时 `nemaHome`、假 provider、录好的夹具；不启动真实 Claude Code，不碰真实的 `~/.nema`、`~/.codex`、`~/.claude`。
- **全量测试必须 `npm test -- --maxWorkers=2`。** 每个任务只跑它列出的文件 + `npm run typecheck`；全量测试在同一时间只跑一组。
- **文案：** 页面文字进 `apps/web/messages/{en,zh,ja}.json`，三种语言一起改。代码、注释、提交信息用英文。
- **不做的事：** 不跨适配器路由；不按任务内容分类选模型；不做并发/负载均衡；不新增 `rooms`、`agents` 表。

## Review Focus

- 凭据只出现在 `secrets/accounts/<id>/` 与 `AuthStore` 的内存里；任何 diff 里都不出现明文 key，测试夹具里也不出现。
- `accounts.json` 的读写是纯函数：坏 JSON、未知版本、重名、id 重复、目录里出现两种凭据都要有拒绝路径，且错误文字只说文件名不说内容。
- 读时合成的隐式账户**不写盘**；用户不改账户设置时，磁盘上一个新文件都没有。
- `config.json` 的投影在两个方向上都不丢字段：老版本改 `model` 后，新版本以投影为准更新默认账户。
- 路由候选集的每一步过滤都有测试；「空候选」与「冷却中」是重点。
- 旧 daemon / 旧 hub / 旧 web 任意一侧是旧版本时，行为与今天一致（除了没有账户选择）。

## 文件结构

| 文件 | 职责 | 批次 |
| --- | --- | --- |
| `apps/cli/src/accounts/schema.ts`（新） | `Account`、`AccountsFile` 的 zod schema；名字、id、`baseUrl`、`costTier` 校验；`IMPLICIT_ACCOUNT_ID` | S1 |
| `apps/cli/src/accounts/store.ts`（新） | `readAccounts` / `writeAccounts`（原子写，0600）、`accountsPath`、`accountDir` | S1 |
| `apps/cli/src/accounts/implicit.ts`（新） | 读时合成隐式账户、把隐式账户落盘并移动旧凭据、投影同步 | S1 |
| `apps/cli/src/accounts/credentials.ts`（新） | 每个账户的凭据路径与状态；`compat` 账户读 `~/.codex/auth.json` | S1 |
| `apps/cli/src/secrets/accounts.ts`（新） | `saveAccountSecret` / `readAccountSecret` / `removeAccountSecrets`，包装现有 secret 助手 | S1 |
| `apps/cli/src/direct/authStore.ts` | 构造参数加可选 base 目录（默认 `nemaHome`） | S1 |
| `apps/cli/src/localSettings.ts` | 导出账户相关函数给 `apps/local` | S1 |
| `apps/local/src/accountsApi.ts`（新） | `/_nema/accounts*` 的 dispatch 处理与 body 校验 | S2 |
| `apps/local/src/settings.ts` | 把 `/_nema/accounts*` 转给 `accountsApi`；`/_nema/settings` 响应加 `accounts` / `defaultAccountId` | S2 |
| `apps/web/lib/accounts.ts`（新） | 账户 API 客户端与类型；404 → `unsupported` | S2 |
| `apps/web/components/AccountSettings.tsx`（新） | 账户列表、新建/编辑表单、能力开关、成本档位 | S2 |
| `apps/web/components/ModelSettings.tsx`、`AppSettings.tsx` | 挂账户块 | S2 |
| `apps/web/components/AccountPicker.tsx`（新） | 本条消息 / thread / workspace 三处选择器 | S2 |
| `apps/web/messages/{en,zh,ja}.json` | 文案 | S2、S3、S4 |
| `apps/cli/src/routing/candidates.ts`（新） | 候选集计算：适配器、作用域、过滤、排序 | S3 |
| `apps/cli/src/routing/capabilities.ts`（新） | 能力三层解析（模型级 → 账户级 → 适配器兜底） | S3 |
| `apps/cli/src/routing/errors.ts`（新） | 错误分类：换 / 不换 | S3 |
| `apps/cli/src/routing/cooldown.ts`（新） | 进程内冷却表 | S3 |
| `apps/cli/src/routing/index.ts`（新） | `resolveRoute`：把上面的东西串起来，返回路由决策 | S3 |
| `packages/shared/src/protocol.ts` | `task.assign` 三个可选字段；`task.finished` 的可选 `route` | S3 |
| `packages/shared/src/workspace.ts` | `AgentMessageMeta.route` | S3 |
| `apps/cli/src/direct/adapter.ts`、`apps/cli/src/claude/adapter.ts` | 用路由决策替换「读一次 config 就定死」 | S3、S4 |
| `apps/hub/src/daemonSocket.ts` | 传 `accountId` / `routing` / `threadId`；收 `route` 并写 `meta` | S3 |
| `apps/web/components/MessageItem.tsx` | 回复下方路由一行与展开面板 | S3 |
| `apps/cli/src/routing/auto.ts`（新） | 自动模式的候选耗尽、`attempts`、进度事件 | S4 |
| `apps/web/lib/modelSettings.ts` | `ModelSettingsDto` 加 `accounts?` / `defaultAccountId?` | S2 |
| `docs/guide.{en,zh,ja}.md`、`docs/reference.zh-CN.md`、`README*.md` | 文档 | S5 |
| `changelog.d/multi-account-routing.added.md` | 片段 | S2、S3、S4 各追加一条，S5 收口 |

## 批次与依赖

| 批次 | 依赖 | 可并行 |
| --- | --- | --- |
| S1 账户数据与凭据 | — | 与 S5 的文档准备并行 |
| S2 设置接口与界面 | S1 | — |
| S3 路由核心（先只支持手动） | S1 | 与 S2 并行（不同文件） |
| S4 自动模式 | S3 | — |
| S5 文档与验收 | S2、S3、S4 | — |

每一批一个 PR，按顺序合并。S2 与 S3 改的文件不重叠，可以同时开工；两者都要改 `changelog.d/` 的同一个片段，合并时以先落地的那条为准追加，避免冲突。

---

## Batch S1：账户数据与凭据

本批只做数据与凭据，不接界面、不接路由。做完之后：`accounts.json` 能读写；每个账户的凭据在自己的目录里；旧单 key 配置在内存里表现为一个隐式账户；磁盘上不多出任何文件。

### Task S1.1：账户 schema

**Files:**
- Create: `apps/cli/src/accounts/schema.ts`
- Test: `apps/cli/test/accounts/schema.test.ts`

**Interfaces:**
- Produces:
  - `const IMPLICIT_ACCOUNT_ID = "acct_0000000000"`
  - `const COST_TIERS = ["low", "standard", "high"] as const`、`type CostTier`
  - `const AccountSchema = z.object({...})`（字段照 spec §2.1：`id`、`name`、`enabled`、`adapter`、`authMode?`、`baseUrl?`、`model?`、`modelCapabilities?`、`capabilities?`、`costTier`、`order`、`createdAt`），`.strict()`
  - `const AccountsFileSchema = z.object({ version: z.literal(1), accounts: z.array(AccountSchema), bindings: z.record(z.string(), z.string()) }).strict()`
  - `type Account = z.infer<typeof AccountSchema>`、`type AccountsFile = z.infer<typeof AccountsFileSchema>`
  - `newAccountId(random?: () => string): string`：`acct_` + 10 位 `[a-z0-9]`，拒绝产出 `IMPLICIT_ACCOUNT_ID`
  - `accountNameProblem(raw: string): string | null`：空、超过 40 个字符、含控制字符、看起来像密钥（长度 ≥ 20 且只含 `[A-Za-z0-9_\-+/=]`）时返回中文原因，否则 `null`
  - `validateAccountsFile(file: AccountsFile): string[]`：返回问题清单（重名不分大小写、id 重复、`byok` 缺 `baseUrl`、`compat` 带了 `baseUrl`、`claude-code` 带了 `authMode`、`codex-direct` 缺 `authMode`、`order` 不是非负整数）；空数组表示通过

`id` 规则 `^acct_[a-z0-9]{10}$`。`bindings` 的 key 只接受 `ws:<id>` 与 `thread:<id>` 两种前缀，值只接受 `auto` 或一个账户 id；这两条在 `validateAccountsFile` 里一起查。

- [ ] **Step 1: 写失败测试**：合法的四组合都能过；`acct_0000000000` 被 `newAccountId` 跳过；重名（仅大小写不同也算）、id 重复、`byok` 缺 `baseUrl`、`compat` 带 `baseUrl`、`claude-code` 带 `authMode`、`bindings` 值指向不存在的账户 —— 各自返回具体原因；`accountNameProblem` 对 41 个字符与疑似密钥返回原因，对「OpenAI 主账号」返回 `null`。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/accounts/schema.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条和 `npm run typecheck -w apps/cli` → PASS。
- [ ] **Step 5: Commit** `feat(cli): define the accounts file schema`

### Task S1.2：`accounts.json` 读写

**Files:**
- Create: `apps/cli/src/accounts/store.ts`
- Test: `apps/cli/test/accounts/store.test.ts`

**Interfaces:**
- Consumes: `AccountsFileSchema`、`validateAccountsFile`
- Produces:
  - `accountsPath(nemaHome: string): string` → `<nemaHome>/accounts.json`
  - `type AccountsRead = { status: "ok"; file: AccountsFile } | { status: "missing" } | { status: "unusable"; reason: "symlink" | "mode" | "corrupt" | "invalid" }`
  - `readAccounts(nemaHome: string): AccountsRead`：文件不存在返回 `missing`；符号链接、非 0600、JSON 坏了、schema 不过、`validateAccountsFile` 有错，都返回 `unusable` 并给出原因。**不抛异常**（设置页要把原因显示出来）
  - `writeAccounts(nemaHome: string, file: AccountsFile): void`：先 `validateAccountsFile`，有问题就抛错（错误只说哪一条，不打印内容）；然后原子写 0600（临时文件 + `fsync` + `rename` + `protectPrivatePath`，与 `apps/cli/src/config.ts:78-88` 同法）
  - `accountDir(nemaHome: string, accountId: string): string` → `<nemaHome>/secrets/accounts/<id>`，并断言 `accountId` 符合 `^acct_[a-z0-9]{10}$`（防止 `../` 逃逸）

- [ ] **Step 1: 写失败测试**：写入后读回相等且文件是 0600；写入时目录是 0700；`accounts.json` 换成符号链接 → `unusable/symlink` 且没有跟随读取；`chmod 0644` 后 → `unusable/mode`；坏 JSON → `unusable/corrupt`；重名 → `unusable/invalid`；`writeAccounts` 遇到重名抛错并且**没有**改动已有文件；`accountDir(home, "../x")` 抛错。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/accounts/store.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): read and write accounts.json atomically`

### Task S1.3：每账户凭据

**Files:**
- Create: `apps/cli/src/secrets/accounts.ts`、`apps/cli/src/accounts/credentials.ts`
- Test: `apps/cli/test/accounts/credentials.test.ts`

**Interfaces:**
- Consumes: `saveSecretLine`、`readSecretLine`、`protectPrivatePath`、`accountDir`、`byokKeyPath`、`claudeTokenPath`
- Produces（`secrets/accounts.ts`）：
  - `accountSecretPath(nemaHome: string, accountId: string, kind: "key" | "token"): string`
  - `saveAccountSecret(nemaHome: string, accountId: string, kind: "key" | "token", value: string): void`：目录 0700、文件 0600；值必须是一行非空（沿用 `saveSecretLine` 的规则）
  - `readAccountSecret(nemaHome: string, accountId: string, kind: "key" | "token"): string`
  - `removeAccountSecrets(nemaHome: string, accountId: string): void`：删掉整个 `<accountDir>`（`rmSync` 递归），不存在也不报错
- Produces（`credentials.ts`）：
  - `type CredentialState = "connected" | "missing" | "unusable"`
  - `accountCredentialFiles(nemaHome: string, account: Account): string[]`：该账户**应该**有的凭据文件（`byok` → `key`；`siwc` → `auth.json`；`claude-code` → `token`；`compat` → `[]`；隐式账户按 `config.authMode` 用**旧路径**）
  - `accountCredentialState(nemaHome: string, account: Account, codexHome: string): { state: CredentialState; files: string[] }`：`compat` 用 `readCodexCliTokens(codexHome)` 判定；其余用 `openPrivateFile` 试读一次；同一目录里出现两种凭据（例如 `byok` 账户里同时有 `key` 和 `token`）返回 `unusable`

隐式账户（`IMPLICIT_ACCOUNT_ID`）的凭据**不走** `secrets/accounts/`：它在 `accounts.json` 不存在时代表 `config.json` 现有的那套单 key，路径是今天的 `byok-key` / `claude-code-token` / `auth.json`。这条让 S1.4 的「不改磁盘」成立。

- [ ] **Step 1: 写失败测试**：`byok` 账户写入 key 后 `state=connected` 且文件 0600、目录 0700；删掉文件后 `missing`；`chmod 0644` 后 `unusable`；`claude-code` 账户只认 `token`；同目录出现 `key` + `token` → `unusable`；`compat` 账户在 `codexHome` 有 `auth.json` 时 `connected`、没有时 `missing`，且 `files` 为空；隐式账户读到的是旧路径；`removeAccountSecrets` 之后目录不在。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/accounts/credentials.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): keep each account's credentials in its own private directory`

### Task S1.4：`AuthStore` 支持自定义目录

**Files:**
- Modify: `apps/cli/src/direct/authStore.ts:116-124`（构造参数与文件路径）
- Test: `apps/cli/test/direct/authStore.test.ts`（补用例）

**Interfaces:**
- Produces: `AuthStoreOptions` 加 `baseDir?: string`；构造函数里 `this.file = path.join(opts.baseDir ?? nemaHome, "auth.json")`、`this.lockPath = path.join(opts.baseDir ?? nemaHome, "auth.lock")`。**`nemaHome` 仍然是必填的第一个参数**（`save` 用它 `mkdir` 与 `protectPrivatePath`，默认不传 `baseDir` 时两者相同，行为逐字不变）。

不改成「base 替代 nemaHome」：`save()` 里 `mkdirSync(this.nemaHome)` 与 `protectPrivatePath(this.nemaHome, 0o700)` 现在保护的是 `nemaHome` 本身（`:173-175`）。改成 base 会多一次对子目录的 `mkdir`，且要让 0700 落到 `secrets/accounts/<id>/` 上。这个改动留给 S1.3 的 `saveAccountSecret` 处理；`AuthStore` 只负责选文件位置。

- [ ] **Step 1: 写失败测试**：不传 `baseDir` 时文件仍在 `<nemaHome>/auth.json`（现有用例全部保持通过）；传了 `baseDir` 时 `save` 与 `inspect` 都落在 `<baseDir>/auth.json`，`nemaHome` 下**没有**新文件；两个 `AuthStore`（不同 `baseDir`）同时刷新各自的令牌互不阻塞（用两个假 refresher 各等一个 tick 断言都完成了）。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/direct/authStore.test.ts` → FAIL（新用例）。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 → PASS（旧用例不受影响）。
- [ ] **Step 5: Commit** `feat(cli): let AuthStore keep its files under an account directory`

### Task S1.5：读时合成的隐式账户与落盘迁移

**Files:**
- Create: `apps/cli/src/accounts/implicit.ts`
- Test: `apps/cli/test/accounts/implicit.test.ts`

**Interfaces:**
- Consumes: `readAccounts`、`writeAccounts`、`IMPLICIT_ACCOUNT_ID`、`saveAccountSecret`、`accountDir`
- Produces:
  - `loadAccounts(nemaHome: string, config: NemaConfig, codexHome: string): { accounts: Account[]; implicit: boolean; unusableReason?: string }`
    - `accounts.json` 不存在：返回一个隐式账户，字段从 `config` 推：`adapter` 取 `config.adapter`；`codex-direct` 时 `authMode` 取 `config.authMode`；`byok` 时 `baseUrl` 取 `config.byokBaseUrl`；`model` 取 `config.model`；`name` 固定「默认账户」；`costTier: "standard"`；`order: 0`；`enabled: true`；`createdAt` 取当天（只在内存里）。`implicit: true`
    - `accounts.json` 读出来是 `unusable`：同样返回隐式账户，但带 `unusableReason`，让设置页能显示「账户文件不可用，现在用的是默认账户」
  - `materializeImplicit(o: { nemaHome: string; config: NemaConfig; codexHome: string; name: string }): { account: Account; movedFrom: string | null }`
    - 把隐式账户写进 `accounts.json`（id 用 `newAccountId()`，不用 `IMPLICIT_ACCOUNT_ID`），并把旧凭据**移动**到 `secrets/accounts/<newId>/`：`byok` → `byok-key` 改名为 `key`；`claude-code` → `claude-code-token` 改名为 `token`；`siwc` → `auth.json` 改名为 `auth.json`（同目录内移动）；`compat` 不移动
    - `movedFrom` 是被移动的旧路径（测试与日志用，不含内容）；文件不存在时返回 `null`，不报错
    - 移动用 `renameSync`；跨设备（`EXDEV`）时退化为「读 → 写 → 删」，写走 `saveAccountSecret`，删旧文件前先确认新文件可读回
  - `syncDefaultAccountProjection(nemaHome: string, accounts: Account[], config: NemaConfig): Partial<NemaConfig> | null`
    - 找 `order` 最小的启用账户（`accounts.json` 有账户时）；若它的 `adapter` / `authMode` / `model` / `byokBaseUrl` 与 `config` 里的投影不同，返回需要写回的补丁（`saveConfig` 的入参），否则 `null`
    - 只在**读**的时候算，由调用方决定是否 `saveConfig`；daemon 启动与设置页首次读取各调一次

「以投影为准」的方向：老版本（0.2.0）只改 `config.json`，新版本读到投影与 `accounts.json` 不一致时，**把投影写进默认账户**（更新该账户的 `authMode` / `baseUrl` / `model`），再写回 `config.json` 保持两者一致。这一条是 D-6 里点名的 S1 验收项。

- [ ] **Step 1: 写失败测试**：
  - `accounts.json` 不存在 + `config` 是 `byok` + 有 `byok-key`：`loadAccounts` 返回一个隐式账户，`byokBaseUrl` 搬到了 `baseUrl`，`implicit` 为 `true`，且**磁盘上没有 `accounts.json`、没有 `secrets/` 目录**。
  - `accounts.json` 不可用（坏 JSON）：返回隐式账户并带 `unusableReason`。
  - `materializeImplicit`：`byok` 情况下 `accounts.json` 里出现一个新 id 的账户，`secrets/accounts/<id>/key` 内容等于原来的 `byok-key`，**旧文件已不在**；`movedFrom` 是旧路径。
  - `siwc` 情况下 `auth.json` 被移动、`AuthStore` 用新目录能 `inspect()` 到同一份登录。
  - `compat` 情况下什么都不移动，`movedFrom` 为 `null`，`~/.codex/auth.json` 未被碰过。
  - 旧凭据文件不存在时 `materializeImplicit` 不抛错。
  - 投影同步：`config.model` 被老版本改过（与默认账户不同）时 `syncDefaultAccountProjection` 返回含 `model` 的补丁；一致时返回 `null`。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/accounts/implicit.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条和 `npm run typecheck -w apps/cli` → PASS。
- [ ] **Step 5: Commit** `feat(cli): synthesize the implicit account and migrate the old single key on first edit`

### Task S1.6：导出与接线

**Files:**
- Modify: `apps/cli/src/localSettings.ts`
- Modify: `apps/cli/src/daemon/setup.ts`（启动时调一次 `syncDefaultAccountProjection`；不阻塞启动，失败只记一行日志，不打印内容）
- Test: `apps/cli/test/accounts/exports.test.ts`

**Interfaces:**
- Produces（`localSettings.ts` 追加导出）：
  - `Account`、`AccountsFile`、`IMPLICIT_ACCOUNT_ID`、`newAccountId`、`accountNameProblem`、`validateAccountsFile`
  - `accountsPath`、`readAccounts`、`writeAccounts`、`accountDir`
  - `loadAccounts`、`materializeImplicit`、`syncDefaultAccountProjection`
  - `accountCredentialState`、`accountCredentialFiles`
  - `saveAccountSecret`、`readAccountSecret`、`removeAccountSecrets`

`compat` 的 `readCodexCliTokens` 已在 `localSettings.ts` 导出，不重复。

- [ ] **Step 1: 写失败测试**：`@nema/cli/localSettings` 能 import 上面每个名字（类型用 `satisfies` 或 `import type` 断言）；daemon `setup` 在 `accounts.json` 存在且投影不同时调用了一次 `saveConfig`（用假的 config 读写，断言只写一次、且写的是补丁）。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/accounts/exports.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run typecheck` + **`npm test -- --maxWorkers=2`**（本批收口跑一次全量）→ PASS。
- [ ] **Step 5: Commit** `feat(cli): export the accounts helpers for the local settings service`

### S1 验收标准

- [ ] 全新用户（没有 `accounts.json`、没有旧凭据）跑一次 `nema doctor` 与一个假任务：磁盘上**没有**新增 `accounts.json` 或 `secrets/` 目录。
- [ ] 现有的 `byok` / `siwc` / `claude` / `compat` 四种配置，行为与 0.2.0 逐字相同（`apps/cli/test/direct/*`、`apps/cli/test/secrets/*` 全绿）。
- [ ] `materializeImplicit` 之后：旧凭据文件不在原位、新位置可读、`accounts.json` 是 0600。
- [ ] 老版本改 `config.json` 的 `model` 后，新版本启动时把该值写进默认账户，再写回 `config.json`，两边一致（D-6 点名的验收项）。
- [ ] 全量 `npm test -- --maxWorkers=2` 通过。
- [ ] **Sourcery / CI 预期：** 会改 `apps/cli` 与 `packages/shared` 的运行时，`classify` 判为 `full`，跑完整 `verify`（含 app tests 与 platform checks）。Sourcery review 可能长期 pending，不在门禁内，不等它。

---

## Batch S2：设置接口与界面

本批只做设置与选择器，不做路由。做完之后：用户能在设置页增删改账户、给账户写凭据、在三个地方选账户；daemon 收到选择后仍然按今天的逻辑跑（选择在 S3 才生效）。

### Task S2.1：`/_nema/accounts*` 接口

**Files:**
- Create: `apps/local/src/accountsApi.ts`
- Modify: `apps/local/src/settings.ts:175-250`（dispatch 里转给 accountsApi）
- Test: `apps/local/test/accountsApi.test.ts`

**Interfaces:**
- Consumes: `loadAccounts`、`readAccounts`、`writeAccounts`、`materializeImplicit`、`newAccountId`、`accountNameProblem`、`validateAccountsFile`、`accountCredentialState`、`saveAccountSecret`、`removeAccountSecrets`
- Produces:
  - `type AccountView = { id: string; name: string; enabled: boolean; adapter: Account["adapter"]; authMode?: Account["authMode"]; baseUrl?: string; model?: string; capabilities: Account["capabilities"]; costTier: Account["costTier"]; order: number; credential: CredentialState; implicit: boolean }`
  - `type AccountsReply = { status: number; body: Record<string, unknown> }`
  - `handleAccounts(method: string, pathname: string, body: unknown, deps: AccountsDeps): AccountsReply | null`：不认识的路径返回 `null`，让 `settings.dispatch` 继续走原来的分支
  - 路由（照 spec §5.3）：`GET /_nema/accounts`、`POST /_nema/accounts`、`PATCH /_nema/accounts`、`DELETE /_nema/accounts`、`POST /_nema/accounts/secret`、`POST /_nema/accounts/login`、`POST /_nema/accounts/probe`、`POST /_nema/accounts/bind`
  - 错误码沿用现有集合：`invalid_request`（400）、`mutation_conflict`（409）、`account_in_use`（409，删除仍被绑定的账户，body 带 `bindings: string[]`）、`account_exists`（409，重名）、`login_not_applicable`（409）、`probe_not_supported`（409）、`internal_error`（500，不带细节）
  - `DELETE` 一个仍被绑定的账户：返回 `account_in_use` 与绑定清单，**不删任何东西**
  - `DELETE` 没被绑定的账户：删账户记录 + `removeAccountSecrets`；**不允许删最后一个启用的账户**（返回 `invalid_request`）
  - `POST /_nema/accounts/secret`：`{ id, kind: "byok" | "claude", value }`，`value` 只校验「一行非空、无反斜杠换行」，写完只回 `{ saved: true }`
  - `POST /_nema/accounts/bind`：`{ scope: "ws:<id>" | "thread:<id>", accountId: string | null | "auto" }`；`accountId` 为 `null` 时删掉这条绑定

`/_nema/settings` 的响应加两个字段（不改已有字段）：`accounts: AccountView[]`、`defaultAccountId: string`（`order` 最小的启用账户）。`accounts` 在文件不可用时不返回（让界面显示 `unusableReason`）。

- [ ] **Step 1: 写失败测试**：`GET` 在只有隐式账户时返回一个 `implicit: true` 的账户；`POST` 建第二个账户后 `GET` 有两个；重名 → 409 `account_exists`；`PATCH` 改名成功；`DELETE` 仍被绑定的账户 → 409 且记录还在；`DELETE` 最后一个启用账户 → 400；`POST /secret` 写入后文件 0600、响应不含值；`POST /bind` 写入后在 `accounts.json` 里能读到，`accountId: null` 删掉；`POST /login` 对 `byok` 账户返回 `login_not_applicable`；不认识的子路径返回 `null`（由 `settings.dispatch` 落到 404）。
- [ ] **Step 2: 跑** `npx vitest run apps/local/test/accountsApi.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(local): serve the accounts settings API`

### Task S2.2：`/_nema/settings` 的账户字段

**Files:**
- Modify: `apps/local/src/settings.ts:72-105`（`redactedStatus` 加字段）
- Modify: `apps/web/lib/modelSettings.ts:14-22`（`ModelSettingsDto` 加 `accounts?`、`defaultAccountId?`；新增 `accountsApi` 客户端）
- Test: `apps/local/test/settings.test.ts`（补用例）、`apps/web/test/modelSettings.test.ts`（没有就新建）

**Interfaces:**
- Produces（web）：`type AccountView`（与后端同形，单独定义，不 import 后端的 zod）、`accountsApi.list()`、`accountsApi.create(body)`、`accountsApi.update(body)`、`accountsApi.remove(id)`、`accountsApi.saveSecret(id, kind, value)`、`accountsApi.bind(scope, accountId)`、`accountsApi.login(id)`、`accountsApi.probe(id)`
- `accountsApi` 的 404 → 抛 `AccountsUnsupportedError`（新类），由界面据此隐藏账户块

- [ ] **Step 1: 写失败测试**：`/_nema/settings` 响应含 `accounts` 与 `defaultAccountId`，且 `config` 的字段与改动前逐字相同（用固定夹具比对键集合）；`accounts` 里不含任何凭据值；web 侧 `accountsApi.list()` 在 404 时抛 `AccountsUnsupportedError`，其他错误码抛 `ModelSettingsError`。
- [ ] **Step 2: 跑** `npx vitest run apps/local/test/settings.test.ts apps/web/test/modelSettings.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run lint -w apps/web` → PASS。
- [ ] **Step 5: Commit** `feat: expose accounts in the settings response`

### Task S2.3：设置页账户块

**Files:**
- Create: `apps/web/components/AccountSettings.tsx`
- Modify: `apps/web/components/ModelSettings.tsx`（模型分组下面挂账户块）、`apps/web/messages/{en,zh,ja}.json`
- Test: `apps/web/test/AccountSettings.test.tsx`

**Interfaces:**
- Produces: `<AccountSettings onChanged={() => void} />`，内部读 `accountsApi.list()`；
  - 列表每行：名字、类型文案、地址（仅 `byok`）、默认模型、凭据三态、能力（图片 / PDF / 上下文，未声明写「未声明」）、成本档位、启用开关、编辑与删除
  - 新建/编辑表单：名字、类型（四选一，与现有四组合一致）、Base URL（仅 `byok`）、默认模型（可空）、能力三个开关 + 上下文数字、成本档位
  - 保存 `byok` 后出现凭据输入框（`type="password"`，只写不读），保存 `claude` 同理；`siwc` 显示登录按钮；`compat` 显示「使用本机 Codex 登录」与只读状态
  - `AccountsUnsupportedError` 时整块不渲染
  - 文案键：`account.title`、`account.add`、`account.name`、`account.kind`、`account.kind.siwc`、`account.kind.compat`、`account.kind.byok`、`account.kind.claude`、`account.baseUrl`、`account.model`、`account.capabilities`、`account.cap.image`、`account.cap.pdf`、`account.cap.context`、`account.cap.undeclared`、`account.cap.unsupported`、`account.costTier`、`account.costTier.low|standard|high`、`account.costTierHelp`、`account.enabled`、`account.credential`、`account.credential.connected|missing|unusable`、`account.delete`、`account.deleteConfirm`、`account.inUse`、`account.exists`、`account.save`、`account.saved`、`account.keyPlaceholder`、`account.login`、`account.compatHelp`

- [ ] **Step 1: 写失败测试**：列表显示三态与能力（未声明与不支持文案不同）；新建 `byok` 后出现凭据框、提交后调用 `saveSecret` 一次；重名时显示 `account.exists` 且表单保留输入；删除被占用的账户时显示绑定清单；`AccountsUnsupportedError` 时组件返回空。
- [ ] **Step 2: 跑** `npx vitest run apps/web/test/AccountSettings.test.tsx` → FAIL。
- [ ] **Step 3: 实现**（三份文案一起加）。
- [ ] **Step 4: 跑** 同一条 + `npm run lint -w apps/web` + `npm run build -w apps/web` → PASS。
- [ ] **Step 5: Commit** `feat(web): manage accounts in model settings`

### Task S2.4：三处账户选择器

**Files:**
- Create: `apps/web/components/AccountPicker.tsx`
- Modify: `apps/web/components/Composer.tsx`（本条消息）、`apps/web/components/ThreadView.tsx`（thread）、`apps/web/components/WorkspaceSettings.tsx`（workspace）、`apps/web/lib/hub.ts`（把选择随消息发出去）、`apps/hub/src/uiApi.ts`（`PostMessageBody` 接受可选的 `accountId`）、`apps/hub/src/messages.ts`（把 `accountId` 存进任务）、`apps/web/messages/{en,zh,ja}.json`
- Test: `apps/web/test/AccountPicker.test.tsx`、`apps/hub/test/uiApi.test.ts`（补用例）

**Interfaces:**
- Produces: `<AccountPicker scope="message" | "thread" | "workspace" value={string | null} onChange={(id) => void} accounts={AccountView[]} />`
  - `value = null` 显示「跟随 workspace」（workspace 作用域显示「全局默认」）
  - 本条消息的选择只存在组件状态里，随发送传给 hub；thread / workspace 的选择调用 `accountsApi.bind`
  - 账户少于 2 个且没有绑定记录时不渲染（单账户用户看不到多余控件）
- hub：`PostMessageBody` 加 `accountId?: string`；`postUserMessage` 把它写进任务（`tasks` 表加列由 S3.5 做，本批先只校验形状与长度，接受 `^acct_[a-z0-9]{10}$`）

- [ ] **Step 1: 写失败测试**：只有 1 个账户时不渲染；2 个账户时默认「跟随 workspace」；本条消息选择一个账户后发送，hub 收到的 `accountId` 一致；thread 选择调用一次 `bind("thread:<id>", …)`；非法 `accountId` 形状被 hub 以 400 拒绝。
- [ ] **Step 2: 跑** `npx vitest run apps/web/test/AccountPicker.test.tsx apps/hub/test/uiApi.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + **`npm test -- --maxWorkers=2`**（本批收口跑一次全量）→ PASS。
- [ ] **Step 5: Commit** `feat: let the user pick an account for a message, thread or workspace`

### S2 验收标准

- [ ] 单账户用户打开设置页，看到的界面与 0.2.0 相同（账户块里只有一行，选择器不出现）。
- [ ] 旧 web（0.2.0 构建）连新 daemon：`/_nema/settings` 正常、`Patch` 正常、四个下拉正常；`/_nema/accounts` 不被调用。
- [ ] 新 web 连旧 daemon：`/_nema/accounts` 404 → 账户块隐藏，其余不变。
- [ ] 删除账户要么拒绝（仍被绑定），要么连带删掉凭据目录；两种情况都没有残留。
- [ ] 全量 `npm test -- --maxWorkers=2` 通过。
- [ ] **Sourcery / CI 预期：** 改 `apps/local`、`apps/web`、`apps/hub`，`classify` 判为 `full`（web 改动触发完整 verify 与 web build）。

---

## Batch S3：路由核心（先只支持手动）

本批把「选哪个账户」从「界面记着」变成「daemon 真的用它跑任务」，并让用户看到结果。**自动模式在 S4 才出现**，本批所有任务走「手动指定或默认账户」这一条路。

### Task S3.1：协议字段与消息元数据

**Files:**
- Modify: `packages/shared/src/protocol.ts:35-59`（`task.assign` 三个可选字段）、`:20`（`task.finished` 成功分支加可选 `route`）
- Modify: `packages/shared/src/workspace.ts:52-66`（`AgentMessageMeta.route`）
- Test: `packages/shared/test/protocol.test.ts`、`packages/shared/test/workspace.test.ts`

**Interfaces:**
- Produces:
  - `const RouteDecisionSchema = z.object({ accountId: z.string(), accountName: z.string(), model: z.string(), mode: z.enum(["manual","auto"]), reason: z.enum(["user_workspace","user_thread","user_message","default","auto_primary","auto_failover","auto_after_limit"]), attempts: z.array(z.object({ accountId: z.string(), accountName: z.string(), model: z.string().optional(), failure: z.string() })).optional(), usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() }).optional() }).strict()`
  - `type RouteDecision = z.infer<typeof RouteDecisionSchema>`
  - `task.assign` 加 `accountId?: string`（`^acct_[a-z0-9]{10}$`）、`routing?: z.literal("auto")`、`threadId?: z.string().min(1)`
  - `task.finished` 成功分支加 `route?: RouteDecisionSchema`
  - `AgentMessageMeta` 加 `route?: RouteDecisionSchema`

`accountId` 用正则而不是 `z.string()`：hub 不校验账户是否存在（它不知道），但形状必须是我们的，否则一个乱串会一路传到 daemon 的路径拼接里。

- [ ] **Step 1: 写失败测试**：带与不带三个新字段的 `task.assign` 都能解析；`accountId: "../x"` 解析失败；`route` 在 `task.finished` 与 `AgentMessageMeta` 上都能往返；未知 `reason` 解析失败；旧形状（没有 `route`）的 `AgentMessageMeta` 仍然通过。
- [ ] **Step 2: 跑** `npx vitest run packages/shared/test/protocol.test.ts packages/shared/test/workspace.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(shared): carry an account choice and a route decision over the wire`

### Task S3.2：能力三层与候选集

**Files:**
- Create: `apps/cli/src/routing/capabilities.ts`、`apps/cli/src/routing/candidates.ts`
- Test: `apps/cli/test/routing/capabilities.test.ts`、`apps/cli/test/routing/candidates.test.ts`

**Interfaces:**
- Produces（`capabilities.ts`）：
  - `type TaskNeeds = { image?: boolean; pdf?: boolean }`（从 `TaskAssign.attachments` 推出：有 `kind === "image"` 就 `image`，有 `pdf` 就 `pdf`）
  - `taskNeeds(task: TaskAssign): TaskNeeds`
  - `type CapabilitySupport = "yes" | "no" | "undeclared"`
  - `accountCapability(account: Account, model: string, need: "image" | "pdf"): CapabilitySupport`：模型级 `modelCapabilities[model]` 有值就用它（`true` → `yes`，`false` → `no`）；否则账户级 `capabilities` 有值就用它；否则 `undeclared`
  - `adapterCapability(adapter: Account["adapter"], need: "image" | "pdf"): CapabilitySupport`：`claude-code` 的 `image` 是 `yes`、`pdf` 是 `undeclared`；`codex-direct` 两者都是 `yes`（与 `apps/cli/src/attachments/capabilities.ts:13-18` 一致）
  - `resolveCapability(account: Account, model: string, need: "image" | "pdf"): CapabilitySupport`：把上面两层合成，账户级没有声明时落到 `adapterCapability`
  - `accountForNeed(account: Account, needs: TaskNeeds): { ok: true } | { ok: false; missing: Array<"image" | "pdf"> }`
- Produces（`candidates.ts`）：
  - `type Candidate = { account: Account; model: string; capabilities: { image: CapabilitySupport; pdf: CapabilitySupport } }`
  - `type Excluded = { accountId: string; accountName: string; reason: "disabled" | "credential_missing" | "credential_unusable" | "compat_unreadable" | "cooling" | "capability" | "model_missing" }`
  - `type CandidateSet = { candidates: Candidate[]; excluded: Excluded[]; empty: boolean }`
  - `computeCandidates(o: { accounts: Account[]; adapter: Account["adapter"]; needs: TaskNeeds; credentialOf: (a: Account) => CredentialState; coolingUntil: (id: string) => number | null; now: () => number; resolveModel: (a: Account) => string | null }): CandidateSet`
    - 只留 `adapter` 相同的账户
    - 过滤顺序照 spec §4.1 第 3 步；`resolveModel` 返回 `null` 的记 `model_missing`（例如 `byok` 账户既没默认模型也没列表）
    - 排序：`order` 升序 → `costTier`（low → standard → high）→ `id` 字典序

- [ ] **Step 1: 写失败测试**：
  - 能力：模型级声明压过账户级；账户级压过适配器兜底；都没声明时 `claude-code` 的 pdf 是 `undeclared`、image 是 `yes`；`codex-direct` 两者都是 `yes`。
  - 需求合成：带一张图片的 `TaskAssign` → `{ image: true }`；没有附件 → `{}`。
  - 候选集：适配器不同的账户被排除且**不出现**在 `excluded` 里（它们不是候选，不该占「为什么没选它」的位置）；停用、凭据缺失、冷却中、能力不满足、模型缺失各自进 `excluded` 并带原因；同样输入两次排序结果相同；`costTier` 在 `order` 相同时生效；全被排除时 `empty: true` 且 `candidates` 为空。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/routing/capabilities.test.ts apps/cli/test/routing/candidates.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run typecheck -w apps/cli` → PASS。
- [ ] **Step 5: Commit** `feat(cli): compute routing candidates from declared capabilities`

### Task S3.3：错误分类与冷却

**Files:**
- Create: `apps/cli/src/routing/errors.ts`、`apps/cli/src/routing/cooldown.ts`
- Test: `apps/cli/test/routing/errors.test.ts`、`apps/cli/test/routing/cooldown.test.ts`

**Interfaces:**
- Produces（`errors.ts`）：
  - `type RouteFailure = "rate_limit" | "quota" | "server" | "context" | "auth" | "policy" | "bad_request" | "streaming_started" | "unknown"`
  - `type SwitchDecision = { switch: true; retryAfterMs?: number } | { switch: false; because: string }`
  - `classifyFailure(e: unknown, o: { startedOutput: boolean }): RouteFailure`
    - `startedOutput` 为真时一律 `streaming_started`（最高优先）
    - `ModelQuotaError` → `quota`；`ByokRejectedError` / `ReloginRequiredError` → `auth`；`AuthRateLimitedError` → `rate_limit`
    - `ModelApiError`：`status === 429` → `rate_limit`；`status >= 500` → `server`；`status === 401` → `auth`；`status === 403` → `policy`；`status === 400` 且正文匹配 `context_length|context window|too many tokens|prompt is too long` → `context`；其余 4xx → `bad_request`
    - 其他（连接错误已在上层重试过）→ `unknown`
  - `shouldSwitch(failure: RouteFailure): SwitchDecision`：只有 `rate_limit` / `quota` / `server` / `context` 为 `true`；其余为 `false` 并给中文原因（「这是这把 key 的问题」「这是供应商的内容策略」「请求本身有问题」「已经开始输出」）
- Produces（`cooldown.ts`）：
  - `class Cooldowns { constructor(o: { now?: () => number }) }`
  - `.until(accountId: string): number | null`、`.mark(accountId: string, ms: number): void`、`.clear(accountId: string): void`、`.clearAll(): void`
  - `cooldownFor(failure: RouteFailure, retryAfterMs?: number): number | null`：`rate_limit` → `retryAfterMs ?? 60_000`；`quota` → `retryAfterMs ?? 15 * 60_000`；`server` → 30_000；其余 `null`

时长是本计划的提议值，进代码时加注释说明「这是经验值，不是 provider 文档里的数字」。`quota` 的 15 分钟与订阅额度重置时间无关——真正的重置时间只有 provider 说了才有，没说不猜。

- [ ] **Step 1: 写失败测试**：每种 `ModelApiError` 状态与正文映射到正确的 `RouteFailure`；`startedOutput` 压过一切；`ModelQuotaError` 与 `ByokRejectedError` 的分类；`shouldSwitch` 对四类返回 `true`、对 `auth` / `policy` / `bad_request` / `streaming_started` 返回 `false` 且原因非空；冷却表在时间推进前返回 `until`、推进后返回 `null`；`clearAll` 后全空。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/routing/errors.test.ts apps/cli/test/routing/cooldown.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): classify routing failures and cool accounts down`

### Task S3.4：`resolveRoute`

**Files:**
- Create: `apps/cli/src/routing/index.ts`
- Test: `apps/cli/test/routing/resolve.test.ts`

**Interfaces:**
- Consumes: `computeCandidates`、`accountForNeed`、`Cooldowns`
- Produces:
  - `type RouteRequest = { task: TaskAssign; config: NemaConfig; accounts: Account[]; bindings: Record<string, string>; cooldowns: Cooldowns; credentialOf: (a: Account) => CredentialState; resolveModel: (a: Account) => string | null }`
  - `type RouteResult = { ok: true; account: Account; model: string; mode: "manual" | "auto"; reason: RouteDecision["reason"]; excluded: Excluded[] } | { ok: false; error: string; excluded: Excluded[] }`
  - `resolveRoute(req: RouteRequest): RouteResult`
    - 作用域优先级：`task.accountId` → `bindings["thread:"+task.threadId]` → `bindings["ws:"+task.workspaceId]` → 第一个启用账户
    - 命中的是具体账户：不走候选集，只查凭据（缺失/不可用 → `ok: false` 并说明是哪一项），`mode: "manual"`，`reason` 按来源给 `user_message` / `user_thread` / `user_workspace` / `default`
    - 命中的账户 id 在本机不存在（例如数据库从别的机器搬过来）：`ok: false`，错误写明「这条消息指定的账户在这台机器上不存在」
    - 本批 `routing: "auto"` 一律返回 `ok: false` 并写「自动路由将在后续版本提供」（S4 换掉这一行）
  - `routeDecision(result: RouteResult, model: string): RouteDecision`：把 `RouteResult` 转成协议里的形状（`attempts` 本批为空）

- [ ] **Step 1: 写失败测试**：四个来源的 `reason` 各自正确；`task.accountId` 指向不存在 id → `ok: false` 且文案非空；`task.accountId` 指向凭据缺失的账户 → `ok: false`；`bindings` 里 thread 压过 workspace；都没有时落到 `order` 最小的启用账户；`routing: "auto"` 在本批返回 `ok: false`；任何情况下返回里都不含凭据内容（用 `JSON.stringify(result)` 断言不含假 key 的字面量）。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/routing/resolve.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run typecheck -w apps/cli` → PASS。
- [ ] **Step 5: Commit** `feat(cli): resolve a task to one account and model`

### Task S3.5：hub 传递选择、落库、回写元数据

**Files:**
- Modify: `apps/hub/src/db/migrations/0NN_task_account.sql`（新；给 `tasks` 加 `account_id text` 与 `routing text`）
- Modify: `apps/hub/src/daemonSocket.ts:279-297`（构建 `task.assign` 时带 `accountId` / `routing` / `threadId`）、`:307-330`（`onFinished` 把 `m.route` 写进 `meta`）
- Modify: `packages/shared/src/protocol.ts`（S3.1 已完成）
- Test: `apps/hub/test/daemonSocket.test.ts`（补用例）、`apps/hub/test/migrations.test.ts`（如无则新建）

**Interfaces:**
- 迁移：`alter table tasks add column account_id text; alter table tasks add column routing text check (routing in ('auto'));`（两列都可空；旧的 `tasks` 行为不变）
- hub 在 `task.assign` 里带：`accountId: task.accountId ?? undefined`、`routing: task.routing ?? undefined`、`threadId: conversationThread?.id`

- [ ] **Step 1: 写失败测试**：消息带 `accountId` 时，`task.assign` 里出现同样的 id；不带时不出现这个字段；thread 任务带 `threadId`，主聊天不带；daemon 回 `route` 时它出现在保存的 agent 消息 `meta.route` 上；`meta` 里没有 `route` 时（旧 daemon）消息照常保存；迁移在已有 `tasks` 表上跑两次不报错。
- [ ] **Step 2: 跑** `npx vitest run apps/hub/test/daemonSocket.test.ts apps/hub/test/migrations.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(hub): pass the account choice down and store the route decision`

### Task S3.6：daemon 用手动路由跑任务

**Files:**
- Modify: `apps/cli/src/direct/adapter.ts:111-160`（`run()` 用 `resolveRoute` 代替「读一次 config 就定死」）
- Modify: `apps/cli/src/claude/adapter.ts`（同样取路由结果，`claude-code` 账户的 token 从账户目录读）
- Modify: `apps/cli/src/daemon/runner.ts`（把 `loadAccounts` 与 `Cooldowns` 传进适配器；`runner` 不改选择逻辑）
- Modify: `apps/cli/src/daemon/connection.ts:132-137`（`task.finished` 的成功分支带上 `route`）
- Test: `apps/cli/test/direct/adapter.test.ts`、`apps/cli/test/claude/adapter.test.ts`、`apps/cli/test/runner.test.ts`、`apps/cli/test/connection.test.ts`

**Interfaces:**
- `CodexDirectAdapterOptions` 加 `accounts?: () => { accounts: Account[]; bindings: Record<string,string> }`（默认由 `loadAccounts` 现取）
- `ClaudeAdapterOptions` 同形
- `AgentResult` 加可选 `route?: RouteDecision`（`packages/shared` 已有类型；`runner.ts:4` 的联合类型加这一项）
- 适配器在任务开始时算一次路由；失败时把 `route` 也带上（失败原因里已经有账户名与模型，元数据仍然记下来，便于事后看「是哪个账户失败的」）

- [ ] **Step 1: 写失败测试**：`byok` 账户 A 与账户 B 各有一把 key，任务点名 B 时请求头里的 key 是 B 的（用假 fetch 断言 `Authorization`）；点名一个凭据缺失的账户 → 任务失败、错误文字含账户名、**没有**发出任何请求；`siwc` 账户从 `secrets/accounts/<id>/auth.json` 取令牌（用临时 `nemaHome` 造两份不同的登录，断言用了正确的那份）；`route` 随 `task.finished` 回到 hub；claude 账户的 token 从账户目录读。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/direct/adapter.test.ts apps/cli/test/claude/adapter.test.ts apps/cli/test/runner.test.ts apps/cli/test/connection.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run typecheck -w apps/cli` → PASS。
- [ ] **Step 5: Commit** `feat(cli): run a task on the account the user chose`

### Task S3.7：回复下方的一行

**Files:**
- Modify: `apps/web/components/MessageItem.tsx:50-110`（路由一行与展开面板，放在 `askedQuestion` 与 `changes` 之间）
- Modify: `apps/web/messages/{en,zh,ja}.json`
- Test: `apps/web/test/MessageItem.test.tsx`（补用例）

**Interfaces:**
- 文案键：`route.line`（`模型：{account} · {model}`）、`route.lineWithReason`（`模型：{account} · {model}（{reason}）`）、`route.details`、`route.reason.user_workspace`、`route.reason.user_thread`、`route.reason.user_message`、`route.reason.default`、`route.reason.auto_primary`、`route.reason.auto_failover`、`route.reason.auto_after_limit`、`route.candidates`、`route.excluded`、`route.usage`、`route.noUsage`
- 展开面板列出 `attempts`（为空时不显示这一段）

- [ ] **Step 1: 写失败测试**：有 `meta.route` 时显示一行、理由按 `reason` 本地化；点「详情」出现候选与排除清单；没有 `meta.route` 时什么都不显示（旧消息）；`attempts` 为空时不渲染那一段。
- [ ] **Step 2: 跑** `npx vitest run apps/web/test/MessageItem.test.tsx` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run lint -w apps/web` → PASS。
- [ ] **Step 5: Commit** `feat(web): show which account and model answered`

### S3 验收标准

- [ ] 两个 `byok` 账户指向两个不同的假端点：在 workspace 里选 B，请求确实发到 B 的 `baseUrl` 与 key。
- [ ] 本条消息指定的账户压过 thread 压过 workspace。
- [ ] 点名的账户不存在或凭据缺失时任务失败并说明，**没有**任何请求发出。
- [ ] 回复下方显示账户与模型；旧消息不显示任何东西。
- [ ] `route` 里没有 base URL、没有 key、没有任何凭据内容。
- [ ] 自动模式的请求在本批明确失败并说明「后续版本提供」，不会悄悄按默认账户跑。
- [ ] 全量 `npm test -- --maxWorkers=2` 通过。
- [ ] **Sourcery / CI 预期：** 改 `apps/cli`、`apps/hub`、`packages/shared`、`apps/web`，`classify` 判为 `full`；新增迁移后 platform checks 会跑桌面数据目录升级夹具。

---

## Batch S4：自动模式

做完之后：打开全局开关，任务可以在候选集里自动选账户；限流或额度用尽时换下一个；换过几次、为什么，都写在 `meta.route.attempts` 与回复下方。

### Task S4.1：全局开关与 `routing: "auto"`

**Files:**
- Modify: `apps/cli/src/accounts/schema.ts`（`AccountsFile` 加 `autoRouting?: boolean`，默认 `false`）
- Modify: `apps/local/src/accountsApi.ts`（`PATCH /_nema/accounts` 接受 `{ autoRouting: boolean }`）
- Modify: `apps/web/components/AccountSettings.tsx`（开关）
- Test: `apps/cli/test/accounts/schema.test.ts`、`apps/local/test/accountsApi.test.ts`、`apps/web/test/AccountSettings.test.tsx`

- [ ] **Step 1: 写失败测试**：默认 `autoRouting` 是 `false`；`PATCH` 之后读回是 `true`；关着的时候 `resolveRoute` 对 `routing: "auto"` 仍返回 `ok: false` 并说明「自动路由未开启」。
- [ ] **Step 2: 跑** 三条测试文件 → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS + `npm run lint -w apps/web`。
- [ ] **Step 5: Commit** `feat: add the off-by-default automatic routing switch`

### Task S4.2：自动选择与切换

**Files:**
- Create: `apps/cli/src/routing/auto.ts`
- Modify: `apps/cli/src/routing/index.ts`（`routing: "auto"` 走 `auto.ts`）
- Modify: `apps/cli/src/direct/adapter.ts`（换账户时重建传输上下文；丢 `encrypted_content`）
- Test: `apps/cli/test/routing/auto.test.ts`、`apps/cli/test/direct/adapter.test.ts`

**Interfaces:**
- Produces:
  - `type Attempt = { account: Account; model: string; failure?: RouteFailure }`
  - `class AutoRouter { constructor(o: { candidates: Candidate[]; cooldowns: Cooldowns; startedOutput: () => boolean; onSwitch: (from: Attempt, to: Attempt, failure: RouteFailure) => void }); next(): Candidate | null; recordFailure(failure: RouteFailure, retryAfterMs?: number): void }`
  - `.next()` 返回下一个未试过的候选；`.recordFailure` 把当前账户写进冷却并推进指针
- `direct/adapter.ts`：每轮模型调用前问一次 `AutoRouter.next()`；换账户时重建 `TransportContext`（新 `TokenSource`、新 `profile`），并把 `history` 里所有 `type: "reasoning"` 的条目整段删掉；`onSwitch` 发一条 `progress` 事件「<账户 A> 被限流，改用 <账户 B>」

**推理丢弃的实现点**（`apps/cli/src/direct/loop.ts`）：`runToolLoop` 已经在 `history` 里累积 `reasoning` 条目（`:92-96`）。本任务给 `ToolLoopOptions` 加可选 `onBeforeCall?: (history: InputItem[]) => InputItem[]`，适配器在换账户后用它过滤掉 `reasoning` 条目。这样「丢掉上一轮加密推理」是一处可测的纯函数，而不是散在适配器里的 `while` 循环。

- [ ] **Step 1: 写失败测试**：
  - `AutoRouter`：依次返回候选；`recordFailure` 后当前账户在冷却且不再被返回；所有候选试完后 `next()` 返回 `null`；`startedOutput()` 为真时 `next()` 返回 `null`（不再换）。
  - 适配器：第一个账户 429、第二个成功 → 最终回复来自第二个，`meta.route.attempts` 有一条记录，`route.reason` 是 `auto_failover`；第一个账户 401 → **不换**，任务失败；第一轮已经收到文本增量后出错 → 不换。
  - 推理丢弃：换账户后发出的请求体里**没有** `encrypted_content`（用假 fetch 抓请求体断言）；不换账户时照常带上。
  - 换账户时发了一条 `progress` 事件，文字里有两个账户名。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/routing/auto.test.ts apps/cli/test/direct/adapter.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + `npm run typecheck -w apps/cli` → PASS。
- [ ] **Step 5: Commit** `feat(cli): switch accounts between model calls when automatic routing is on`

### Task S4.3：空候选与能力拒绝

**Files:**
- Modify: `apps/cli/src/routing/auto.ts`、`apps/cli/src/direct/adapter.ts`、`apps/cli/src/claude/adapter.ts`
- Test: `apps/cli/test/routing/auto.test.ts`、`apps/cli/test/direct/adapter.test.ts`、`apps/cli/test/claude/adapter.test.ts`

- [ ] **Step 1: 写失败测试**：任务带一张图片、所有候选都没声明支持图片 → 任务失败，错误文字点名「没有账户声明支持图片」并列出被排除的账户；手动点名一个没声明图片的账户 → 照发（请求照常带 `input_image`），provider 拒绝时错误文字与今天的 `attachmentRejection` 一致；自动模式下有部分账户声明支持时只挑那几个。
- [ ] **Step 2: 跑** 三条 → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): refuse an automatic route rather than downgrade capabilities`

### Task S4.4：界面上的自动选项

**Files:**
- Modify: `apps/web/components/AccountPicker.tsx`（开关打开时多一项「自动」）、`apps/web/messages/{en,zh,ja}.json`
- Test: `apps/web/test/AccountPicker.test.tsx`

- [ ] **Step 1: 写失败测试**：`autoRouting` 为假时没有「自动」项；为真时出现；选中后 `bind` 写入 `"auto"`；本条消息选「自动」时发送的 body 里 `routing: "auto"` 且不带 `accountId`。
- [ ] **Step 2: 跑** `npx vitest run apps/web/test/AccountPicker.test.tsx` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条 + **`npm test -- --maxWorkers=2`**（本批收口）→ PASS。
- [ ] **Step 5: Commit** `feat(web): offer automatic routing when the user turned it on`

### S4 验收标准

- [ ] 开关默认关；关着时界面没有「自动」，`routing: "auto"` 的请求明确失败。
- [ ] 打开后用两个假端点：第一个返回 429，任务在第二个上完成，`meta.route.attempts` 有一条，回复下方写了「被限流，改用 X」。
- [ ] 401 不换账户；已经开始输出后不换账户。
- [ ] 换账户后的第一次请求里没有 `encrypted_content`。
- [ ] 能力不满足且没有合格候选时失败并列出缺什么，**没有**发出任何请求。
- [ ] 全量 `npm test -- --maxWorkers=2` 通过。
- [ ] **Sourcery / CI 预期：** 同 S3，`full`。

---

## Batch S5：文档与验收

### Task S5.1：三语指南与技术参考

**Files:**
- Modify: `docs/guide.{en,zh,ja}.md`、`docs/reference.zh-CN.md`
- Modify: `README.md`、`README.en.md`（逐字节一致）、`README.zh.md`、`README.ja.md`
- Create: `changelog.d/multi-account-routing.added.md`

要写清的用户可见事实（三语一致）：

- 账户是什么、在哪里管、凭据放在哪、删账户会删掉什么。
- 三处选择器的优先级；「跟随 workspace」与「全局默认」的区别。
- 自动路由默认关；怎么开；开了之后哪些错误会换、哪些不会；换账户会丢掉上一轮的推理内容。
- 能力必须声明；没声明的账户不进自动候选；「未声明」与「不支持」的区别。
- 成本档位只影响排序，Nema 不知道真实价格（D-8）。
- 回退到 0.2.0 时账户看不到了，`config.json` 投影出来的那一个仍在用。

`changelog.d/multi-account-routing.added.md` 是一条 `- ` 开头的中文 bullet，汇总这一版用户能看到的变化。

- [ ] **Step 1:** 写三份指南的同一章节、技术参考、四份 README 的相关段落。
- [ ] **Step 2:** 跑 `node scripts/ci/docs-check.mjs` 的等价检查（把改动的路径列表喂给它）与 `npm run typecheck`。
- [ ] **Step 3: Commit** `docs: describe accounts and automatic routing`

### Task S5.2：真实账户验收记录

**Files:**
- Create: `docs/reviews/2026-MM-DD-multi-account-acceptance.md`

规则照本仓库既有验收文档：只用已有凭据，不申请新 key、不充值；记录真实输出；失败与限流照实写。

- [ ] **Step 1:** 用两个真账户（若只有一个可用凭据，就记「只有一个账户，自动路由的真实切换未测」，不假装测过）。
- [ ] **Step 2:** 手动模式：选 A 跑一个任务，确认回复下方写的是 A；选 B 再跑一次。
- [ ] **Step 3:** 自动模式：构造一次限流（用免费额度账户），记录是否切换、`attempts` 内容、回复下方文案。
- [ ] **Step 4:** 能力：给一个没声明图片的账户发带图片的任务，记录自动模式拒绝与手动模式照发的结果。
- [ ] **Step 5:** 把结果写进验收文档，并更新 ROADMAP 与 #131 的勾选。

### S5 验收标准

- [ ] 三份指南章节结构一致，命令与界面标签与实际一致。
- [ ] 四份 README 的相关段落更新，两份英文 README 逐字节一致。
- [ ] 验收文档里每个结论都有可复跑的步骤或真实输出，未测的项目写明未测。

## Self-Review

- **Spec 覆盖：** §1（用户看到什么）→ S2.3、S2.4、S3.7、S4.4；§2.1–2.2（账户与存放）→ S1.1–S1.2；§2.3（作用域映射）→ S3.4；§2.4（四组合与投影）→ S1.5、S1.6；§3（凭据）→ S1.3、S1.4；§3.4（迁移）→ S1.5；§4.1（候选集）→ S3.2、S3.4；§4.2（能力）→ S3.2、S4.3；§4.3（错误分类）→ S3.3、S4.2；§4.4（冷却）→ S3.3；§4.5（成本档位）→ S3.2、S2.3；§4.6（可观测）→ S3.1、S3.5、S3.7；§5（兼容）→ S2.2、S3.1、S3.5；§6（非目标）→ Global Constraints；§7/§10（决定）→ Global Constraints 与各批说明；§8（测试策略）→ 各任务 Step 1；§9（分批）→ 本计划的五个批次。
- **名称一致：** `Account`、`AccountsFile`、`IMPLICIT_ACCOUNT_ID`、`loadAccounts`、`materializeImplicit`、`syncDefaultAccountProjection`、`computeCandidates`、`resolveCapability`、`classifyFailure`、`shouldSwitch`、`Cooldowns`、`resolveRoute`、`RouteDecision`、`AutoRouter` 在定义处与使用处同名。
- **待定的一处：** 冷却时长。spec 只写了「时长自己定并写进决策」，本计划给了提议值并要求在代码注释里注明是经验值。这不是遗漏，是留到实现时按真实表现调整的量。
