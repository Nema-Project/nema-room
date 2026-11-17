# 轻量化发布：Graphify 按需下载与离线组件包（#132 后续）

**状态**：设计草案。D-1～D-4、D-6 待维护者定案（逐项建议见「决定」一节）；D-5 已由 #134 解决，不在本设计范围。本文件不改生产代码，实施计划另行编写。

**设计所对照的 HEAD**：`04e098a`（`main`，v0.3.0 发布记录合并之后）。标为「实测」的数字是在这个 SHA 与 v0.3.0 发布物上实际量得的；#132 正文里的数字是 v0.1.6（2026-10-30）的，已过期，本文件全部换新。

**范围**：#132 原范围有两块——去掉重复打包的 Node、Graphify 运行环境改为按需下载。Node 去重已拆到 #134 并完成（见现状第 3 条）。本设计只剩 Graphify 按需下载 + 离线组件包，并定为 v0.3.1。

## 如何服务 #45

#45 的判断标准：让人和 agent 能维护一份随项目演进、有证据支撑的共同理解。Graphify 是把代码仓变成可查询知识图谱的工具，是这份共同理解的生产者之一；但它今天只随桌面安装包分发，npm 与 Compose 用户根本用不上（见现状第 4 条），而桌面用户则要为一项可选功能多下载约 122 MiB。把它改成「核心完整安装、大组件按需获取」后：安装门槛下降，第一次真正用到图谱功能的人才付出下载成本；npm/Compose 用户第一次能用上 Graphify；每个下载字节仍由 `graphify-lock.json` 的 sha256 锁定，证据链不比随包弱。

## 现状（已核对，2026-11-18 实测）

1. **v0.3.0 桌面发布物**（`gh release view v0.3.0`）：dmg 173,739,094 B（165.7 MiB）、NSIS exe 142,568,506 B（136.0 MiB）、Windows zip 208,708,059 B（199.0 MiB）。
2. **v0.3.0 payload 构成**（桌面发布运行 [44130554399](https://github.com/Nema-Project/nema-room/actions/runs/44130554399) 日志的 `payload size:` 行，未压缩）：win32-x64 合计 196.7 MiB，其中 graphify 122.1、web 25.8、node 0.0；darwin-arm64 合计 193.7 MiB，其中 graphify 121.2、web 24.0、node 0.0。Graphify 一项约占 payload 的 62%。
3. **Node 去重已完成**：payload 里 `node 0.0 MiB`，桌面端用 Electron 45.1.0 自带 Node 24.22.1（`ELECTRON_RUN_AS_NODE=1`），#134 已关闭。D-5 到此为止。
4. **Graphify 今天仍随包**：`scripts/desktop/stage-runtime.mjs` 在 staging 时调 `fetch-graphify.mjs`，按 `scripts/desktop/graphify-lock.json` 下载并逐文件验 sha256 后解压，落到 payload 的 `tools/graphify/`（Windows 启动器由 `graphify-launcher.c` 编译，macOS 是 shell 脚本）。锁的内容：CPython 3.11.18（python-build-standalone `20261026`，来源 github.com）、graphifyy 0.9.95 及锁定 wheel（来源 files.pythonhosted.org，无 extras，只保留 16 种 tree-sitter 语言）；锁只覆盖 win32-x64 与 darwin-arm64 两个 target。锁文件目前**不记录每个文件的大小**。
5. **运行时查找**：`apps/cli/src/repos/graphify.ts` 的 `packagedGraphifyBin()` 只认 `NEMA_GRAPHIFY_BIN`，否则拼 `<NEMA_PAYLOAD_ROOT 或可执行文件目录>/tools/graphify/graphify[.exe]`，不查 PATH、不查用户目录；缺失时提示 `随包的 Graphify 运行环境缺失`（`INSTALL_HINT`）。因此 npm 与 Compose 用户（daemon 在宿主机经 npm 安装）的 Graphify 功能今天是不可用的。
6. **与现行原则冲突**：`scripts/desktop/README.md` 第 35 行写明「This is a build-time fetch. First launch does not download Graphify, uv, or Python.」改成按需下载前必须先修订这条（修订文本见设计第 7 节）。
7. **可复用的既有模式**：Skills 安装已有「锁 commit + 逐文件哈希校验 + 进度/取消/重试 UI」（`apps/cli/src/extensions/install.ts`）；daemon 已有 `proxyEnv` 配置项（#242）处理代理转发。本设计沿用这两条线的思路，不另起炉灶。

## 目标 / 非目标

**目标**

- 桌面安装包不再包含 Graphify 运行环境，体积目标见验收一节。
- Graphify 改为第一次用到时、经用户确认后按需下载：沿用 `graphify-lock.json` 的 url 与 sha256，逐文件先验哈希再解压，装到 `~/.nema/runtime/graphify/<lock-hash>/`，原子切换，保留上一版。
- 下载支持镜像（Python 与 PyPI 两个来源可分别换源）、代理与企业 CA、重试与取消；提供离线组件包导入，覆盖完全离线与内网环境。
- 同一套下载器供桌面、npm、Compose 三种形态的 daemon 共用，npm/Compose 用户第一次能用上 Graphify。
- 下载失败或用户拒绝时，只有 Graphify 功能不可用，应用其余功能不受影响，原因如实呈现。

**非目标**

- 不做整个应用在线安装，不拆 npm 平台包（D-1 不选 B/C）。
- 不打包、也不代运行 Agent CLI（Codex、Claude Code）的官方安装器（D-6 取 A）。
- Nema 不重新分发 Graphify/Python 本体：不把组件包放进自己的 Release（D-3 取 A）；离线包是用户/组织自行制作与内部分发的侧载物（D-2 取 B）。
- 不改 Graphify 本身的版本、语言集与提取行为；锁的更新节奏不变。
- 不做组件自动更新：组件版本跟随主程序锁，主程序升级带来新锁时按新锁下载，旧版按保留策略清理。

## 设计

### 1. 组件模型与锁

- 唯一可选组件：`graphify`。组件的事实来源仍是 `scripts/desktop/graphify-lock.json`，随主程序发布，运行时从随包资源读取（桌面 payload、npm 包内各一份，内容一致）。
- `<lock-hash>` 定义为：对当前平台 target 的锁条目（python 条目 + wheels 数组，含 url 与 sha256）做规范化 JSON 序列化后的 sha256 十六进制全串。同一锁在同一平台恒定同值；锁的任何一项变化都会产生新目录。
- 锁文件补 `size` 字段：`fetch-graphify.mjs` 在 staging/制包时已实际下载每个文件，顺手把字节数写回锁（制锁流程的一部分，CI 校验锁内 size 与实际下载一致）。运行时确认弹窗与进度条用它，不临时发 HEAD 请求猜大小。

### 2. 下载时机与确认 UX（D-4 = B）

- 触发点：任何第一次真正需要执行 graphify 的调用（知识图谱构建/查询），以及设置页的「组件」区手动入口。应用启动、打开工作区等路径**不**触发。
- 桌面/web UI：先弹确认框，写明组件名、下载总大小（按锁内 size 汇总，约数十 MiB 量级以下载时锁为准）、安装位置（`~/.nema/runtime/graphify/`）、下载来源域名；用户确认后才开始。下载中显示进度（已下载/总量、当前文件），可取消；失败显示具体原因（网络、代理、哈希不一致分别成文案）与「重试」「导入离线包」两个出口。
- CLI/daemon 无 UI 时：不静默下载。调用返回明确状态，提示运行 `nema components install graphify`（交互终端里该命令同样先打印大小并等待确认；`--yes` 可跳过确认，供脚本使用）。
- 用户拒绝或从未确认：Graphify 功能保持未安装状态，入口处显示「未安装」及安装按钮，不反复弹窗（同一版本只在用户主动触发功能时提示）。
- 离线开关：`NEMA_GRAPHIFY_OFFLINE=1`（或配置 `components.offline`）时禁止一切下载尝试，直接走未安装/离线导入路径，满足内网合规要求。

### 3. 安装布局与原子切换

```
~/.nema/runtime/graphify/
  <lock-hash>/            # 完整安装好的一个版本（含 python/ 与启动器）
  <lock-hash>.staging/    # 下载与解压中的临时目录，成功后改名
  current.json            # { "active": "<lock-hash>", "previous": "<lock-hash>" }
```

- 流程：下载到 staging → 逐文件 sha256 校验（与锁比对，任一不符整次作废）→ 解压到 staging → 跑一次自检（启动器可执行且 `python -m graphify --version` 成功）→ 目录改名为 `<lock-hash>` → 原子改写 `current.json` 切换 active。任何一步失败删 staging，已 active 的旧版不受影响。
- 保留策略：保留 active 与 previous 两版，其余 `<lock-hash>` 目录在下一次成功安装后清理（沿用社区共识的自动清理旧版本）。
- 启动器：Windows 沿用现行编译好的 launcher 逻辑改为随组件生成（staging 时的 C 编译不在用户机器上发生——launcher 是锁内一个预构建小二进制，还是由安装器写出的脚本，属于实施计划要定的实现细节；约束是用户机器上不要求编译器）；macOS 沿用 shell 脚本形态。
- 运行时查找顺序（改 `packagedGraphifyBin` 一带）：`NEMA_GRAPHIFY_BIN`（显式覆盖，最优先）→ `~/.nema/runtime/graphify/<current active>` 且其 lock-hash 与当前主程序锁一致 → 随包 `tools/graphify`（仅过渡期旧版 payload，新版不再随包）→ 未安装。lock-hash 不一致（主程序已升级、组件未跟上）时视为未安装并走第 2 节流程，不拿旧版凑数。

### 4. 下载源、镜像、代理与 CA（D-3 = A）

- 默认直连锁内 url 的上游：github.com（python-build-standalone）与 files.pythonhosted.org（wheels）。Nema 不镜像、不中转。
- 镜像变量（环境变量优先，桌面端可在设置页填、落到同一配置）：`NEMA_GRAPHIFY_PYTHON_MIRROR` 替换 python 条目 url 的来源前缀，`NEMA_GRAPHIFY_PYPI_BASE` 替换 wheels 的 files.pythonhosted.org 前缀（按 PyPI 索引页规则拼接）。换源只改地址，sha256 仍按锁校验——镜像给错字节只会校验失败，不会装上错的东西。
- 代理：下载器遵循 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`；桌面形态可复用 #242 的 `proxyEnv` 语义（用户已为 agent 转发过代理时，组件下载默认沿用同一组变量，不再问一遍）。企业 CA：认 `NODE_EXTRA_CA_CERTS` 与 `SSL_CERT_FILE`。Node 内置 fetch 不读代理变量，下载器要显式处理（社区调研已标注此坑）。
- 重试与超时：单文件失败自动重试（指数退避，上限实施计划定），整体有空闲超时；断点续传不做（单文件最大约数十 MiB，重下成本可接受），取消后清理 staging。

### 5. 离线组件包（D-2 = B）

- 形态：一个 `.nema-component` 包（本质 tar），内含按第 3 节布局打好的组件目录与 `manifest.json`（组件名、target、lock-hash、每文件 sha256 与 size、制作工具版本）。
- 制作：提供 `nema components pack graphify`（在能联网的机器上运行：按锁下载、校验、组装、打包），组织可把包放进内网文件共享自行分发。包的制作方即分发方，许可证义务由制作方承担（见风险一节）；Nema 的 Release 不附带此包。
- 导入：设置页选文件，或 `nema components import <file>`。导入时全量校验 manifest 与每文件 sha256，且 lock-hash 必须等于当前主程序锁的 lock-hash、target 必须等于当前平台，否则拒绝并说明；校验通过后按第 3 节同一路径落盘与切换，不要求联网。
- 离线包与在线下载产出物完全同构，运行时不区分来源。

### 6. 失败降级与提示

- 下载/导入/自检任一环节失败：组件状态置为「未安装（上次尝试失败：<原因>）」，Graphify 相关入口（图谱构建、图谱查询）置灰并给原因与重试/导入入口；应用其余功能（对话、知识条目、分享等）不受影响，不弹全局错误。
- 绝不出现「装成功了但其实是坏的」：未过全量 sha256 与自检的目录永不被标为 active（对照 Codex optional 依赖静默失败的反例）。
- 已装好旧版、新锁下载失败时：明确提示「新版本组件下载失败，当前图谱功能仍使用旧版本」还是「已停用」——按第 3 节规则 lock-hash 不一致即不启用旧版，文案须与此一致，不误导。

### 7. 桌面 README 原则修订

`scripts/desktop/README.md` 第 35 行现行文本（节选）：

> …SHA-256 is checked before extract. … This is a build-time fetch. First launch does not download Graphify, uv, or Python. …

修订为（要点，实施时落英文原文）：

> Graphify is not part of the payload. The runtime is an optional component: on first use of a graph feature, after the user confirms the download size, the daemon downloads the runtime pinned in `graphify-lock.json` from its upstream sources, verifies every file against the lock's SHA-256 before extract, and installs it under `~/.nema/runtime/graphify/<lock-hash>/`. First launch itself downloads nothing. uv is never involved; Python arrives only as part of this component. A failed or declined download leaves only the graph features unavailable.

同时第 35 行整段关于 staging 下载 Graphify 的描述改为指向组件模型；四份 README 与三份指南中「桌面版自带 Graphify」的表述同步改为「首次使用图谱功能时按需下载，可离线导入」（AGENTS.md 的文档对齐要求）。

### 8. 发布流程衔接

- desktop-release：staging 不再调 `fetch-graphify` 组装 payload（该脚本保留，供制锁、记 size 与 `components pack` 复用）；`payload size:` 的 graphify 行应为 0/消失，发布检查把「payload 不含 tools/graphify」列为断言。
- release-manifest：不新增 Nema 分发的组件资产（D-3 = A）；如后续改选 C 再议。
- npm 与镜像发布：流程不变；npm 包内带锁文件与下载器代码（包体积增量以 KB 计）。
- promote 的指针安全规则（#44）不受影响：组件下载发生在用户机器、发布之后，不存在发布空窗问题。

### 9. Agent CLI（D-6 = A）

Codex、Claude Code 继续不打包、不代装。状态/设置页显示检测结果（PATH 与已知安装位置）：已装显示版本，未装给官方安装方式的链接与一句话说明，仅此而已。不调用官方安装器（B 不选：安装器行为与升级策略归各官方，Nema 代跑等于替用户接受其条款与自动更新策略）。

## 决定

| 项 | 选项 | 建议 | 理由 |
| --- | --- | --- | --- |
| D-1 范围 | A 只做大的可选组件 / B 整个应用在线安装 / C 平台拆包 | **A** | Graphify 一项占 payload 62%，是唯一「大而可选」的组件；B 收益小、复杂度与拦截风险高（社区无先例把整个应用在线化）；C 有 optional 依赖静默失败与发布空窗的已知坑，且 npm 包本来就小。 |
| D-2 离线版 | A 精简+完整两份产物 / B 精简安装包 + 可侧载离线组件包 / C 只发精简版 | **B** | A 等于继续为完整版分发 Graphify，许可证与体积问题只解决一半，且双产物翻倍发布与验证成本；C 放弃完全离线与内网用户；B 与 VSIX/nsis-web package-file 的社区做法一致，一份安装包 + 一个同构组件包覆盖两种环境。 |
| D-3 下载源 | A 上游直连 + 镜像变量 / B Nema 重打包放 Release / C 两者都提供 | **A** | 只有用户直接从上游下载，Nema 才不再分发 Python/wheels，许可证压力真正下降；B 仍是 Nema 分发且与 D-2 的侧载重复；C 增加一份要长期维护与验签的官方组件包，等 A 的镜像变量被证明不够用再议。 |
| D-4 下载时机 | A 首次启动自动下载 / B 第一次用到时提示大小并确认 / C 只在设置页手动下载 | **B** | A 与「首次启动不下载东西」的产品习惯冲突，且给永远不用图谱的人白下 100+ MiB；C 可发现性差，功能看起来像坏了；B 是 Playwright/uv 的主流做法，成本发生在价值发生处。 |
| D-5 Node 去重 | A 与本项一起做 / B 单独 issue 先做 / C 不做 | **已解决** | 已按 B 拆到 #134 并完成：payload node 0.0 MiB（v0.3.0 实测），改用 Electron 自带 Node。本设计不再涉及。 |
| D-6 Agent CLI | A 不打包，只检测并引导 / B 一键调用官方安装器 | **A** | 现状即 A 且运转良好（用户自装、PATH 检测）；B 让 Nema 替用户接受官方安装器的更新与条款策略，出问题时责任边界不清。只需把检测与引导在状态页做显式。 |

## 验收标准

**体积（以 v0.3.0 为基线，首个含本改动的发布实测）**

- payload：`payload size:` 中 graphify 一项消失或为 0；每 target 的 payload 合计 ≤ 80 MiB（基线 win32-x64 196.7、darwin-arm64 193.7）。
- 安装包：dmg ≤ 95 MiB（基线 165.7）、NSIS exe ≤ 80 MiB（基线 136.0）、Windows zip ≤ 90 MiB（基线 199.0）。数字由 `gh release view` 的资产 size 核对；未达标要在发布记录里说明差额构成。

**下载与校验**

- 自动化测试：锁内任一文件的字节被篡改时，安装必须失败且不产生 active 目录；下载中途中断（杀进程/断网模拟）后，staging 被清、既有 active 版本（如有）仍可正常执行 graphify。
- 干净环境（无随包 graphify 的构建产物）首次触发图谱功能：确认弹窗出现且显示的大小与锁内 size 汇总一致；确认后装成 `<lock-hash>` 目录，`current.json` 指向它，图谱构建跑通。
- 镜像变量生效测试：把两个镜像变量指向本地假源，下载全程不访问上游域名且校验通过；假源给错字节时校验失败。

**离线导入**

- 在 A 机 `nema components pack graphify` 制包，拷到断网的 B 机（同平台）导入成功，图谱功能可用；lock-hash 或 target 不符的包被拒绝并给出明确原因。

**降级与多形态**

- 下载必失败的环境（黑洞代理）里：应用正常启动与使用非图谱功能，图谱入口显示失败原因与重试/导入出口，无全局报错弹窗。
- npm 全新安装的 daemon（无桌面 payload）走通同一套确认→下载→可用流程；Compose 形态的宿主机 daemon 同样走通。

以上为静态检查与自动化测试之外的真实环境验收项；桌面真机验收按维护者 2026-11-16 测试政策不主动做，桌面部分以 CI 的 staging/smoke 与上述可测项为准，问题等用户反馈。

## 风险与未决问题

- **上游可用性**：D-3 = A 后，上游（GitHub Releases、PyPI）不可达即无法在线安装；镜像变量与离线包是仅有的兜底，上游长期下线时需重议 D-3。
- **macOS 对下载可执行文件的态度**：组件里的 Python 是下载所得而非随签名 app 分发，是否被 Gatekeeper/隔离属性影响需在实施时实测（Node fetch 下载通常不带 quarantine 属性，但不能只假设）。
- **Windows 杀软误报**：下载并执行未签名的 python.exe 可能触发部分安全软件，只能靠如实提示与离线包路径缓解，无法根除。
- **许可证边界**：用户/组织制作并分发离线包即成为分发方，义务（尤其 python-build-standalone 的组件许可证与 `sourceCorrespondence` 的 pending-task-7c）在制包文档里要写清；Nema 官方不分发这一条不能在后续版本里悄悄破例。
- **磁盘占用**：保留两版组件约占 2×122 MiB，低磁盘环境要在安装前检查剩余空间并提示（阈值实施计划定）。
- **锁更新与存量用户**：主程序升级换锁后，存量用户要再下载一次新组件；大版本密集发布时这是重复成本，是否允许「同 graphifyy 版本、仅平台补丁差异时复用」留待实施计划评估，默认不复用。
- **未决**：确认弹窗在 web UI 与桌面壳里的具体形态（同一套 web UI 应可复用）；`components` 子命令族的最终命名；设置页镜像字段与环境变量的优先级（本设计定为环境变量优先，未决是否给 UI 覆盖一次的机会）。
