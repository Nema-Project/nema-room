# 首次运行时的 agent 就绪引导：按运行时判定、daemon 侧检测、不打扰的落点

日期：2026-11-25。Issue：[Nema-Project/nema-room#302](https://github.com/Nema-Project/nema-room/issues/302)（首次运行无 coding agent 时的配置引导）。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。相关：[#132](https://github.com/Nema-Project/nema-room/issues/132) 轻量化发布的 D-6（Agent CLI 不打包、只检测并引导，见 [2026-11-18 轻量化发布设计 §9](2026-11-18-lightweight-release-design.md)）、[#167](https://github.com/Nema-Project/nema-room/issues/167) 远程 hub 与多人（见 [2026-11-24 远程 hub 与多人设计](2026-11-24-remote-hub-multiuser-design.md)）。

**状态**：全部定案（2026-11-25，维护者：D-1…D-10 一律按推荐；排期在 #167 之前实施）。设计所对照的 HEAD 为 `main` `ca0266d`；「现状核实」各条是在这个 SHA 上读代码得到的，没有在桌面实机或 Compose 实环境上复现。本文不改生产代码，实施计划另行成文。

## 如何服务 #45

#45 的判断标准要求：让人和 agent 围绕同一个项目维持一份有证据、可追溯的共同理解。agent 是这份理解的一半生产者：讨论里的事实、决定与工作包要靠 daemon 上的模型运行时提炼和回报。今天首次运行的用户如果没有可用的运行时，发出的第一条讨论会排队或在执行时失败（失败原因只出现在那条任务里），用户得到的第一印象是「这东西不工作」，而不是「这台机器还差哪一步」。

本项把「这台机器能不能替我跑 agent」变成一条有来源的事实：哪台机器、何时检查、查了什么、没查什么，都写在呈现里。它服务 #45 的方式是让 agent 这一半参与者的就绪状态可见、可复检，而不是靠推断或等失败。护栏对照：

- **不把推断当权威**：检测只说它真正检查过的东西（命令在不在 daemon 的 PATH 上、本机凭据文件在不在且格式可用），不说「已验证可用」；没查到就是「未知」，不降级成「未安装」（D-3、状态模型）。
- **不把 Nema Room 收窄成 coding UI 或编排器**：知识库、工作区、分享、手写讨论在没有 agent 时照常可用，引导不挡任何入口（「不做」）。
- **不声称没有的集成**：Nema 不代装、不捆绑 Codex 或 Claude Code，只链到官方说明（沿用 #132 D-6 = A）。

## 现状核实（`ca0266d`）

1. **`AgentCliStatus` 从哪里来**。`apps/cli/src/agentClis.ts:36` 的 `detectAgentClis` 对 `codex`、`claude` 各跑一次 `<command> --version`（`commandSpec` 包装，10 秒超时，并行）。成功即 `installed: true` 并取首行为 `version`；**缺失、超时、非零退出一律记成 `installed: false`**，三种情况在结果里分不开。它只回答「这个命令在 daemon 的 PATH 上能不能答 `--version`」，**不知道任何登录态**。
2. **经什么路径到 web**。daemon RPC `agents.detect`（`apps/cli/src/components/rpc.ts:229`）→ hub `GET /api/agent-clis` 原样透传（`apps/hub/src/components.ts:82`，RPC 超时 `COMPONENT_RPC_TIMEOUT_MS` = 30 秒，daemon 不在线时按 `daemonHttpStatus` 回 503）→ web `getAgentClis`（`apps/web/lib/hub.ts:171`）。唯一的调用方是设置页「组件」标签里的 `AgentClis`（`apps/web/components/ComponentsSettings.tsx:469`），而这个面板**只在用户点开「组件」标签时挂载**（`apps/web/components/AppSettings.tsx:318-319`）。
3. **刷新时机**。每次挂载请求一次；没有轮询、没有缓存、没有 hub 推送事件，也没有「重新检查」按钮。用户装好 CLI 后要关掉再打开这个标签才会看到变化。
4. **检测对象和任务真正用的东西不一致**。daemon 的任务按 `config.adapter` 选运行时（`apps/cli/src/daemon/runner.ts:19`，默认 `codex-direct`，`apps/cli/src/config.ts:74`）：
   - `codex-direct` **不启动 `codex` 可执行文件**（[guide 的 Model runtimes 一节](../../guide.en.md#models)；旧的 CLI adapter 已退役，`apps/cli/src/codex/adapter.ts:5`）。它的凭据是 Nema 自己的 SIWC 登录、BYOK key，或 compat 模式下借用 `$CODEX_HOME/auth.json`（`apps/cli/src/accounts/credentials.ts:143`）。compat 只要那份登录文件，**不要求 `codex` 命令在 PATH 上**。所以「Codex CLI 未安装」对默认运行时既不是必要条件，也不是充分条件。
   - `claude-code` 启动 `claude`（`apps/cli/src/claude/adapter.ts:272`），凭据是 Nema 自存的 token（`claude setup-token` 生成，`nema auth claude` 或设置页存入），**不是** Claude Code 自己的交互登录。所以对 Claude 有意义的「已登录」是「Nema 存了可用 token」，而不是「`claude` 自己登录过」。
5. **未登录在跑任务之前就能知道**。`resolveRoute`（`apps/cli/src/routing/index.ts:140`）在启动任何进程或请求之前，就对选中的账户调用 `credentialOf`，缺凭据时返回 `NOT_LOGGED_IN` 一类的句子（`apps/cli/src/routing/messages.ts`，组装见 `routing/index.ts:257-270`）。`credentialOf` 即 `credentialStateOf`（`apps/cli/src/routing/accountAuth.ts:45`）→ `accountCredentialState` / `implicitCredentialState`（`apps/cli/src/accounts/credentials.ts:170`、`:187`），**只读本机文件，不联网、不刷新**，返回 `connected | missing | unusable`。所以这份知识完全可以在任务之前、按需计算，成本是几次 `lstat`/读文件。它不能知道的是：文件在、格式对，但令牌已在服务端过期或被吊销。这种情况今天只在运行时暴露，例如 Claude 的 stderr 命中 `AUTH_STDERR` 后给出 `LOGIN_FAILED`（`apps/cli/src/claude/adapter.ts:41-45`）。
6. **凭据状态今天只在桌面形态到 web**。桌面本地 gateway 的 `/_nema/settings`（`apps/local/src/settings.ts:99-133` 的 `redactedStatus`，含 `tools.claude.available`，由 `commandOnPath` 扫 PATH 目录得到，`:130`、`:135`）与 `/_nema/accounts`（`apps/local/src/accountsApi.ts:129`）返回凭据状态。Web / Compose 形态没有这些路由，guide 也写明 Compose 页面没有账户区块（[guide.en.md 账户段](../../guide.en.md#models)）。hub 与 hub→daemon RPC 里**没有任何凭据就绪信息**。
7. **同一台机器上有两个 PATH 检测，口径不同**：daemon 的 `agents.detect` 实际执行 `--version`，本地 gateway 的 `commandOnPath` 只看文件存在。损坏的 shim 会让两者结论相反。
8. **桌面 daemon 的 PATH 来自 Electron 进程**。`apps/local/src/runtime.ts:313-318` 原样拷贝父进程的 `PATH`，`apps/desktop` 与 `apps/local` 里没有解析登录 shell PATH 的代码。推断（未实机验证）：macOS 从 Finder 启动时 PATH 很短，装在 `~/.local/bin`、npm 全局目录或 Homebrew 下的 `claude` 会被判成找不到。这个判定对任务本身是如实的，因为 `claude-code` 运行时用同一个 PATH 启动，同样找不到（`NOT_FOUND`，`claude/adapter.ts:31`）。但「未安装」这个说法会误导用户。
9. **已有的入口**：CLI 的 `nema doctor`（`apps/cli/src/doctor.ts:59-94`）已经检查直连登录、`claude` 可执行与 Claude token，但只在终端里。web 侧的 daemon 连接状态有 `GET /api/daemon/status` 与 `daemon.status` 事件（`apps/web/components/WorkspaceShell.tsx:211-219`、`:242`），侧栏已有显示。首页空状态只有一句「No workspace yet…」（`main.empty`）。设置页的标签状态是组件内部 state（`AppSettings.tsx:231`），没有可深链的 URL 或参数。

结论：需要的两份知识（命令在不在、凭据在不在）daemon 今天都能便宜地得到，但只有前一份到了 web，而且只在一个很深的面板里，还检查错了对象（检查 CLI，而不是任务真正用的运行时）。本项要补的是**一个按运行时汇总、由 daemon 计算、经 hub 透传的就绪状态**，以及几个不打扰的落点。

## 状态模型

### 判定对象：运行时，不是 CLI（D-1）

就绪按 daemon 能跑的两个运行时判定，与设置页「模型」里用户可见的选择一一对应。CLI 只是 `claude-code` 的一个子条件。

| 运行时 | 需要的命令 | 需要的凭据（daemon 本机） | 「已登录」在这里的含义 |
| --- | --- | --- | --- |
| `codex-direct`（默认） | 无 | 默认账户的 SIWC 登录 / BYOK key / compat 下的 `$CODEX_HOME/auth.json` | `credentialStateOf(默认账户) === "connected"` |
| `claude-code` | `claude` 在 daemon 的 PATH 上能答 `--version` | Nema 存的 Claude token | 同上，账户为该运行时的默认账户 |

「默认账户」取 `resolveRoute` 无显式选择时的同一规则：该运行时下排序最前的已启用账户（`routing/index.ts:166-179`）。工作区或 thread 绑定了别的账户时按绑定走，那属于账户设置的范围，不属于首次运行引导。

### 三态与未知态（两运行时各自独立）

| 状态 | `codex-direct` | `claude-code` | 用户看到的说法 |
| --- | --- | --- | --- |
| `not_installed` | 不适用（不需要命令） | `claude --version` 报 ENOENT | 「运行 daemon 的这台机器的 PATH 上找不到 `claude`」，附官方安装链接；**不说「未安装」**（现状 8） |
| `not_signed_in` | 默认账户凭据 `missing`，或这个运行时下没有已启用账户 | 命令可用，但 token `missing` | 「还没有连接账户」，附下一步动作（D-5） |
| `credential_unusable` | 默认账户凭据 `unusable` | token `unusable` | 「凭据文件不可用（权限、符号链接或内容）」，与 `not_signed_in` 分开，因为修法不同 |
| `configured` | 凭据 `connected` | 命令可用，且 token `connected` | 「已配置」。**不说「可用」或「已验证」**（D-3） |
| `unknown` | daemon 不在线、RPC 失败或超时、旧版 daemon 没有这个方法、凭据检查抛错 | 同左，另加 `--version` 超时或非 ENOENT 的失败 | 「暂时无法检查」，并写明原因 |

整体就绪由 web 从两行推出：

- **ready**：当前配置的运行时（`config.adapter`）是 `configured`。另一个运行时的状态只在设置页显示，不触发任何引导。
- **needs_setup**：当前运行时是 `not_installed` / `not_signed_in` / `credential_unusable`。如果另一个运行时是 `configured`，引导多给一个「切换到它」的选项。
- **unknown**：当前运行时是 `unknown`。只在设置页与引导卡片里如实显示原因，**不弹横幅**（避免检测故障演变成打扰）。

`--version` 的失败要拆开：ENOENT 记为 `not_installed`，超时和其他错误记为 `unknown`（附一行原因）。现状 1 里三者混成 `installed: false`，这个混淆要在本项修掉。

### 数据契约（草案）

新增 daemon RPC `agents.readiness`，hub 透传为 `GET /api/agent-readiness`（D-7）。返回值只含状态与理由码，不含任何凭据值、路径内容或账户密钥：

```ts
type RuntimeReadiness = {
  runtime: "codex-direct" | "claude-code";
  state: "not_installed" | "not_signed_in" | "credential_unusable" | "configured" | "unknown";
  /** Why it is unknown or not configured, as a code the web translates; never stderr. */
  reason?: "no_enabled_account" | "cli_timeout" | "cli_error" | "inspect_failed";
  cli?: { command: string; version: string | null; installUrl: string };
  accountId?: string; // which account was judged, never its credential
};
type ReadinessReply = { current: "codex-direct" | "claude-code"; runtimes: RuntimeReadiness[]; checkedAt: string };
```

计算全部复用现有函数：`detectAgentClis` 的执行器（按 ENOENT 与其他失败拆开）、`loadRoutingAccounts`、`credentialStateOf`。不联网、不刷新令牌、不读令牌值。

## D 项（待维护者拍板）

- **D-1 判定粒度：按 CLI 还是按运行时？推荐：按运行时（上表），CLI 只作为 `claude-code` 的子条件。** 理由：任务真正依赖的是运行时与凭据（现状 4）。按 CLI 判定会把用 SIWC 跑默认运行时、从没装过 Codex CLI 的用户标成「缺东西」，也会把装了 `claude` 但 Nema 里没存 token 的用户标成「好了」。两种都是错的引导。备选：保持 brief 原样的「两个 CLI × 三态」：实现最省（现有 `agents.detect` 加登录位），但两个 CLI 的「登录」语义（Codex 自己的 `auth.json`、Claude 的 Nema token）不对称，展示出来的「已登录」并不是任务需要的那个，等于把推断当事实。
- **D-2 引导落点：首启屏、首页空状态、可关横幅、设置页深链，选哪些？推荐：三处组合，不做首启屏。**
  1. **首页空状态**（无工作区时）：在「创建工作区」旁加一张「准备 agent」清单卡，按状态模型列出 daemon 连接、当前运行时、下一步，每步带「重新检查」。这里是零工作区用户必经的位置，打扰为零：它填的是本来空着的地方。
  2. **工作区内可关横幅**：只在整体状态为 `needs_setup` 且用户没有关闭过时显示，一行，链到设置页。不在 `unknown` 时显示。
  3. **设置页深链**：横幅和清单卡的动作都打开设置页并定位到「模型」标签（桌面形态在那里登录或填 token）或「组件」标签（看 CLI 检测）。这需要给 `AppSettings` 加一个初始标签参数（现状 9：今天标签是内部 state）。

  另在 Composer 发送区加一行就地提示：`needs_setup` 时说明「这条消息会排队，当前运行时尚未配置」。发送不被阻止，因为讨论本身会落库，任务回队或失败的既有路径不变。

  理由：触达最高的是空状态与 Composer，它们只出现在用户正准备用 agent 的地方；横幅给已经有工作区的用户（例如从旧版升级、换了机器）一次提醒，可关；深链让每条提示都有去处。首启屏不选，原因有四：它挡住知识库等不需要 agent 的功能（与「不做」冲突）；桌面、npm、Compose、远程四种形态的「首次」定义各不相同（远程形态下首次打开 web 的人可能根本不管 daemon）；一旦关掉，之后就没有落点；还要再做一套关闭状态。备选：(a) 只做设置页状态（今天的做法加强版）：零打扰，但触达几乎为零，现状 2 已经说明这个面板很深；(b) 常驻横幅不可关：对只用知识库的人是持续打扰，违背「不挡住」。
- **D-3 探测深度：只查存在性与本机凭据状态，还是对每个运行时做真实 auth 探测？推荐：只做前者（命令存在 + `credentialStateOf` 的本机文件判定），展示为「已配置」。真实探测只作为用户主动点击的动作，并且只在已有的地方提供（桌面「模型」页的 SIWC/BYOK 探测）。** 理由：
  - **成本**：真实探测会发一次模型请求、消耗额度。AGENTS.md 与 guide 都把 `auth probe` 写成「会发真实请求」，自动跑等于替用户花钱；每次刷新、每台 daemon 都跑更不可接受。
  - **误判**：网络、代理（参考 `CONNECTION_FAILED_*`）、限流都会让探测失败，自动探测会把「网络问题」误报成「没登录」，比只查文件的误判更难懂。
  - **能力不对称**：Claude 没有探测路径（`/_nema/auth/probe` 对 claude-code 回 `probe_not_supported`，`apps/local/src/settings.ts:320`）。为它造一条就要启动 `claude` 发请求。
  - **桌面与远程的差异**：桌面上 daemon 与浏览器同机，用户点「检查」的代价可见。远程形态下探测发生在另一台机器、用的是那台机器主人的额度。一个看页面的人不该能触发别人机器上的计费请求（与 #167「凭据不出 daemon 本机」同向）。

  代价是会漏掉「文件在但令牌已失效」，这种情况继续由任务时的既有错误句子兜底（现状 5）。备选：自动真实探测（准确度最高，但上面四条都不成立）；只查存在性、不查凭据（等于今天，漏掉最常见的未登录）。
- **D-4 刷新时机。推荐：在四个时刻读一次 `agents.readiness`：页面加载；`daemon.status` 从断开变为连接；窗口重新获得焦点（节流，两次至少间隔 30 秒）；用户点「重新检查」。不做后台轮询。daemon 侧不缓存凭据判定（够便宜），`--version` 结果缓存 30 秒，「重新检查」带 `force` 绕过缓存。** 理由：用户最典型的动作是切到终端装或登录，再切回来。焦点事件正好覆盖这一步，免去手动刷新。`--version` 每次都会起子进程，轮询会让空闲的 Room 持续 fork 进程。备选：固定间隔轮询（简单，但浪费进程，且只在需要引导时才有意义，状态机反而更复杂）；daemon 主动推送（需要监听文件与 PATH 变化，跨平台不可靠）。
- **D-5 下一步动作按形态给。推荐：桌面形态（`LOCAL_HUB_MODE`，且 `/_nema/settings` 可用）给应用内动作：深链到「模型」页登录或填 token，`not_installed` 给官方安装链接。其他形态（npm 本地、Compose、远程）给「在运行 daemon 的那台机器上执行」的命令文本：`nema auth login`、`claude setup-token` 加 `nema auth claude`、`nema doctor`，并附 guide 链接。命令按版本化写法给出（AGENTS.md 要求，不写无版本的 `npx`）。** 理由：凭据只能在 daemon 本机写入（Compose 页面没有账户区块，远程形态按 #167 的不变量也不会有）。在 web 上给一个「登录」按钮，在这些形态下是做不到的承诺。备选：所有形态统一只给命令：桌面用户被迫开终端，退回 0.2 的体验。
- **D-6 退出与「配好后永不再扰」。推荐：**
  - **自动退出**：整体状态变为 `ready` 时，横幅与 Composer 提示立即消失，无需用户操作；空状态卡在有工作区后自然不再出现。
  - **永久退休**：首次观察到 `ready` 时，在浏览器 `localStorage` 记一个按 hub 源区分的「已完成首次就绪」标记。之后即使状态退回 `needs_setup`（令牌被删、换了运行时），也不再显示首次引导横幅，退化由既有的任务失败句子与设置页状态承担。用户主动点「不再提示」效果相同。
  - **只关这一次**：横幅的关闭按钮只记当前的原因码。原因变了（例如从 `not_installed` 进到 `not_signed_in`）就再显示一次，因为这是新的一步。

  理由：首次引导的职责是把人带到第一次可用，之后的故障属于运维状态，不该用 onboarding 的语气反复出现。`localStorage` 不需要迁移、不进 hub 数据库，符合「数据库变更要有兼容与恢复计划」的低成本路径。代价是换浏览器会再看到一次（仅在仍未就绪时）。备选：存在 hub 的用户偏好里（跨浏览器一致，远程多人下更自然，但要新增 schema 并等 #167 的真人身份落地）。见「待维护者拍板」第 4 条。
- **D-7 接口形态：扩展 `agents.detect` 还是新增方法？推荐：新增 daemon RPC `agents.readiness` 与 hub 路由 `GET /api/agent-readiness`；`agents.detect` 与「组件」页保持原样，只修它的 ENOENT 与超时混淆（复用同一个执行器）。** 理由：语义不同（一个是 CLI 清单，一个是运行时就绪，含凭据状态），分开后旧 daemon 对新方法回「未知方法」，web 按 `unknown` 处理、不显示横幅，降级是安静的。往 `agents.detect` 加字段也能做到，但那条路由的名字与「组件」页的定位都会被迫改义。备选：扩展现有方法（少一条路由，语义混在一起）。
- **D-8 daemon 未连接时。推荐：清单卡的第 0 步是「daemon 已连接」，复用现有 `connected` 状态与侧栏指示；未连接时运行时行全部显示 `unknown（daemon 未连接）`，不显示横幅（侧栏已有指示，避免重复提示）。** 理由：没有 daemon，就绪无从判定。桌面形态 daemon 随应用启动，这一步主要服务 npm 与 Compose 用户，他们需要被告知「还要在终端启动 daemon」。备选：daemon 未连接也弹横幅（与侧栏指示重复）。
- **D-9 远程形态（#167）下的差异。推荐：本项按单 daemon 实现，但数据契约与文案从一开始就带「哪台机器」：** 回复里预留 daemon 标识字段（#167 的 `daemons.id`/`label` 落地后填入），文案一律写「运行 daemon 的机器」而不是「你的电脑」。多 daemon 落地后，整体就绪定义为「当前用户可派任务的在线 daemon 中，至少一台 `ready`」（与 #167 D-6 的派发资格一致）。设置页按 daemon 分行列出各自状态。远程形态下所有下一步动作都按 D-5 的命令文本给，并说明「这些命令要在那台机器上、由那台机器的主人执行」。查看页面的人如果不是任何在线 daemon 的主人，提示改成「这个 hub 上还没有为你准备好的 daemon」，不给命令。理由：远程形态下浏览器、hub、daemon 可能分属三台机器、两个人，「装一下」「登录一下」的主语必须写清楚，否则用户会在自己的笔记本上装 CLI，却解决不了那台 Mac mini 的问题。备选：远程形态关闭引导（最省，但正是最需要说清「在哪台机器」的场景）。
- **D-10 桌面 PATH 看不到用户 shell 里的 `claude`。推荐：本项不改 daemon 的 PATH 来源，只把文案从「未安装」改成「daemon 的 PATH 上找不到」，并在桌面形态附一句「如果你已经安装，桌面应用可能看不到终端里的 PATH」与 guide 链接。是否让桌面运行时继承登录 shell 的 PATH 另开 issue。** 理由：PATH 来源影响 git、graphify 等所有子进程，是独立的兼容性决定；检测与运行同源，本项如实报告即可。备选：本项顺手解析登录 shell PATH（影响面超出引导，且 macOS、Windows 各有坑）。

## 流程

1. **首次打开**（无工作区）：空状态卡显示第 0 步 daemon 连接，以及当前运行时的状态和下一步。用户可以直接创建工作区，卡片不挡路。
2. **用户在终端或系统里完成一步**（装好 `claude`、`nema auth login`、在桌面「模型」页登录）后切回窗口。焦点事件触发复检（D-4），卡片或横幅立即更新到下一步，或者消失。卡片上的「重新检查」按钮做同样的事并绕过缓存。
3. **退出**：当前运行时变为 `configured`，即整体 `ready`，所有首次引导自动消失并永久退休（D-6）。
4. **之后的故障**：凭据被删或失效时，任务失败继续给出既有的、指名下一步的句子（现状 5）。设置页「模型」与「组件」照常显示状态，首次引导不再出现。
5. **远程形态**：与上面相同，但每一步的主语是「运行 daemon 的那台机器」，动作是那台机器上的命令（D-5、D-9）。

## 不做

- **不代装、不捆绑**：不运行任何官方安装器，不把 Codex 或 Claude Code 打进安装包或 Compose 镜像，只给官方安装说明链接（沿用 #132 D-6 = A 的口径与理由）。
- **不代登录**：web 不收集、不转发任何模型凭据。桌面形态沿用已有的本地设置页流程，其他形态只给命令文本。
- **不挡功能**：创建工作区、知识库、手写讨论、只读分享、仓库绑定等不依赖 agent 的功能，在任何就绪状态下都不受限制。不做首启屏或模态（D-2），Composer 不禁用发送。
- **不自动发真实模型请求**：不做后台探测或首次探测（D-3）。
- **不把「已配置」说成「可用」**：UI 与文档都不声称检测证明了令牌有效、模型可达或任务会成功。
- **不改路由与失败语义**：`resolveRoute`、任务回队、失败句子保持原样。本项只读这些判定，不改变它们。
- **不改 daemon 的 PATH 来源**（D-10），不改「组件」页的 `agents.detect` 定位（D-7）。

## 实施要点（供计划参考）

- `apps/cli`：`agents.readiness` 处理器（复用 `credentialStateOf`、`loadRoutingAccounts` 与 `detectAgentClis` 的执行器，ENOENT 与其他失败分开），带单元测试覆盖上面状态表的每一格。
- `apps/hub`：`GET /api/agent-readiness` 透传，daemon 离线回 503、未知方法回可识别错误。测试仿照 `apps/hub/test/components.test.ts`。
- `apps/web`：空状态清单卡、横幅、Composer 提示、`AppSettings` 初始标签参数、`localStorage` 标记；三份 `messages/*.json` 同步。
- 文档：`changelog.d/` 片段（`added`）；四份 README 与 `docs/guide.{en,zh,ja}.md` 中首次运行段落补一句引导的位置与「已配置 ≠ 已验证」。

## 验收口径

三类证据分开写，不互相替代：

- **静态检查**：`npm run typecheck`、`npm run typecheck -w apps/cli`；web 改动加 `npm run lint -w apps/web` 与 `npm run build -w apps/web`。
- **自动化测试**：① daemon 侧状态表逐格（假的 `--version` 执行器分别返回 ENOENT、超时、成功；临时 `nemaHome` 下凭据分别为 missing、unusable、connected；无已启用账户）；② hub 透传与 daemon 离线 503；③ web：每种整体状态下的空状态卡、横幅与 Composer 提示；`unknown` 与 daemon 未连接时不出横幅；`ready` 后横幅消失、标记写入、之后状态退回也不再出现；关闭按钮按原因码记忆；焦点复检节流。所有测试用临时数据目录与假执行器，不调用真实模型。
- **真实环境验收**：按 2026-11-16 测试政策，在 VM 内走 Compose 路线：没有 `claude`、没有登录时看到清单卡与正确命令；执行 `nema auth login` 后切回窗口，状态更新并且引导退出。桌面实机不主动测；D-10 的 macOS PATH 推断如果要确认，需要维护者在实机上看一次。

## 待维护者拍板

1. ~~D-1：就绪按运行时判定（CLI 只作为 `claude-code` 的子条件），不按 brief 原文的「两个 CLI × 三态」。~~ **已定案（2026-11-25）：按推荐。**
2. D-2：落点为空状态卡、可关横幅、设置页深链，外加 Composer 一行提示；不做首启屏。 **已定案（2026-11-25）：按推荐。**
3. D-3：不做自动真实 auth 探测，呈现为「已配置」而不是「可用」。 **已定案（2026-11-25）：按推荐。**
4. D-6：「永不再扰」标记存浏览器 `localStorage`（零迁移），还是等 #167 真人身份落地后存 hub 用户偏好。 **已定案（2026-11-25）：按推荐。**
5. D-7：新增 `agents.readiness` 与 `GET /api/agent-readiness`，不扩展 `agents.detect`。 **已定案（2026-11-25）：按推荐。**
6. D-9：本项按单 daemon 实现，契约与文案预留 #167 的 daemon 标识；多 daemon 的就绪聚合随 #167 二期或本项后续再做。 **已定案（2026-11-25）：按推荐。**
7. D-10：桌面 PATH 继承问题是否另开 issue；本项只改文案。 **已定案（2026-11-25）：按推荐。**
8. 排期：本项排在 v0.3.3（#167）之前、之中还是之后。D-9 的预留让它可以先于 #167 落地。 **已定案（2026-11-25）：按推荐。**
