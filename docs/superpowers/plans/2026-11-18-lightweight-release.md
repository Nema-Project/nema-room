# 轻量化发布实施计划：Graphify 按需下载与离线组件包

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were given authorizes it; otherwise leave changes for supervisor review.

**目标：** 桌面安装包不再包含 Graphify 运行环境（约 122 MiB，占 payload 约 62%）。Graphify 改为第一次真正用到图谱功能时、经用户确认大小后按需下载：沿用 `graphify-lock.json` 的 url 与 sha256，逐文件先验哈希（与 `size`）再解压，装到 `~/.nema/runtime/graphify/<lock-hash>/`，原子切换并保留上一版。同一套安装器供桌面、npm、Compose 三种形态共用，npm/Compose 用户（包括 Linux 宿主机）第一次能用上 Graphify；离线环境用 `nema components pack` 制作、`nema components import` 导入的组件包，导入只认随主程序发布的受信锁。下载失败或被拒绝时只有图谱功能不可用，原因如实呈现。

**架构：**

- 锁仍是组件的唯一事实来源：`scripts/desktop/graphify-lock.json` 补每个文件的 `size`，target 从两个扩到四个（新增 `linux-x64`、`linux-arm64`）；制锁流程在 `scripts/desktop/fetch-graphify.mjs`。运行时读的锁随主程序资源分发（桌面 payload 与 npm 包内各一份，内容一致，有测试断言）。
- 共享组件安装器住在 `apps/cli/src/components/`：CLI、宿主机 daemon 与桌面形态的 daemon 本来就是同一份 CLI 代码（桌面经 `apps/local` 拉起同一 daemon），放这里三方共用，不新开包。安装器负责：算 lock-hash、按 §4 规则下载（镜像/代理/CA/重试/取消）、逐文件 sha256+size 校验、staging 组装、自检、原子改名（verify-or-replace 恢复）、写 `current.json`、保留上一版。
- `apps/cli/src/repos/graphify.ts` 的解析顺序改为：`NEMA_GRAPHIFY_BIN` → 组件仓库里 lock-hash 与当前锁一致的 active 版本 → 随包 `tools/graphify`（仅过渡期旧 payload）→ 未安装。未安装、锁不一致、上次失败是三个不同的状态，向上如实报告，不互相冒充。
- 首次使用 UX 走既有链路：daemon 经 RPC 向 hub 报告组件状态并发起安装，hub 透传，web 弹确认框（大小取自锁内 `size` 汇总）并显示进度与失败原因；CLI 侧用 `nema components install graphify`（打印大小、等待确认、`--yes` 跳过）。应用启动与打开工作区不触发下载。
- 桌面 staging 不再把 Graphify 组装进 payload（`scripts/desktop/stage-runtime.mjs`），发布检查新增「payload 不含 `tools/graphify`」断言；`fetch-graphify.mjs` 保留，供制锁、记 `size` 与 `components pack` 复用。
- 离线包只装原始归档（python 归档与全部 wheels，逐字节与上游一致）加一份不可信的 `manifest.json` 索引；组装只在导入端由安装器完成，与在线路径共用同一条组装与校验代码。

**技术栈：** Node 22、TypeScript、Vitest、node:test（scripts）、Next.js 与 next-intl 文案文件、Electron 打包脚本（`scripts/desktop/`）、GitHub Actions 桌面发布流程。

**Spec：** [轻量化发布设计](../specs/2026-11-18-lightweight-release-design.md)。产品判断标准：[#45](https://github.com/Nema-Project/nema-room/issues/45)。Issue：[#132](https://github.com/Nema-Project/nema-room/issues/132)。

**如何服务 #45：** Graphify 是把代码仓变成可查询知识图谱的工具，是共同理解的生产者之一。核心完整安装、大组件按需获取：安装门槛下降，成本只落在第一次真正用到图谱功能的人身上；npm/Compose 用户第一次能用上它；每个下载字节仍由锁的 sha256 钉住，证据链不比随包弱。离线包只认随主程序发布的受信锁，能被执行的每个字节都可溯源到一把经锁校验的归档——推断或侧载的东西不冒充有出处的事实。

**规模估计：** 9 个任务（8 个实现与文档任务，1 个单独授权的最终验收）。任务 1（锁）与任务 2（安装器）是地基；任务 5（payload 瘦身）必须等任务 3（解析改造）落地后才能合，否则新版桌面包会找不到 Graphify。

## 全局约束

- **D 项已定案，不得自行更改**（spec，2026-11-18，全部按推荐）：
  - D-1 A：只做大的可选组件 Graphify；不做整个应用在线安装，不拆 npm 平台包。
  - D-2 B：精简安装包 + 可侧载离线组件包；只发一份安装包。
  - D-3 A：上游直连 + 镜像变量，Nema 不重新分发、不镜像、不中转；换源只改地址，sha256 仍按锁校验。
  - D-4 B：第一次用到时提示大小并确认后下载；不在首次启动自动下载，不只藏在设置页。
  - D-5：已由 #134 解决（Node 去重），本计划不涉及。
  - D-6 A：Agent CLI 不打包、只检测并引导；不调用官方安装器。本计划只在状态/设置页把既有检测结果做显式（随任务 4 的设置页「组件」区顺带呈现），不新增安装行为。
- **信任链只有一条：** 能被执行的每个字节都必须来自一把经受信锁（随主程序发布的 `graphify-lock.json`）校验过 sha256 与 `size` 的归档。在线下载与离线导入共用同一条校验与组装路径；离线包的 manifest 只是不可信索引，它里面的任何哈希都不作数，不设「组装后逐文件哈希表」这类信任输入。包内若有预组装目录或脚本，一律忽略、永不执行。
- **未过全量校验与自检的目录永不被标为 active。** 任何一步失败删 staging，已 active 的旧版不受影响；lock-hash 与当前主程序锁不一致的旧版视为未安装，不拿旧版凑数，文案与此一致。
- **不静默下载：** 无 UI 的调用返回明确状态并提示 `nema components install graphify`；`NEMA_GRAPHIFY_OFFLINE=1`（或配置 `components.offline`）时禁止一切下载尝试。应用启动、打开工作区等路径不触发下载。
- **下载参数（本计划定，spec 授权实施计划定上限）：** 单文件失败自动重试最多 3 次，指数退避 1s→2s→4s；单次请求空闲超时 60 秒；不做断点续传，取消后清理 staging。安装前检查目标盘可用空间：不足「下载总量 + 按锁内 size 汇总估算的解压体积」时不开始下载，明确提示差额。
- **Windows 启动器（spec 留给实施计划定）：** 用户机器上不要求编译器。Windows launcher 是 Nema 自己的小二进制（`scripts/desktop/graphify-launcher.c`），不属于上游归档：仍在构建期由现有流程编译，作为随主程序资源分发的小资产（桌面 payload 与 npm 包内各一份，KB 级），组装时由安装器放入组件目录；macOS 与 Linux 沿用 shell 脚本形态（`fetch-graphify.mjs` 已导出 `POSIX_GRAPHIFY_LAUNCHER`，安装器写出同一文本）。launcher 的字节来自随主程序发布的资源，与锁文件同级信任，不经下载。
- **子命令命名（spec 未决项，本计划定）：** `nema components status`、`nema components install graphify`、`nema components pack graphify`、`nema components import <file>`。设置页镜像字段与环境变量的优先级按 spec 已定的「环境变量优先」，UI 不提供覆盖（关闭该未决项）。
- **Linux 只支持 glibc：** musl 环境（如 Alpine）视为不支持的平台，组件状态如实报告「平台不支持」，不尝试下载。
- 测试用临时数据目录、本地假源与假二进制；不用真实 `~/.nema`，不访问真实上游，不调用真实模型。
- 文档对齐（AGENTS.md）：四份 README（`README.md` 与 `README.en.md` 逐字节相同）、三份 `docs/guide.{en,zh,ja}.md`、每条新 web 文案进 `apps/web/messages/{en,zh,ja}.json` 三份、一份 `changelog.d` 片段。

## 审查重点

- 任务 1：锁内 `size` 与实际下载字节数逐项一致；Linux 两个 target 的每个 wheel 都有 manylinux 变体且 url/sha256/size 齐全；四 target 的 lock-hash 定义同一套规范化规则。
- 任务 2：篡改任一字节必须整次作废且不产生 active；「已改名、未写 current.json」这一点中断后重试必须自愈（复用或替换），不许要求手工删目录；改坏已落盘目录里的一个文件后重跑，坏目录被识别并替换、永不被激活。
- 任务 3：解析顺序与状态区分。尤其 `apps/local/src/runtime.ts` 现在写死传 payload 内的 graphify bin——改后桌面 daemon 不得再指向不存在的随包路径；lock-hash 不一致时不得回退到旧版组件。
- 任务 4：确认弹窗显示的大小与锁内 `size` 汇总一致；拒绝后不反复弹窗；失败只禁用图谱功能，无全局报错。
- 任务 6：按 spec §5 的篡改用例——「改过的启动器（替换归档形式）+ 与之自洽的 manifest」必须导入失败且不产生 active 目录；另附预组装目录的形态按规则忽略、永不执行（断言 active 里的启动器来自安装器）；归档集合与受信锁当前 target 条目恰好相等，多一个少一个都拒绝。
- 任务 5：payload 断言真的能拦住回归（把 graphify 塞回 staging 时发布检查变红），而不只是数字变小。

---

### 任务 1：锁再生——`size` 字段与 Linux 目标

**Spec：** §1（组件模型与锁）、§8（`fetch-graphify.mjs` 保留供制锁与记 size）。

**文件：** `scripts/desktop/graphify-lock.json`、`scripts/desktop/fetch-graphify.mjs`（导出 `graphifyLock` 与 `fetchGraphify`，制锁/下载逻辑所在）、`scripts/desktop/graphify.test.mjs`、`scripts/desktop/graphify-languages.test.mjs`（语言集不变，确认仍绿）、新增锁分发一致性测试（放 `scripts/desktop/graphify.test.mjs` 或 CLI 侧测试，见下）。

**接口：**

- 锁条目每个文件（python 条目与每个 wheel）在现有 `file`/`url`/`sha256` 之外补 `size`（字节数，整数）。
- target 键仍为 `${platform}-${arch}`，共四个：`win32-x64`、`darwin-arm64`、`linux-x64`、`linux-arm64`。Linux 两项与桌面 target 走同一制锁流程：CPython 取 python-build-standalone 同一钉住版本（`20261026`）的 `x86_64-unknown-linux-gnu` 与 `aarch64-unknown-linux-gnu` install_only 构建；wheels 取同一依赖集的 manylinux 变体，只保留与现有 target 相同的 16 种 tree-sitter 语言集。
- `<lock-hash>`：对当前平台 target 条目（python 条目 + wheels 数组，含 url、sha256、size）做规范化 JSON 序列化后的 sha256 十六进制全串。规范化规则（键排序、数组保序）在本任务里以代码定死（`scripts/desktop/fetch-graphify.mjs` 导出或 scripts 侧共享函数），任务 2 的运行时实现必须与它逐字节一致——用同一组夹具向量在两侧测试里各断言一遍。
- 锁的运行时分发：构建/打包时把 `graphify-lock.json` 复制为 CLI 包内资源（桌面 payload 与 npm 包各一份）。落点与读取方式在实现时按现有资源约定定（参考 `apps/local` 读 build identity 的方式与 CLI 包的 `files` 配置），并有测试断言两份与 `scripts/desktop/graphify-lock.json` 逐字节一致，防漂移。

- [ ] 先写失败测试（`scripts/desktop/graphify.test.mjs`）：四个 target 齐全；每个文件条目都有正整数 `size`；同一 target 内文件名不重复；lock-hash 夹具向量（给定固定条目 JSON，期望固定哈希串）。
- [ ] 运行 `node --test scripts/desktop/graphify.test.mjs`，确认新断言失败。
- [ ] 扩展制锁流程：下载 Linux 两项的 python 与 manylinux wheels，逐项钉 url、sha256 并把实际字节数写回 `size`；既有两项一并补 `size`（以实际下载为准，不手填）。CI 校验锁内 `size` 与实际下载一致（沿用现有锁校验入口，补 size 断言）。
- [ ] 实现锁分发复制与一致性测试；确认桌面 staging 与 npm pack 各带一份锁。
- [ ] 重跑 `node --test scripts/desktop/graphify.test.mjs scripts/desktop/graphify-languages.test.mjs scripts/desktop/fetch-tools.test.mjs` 与新增一致性测试，全部通过。注意：本机无 Docker/网络受限时，真实下载制锁这一步要在能联网的环境跑，跑不到的部分在 PR 里如实标注，不拿手填数字冒充实测。

### 任务 2：共享组件安装器模块

**Spec：** §3（安装布局与原子切换、verify-or-replace）、§4（下载源、镜像、代理与 CA）、§6（失败降级）。

**依赖：** 任务 1（锁格式与 lock-hash 定义）。

**文件：** 新增 `apps/cli/src/components/`：`lock.ts`（读随包锁、取当前平台 target、算 lock-hash、汇总大小）、`download.ts`（带代理/CA/镜像/重试的下载）、`install.ts`（staging 组装、自检、原子切换、清理）、`store.ts`（`current.json` 读写、组件状态查询）、`types.ts`（状态与进度事件类型）。测试新增 `apps/cli/test/components/`（或就近的 `apps/cli/test/components.test.ts` 一组）。下载实现参考 `apps/cli/src/extensions/install.ts` 既有的「锁 + 逐文件哈希 + 进度/取消」模式，不另起炉灶。

**接口：**

- `componentStatus(env?): Promise<ComponentStatus>`，状态至少区分：`installed`（含 lock-hash 与版本信息）、`not-installed`、`lock-mismatch`（装过但与当前锁不一致）、`failed`（含原因枚举：`network` / `proxy` / `hash-mismatch` / `self-check` / `unsupported-platform` / `offline` / `disk-space` 与人类可读 detail）、`installing`（含进度）。
- `installComponent(name, { confirm?, onProgress?, signal? }): Promise<ComponentStatus>`：只实现 `graphify` 一个组件名，未知组件名报错。进度事件含已下载/总量字节与当前文件名；`signal` 取消后清理 staging 并回到安装前状态。
- `componentBin(name, env?): string | null`：返回 active 且 lock-hash 与当前锁一致时的启动器路径，否则 null（供任务 3 的解析改造调用）。
- 下载规则（spec §4）：默认直连锁内 url；`NEMA_GRAPHIFY_PYTHON_MIRROR` 替换 python 条目 url 的来源前缀，`NEMA_GRAPHIFY_PYPI_BASE` 替换 wheels 的 files.pythonhosted.org 前缀；遵循 `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`，桌面形态可复用 #242 `proxyEnv` 的同一组变量（`apps/cli/src/config.ts` 的配置语义）；认 `NODE_EXTRA_CA_CERTS` 与 `SSL_CERT_FILE`。Node 内置 fetch 不读代理变量，下载器显式处理（用 undici 的 ProxyAgent / EnvHttpProxyAgent 或等价做法，实现时按仓库现有依赖定）。重试与超时按全局约束。
- 安装流程（spec §3）：下载到 `~/.nema/runtime/graphify/<lock-hash>.staging/` → 逐文件 sha256 与 `size` 校验（任一不符整次作废）→ 解压 → 放入启动器（Windows 用随主程序资源的预构建 launcher，POSIX 写 shell 脚本）→ 自检（启动器可执行且 `python -m graphify --version` 成功）→ 改名为 `<lock-hash>` → 原子改写 `current.json`（`{ "active": ..., "previous": ... }`）。改名目标已存在时走 verify-or-replace，且复用必须先过字节级核对、核对通过前不许执行已存在目录里的任何东西：锁只钉归档字节、没有组装后逐文件哈希表，完整性核对的口径因此定为——把已存在目录与本次刚由经锁校验的归档组装出的 staging 逐文件比对（文件集合恰好相等，且每个文件的 sha256 与 `size` 都一致；启动器按随主程序资源或安装器写出的规范字节比对）；全部一致才视为同一把已验归档的组装，删 staging、跳过改名、直接写 `current.json` 复用，自检结论用本次 staging 已通过的那次，不另跑已存在目录的启动器。任一文件缺失或不一致即整目录判无效、走替换；替换不得先毁掉 `current.json` 仍指向的目录：已存在目录恰为 current 记着的 active/previous 时，先把它改名到一旁的备份名（如 `<lock-hash>.replaced-<随机后缀>`），再把 staging 改名到位并原子改写 `current.json`，两步都成功后才删备份；改名或写指针任一步失败，则清掉未完成的 staging、把备份改回原名，`current.json` 保持原样、旧版继续可用。不被 current 指向的孤儿目录可直接整目录删除后改名到位。
- 保留策略：保留 active 与 previous 两版，下一次成功安装后清理其余 `<lock-hash>` 目录。
- 安装前磁盘空间检查与离线开关（`NEMA_GRAPHIFY_OFFLINE=1` / 配置 `components.offline`）按全局约束；musl 平台直接报 `unsupported-platform`（以 libc 检测为准，实现时按 Node 既有报告方式定）。

- [ ] 先写失败测试：
  - lock-hash 与任务 1 的夹具向量一致；未知平台/ musl 报告 `unsupported-platform`。
  - 用本地假源（本地 HTTP 服务或注入的 fetch 替身）走通完整安装：目录落 `<lock-hash>`、`current.json` 指向它、自检通过、状态变 `installed`。
  - **篡改字节：** 假源把任一文件改一个字节（sha256 或 size 对不上），安装失败、不产生 `<lock-hash>` 目录、`current.json` 不变、状态为 `failed` 且原因 `hash-mismatch`。
  - **中途中断：** 下载中途取消/杀掉，staging 被清，已有 active 版本仍可执行（用假二进制断言 `componentBin` 仍指向旧版）。
  - **中断恢复（spec 验收项）：** 在「staging 已改名为 `<lock-hash>`、`current.json` 尚未写入」这一点中断（测试里直接构造该目录状态），再次安装必须成功并以该版为 active，不要求手工删目录；把已落盘 `<lock-hash>` 目录改坏一个文件后重跑，坏目录被识别并替换、不得被激活。复用判定另测：已存在目录与本次 staging 逐文件一致（集合、sha256、`size` 全对）才走复用，且断言其假启动器在核对通过前零执行（复用不靠跑它自检）；已存在目录恰为 active 且被判无效时，注入「staging 改名到位失败」，断言 `current.json` 不变、旧目录被备份恢复且仍可执行，替换与指针更新都成功后备份才被清理。
  - 镜像变量：两个镜像变量指向本地假源时，全程不访问上游域名且校验通过；假源给错字节时校验失败。
  - 代理变量被下载器 honor（假代理断言请求经过它）；离线开关打开时零下载尝试、直接报 `offline`。
  - 保留策略：连续装三版后只剩 active 与 previous。
- [ ] 运行新增测试，确认失败。
- [ ] 实现 `lock.ts`、`download.ts`、`install.ts`、`store.ts`，重跑测试至全绿；再跑 `npm run typecheck -w apps/cli` 与 `npx vitest run apps/cli/test/repos`（确认没碰坏既有 graphify 调用）。

### 任务 3：graphify 解析改造与状态呈现

**Spec：** §3（运行时查找顺序）、§5 现状第 5 条的替代、§6。

**依赖：** 任务 2（`componentBin` 与 `componentStatus`）。

**文件：** `apps/cli/src/repos/graphify.ts`（`packagedGraphifyBin` :44、`INSTALL_HINT`、`graphifyInstallStatus` :207）、`apps/cli/src/repos/handlers.ts` 与 `apps/cli/src/repos/indexState.ts`（调用方，确认错误呈现）、`apps/cli/src/daemon/setup.ts`（`checkGraphify` 与 graphify opts 注入）、`apps/local/src/runtime.ts`（:556 现在写死传 payload 内 `tools/graphify` 路径）、`apps/cli/src/doctor.ts`（graphify 检查项）、测试 `apps/cli/test/repos/` 与相关 daemon/doctor 测试。

**接口：**

- `packagedGraphifyBin` 改为按 spec §3 顺序解析：`NEMA_GRAPHIFY_BIN`（显式覆盖，最优先）→ 组件仓库 active（lock-hash 与当前主程序锁一致才算）→ 随包 `tools/graphify`（过渡期旧 payload）→ 未安装。保留「不查 PATH」的既有原则。
- 状态分开报告：把今天单一的 `INSTALL_HINT`（「随包的 Graphify 运行环境缺失」）换成与任务 2 `ComponentStatus` 对齐的结果——未安装、锁不一致（视为未安装并提示走安装流程）、上次失败带原因。`graphifyInstallStatus` 在此之上实现，不再靠比对错误字符串判断。
- 图谱调用（索引构建/查询）在未安装时返回明确的「组件未安装」状态给 hub，而不是含糊的执行失败；daemon 无 UI 时按 spec §2 提示 `nema components install graphify`。
- `apps/local/src/runtime.ts` 不再写死 payload bin：桌面 daemon 改为不传 `bin`（走 CLI 统一解析），或传组件仓库解析结果；二选一在实现时定，但结果必须是新版 payload（无 `tools/graphify`）下桌面图谱功能走组件仓库。

- [ ] 先写失败测试：四种解析顺序各一例（env 覆盖优先于组件仓库；组件仓库优先于随包；锁不一致时不返回旧版组件路径；全无时报告未安装而非随包路径）；`graphifyInstallStatus` 对未安装/锁不一致/已装三态返回不同结果；doctor 输出区分三态。
- [ ] 运行测试确认失败，实现后重跑至全绿；跑 `npm run typecheck` 与 `npx vitest run apps/cli/test` 的相关子集（repos、daemon、doctor）。

### 任务 4：首次使用 UX（确认、进度、失败降级、设置页入口）

**Spec：** §2（下载时机与确认 UX、D-4 = B）、§6（失败降级与提示）、§9（Agent CLI 检测呈现，顺带）。

**依赖：** 任务 2、任务 3（状态与安装 RPC）。

**文件：** `apps/cli/src/daemon/`（组件状态/安装的 RPC 面，随 `setup.ts` 的既有注入方式）、`apps/hub/src/daemonRpc.ts`（RPC 透传与超时口径，注意图谱调用本身的长超时注释）、hub 侧组件状态路由（按现有 hub 路由组织，实现时定落点）、`apps/web` 的设置页「组件」区与图谱入口组件（图谱构建/查询的触发点，实现时按现有组件定位）、`apps/web/messages/{en,zh,ja}.json`（全部新文案三语齐全）、对应 web 测试与 hub 测试。

**接口与行为：**

- 触发点只有两个：第一次真正需要执行 graphify 的调用（图谱构建/查询），与设置页「组件」区的手动入口。启动、打开工作区不触发。
- 确认框写明：组件名、下载总大小（锁内 `size` 汇总，与任务 1 的数据一致）、安装位置（`~/.nema/runtime/graphify/`）、下载来源域名。确认后才开始下载；进度显示已下载/总量与当前文件，可取消；失败按原因分别成文案（网络、代理、哈希不一致分开写），并给「重试」与「导入离线包」两个出口。
- 拒绝或未确认：图谱入口显示「未安装」与安装按钮，同一版本只在用户主动触发功能时提示，不反复弹窗。
- 失败降级（spec §6）：状态记为「未安装（上次尝试失败：<原因>）」；图谱构建/查询入口置灰并给原因与重试/导入入口；应用其余功能不受影响，不弹全局错误。已装旧版但锁已换、新版下载失败时，文案明确写「已停用」而不是暗示仍在用旧版（与任务 3 的锁不一致规则一致）。
- 设置页「组件」区：显示当前状态（已装版本/未装/失败原因）、安装/重试/导入离线包入口、镜像字段（落到与环境变量同一配置，环境变量优先）。同一区域顺带呈现 D-6 的 Agent CLI 检测结果（已装显示版本，未装给官方安装方式链接与一句话说明，仅检测与引导）。
- CLI 侧无 UI 路径已由任务 6 的 `nema components install` 承接；本任务只保证 daemon 被图谱调用命中未安装时返回可行动的状态，不静默下载。

- [ ] 先写失败测试：hub 透传组件状态与安装进度事件；web 确认框大小数字与锁汇总一致（用夹具锁断言）；拒绝后再次触发图谱功能才提示、普通页面浏览不弹窗；失败后图谱入口置灰且原因文案按原因区分，非图谱功能不受影响（至少断言状态面与文案键齐全、三语键对齐）。
- [ ] 运行测试确认失败，实现后重跑；跑 `npm run lint -w apps/web` 与 `npm run build -w apps/web`。

### 任务 5：桌面 payload 瘦身与发布断言

**Spec：** §7（README 原则修订在任务 8）、§8（发布流程衔接）、验收「体积」。

**依赖：** 任务 3（运行时解析已改到组件仓库；先瘦身会让新版桌面包的图谱功能无处找 bin）。任务 4 不阻塞本任务的代码合入，但有发布门禁：含本任务（slim payload）的版本，在任务 4（首次使用确认 UX）与任务 6（`nema components install`）落地前不得发布——否则用户拿到不含 Graphify 的 payload 却没有任何安装入口，D-4 定的确认路径也无从谈起；本任务须与任务 4、6 同版发布，任务 9 验收按此核对。

**文件：** `scripts/desktop/stage-runtime.mjs`（:449 起的 `fetchGraphify` 组装段）、`scripts/desktop/payload-size.mjs`（graphify 一节的口径）、`scripts/desktop/validate-release.mjs` 与/或 `scripts/desktop/release.test.mjs`、`scripts/desktop/staging.test.mjs`、桌面发布流程里跑发布检查的入口（实现时按现有 workflow 落点）。

**变更：**

- staging 不再调 `fetchGraphify` 组装 `tools/graphify`，payload 里不再有该目录；licenses 的处理随之调整（组件的许可证随组件走，不再拷进 payload 的 `runtime/licenses/graphify-runtime`——实现时确认组件组装是否需要带 licenses 目录，需要则由任务 2 的组装路径处理）。
- payload 仍带：锁文件（任务 1 的分发）与 Windows launcher 资源（全局约束），两者都是 KB 级。
- 发布检查新增断言：payload 不含 `tools/graphify`；`payload size:` 的 graphify 一项消失或为 0。断言要真能拦回归（见审查重点）。
- 体积目标（spec 验收，首个含本改动的发布实测，任务 9 勾）：每 target payload 合计 ≤ 80 MiB（基线 win32-x64 196.7、darwin-arm64 193.7）；dmg ≤ 95 MiB（基线 165.7）、NSIS exe ≤ 80 MiB（基线 136.0）、Windows zip ≤ 90 MiB（基线 199.0）。

- [ ] 先写失败测试/断言：staging 产物不含 `tools/graphify`；把一个假 `tools/graphify` 塞进 payload 后发布检查必须变红；payload-size 输出里 graphify 为 0/缺席且合计 ≤ 80 MiB（在本机能跑的 staging 子集上断言，跑不到的原生部分如实标注）。
- [ ] 运行 `node --test scripts/desktop/staging.test.mjs scripts/desktop/release.test.mjs scripts/desktop/payload-size.test.mjs`（以仓库实际文件名为准）确认新断言先失败、实现后通过。
- [ ] 移除 staging 的 graphify 组装段与其专属校验，保留 `fetch-graphify.mjs` 本体（制锁、记 size、`components pack` 复用）。

### 任务 6：CLI `nema components pack` / `import`（含 install / status）

**Spec：** §2（CLI 无 UI 时的安装命令）、§5（离线组件包，D-2 = B）。

**依赖：** 任务 2（校验与组装路径复用；导入不得另写一套组装）。任务 1（受信锁）。

**文件：** 新增 `apps/cli/src/components/componentsCommands.ts`（或按 `apps/cli/src/extensions/mcpCommands.ts` 的 `register*Commands` 模式组织）、`apps/cli/src/index.ts`（注册 `components` 子命令，与现有 `mcp` 等子命令并列）、`apps/cli/src/components/pack.ts`（制包与导入，可并入任务 2 的模块目录）、测试 `apps/cli/test/components/` 增补与 `apps/cli/test/indexCommands.test.ts` 相应断言。

**接口：**

- `nema components install graphify`：交互终端里先打印组件名、总大小（锁内汇总）、来源域名并等待确认；`--yes` 跳过确认供脚本使用；离线开关打开时拒绝并说明。实际安装调用任务 2 的 `installComponent`，进度打到终端，可 Ctrl-C 取消（清理 staging）。
- `nema components status`：打印当前平台的组件状态（任务 2 的 `ComponentStatus` 人类可读版），含 lock-hash 与安装位置。
- `nema components pack graphify`：在能联网的机器上按锁下载、逐项校验 sha256 与 `size`，把**原始归档原样**打成一个 `.nema-component`（tar）包：内含 python 归档与全部 wheels 加 `manifest.json`。manifest 只声明组件名、target、一份声称的 lock-hash、制包工具版本、归档清单（文件名与 size）。制包端不组装、不放组装好的目录。制包文档义务（制作方即分发方、许可证责任）写进命令输出与任务 8 的文档。
- `nema components import <file>`：以随主程序的受信锁为准绳——取当前平台 target 条目，包内归档集合必须与该条目**恰好相等**（都在、无多余），逐个按锁校验 sha256 与 `size`；manifest 声称的 lock-hash 必须等于按受信锁算出的 lock-hash、target 必须等于当前平台，否则拒绝并说明原因。manifest 的哈希一律不读、不作放行依据。全量校验通过后走任务 2 与在线下载完全相同的组装路径（解压到 staging → 自检 → 改名 → 原子切换），不要求联网。包内预组装目录或脚本一律忽略、永不执行。

- [ ] 先写失败测试：
  - pack 产出的包：解开后归档与假源字节逐项一致，manifest 字段只有允许的索引项，不含组装目录。
  - import 正常路径：断网替身下导入成功，产出与在线安装同构（同 lock-hash 目录、`current.json` 一致），图谱自检通过。
  - lock-hash 或 target 不符的包被拒绝并给出明确原因；归档多一个/少一个都被拒绝。
  - **篡改验收（spec §5/验收）：** 分两形，与导入规则对齐：① 归档被替换或改了字节（改过的启动器以替换归档形式混入）+ 与之自洽的 manifest——归档与受信锁对不上，导入必须失败且不产生 active 目录；② 包内归档全部是锁内原样、只是另附一个含改过启动器的预组装目录——按导入规则该目录一律忽略、永不执行、不进入组装产物，导入成败只由归档决定（归档全对则导入成功），并断言 active 目录里的启动器是安装器按随主程序资源/规范文本放入的那一份，不是包里那份。
  - `install` 在离线开关打开时零下载并明确报错；`--yes` 与交互确认两条路径都覆盖。
- [ ] 运行测试确认失败，实现后重跑至全绿；跑 `npm run typecheck -w apps/cli`。

### 任务 7：npm / Compose 宿主机 daemon 路径

**Spec：** §1（Linux target 只存在于锁里、供 npm/Compose 形态）、§4、验收「降级与多形态」。

**依赖：** 任务 2、任务 3（同一安装器与解析）；任务 6 的 CLI 命令是这条路径上无 UI 时的操作入口。与任务 4 共享状态面，但不依赖 web 部分。

**变更：**

- 确认 npm 包（`@nema-project/nema`，即 apps/cli）发布物里带齐：锁文件（任务 1）、安装器代码、Windows launcher 资源（仅 win32 用到）。包体积增量以 KB 计，在 PR 里给出 pack 前后数字。
- npm 全新安装的 daemon 第一次命中图谱功能时：返回未安装状态 → 用户跑 `nema components install graphify`（或经 web 确认，任务 4）→ 下载校验组装 → 图谱可用。Linux x64/arm64 宿主机走锁的 Linux target；glibc 之外如实报不支持。
- Compose 形态：daemon 在宿主机（与 npm 同一路径），容器内的 hub/web 不受影响；不需要给镜像加任何东西。把这条写进任务 8 的指南，避免误以为要在容器里装组件。
- `nema doctor` 的 graphify 检查在 npm 形态下同样区分三态（任务 3 已覆盖实现，这里做形态侧验证）。

- [ ] 先写失败测试/检查：npm pack 清单断言（锁与 launcher 资源在包内、无多余大文件）；以临时目录模拟 npm 全新安装的 daemon 数据目录，走通「未安装 → install → 自检通过 → `componentBin` 可用」全链（用假源，不访问上游），平台参数分别取 linux-x64 与 linux-arm64 的夹具锁。
- [ ] 运行测试确认失败，实现后重跑；在 PR 里记录 npm 包体积增量实测。

### 任务 8：文档与 changelog

**Spec：** §7（桌面 README 原则修订）、§5（制包的许可证义务）、文档对齐要求（AGENTS.md）。

**依赖：** 任务 4、6、7 的行为定型后写，避免文档与实现互相追赶。

**文件：** `scripts/desktop/README.md`（第 35 行一带）、`README.md`、`README.en.md`、`README.zh.md`、`README.ja.md`、`docs/guide.en.md`、`docs/guide.zh.md`、`docs/guide.ja.md`、`changelog.d/graphify-on-demand.changed.md`（类别在实现时按仓库惯例定，`added`/`changed` 二选一）。

- [ ] **桌面 README 原则修订（spec §7 的英文原文要点照落）：** 把「This is a build-time fetch. First launch does not download Graphify, uv, or Python.」一段改为：Graphify 不属于 payload；它是可选组件——第一次使用图谱功能时、经用户确认下载大小后，daemon 从上游按 `graphify-lock.json` 下载、逐文件验 SHA-256 后再解压、装到 `~/.nema/runtime/graphify/<lock-hash>/`；首次启动本身什么都不下载；uv 从不参与，Python 只作为该组件的一部分出现；下载失败或被拒绝时只有图谱功能不可用。整段关于 staging 下载 Graphify 的旧描述改为指向组件模型。
- [ ] **四份 README 与三份指南（三语等价）：** 把「桌面版自带 Graphify」一类表述改为「首次使用图谱功能时按需下载，可离线导入」；写清：触发时机与确认、安装位置、镜像变量（`NEMA_GRAPHIFY_PYTHON_MIRROR`、`NEMA_GRAPHIFY_PYPI_BASE`）、代理与企业 CA、离线开关、`nema components` 四个子命令、离线包的制作与分发责任（制作方即分发方，许可证义务归制作方，含 python-build-standalone 的组件许可证说明）、npm/Compose（含 Linux 宿主机）的同一流程、musl 不支持。`README.md` 与 `README.en.md` 保持逐字节相同（`cmp` 断言）。
- [ ] **Changelog：** `changelog.d/` 写一个片段，每行以 `- ` 开头，一条英文要点，例如：`- Graphify is no longer bundled with the desktop app: it downloads on first use of a graph feature after a size confirmation, verified against the shipped lock, with offline component packs for air-gapped setups.`
- [ ] 跑文档检查（见任务 9 的命令口径）与 `git diff --check`；ROADMAP 的 #132 行状态只在合并后按验收证据更新，不在本任务里提前标完成。

### 任务 9：最终验收（单独授权）

**Spec：** 验收标准全节。本任务需要维护者单独授权后执行；桌面真机验收按维护者 2026-11-16 测试政策不主动做，桌面部分以 CI 的 staging/smoke 与下列可测项为准，packaged bench 保持手动/可选，问题等用户反馈。**诚实证据规则：没有证据不勾 checkbox；静态检查、自动化测试、真实环境验收三者分开记录，不互相冒充；跑不到的项写明环境限制与缺口，不勾。**

- [ ] **体积：** 首个含本改动的发布（或等价的发布构建）实测——`payload size:` 中 graphify 一项消失或为 0；每 target payload 合计 ≤ 80 MiB；dmg ≤ 95 MiB、NSIS exe ≤ 80 MiB、Windows zip ≤ 90 MiB（以 `gh release view` 资产 size 核对）。未达标时在发布记录里写明差额构成，不勾。
- [ ] **下载与校验（自动化证据）：** 任务 2 的篡改字节、中途中断、中断恢复（改名后未写 current.json、改坏已落盘文件）测试全绿记录在案。
- [ ] **干净环境首次触发：** 无随包 graphify 的构建产物上第一次触发图谱功能，确认弹窗出现且显示大小与锁内 `size` 汇总一致；确认后装成 `<lock-hash>` 目录、`current.json` 指向它、图谱构建跑通。
- [ ] **镜像变量：** 两个镜像变量指向本地假源，下载全程不访问上游域名且校验通过；假源给错字节时校验失败（任务 2 测试证据 + 一次真实形态复跑）。
- [ ] **离线导入：** 在 A 机 `nema components pack graphify` 制包，拷到断网的 B 机（同平台）导入成功、图谱可用；lock-hash 或 target 不符的包被拒绝并给出明确原因；「改过的启动器以替换归档混入 + 自洽 manifest」的包导入失败且不产生 active 目录（另附预组装目录的包按规则忽略该目录、只由归档决定成败）。
- [ ] **降级：** 下载必失败的环境（黑洞代理）里应用正常启动与使用非图谱功能，图谱入口显示失败原因与重试/导入出口，无全局报错弹窗。
- [ ] **多形态：** npm 全新安装的 daemon（含 Linux x64/arm64 宿主机）走通确认→下载→可用；Compose 形态的宿主机 daemon 同样走通。
- [ ] **风险项实测记录：** macOS 上下载所得 Python 是否受 Gatekeeper/隔离属性影响（实测结论写进发布记录，不只假设 Node 下载不带 quarantine）；Windows 杀软误报只能记录与提示，不作为勾选条件。
- [ ] **记录：** 把命令、版本、体积数字、测试与实测结果按「静态检查 / 自动化测试 / 真实验收」分开写成发布记录（PR 或 #132 评论），ROADMAP 的 #132 行只按这份证据更新状态。

## 执行证据

（实现阶段填写：每个任务的命令与结果、未验证项与环境限制。未执行前留空，不预先声称任何结果。）
