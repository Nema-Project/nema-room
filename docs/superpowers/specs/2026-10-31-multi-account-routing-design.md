# 同一供应商多账户与自动路由

- **Issue：** [#131](https://github.com/Nema-Project/nema-room/issues/131)
- **目标版本：** v0.2.1（milestone）
- **核对基线：** `origin/main` `3d676f2`（Merge pull request #154，v0.2.0 收尾）；2026-10-31 13:35 JST 逐文件核对行号
- **调研：** [多账户与自动路由：社区做法调研](../../reviews/2026-10-31-multi-account-routing-research.md)（2026-10-31 抓取；本文所有「社区怎么做」都指向那份文件里的 URL）
- **状态：** 八项决策已由用户在 2026-10-31 定下（全按推荐 A，见第 10 节），plan 按第 7 节与第 10 节写。这一版只有文档，没有改代码。

## 如何服务 #45

按 [#45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准衡量：这件事服务的不是「更能干」，而是**「这次回答是谁给的、花了谁的额度、为什么是它」可以被核对**。

- **可追溯：** 每条回复记下账户、模型和选择理由。事后能回答「这句话出自哪把 key 背后的哪个模型」，而不是只知道「用了 Nema」。
- **不夸大：** 能力来自**声明**，不从模型名猜；没有声明的一律不进自动候选。选不到就如实说缺什么，不悄悄换成别的能力或别的账户。
- **不越权：** 换账户可能换账单、换限额。默认不自动换（D-3），自动模式下每次换都写出来。
- **密钥仍然只在本机：** 账户与凭据不写进数据库、不进日志、不进消息元数据（只有账户名字和 id）。

本设计不把 Nema 变成模型网关，也不引入按 token 计价的成本优化（本仓库今天没有任何用量或价格数据，见 4.5 与 D-8）。

## 1. 用户看到什么

### 1.1 账户列表

设置页的模型分组下面多一块 **账户 / Accounts**，列出本机已配的每个账户：

| 列 | 内容 |
| --- | --- |
| 名字 | 用户起的显示名，如「OpenAI 主账号」「OpenRouter 免费」。同一台机器内唯一（不分大小写） |
| 类型 | 现在只有两种：**Nema 直连**（`codex-direct`）和 **Claude Code**（`claude-code`）。前者再分三种登录方式（ChatGPT 订阅 / 现有 Codex 登录 / API 密钥），后者是 Claude 订阅 token |
| 地址 | 仅 API 密钥类显示 Base URL；订阅类显示提供方域名，不可改 |
| 默认模型 | 该账户默认用的模型；可留空表示「用这个账户的模型列表第一个」 |
| 凭据 | 已连接 / 缺失 / 不可用（沿用 `/_nema/settings` 现有的三态文案） |
| 能力 | 一行小字：图片 ✓/✗/未声明、PDF ✓/✗/未声明、上下文（若有声明）。未声明就写「未声明」，不写「不支持」 |
| 成本档位 | 省 / 标准 / 强（D-8 讨论），只影响自动路由的排序，不代表任何真实价格 |
| 启用 | 开关，关掉的账户不进任何候选 |

新建账户是一个表单：名字、类型、登录方式、Base URL（仅 API 密钥）、默认模型、能力声明（三个开关 + 一个可选的上下文窗口数字）、成本档位。保存后立刻出现凭据输入框，和今天的「API 密钥」保存后一样。

删除账户前必须处理两件事：把绑定到它的 workspace 解绑，把它的凭据文件删掉（沿用今天的 0600 私有文件删除方式）。正在跑的任务不受影响，下一次任务才生效。

### 1.2 在哪里选账户

**手动模式（默认，D-3）。** 三处，优先级从高到低：

1. **本条消息**：输入框右侧的账户选择器，默认显示「跟随 workspace」。发送时作为这次任务的账户选择。不落到任何设置里。
2. **thread**：thread 顶部的账户选择器，只影响这个 thread 之后的任务。存 `<nemaHome>/accounts.json` 的绑定表。
3. **workspace**：workspace 设置页的模型分组里，一个「默认账户」下拉。存同一张绑定表。

三处都有「不指定」这一项。都不指定时用全局默认账户（就是设置页里排在第一位、且启用的那个）。

**自动模式（显式开启，D-3）。** 上面三处都可选「自动」。选了自动，任务开始时按第 4 节算候选集并选一个；用户在这条消息上仍然可以临时指定账户，临时指定优先。

设置页有一个全局开关 **自动路由 / Automatic routing**，默认关。关着的时候，界面上所有「自动」选项都不出现。它打开后，每个 workspace / thread 仍然默认是「跟随 workspace」而不是「自动」——开关只解锁选项，不改变已有绑定。

### 1.3 路由决策显示在哪里

回复下方一行小字，和今天 `changes` / `askedQuestion` 卡片同一层：

```text
模型：OpenRouter 免费 · deepseek/xxx（自动：首选账户被限流，改用备用）   [详情]
```

- 手动选账户时也显示，理由固定为「你在本工作区选的」/「你在这条消息里选的」，让用户随时知道当前落在哪。
- 「详情」展开后是一个小面板：候选集（账户 · 模型 · 为什么被排除或排在后面）、实际选中的、provider 报的 token 数（如果有）。
- 失败的任务没有回复，这条信息写进失败原因那一行（`saveTaskFailure`，`apps/hub/src/daemonSocket.ts:227`），同样只说账户名和模型，不带 key。

## 2. 数据模型

### 2.1 账户是什么

一个**账户**是「一个凭据 + 一个终点 + 一个默认模型」的组合，属于某一台机器上的 daemon：

```ts
type Account = {
  /** 创建时生成，永久不变；名字可以改，id 不改。见 D-2。 */
  id: string;                 // "acct_" + [a-z0-9]{10}
  name: string;               // 显示名，本机唯一（不分大小写），1..40 个字符
  enabled: boolean;
  /** 沿用现有两个适配器；账户不跨适配器共享。 */
  adapter: "codex-direct" | "claude-code";
  /** codex-direct 的登录方式；claude-code 账户不用这个字段。 */
  authMode?: "siwc" | "compat" | "byok";
  /** 仅 byok；规则与今天 normalizeByokBaseUrl 相同。 */
  baseUrl?: string;
  /** 该账户默认模型；空表示取模型列表第一个。 */
  model?: string;
  /** 可选：按模型覆盖能力声明。v1 界面不暴露，只由手改文件或导入产生（4.2 第 1 层）。 */
  modelCapabilities?: Record<string, { image?: boolean; pdf?: boolean; contextTokens?: number }>;
  /** 能力声明。未写 = 未声明，不进自动候选（D-4）。 */
  capabilities?: {
    image?: boolean;
    pdf?: boolean;           // 只有 codex-direct 有意义；claude-code 恒为未声明
    contextTokens?: number;  // 声明值，不是测出来的
  };
  /** 自动路由排序用；不参与任何计价。 */
  costTier: "low" | "standard" | "high";
  /** 同机内的人工排序，数字小的先试。 */
  order: number;
  createdAt: string;          // ISO 8601
};
```

**为什么不跨适配器。** 适配器决定整个任务的运行方式：`codex-direct` 是 Nema 自己的工具循环（`apps/cli/src/direct/adapter.ts`），`claude-code` 是拉起 `claude` 子进程（`apps/cli/src/claude/launch.ts`）。换适配器不是「换一个账户」，是换一种执行方式、换一套工具和提示词。所以候选集永远只含**当前运行方式**的账户。这也意味着 #131 里说的「同一供应商多账户」在本设计里就是：同一个适配器、同一个供应商域名、不同的 key / 项目 / 工作区。

**为什么没有 provider 字段。** 今天代码里没有 provider 抽象，只有适配器 + 登录方式 + Base URL（`apps/cli/src/config.ts:30-38`）。加一个 `provider` 枚举等于凭空造一层，且对 `byok` 这种任意 OpenAI 兼容地址毫无意义。供应商信息在界面上从 Base URL 和登录方式推出来显示，不存。

### 2.2 存哪里

| 内容 | 位置 | 权限 |
| --- | --- | --- |
| 账户元数据 + 作用域绑定 | `<nemaHome>/accounts.json` | 0600，原子替换（与 `config.json` 同法，`apps/cli/src/config.ts:78-88`） |
| 凭据 | `<nemaHome>/secrets/accounts/<id>/`（`0700`）内的文件 | 每个文件 0600 |
| 旧的单账户凭据 | 位置不变（`byok-key`、`claude-code-token`、`auth.json`） | 0600 |

```ts
type AccountsFile = {
  version: 1;
  accounts: Account[];
  /** workspace / thread → 账户 id 或 "auto"。缺失 = 不指定。 */
  bindings: Record<string, string>;   // key: `ws:<id>` | `thread:<id>`
};
```

绑定的 key 用带前缀的字符串，避免 workspace id 和 thread id 撞车。绑定在**本机**，不在 hub 数据库里：账户 id 属于这台机器，写进数据库后在另一台机器上会指向一个不存在的账户，而且备份/恢复到别的机器时会带过去一堆无意义的 id。代价写在 D-5 的取舍里。

### 2.3 作用域：workspace / room / agent 分别是什么

issue #131 写的是「可以按 workspace、room 或 agent 选用哪个账户」。本仓库今天只有两个可绑定的实体，加一个由适配器决定的维度：

| issue 的说法 | 本仓库里的实体 | 绑定存在哪 | 生效范围 |
| --- | --- | --- | --- |
| workspace | `workspaces` 表（`apps/hub/src/db/migrations/001_init.sql:1-7`） | `accounts.json` 的 `bindings["ws:<id>"]` | 这个 workspace 里的所有新任务 |
| room | **thread**：一次围绕某条消息展开的对话（`apps/hub/src/db/migrations/011_threads.sql:3-10`） | `bindings["thread:<id>"]` | 这个 thread 之后的任务 |
| agent | **运行方式**：`codex-direct` 或 `claude-code` | 不绑定，是候选集的硬过滤（4.1 第 1 步） | 每个任务 |

三点说明：

- **没有单独的 `agent` 实体。** 一次任务只跑一个适配器（`apps/cli/src/daemon/runner.ts:12-15` 的 `resolveAdapterName`），不存在「同一个 workspace 里换一个 agent」这回事。要换运行方式，用户改设置。所以「按 agent 选账户」在这版里等于「账户本身属于某个运行方式」。
- **`room` 按 thread 实现。** 仓库里的「房间」就是 thread：它有自己的锚点消息、自己的对话历史，也能独立设标题。给它绑账户是 issue 的本意，而新建一张 `rooms` 表只会造出第三个概念。
- **绑定在 daemon 本机。** 理由见 2.2：账户 id 只在这台机器上有意义。

### 2.4 和现有 `adapter` + `authMode` 四组合怎么衔接

今天的四组合（`docs/superpowers/specs/2026-10-25-model-provider-login-design.md` 第 23-34 行）原样保留，变成**账户上的字段**：

| 账户长什么样 | `adapter` | `authMode` | 凭据文件 |
| --- | --- | --- | --- |
| ChatGPT 订阅，浏览器登录 | `codex-direct` | `siwc` | `secrets/accounts/<id>/auth.json` |
| ChatGPT 订阅，本地 Codex 登录 | `codex-direct` | `compat` | 不复制；只读 `~/.codex/auth.json` |
| API 密钥 | `codex-direct` | `byok` | `secrets/accounts/<id>/key` |
| Claude 订阅 | `claude-code` | — | `secrets/accounts/<id>/token` |

`compat` 账户不拥有凭据：它指向 Codex CLI 自己的登录文件，和今天 `defaultOperations` 的 `logout("compat")` 直接 `return`（`apps/local/src/settings.ts:49`）的含义一致——Nema 不删别人的文件。因此 `compat` 账户的「凭据」一栏永远显示 `~/.codex/auth.json` 的可读状态，而不是 `secrets/` 下的文件。

`config.json` 仍然描述「这台机器现在跑什么」，**一个字段都不加**。它的 `adapter` / `authMode` / `model` / `byokBaseUrl` 是「全局默认账户」的投影，由设置页改默认账户时同步写回，读的时候以 `accounts.json` 为准。

不往 `config.json` 加 `defaultAccountId` 是刻意的：`ConfigSchema` 是 `.strict()` 的（`apps/cli/src/config.ts:30-38`），多一个键会让 0.2.0 读配置直接失败：`loadConfig` 里的 `ConfigSchema.parse`（`apps/cli/src/config.ts:75`）抛错，用户看到的是 `configErrorMessage`（`:46-52`）那句「配置文件 ~/.nema/config.json 无法读取」。用户回退版本后要手改 JSON 才能启动，代价太大。全局默认账户改为从 `accounts.json` 里取 `order` 最小的启用账户，见 4.1 第 2 步。

## 3. 凭据存储

### 3.1 沿用现有机制，只换目录

凭据读写全部走已有的三个函数，不新写一套文件 IO：

- `saveSecretLine` / `readSecretLine`（`apps/cli/src/secrets/file.ts:42`、`:77`）：拒绝符号链接、`wx` 建临时文件、fsync、改名、`protectPrivatePath`。
- `protectPrivatePath` / `privateModeMatches` / `openPrivateFile`（`apps/cli/src/secrets/permissions.ts:58`、`:63`、`:69`）：POSIX 走 `chmod 0600`，Windows 走私有 DACL 校验，读时用 `O_NOFOLLOW`。

变化只有路径：`<nemaHome>/byok-key` → `<nemaHome>/secrets/accounts/<id>/key`。

`siwc` 账户需要读写整个 `StoredAuth`（含 refresh token 与刷新时间），今天的 `AuthStore` 把路径钉死在 `<nemaHome>/auth.json`（`apps/cli/src/direct/authStore.ts:122-123`）。改造方式是给 `AuthStore` 的构造参数加一个可选的 base 路径（默认仍是 `nemaHome`，保持现有调用不变），账户凭据目录直接作为它的 base：`new AuthStore(accountDir, refresher)`。锁文件 `<accountDir>/auth.lock` 跟着走，同一账户并发刷新仍由同一把锁保护，不同账户互不阻塞——这比今天所有账户共用一把锁更合理。

### 3.2 每账户一个目录，不是一个文件

推荐**每账户一个目录**，原因不是审美：

- 一个 `siwc` 账户需要 `auth.json` + `auth.lock` 两个文件，还可能留 `lastAuthError`；一个 `byok` 账户只有一行 key。塞进一个文件就得自己发明多段格式。
- 删除账户 = 删一个目录，一次到位；不会漏掉锁文件。
- 目录 `0700`、文件 `0600`，与今天 `nemaHome` 的做法一致（`apps/cli/src/config.ts:80-81`）。

文件布局：

```text
<nemaHome>/
  accounts.json                      0600
  secrets/
    accounts/                        0700
      acct_3f9k2m0q1x/               0700
        key                          0600   (byok)
        auth.json                    0600   (siwc；AuthStore 负责其内部格式与原子写)
        auth.lock                    0600
        token                        0600   (claude-code)
      acct_9wq7e1r5tz/               0700
        auth.json
        auth.lock
```

同一目录里**只会出现一种凭据**（`key` / `auth.json` / `token` 三选一，`compat` 一个都没有）。读到多个或者读到与 `authMode` 不符的文件，按「不可用」处理并说明，不猜。

### 3.3 密钥不进哪里

明写三条，作为实现时的检查项：

1. **不进 hub 数据库。** 账户与凭据都在 daemon 机器上。hub 只在用户**逐条消息指定账户**时看到一个不透明的 id（`task.assign.accountId`，5.4 节），其余情况连 id 都不知道；任何情况下都不知道 key。
2. **不进日志与错误文字。** 沿用现有做法：`SecretFileError` 只提文件名不提内容（`apps/cli/src/secrets/file.ts:23-32`），`readSecretLine` 的错误消息里不回显值。
3. **不进消息元数据。** 元数据里只有 `accountId` 和 `name`。`name` 是用户起的显示名；创建时如果名字里出现疑似密钥的串（长度 ≥ 20 且只含 base64 字符与 `-_`），提示一次「这个名字看起来像密钥」，不强制改（名字是用户自己的东西）。

### 3.4 现有单 key 怎么迁移

见 D-6。默认做法是**读时合成**：`accounts.json` 不存在时，从 `config.json` + 旧凭据文件合成一个隐式账户（id `acct_0000000000`——全零是保留值，随机生成器不会产出它，名字「默认账户」），只存在于内存，不写盘。用户第一次改账户设置时才把它落成真实文件，并把旧凭据**移动**（不是复制）到 `secrets/accounts/<id>/`。

不写盘的原因很直接：只要没落盘、`config.json` 一个键都不加（2.4 节），用户回退到 0.2.0 时一切照旧。落盘之后仍然兼容老版本，因为账户信息全在 `accounts.json` 里，而老版本根本不读这个文件；代价只是老版本看不到多出来的账户，只认 `config.json` 投影出来的那一个。这正是 D-6 选 A 的关键好处，也是选 B 会失去的东西。

## 4. 路由

### 4.1 候选集怎么算

一次任务开始时（`Runner.enqueue` 已经拿到 `TaskAssign` 和配置，`apps/cli/src/daemon/runner.ts:47-71`），按顺序做四步：

1. **定运行方式。** `task.adapter` 经 `resolveAdapterName`（`runner.ts:12-15`）得到 `codex-direct` 或 `claude-code`。这是硬约束，候选集只含这个适配器的账户。
2. **定作用域。** 优先级：`task.accountId`（本条消息选的）> thread 绑定 > workspace 绑定 > 全局默认（`accounts.json` 里 `order` 最小的启用账户）。绑定表在 daemon 本机（2.2 节），由 daemon 按 `task.threadId` 与 `task.workspaceId` 查（5.4 节新增的 `threadId?`）。这一项如果指向一个**具体账户**（不是 `"auto"`），候选集就是它一个，跳过排序和选择——**点名的账户不因能力、启用状态或冷却被排除**（对应 D-4 的手动模式）。唯一仍要检查的是**凭据本身**：点名了一个凭据缺失/不可用的账户，任务在发起任何请求前就失败并说明是哪一项不可用（沿用现有的 `UNUSABLE_FILE_MESSAGE` / 未登录文案），而不是跑到 provider 那里拿一个 401。
3. **过滤。** 依次去掉：`enabled: false`、凭据不可用（文件缺失/权限不对/内容无效）、`compat` 账户但 `~/.codex/auth.json` 读不到、处于冷却期、**能力声明不满足本次任务**（4.2）。
4. **排序。** `order` 升序 → `costTier`（low → standard → high）→ `id` 字典序。最后一项只是为了让结果确定，不表达偏好。

过滤后为空：不猜、不降级，按 D-4 处理。

### 4.2 能力从哪里来

今天的能力判断只有一张三行表（`apps/cli/src/attachments/capabilities.ts:13-18`）：Claude Code 的 PDF 是 `unknown`，其余是 `native`。它按**适配器**给答案，不区分账户。

新规则是三层，从具体到笼统，第一层有值就用它：

| 层 | 来源 | 例子 |
| --- | --- | --- |
| 1. 模型级声明 | `accounts.json` 里账户的 `modelCapabilities[model]`（可选；v1 界面上不暴露，只在手改文件或导入时出现） | 同一个 OpenRouter key，`xxx:free` 不支持图片，`xxx` 支持 |
| 2. 账户级声明 | 设置页那三个开关 | 「这个账户配的是纯文本端点，图片 ✗」 |
| 3. 适配器兜底 | 现有 `attachmentCapabilities()` | `claude-code` 的 `pdf: "unknown"` |

`unknown` 与 `false` 在**自动模式**里同样是「不进候选」，但显示不同：一个说「未声明」，一个说「不支持」。这是 #131 的「不静默降级」在候选集上的直接后果：**只有明确声明支持，才可能被自动选中。**

**工具调用不是路由维度。** Nema 的 agent 每一轮都带 `tools`（`apps/cli/src/direct/transport.ts:382`），不带工具的模型跑不完一个任务。所以「不支持工具调用」等于「这个账户不能用」，不是「这个任务换个账户」；这样的账户在候选集里被永久排除，界面直接说原因。

**上下文长度只能声明、不能预判。** 本仓库没有任何 tokenizer，也无法在发请求前知道一次任务有多少 token（附件是 base64 原生块，历史每轮全量重发）。所以 v1 不做「按上下文长度预选更大的账户」，只在 provider 明确报上下文超限时**事后**换一个声明了更大窗口的账户——见 D-7。

### 4.3 什么错误换账户、什么错误不换

分类以 provider 的说法为准，**不看 HTTP 状态码猜**（OpenRouter 的做法见调研 §2.3）。Nema 今天能拿到的信号有三类：`ModelQuotaError`（额度）、`ModelApiError`（带 `status`，`apps/cli/src/direct/transport.ts:210`）、`ByokRejectedError` / `ReloginRequiredError` / `AuthRateLimitedError`（凭据）。

| 情况 | 判断依据 | 自动模式下的动作 |
| --- | --- | --- |
| 限流 | 429，或 `statusForCode` 映射出的额度码（`apps/cli/src/direct/transport.ts:478-494`） | **换**下一个候选，当前账户进冷却 |
| 额度用尽 | `ModelQuotaError` | **换**，且该账户本轮任务内不再使用 |
| 5xx / 连接失败 | 500-599，或连接错误重试一次后仍失败 | **换** |
| 上下文超限 | provider 报 `context_length_exceeded` 或等价措辞 | **换**一个声明了更大窗口的账户（D-7） |
| 401 | `ByokRejectedError` / `ReloginRequiredError` | **不换**。这是这把 key 的问题，换账户等于掩盖它 |
| 403 / 内容审核 / 拒绝回答 | `ModelApiError` 且 body 明确指向策略 | **不换**。换账户等于替用户绕过供应商的策略 |
| 请求本身有问题（400 且与内容块、参数、媒体类型无关） | `ModelApiError` | **不换** |
| 已经开始输出 | 已经收到过 `output_text` 增量 | **不换**。OpenRouter 的做法同此：一旦有内容到达调用方就停止 failover |

**换账户发生在两次模型调用之间。** 每次模型调用都是一个独立请求，换账户就是下一条请求换凭据和终点。已经产生的对话历史继续用，但**上一轮产出的加密推理整段丢掉**：`store: false` 的回放靠 `encrypted_content`（`apps/cli/src/direct/loop.ts:92-96`），跨 key 解不开，LiteLLM 的文档也明说这一点（调研 §1.3）。丢掉的部分在决策里写一行「换账户后，之前那轮的推理内容不再提供给模型」，不隐瞒。

正在进行的**工具调用**不重放：如果失败发生在拿到 tool_call 之后、执行工具之前，按「不换」处理（换账户会让同一个工具在两个模型下各跑一次）。

### 4.4 冷却

进程内一个 `Map<accountId, untilMs>`，不落盘：daemon 是单进程、单任务串行（`Runner` 一条链），重启后冷却没有意义。

规则（具体时长是提议，进 plan 时定）：

- 429 与额度错误：冷却到 provider 给的 `Retry-After`（若有），否则一个固定短窗口。
- 5xx / 连接失败：冷却一个更短的窗口，且只影响这一个账户。
- 冷却中的账户不出现在候选集里，界面上的「为什么没选它」写「刚刚被限流，冷却到 HH:mm」。

不设「失败 N 次永久降级」：用户可能就是想用那个账户，冷却结束自然回队。

### 4.5 成本偏好怎么表达

只有**用户自己标的档位**，没有价格表：

- 每个账户一个 `costTier`（`low` / `standard` / `high`），默认 `standard`。
- 自动路由在同 `order` 下按档位排序；档位只影响顺序，不影响是否可选。
- 界面上写清一句：「档位只用来排序，Nema 不知道实际价格。」
- 不提供「按预算封顶」这类功能：没有价格就无法计算，做了就是假承诺。

之所以不做价格表：本仓库没有任何用量或价格数据（调研 §8），要建就得先有 tokenizer、模型价格目录和一张用量表，那是另一个 issue 的规模，且会和 #131 的可见性目标抢注意力。

### 4.6 决策如何可观测

三处，同一份数据：

1. **消息元数据。** `AgentMessageMeta`（`packages/shared/src/workspace.ts:52-66`）加一个可选字段：

```ts
route?: {
  accountId: string;
  accountName: string;
  model: string;
  /** "manual" | "auto" */
  mode: "manual" | "auto";
  /** 机器可读的原因码，见下表 */
  reason: "user_workspace" | "user_thread" | "user_message" | "default" |
          "auto_primary" | "auto_failover" | "auto_after_limit";
  /** 自动模式换过账户时，之前试过谁、为什么没用 */
  attempts?: { accountId: string; accountName: string; model?: string; failure: string }[];
  /** provider 自报的 token 数；没有就是没有，不估算 */
  usage?: { inputTokens?: number; outputTokens?: number };
};
```

2. **界面。** 回复下一行（1.3 节）。展开显示候选集与排除原因。
3. **进度事件。** 换账户时发一条 `task.event`（`progress`），文案是「OpenRouter 免费被限流，改用 OpenAI 主账号」，在任务进度里能按时间看到。

不记录的东西：base URL 不写进元数据（用户可能不想它出现在导出的对话里），key 永远不写，账户的 `order`/`costTier` 不写（元数据记事实，不记设置快照）。

## 5. 与现有 `ModelConfig` / `_nema/settings` 的兼容

### 5.1 旧客户端连新 daemon

`/_nema/settings` 的响应体只**加**字段，不改已有字段的含义：

- `config` 保持原样，`adapter` / `authMode` / `model` / `byokBaseUrl` 仍是「当前默认账户」的投影；这样老版 web 的四个下拉仍然能用、仍然能切。
- 新增顶层 `accounts?: AccountView[]`（不含任何凭据）和 `defaultAccountId?: string`（服务端算出，只读）。老客户端按 `ModelSettingsDto`（`apps/web/lib/modelSettings.ts:12-19`）取值，多余字段被忽略。
- `PATCH /_nema/settings` 的键白名单（`apps/local/src/settings.ts:121`）**不加**新键。账户的增删改走新路径，见 5.2。这样老 web 的 `patch` 不会误改账户。

`GET /_nema/models` 保持原状，但**默认账户**变了之后它会不同——它本来就每次调用都读配置（`apps/local/src/settings.ts:178-190`），不需要改。

### 5.2 新客户端连旧 daemon

新 web 会调 `/_nema/accounts`。旧 daemon 对未知路径返回 `404 { error: "not_found" }`（`apps/local/src/settings.ts:248`）。新前端把 404 解释成「这台 daemon 还不支持多账户」，隐藏账户块，保留原来的四下拉界面。这是唯一需要的降级。

### 5.3 新增的设置接口

都挂在现有 settings service 的同一个 `dispatch` 上（`apps/local/src/settings.ts:175-250`），因此自动继承 gateway 的会话校验（`apps/local/src/gateway.ts:221` 起）、`no-store`、只允许 GET/POST/PATCH、JSON content-type 校验。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/_nema/accounts` | 列出账户（无凭据），附每个账户的凭据状态与绑定 |
| `POST` | `/_nema/accounts` | 新建；body 是 2.1 结构去掉 `id`/`createdAt` |
| `PATCH` | `/_nema/accounts` | 改名字、模型、能力、档位、启用、排序；body 带 `id` |
| `DELETE` | `/_nema/accounts` | 删除；拒绝删除仍被绑定的账户，返回 409 和绑定清单 |
| `POST` | `/_nema/accounts/secret` | 给某账户写凭据（`{ id, kind: "byok" \| "claude", value }`）；`siwc` 走登录流程 |
| `POST` | `/_nema/accounts/login` | 对一个 `siwc` 账户发起浏览器登录 |
| `POST` | `/_nema/accounts/probe` | 对某账户试探（沿用 `confirmQuotaUse` 确认） |
| `POST` | `/_nema/accounts/bind` | `{ scope: "ws:<id>" \| "thread:<id>", accountId: string \| null \| "auto" }` |

沿用现有 settings 的几个硬约束，不例外：单飞任务（`login`/`probe` 同一时刻只允许一个，`settings.ts:140-157`）、登出期间 409 `mutation_conflict`、错误只回码不回细节（`scrubbedError`）。

### 5.4 hub 与 daemon 的协议

账户只存在于 daemon 机器上，hub 不知道有哪些账户。所以：

- `task.assign`（`packages/shared/src/protocol.ts:35-59`）加三个可选字段：
  - `accountId?: string` — 本条消息点名要用的账户；
  - `routing?: "auto"` — 这个任务允许自动路由；
  - `threadId?: string` — 这条任务属于哪个 thread（主聊天没有）。
  都缺 = 走默认账户，行为和今天完全一样。旧 daemon 收到未知字段不报错（zod 默认丢弃），新 hub 配旧 daemon 时退化成默认账户，符合预期。
- 为什么是 hub 传 `threadId` 而不是 daemon 自己找：hub 在派发时已经取到了当前 thread（`apps/hub/src/daemonSocket.ts:195` 的 `conversationThread`），而 daemon 只知道 prompt 文字。传下来比让 daemon 从 prompt 里解析「# 当前 thread：<标题>」可靠。
- hub 不读绑定表：绑定表在 daemon 机器上（2.2 节），hub 拿不到也不该拿。作用域由 **daemon** 在 `task.assign` 到达时解析成具体账户（4.1 第 2 步）。
- **逐条消息指定的账户 id 会经过 hub 一次。** 用户在输入框选账户时，那个 id 随消息发到 hub、存进这条任务的记录、再随 `task.assign` 送到 daemon。这是本设计里唯一一处账户 id 离开本机的地方。它是不透明的随机串，不含任何凭据，`accountId` 在数据库里只是一个字符串；但要说清后果：**同一份数据库换到另一台机器上时，那个 id 指向的账户不存在**，daemon 收到不认识的 id 时按 4.1 第 3 步的过滤规则把它当作「不可用」，退回默认账户并在路由那一行写「本条消息指定的账户在这台机器上不存在」，不静默。
- 逐条消息的选择**不进 `messages.meta`**：它是这次任务的输入，不是结果。结果（实际用了谁）由 daemon 回传后写进 `meta.route`（4.6 节）。
- 决策回传：`task.finished` 的 `ok: true` 分支（`packages/shared/src/protocol.ts:20`）目前只有 `reply`。`route` 由 daemon 通过一条 `task.event`（`progress`）之外的结构化消息回传，或直接在 `task.finished` 上加可选 `route` 字段。**推荐后者**：hub 需要它来写 `AgentMessageMeta`，走 `task.event` 只能拿到纯文本。

### 5.5 旧 daemon + 新 hub 的版本闸

hub 现在会拒绝不认识 `adapter: "auto"` 的极老 CLI（`apps/hub/src/daemonSocket.ts:366-372`），也已经有「daemon 没有声明 `attachments` 就宁可让任务失败」的先例（`apps/hub/src/daemonSocket.ts:252`，`conn.features.has("attachments")`）。本轮照这个先例，**不新造闸**：

- daemon 在 `hello` 的 `features` 里加一项 `accounts`（沿用 `apps/cli/src/attachments/capabilities.ts:5` 的 `DAEMON_FEATURES`）。
- hub 没看到这一项时：隐藏账户选择器与账户块；如果**用户仍然逐条消息指定了账户**（例如刚升级 hub、daemon 还没重启），**让任务失败**并写明「这台机器上的 nema daemon 还是旧版本，不支持指定账户；请升级并重启 daemon，或取消这条消息的账户选择」。**不回落成默认账户**——那正是「静默降级」，会让用户以为请求发给了 A 其实发给了 B。
- 绑定（workspace / thread）不需要闸：绑定只存在于 daemon 本机，旧 daemon 根本不读它，界面上也不会显示（因为账户块被隐藏了）。

## 6. 非目标

- **不做模型网关。** 不代理其他应用的请求，不做 OpenAI 兼容前端给第三方用。
- **不做按价格的最优化。** 没有价格表、没有预算封顶、没有成本报表（D-8）。
- **不跨适配器路由。** `codex-direct` 与 `claude-code` 之间不自动切换；换适配器仍然是用户改设置。
- **不按任务内容分类选模型。** Cursor 那样用分类器判断"这活难不难"需要训练数据和线上流量，Nema 不做，也不假装做。
- **不做并发/负载均衡。** daemon 单任务串行，没有并发可摊；不做加权随机、least-busy、latency-based。
- **不改 Skill、附件、知识库的现有行为。** 附件能力表只被读取，语义不变；换账户不重发附件以外的东西。
- **不做「自动升级到更贵的模型」。** 成本偏好只能同档或更省；质量档位是用户显式选择，不会因为任务看起来难就自动跳档。
- **不把账户写进 workspace 快照/备份。** 备份恢复不带走账户与绑定。
- **不新增 `room` 与 `agent` 两个实体。** issue #131 说的三个作用域在本仓库里对应两个实体加一个维度，见 2.3。

## 7. 需要拍板的决策

**用户已在 2026-10-31 定下：八项全部按推荐 A。** 下面每一项的标题后标了「**已选 A（2026-10-31）**」，表格与推荐理由原样保留，作为当时的取舍记录；每项末尾的「定稿」一行写选了什么、为什么选。plan 严格按 A 写。

### D-1：多账户元数据与凭据的存储粒度 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 一份 `accounts.json` + 每账户一个凭据目录（推荐）** | 元数据与绑定在一个文件里原子替换；凭据在 `secrets/accounts/<id>/` | 列出账户只读一个文件，坏文件一眼能看出来并整体报错；凭据目录可以单独删；与今天「config.json 管设置、单文件管密钥」的分法一致 | 两处要保持一致：删账户要同时删目录；`accounts.json` 损坏时所有账户都不可用（比逐个损坏更明显，也算好处） |
| B. 每账户一个目录，元数据与凭据同放 | `accounts/<id>/account.json` + `key` | 一个账户一个单元，删除即 `rm -rf` | 列账户要扫盘并按目录名排序；元数据没有单点，无法整体校验；读设置的代码路径必须进入含密钥的目录 |

**推荐 A。** 理由：元数据是「可以给界面看、可以随日志导出」的东西，凭据是「只能待在本机」的东西；放在同一个文件/目录里，以后想加一个只读设置的服务或导出设置的功能，就得多写一层「别读那个文件」的规则。代价是删除要动两处，用 `DELETE` 接口在一个函数里做掉即可。

**定稿：A。** 账户元数据与作用域绑定放在一份 `<nemaHome>/accounts.json`（0600，原子替换），每个账户的凭据放在 `<nemaHome>/secrets/accounts/<id>/`（目录 0700、文件 0600）。理由是元数据与凭据的可见范围不同，分开才好以后加只读设置导出；代价是删除账户要同时删两处，由 `DELETE /_nema/accounts` 在一个函数里完成。

### D-2：账户 id 怎么生成 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 创建时随机生成、永不变（推荐）** | `acct_` + 10 位 `[a-z0-9]`；名字只作显示 | 改名不断引用（绑定、消息元数据、日志都记 id）；名字可以重名处理、可以含空格与大小写 | id 不可读，排错时要对着界面查名字；用户不能自定义 |
| B. 名字即 id | id 由名字规范化得到（小写、连字符） | 可读，日志里直接看懂 | 改名等于新建账户（绑定全丢）；重名必须拒绝；用户输入的字符集要收窄 |

**推荐 A。** 理由：这个名字会出现在 `AgentMessageMeta.route` 里并且长期保存，改名是必然会发生的事（用户一开始起名很随意）。B 在改名时的代价不可接受，而 A 的代价只是「排错时多看一眼」。

**定稿：A。** `acct_` + 10 位 `[a-z0-9]`，创建时随机生成，之后永不改变；名字只作显示、可改。理由是 id 会进绑定、`AgentMessageMeta.route` 与日志，改名不能牵动引用；`acct_0000000000` 保留给读时合成的隐式账户（D-6）。

### D-3：自动路由默认开还是关 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 默认关，按需开启（推荐）** | 全局一个开关，默认关；关着时界面不出现「自动」；开之后每个 workspace/thread 仍默认「跟随 workspace」 | 账户背后是不同账单和不同限额，默认换等于替用户决定花谁的钱；和「不静默降级」一致；出问题时行为可预测 | 想用自动的人要多点一次；#131 的核心卖点默认不可见，需要在 release notes 里说清怎么开 |
| B. 默认开（多账户时） | 配了 2 个以上账户就默认自动 | 开箱即用，真能省事 | 一次限流就会把请求发到用户没预期的账户上；用户看到账单才知道 |

**推荐 A。** 理由：这一版是第一次引入「同一次对话里换凭据」，没有历史数据能说明用户是否接受。默认关、显式开，把选择权留在用户手里；等用一段时间、用户自己说想要默认为开，再改默认值是一行改动。代价是要在文档里把开关位置写清楚。

**定稿：A。** 自动路由的全局开关默认关闭；关着时界面不出现「自动」选项；打开后每个 workspace / thread 仍默认「跟随 workspace」。理由是换账户等于换账单与限额，默认替用户决定不可接受；代价是核心能力默认不可见，三语指南里要写清开关位置。

### D-4：能力不匹配时怎么办 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 自动模式拒绝、手动模式照发并如实报错（推荐）** | 自动模式：没有声明支持该能力的候选就失败，说明缺什么。手动模式：用户选的账户即使没声明，也照发，provider 拒绝时按现有 `attachmentRejection` 的方式转述原文 | 自动模式绝不替用户挑一个不支持的账户；手动模式尊重用户的明确选择，不替用户改主意；两种情况都不静默 | 两套行为要说清楚（界面上按模式给不同提示）；手动模式下用户可能连续撞墙 |
| B. 一律拒绝 | 手动选了不支持的账户也拒绝 | 行为单一，最好解释 | 用户明明知道自己在干什么（比如想试试某个端点）却被拦住；和附件 D-2 修订后的「先用提供商原生能力，不能就如实说」冲突 |
| C. 一律照发 | 不检查，交给 provider | 最简单 | 自动模式会挑到一个已知不支持的账户，正是 #131 要禁止的 |

**推荐 A。** 理由：自动模式的全部意义是「替用户做没有争议的选择」；没有合格候选时，最没有争议的选择是**说做不到**。手动模式相反：用户已经点名了，Nema 的职责是把结果如实说出来。这和附件 D-2 修订后的方向一致——不假设用户用的是哪家提供商，先用原生能力，不能用时如实告诉用户。

**定稿：A。** 自动模式下，没有明确声明支持所需能力的候选就不选，任务失败并说明缺什么；手动点名的账户照发，provider 拒绝时按现有 `attachmentRejection` 的方式转述原文。理由是自动模式只做没有争议的选择，手动模式尊重用户的明确选择。

### D-5：路由决策显示在哪、要不要落进消息元数据 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 回复下一行 + 写进消息元数据（推荐）** | 4.6 节的 `route` 字段；界面一行小字，可展开 | 事后可查「这句话是谁给的」；换账户时用户当场看得到；元数据里的东西能被以后的统计/导出复用 | `messages.meta` 变大一点点；账户名进入导出的对话（用户自己的名字，不算泄漏） |
| B. 只在设置页/日志里 | 不进消息，只在本机的路由日志 | 对话干净 | 换了账户用户当场不知道；事后要另找地方查；`meta` 已有 `changes`/`askedQuestion` 这类可核对的字段，路由反而更该记 |
| C. 只显示，不落盘 | 界面上一行，刷新就没了 | 对话干净且当场可见 | 事后无法回答「这条是谁给的」；与 #45 的可核对要求相悖 |

**推荐 A。** 理由：#131 的原话是「每次的路由决策要能让用户看到：用了哪个账户、哪个模型、为什么选它」。「看到」如果只在当下，第二天就查不到了。落进元数据是成本最低的持久化——`messages.meta` 已经是 jsonb（`apps/hub/src/db/migrations/001_init.sql:14`），读的时候是直接 cast 不校验（`apps/hub/src/messages.ts:76`），加可选字段对旧数据无影响。

**定稿：A。** 回复下方一行小字（账户 · 模型 · 原因，可展开看候选与排除理由），同时把同样的内容写进 `AgentMessageMeta.route`。理由是没有持久化就回答不了「这条回复是谁给的」；`meta` 是 jsonb，加可选字段对旧消息无影响。

### D-6：现有单 key 配置怎么迁移 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 读时合成，首次修改才落盘（推荐）** | `accounts.json` 不存在时合成一个隐式账户 `acct_0000000000`（「默认账户」）；用户第一次改账户设置时，把它写进 `accounts.json` 并**移动**旧凭据到 `secrets/accounts/<id>/`；`config.json` 一个键都不加（2.4 节） | 未动设置的用户完全感觉不到变化；因为 `config.json` 不变、账户只在 `accounts.json` 里，回退到 0.2.0 也能读配置正常启动，只是看不到多出来的账户、只认投影出来的那一个；只有真要改账户的人才进新结构 | 两套读取路径并存一段时间（配置读 + 账户读），代码里要多一层；回退后老版本改模型会覆盖「全局默认账户」的投影，用户切回新版时要重设默认账户 |
| B. 升级时立即迁移 | 启动时把旧配置改写成 `accounts.json`，删掉旧凭据文件 | 只有一条路径，代码简单 | 回退到 0.2.0 时 `config.json` 里有旧版本不认识的键（`.strict()` 直接报错，`apps/cli/src/config.ts:30-38`），用户看到「配置文件无法读取」；凭据已被移动，老版本找不到 key |
| C. 不动，多账户是并列功能 | 旧配置永远是「默认账户」，不迁移 | 零风险 | 两套东西长期并存，用户永远有个改不了名字的「默认账户」；「账户」和「模型提供方」两个概念在界面上打架 |

**推荐 A。** 理由：0.2.0 刚发，用户会来回切版本试用。迁移必须是「用户主动做什么才发生」的，不能是「装上新版就发生」的。B 的报错方式对普通用户几乎无法自救（要手改 JSON）。C 把一个临时状态变成了产品形态。

**选 A 之后仍然要处理一件事：** 老版本完全不读 `accounts.json`，所以回退期间用户看到的是 `config.json` 投影出来的那一个账户。如果老版本改了 `model` / `authMode` / `byokBaseUrl`，新版本下次启动要以投影为准更新全局默认账户的这几个字段（而不是反过来覆盖），否则会出现「界面显示 A、实际用 B」。这条写进 S1 的验收。

**定稿：A。** `accounts.json` 不存在时从 `config.json` 与旧凭据文件合成一个隐式账户 `acct_0000000000`（只存在于内存）；用户第一次改账户设置时才落盘，并把旧凭据**移动**到 `secrets/accounts/<id>/`；`config.json` 一个键都不加。理由：0.2.0 刚发，用户会来回切版本，迁移必须由用户主动触发；`.strict()` 多一个键就会让老版本读不了配置。

### D-7：上下文长度这一项怎么做 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 只做事后切换（推荐）** | 不在发请求前判断；provider 报上下文超限时，换一个声明了更大窗口的候选并说明原因。账户上可以填声明值，仅用于界面显示与事后挑选 | 不编造 token 数；不引入 tokenizer 依赖；错了也只是「多失败一次」 | 超限的任务要多失败一次才切；不声明窗口的账户在这一步帮不上忙 |
| B. 粗估预判 | 按字符数 ÷ 4 估计 token，超过声明窗口就不进候选 | 一次就对 | 「÷4」对中文、代码、附件 base64 全都是错的，估出来的数字会被当成真数字；附件是 base64，估出来的量级完全失真 |
| C. 引入 tokenizer | 打包一个分词器，按模型算真实 token | 准 | 每个模型的分词器不同（`tiktoken` 只覆盖 OpenAI 系），包体积与许可证成本都要付；#131 不是为这个立项的 |

**推荐 A。** 理由：`contextTokens` 在这版里的作用是**告诉用户和事后挑选**，不是**预测**。B 和 C 都会让界面上出现一个看起来精确、实际上没根据的数字，那比"不判断"更糟。代价是要接受偶尔多失败一次，这个失败原因本身也是有用的信息。

**定稿：A。** 不在发请求前预判；只在 provider 明确报上下文超限时换一个声明了更大窗口的候选，并说明原因。账户上的 `capabilities.contextTokens` 只用于界面显示与事后挑选。理由：没有 tokenizer 时任何预判都会在界面上造出一个看起来精确、实际没根据的数字。

### D-8：自动路由要不要写进成本统计 **已选 A（2026-10-31）**

| 方案 | 做法 | 好处 | 代价 |
| --- | --- | --- | --- |
| **A. 不建统计，只记事实（推荐）** | 消息元数据里记 `route` 和 provider 自报的 `usage`（有就记，没有就空）；不建用量表、不算钱、不按价格排序 | 先把「谁给的、用的哪个模型、为什么」记全；以后要统计时数据已经在；不会出现假的价格 | 用户看不到「这个月花了多少」；成本偏好只能靠自标档位（4.5） |
| B. 同时建一张用量表 | 新表记每次任务的账户、模型、token、按价格表折算 | 能看花费 | 需要价格目录与维护成本，跨 provider 的单位不统一；`siwc`/`compat` 这种订阅制根本没有单价，算出来的数字没有意义 |
| C. 完全不记 usage | 连 provider 报的 token 数也不记 | 最省 | 以后想统计要从零开始；而且这些数字本来就在响应里，丢掉可惜 |

**推荐 A。** 理由：本仓库今天**没有任何**用量或价格数据（调研 §8 有检索记录）。做统计的前提是价格目录，而订阅制账户（`siwc`、`compat`、Claude 订阅）没有单价——同一张表里一半是"钱"一半是"额度百分比"，做出来就是误导。先记事实，等真有需要时再单独设计。

**定稿：A。** 不建用量或价格表，也不按价格排序；`meta.route` 里记录 provider 自报的 `usage`（有就记，没有就空），成本偏好只靠用户自标的 `costTier`。理由：订阅制账户没有单价，一半「钱」一半「额度」的表会误导；先记事实，需要统计时另立 issue。

## 8. 测试策略（plan 时展开）

只写方向，不写用例清单：

- **账户文件**：`accounts.json` 的读写是纯函数，坏 JSON、未知版本、重名、id 重复、`compat` 带凭据文件、`byok` 缺 `baseUrl` 都要有拒绝路径。
- **凭据**：沿用现有 secret 测试的形态（符号链接、权限位、内容无效），新增「同一目录里出现两种凭据」与「删除账户后目录不在」。
- **候选集**：给定账户列表 + 任务特征，断言选中的账户和 reason 码；重点是「空候选」和「冷却中」。
- **错误分类**：把 `transport.ts` 的每种错误塞进分类表，断言换或不换；特别是 401、403、内容审核、已输出之后。
- **推理丢弃**：换账户后下一轮请求里不含任何上一轮的 `encrypted_content`。
- **兼容**：旧 `ModelSettingsDto` 形状的客户端读新响应不报错；新前端对 404 隐藏账户块。
- **端到端**：一个真账户 + 一个故意坏掉的账户（错误 baseUrl），断言自动模式会切过去并在元数据里留下 attempts。真实模型验收另开一份 `docs/reviews/` 记录，不在 spec 里假装跑过。

## 9. 分批概要（plan 时细化）

1. **S1 账户数据与凭据**：`accounts.json` schema、`secrets/accounts/<id>/`、`AuthStore` 支持自定义目录、读时合成的隐式账户。
2. **S2 设置接口与界面**：`/_nema/accounts*`、设置页账户块、三处账户选择器（本机绑定）。
3. **S3 路由核心**：候选集、能力三层、错误分类、冷却、`route` 元数据与界面一行。此步先只支持手动。
4. **S4 自动模式**：全局开关、自动选择、attempts、进度事件。
5. **S5 文档与验收**：三语指南、`docs/reference.zh-CN.md`、真实账户的验收记录（含失败与限流的实际情况）。

S1 与 S2 可以并行；S3 依赖 S1；S4 依赖 S3。

## 10. 已定的事项（2026-10-31，用户决定）

用户在 2026-10-31 确认：第 7 节的八项**全部按推荐 A**。逐项一句话摘要，理由与代价留在第 7 节各自的表格里。

| 项 | 决定 | 一句话 |
| --- | --- | --- |
| D-1 | **A** | 元数据与绑定在 `<nemaHome>/accounts.json`（0600），凭据在 `secrets/accounts/<id>/`（0700 / 0600），两处分开。 |
| D-2 | **A** | id 是 `acct_` + 10 位随机字符，创建时生成、永不变；名字只作显示、可改。 |
| D-3 | **A** | 自动路由默认关，显式开启后才出现「自动」选项；开之后每个 workspace / thread 仍默认跟随 workspace。 |
| D-4 | **A** | 自动模式没有合格候选就失败并说明缺什么；手动点名的账户照发，provider 拒绝时转述原文。 |
| D-5 | **A** | 回复下一行显示账户 · 模型 · 原因，同时写进 `AgentMessageMeta.route`。 |
| D-6 | **A** | 读时合成隐式账户 `acct_0000000000`，首次改账户设置才落盘并移动旧凭据；`config.json` 一个键都不加。 |
| D-7 | **A** | 不在发请求前预判上下文；只在 provider 报超限时换一个声明了更大窗口的候选。 |
| D-8 | **A** | 不建用量或价格表；`meta.route` 只记 provider 自报的 usage，成本偏好靠自标 `costTier`。 |

决策日期：2026-10-31（JST）。plan 严格按上表写；实现中若发现某项在当前代码或当前 provider 上做不到，先停下报告，不悄悄换成另一个选项。
