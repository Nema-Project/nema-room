# 远程 hub 与多人协作（#167）实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were assigned says so.

**目标**：按已定案 spec 把 Nema Room 从「单人、单 daemon、hub 只绑回环」推进到 v0.3.3 的远程形态：真人账号（引导/邀请/登录/会话）、内容 API 成员资格校验、daemon 注册表与每机凭据、多 daemon 连接与最小路由、Host 允许清单放开——且默认配置下单机形态行为与今天逐字节一致。

**规格**：[2026-11-24 远程 hub 与多人设计](../specs/2026-11-24-remote-hub-multiuser-design.md)，D-1～D-10 已于 2026-11-24 由维护者全部按推荐定案。Issue：[#167](https://github.com/Nema-Project/nema-room/issues/167)。ROADMAP：P2-12（v0.3.3）。

**已核对的现状**（对照 `main` `b91946e`，逐条定位见 2026-11-24 grounding 笔记）：`apps/hub/src/daemonSocket.ts:73` 只有单个 `current` 连接，第二个 hello（:410-431）替换旧连接并 `interruptRunning` 打断其任务（任务有回队重试，上限 3 次，`apps/hub/src/tasks.ts:148/158`）；`daemonId` 连接时现铸（:413）。`apps/hub/src/identity.ts` 的 `localIdentity` 恒返回 `usr_local`，`IdentityProvider` 注入缝在 `apps/hub/src/app.ts:36/99`（deps.identity，缺省 localIdentity）；生产代码无创建用户的路径，迁移止于 `022_identity.sql`（新迁移自 023 顺延）。`requireMember`（`apps/hub/src/members.ts:28`）只被 `memberRoutes.ts:26/30` 调用；内容路由挂载面在 `app.ts:110-125`：`uiRoutes`、`attachmentRoutes`、`mentionContextRoutes`、`componentRoutes`、`shareAdminRoutes`（均挂 `/api`），`/room/*` 与 `/report` 是任务作用域 token 通道。`hostGuard`（`app.ts:54-55`）只认回环 Host。daemon 全体共用 `apps/hub/src/main.ts:22` 的单文件 token，hello 明文比较在 `daemonSocket.ts:391`，版本全等校验在 :396-397（文案 `apps/hub/src/hubVersion.ts` 的 `versionSkewMessage`）。`claimNextTask`（`tasks.ts:87`）只挑最老 queued，`daemon_id` 只写不选；`workspace_repos.git_common_dir` 是本机路径指纹唯一键（迁移 005），无 daemon 归属列，`remote_url` 已存但不是键。daemon↔hub 协议类型在 `packages/shared/src/protocol.ts`。仓库当前**没有任何密码哈希库**（argon2/scrypt/bcrypt 均无依赖）。

## 全局约束

- **阶段顺序是硬约束（spec 定案，不可调换）**：阶段一政策 → 阶段二身份与校验 → 阶段三多路化 → 阶段四放开暴露。前一阶段未验收，后一阶段不开工；尤其 hostGuard 与绑定放开（任务 13）必须最后，任何提前放开暴露的改动按违规处理。
- **默认行为逐字节不变（D-10）**：不开启远程形态时，身份、绑定、Host 守卫、daemon 校验与今天完全一致。每个触及既有路径的任务都要有「远程关 / 单机形态」回归用例钉住这一点；桌面形态（`apps/local` 的 gateway 身份与内嵌 hub）不接远程 provider、不传远程配置。
- **hub 只存哈希**：密码（argon2id，D-3）、会话 token、daemon 凭据、邀请码、注册码在 hub 侧一律只存哈希。高熵随机凭据（会话/daemon/邀请/注册码）沿用 `apps/hub/src/shares.ts:76` 的 sha256 先例；只有低熵的人类密码走 argon2id。
- **凭据不出 daemon 本机**：任务与 hub 只新增「哪个用户、哪台 daemon」的归属，不传任何模型凭据；路由选不到账号时沿用今天的失败路径。
- **成员校验与真实身份同批上线**：任务 8 不得早于任务 4/5 合入同一发布面；只上身份不上校验、或只上校验不上身份，都按未完成计。
- **事件落点不复用 `member_events`**：其 `kind` 在迁移 022:27 有 check 约束（仅四种成员事件）；账号/邀请/登录事件进新表 `auth_events`、daemon 事件进新表 `daemon_events`（任务 2 建），不改 #163 既有审计语义。成员变更仍走 `member_events`。
- **迁移只增不改**：新迁移自 023 起按文件名顺序顺延；已发布的 001-022 一字不动。新迁移必须在 PGlite 与真实 PostgreSQL 两驱动上各跑一遍（`apps/hub/test/migrations.test.ts`、`persistentDb.test.ts` 的既有双驱动口径）。
- **验收三类分开记录**：静态检查（typecheck / web lint+build）、自动化测试、真实环境（VM 内 Compose，任务 15）互不替代；桌面实机不主动测（2026-11-16 测试政策）。UI 文案改动必须同步 `apps/web/messages/{en,zh,ja}.json` 三语（仓库 AGENTS.md）。

## 文件与职责（预计）

- `SECURITY.md`：任务 1 修订报告范围（第 19 行）、第 31 行、第 47 行口径，新增远程形态威胁模型小节。
- `apps/hub/src/db/migrations/023_user_credentials_sessions.sql`、`024_invites_auth_events.sql`、`025_daemons.sql`：任务 2 新建（凭据/会话、邀请/账号事件、daemon 注册表/注册码/daemon 事件）。
- `apps/hub/src/db/snapshot.ts`：任务 2 定新表快照口径（`TABLE_COLUMNS`/`TABLE_ORDER`/`OPTIONAL_TABLES`/`IDENTITY_TABLES` 在 :49-51）。
- `apps/hub/src/passwords.ts`（新）：任务 3 的 argon2id 哈希/校验模块与参数常量。
- `apps/hub/src/auth.ts`（新）+ `apps/hub/src/authRoutes.ts`（新）：任务 4-6 的会话、引导、邀请、登录/登出、限速的逻辑与路由；`apps/hub/src/identity.ts` 加会话型 provider，`localIdentity` 不动。
- `apps/hub/src/app.ts`：任务 4 起挂 auth 路由（置于 `/api/*` 身份中间件之前，照 `/share` 先例，但仍过 hostGuard）；任务 13 改 `hostGuard` 为清单制。
- `apps/hub/src/main.ts`、`apps/hub/src/lifecycle.ts`：远程开关与配置的 env 解析（建议名 `NEMA_HUB_REMOTE`、`NEMA_HUB_ALLOWED_HOSTS`，见任务 4/13）与 deps 透传；引导令牌生成在 `main.ts`。
- `apps/web/app/login/page.tsx`（新）、`apps/web/components/AppSettings.tsx`、`apps/web/messages/*.json`：任务 7 登录页与登录态入口。
- `apps/hub/src/uiApi.ts`、`attachmentRoutes.ts`、`mentionContextRoutes.ts`、`components.ts`、`shareAdmin.ts`：任务 8 逐路由前置成员校验；校验 helper 收敛在 `apps/hub/src/members.ts` 旁（或新 `authz.ts`，任务内定）。
- `apps/hub/src/daemons.ts`（新）：任务 9 注册码/注册表/吊销逻辑；`apps/web/components/DaemonsSettings.tsx`（新，参照 `ComponentsSettings.tsx` 先例）为设置页 daemon 面板；`apps/cli/src/daemon/register.ts`（新）+ `apps/cli/src/index.ts` 的 `daemon` 命令组改造。
- `apps/hub/src/daemonSocket.ts`：任务 9 改 hello 凭据校验（远程形态查注册表）；任务 10 把 `current` 单例改连接表；任务 11 接路由资格；任务 12 改版本校验。
- `apps/hub/src/tasks.ts`：任务 11 给 `claimNextTask` 加资格谓词与等待原因推导（`toUiTask` 增 `waitingReason`）。
- `packages/shared/src/protocol.ts`：任务 11 给 hello 增 `heldRepos` 上报字段；remote_url 规范化函数放 `packages/shared`（hub 与 CLI 共用一份，先核对 `apps/hub/src/repos.ts:61` 的 `githubTarget` 是否可复用/下沉）。
- `apps/hub/src/hubVersion.ts`：任务 12 加最低兼容版本常量与比较函数。
- 四份 README、`docs/guide.{en,zh,ja}.md`、`docker-compose.yml` / `.env.example`、`changelog.d/remote-hub-multiuser.added.md`：任务 14。

## PR 切分建议

每 PR 承载 1-3 个相邻任务，按阶段顺序合入；阶段之间不跨越（阶段二的 PR 全部合入并验收后才开阶段三）。

- PR-1：任务 1（政策，纯文档，独立先行）。
- PR-2：任务 2 + 任务 3（迁移与凭据地基：表结构 + 哈希模块，无行为变化）。
- PR-3：任务 4（远程 provider + 引导通道）。
- PR-4：任务 5 + 任务 6（邀请/登录/会话管理 + 限速锁定，同属 auth 模块）。
- PR-5：任务 7（web 登录页，依赖 PR-4 的 API 形状）。
- PR-6：任务 8（成员校验全面铺开，单独成 PR——回归面最大，不与任何其他改动混合）。
- PR-7：任务 9（daemon 注册：hub + web 面板 + CLI，三面同 PR 以免协议两端错位）。
- PR-8：任务 10（连接表，单独成 PR——daemonSocket 结构改造）。
- PR-9：任务 11 + 任务 12（路由资格 + 版本策略，同在 daemonSocket/tasks 面）。
- PR-10：任务 13 + 任务 14（放开暴露 + 部署文档，必须在阶段二、三全部合入之后）。
- PR-11：任务 15 + 任务 16（验收记录与 ROADMAP 收口，记录型）。

## 阶段一（政策）

### 任务 1：SECURITY.md 修订

- [ ] 改报告范围（第 15 行起，第 19 行条目）：「在回环地址之外可被访问」从一律属于报告事项，改为「未开启远程形态时在回环之外可达、或开启远程形态但未启用真实认证 / Host 清单时可达」属于报告事项；开启远程形态且认证与清单齐备的部署不再落在报告范围内。
- [ ] 改第 31 行：把「暴露到公网不属于支持的用法」细化为两句口径——默认形态仍只监听回环；远程形态仅在受信网络（局域网 / 自备 VPN 组网）内、且完成引导与认证时受支持，hub 直面公网仍不支持（D-2）。
- [ ] 改第 47 行（分享节）：区分「hub 不对局域网或公网发布」（默认形态）与远程形态的受控发布，分享页的内网来源口径本身不变。
- [ ] 新增「远程形态」小节写威胁模型：受信网络前提、链路明文的风险与部署通道加密的责任划分（D-8）、登录爆破面与限速/锁定对策、daemon 凭据与会话 token 只存哈希、凭据泄露的处置路径是吊销（会话/daemon 各自的吊销入口）。
- [ ] 验证：`node scripts/ci/docs-check.mjs` 对改动路径通过（CI docs job 同口径）；人工逐行核对三处旧口径已改且与新小节不矛盾；本任务不改任何代码与绑定行为，`git diff` 只含 `SECURITY.md`。

## 阶段二（身份与校验，hub 仍只绑回环）

### 任务 2：新迁移（凭据/会话、邀请、daemon 注册表）与快照口径

- [ ] 写 `023_user_credentials_sessions.sql`：`user_credentials`（`user_id` 主键外键 `users`、`password_hash`、`created_at`、`updated_at`）；`sessions`（`id` 主键、`user_id` 外键、`token_hash` 唯一、`created_at`、`expires_at`、`revoked_at`）。
- [ ] 写 `024_invites_auth_events.sql`：`invites`（`id` 主键、`code_hash` 唯一、`created_by` 外键 `users`、`intended_workspace_id` 可空外键 `workspaces`、`expires_at`、`used_at`、`used_by_user_id` 可空、`created_at`）；`auth_events`（`id` 主键、`user_id` 可空、`kind` check 取值 `account_created | invite_created | invite_used | login_locked | sessions_revoked | bootstrap_completed`、`actor_user_id` 可空、`detail` jsonb、`created_at`）。
- [ ] 写 `025_daemons.sql`：`daemons`（`id` 主键——稳定 ID 替代现铸 `daemonId`、`owner_user_id` 外键 `users`、`label`、`credential_hash` 唯一、只存哈希、`created_at`、`last_seen_at`、`revoked_at`）；`daemon_registration_codes`（`id`、`code_hash` 唯一、`owner_user_id`、`expires_at`、`used_at`、`used_by_daemon_id` 可空、`created_at`）；`daemon_events`（`id`、`daemon_id` 可空、`owner_user_id`、`kind` check 取值 `registered | revoked | rejected`、`actor_user_id` 可空、`detail` jsonb、`created_at`）。
- [ ] `apps/hub/test/migrations.test.ts` 登记新迁移并通过其双驱动用例（PGlite 与真实 PostgreSQL 各跑一遍迁移全集）；`persistentDb.test.ts`、`upgradeRecovery.test.ts` 不回归（存量库升到 025 后 `usr_local` 与既有数据不变）。
- [ ] 快照口径（`apps/hub/src/db/snapshot.ts`）：定并写测试——`sessions`、`invites`、`daemon_registration_codes` **不入快照**（短时凭据，导入后重新登录/重新邀请/重新注册）；`user_credentials`、`daemons`、`daemon_events`、`auth_events` 入快照且只带哈希列（与今天 `users` 入快照的备份语义一致），在 `TABLE_COLUMNS`/`TABLE_ORDER` 中登记、按需进 `OPTIONAL_TABLES` 以兼容旧快照导入；快照往返测试（`persistentDb.test.ts` 或快照专项套件）钉住上述取舍。
- [ ] 验证：根 `npm run typecheck` 通过；hub 迁移相关套件全绿；本任务不改任何运行时行为，既有 hub 全套件不回归。

### 任务 3：argon2id 选型与密码哈希模块

- [ ] 选型验证（spike）：仓库现无任何密码哈希依赖，D-3 只定了 argon2id 算法、未定实现库。依次验证候选（`argon2` 原生、`@node-rs/argon2` 预编译、`hash-wasm` 纯 wasm）在 hub 三种运行环境的可加载性：Compose 镜像（`Dockerfile` 的 node:trixie 构建）、npm 全局安装的 CLI 捆绑 hub、桌面内嵌（`apps/local` 在 Electron Node 下加载 hub 构建产物）；各跑一次 hash/verify 冒烟并把结果记进本任务 PR 描述。
- [ ] 若三候选无一在三环境皆可行：停工，在本计划执行证据与 #167 各记一条并回报维护者——这触及 D-3 定案（改算法或接受某环境的打包代价都需维护者决定），不自行回退到 scrypt/自研哈希。
- [ ] 实现 `apps/hub/src/passwords.ts`：`hashPassword` / `verifyPassword`，argon2id 参数（内存/迭代/并行度按 OWASP 口径在本任务内定为代码常量，校验时从哈希串自带参数解析，留参数升级余地）；依赖加在 `apps/hub/package.json`（或实际承载 hub 构建的包，执行时以构建路径为准）。
- [ ] 先写失败测试再实现（新 `apps/hub/test/passwords.test.ts`）：正确密码 verify 通过、错误密码拒绝、同一密码两次哈希不同（带盐）、参数常量被断言引用、空/超长输入的拒绝口径明确。
- [ ] 验证：`npx vitest run apps/hub/test/passwords.test.ts` 全绿；hub 构建（`npm run build -w apps/hub` 或仓库当时的等价命令）成功且产物能在本机 Node 直接 import 哈希模块。

### 任务 4：远程 IdentityProvider 与引导通道

- [ ] 配置面（spec 未命名，本计划定名并随任务 14 进文档）：环境变量 `NEMA_HUB_REMOTE=1` 开启远程形态，仅对独立 hub 装配（`apps/hub/src/main.ts` → `lifecycle.ts` 的 `startHub` deps）生效；桌面 `apps/local` 装配不传此开关。`AppDeps` 增 `remoteAuth?: boolean`（缺省关）。
- [ ] `apps/hub/src/auth.ts`（新）：会话的签发/解析/吊销原语（token 只存哈希、过期判断），引导状态判定（库中无任何 `user_credentials` 行 = 未引导）。
- [ ] `apps/hub/src/identity.ts`：新增会话型 provider（从 cookie 读会话 token → 查 `sessions` → 得真实 `userId`；无/过期/已吊销一律返回 null 使 `app.ts:99` 回 401）；该 provider 永不返回 `usr_local`（D-10）。`localIdentity` 与 gateway 身份一字不动。
- [ ] 引导通道：远程开启且未引导时，`main.ts` 生成一次性引导令牌，打印到 hub 控制台并写入 `<dataDir>/bootstrap-token`（0600，与 daemon token 同级）；引导端点（挂 `authRoutes`，置于 `/api/*` 身份中间件之前、hostGuard 之后，照 `/share` 装配先例）凭令牌创建第一个账号（写 `users` + `user_credentials`，记 `auth_events.bootstrap_completed`），成功即删令牌文件且通道永久关闭（以「已有凭据行」为准，重启不复活）。
- [ ] 装配：`app.ts` 仅在 `deps.remoteAuth` 为真时挂 `authRoutes` 与会话 provider；为假时路由不存在、行为与今天一致。登录 cookie 的签发在任务 5，本任务先打通「引导建号 → 直接签发首个会话」使引导闭环可测。
- [ ] 先写失败测试（新 `apps/hub/test/auth.test.ts`，参照 `identity.test.ts` 布局）：引导令牌建首账号成功且随后引导端点拒绝一切请求；无会话/伪造会话/过期会话访问 `/api/*` 得 401；有效会话解析出真实 userId；远程 provider 下任何路径不产生 `usr_local`；`remoteAuth` 关时 auth 路由 404 且 `localIdentity` 行为不变。
- [ ] 验证：`npx vitest run apps/hub/test/auth.test.ts apps/hub/test/identity.test.ts` 全绿；根 `npm run typecheck` 通过。

### 任务 5：邀请建号、登录/登出与会话管理

- [ ] 邀请（`auth.ts` + `authRoutes.ts`）：登录态的管理员/工作区 owner 生成邀请（明文码只在生成响应出现一次，hub 存 `code_hash`；带过期；可预带 `intended_workspace_id`）；记 `auth_events.invite_created`。
- [ ] 邀请建号端点（未登录可达，同引导的装配位置）：凭有效邀请设显示名 + 密码 → 建 `users` + `user_credentials`、标记邀请已用（`used_at`/`used_by_user_id`）、记 `invite_used` 与 `account_created`、直接签发会话。过期/已用/不存在的邀请一律拒绝且口径一致（不区分以免枚举）。
- [ ] 邀请状态查询（登录态，限邀请创建者与目标工作区 owner）：列出自己发出的邀请及其状态（含 `used_by_user_id` 与预带工作区），供 owner 在建号完成后走既有 `addMember` 一键确认加入——成员语义仍只经 `members.ts` 的 `addMember` 与 `member_events`，本任务不新开任何加成员后门（spec 定案流程）。
- [ ] 登录/登出：`POST /api/auth/login`（密码校验走 `passwords.ts`；成功签发会话并 set-cookie：httpOnly、SameSite=Lax、Secure 属性按形态参数化——远程形态恒 Secure，本任务先落参数、任务 13 收口核对）；`POST /api/auth/logout` 吊销当前会话；管理员端点吊销指定用户全部会话（记 `sessions_revoked`）。`usr_local` 无凭据行，天然不可登录，另以测试钉住。
- [ ] 凭据重置的最小口径（spec 未覆盖，本计划补记并在此落地最小版）：不做自助找回；管理员可对指定用户触发「重置凭据」——吊销其全部会话 + 生成一次性重置码（复用邀请码的哈希/过期机制，接受端点只设新密码不建号）。若维护者认为一期不需要，在定案复核时删本条并把缺口留到二期登记。
- [ ] 测试（`apps/hub/test/auth.test.ts` 续写，对应 spec 验收 ④⑤）：邀请全流程 生成 → 建号 → `addMember` 成功；过期邀请被拒；同一邀请二次使用被拒；错误密码 401 且不签发会话；登出后旧会话 401；管理员吊销某用户全部会话后其会话全灭、他人不受影响；引导通道在首账号后关闭（与任务 4 用例不重复的一侧）。
- [ ] 验证：`npx vitest run apps/hub/test/auth.test.ts apps/hub/test/members.test.ts` 全绿；根 `npm run typecheck` 通过。

### 任务 6：登录限速与失败锁定

- [ ] `apps/hub/src/loginThrottle.ts`（新）：进程内计数（一期 hub 单进程，spec 拓扑已声明），按账号与来源各一份；可注入时钟以便测试。阈值/窗口/锁定时长定为代码常量（在本任务内定值并写进测试断言，如连续失败 N 次锁定 M 分钟）。
- [ ] 接入登录端点：锁定期间即使密码正确也拒绝（口径与普通失败区分但不泄露账号存在性）；成功登录清零该账号计数；触发锁定时记 `auth_events.login_locked`。
- [ ] 先写失败测试（新 `apps/hub/test/loginThrottle.test.ts` + `auth.test.ts` 集成一条）：未达阈值可继续尝试、达阈值锁定、窗口过期后恢复、成功登录清零、锁定中正确密码被拒、A 账号的失败不影响 B 账号。
- [ ] 验证：`npx vitest run apps/hub/test/loginThrottle.test.ts apps/hub/test/auth.test.ts` 全绿。

### 任务 7：web 登录页与登录态接入

- [ ] 先核对 web 侧现状：web 如何调 hub API（本地经 gateway、远程直连 hub 源）、`apps/web/app/(room)` 路由组与 `layout.tsx` 的会话假设、既有 `GET /api/me`（`memberRoutes` 内）的返回形状——登录态判定一律以 `/api/me` 的 401 为准，不新造探针。
- [ ] CORS 前置改动（hub 侧）：远程拓扑下 web 与 hub 不同源，会话 cookie 需要 `app.ts` 的 `cors()` 开 `credentials: true` 且 `webOrigins` 命中部署源（`NEMA_WEB_ORIGIN` 已有配置面，main.ts:68）；本地形态下此改动不改变既有行为，以 hub 既有 CORS 相关测试不回归为准。
- [ ] 新 `apps/web/app/login/page.tsx`：账号/密码表单 → `POST /api/auth/login`（带 credentials）→ 成功跳 `/`；失败显示统一错误文案（不区分账号不存在/密码错）；已登录访问 `/login` 直接跳 `/`。
- [ ] 401 驱动跳转：web 的 API 层在收到 401 且当前不在 `/login` 时跳登录页（仅对会话型 401；本地形态永不产生此 401，行为不变——以既有 web 测试不回归 + 新用例钉住）。
- [ ] 登录态入口：`apps/web/components/AppSettings.tsx`（或顶栏既有用户区，执行时以现状为准）显示当前用户显示名与登出按钮，仅在 `/api/me` 返回真人身份时出现；`usr_local` 时不渲染（单机无感，D-10）。
- [ ] 文案三语：登录页与登录态入口的全部新字符串进 `apps/web/messages/{en,zh,ja}.json`。
- [ ] 测试（新 `apps/web/test/login.test.tsx`，参照 `apps/web/test/ComponentsSettings.test.tsx` 先例）：表单渲染、提交成功跳转、401 显示错误、`/api/me` 为真人时设置区出现登出、为 `usr_local` 时不出现。
- [ ] 验证（仓库 AGENTS.md 对 web 改动的硬要求）：`npm run lint -w apps/web`、`npm run build -w apps/web` 通过；web 既有测试全绿。

### 任务 8：内容 API 全面 requireMember（含单机短路）

- [ ] 路由清单逐条核对（`app.ts:110-125` 的挂载面）：`uiRoutes`（话题/消息/条目/工作区设置）、`attachmentRoutes`、`mentionContextRoutes`、`componentRoutes` 中带 workspaceId 的操作、`shareAdminRoutes`（分享管理）——逐路由标出其 workspaceId 来源（path 参数 / body / 经资源反查）与所需级别（member / owner-only 的管理类操作）。`/room/*` run token 与 `/report` report token 通道不在本任务范围（spec 明示），一行不动。
- [ ] 收敛校验 helper：在 `members.ts` 旁（或新 `apps/hub/src/authz.ts`）提供按 (db, identity, workspaceId, owner?) 的单一入口，内部调用既有 `requireMember` 判定；**短路规则只写在这一个入口里**：`identity.userId === LOCAL_USER_ID` 时直接放行（单机形态与今天逐字节一致）。各路由只调 helper，不各自写短路判断。
- [ ] 逐路由前置校验：读类 member、管理类（工作区设置、分享管理、components 的工作区级操作）owner；校验必须在读写真值之前。无法从请求直接得 workspaceId 的路由（按资源 ID 访问的）先反查所属工作区再校验，口径与该路由既有的归属校验（如 uiApi 中 thread/message 的 workspaceId 比对）合并，不留双份逻辑。
- [ ] 先写失败测试（新 `apps/hub/test/contentAuthz.test.ts`，对应 spec 验收 ③⑥）：按路由家族各取代表——话题列表读、发消息写、工作区改名（owner 类）、components 工作区操作、分享创建——非成员读/写均 403、已移除成员 403、普通成员读/写通过但 owner 类操作 403、owner 全通；同一组用例以 `usr_local` 身份重跑应全部放行（单机短路）。
- [ ] 回归：hub 全套件全绿是本任务的硬门（既有测试大量以 `usr_local` 跑，短路失效会大面积变红，正好当探针）；根 `npm run typecheck` 与 `npm run typecheck -w apps/cli` 通过。
- [ ] 验证：`npx vitest run apps/hub/test/contentAuthz.test.ts apps/hub/test/members.test.ts` 全绿 + hub 全套件全绿，两个结果分开记录。

### 任务 9：daemon 注册流程（设置页注册码 + CLI 注册 + hello 查注册表）

- [ ] hub 逻辑（新 `apps/hub/src/daemons.ts`）：注册码生成（登录态、限本人、一次性、短时过期、只存哈希）、注册端点核销（凭码 + label → 建 `daemons` 行、签发长期凭据明文只回这一次、记 `daemon_events.registered`）、名下 daemon 列表、吊销（置 `revoked_at`、记 `revoked`；若该 daemon 当前在线，在本阶段的单例模型下断开其连接，其任务走既有回队）。
- [ ] 路由：`POST /api/daemons/registration-codes`、`GET /api/daemons`、`POST /api/daemons/:id/revoke` 走登录态（挂 `/api` 身份中间件之后）；`POST /api/daemons/register` 未登录可达（凭码即凭据），与 auth 路由同批装配、仍过 hostGuard。吊销权限：只能吊销自己名下的 daemon（管理员可吊销任意，在本任务内定并钉测试）。
- [ ] hello 校验（`daemonSocket.ts:391` 一带）：远程形态下 `m.token` 按注册凭据查 `daemons.credential_hash`——查无或 `revoked_at` 非空 → 回可读原因、记 `daemon_events.rejected`、关连接；通过 → `conn.daemonId` 用注册表稳定 ID（替代 :413 现铸）、更新 `last_seen_at`。非远程形态（单机/Compose）继续共享文件 token 路径，一行口径不变；远程形态下共享 token 必须被拒（测试钉住）。
- [ ] 设置页面板（新 `apps/web/components/DaemonsSettings.tsx`，参照 `ComponentsSettings.tsx` 的结构与测试先例）：生成注册码（明文只显示一次、带过期提示）、名下 daemon 列表（label、最近在线、状态）、吊销按钮（二次确认）；文案三语。
- [ ] CLI 注册（新 `apps/cli/src/daemon/register.ts`）：`nema daemon register --hub <url>`——输入注册码（参数或交互输入，执行时以 CLI 既有交互口径为准）→ 调 hub 注册端点 → 凭据写入本机 `~/.nema/daemon-credential`（0600，与 token 文件同级保护）。`apps/cli/src/index.ts` 的 `daemon` 改为命令组：无子命令时行为与今天 `nema daemon` 完全一致（默认 action），`register` 为子命令；`startDaemon`（`apps/cli/src/daemon/setup.ts`/`connection.ts`）在本机存在注册凭据时 hello 以其作 token 字段，远程注册凭据优先于共享 token 文件。
- [ ] 测试：hub 侧（`daemonSocket.test.ts` 续写 + 新 `apps/hub/test/daemons.test.ts`）——注册凭据 hello 成功且 daemonId 稳定（重连不变）、吊销后 hello 被拒且原因可读、远程形态共享 token 被拒、本机形态共享 token 不回归、注册码过期/复用被拒、吊销他人 daemon 被拒；CLI 侧（新 `apps/cli/test/daemon/register.test.ts` 或执行时以 CLI 测试布局为准）——注册成功落盘 0600、坏码报错不落盘、`nema daemon` 默认行为不变；web 侧面板测试（生成码只显示一次、列表渲染、吊销调用）。
- [ ] 验证：`npx vitest run apps/hub/test/daemons.test.ts apps/hub/test/daemonSocket.test.ts`、CLI 相关套件、web 面板测试全绿；根 `npm run typecheck` 与 `npm run typecheck -w apps/cli` 通过。

## 阶段三（多路化）

### 任务 10：daemonSocket 连接表改造

- [ ] 连接表：`daemonSocket.ts:73` 的 `current` 单例改为按 daemonId 的连接表（Map），`connections` 集合与之合并为一份真相；hello 不再关闭任何既有连接、不再对他人任务调 `interruptRunning`——`:410-431` 的顶替逻辑整段删除。
- [ ] 断开语义：某连接关闭只收尾它自己——其名下 running 任务经既有 `requeueDaemonTasks`（`tasks.ts:148`，上限 3 次不变）回队并公告；其他 daemon 的连接与任务零影响。
- [ ] facade 选连接：盘点 `deps.daemon`（`daemonRpc.ts` 的 `DaemonRpc` 门面）的全部调用点（dispatch、`/workspace.deleted` 通知 :495、`repos.sync` :497、components 与 repos 的 UI 发起 RPC），逐个定目标连接选择规则并写进代码注释：与具体工作区相关的 RPC 优先该工作区绑定所有者的 daemon；无从判定时的回退规则（单连接时即它本身——单机行为与今天一致）。规则保持最小可解释，不引入负载/评分。
- [ ] 状态面：`isConnected`（:532）与 daemonStatus 改为按连接表回答（任一在线 / 按 daemonId 查），UI 侧消费口径不变形（执行时核对 web 的 daemon 状态展示）。
- [ ] 先写失败测试（`apps/hub/test/daemonSocket.test.ts` + `daemonRpc.test.ts` 续写，对应 spec 验收 ①②）：双 daemon 同连共存；乙 hello 后甲的在跑任务不被打断、不回队；甲断开只回队甲的任务、乙的任务继续；吊销联动（任务 9 的吊销在连接表下断开目标连接）在本任务复测一遍；单 daemon 场景既有全部用例不改口径全绿。
- [ ] 验证：`npx vitest run apps/hub/test/daemonSocket.test.ts apps/hub/test/daemonRpc.test.ts` 全绿；hub 全套件全绿。

### 任务 11：D-6 最小路由与持有上报协议

- [ ] 持有上报协议：`packages/shared/src/protocol.ts` 的 hello 消息增 `heldRepos?: string[]`（规范化 remote_url 集合）；CLI 侧在连接时由本机仓库索引（`apps/cli/src/repos/`，以 `git.ts` 的 inspect 结果为准）计算持有集并随 hello 上报，`repos.sync` 完成后以同一字段的更新消息刷新（消息形状在本任务内定：复用 hello 字段的独立 `holdings` 消息或 sync 响应附带，二选一并写进 protocol 测试）。旧 daemon 不报此字段 → 持有集为空（与任务 12 的兼容口径衔接）。
- [ ] remote_url 规范化：函数放 `packages/shared`（新 `remoteUrl.ts` 或 protocol 旁），规则在本任务内定死并写测试——host 小写、剥 `.git` 后缀、`git@host:path` 与 `https://host/path` 归一、剥尾随 `/`；先核对 `apps/hub/src/repos.ts:61` 的 `githubTarget` 可否下沉复用，能复用不另写。hub 与 CLI 只许用这一份。
- [ ] 路由资格（`tasks.ts:87` 的 `claimNextTask` 与 `daemonSocket.ts:253` 的 `dispatchOnce`）：claim 改为按「正在询问的连接」过滤——① 连接所有者（`daemons.owner_user_id`；本机形态为 `usr_local` 视同全工作区 owner，与今天一致）是任务工作区的未移除成员；② 该工作区有绑定仓库时，连接的持有集须覆盖绑定行 `remote_url` 的规范化集合（无绑定则此条 vacuous）；③ 同工作区同时只跑一个（既有不变式，保留原判定）。谓词尽量下推到 claim 查询，禁止「先 claim 再发现不合格」的占坑循环；`dispatchOnce` 对每个连接只领它合格的任务。
- [ ] 等待原因：任务保持 queued 且无合格 daemon 时，hub 在任务视图（`toUiTask`）给 `waitingReason`（实时推导、不落库）：取值至少区分 `no-daemon-online` / `no-member-daemon` / `repo-not-held`，并带可读文案所需的数据（缺哪台/哪类）。web 任务状态展示处渲染该原因（文案三语；展示组件执行时以现状定位）。
- [ ] 账号面不变：任务的 accountId 仍在 daemon 本机解析，dispatch 期既有 features 检查（`daemonSocket.ts:270/274`）保留；选不到账号沿用今天的失败路径。
- [ ] 先写失败测试（新 `apps/hub/test/taskRouting.test.ts` + `packages/shared/test/` 规范化用例）：非成员所有者的 daemon 领不到任务；成员但未持有仓库的 daemon 领不到绑仓工作区的任务、能领无绑定工作区的任务；持有齐备的 daemon 领到；两 daemon 同时在线时任务只落合格者；无合格者时任务留 queued 且 `waitingReason` 正确；同工作区两任务不并发落两个 daemon。
- [ ] 验证：`npx vitest run apps/hub/test/taskRouting.test.ts apps/hub/test/daemonSocket.test.ts` 与 shared 协议/规范化测试全绿；根 `npm run typecheck` 与 CLI 型检查通过。

### 任务 12：D-9 版本策略（最低兼容 + features 协商）

- [ ] `apps/hub/src/hubVersion.ts`：新增最低兼容版本常量（初值 = 首个支持注册凭据与 heldRepos 上报的 CLI 版本，即本项交付的版本号，合入时按当时的发布口径落值）与 x.y.z 比较函数（带单元测试）；`versionSkewMessage` 保留给「低于最低线」场景并改文案为升级指引。
- [ ] `daemonSocket.ts:396-397`：全等校验改为——低于最低线 → 拒绝并回升级原因；大于等于最低线一律放行（与 hub 版本不同不再拒绝）。此校验在远程与本机形态下的适用范围在本任务内定（建议：有 `releaseVersion` 的装配下一律按最低线口径；测试装配不设则跳过，与今天一致）。
- [ ] features 协商口径：hello 的 features 继续记录（:415）；「必需能力缺失」只在派发期按既有检查显式报错（:270/:274 保留），不新增 hello 期版本号猜测。heldRepos 缺失（旧 daemon）按任务 11 口径处理（持有集为空），不算版本拒绝。
- [ ] 改口径测试（`apps/hub/test/daemonVersionSkew.test.ts` 重写相关断言）：低于最低线被拒且文案含升级指引；等于 hub 版本通过；高于 hub 版本通过；与 hub 不同但不低于最低线通过（旧全等断言翻转）；未设 `releaseVersion` 的装配不校验（既有行为）。
- [ ] 验证：`npx vitest run apps/hub/test/daemonVersionSkew.test.ts apps/hub/test/daemonSocket.test.ts` 全绿。

## 阶段四（放开暴露）

### 任务 13：hostGuard 允许清单与绑定配置

- [ ] 前置确认：阶段二、三的全部 PR 已合入且验收通过（任务 4-12 的复选框全勾）——本任务开工前在本计划执行证据里记一行确认，未确认不开工。
- [ ] `app.ts` 的 `hostGuard` 改清单制：回环（`127.0.0.1`/`localhost`，含端口）恒允许；`AppDeps` 增 `allowedHosts?: string[]`，清单项匹配口径在本任务内定死并写测试（建议：清单项为 hostname 或 host:port，不带端口时只比 Host 的 hostname 部分）；清单外一律 403（rebinding 防护语义保留，注释同步更新）。
- [ ] 配置接线：`main.ts` 解析 `NEMA_HUB_ALLOWED_HOSTS`（逗号分隔）→ `lifecycle.ts` 透传 deps；**仅当 `NEMA_HUB_REMOTE=1` 时清单才生效**——未开远程时即使误填清单，守卫行为与今天一致（测试钉住）。桌面装配不传清单。绑定地址沿用既有 `NEMA_HUB_HOST`（main.ts:52），放开为部署者显式配置（如 `0.0.0.0`），代码不新增默认值变化。
- [ ] cookie Secure 收口：核对任务 5 的会话 cookie 在远程形态下恒带 Secure（参数来源 = remoteAuth 开关），回环开发形态不带 Secure 的口径与文档（任务 14）一致。
- [ ] 先写失败测试（新 `apps/hub/test/hostGuard.test.ts`，对应 spec 验收 ⑦）：远程开 + 清单含 `hub.example.lan` → 该 Host 通过、未列 Host 403、回环通过；远程关 + 清单已填 → 未列 Host 仍 403、回环通过；清单为空 + 远程开 → 只有回环通过。
- [ ] 验证：`npx vitest run apps/hub/test/hostGuard.test.ts apps/hub/test/auth.test.ts` 全绿；hub 全套件不回归。

### 任务 14：部署文档与 changelog

- [ ] 四份 README（`README.md`、`README.en.md` 两英文版保持字节一致，`README.zh.md`、`README.ja.md`）与三份指南（`docs/guide.{en,zh,ja}.md`）新增「远程 hub（多人）」章节，内容口径一致：拓扑（独立 hub + PostgreSQL + 各人本机 daemon）、开启步骤与 env 表（`NEMA_HUB_REMOTE`、`NEMA_HUB_ALLOWED_HOSTS`、`NEMA_HUB_HOST`、`NEMA_WEB_ORIGIN`）、引导令牌的取得路径（hub 控制台输出与 `<dataDir>/bootstrap-token`；Compose 下经 `docker compose logs` 或数据卷文件）、邀请建号与 daemon 注册的操作顺序、会话 cookie 强制 Secure 的前提（https——受信网络/VPN 加密层或部署者自备反代）、D-2 边界警告（不直面公网、不内置 TLS)。
- [ ] `docker-compose.yml` / `.env.example`：给 hub 服务补远程形态 env 的注释示例（默认注释掉或置空，默认行为不变）；核对 Compose 下 hub 的绑定与端口发布口径与新章节描述一致，有出入以代码现状为准改文档。
- [ ] 与 `SECURITY.md`（任务 1 的新口径）交叉核对：指南不得把公网直连写成受支持；分享节口径不冲突。
- [ ] changelog 片段 `changelog.d/remote-hub-multiuser.added.md`（每行以 "- " 开头）：写明远程形态为显式开启的新能力、默认单机行为不变、升级后已装组件/既有单机用户无感（D-10）。
- [ ] 验证：`node scripts/ci/docs-check.mjs` 对改动路径通过；四 README 与三指南逐项人工核对（两英文 README 字节一致用 `diff` 验）；根 `npm run typecheck` 不受影响（纯文档 + compose 注释）。

## 收尾（验收与记录）

### 任务 15：VM 内 Compose 真实环境验收

- [ ] 演练环境：按 2026-11-16 测试政策在 VM 内走 Compose 路线——`docker compose` 起 postgres + hub（`NEMA_HUB_REMOTE=1`、`NEMA_HUB_ALLOWED_HOSTS` 含演练主机名、`NEMA_HUB_HOST` 放开到容器口径）+ web；两个 daemon 用仓库构建的 CLI 以两个不同 `~/.nema` 数据目录在宿主机各起一个进程；两个真人账号（引导建管理员甲、邀请建乙）。模型执行面以「任务被派到正确 daemon 并进入 running、产出开始」为验收边界（凭据在各人本机，VM 演练不接真实模型账号；若仓库的测试适配器可用则用它跑完一条任务并注明）。
- [ ] 剧本逐项走并记录（对应 spec 真实环境验收）：甲引导建号 → 甲邀请乙、乙设密码建号 → 甲把乙 `addMember` 进工作区 → 甲发任务、任务由甲的 daemon 执行（不是乙的）→ 乙在 web 可见任务与消息并回复 → 甲吊销乙的 daemon 后乙 daemon 重连被拒 → 第三个账号（有 hub 账号、非工作区成员）读工作区内容得 403 → 清单外 Host 访问 hub 得 403 → 单机形态冒烟：另起一个未开远程的默认 hub/桌面口径实例，`usr_local` 行为与今天一致。
- [ ] 每项记录实际命令与输出摘要（成功/失败分开记，失败不粉饰）；浏览器字面操作若受 VM 无浏览器限制，以 API 与页面抓取等价验证并明确标注这一限制（沿用 #162/#163 的既有口径）。
- [ ] 验证：剧本全部条目有通过证据，或失败项已定位并回到对应任务修复后复测；本任务不以自动化测试结果替代真实环境结果。

### 任务 16：#167 验收记录与 ROADMAP 收口

- [ ] 在 #167 贴验收记录：三类证据分开写——静态检查（typecheck / web lint+build 的实际命令与结果）、自动化测试（各套件结果，含 spec 验收 ①-⑦ 的用例落点）、真实环境（任务 15 的剧本结果与未覆盖项）；桌面实机未测注明是政策决定。
- [ ] 验收全过后关闭 #167；未过项不关，回到对应任务。
- [ ] ROADMAP：P2-12 改已完成、v0.3.3 一节按交付状态更新、二期登记项（D-7 迁键、路由增强、统一审计面）保持未排期原文，执行记录补一行。

## 执行证据

（实现阶段填写：每个任务的命令与结果、未验证项与环境限制。未执行前留空，不预先声称任何结果。）
