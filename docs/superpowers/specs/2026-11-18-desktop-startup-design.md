# 桌面启动速度与加载体验：剩余项与 0.3.1 范围

日期：2026-11-18。Issue：[Nema-Project/nema-room#186](https://github.com/Nema-Project/nema-room/issues/186)。产品判断标准：[Nema-Project/nema-room#45](https://github.com/Nema-Project/nema-room/issues/45)。前置设计：[启动窗口](2026-11-04-desktop-startup-window-design.md)、[启动剩余项（窗口侧）](2026-11-04-desktop-startup-remainder-design.md)、[启动剩余项：一个 Windows ACL 进程](2026-11-10-desktop-startup-remainder-design.md)。相关：[#188](https://github.com/Nema-Project/nema-room/issues/188)（启动基准，已关闭）、[#134](https://github.com/Nema-Project/nema-room/issues/134)（Node 去重，已关闭）、ROADMAP P1-10（进行中）。

**状态**：设计已定案。D-1 到 D-7 已于 2026-11-18 由维护者全部按本文推荐决定（逐项见下），实现按决定执行，不得自行更改。本文件不改生产代码，实施计划另行编写。

**设计所对照的 HEAD**：`04e098a`（`main`，v0.3.0 发布记录合并之后）。标为「已核对」的行为是在这个 SHA 上读代码得到的。

**来源说明**：#186 正文写于 `e0a5493` 时代，实测对象是已安装的 v0.2.1 桌面版（Windows 11 x64）。此后 #186 的大部分建议已经分片落地（v0.2.4 的 PR #213、v0.3.0 前的 PR #221/#222 等）。本文的任务是逐条核对 issue 的五个问题在当前 main 上还剩什么，并为 v0.3.1 切分范围；issue 中的毫秒数字不直接沿用，理由见「现状核实」各条。

## 如何服务 #45

#45 的判断标准：打开共享房间这一入口要可靠、可感知——用户能分清「在启动」「卡住」和「失败」，失败时留下可复现的证据。这不是新功能。#186 的主体（启动窗口、失败呈现、阶段进度、ACL 不阻塞主进程、web 与 DB 并行）已经服务于这一标准并已发布；本文剩余项只处理两件仍未闭合的事：一是等待时间的尾部（冷启动 DB、无记忆工作区时的一跳、首屏负载构成），二是证据的尾部（打包基准从未在真实平台上记录过数字，P1-10 因此一直挂在进行中）。缩短等待不得以放松私有文件校验为代价，见「安全不变量」。

## 前置工作已经决定和交付了什么

写本文前先说清三份既有材料，避免重复立项：

- **[2026-11-04 启动窗口设计](2026-11-04-desktop-startup-window-design.md)**（PR #213，v0.2.4 发布）已决定并交付：主窗口在 core 就绪前创建并显示，`backgroundColor` 跟随主题（浅色 `#ffffff`、深色 `#141311`）；**不设独立 splash 窗口**，同一窗口先加载主进程生成的 `data:` 启动文档，就绪后 `loadURL` 到启动链接；启动失败时错误写进该文档（错误标记 `startupShown`），模态 `showErrorBox` 只作兜底；web 的 HTTP 就绪与 `createLocalDb`、`startHub` 重叠，15 秒 web 预算从这段工作之后起算，daemon 在 web 就绪后才连接。该设计明确把 ACL 合并、冷启动 PGlite、渲染端改造、阶段进度回传列为范围外。
- **[2026-11-10 启动剩余项设计](2026-11-10-desktop-startup-remainder-design.md)** 已决定：Windows ACL 改为「每进程一个常驻 PowerShell helper、每次检查仍然执行」（方案 1），拒绝「校验结果缓存」（方案 3，语义放松）；冷启动 DB 的 D-1 选 **B**（不预置数据目录、不跳迁移、不开 `relaxedDurability`），依据是其在 Linux 主机上的实测——冷开销主要是 PGlite 初始化（中位 ready 1500ms），迁移只占约 102ms，预置 dump 在该主机上约省 1.0s 但要付 4.8MB 载荷与格式/恢复义务；Windows/macOS 的冷/热数字改由 CI 平台样本（`scripts/ci/startup-sample.mjs`）记录。该设计的实现即 PR #221（计划/规格）与 #222（supervisor worker 托管 ACL worker，含 PID 上报与有序拆解），已合入。
- **#188 已交付** `scripts/desktop/bench-startup.mjs`（`npm run desktop:bench --app <打包后的可执行文件>`）：用隔离的测试 home 启动打包应用，记录 Electron 侧 marks（`process-start`、`app-ready`、`ready-to-show`、`runtime-ready`、`did-finish-load`）、core 的 `startup-phase` 各阶段和 Windows ACL 调用行，给出冷/热样本。它是手工运行的工具，不进 CI。
- **#134 已交付**：桌面载荷不再打包一份重复的 Node，运行时 Node 改用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE=1`），载荷里留一份来源记录（`scripts/desktop/electron-node.mjs` 的 `runtimeNodeRecord`，含 Electron/Node 版本与 engines 校验）。issue 中「#134 落地后需要重新测量」的备注因此仍然有效——重新测量缺的正是打包基准数字，见工作流 W3。

## 现状核实（逐条对照 issue 五个问题）

### 1. 窗口要等 core 就绪才创建、没有启动画面 —— 已变化，已解决

当前 `apps/desktop/lifecycle.cjs` 的 `createMainWindow`（:290 起）在一个 async 块里先建窗口（`show: true`、主题 `backgroundColor`，:301-309），立即 `showStartup` 显示启动文档（:313），然后才 `await ensureCore(...)`（:315），就绪后在同一窗口 `loadURL(instance.launchUrl)`（:326）。失败时把错误文本写进启动文档并标记 `startupShown`（:330-343），`reportError` 对已标记的错误跳过模态对话框。issue 引用的 `lifecycle.cjs:192-209` 旧顺序已不存在。**结论：仍成立的只剩「没有独立 splash 窗口」这一字面描述，但那是 2026-11-04 设计的有意决定，不是缺口。**

### 2. core 启动完全串行 —— 已变化，大部分已解决

当前 `apps/local/src/runtime.ts` 的 `startLocalRuntime`：web 子进程在 `private-files` 之后立即 spawn（:510），其 HTTP 就绪 promise 与 `createLocalDb`（:528）、`startHub`（:531）重叠等待（:518-525 的注释与代码一致）；web 的 15 秒预算在 DB 与 hub 之后才开始计时；daemon 在 `await webReady` 之后才启动（避免 web 超时打断已领走的任务）；`assertWebAlive` 与 teardown 语义保留。仍串行的部分是本质依赖或低收益段：lease → private-files 在 web spawn 之前；hub 依赖 db 无法并行；daemon → gateway → publish 依次依赖前者。issue 的阶段表（冷 db 5.9s、热 db 1.1–1.9s、web 0.9s）测于 v0.2.1 且串行结构已变，**数字作废，需用当前基准口径重测，见 W3/W4**。issue 提到的 `begin` 之前约 820ms 模块加载是 tsx 开发态数字，打包态从未测过，同属 W3 缺口。

### 3. Windows ACL 每路径一次 PowerShell（约 300ms × 8 ≈ 2.7s）—— 已变化，已解决

当前 `apps/cli/src/secrets/permissions.ts` 的 `windowsAcl`（:372）不再 `spawnSync(powershell.exe)`：每进程一个常驻 helper——worker 线程持有 PowerShell 子进程与管道，主线程经 `SharedArrayBuffer` 同步等回复；supervisor worker 负责拆解顺序（stop → 杀进程树 → 确认退出 → terminate worker，#222）。`windowsAclHelperStarts()`（:362）可数启动次数。调用次数不变（启动就绪前仍是 8 次检查/保护，2026-11-10 设计已逐项点名），进程启动次数从 8 次降到每进程 1 次（父进程 + core 各一个 helper）。**语义未放松**：每次 `protectPrivatePath`/`assertPrivateAcl`/`openPrivateFile` 仍实际执行校验，无任何缓存（2026-11-10 设计方案 3 已否决）。issue 的 2.7s 是单台 Windows 11 机器上 v0.2.1 的旧账；当前每次调用的毫秒数由 CI 的 `startup-sample` 在 `windows-latest` 上持续记录（8 次调用总时长 + helper 启动数）。

### 4. 同步 PowerShell 阻塞 Electron 主进程、75ms 轮询失效 —— 已变化，已解决

两层都已处理：其一，ACL 调用本身不再是同步进程启动（见第 3 条），单次往返只是管道通信；其二，`ensureLocalRuntime` 的轮询已改（`apps/local/src/runtime.ts` :718-719、:754 的注释与代码）：75ms 轮询只做 stat，不再每次做私有文件校验——只在子进程报就绪、端口冲突，或描述文件出现时才发现实例，且出现时只校验一次。issue 实测的「discoverInstance 每次约 600ms」路径已不存在。

### 5. 渲染端：二次跳转、静态 import、纯「加载中」文字 —— 部分已变化，仍有剩余

已落地：启动链接带 `nema_workspace` cookie 时直接进入上次的工作区（ROADMAP P1-10 验收行已记录 `nema_workspace=ws_…` 进入 `/w/ws_…`）；`WorkspaceShell` 在列表返回前渲染骨架（`room-skeleton`，`apps/web/components/WorkspaceShell.tsx` :524），不再是纯文字；`AppSettings` 与 `WorkspaceSettings` 已改 `next/dynamic`（:12-13）。仍成立的剩余：

- 无记忆工作区时，`/` 仍先 `listWorkspaces()` 再 `router.replace('/w/<id>')`（`WorkspaceShell.tsx` :152、:200），一跳还在，只是被骨架遮住了大半感知。这里的「无记忆」指 localStorage 里没有记忆 ID（首次运行或记忆已清除），或记忆 ID 已失效（房间已删/归档，要等列表返回才确认并清除）；cookie 缺失本身不算——cookie 缺失但 localStorage 仍有有效 ID 时，shell 在列表返回前就已跳转（:159-169 的 effect 在 `workspaces` 尚为 null 时即 `router.replace`）。
- 首屏组件 `Chat`、`EntryDetail`、`KnowledgePanel`、`Sidebar` 仍是静态 import（:6-9）。它们是首屏内容，静态未必错；但 issue 点名的 v0.2.1 大 chunk（457KB 等）构成从未分析，#134 与其后的依赖变化后 chunk 现状也没有新数字。**先测量再决定拆不拆，见 W1。**

### 6. issue 验收建议的落实情况

issue 的四条验收建议里：启动画面 1s 内出现、失败在窗口内呈现、ACL 改动附「放宽后仍被拒绝」测试——都已由 PR #213/#222 的自动化测试与 P1-10 验收行覆盖；唯独「Windows x64、macOS arm64 各自用基准脚本记录优化前后的冷/热数字」从未执行：`desktop:bench` 需要打包安装包，本仓库的 CI 与开发 VM 都没有在真实平台上跑过它。按维护者 2026-11-16 的测试政策（桌面不做主动实机测试，验收靠基准脚本与 CI 平台 runner），这条验收口径本身需要改写，见 D-6 与「验收」。

## 工作流拆分

### W1 渲染端剩余（首屏负载与一跳）

- **做法**：先用现有构建产物分析首屏 chunk 构成（`apps/web` 构建输出即可，不需要真机），确认 457KB 级 chunk 的来源；只对非首屏面板（图表、工作包详情等当前跟随 `EntryDetail` 静态进入的部分）评估 `next/dynamic` 拆分。无记忆工作区的一跳不做 SSR 改造，只确认骨架覆盖与列表请求无重复发起。
- **预期收益**：首屏 JS 减少才有收益，具体数字以 chunk 分析为准；无据之前不承诺毫秒数。
- **风险**：低。拆分过度会把等待从启动挪到首次点击，分析必须区分首屏/非首屏。
- **依赖**：无。

### W2 冷启动 DB 复核（只评估）

- **做法**：取 `verify.yml` 平台 job 日志里 `scripts/ci/startup-sample.mjs` 的 JSON，读其 fresh-process 冷/热 `createLocalDb` 总时长，与 2026-11-10 设计在 Linux 主机上的数字（冷中位 1605ms、热中位 264ms，其中迁移约 102/61ms）并列记录在本 issue。注意单次运行每个平台只产一份冷样本，D-3 要用的中位数不能取自单份日志：须跨最近至少 5 次独立运行收集 `windows-latest` 与 `macos-latest` 各自的冷总时长，排序后取中间值（样本数为 5 时即第 3 个），热总时长同口径附记。若 Windows 冷开销显著高于 Linux（例如两倍以上），再单独立项讨论预置数据目录（2026-11-10 的 D-1 方案 A）及其恢复方案。
- **预期收益**：本版不产生速度收益，产出的是「改或不改」的依据数字。
- **风险**：无（只读 CI 日志与记录）。注意 CI runner 的冷数字含 WASM 首次编译，与用户机器同口径，但 runner 性能波动大，只看量级不看个位数。
- **依赖**：`startup-sample` 已在 `verify.yml` 平台 job 中运行（已核对，`.github/workflows/verify.yml` :86）。

### W3 打包基准的口径收尾

- **做法**：不在 CI 里新增打包+bench 的 job（打包耗时与产物分发成本高，且 CI runner 不是用户硬件，数字的代表性有限）。改为把 P1-10 与 #186 的验收口径正式改写为：Electron 侧行为由 lifecycle 自动化测试 + `desktop-mark` 打点覆盖；平台 DB/ACL 数字由 `startup-sample` 在 CI 平台 runner 持续记录（它只测 fresh-process 的 `createLocalDb` 冷/热总时长与 Windows ACL 微基准，不启动 core、不产 `startup-phase` 行）；core 各阶段时长来自 core 自身写到 stdout 的 `startup-phase` 行，由 `desktop:bench` 从 core 日志解析、由本地运行时测试解析断言，不是 `startup-sample` 的产物；`desktop:bench` 保留为手工工具，发布说明或 issue 中引用数字时必须注明机器与安装包 SHA，且不作为合并门槛。
- **预期收益**：P1-10 可以据此收尾，不再无限期挂着一条按现行政策不会执行的验收。
- **风险**：口径放宽是真实取舍——打包态的 Electron 启动、`requireSystemGit`、首帧时间将继续没有数字。本文把这点写明，而不是假装 sample 等于打包基准。
- **依赖**：维护者对 D-6 的决定。

### W4 启动链剩余串行段（只测量，不改造）

- **做法**：用 core 自身的 `startup-phase` 打点看 lease 与 private-files 两段的量级：`startLocalRuntime`（`apps/local/src/runtime.ts` :428、:503）把每个阶段连同 elapsed ms 写成 JSON 行到 stdout，`apps/local/test/runtime.test.ts` 的 `startupPhases` 助手正是解析这些行取每阶段 ms（该测试集由 CI 平台 job 承载），托管 core 场景下也可用 `NEMA_LOCAL_CORE_LOG` 把这份 stdout 落盘后读取；CI 的 `startup-sample` 不产 `startup-phase` 行，不作本项来源。两段在 web spawn 之前，issue 旧表里合计约 1.2–1.8s，但那是含旧 ACL 行为的 v0.2.1 数字。本版不改顺序：web spawn 提前到 lease 之前会动到实例所有权与 teardown 语义，收益未经证实不动。
- **预期收益**：无直接收益；若两段在新数字里仍占大头，下一版再立项。
- **风险**：无。
- **依赖**：无。

### 不再重开的工作流

启动画面形态（D-4）、阶段进度回传（D-5）、ACL 进程模型（D-2）均已决定并发布，本文不重新设计，只在「决定」里登记状态，防止后续会话重复立项。

## 决定（待维护者定案，均为本文建议）

### D-1 0.3.1 范围切分

**建议**：0.3.1 只纳入 W1（渲染端剩余，先测量后拆分）、W2（冷启动 DB 评估记录）、W3（基准口径收尾与 P1-10 状态更新）。W4 只测量不改造。ACL、启动窗口、进度回传、web/DB 并行均已发布，不进本版。
**理由**：#186 的主体已经关闭在 v0.2.4–v0.3.0 的各分片里；把已完成项再排进 0.3.1 只会让版本范围失真。剩余三项都是小而可独立验收的工作，正好与 #132（轻量化发布，已排 v0.3.1）同量级搭载。

**状态：已决定（2026-11-18，维护者按推荐定案）：0.3.1 只纳入 W1（渲染端剩余，先测量后拆分）、W2（冷启动 DB 评估记录）、W3（基准口径收尾与 P1-10 状态更新）；W4 只测量不改造；ACL、启动窗口、进度回传、web/DB 并行均已发布，不进本版。**

### D-2 ACL 批量化是否进本版

**建议**：不进，且不再提「批量化」。已落地的形态是「合并进程、不合并校验」：一次启动 8 次校验仍逐次执行，只是共用一个常驻 PowerShell 进程（2026-11-10 设计方案 1，PR #222）。把多次校验合并成一次调用（旧方案 2 的方向）会让 create-then-protect 的路径被迫分波，且校验粒度变粗的风险需要重新论证，收益（再省几次管道往返）远小于 ACL helper 已经拿到的收益（省掉 6–7 次进程启动）。
**理由**：速度的大头已经拿到；剩下的要拿必须动安全语义的粒度，不值。

**状态：已决定（2026-11-18，维护者按推荐定案）：不进本版，且不再提「批量化」；已落地的形态是「合并进程、不合并校验」——一次启动 8 次校验仍逐次执行、共用一个常驻 PowerShell 进程——即为定案，不合并校验、不做任何校验结果缓存。**

### D-3 冷启动 DB：只评估还是做改造

**建议**：只做评估（W2）。沿用 2026-11-10 的 D-1 选 B 作为当前决定，用 CI 平台数字复核一次并把数字记回 #186；只有当 `windows-latest` 的冷 `createLocalDb` 中位（口径见 W2：跨至少 5 次独立 CI 运行收集的冷样本，排序取中间值）量级明显高于 Linux 数字（建议阈值：两倍）时，才另行立项预置数据目录。
**理由**：已测证据显示冷开销主要是 PGlite 初始化而非迁移，预置目录在 Linux 主机上只省约 1.0s，却引入模板与 PGlite 版本/迁移集绑定、半成品目录恢复、载荷体积三项长期义务。没有 Windows 数字之前不付这笔账。

**状态：已决定（2026-11-18，维护者按推荐定案）：只做评估（W2），不做改造；沿用 2026-11-10 的 D-1 选 B（不预置数据目录、不跳迁移、不开 relaxedDurability）；只有当 windows-latest 的冷 createLocalDb 中位（口径见 W2：跨至少 5 次独立 CI 运行收集的冷样本，排序取中间值）量级明显高于 Linux 数字（阈值：两倍）时，才另行立项预置数据目录。**

### D-4 启动画面：独立窗口还是同窗口

**建议**：维持已决定并发布的同窗口方案（主窗口先行显示 + `data:` 启动文档 + 就绪后同窗口 `loadURL`），本版不重开。
**理由**：2026-11-04 设计已比较过独立 splash 的代价（双窗口焦点/关闭语义、主题同步多一处），同窗口方案已在 v0.2.4 发布且验收行完整。重开需要新证据，当前没有。

**状态：已决定（2026-11-18，维护者按推荐定案）：维持已决定并发布的同窗口方案（主窗口先行显示 + `data:` 启动文档 + 就绪后同窗口 `loadURL`），不设独立 splash 窗口，本版不重开。**

### D-5 进度回传是否本版做

**建议**：不做，因为已经做了。`ensureCore` 的 `onStartupPhase` 回调（`apps/desktop/lifecycle.cjs` :150-152、:315-319）把 core 的 `startup-phase` 映射为启动文档里的阶段文案（`STARTUP_PHASE_DETAIL`，:95-104），core 侧经 `process.send` 回报（`apps/local/src/runtime.ts` :407-410）。issue 里列为「第二阶段」的这项已随后续分片落地。剩余的只是文案层小事（固定英文文案、无耗时显示），不单独立项。
**理由**：登记状态即可；把已完成项写进版本范围会重蹈 D-1 要避免的覆辙。

**状态：已决定（2026-11-18，维护者按推荐定案）：不做，因为已经做了——阶段进度回传（`onStartupPhase` 回调把 core 的 `startup-phase` 映射为启动文档阶段文案）已随后续分片落地并发布；本项只登记状态，无本版工作。**

### D-6 打包基准的验收口径

**建议**：正式改口径——#186 与 P1-10 的验收以「基准脚本 + CI 平台样本 + 自动化测试」为准（见「验收」），`desktop:bench` 打包数字改为手工可选、引用时注机型与 SHA。P1-10 在 W1–W3 完成后据此改为已完成，附一句诚实限定：打包应用在真实用户硬件上的冷/热数字仍未采集，那是按维护者测试政策主动放弃的证据，不是遗漏。
**理由**：现行政策（2026-11-16）明确桌面不做主动实机测试；继续把 P1-10 挂在一条政策上不会执行的验收上，只会让路线图长期失真。

**状态：已决定（2026-11-18，维护者按推荐定案）：正式改口径——#186 与 P1-10 的验收以「基准脚本 + CI 平台样本 + 自动化测试」为准（见「验收」），`desktop:bench` 打包数字改为手工可选、引用时注机型与 SHA；P1-10 在 W1–W3 完成后据此改为已完成，并附诚实限定：打包应用在真实用户硬件上的冷/热数字仍未采集，那是按维护者测试政策主动放弃的证据，不是遗漏。**

### D-7 无记忆工作区时的一跳

**建议**：保留现有 cookie 记忆路线，不做根页面 SSR/服务端重定向改造。本版只做 W1 里的确认性工作（骨架覆盖、无重复请求）。
**理由**：有记忆时已直达 `/w/<id>`；无记忆只发生在首次运行、换机或房间被删之后，是一生一次量级的成本，为它改渲染架构不划算。

**状态：已决定（2026-11-18，维护者按推荐定案）：保留现有 cookie 记忆路线，不做根页面 SSR/服务端重定向改造；本版只做 W1 里的确认性工作（骨架覆盖、无重复请求）。**

## 安全不变量

ACL 校验语义不得放松，这一点在 2026-11-10 设计里已论证过一次，本文沿用并收紧为验收可查的四条：

1. **每次打开仍校验。** `openPrivateFile`/`openPrivateFileChecked` 每次调用都实际执行 ACL 校验；任何「这个路径刚校验过」的缓存（按路径、按进程、按启动阶段）都不允许。论证方式：威胁模型里，同一进程生命周期内文件 DACL 被第三方放宽正是校验要抓的变化，缓存等于把检查点之间的窗口变成盲区——2026-11-10 设计否决方案 3 的理由不变。
2. **允许集合不变。** 仍只允许当前用户、SYSTEM、Administrators；reparse point、外部 owner、owner 读不到、任何其他 Allow 条目都拒绝，错误文案仍为固定的 `cannot verify private Windows ACL` 且不回显路径内容之外的数据。
3. **失败即关闭（fail closed）。** helper 超时、管道断裂、子进程死亡、协议错误都让本次调用失败，绝不降级为「跳过校验继续打开」；拆解顺序（stop → 杀树 → 确认退出 → terminate worker，#222）不得改动，旧 helper 未确认退出前不得启动替代 helper——否则一个卡住的 PowerShell 可能在替代者启动后才修改 ACL。
4. **本版工作不触碰校验路径。** W1–W4 没有一项需要改 `permissions.ts`、`instance.ts` 的校验时机或 `runtime.ts` 的 private-files 阶段；若实施中发现必须动，先停下来另写安全论证并单独评审，不并入本版顺手改。

## 验收

全部证据按维护者 2026-11-16 的测试政策产生：**不安排真实 Windows/macOS 硬件测试**；数字来自基准脚本与 CI 平台 runner（`windows-latest`、`macos-latest`），行为来自自动化测试。

- **W1**：`apps/web` 构建产物的 chunk 清单前后对照随 PR 给出（首屏入口 chunk 的字节数变化可查）；被拆分的非首屏面板有按需加载的组件测试或构建证据；`WorkspaceShell` 骨架与直达行为的既有测试保持全绿。
- **W2**：#186 上留一条评估记录，含按 W2 口径从至少 5 次 `verify.yml` 运行收集的 `startup-sample` 冷/热 `createLocalDb` 中位数（`windows-latest` 与 `macos-latest`）、与 2026-11-10 Linux 数字的对照、以及「触发/不触发预置目录立项」的结论。没有这条记录，W2 不算完成。
- **W3**：ROADMAP P1-10 的验收行改写为新口径并注明打包数字的主动放弃；#186 按新口径逐项对账后关闭或保留明确的剩余项。
- **回归线（既有能力不许退）**：窗口在 `ensureLocalRuntime` 返回前已显示且背景色随主题；启动失败时错误出现在启动窗口文档内而非只有模态框；子进程回报 `db` 阶段时启动文档显示对应文案；web 被挡住时 `startup-phase` 的 `db` 可早于 `web`；Windows 上一次启动内 ACL helper 启动次数为每进程 1 次且 8 次校验逐次执行，放宽 ACL 后再次打开仍抛 `cannot verify private Windows ACL`（既有测试集，CI 平台 job 承载）。
- **启动画面时限**：issue 的「点击后 1s 内出现启动画面」保留为目标而非门槛——它只能在打包应用上测，本版以 lifecycle 测试中「窗口先于 core 就绪显示」的既有断言为据，并在 W2/W3 的记录里注明该时限未在真实硬件上复测。

## 不做的事

- 不做独立 splash 窗口（D-4）、不做 ACL 校验合并或缓存（D-2、「安全不变量」）、不预置 PGlite 数据目录、不跳迁移、不开 `relaxedDurability`（D-3）。
- 不把 core 迁到 `utilityProcess` 托管（issue 已与 #134 结论对齐：core 必须能独立于 Electron 运行）。
- 不在 CI 里新增打包并运行 `desktop:bench` 的 job（D-6）。
- 不改 `release` 流程、不动 ROADMAP 的版本映射之外的行；P1-10 的文字更新随 W3 的实现 PR 一起做。
