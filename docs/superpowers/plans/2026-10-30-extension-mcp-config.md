# 扩展管理：MCP 配置与启停 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：草案，含待维护者确认的决定（D-1、D-2、D-3）。** 决定选定前，标了「受 D-n 阻塞」的任务不得开工，也不得由实现者替维护者选。其余任务可以先做。

**Goal:** 让用户在 Nema 里保存一个本地 stdio 或远程 HTTP 的 MCP 服务器配置，凭据只留在本机受信任层，界面只看到「已配置」；由 daemon 用现有的受管 helper 启动、连接、列出工具并停止它，停用、改配置、卸载和退出时都不留进程。

**Architecture:** MCP 配置是一条 `kind: "mcp"`、`provision: "managed"` 的扩展记录。不含凭据的配置写在该记录自己的受管目录 `extensions/extensions/<id>/mcp.json` 里，卸载时随目录一起删除。凭据按 D-1 选定的方式保管，配置里只存引用。daemon 里的 `McpSupervisor` 按 id 串行化启动和停止，stdio 走注入的 `OwnedHelperScope`，没有注入时用独立进程组；HTTP 走 MCP SDK 的 Streamable HTTP 客户端。连接成功后记录工具名和 schema 摘要。本计划**不把这些工具交给 Agent**（见 D-3）。hub 只代理固定操作，web 只提交固定操作、读状态。

**Tech Stack:** TypeScript、Node.js `fs` / `child_process`、`@modelcontextprotocol/sdk`（`apps/cli` 已依赖 `^1.32.1`）、Hono、Next.js、Vitest。除 D-1 选 B 外不新增依赖。

**Spec:** [扩展管理设计](../specs/2026-10-25-extension-management-design.md)，重点是「安装来源与版本」的 MCP 段、「统一安装记录和操作服务」、「Skills 与 MCP 如何真正可用」的 MCP 段和「验证与交付边界」。上一份计划 [extension management plan](2026-10-25-extension-management.md) 的 *Later plans* 把这一份定为「MCP: save a stdio or HTTP config, start and stop it with the existing owned-helper scope, and keep credentials off the page」。

**Issue:** [#75](https://github.com/Nema-Project/nema-room/issues/75) 验收里的两条：「MCP 支持 stdio 与 HTTP 配置，凭据由本机保管且不回传明文」「MCP 启停使用现有受管 helper，进程不遗留」。连接器侧约束来自 [#25](https://github.com/Nema-Project/nema-room/issues/25) 与 [connector architecture v0.2](../../design/connector-architecture-v0.2.md)（ADR-03、ADR-04、§4.2、§4.3）。

**Base:** 写本计划时的 `origin/main` 是 `2dfd984`（Merge pull request #90）。动手前 `git fetch origin main`，再看 `git diff --name-only 2dfd984..origin/main -- apps/cli/src/extensions apps/cli/src/daemon apps/cli/src/secrets apps/hub/src/plugins.ts apps/hub/src/uiApi.ts apps/web/components/PluginsPage.tsx packages/shared/src/extensions.ts`。有改动时先重读这些文件，与下文「核对的代码」不一致就先改本计划。

## 如何服务 #45

[#45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准是：这是否让人和 agent 更容易对项目保持有证据支撑的共同理解。MCP 本身不是对齐能力，它是让 room 能接入更多上下文来源的通道（#45 的回路里「Docs / Repo evidence」那一层）。本计划只做这个通道里**可核对、可撤回**的那部分：

- 每个服务器记录它从哪来、怎么启动、用的是哪个版本的工具清单（schema 摘要），事后能回答「当时 agent 能调什么」。
- 「配置已保存」「已连接」「工具已交给 Agent」分开显示，不把能连上说成能用，也不把发现说成授权。
- 不让 Agent 直接拿到新工具（D-3），避免在策略引擎（CX-02）之前扩大 Agent 的执行面，符合 #45「不为架构图增加集成或自主动作」的护栏。

它不把 Nema Room 写成编排器或通用 MCP 客户端，也不宣称已经接通任何外部系统。

## 写本计划时核对的代码（`2dfd984`）

- `packages/shared/src/extensions.ts`：`ExtensionKind` 已含 `"mcp"`；`ExtensionRecord` 没有连接配置引用、连接状态或工具清单字段。spec 要求的 MCP 连接状态（未连接 / 连接中 / 已连接 / 需要登录 / 连接异常）还没有类型。
- `apps/cli/src/extensions/store.ts`：`putManaged` 为 managed 记录建 `extensions/extensions/<id>`，`removeManaged` 经 `ownedDirectory` 校验（含 #85 加的根目录符号链接拒绝）后删除该目录和记录。`assertPinned` 只约束 GitHub 来源，MCP 配置记录的 `source` 不是 GitHub 链接，不受影响。id 规则 `^[a-z][a-z0-9-]{0,63}$`，不得与内置 id 重名。
- `apps/cli/src/extensions/handlers.ts`：已有 `extensions.list / setUse / remove / resolveSource / install / installStatus / cancelInstall / retryInstall`。`remove` 对正在安装的项拒绝。
- `apps/cli/src/ownedProcess.ts`：`spawnOwned` **只在 Windows 上可用**（Job Object + guardian），注释写明「POSIX helper ownership is a separate gate」。`apps/local/src/ownedHelpers.ts` 的 `createOwnedHelperScope` 提供 `spawn / stopAccepting / drain`，只在桌面运行时清单带 guardian 时注入（`apps/local/src/runtime.ts`）。
- `apps/cli/src/github/client.ts`：`ExactEnvStdioTransport` 是仓库里已有的 MCP stdio 客户端传输：给了 `ownedHelpers` 就走受管 spawn，否则 `spawn(..., { shell: false })`；子进程环境是精确传入的，不继承 daemon 的全部环境。`GithubMcp` 已有连接、`listTools`、关闭和启动失败退避的写法。
- `apps/cli/src/claude/adapter.ts`：POSIX 上用 `detached: true` 让子进程自成进程组，停止时按进程组发信号。这是 POSIX 上「不留子进程」的现有做法。
- `apps/cli/src/daemon/setup.ts`：daemon 关闭时 `Promise` 汇总 `runner.stop()、watcher.stop()、connection.close()、github.close()`。新的 supervisor 要加进这里。
- `apps/cli/src/secrets/file.ts` + `permissions.ts`：`saveSecretLine` / `readSecretLine` 原子写入一行，POSIX 0600、Windows 私有 DACL，拒绝符号链接，错误信息不含内容。`github-token`、BYOK 密钥都用它。仓库里没有任何系统钥匙串（Keychain / Credential Manager / libsecret / Electron `safeStorage`）的用法。
- `apps/hub/src/plugins.ts`：`enabledPluginTools` 只从静态 `PLUGINS` 清单出工具；`withoutDisabledExtensions` 按扩展 id 扣掉停用项。扩展记录里的 MCP 不会自动变成 Agent 工具，本计划保持这一点。
- `apps/cli/test/fixtures/fake-github-mcp.mjs`：已有假 stdio MCP 服务器夹具，可照着写通用假服务器。

## 待维护者确认

### D-1：凭据存放位置和保管方式（重大决策，待维护者确认）

MCP 的 stdio `env` 与 HTTP 请求头里常有 API key 或 Bearer token。spec 只要求「由本机受信任层保管，界面只得到已配置状态，不返回明文」，没有定存哪里。

| 方案 | 做法 | 好处 | 代价与风险 |
| --- | --- | --- | --- |
| **A. Nema 私有密钥文件**（推荐） | 每个值一份文件：`<nemaHome>/secrets/mcp/<id>/<NAME>`，复用 `saveSecretLine` / `readSecretLine`（POSIX 0600、Windows 私有 DACL、拒绝符号链接、原子写）。配置只存 `{ secret: "NAME" }` 引用。卸载时删 `<id>` 目录 | 与 GitHub 令牌、BYOK 密钥同一机制，已有跨平台测试；桌面、源码 daemon、Compose 宿主 daemon 三种跑法都能用；不新增原生依赖；hub 容器里永远没有这些值 | 磁盘上是明文，只靠文件权限保护；同一系统用户下的其他进程、整盘备份或拷走 `~/.nema` 都能读到；不提供静态加密 |
| B. 系统凭据库 | macOS Keychain、Windows Credential Manager（DPAPI）、Linux Secret Service，经原生模块（例如 keyring 绑定）读写；配置只存条目名 | 静态加密，由操作系统按用户隔离；备份 `~/.nema` 不会带走凭据 | 要为每个平台和架构打包原生模块（含许可证、桌面包体积、未来 arm64）；无桌面会话的 Linux 宿主 daemon（Compose 场景）通常没有 Secret Service，仍要回退到 A；Electron `safeStorage` 只在桌面主进程可用，CLI daemon 用不到；新增一类跨平台失败与测试面 |
| C. 不由 Nema 保存 | 配置里只写 `{ env: "NAME" }`，启动时从 daemon 自己的环境变量取值；Nema 不落盘任何凭据 | 最简单，Nema 没有可泄露的存储；适合已经用 shell 管理密钥的开发者 | 桌面应用从图形界面启动时拿不到用户 shell 里的变量；页面无法设置；改值要重启 daemon；不符合 spec「由本机受信任层保管」的意图，只适合作为补充 |

**推荐：A 为默认，同时允许 C 作为补充的引用类型**（配置里某个值写 `{ env: "NAME" }` 时从 daemon 环境取，不落盘）。理由：A 和现有凭据保管方式一致、三种运行形态都能用、不引入原生依赖；B 的静态加密收益真实，但在 Compose 宿主上无论如何都要回退，适合作为以后单独评估的升级，届时只换 `McpSecretStore` 的实现，不改配置格式。选 B 的话 Task 2 改为原生模块 + A 回退，并要先补一份打包与许可调查。

### D-2：凭据从哪里输入（待维护者确认，与 D-1 相关）

- **P1. 只用 CLI**：`nema mcp secret set <id> <NAME>` 从标准输入读一行，和 `nema auth github` 一样。值不经过 hub。桌面用户要能找到 CLI，体验差。
- **P2. 页面只写字段 + CLI**（推荐）：页面上的密码框只能提交，不回显；请求经 hub 原样转给 daemon 的 `extensions.mcp.setSecret`，hub 不落库、不记日志、不写进 `plugin_calls` 或错误文本，响应里只有 `{ name, configured: true }`。值会在 hub 进程内存里短暂经过（Compose 场景下是容器里的 hub），这一点要写进文档。CLI 入口同时保留。

推荐 P2：桌面用户没有终端也能配置，经过 hub 只在内存里、走已有的本机 hub↔daemon 连接，符合 connector 设计「Hub 不持有 token」（不持久化）。若维护者要求凭据完全不经过 hub，选 P1，Task 6 的密码框删掉，页面只显示「已配置 / 未配置」和对应 CLI 命令。

### D-3：本计划的边界：工具先不交给 Agent（待维护者确认）

spec 要求 MCP 工具「经过连接、schema 校验、工具命名空间和显式启用后」才加入 Agent 工具集；ADR-04 要求「未审计 MCP 工具默认禁止 Agent 调用」，§4.2 要求未知工具默认 `unsupported`，由 CX-02 的策略引擎分类。

- **推荐：本计划到「已连接、工具清单与 schema 摘要已记录、页面可见」为止，不进任何 Agent 的工具集。** 交给 Agent 另开计划，与 CX-02 一起做（命名空间 `mcp__<id>__<tool>`、逐工具显式启用、schema 摘要变化后自动停用待确认、workspace 范围）。
- 备选：本计划内就允许逐工具手动启用并交给 Agent，只限只读标注的工具。代价是在策略引擎之前绕开 ADR-04 的默认拒绝，第三方 annotations 又不能作为权限保证（spec 原文），不推荐。

## 范围与非目标

做：stdio 与 HTTP 两种配置的保存、校验、修改与删除；凭据按 D-1 保管、按 D-2 输入；daemon 内的启动、连接、`listTools`、停止；连接状态与工具清单展示；停用、改配置、卸载、daemon 退出时停掉对应实例。

不做（各有去处）：

- 远程 MCP 的 OAuth（PKCE、回调、刷新）：CX-06。HTTP 本计划只支持静态请求头凭据；服务器返回 401/403 时状态记为「需要登录」，不尝试登录。
- 按 npm / PyPI / GitHub 注册信息自动安装 MCP 包和生成启动配方：spec 要求，但另开计划。本计划只接受用户显式写出的启动命令和参数。
- 把工具交给 Agent：见 D-3。
- 发现其他客户端（Claude Code、Codex 等）的 MCP 配置并接入：属于外部发现，另开计划；不读取、不复制其他客户端的密钥。
- POSIX 上的受管 helper 所有权：仍是 `ownedProcess.ts` 写明的独立门槛。本计划在 POSIX 用进程组停止，**不宣称** POSIX 与 Windows Job Object 等价。

## Global Constraints

- 凭据值不出现在：扩展记录、`index.json`、`mcp.json`、任何 RPC / HTTP 响应、日志、错误文本、`plugin_calls`、测试快照和提交里。测试用唯一标记串（例如 `nema-test-secret-7f3a`）断言它不在任何序列化输出里。
- 启动命令不经 shell：`spawn(command, args, { shell: false })`，Windows 走现有 `commandSpec`。不把 README 或注册表里的命令字符串整句执行。
- 子进程环境是精确传入的：只给配置里的 `env`、解析后的凭据、必需的 `PATH` / `HOME`（指向 `<nemaHome>/run/mcp/<id>/home`）和 `windowsRuntimeEnv`，不继承 daemon 的全部环境，避免把 `~/.nema` 里的其他令牌或模型密钥带进第三方进程。
- HTTP 地址：`https:` 必须；`http:` 只允许 `127.0.0.1`、`::1`、`localhost`。不跟随重定向。不允许 URL 里带用户名密码。
- 同一 id 的启动、停止、改配置、删除串行化；改配置和删除先停实例再写文件。
- 启动有超时（连接 + `listTools`），超时就停掉进程并记为「连接异常」，不留半启动的子进程。
- 不改 `apps/hub/src/plugins.ts` 里 `enabledPluginTools` 的出工具逻辑（D-3）。
- 并行工作：插件页 UI 线和 Skills 渐进加载线在改 `PluginsPage.tsx`、`extensions/handlers.ts`、`extensions/store.ts`、`daemon/setup.ts`。开工前看它们是否已合并；没合并就只做不碰这些文件的任务（Task 1、2、4 的新文件部分），其余等合并后在新 main 上做，不在别人的分支上改。
- 用户可见变更写 `changelog.d/extension-mcp-config.added.md`；UI 文案三语同改；`README.md` 与 `README.en.md` 保持逐字节一致。

## Review Focus

1. 任何响应、日志或错误里出现凭据值（Task 2、5、6 的标记串测试）。
2. 停止、改配置、卸载、daemon 退出、启动超时之后还有子进程活着（Task 4 的进程存活测试，POSIX 与 Windows 分开记录）。
3. 子进程拿到了不该有的环境变量（Task 4 的环境快照测试）。
4. 删除越界：`removeManaged` 之外另删了凭据目录以外的路径，或凭据目录是符号链接时被跟随（Task 2、3）。
5. HTTP 跟随重定向或接受了非回环的 `http:`（Task 4）。
6. 有任何路径让 MCP 工具进了 Agent 工具集（D-3，Task 5 的回归测试）。

---

### Task 1: 共享类型与配置校验

**Files:**
- Modify: `packages/shared/src/extensions.ts`
- Create: `packages/shared/src/mcpConfig.ts`（并从包入口导出）
- Test: `packages/shared/test/mcpConfig.test.ts`

**Interfaces:**
- Produces:
  - `McpValue = { value: string } | { secret: string } | { env: string }`。`value` 只用于非敏感值；`secret` 是 D-1 的存储引用；`env` 是 D-1 推荐里的 C 型补充引用。
  - `McpConfig = { transport: "stdio"; command: string; args: string[]; cwd?: string; env: Record<string, McpValue> } | { transport: "http"; url: string; headers: Record<string, McpValue> }`
  - `parseMcpConfig(input: unknown): McpConfig`：拒绝空命令、命令里带换行或 NUL、`args` 非字符串数组、`env` / 请求头名不合法（`^[A-Za-z_][A-Za-z0-9_]{0,63}$`；请求头名按 RFC 7230 token）、`secret` / `env` 引用名不合法、HTTP 地址违反 Global Constraints。
  - `McpConnection = "disconnected" | "connecting" | "connected" | "needs-login" | "error"`
  - `ExtensionRecord` 增加可选的 `mcp?: { transport: "stdio" | "http"; connection: McpConnection; tools: Array<{ name: string; schemaDigest: string }>; secrets: Array<{ name: string; configured: boolean }>; lastError: string | null }`。不含命令行、地址以外的配置细节，也不含任何值。
- [ ] **Step 1: 写失败测试**：每条拒绝规则一例；合法 stdio / HTTP 各一例；`{ value }` 里放标记串时，`parseMcpConfig` 的错误信息不含该串。
- [ ] **Step 2: 跑** `npx vitest run packages/shared/test/mcpConfig.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑** 同一条和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(shared): describe MCP server configs and connection state`

### Task 2: 凭据存储（受 D-1 阻塞）

**Files:**
- Create: `apps/cli/src/secrets/mcp.ts`
- Test: `apps/cli/test/secrets/mcp.test.ts`

**Interfaces（按 D-1 推荐的 A 写；选 B 时接口不变、实现换掉）:**
- `McpSecretStore`：`set(id, name, value)`、`has(id, name): boolean`、`names(id): string[]`、`clear(id, name)`、`removeAll(id)`、`resolve(id, name): string`（只给 supervisor 调用，不注册成 RPC）。
- 路径 `<nemaHome>/secrets/mcp/<id>/<name>`，目录 0700 / 私有 DACL；`id` 用扩展 id 规则校验，`name` 用 Task 1 的引用名规则校验，杜绝 `..`。
- `removeAll` 只删 `<nemaHome>/secrets/mcp/<id>`：先 `lstat`，是符号链接或解析后不在 `secrets/mcp` 下就拒绝。
- [ ] **Step 1: 写失败测试**：写入后 POSIX 模式为 0600；`has` / `names` 不读内容；值为符号链接时 `resolve` 拒绝且错误不含路径以外的内容；`removeAll` 遇到指向外部的符号链接目录时拒绝且外部文件仍在；错误信息不含标记串。Windows 的 DACL 断言沿用 `apps/cli/test/secrets` 现有做法，只在 Windows CI 跑。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/secrets/mcp.test.ts` → FAIL。
- [ ] **Step 3: 实现**，复用 `saveSecretLine` / `readSecretLine`，不复制权限逻辑。
- [ ] **Step 4: 跑** → PASS；`npm run typecheck -w apps/cli`。
- [ ] **Step 5: Commit** `feat(cli): keep MCP credentials in private files outside the extension record`

### Task 3: MCP 配置记录

**Files:**
- Modify: `apps/cli/src/extensions/store.ts`
- Test: `apps/cli/test/extensions/store.test.ts`

**Interfaces:**
- `putMcpConfig(id, name, config: McpConfig)`：建或更新 `kind: "mcp"`、`provision: "managed"`、`source: "mcp:stdio"` 或 `"mcp:http"`、`revision` 为 `mcp.json` 内容的 sha256 前 12 位的记录；把 config 原子写进 `ownedDirectory(root, id)/mcp.json`。
- `readMcpConfig(id): McpConfig`：读回并重新经 `parseMcpConfig` 校验，文件被改坏时记录的 `availability` 为 `damaged`。
- `removeManaged` 对 `kind: "mcp"` 额外调用 `McpSecretStore.removeAll(id)`（store 接收一个可选的 `onRemove(id, record)` 回调，避免 store 直接依赖 secrets 模块）。
- [ ] **Step 1: 写失败测试**：新建、更新（revision 随内容变）、读回、`mcp.json` 被手改为非法时报 `damaged`、卸载后目录和凭据目录都不在、`index.json` 与 `mcp.json` 里没有标记串。
- [ ] **Step 2–4: 跑 FAIL → 实现 → 跑 PASS**（`npx vitest run apps/cli/test/extensions/store.test.ts`）。
- [ ] **Step 5: Commit** `feat(extensions): save stdio and HTTP MCP configs as managed records`

### Task 4: `McpSupervisor`：启动、连接、停止

**Files:**
- Create: `apps/cli/src/extensions/mcp/supervisor.ts`、`apps/cli/src/extensions/mcp/stdioTransport.ts`
- Modify: `apps/cli/src/github/client.ts` 仅在需要时把 `ExactEnvStdioTransport` 抽成可复用的通用传输（命令和参数从外部给）；GitHub 行为不变，现有 GitHub 测试原样通过。
- Create: `apps/cli/test/fixtures/fake-mcp-server.mjs`（stdio 与 HTTP 两种模式，可配置：列出 N 个工具、启动后挂起、启动后派生孙进程、对 HTTP 返回 401 或 302）
- Test: `apps/cli/test/extensions/mcpSupervisor.test.ts`

**Interfaces:**
- `new McpSupervisor({ nemaHome, store, secrets, ownedHelpers?, timeoutMs? })`
- `start(id): Promise<McpStatus>`、`stop(id): Promise<void>`、`status(id): McpStatus`、`closeAll(): Promise<void>`
- `McpStatus = { id, connection: McpConnection, tools: Array<{ name, schemaDigest }>, lastError: string | null }`，`schemaDigest` 是工具 `inputSchema` 规范化 JSON 的 sha256。
- stdio：注入了 `ownedHelpers` 就走它；没有时 POSIX 用 `detached: true` 并在停止时按进程组发 `SIGTERM`、宽限后 `SIGKILL`，与 `claude/adapter.ts` 一致。环境按 Global Constraints 精确构造，凭据此时才 `resolve`。
- HTTP：MCP SDK 的 Streamable HTTP 客户端传输，请求头里放解析后的凭据，`redirect: "manual"`，遇到 3xx 记为「连接异常」；401/403 记为 `needs-login`。
- 同一 id 的操作用一个 promise 链串行化；`stop` 在 `start` 进行中被调用时，先让 `start` 失败退出再停。
- [ ] **Step 1: 写失败测试**：
  - stdio 正常启动并列出工具，`schemaDigest` 稳定；
  - 启动超时：状态 `error`，进程已不在（POSIX 用 `process.kill(pid, 0)` 断言 ESRCH，含派生的孙进程）；
  - `stop`、`closeAll` 之后进程与孙进程都不在；
  - 子进程看到的环境只有允许的键（夹具把 `process.env` 的键名写到 stdout 的一个工具结果里），daemon 环境里放一个假 `NEMA_TEST_LEAK` 不应出现；
  - HTTP：200 正常；401 → `needs-login`；302 → `error` 且没有请求第二个地址；非回环 `http:` 在 `parseMcpConfig` 已被拒；
  - 任何状态、错误里没有标记串。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/extensions/mcpSupervisor.test.ts` → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑** → PASS；`npx vitest run apps/cli/test/github` 仍全过；`npm run typecheck -w apps/cli`。Windows CI 上用注入的 `createOwnedHelperScope` 再跑 stdio 用例，PR 描述里分开写 POSIX 与 Windows 的结果。
- [ ] **Step 5: Commit** `feat(extensions): start, connect and stop MCP servers under the owned-helper scope`

### Task 5: daemon RPC 与 hub 路由

**Files:**
- Modify: `apps/cli/src/extensions/handlers.ts`、`apps/cli/src/daemon/setup.ts`（关闭时 `supervisor.closeAll()` 加进汇总）
- Modify: `apps/hub/src/plugins.ts`（新增代理函数，不改 `enabledPluginTools`）、`apps/hub/src/uiApi.ts`
- Test: `apps/cli/test/extensions/handlers.test.ts`、`apps/hub/test/plugins.test.ts`、`apps/hub/test/uiApi.test.ts`

**Interfaces:**
- daemon：`extensions.mcp.save { id, name, config }`（已在运行的先停再存）、`extensions.mcp.start { id }`、`extensions.mcp.stop { id }`、`extensions.mcp.status { id }`、`extensions.mcp.setSecret { id, name, value }`（受 D-2 阻塞：选 P1 时不注册）、`extensions.mcp.clearSecret { id, name }`。
- 现有操作的连带行为：`extensions.setUse` 设为 `disabled` 时先 `stop`；`extensions.remove` 对 MCP 先 `stop` 再删；`extensions.list` 给 MCP 记录填 `mcp` 字段（连接状态取 supervisor 的内存状态，daemon 重启后都是 `disconnected`，不自动启动）。
- hub：`POST /extensions/mcp`、`POST /extensions/:id/mcp/start`、`POST /extensions/:id/mcp/stop`、`PUT /extensions/:id/mcp/secrets/:name`（D-2）、`DELETE /extensions/:id/mcp/secrets/:name`。返回值逐字段校验，形状不对按 #85 的做法报 502。hub 不记录 `PUT` 请求体，错误路径不回显请求体。
- [ ] **Step 1: 写失败测试**：每个 RPC 的成功与拒绝；停用和卸载会先停实例；所有响应 JSON 里没有标记串；回归：给 workspace 开着所有插件时，`enabledPluginTools` 的结果里没有任何 `mcp` 记录产生的工具（D-3）。
- [ ] **Step 2–4: FAIL → 实现 → PASS**；`npm run typecheck`；`npm test -- --maxWorkers=2`。
- [ ] **Step 5: Commit** `feat(extensions): add MCP config, credential and start/stop operations to daemon and hub`

### Task 6: 插件页（受 D-2 阻塞；等插件页 UI 线合并后做）

**Files:**
- Modify: `apps/web/components/PluginsPage.tsx`、`apps/web/lib/hub.ts`、`apps/web/messages/{zh,en,ja}.json`
- Test: `apps/web/test/PluginsPage.test.tsx`、`apps/web/test/i18n.test.tsx`

**Interfaces:**
- 「添加 MCP 服务器」表单：传输方式（stdio / HTTP）；stdio 填命令、参数（每行一个）、环境变量；HTTP 填地址、请求头。每个值选「普通值 / 凭据 / 环境变量」三种之一。
- 凭据字段是只写密码框，提交后清空，只显示「已配置 / 未配置」，可清除；选 P1 时改为显示 CLI 命令。
- MCP 行显示连接状态与工具数，提供「连接 / 断开」；工具清单可展开，只读，并注明「尚未交给 Agent」（D-3）。
- [ ] **Step 1: 写失败测试**：提交后的请求里凭据值只出现一次（发往 secrets 路由），页面状态与渲染结果里不再有它；三语键齐全；连接状态的五种文案。
- [ ] **Step 2–4: FAIL → 实现 → PASS**；`npm run lint -w apps/web`；`npm run build -w apps/web`。
- [ ] **Step 5: Commit** `feat(web): add and connect MCP servers from the Plugins page`

### Task 7: 文档

**Files:**
- Modify: `docs/reference.zh-CN.md`（扩展一节：MCP 配置格式、凭据存放位置、POSIX / Windows 停止方式的差别、工具尚未交给 Agent）、`docs/guide.{zh,en,ja}.md`、`README*.md` 中扩展管理那一条（两份英文 README 逐字节一致）
- Create: `changelog.d/extension-mcp-config.added.md`
- Modify: `ROADMAP.md` P2-06 的剩余项
- [ ] **Step 1:** `cmp README.md README.en.md`；docs-check 用 JSON 数组列出改动的文件 → 0 errors。
- [ ] **Step 2: Commit** `docs: describe MCP server configs and where their credentials live`

## 验收对照

| #75 / spec 要求 | 任务 |
| --- | --- |
| MCP 支持 stdio 与 HTTP 配置 | 1、3、5、6 |
| 凭据由本机保管，界面只得到已配置状态，不返回明文 | 2、5、6（标记串测试） |
| MCP 启停使用现有受管 helper，进程不遗留 | 4、5（Windows 走 owned scope；POSIX 走进程组，另记为独立门槛） |
| 来源安装与服务器连接是两个步骤 | 3（保存）与 4（连接）分开 |
| 程序版本、连接状态、登录状态分别展示 | 1、5、6 |
| 配置变更与卸载停止对应实例 | 5 |
| 工具经连接、schema 校验、命名空间、显式启用后才进 Agent | 本计划只做到连接与 schema 摘要；其余见 D-3 的后续计划 |

## Later plans

- MCP 工具交给 Agent：与 CX-02 一起做，按 D-3 的结论。
- 远程 MCP OAuth：CX-06。
- 按注册信息安装 MCP 包并生成启动配方。
- 发现并接入其他客户端的 MCP 配置（只读元数据，不复制密钥）。
- 若 D-1 选 A，以后单独评估系统凭据库作为 `McpSecretStore` 的另一实现。
