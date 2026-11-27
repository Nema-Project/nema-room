# 首次运行 agent 就绪引导（#302）实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were assigned says so.

**目标**：按已定案 spec，让「运行 daemon 的这台机器能不能替我跑 agent」成为一条有来源的事实：daemon 按运行时计算就绪状态（只读本机，不联网），hub 透传并按调用者裁剪，web 在首页空状态、工作区横幅、Composer 与设置页深链四处不打扰地呈现，配好后永久退休。

**规格**：[2026-11-25 首次运行 agent 就绪引导设计](../specs/2026-11-25-first-run-agent-guidance-design.md)（PR #307，合并提交 `e784ee4`）。D-1…D-10 已定案，评审第二轮对 D-4、D-5/D-9、D-6、D-7 的修订已于 2026-11-26 由维护者裁定接受，**以 spec 当前文本为准**。Issue：[#302](https://github.com/Nema-Project/nema-room/issues/302)。

**如何服务 [#45](https://github.com/Nema-Project/nema-room/issues/45)**：agent 是共同理解的一半生产者。本计划把 agent 一侧的就绪状态做成可复检、写明检查了什么与没检查什么的事实，而不是让首个任务失败后再推断。护栏照 spec 执行：只说「已配置」不说「可用」（D-3）；不挡知识库等无需 agent 的入口（spec「不做」）；不代装、不代登录，只给官方链接与命令文本（D-5）；文案主语一律是「运行 daemon 的机器」（D-9）。本计划不把 Nema Room 收窄成编排器或 coding UI：引导只回答一个问题，即 agent 这一方是否到场。

## 已核对的现状（对照 `e784ee4`）

spec 的「现状核实」写于 `ca0266d`。此后 `main` 合入了 99 个提交，其中包括 #167（v0.3.3）。下面只列本计划依赖、且与 spec 写作时不同或需要补充的点。其余以 spec 为准，执行时仍需按行号复核。

1. **#167 已落地，daemon 不再是单例**。`apps/hub/src/daemonSocket.ts:186` 是按 `daemonId` 索引的连接表。`Conn` 带 `registered` 与 `ownerUserId`（:73-76），注册 daemon 的 `ownerUserId` 是 `daemons.owner_user_id`；本机 daemon 未注册，`ownerUserId` 为 null。`DaemonRpc.call` 只有一个连接时直接由它应答；有多个时按 `chooseConnection`（:762-810）选择，不带目标的调用落到**最新的连接**（规则 4）。facade **不向调用方报告由哪个连接应答**。
2. **主机级路由已有管理员门**。`apps/hub/src/app.ts:38` 的 `HOST_ADMIN_PATH` 包含 `/api/agent-clis` 与 `/api/daemon/*`（含 `GET /api/daemon/status`，`uiApi.ts:202`），远程形态下非 hub 管理员会收到 403（`authz.ts:66-82`）。新路由 `/api/agent-readiness` 不匹配这条正则，正合 spec「非主人拿到裁剪回复」的要求，不能放进这个门。
3. **daemon 状态没有连接标识**。`GET /api/daemon/status` 只回 `{ connected }`。`daemon.status` 事件在每次接受 hello 时发 `connected: true`（:644），关闭时只在**没有剩余连接**时发 `connected: false`（:727）。多连接下，最新连接关闭会让「当前应答者」静默换成较旧的连接，期间不发任何事件。
4. **既有路径仍与 spec 一致**：`agents.detect` 在 `apps/cli/src/components/rpc.ts:229`；hub 透传在 `apps/hub/src/components.ts:82`；`detectAgentClis` 在 `apps/cli/src/agentClis.ts:36`，`execFile` 的超时为 10 秒（:31）；`preferredModel`、`credentialStateOf` 在 `apps/cli/src/routing/accountAuth.ts:28`、`:45`；`implicitCredentialState`、`accountCredentialState` 在 `apps/cli/src/accounts/credentials.ts:170`、`:187`。
5. **web 侧行号有漂移**：`getAgentClis` 在 `apps/web/lib/hub.ts:174`，`getMe` 在 `:220`。`AppSettings` 的标签 state 在 `apps/web/components/AppSettings.tsx:235`，切换在 `:259`。`main.empty` 在 `WorkspaceShell.tsx` 的 **两处**（:531、:586）。`useAccounts` 的 `bindings`/`supported` 在 `apps/web/lib/useAccounts.ts:17-36`。桌面 SIWC 登录任务状态由 `apps/local/src/settings.ts:290` 的 `/_nema/auth/status` 提供，`ModelSettings.tsx:85`、`:146` 在观察到 `succeeded` 后刷新设置。已有的 `localStorage` 先例在 `apps/web/lib/components.ts:235-251`。

第 1-3 点使 spec 中「按单 daemon 实现」与「从处理 RPC 的连接填写 `daemon`」需要具体落法，本计划在任务 4、5 中给出。仍需维护者判断的部分列在文末[待确认](#待确认不阻塞开工)。

## 全局约束

- **只读、不联网、不发模型请求**（D-3）：就绪计算只做 `--version` 子进程、`lstat`/读本机文件与读 `config.json`、`accounts.json`。任何测试都不调用真实模型；一律使用临时 `nemaHome` 与假执行器。
- **不改路由与失败语义**：`resolveRoute`、`implicitCredentialState`、任务回队与失败句子一行不改（spec「不做」）。合成账户的判定是**新增**的只读导出函数，不改原函数。
- **不改 `agents.detect` 与「组件」页**（D-7）：两者共用执行器，但 `agents.detect` 仍把所有失败映射为 `installed: false`。每个触及执行器的任务都要有回归断言。
- **回复不含凭据**：`agents.readiness` 的回复只有状态、理由码、命令名与版本、账户 id/是否合成/认证模式。不含路径内容、stderr 或令牌。hub 再按 `access` 裁剪（spec「数据契约」末段）。
- **降级是安静的**：旧 daemon 没有 `agents.readiness` 方法、daemon 离线、RPC 失败，web 一律视为 `unknown`：不弹横幅，不给 Composer 提示（D-7、D-8）。
- **永久标记只能由已确认的连接写入**（D-4 并发条、D-6）：只有浏览器在收到 `ready` 回复**之后**又收到状态事件或快照，且该状态的 daemon 身份与**连接身份**都与回复一致，`ready` 回复才能写「已完成首次就绪」标记。只凭就绪回复本身、或凭回复之前收到的状态，不得写标记。浏览器尚未确认任何 `daemonId` 时（例如远程非管理员在两次状态事件之间打开页面），就绪视为 `unknown`：不写标记、不显示横幅与 Composer 提示，卡片第 0 步显示连接状态未知。这条不变量在任务 6 中实现，在任务 6 与任务 9 中各用测试钉住。
- **文案**：主语是「运行 daemon 的机器」；不说「未安装」，只说「PATH 上找不到」（现状 8、D-10）；不说「可用」或「已验证」。所有新增字符串同步进 `apps/web/messages/{en,zh,ja}.json`。命令一律用版本化写法（AGENTS.md）。
- **验收三类分开记**：静态检查、自动化测试、真实环境（VM 内 Compose，任务 13）互不替代。桌面实机不主动测（2026-11-16 测试政策）；D-10 的 macOS PATH 推断如需确认，由维护者在实机上看。

## 文件与职责（预计）

- `apps/cli/src/accounts/credentials.ts`：任务 1，新增只读的合成账户旧路径判定导出。
- `apps/cli/src/agentClis.ts`：任务 2，拆分执行器结果（成功、ENOENT 后按 PATH 查到或查不到、超时、其他错误），加 `--version` 成功缓存与在途共享，`detectAgentClis` 的映射不变。PATH 查找规则以 `apps/cli/src/platform.ts` 的 `commandSpec` 为准，与它共用或下沉一份，不另写一套。
- `apps/cli/src/agents/readiness.ts`（新）：任务 3 的 `computeReadiness`。注册放在 `apps/cli/src/components/rpc.ts`，与 `agents.detect` 相邻。
- `packages/shared`：任务 3 的 `RuntimeReadiness`、`ReadinessReply` 类型与 hub HTTP 回复类型（含 `access`）。放在 `AgentCliStatus` 的定义处旁，执行时用 grep 定位。
- `apps/hub/src/daemonSocket.ts`、`apps/hub/src/daemonRpc.ts`、`apps/hub/src/uiApi.ts`：任务 4（状态带 `daemonId`）与任务 5（facade 报告应答连接）。
- `apps/hub/src/components.ts`（或新 `apps/hub/src/readiness.ts`）：任务 5 的 `GET /api/agent-readiness`。
- `apps/web/lib/hub.ts`、`apps/web/lib/agentReadiness.ts`（新）、`apps/web/lib/useAgentReadiness.ts`（新）：任务 6、7。
- `apps/web/components/AppSettings.tsx`、`ModelSettings.tsx`、`apps/local/src/settings.ts`：任务 8。
- `apps/web/components/WorkspaceShell.tsx` 与新组件 `AgentReadinessCard.tsx`、`AgentReadinessBanner.tsx`：任务 9、10。`apps/web/components/Composer.tsx`（执行时以现状定位）：任务 11。
- `changelog.d/302-first-run-agent-guidance.added.md`、四份 README、`docs/guide.{en,zh,ja}.md`：任务 12。

## PR 切分建议

硬顺序：PR-1 → PR-2 → PR-3 → PR-4 → PR-5。任务 4 不依赖 PR-1，可以与 PR-1 并行开发，但须随 PR-2 合入。

| PR | 任务 | D 编号 | 说明 |
| --- | --- | --- | --- |
| PR-1 | 1、2、3 | D-1、D-3、D-4（daemon 缓存与并发）、D-7 | daemon 侧新增方法。没有 UI 变化，旧 web 与 hub 不受影响。 |
| PR-2 | 4、5 | D-4（连接标识）、D-7、D-9 | hub 状态带连接 id，新增透传路由并按调用者裁剪。web 尚未消费，不改变用户可见行为。 |
| PR-3 | 6、7、8 | D-4、D-5、D-6、D-8、D-2（深链部分） | web 数据层、下一步选择、设置页初始标签与复检时刻。只有深链参数可见，引导落点还没有接入。 |
| PR-4 | 9、10、11、12 | D-2、D-5、D-6、D-8、D-10 | 三处落点与文档、changelog 同一个 PR 上线，避免先上 UI 后补文档。 |
| PR-5 | 13 | 验收 | 真实环境验收、#302 记录、ROADMAP。记录型。 |

拆成这样的理由：每个 PR 合入后 `main` 都是可发布状态。PR-1 只增加 RPC 方法；PR-2 只增加路由与字段；PR-3 不接任何落点；用户可见的引导集中在 PR-4。PR-4 回归面最大，它依赖的状态机已在 PR-3 用纯逻辑测试钉住。

## 阶段一：daemon 侧就绪计算（PR-1）

### 任务 1：合成账户旧路径凭据的只读判定（D-1）

- [ ] 在 `apps/cli/src/accounts/credentials.ts` 新增并导出 `implicitCredentialReadiness(nemaHome, account, codexHome): CredentialState`，返回 `connected | missing | unusable`。规则照 spec「判定对象」第一条：
  - SIWC：用 `AuthStore.inspect`，再对解析出的记录套用 `usableSiwcLogin`（`credentials.ts:182-184,222-226`）。文件缺失记 `missing`；无法信任或解析、模式不符、刷新令牌为空记 `unusable`。
  - BYOK 的 `byok-key` 与 Claude 的 `claude-code-token` 按 `fileState`（私有、属主、单行非空）判定。
  - compat 按 `codexLoginProblem` 判定 `$CODEX_HOME/auth.json`。
  - 不套用「一个目录只能有一种凭据」的外来文件规则（与 `credentials.ts:160-168` 的注释一致）。
- [ ] `implicitCredentialState` 与 `resolveRoute` 不改：用 `git diff` 确认这两个函数没有改动行，并加一条回归断言，说明 `implicitCredentialState` 对合成 BYOK、compat、claude-code 仍回 `connected`。
- [ ] 先写失败测试（与 `apps/cli/test/` 下既有 credentials 测试同处，执行时定位）：在临时 `nemaHome` 下，覆盖合成账户 SIWC、BYOK、compat、claude-code 四种模式各自的 missing、unusable、connected；SIWC 另测「可解析但刷新令牌为空」与「模式不符」，均记 `unusable`；BYOK key 文件权限过宽记 `unusable`。
- [ ] 验证：`npx vitest run <credentials 测试文件>`；`npm run typecheck -w apps/cli`。

### 任务 2：`--version` 执行器拆分、缓存与并发（D-4、D-7、现状 7/8）

- [ ] `apps/cli/src/agentClis.ts`：把执行器的结果拆成 `{ kind: "ok", version } | { kind: "enoent" } | { kind: "timeout" } | { kind: "error" }`。`detectAgentClis` 用同一个执行器，把非 `ok` 一律映射成 `installed: false`，行为与今天逐字一致。
- [ ] ENOENT 后按 `commandSpec` 同样的 PATH 与扩展名规则查一次 PATH 目录项（只 `lstat`，不执行）：查不到记 `not_installed`，查到记 `unknown` + `cli_broken`。Windows 上 `commandSpec` 对不认识或入口缺失的 shim 抛出的错误（`platform.ts:45-47`）记 `cli_error`。
- [ ] 缓存与并发只用于 readiness 路径（`detectAgentClis` 保持每次直接执行，「组件」页行为不变）：
  - 只缓存 `ok`，有效期 30 秒；ENOENT、超时与其他失败都不缓存。
  - 普通请求共享同一命令最新的在途探测。
  - `force` 启动新探测，并立即清除该命令的缓存。
  - 只有最新启动的探测能写缓存；它失败时缓存保持为空。早于 `force` 启动、晚于它返回的旧探测不能写缓存。
  - 时钟与执行器可注入，便于测试。
- [ ] 先写失败测试（新 `apps/cli/test/agentClis.test.ts`，或续写 `apps/cli/test/components/rpc.test.ts` 中 detect 的用例）：成功、ENOENT 且 PATH 无项、ENOENT 但 PATH 有悬空链接（POSIX）、超时、其他失败；`agents.detect` 对后四种仍回 `installed: false`；缓存命中、过期；普通请求共享在途探测；旧探测晚于 `force` 返回时不污染缓存；`force` 失败后下一次普通请求重新探测。
- [ ] 验证：`npx vitest run apps/cli/test/agentClis.test.ts apps/cli/test/components/rpc.test.ts`；`npm run typecheck -w apps/cli`。

### 任务 3：`agents.readiness` RPC 与共享类型（D-1、D-3、D-7）

- [ ] 在 `packages/shared` 定义 spec「数据契约」中的 `RuntimeReadiness`、`ReadinessReply`，以及 hub HTTP 回复类型 `AgentReadinessResponse = ReadinessReply & { daemon: { id; connectionId; label }; access: "full" | "owner_unknown" | "non_owner" }`，其中 `connectionId` 是 hub 为每次接受的连接分配的标识（同一 daemon 重连时不同），裁剪形式的字段可选性用类型表达。理由码只能取 spec 列出的五个。
- [ ] 新 `apps/cli/src/agents/readiness.ts` 的 `computeReadiness({ nemaHome, codexHome, config, force, probe, now })`：
  - 同一次调用只执行一次 `loadRoutingAccounts`。它抛错时两行都记 `unknown` + `inspect_failed`。缺少 `accounts.json` 时只为当前 `config.adapter` 合成账户；另一运行时不用旧路径凭据预演切换。spec 写的是「只为当前运行时合成账户」，另一行此时怎么判定，执行时按 `loadRoutingAccounts` 的实际返回处理，原文见[待确认](#待确认不阻塞开工)第 4 条。
  - 默认账户按 `resolveRoute` 无显式选择时的规则选取（`routing/index.ts:166-179`：该运行时下已启用账户按 `order`、再按 id 排序取第一个）。把这段逻辑抽成共用函数，或在测试里与 `resolveRoute` 对拍，不要复制出一份会漂移的实现。
  - `claude-code`：先判命令，命令可用才判账户。
  - 没有已启用账户：记 `not_signed_in` + `no_enabled_account`，省略 `account`。
  - 存储账户用 `credentialStateOf`，合成账户用任务 1 的函数。`connected` 的 BYOK 账户若 `preferredModel` 为 `null`，记 `needs_model`。
  - 凭据检查抛错记 `unknown` + `inspect_failed`。
  - `account` 字段只带 `id`、`implicit` 与 `authMode`。
- [ ] 在 `apps/cli/src/components/rpc.ts` 中、`agents.detect` 旁注册 `agents.readiness`，参数 `{ force?: boolean }`，回复中的 `current` 取 `config.adapter`，`checkedAt` 用 ISO 时间。
- [ ] 先写失败测试（新 `apps/cli/test/agents/readiness.test.ts`，覆盖 spec「验收口径·自动化测试」第 1 条）：状态表逐格；`codex-direct` 的 SIWC、BYOK、compat 三种模式，加 `needs_model`；`claude-code` 命令检查的优先级（ENOENT、`cli_broken`、超时、`cli_error` 时不判账户）；两运行时各自没有已启用账户的情况；`accounts.json` 不可读；缺 `accounts.json` 时只合成当前运行时；回复序列化后不含任何临时凭据文件的内容（拿写入的假令牌做反向断言）。
- [ ] 验证：`npx vitest run apps/cli/test/agents/readiness.test.ts`；`npm run typecheck`；`npm run typecheck -w apps/cli`。

## 阶段二：hub 透传、连接标识与裁剪（PR-2）

### 任务 4：daemon 状态带上当前应答连接的 id（D-4 第一条）

- [ ] 定义「当前连接」为不带目标的 RPC 会落到的那个连接，即 `openConnections()` 中最新的一个（`chooseConnection` 规则 4；只有一个连接时就是它）。这正是任务 5 中就绪调用的应答者，两处必须用同一个函数取值。
- [ ] `GET /api/daemon/status` 回 `{ connected, daemonId: string | null, connectionId: string | null }`。`daemon.status` 事件同样带 `daemonId` 与 `connectionId`。`connectionId` 由 hub 在每次接受连接时分配（自增序号或随机串均可），同一 daemon 重连时 `daemonId` 不变而 `connectionId` 变化；没有剩余连接时两者都为 null。
- [ ] 事件发布时机：接受 hello 后发布（新连接成为最新）；连接关闭后若最新连接的 id 变了，发布新的 id 与 connectionId；没有剩余连接时发 `connected: false, daemonId: null, connectionId: null`。只发布与发布时刻连接表一致的值（spec「hub 只发布仍与当前连接状态一致的事件」）：发布前重读连接表，不使用闭包里的旧值。
- [ ] 同步 `packages/shared` 中的事件类型与 web 侧消费的类型（仅加可选字段，旧 web 忽略它）。
- [ ] 先写失败测试（`apps/hub/test/daemonSocket.test.ts` 续写）：首次连接事件带 id 与 connectionId；同一 daemon 直接替换连接时发布新 id（`true → true`），且 connectionId 变化；两个连接中最新者关闭，事件给出较旧者的 id 与 connectionId；全部关闭时两者都为 null；`GET /api/daemon/status` 与事件给出同一个 id 与 connectionId。
- [ ] 验证：`npx vitest run apps/hub/test/daemonSocket.test.ts`；hub 既有套件不回归。

### 任务 5：`GET /api/agent-readiness`（D-4、D-7、D-9）

- [ ] facade 报告应答者：给 `DaemonRpc` 加一个返回 `{ result, daemonId }` 的调用形式（或给 `call` 的目标参数加一个回调，执行时二选一，以对其他调用方零改动为准），取值必须与任务 4 使用同一个「当前连接」函数。
- [ ] 路由（挂在 `componentRoutes` 旁或新 `readiness.ts`，**不进 `HOST_ADMIN_PATH`**，在 `app.ts` 中以注释写明原因）：
  - 透传 `agents.readiness`，查询参数 `force=1` 转为 `{ force: true }`，超时沿用 `COMPONENT_RPC_TIMEOUT_MS`。
  - daemon 离线时按既有 `daemonHttpStatus` 回 503。
  - 回复生成前，若应答连接已不在连接表中，或已不是「当前连接」，也回 503。
  - daemon 回「未知方法」时，回可识别的错误码（建议 `{ error: "readiness_unsupported" }`，状态码执行时与 web 侧约定），web 据此显示 `unknown`。daemon 侧对未注册方法的错误形状，执行时在 `apps/cli/src/daemon/rpc.ts` 核对。
- [ ] `daemon` 字段由 hub 填写：`id` 取应答连接的 `daemonId`，`connectionId` 取应答连接的连接标识；`label` 对注册 daemon 取 `daemons.label`，对本机 daemon 取 `null`。
- [ ] `access` 与裁剪（spec「谁能看到多少」，按 #167 已落地的状态具体化）：
  - 身份为 `usr_local`（本机形态）：`full`。
  - 远程身份，应答连接已注册，且 `ownerUserId === identity.userId`：`full`。
  - 远程身份，应答连接已注册但属于他人：`non_owner`。
  - 远程身份，应答连接未注册（共享 token 的本机 daemon）：`owner_unknown`。
  - 两种裁剪形式都只保留 `access`、`current`、`checkedAt`、`daemon`，以及各行的 `runtime` 与 `state`，删掉 `reason`、`cli`、`account`。裁剪在 hub 端完成，用白名单构造新对象，不用删除字段的写法。
- [ ] 先写失败测试（新 `apps/hub/test/agentReadiness.test.ts`，仿照 `apps/hub/test/components.test.ts`，覆盖 spec「验收口径·自动化测试」第 2 条）：透传与 `force`；离线 503；应答后、回复前连接被替换时回 503；旧 daemon 的未知方法；`daemon` 取自应答连接（两个连接在线时取最新者，`id` 与 `connectionId` 都与该连接一致）；`full`、`owner_unknown`、`non_owner` 三种访问级别及各自的字段集合（裁剪回复中不出现 `account`、`cli`、`reason`）；远程模式下非管理员也能访问此路由（不返回 403）。
- [ ] 验证：`npx vitest run apps/hub/test/agentReadiness.test.ts apps/hub/test/daemonSocket.test.ts apps/hub/test/components.test.ts`；`npm run typecheck`；hub 全套件不回归。

## 阶段三：web 数据层与设置深链（PR-3）

### 任务 6：就绪状态机、刷新时机与持久标记（D-4、D-6、D-8）

- [ ] `apps/web/lib/hub.ts`：新增 `getAgentReadiness(force?: boolean)`；`getDaemonStatus`（或现有等价函数）的类型加上 `daemonId`。
- [ ] 新 `apps/web/lib/agentReadiness.ts`（纯函数，不依赖 React）：
  - `overall(reply | failure, connected)`：返回 `ready | needs_setup | unknown`。离线、503、未知方法与当前运行时 `unknown` 都得 `unknown`。
  - `alternative(reply)`：当前运行时需要设置、另一运行时为 `configured` 时，给出「切换到它」的候选。是否真的提供，由任务 7 按 `access` 决定。
  - 首次就绪标记：键为 hub 源加 `getMe().userId`，存于 `localStorage`，读写都用 try/catch 包住，遵循 `lib/components.ts` 的先例。
  - 临时关闭记忆：只记 `(runtime, state, reason ?? null)`。
- [ ] 新 `apps/web/lib/useAgentReadiness.ts`（hook）：
  - 四个刷新时刻：页面加载；`daemon.status` 从断开变为连接，或 `daemonId` 变化（含 `true → true`）；窗口重新获得焦点；用户点「重新检查」（`force`）。
  - 焦点节流 30 秒，窗口内再获得焦点时在窗口结束补一次检查（trailing），同一窗口只补一次。
  - 另外导出 `recheck()`，供任务 8 在保存与登录成功时调用。
  - 每个连接周期有一个序号。断开或 `daemonId` 变化时清空状态，并让在途请求失效。只接纳当前周期内最新一次请求的结果。成功回复的 `daemon.id` 与 `daemon.connectionId` 必须等于浏览器从状态事件或快照得到的最新值，否则丢弃。浏览器尚未确认任何 `daemonId` 时，所有就绪回复都丢弃，整体状态为 `unknown`。
  - **标记写入条件**：`overall === "ready"`，且在收到该回复**之后**又收到状态事件或快照，其 `daemonId` 与 `connectionId` 都与回复一致。只凭就绪回复本身、或凭回复之前收到的状态，不得写标记。未确认任何 `daemonId` 时不写标记，整体状态为 `unknown`，卡片第 0 步显示连接状态未知（见任务 9）。
  - 不做轮询。
- [ ] 先写失败测试（新 `apps/web/test/agentReadiness.test.ts` 与 `useAgentReadiness.test.tsx`，用假时钟、假 hub）：`overall` 的各分支；trailing 补检只发生一次；断开与直接换连接让旧响应失效；同一连接内旧响应不覆盖新响应；旧连接的 `ready` 不写标记；同一 daemon 重连后，旧连接的 `ready` 回复即使 `daemon.id` 相符也因 `connectionId` 不符而不写标记；标记只在回复之后收到的状态与回复的 daemon 与连接身份都一致时写入；替换后状态事件未到时，在途的旧 daemon `ready` 回复不写标记；未确认任何 `daemonId` 时整体为 `unknown` 且不写标记；标记按 hub 加用户隔离，另一用户不继承；`localStorage` 抛错时不崩溃。
- [ ] 验证：`npx vitest run apps/web/test/agentReadiness.test.ts apps/web/test/useAgentReadiness.test.tsx`。

### 任务 7：下一步动作选择（D-5、D-9、D-10）

- [ ] 在 `apps/web/lib/agentReadiness.ts` 中新增纯函数 `nextSteps(row, { access, localHubMode, settingsAvailable })`，返回结构化动作列表（`settings-link`、`install-link`、`command`、`guide`、`contact-owner`、`switch-runtime`），不直接拼文案。规则照 spec D-5：
  - 先看 `access`。`owner_unknown` 与 `non_owner` 只给「联系管理或拥有该 daemon 的人」与通用 guide，不给命令（含 `nema doctor`）、安装链接、深链或切换。
  - `full` 时，`not_installed` 在所有形态都给官方安装链接（`cli.installUrl`）。桌面形态另附 D-10 的那句提示与 guide 链接。
  - `unknown` 只给检查说明与通用 guide；`cli_broken` 不给安装链接。`configured` 不给任何动作。
  - 桌面形态（`LOCAL_HUB_MODE` 且 `/_nema/settings` 可用）优先给「模型」页深链。
  - 其他形态，合成账户沿用 `routing/messages.ts` 已经指名的命令：SIWC 给 `nema auth login`；BYOK 缺 key 给从标准输入执行的 `nema auth byok`；`needs_model` 给 `nema config set model <名称>`；compat 先 `codex login`，再 `nema auth login`；Claude 给 `claude setup-token` 加 `nema auth claude`。
  - `credential_unusable` 给同一模式下重写那份文件的命令（SIWC 为 `nema auth login`，BYOK 与 Claude 用各自的命令，compat 为 `codex login`）。
  - 存储账户或 `no_enabled_account`：桌面形态指向账户设置，其他形态说明须在运行 daemon 的机器上管理账户并给 guide；`nema doctor` 只作补充诊断，并注明它查不到存储账户。
  - 涉及 `nema` 包的安装或 `npx` 写法一律版本化（取 hub 版本）。
- [ ] 动作文案的 i18n 键进三份 `messages/*.json`，命令文本不翻译。
- [ ] 先写失败测试（续写 `apps/web/test/agentReadiness.test.ts`）：完整回复下 `account` 缺省时的安装与无启用账户两种情况；裁剪回复只给通用说明；桌面与非桌面的分叉；每种合成模式的命令；存储账户的 doctor 限制说明；`cli_broken` 不给安装链接。
- [ ] 验证：同任务 6 的测试命令。

### 任务 8：设置页初始标签与保存后复检（D-2 第 3 点、D-4 第二条）

- [ ] `AppSettings` 增加初始标签参数（如 `initialTab?: SettingsTab`），默认仍为 `"model"`（:235）。打开设置的入口（执行时定位调用方）能传入 `"model"` 或 `"components"`。
- [ ] 复检时刻：
  - 「模型」或账户设置保存成功后调用 `recheck()`。
  - 关闭设置对话框时，若期间有过保存，再调用一次。
  - 桌面 SIWC 登录任务**首次**被观察到进入 `succeeded`（含设置页恢复该任务状态时）时调用一次。
- [ ] 同一次登录只触发一次复检：在 `apps/local/src/settings.ts` 的任务状态响应（`/_nema/auth/status` 的 `jobSnapshot`）中加入任务类型与实例标识，web 按实例标识去重。只增加字段，不改变既有字段的含义。
- [ ] 先写失败测试（续写 `apps/web/test/AppSettings.test.tsx`，以及 `ModelSettings` 的既有测试；local 侧续写 settings 的测试）：`initialTab` 生效；保存后复检一次；有保存时关闭再复检；同一个登录实例的 `succeeded` 被观察两次也只复检一次；`jobSnapshot` 带新字段。
- [ ] 验证：上述测试；`npm run typecheck`；`npm run lint -w apps/web`；`npm run build -w apps/web`。

## 阶段四：落点、文档（PR-4）

### 任务 9：首页空状态清单卡（D-2 第 1 点、D-6、D-8）

- [ ] 新 `AgentReadinessCard.tsx`，放在零工作区时的 `main.empty` 位置（`WorkspaceShell.tsx` 中两处 `main.empty` 的语义执行时核对，只放在「没有任何工作区」的那一处），排在「创建工作区」旁边，不遮挡它。
- [ ] 内容：
  - 第 0 步是「daemon 已连接」，复用现有 `connected`。未连接时运行时行显示「unknown（daemon 未连接）」，并给出启动 daemon 的命令与 guide（D-8）。浏览器尚未确认 daemon 身份时（见任务 6），第 0 步显示「连接状态未知」，不给出就绪结论。
  - 当前运行时一行，写明检查时间与「检查了什么、没检查什么」（「已配置」不等于「已验证」）。
  - 按任务 7 的结果给出下一步，附「重新检查」按钮。
- [ ] 退休：`ready`、已有首次就绪标记或用户点过「不再提示」时，卡片只显示状态，不给建议或操作。创建工作区后卡片消失。
- [ ] 先写失败测试（续写 `apps/web/test/WorkspaceShell.test.tsx` 或新 `AgentReadinessCard.test.tsx`）：三种整体状态与离线下的渲染；`ready` 与「不再提示」后只显示状态；状态退化后仍无建议；创建工作区后消失；「重新检查」发出 `force`；创建工作区按钮在任何状态下都可用。

### 任务 10：工作区内可关横幅（D-2 第 2 点、D-6）

- [ ] 新 `AgentReadinessBanner.tsx`。显示条件：有工作区、整体 `needs_setup`、没有首次就绪标记，且当前 `(runtime, state, reason ?? null)` 未被关闭。`unknown` 或离线时不显示。
- [ ] 一行文字，链接到设置页对应标签（任务 8）。关闭按钮只记当前三元组；三元组任一项变化后，若仍满足条件，再显示一次。
- [ ] 测试：`needs_setup` 时显示；`unknown`、离线、`ready` 时不显示；关闭后同一三元组不再显示；无原因码的状态变化后重新显示；`ready` 后自动消失并写入标记（标记写入条件沿用任务 6，此处再钉一条集成用例）。

### 任务 11：Composer 就地提示（D-2 补充段）

- [ ] 显示条件，三者同时满足：整体 `needs_setup`；这条消息会走默认分支（按消息、thread、工作区的优先级都未指定路由，绑定来自 `useAccounts().bindings`）；没有首次就绪标记。
- [ ] 不显示：消息选择了命名账户或「自动」（`routing: "auto"`）；生效绑定指定了账户或 `auto`（含自动路由开关关闭时）。`useAccounts().supported === false` 且消息未指定路由时，可以显示条件式文案。
- [ ] 文案用条件句，不预言结局（例如「默认账户尚未配置；用它运行的 agent 任务会失败，讨论本身照常保存」）。发送不被阻止。
- [ ] 测试（续写 `apps/web/test/Composer.test.tsx`）：默认分支下显示；显式自动、thread 与工作区的自动绑定、命名选择、已知命名绑定都不显示（含自动路由关闭时）；`supported: false` 时显示条件式文案；发送按钮在任何状态下都可用；有标记后不显示。
- [ ] 任务 9-11 合并验证：`npx vitest run apps/web/test`；`npm run lint -w apps/web`；`npm run build -w apps/web`；三份 `messages/*.json` 的键集合一致（沿用 web 测试中既有的消息键一致性检查，没有则人工 diff）。

### 任务 12：changelog 与文档

- [ ] `changelog.d/302-first-run-agent-guidance.added.md`（每行以 `- ` 开头）：写明新增就绪引导的位置，以及「已配置」只表示命令与本机凭据文件存在且格式可用，不表示令牌有效或任务会成功。
- [ ] 四份 README（`README.md` 与 `README.en.md` 保持字节一致）与 `docs/guide.{en,zh,ja}.md` 的首次运行段落各补一句：引导出现在哪里；「已配置 ≠ 已验证」；远程形态下操作须在运行 daemon 的机器上进行。命令写法版本化。
- [ ] 验证：`node scripts/ci/docs-check.mjs <含改动路径的 JSON 数组文件>` 退出 0；`diff README.md README.en.md` 无输出；三语段落人工对照，锚点有效。

## 收尾（PR-5）

### 任务 13：VM 内 Compose 真实环境验收与记录

- [ ] 按 2026-11-16 测试政策，在 VM 内走 Compose 路线：PostgreSQL、hub 与 web 跑在容器中，daemon 用仓库构建的 CLI 在宿主机启动，`~/.nema` 用临时目录，PATH 上没有 `claude`。
- [ ] 剧本逐项走并记录：
  1. daemon 未启动时：卡片第 0 步显示未连接，无横幅。
  2. 启动 daemon 后，卡片显示 `codex-direct` 为 `not_signed_in`，给出 `nema auth login` 的版本化命令。
  3. 切到 Claude 运行时：显示「PATH 上找不到 `claude`」与安装链接，不出现「未安装」字样。
  4. 切回 `codex-direct` 运行时（第 3 步切到了 Claude；`nema auth login` 登录的是 Codex，不会使当前 Claude 运行时变为已配置），执行 `nema auth login`，再切回窗口：焦点复检，卡片转为「已配置」，引导退出。
  5. 删除凭据后：横幅与 Composer 提示不再出现（永久退休），设置页仍如实显示状态。
- [ ] 第 4 步需要真实 SIWC 登录。若 VM 内无法完成真实登录，只验证到第 3 步，并在记录中写明此限制，不用自动化测试结果替代。不发起任何真实模型请求，不运行 `auth probe`。
- [ ] 在 #302 贴验收记录，三类证据分开写，并注明桌面实机未测是政策决定。验收通过后关闭 #302；ROADMAP 中对应条目（若有）按证据更新状态。

## 待确认（不阻塞开工）

以下是 spec 写于 #167 落地之前，与 `e784ee4` 现状对照后发现的出入。本计划按括号中的落法执行。维护者如另有裁决，只需改动对应任务。

1. **多 daemon 已经上线**：spec D-9 写「本项按单 daemon 实现」，并把「任一合格 daemon ready」的聚合留到 #167 二期或后续。#167 现已支持多连接，但本计划仍只报告不带目标的调用会落到的那一台（最新连接）。在多人远程部署中，这一台可能不是有权为某个工作区派发任务的 daemon。（任务 4、5 按「最新连接」实现；按工作区聚合另开 issue。）
2. **非管理员拿不到 daemon 状态快照**：`GET /api/daemon/status` 位于 `HOST_ADMIN_PATH` 下。远程形态的非管理员只能通过 `daemon.status` 事件拿到 `daemonId`，在两次事件之间打开页面时可能一直没有确认的 id，因此不会写首次就绪标记。对非主人来说这无害，因为他们本来只拿到裁剪回复；但 daemon 主人如果不是 hub 管理员，同样受影响。（本计划不改主机级路由的门；可选做法是在就绪路由的回复之外，再为所有已登录用户开放一个只含 `{ connected, daemonId }` 的状态读取，需要维护者确认。**在裁决之前**：未确认 id 时按任务 6 的规则处理——就绪回复直接丢弃、整体状态为 `unknown`、不写标记、卡片第 0 步显示连接状态未知；无已确认 id 的就绪回复在任何情况下都不作为写标记的依据。若裁决开放快照，快照须同时带 `daemonId` 与 `connectionId`，其确认效力与状态事件相同。）
3. **`owner_unknown` 的触发条件**：spec 以「#167 D-5 落地之前或之后」区分。D-5 落地后，远程形态里仍可能有未注册的共享 token 本机 daemon。（任务 5 对这种连接回 `owner_unknown`。）
4. **缺少 `accounts.json` 时另一运行时的判定**：spec 写「只为当前运行时合成账户，不用旧路径凭据预演切换」，但状态表要求两行都给出状态。另一行是记 `not_signed_in`（`no_enabled_account`），还是沿用 `loadRoutingAccounts` 实际合成的结果，原文没有说清。（任务 3 以 `loadRoutingAccounts` 的实际返回为准，并用测试钉住，执行时在 PR 描述中写明。）

## 执行证据

（实现阶段填写：每个任务的命令与结果、未验证项与环境限制。未执行前留空，不预先声称任何结果。）
