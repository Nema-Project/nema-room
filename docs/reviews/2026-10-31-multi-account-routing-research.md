# 多账户与自动路由：社区做法调研

输入给 [同一供应商多账户与自动路由设计](../superpowers/specs/2026-10-31-multi-account-routing-design.md)（issue #131）。本文只记录**官方文档写了什么**，以及「Nema 该不该学」。没有跑任何第三方服务，没有申请新 key，没有读本机任何凭据。

抓取日期：2026-10-31（JST）。下面每条都给了当次打开的 URL；没有出处的判断不写。

标注：**[C]** 引文直接来自该页。**[I]** 由引文推得，是我的判断。

---

## 0. 一句话结论

四个成熟实现（LiteLLM、OpenRouter、Claude Code、Cursor）都用同一套骨架：**候选集 → 按能力/健康度过滤 → 排序 → 选中 → 失败时在候选集里换一个 → 把「实际用了哪个」记下来**。差别只在候选怎么来（配置的 model group / provider 列表 / 模型池）和决策暴露多少（响应头、日志、界面提示、默认隐藏）。Nema 缺的不是路由算法，而是**每个账户/模型的能力与价格这些事实**：现在一个都没有（第 6 节）。

---

## 1. LiteLLM Router

### 1.1 多部署写法：`model_list` + `model_name` 别名

**[C]** 同一 `model_name` 下挂多个 deployment，每个 deployment 有自己的 `litellm_params`（`model`、`api_key`、`api_base`、`rpm`、`weight`、`order`）。请求写 `model="gpt-6-luna"`，Router 在这个名字的多个 deployment 里挑。

> "list of model deployments … model_name: gpt-6-luna, # model alias -> loadbalance between models with same `model_name`"

出处：<https://docs.litellm.ai/docs/routing>

**[C]** 每个 deployment 由 `litellm_params` 的确定性哈希得到唯一 `model_id`，冷却和健康状态按 deployment 记，不按 model group。

**[C]** `order` 是优先级（数字小优先），某个 order 层级整体失败才升到下一层；`weight` 在同一层内按权重抽。

**[I] Nema 该不该学：** 学「别名 + 多条目」这个形状，但**不要**学 LiteLLM 的「同组内随机挑」。Nema 的每条记录是一次真实的账户+模型选择，用户要能预期「这条消息会花谁的钱、发给谁」，随机挑与 #131 要求的可解释性冲突。

### 1.2 路由策略

**[C]** 官方列了五种内置策略，并明确写了默认值与取舍：

- `simple-shuffle`（默认，官方 "RECOMMENDED - best performance in production"）：按 `rpm`/`tpm` 或 `weight` 加权抽；都没给就随机。
- `usage-based-routing` / v2：按 Redis 里记的低 TPM 用量挑；官方写 "Usage-based routing is not recommended for production due to performance impacts"。
- `latency-based-routing`：按缓存的响应时间挑，可用 `routing_strategy_args.ttl` 设窗口、`lowest_latency_buffer` 设缓冲。
- `least-busy`：挑并发最少的。
- `cost-based-routing`：挑单价最低；模型不在 LiteLLM 自己的 `litellm_model_cost_map` 里时**按 `$1` 计**（这一点很关键：没有价格表就退化成常量）。

出处同上。

**[I] Nema 该不该学：** `simple-shuffle`、`usage-based`、`least-busy`、`latency-based` **都不学**。理由：Nema 的 daemon 是单进程、单任务串行执行（`apps/cli/src/daemon/runner.ts` 的 `Runner` 一条链），没有并发负载要摊，也没有 Redis 记跨进程用量；这些策略在本地桌面里只会让「为什么选了它」变得不可解释。`cost-based` 的**思路**要学，但 LiteLLM 自己承认缺价格时按常量兜底——Nema 连这张表都没有，见第 6 节。

### 1.3 失败处理：fallbacks / retries / cooldowns

**[C]** 三类 fallback：`fallbacks`（其余错误，如 429）、`context_window_fallbacks`（`ContextWindowExceededError`）、`content_policy_fallbacks`（`ContentPolicyViolationError`）。fallback 是 model group 到 model group 的有序列表。

**[C]** 冷却：默认"429 立刻冷却 5 秒；一分钟内失败率 >50% 冷却 5 秒；401/404/408 冷却 5 秒"。可设 `allowed_fails`、`cooldown_time`，也可按 deployment 单独设。

**[C]** 重试：`num_retries`，限流错误用指数退避，`retry_after` 设最小等待。`num_retries` 与 provider SDK 的 `max_retries` 不同，走 Router 时 SDK 的重试被钉成 0，避免 `(1+N)²` 次上游调用。

出处：<https://docs.litellm.ai/docs/proxy/reliability>、<https://docs.litellm.ai/docs/routing>

**[C]** 跨 provider / 跨 API key 的 fallback **解不开**前一个 deployment 产出的加密推理：

> "A fallback to a deployment on another provider, or on another API key, cannot decrypt the encrypted reasoning the failed deployment produced on earlier turns … The fallback drops what the target cannot decrypt and keeps each Responses reasoning item's readable summary"

**[I] Nema 该不该学：** 冷却与「换之前先按错误分类」学，数值不抄（5 秒是 LiteLLM 的经验值，Nema 该自己定并在决策里写出来）。**加密推理必须丢**这一条一定要写进设计：Nema 的 direct 传输本来就发 `include: ["reasoning.encrypted_content"]` 并在下一轮回放（`apps/cli/src/direct/loop.ts`），换账户等于换 key，回放的 reasoning 必须整段丢掉。

### 1.4 调用前的能力过滤

**[C]** `enable_pre_call_checks: true` 时，Router 先按上下文窗口过滤 deployment；可用 `model_info.max_input_tokens` 覆盖。

**[C]** 视觉能力过滤**默认开启**，且不需要 `enable_pre_call_checks`：请求带图片时，标成 `supports_vision: false`（或目录里如此）的 deployment 被移除；全部都不支持时不移除，交给 provider 自己报错。

**[C]** 响应头 `x-litellm-model-id` 指出实际服务的 deployment；spend log 里记 `attempted_fallbacks` 与 `original_model_group`。

出处：<https://docs.litellm.ai/docs/routing>、<https://docs.litellm.ai/docs/proxy/reliability>

**[I] Nema 该不该学：** 学「按能力先过滤候选，全部不支持时不假装支持、让 provider 自己报错」，以及「响应头/日志记下实际服务者」。不学「没有声明就当作可用」这条默认——LiteLLM 的默认是"没有声明也不在目录里就保持可选"，而 #131 要求不静默降级，Nema 反过来：**没有明确支持就不进候选**（除非用户手选）。

---

## 2. OpenRouter

### 2.1 provider routing 的 `provider` 对象

**[C]** 请求体里的 `provider` 对象字段：

| 字段 | 含义（原文要点） |
| --- | --- |
| `order` | provider slug 的有序列表，按序试 |
| `allow_fallbacks` | 默认 `true`，主 provider 不可用时是否允许备用 |
| `require_parameters` | 只用支持请求里**全部**参数的 provider |
| `only` / `ignore` | 白名单 / 黑名单 |
| `sort` | `"price"` / `"throughput"` / `"latency"`，或 `{by, partition}` |
| `preferred_min_throughput` / `preferred_max_latency` | 可给 p50/p75/p90/p99 分位阈值；**只降权不排除** |
| `max_price` | 超过就不跑（与上一行相反，是硬限制） |
| `quantizations`、`data_collection`、`zdr` | 量化、数据留存策略 |

**[C]** 默认路由会综合「实际价格（含缓存命中与输入输出比）、吞吐、首 token 延迟、429 率、可靠性、工具调用是否规范」给每个 provider 分配流量份额，并按请求随机加权挑；某个 provider 明显变差时份额降到零。

**[C]** 请求带 `tools` 时，"OpenRouter makes a best effort to route to providers known to support tool use"。

**[C]** 设了 `sort`、`order`、`:floor`/`:nitro` 或自带 key 时，默认路由被绕过。

出处：<https://openrouter.ai/docs/guides/routing/provider-selection>

**[I] Nema 该不该学：** 学三个概念：**排序键可以是价格/速度**、**阈值型偏好只降权、硬上限才排除**、**能力不满足的 provider 不进候选**。不学默认路由本身：它依赖真实生产流量的统计量，Nema 一台机器上凑不出样本，硬做只会变成拍脑袋。

### 2.2 `models` 回落数组

**[C]** `models: ["a", "b"]` 按优先级试；默认任何错误都能触发回落，**包括"上下文长度校验错、内容审核拦截、限流、宕机"**；计费按最终使用的模型。

**[C]** `/messages` 还有一个 `fallbacks` 参数，最多 3 条，只能带 `model` 字段，且不能与 `models` 同时用。

出处：<https://openrouter.ai/docs/guides/routing/model-fallbacks>

**[I] Nema 该不该学：** 学「回落列表是有序的、最终按实际用的计费/记账」。**不学**「任何错误都回落」：内容审核拦截回落到另一个模型等于替用户绕过供应商策略，Nema 不该做。

### 2.3 错误面：什么时候**不能**回落

**[C]** 流式请求在 provider 接受后 HTTP 头就已经发出，"Failover also stops once part of the answer has reached you, since your application already holds output from the first provider."

**[C]** 错误码表：`429`（限流）、`503`（没有满足路由要求的 provider）、`402`（余额不足）、`502`（模型宕机/无效响应），429/503 可能带 `Retry-After`。

**[C]** 有一份规范化的 `error_type` 词表，跨三种 API 皮肤稳定：`context_length_exceeded`、`rate_limit_exceeded`、`provider_overloaded`、`provider_unavailable`、`payment_required`、`authentication`、`permission_denied`、`content_policy_violation`、`refusal`、`server`、`timeout` 等。

**[C]** 非流式请求也可能拿到 HTTP 200、正文里只有 `error` 对象。

出处：<https://openrouter.ai/docs/api-reference/errors>

**[I] Nema 该不该学：** 这一页是全篇最该照抄的：**按 `error_type` 分类决定换不换**，而不是按 HTTP 状态码猜；**输出已经开始就不再换**；**402/401 不换**（换账户等于替用户花钱或掩盖失效的 key）。

### 2.4 模型目录里有什么

**[C]** `GET /api/v1/models` 每个模型返回 `context_length`、`architecture.input_modalities`（`["file","image","text"]`）、`supported_parameters`（含 `tools`、`tool_choice`、`structured_outputs`、`reasoning` 等）、`pricing`（每 token 单价，含 `input_cache_read` 等）、`top_provider.max_completion_tokens`。单模型查询 `GET /api/v1/model/{author}/{slug}`。

本次抓取的一份真实响应（同一台机器、2026-10-31，取第一条）包含 `"context_length":1048576`、`"input_modalities":["text","image"]`、`"supported_parameters":[...,"tool_choice","tools",...]`。

出处：<https://openrouter.ai/docs/guides/overview/models>

**[I] Nema 该不该学：** 学「能力从目录读，不从模型名猜」。这正是 Nema 现在最缺的一块，而且 `byok` 可以指向 OpenRouter 这类网关，所以对**一部分**真实配置，这份目录是能读到的；对 OpenAI 官方 `/models` 这类只回 id 的端点读不到，只能靠用户声明。

---

## 3. LibreChat：多端点配置

**[C]** `librechat.yaml` 的 `endpoints.custom` 是一个列表，每项 `name`（唯一）、`apiKey`（可写 `${ENV}` 或 `user_provided`）、`baseURL`（可写 `${ENV}` 或 `user_provided`）、`models.default`（必填至少一个）+ `models.fetch`（是否去线上拉列表）。`provider: "anthropic"` 时走原生 Messages 客户端，此时 `models.fetch` 不生效。

**[C]** 每端点可配 `tokenConfig`，按模型给 `prompt`/`completion`/`context`/`cacheRead`/`cacheWrite`，用于上下文用量、费用拆分与多端点计费。

**[C]** 端点之间不合并：用户在界面上选 endpoint，再选该 endpoint 的 model。

**[C]** 文档自己点出一个坑：缺任一必填字段的端点会**静默消失**——"An entry missing any of them is removed from the endpoint list with no error and no log line at all"；同名（不分大小写）端点会静默替换前一个。

出处：<https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint>、<https://www.librechat.ai/docs/quick_start/custom_endpoints>

**[I] Nema 该不该学：** 学「一个账户 = 名字 + baseURL + key + 默认模型 + 每个模型的能力/价格元数据」这个字段组合，以及"按模型配 `context`"。**不学静默丢配置**：Nema 的账户文件读不出来时必须报错并指出哪一条（`config.json` 现在的做法就是 `configErrorMessage` 明确报错，保持一致）。

---

## 4. Open WebUI：多 OpenAI 兼容连接

**[C]** 环境变量成对出现，**按位置对应**：`OPENAI_API_KEYS`（分号分隔，"Supports multiple OpenAI API keys, semicolon-separated"）与 `OPENAI_API_BASE_URLS`（分号分隔，"Supports balanced OpenAI base API URLs, semicolon-separated"）。键多于 URL 时截断、URL 多于键时补空串，这一条来自后台连接组件的源码（`updateOpenAIHandler`）。

**[C]** `OPENAI_API_CONFIGS` 是 JSON 对象，**以连接的下标为键**（旧版也接受 URL 作键），每项可含 `enable`、`prefix_id`、`model_ids`、`tags`、`connection_type`。

**[C]** 界面上是 Settings > Admin > Connections 里逐个「Add Connection」，每个连接可单独启停；provider 不实现 `/models` 时用 Model IDs 白名单手动列出。

**[C]** 验证连接会调用 provider 的 `/models`；有些 provider 不支持，验证失败但对话仍可用。

出处：<https://docs.openwebui.com/reference/env-configuration/>、<https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/>、<https://github.com/open-webui/open-webui/blob/main/src/lib/components/admin/Settings/Connections.svelte>

**[I] Nema 该不该学：** 学「每个连接可单独启停」「拉不到模型列表时可以手填」。**不学**位置对应的分号数组和「下标当键」：账户一旦被删除或重排，下标就全错位，且这种错位是静默的。Nema 用带 id 的命名记录。

---

## 5. Cursor 和 Claude Code：用户怎么选模型

### 5.1 Cursor

**[C]** Cursor 的 Auto 有三种模式：Cost / Balance / Intelligence，由 Router 按任务类型与复杂度分类后选模型；用户"steer routing by choosing an optimization mode"，不能指定具体模型。

**[C]** 团队设置里有一项「Underlying model」：可以**显示** Auto 路由到了哪个模型，或者**隐藏**——"Hidden is the default and recommended, so results are judged on their own merit rather than by model name"。

**[C]** Router 遵守团队的模型访问控制；"Blocking too many models reduces routing quality and can disable the router"。

出处：<https://cursor.com/docs/cursor-router>、<https://cursor.com/docs/models>

**[I] Nema 该不该学：** 学「用模式（成本/平衡/质量）而不是逐个挑模型来表达偏好」。**明确不学默认隐藏**：Cursor 隐藏是为了让评测不看模型名，而 #131 明确要求用户看得到用了哪个账户、哪个模型、为什么。

### 5.2 Claude Code

**[C]** 选模型有优先级：会话内 `/model` > 启动 `--model` > `ANTHROPIC_MODEL` > 设置里的 `model` > `ANTHROPIC_DEFAULT_MODEL`。`/model` 选择器里 `Enter` 存为默认，`s` 只对本次会话生效。

**[C]** 有「fallback model chain」：`--fallback-model a,b` 或设置 `fallbackModel: []`，最多 3 个；**只在 overloaded/unavailable 等非可重试服务端错误时切**，且"Authentication, billing, rate-limit, request-size, and transport errors … never trigger a switch"；切换只对当前轮有效，下一轮先试主模型；切换时会在对话里显示提示。

**[C]** 还有一类「自动模型回落」：Fable/Opus/Sonnet 的安全分类器拦下请求后，改到另一个模型重跑，之后会话就留在那个模型上，可用 `/model` 换回；可用 `switchModelsOnFlag: false` 改成每次询问。

**[C]** `availableModels` / `enforceAvailableModels` 让管理员限制可选模型；别名在不同 provider 上解析到不同版本。

出处：<https://code.claude.com/docs/en/model-config>

**[I] Nema 该不该学：** 学两点：**「切换要有明显提示」**、**「认证/计费错误不切换」**。不学的一点：Claude Code 连限流都不切，是因为它只有一个账户，换模型并不会换来新的额度；Nema 的前提正相反——另一个账户有独立额度，所以限流时换账户是对的。这个差别要在 spec 里写清楚，避免照抄成"限流也不切"。

---

## 6. 可选补充：多 key 的原生做法

### 6.1 Anthropic workspaces

**[C]** 组织下可有多个 workspace（默认上限 100），API key 可以**绑定单个 workspace**，此时请求不必带 workspace 头；未绑定的 key 必须在每个请求上带 `anthropic-workspace-id`。

**[C]** key 分 personal / service account / workspace（legacy）三类；workspace 可配成员、资源与**花费上限**。

出处：<https://platform.claude.com/docs/en/manage-claude/workspaces>、<https://platform.claude.com/docs/en/manage-claude/authentication>

**[I] Nema 该不该学：** 学「一个账户 = 一把 key + 一个可选的作用域头」。这意味着账户记录里除了 baseUrl 还要能放**额外的请求头**（LiteLLM 和 LibreChat 也都有 `headers`/`extraHeaders` 这个概念）。Nema 的 `TransportProfile.extraHeaders` 已经是这个形状，扩展成本低。

### 6.2 OpenAI projects

**[C]** 项目 API key 属于项目；项目可设**模型权限**（`allow_list` / `deny_list`）和**速率限制**（按模型给 rpm/tpm）。

出处：<https://platform.openai.com/docs/api-reference/projects>、<https://platform.openai.com/docs/api-reference/project-api-keys>

**[I] Nema 该不该学：** 学「同一个组织下用几把项目 key 当几个账户」是真实存在的用法，所以「同一供应商多账户」不是假需求；同时说明**限额可能是按项目/按 key 分别算的**，这正是换账户能绕过限流的原因。

### 6.3 Vercel AI SDK provider registry

**[C]** `createProviderRegistry` 把多个 provider 注册成 `providerId:modelId` 字符串；`customProvider` 可定义别名、预设参数（middleware）、限定可选模型，并可指定 `fallbackProvider`。

出处：<https://ai-sdk.dev/docs/ai-sdk-core/provider-management>

**[I] Nema 该不该学：** 学「账户+模型合成一个稳定 id」的表达（Nema 可用 `accountId/model`），便于在日志和消息元数据里指认；不引入 AI SDK 本身，Nema 的传输层是自己写的。

---

## 7. 汇总：Nema 学什么、不学什么

| 主题 | 社区做法 | Nema 的决定 | 理由 |
| --- | --- | --- | --- |
| 候选集 | model group（LiteLLM）/ provider 列表（OpenRouter）/ 多连接（Open WebUI、LibreChat） | 账户列表 + 每个账户的默认模型；作用域绑定的账户进候选 | 账户是用户能理解和管理的单位 |
| 能力过滤 | 调用前按 `supports_vision`、上下文窗口过滤（LiteLLM）；`require_parameters`（OpenRouter） | 只让**明确声明支持**的账户进候选；上下文超限靠 provider 报错再切 | Nema 没有 tokenizer，也没有权威能力表；宁可不选，不可假装 |
| 错误分类 | `error_type` 词表（OpenRouter） | 照此分类：429/额度/5xx 可切；401/403/内容审核不切 | 见 §2.3、§5.2 |
| 输出已开始 | OpenRouter 明确不再 failover | 同 | 半截回答已经给用户了，换模型拼接只会更糟 |
| 加密推理 | 跨 key fallback 解不开，丢弃（LiteLLM） | 换账户时整段丢弃 reasoning | Nema 本来就回放 encrypted_content |
| 冷却 | allowed_fails + cooldown_time（LiteLLM） | 有，但时长自己定并写进决策 | 数值不可照搬 |
| 成本偏好 | 模式选择（Cursor 三档）、`sort: price`（OpenRouter）、成本表（LiteLLM） | 用户给账户标成本档位，不建价格表 | 见 §8 |
| 决策可见 | 响应头 + 日志（LiteLLM）、切换提示（Claude Code）、默认隐藏（Cursor） | 回复里一行 + 消息元数据 | #131 明确要求可见 |
| 配置形状 | 位置对应数组 + 下标键（Open WebUI）；静默丢条目（LibreChat） | 带 id 的命名记录，读不出来就报错 | 重排/删除不该静默错位 |

## 8. Nema 现在没有的事实

**[C]** 本仓库里没有任何 token 用量或花费的统计：`apps/cli/src/direct/transport.ts` 不解析响应的 `usage`，`apps/hub` 没有任何 usage/cost 表（`grep -rn "usage\|cost\|pricing"` 只命中错误码与 Skill 文案）。

**[I]** 因此「成本偏好」在 v1 里**不可能**基于真实价格排序。可做的只有：用户给每个账户标一个成本档位（自己心里的相对贵贱），路由按档位排序。这一点必须在设计里说明，不能假装在优化真金白银。

**[C]** 本仓库也没有任何按模型的能力表：能力判断只有按适配器的三格表（`apps/cli/src/attachments/capabilities.ts:13-18`：Claude Code 的 pdf 是 `unknown`，codex-direct 的 image/pdf 是 `native`），没有上下文窗口、没有工具调用声明、没有 `input_modalities` 之类的字段。

## 9. 三个最重要的发现

1. **换账户只能发生在两次模型调用之间。** OpenRouter 明说输出一到就不再 failover；LiteLLM 明说跨 key 的 fallback 解不开前一个账户的加密推理、只能丢掉摘要。Nema 的工具循环每轮都回放 `encrypted_content`，所以"自动切账户"在设计上必须写成"下一次模型调用换账户，并丢弃本轮之前的推理内容"，不能写成"这次请求失败就换个账户重发"。
2. **能力必须来自声明，不能来自模型名。** 三家成熟实现都靠元数据（`supports_vision`、`input_modalities`、`context_length`）过滤候选，没有一家靠名字猜。Nema 现在连这些字段都没有，所以 v1 的路由要先补一张**账户级能力记录**（用户声明或从目录读），否则"按能力路由"只是换了个说法。
3. **"什么错误该切、什么错误不该切"比"怎么挑"更要紧。** OpenRouter 有一整份 `error_type` 词表，Claude Code 明确写了认证/计费/限流/传输错误不触发切换（它只有一份额度）；Cursor 干脆让用户选模式而不是管细节。Nema 的取舍应该照 OpenRouter 分类、按自己的前提（多账户各自有额度）决定限流要切、认证与内容审核不切。
