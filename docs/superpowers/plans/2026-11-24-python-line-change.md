# 内置 Python 换线（3.11 → 3.14）实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Commit, push or open a PR only when the task you were assigned says so.

**目标**：把 graphify 组件的内置 CPython 从 3.11.18 换到 3.14 线最新补丁版（定案时为 3.14.10），重新生成四 target 的组件锁；包版本一个不升，安装器语义不变；已装组件按既有锁不匹配语义停用，由用户手动重装一次。

**规格**：[2026-11-22 内置 Python 换线设计](../specs/2026-11-22-python-line-change-design.md)，D-1～D-5 已于 2026-11-24 由维护者全部按推荐定案。Issue：[#56](https://github.com/Nema-Project/nema-room/issues/56)（本计划只覆盖其中的 Python 线；ESLint/TypeScript/Node 三线各自单独 PR）。ROADMAP：P2-07（v0.3.2）。

**已核对的现状**（对照 HEAD `846e8ea` 与 2026-11-22 的在线核对）：锁 `scripts/desktop/graphify-lock.json` 为 graphifyy 0.9.95 + Python 3.11.18 + 构建 `20261026`，四 target 各 21 个 wheel，其中 ABI 绑定的只有 numpy 2.4.6、pyyaml 6.0.3、rapidfuzz 3.14.6、tree_sitter 0.25.2，且四者在现钉版本上都有 cp314 wheel（PyPI 已核对）；python-build-standalone `20261110` 提供 CPython 3.14.10 四 target 的 `install_only` 归档。锁的再生入口是 `scripts/desktop/fetch-graphify.mjs refresh-lock`：它以现有锁为模板，纯 wheel 原样沿用，ABI wheel 按文件名经 PyPI 元数据为各 target 重新选文件并核对索引 sha256/字节数，CPython 归档按锁中声明的文件/URL 重新下载钉住，最后整份回写锁文件。`python3.11` 字面量在 `apps/cli/src/components/install.ts`（启动器模板、canonical 路径、LICENSE 候选）与 `scripts/desktop/fetch-graphify.mjs`，另有 `cp311`/版本断言散落在 `scripts/desktop/graphify.test.mjs` 与 `apps/cli/test/components/` 的 fixture。

## 全局约束

- 只换线，不升包：graphifyy 与全部 wheel 的版本与定案时一致；若某个 ABI wheel 在目标平台实际缺 cp314 文件，按 spec D-1 的回退顺序（同大版本内取有 wheel 的最近版本 → 仍不行退 3.13）处理并记录，不静默换大版本。
- 锁只能由 `refresh-lock` 从真实下载生成：禁止手写 sha256/字节数。刷新后逐 target 核对：CPython 归档文件名含所选目标线的 `<版本>+<发布号>`、ABI wheel 文件名含该线的 ABI 标签（`cp314`；回退 3.13 时 `cp313`）、纯 wheel 与旧锁逐字节一致（文件名与 sha256 不变）。
- 安装器与 hub 的行为语义不变：锁校验、归档安全、离线包、自检、激活的规则一律沿用；本计划只允许改「解释器名字符串从哪来」（D-2 派生）与测试 fixture 的字面量。
- 解释器名派生是纯函数：输入锁的 `python` 版本（如 `3.14.10`），输出 `python3.14`；非法输入显式抛错，不回退到任何写死值。
- 已装组件语义（D-4）：新锁下旧组件呈 `lock-mismatch` 被停用，图谱请求以 `GraphifyUnavailableError` 报错并指引手动安装；用户手动重装后按新锁运行。不改成自动重装，不新增迁移代码；工作区内的图谱文件不被触碰。以自动化测试钉住。
- 静态检查、自动化测试、真实归档端到端、真机验收分开记录；桌面真机不主动测（2026-11-16 测试政策）。本机（VM）Node 的 http(s).request 栈受沙箱代理限制的历史问题仍在：`refresh-lock` 用 fetch，若直连失败，按 #132 Task 9 的本地镜像方法完成下载，不改锁的内容口径。

## 文件与职责（预计）

- `scripts/desktop/graphify-lock.json`：任务 1 再生（模板字段先改：`python`、`cpythonRelease`、四 target 的 CPython 归档文件名/URL、四个 ABI wheel 的模板文件名 cp311→所选目标线标签（cp314；回退时 cp313），再跑 `refresh-lock` 回写全部 sha256/字节数）。
- `apps/cli/src/components/install.ts`：任务 2 改为从锁派生解释器名（启动器模板、canonical 路径、LICENSE 候选）；派生函数放同文件或 `lock.ts`，以现有模块边界为准。
- `scripts/desktop/fetch-graphify.mjs`：任务 2 同步派生（其 POSIX 启动器与裁剪逻辑）。
- `scripts/desktop/graphify.test.mjs`、`apps/cli/test/components/*`：任务 3 更新字面量与 fixture；任务 4 在 components 测试加已装组件语义用例。
- `changelog.d/python-314-line.changed.md` 与文档中写死 Python 版本的段落（任务 6 核对）。

### 任务 1：锁模板更新与再生

- [x] 改锁模板：`python` 改为目标线最新补丁版（执行时以 python-build-standalone 最新发布为准，定案时为 `3.14.10` / 发布 `20261110`），`cpythonRelease` 同步；四 target 的 CPython 归档文件名与 URL 换到新发布；四个 ABI wheel 的模板文件名由 `cp311` 换为所选目标线对应的标签文件名（3.14 线为 `cp314`；若按 D-1 回退 3.13 则为 `cp313`，平台标签部分以 PyPI 该版本文件列表为准）。
- [x] 跑 `node scripts/desktop/fetch-graphify.mjs refresh-lock` 再生整锁；直连失败时按全局约束走本地镜像，镜像只作传输、不改内容。
- [x] 再生后逐项核对：四 target 的 CPython 归档文件名含所选目标线的版本与发布号、ABI wheel 文件名含该线的 ABI 标签（`cp314`，回退时 `cp313`），且其 sha256/字节数均由本次下载产生；17 个纯 wheel 的文件名与 sha256 与旧锁完全一致；`node --test scripts/desktop/graphify.test.mjs` 通过（其写死断言若属任务 3 范围，在本任务内先同步到新线再跑）。

### 任务 2：解释器名派生（D-2）

- [x] 先写失败测试：派生函数对 `3.14.10` 输出 `python3.14`，对 `3.11.18` 输出 `python3.11`，对非法版本抛错。
- [x] `install.ts` 的启动器模板、canonical 解释器路径、LICENSE 路径候选改为用派生结果，不再出现 `python3.11` 字面量；`fetch-graphify.mjs` 的 POSIX 启动器与裁剪逻辑同样派生。
- [x] components 测试全绿；全仓 grep `python3\.11` 只剩历史文档（spec/plan/旧记录）与本任务有意保留处，逐处在执行证据里说明。

### 任务 3：测试字面量与 fixture 清点

- [x] 以 grep 清点 `cp311`、`3\.11\.18`、`cpython-3.11` 在 `apps/cli/test`、`scripts` 中的全部出现，逐处更新到新线（fixture 的 wheel 文件名换所选目标线对应的标签名（cp314；回退时 cp313），断言的版本号换新版）。
- [x] 受影响测试全绿：`apps/cli` components 相关套件、`scripts/desktop/graphify.test.mjs`、`graphify-languages.test.mjs`、bundle/stage-package 中引用锁的测试（本机例外：`bundle-cli.test.mjs` 的 import.meta.url 路径断言在本机 VM 对干净 main 同样失败，属基线环境失败；以本 PR 的 CI 全绿为判定门，见执行证据）。

### 任务 4：已装组件语义（D-4）

- [x] 加自动化测试：以旧锁身份装好的组件目录，在新锁下状态为 `lock-mismatch`；图谱解析路径抛 `GraphifyUnavailableError` 且文案指引手动安装；用户手动触发标准安装后按新锁装好、自检通过、在新解释器上可运行；工作区图谱文件（fixture）在全程逐字节不变。
- [x] 若现有「锁不匹配」语义已天然满足，只加测试不改代码，并在执行证据里指出所依赖的既有判定点。

### 任务 5：端到端验证（linux-x64）

- [x] 按新锁真实安装一次（直连或本地镜像）：下载→校验→自检→激活全程成功，状态输出报告所选目标线的 Python 版本（3.14.x；回退时 3.13.x）与 graphifyy 0.9.95。
- [x] 用装好的组件对一份小语料实际跑一次图谱抽取并产出图谱文件（组件本体验证，不经 hub）。
- [x] 根 `npx tsc -b`、CLI 型检查、`apps/cli` 与 `apps/hub` 相关套件全绿。

### 任务 6：文档与 changelog

- [x] grep 四份 README 与三份指南中的 Python 版本表述（如「Python 3.11」），按新线改齐；无表述则在本任务证据里注明。
- [x] 加 changelog 片段 `changelog.d/python-314-line.changed.md`（每行以 "- " 开头），写明运行时换线、升级后旧组件将停用并需在组件页重装一次、工作区图谱不受影响。

### 任务 7：本线收口（#56 不关）

- [x] 在 #56 贴 Python 线完成记录（再生锁的证据、端到端结果、测试结果分开写），#56 保持开放等其余三线。
- [x] ROADMAP：P2-07 行与 v0.3.2 一节按四线进度更新（Python 线标完成，其余三线按各自状态），执行记录补一行。

## 执行证据

2026-11-24 执行（分支 `feat/56-python-314`）：

- 任务 1：模板先改 `python`/`cpythonRelease` 与四 target 的归档名/ABI 文件名，新钉的 sha256 取自上游发布元数据（python-build-standalone `20261123` 的 SHA256SUMS 与 PyPI 各版本 JSON 的 digests），再跑 `fetch-graphify.mjs refresh-lock` 从真实下载逐条核对回写。首轮因模板 URL 误指同发布的 3.11.18 归档被哈希校验当场拒绝，修正 URL 后通过。再生后逐 target 核对：CPython 均为 `3.14.10+20261123`，ABI wheel 均为 cp314（每 target 4 个），17 个纯 wheel 的文件名/sha256/字节数与旧锁逐字节一致，graphifyy 仍 0.9.95。D-1 回退未触发（四平台 cp314 wheel 全部存在）。
- 任务 2：派生函数 `pythonInterpreterName` 落在 `apps/cli/src/components/lock.ts` 与 `scripts/desktop/fetch-graphify.mjs`（两侧一致性由 lock.test.ts 钉住），非法版本显式抛错、无回退值；install.ts 的启动器/dedupe/自检解释器/LICENSE 候选与 fetch-graphify 的对应点全部改为派生。生产代码 grep `python3\.11` 为零。
- 任务 3：`graphify.test.mjs`（含两枚 sha256 canary 与选择器 fixture）、`apps/cli/test/components/` 全部 fixture 与断言、`apps/web/test/ComponentsSettings.test.tsx` 的展示 fixture 均已换到新线；components 测试用的旧线 fixture 只保留在 D-4 测试的 `OLD_PYTHON_LINE`（刻意为之，见任务 4）。
- 任务 4：新增 `apps/cli/test/components/pythonLineChange.test.ts`，以旧线锁装好的组件走完「新锁下 lock-mismatch → resolveGraphify 不可用 → buildIndex 抛 GraphifyUnavailableError 且文案指引手动安装 → 标准安装按新锁重装成功并可解析 → 工作区图谱 fixture 逐字节不变」全链；实现侧零改动（既有语义天然满足，判定点为 store.ts 的 componentStatusSync 与 repos/graphify.ts 的 resolveGraphify）。
- 任务 5：linux-x64 真实安装：直连下载 CPython 归档时本机沙箱代理出现 socket hang up（环境限制，非产品问题），按计划走本地镜像（refresh-lock 已验证的缓存字节经 HTTP 镜像提供，安装器仍按锁校验每个文件）完成下载→校验→解压→自检→激活；`components status` 报告 graphifyy 0.9.95 / Python 3.14.10，新锁 lock-hash 7731599a…；用装好的组件对 3 文件小语料实跑 `extract --code-only`，产出 graph.json（7 节点 7 边）。
- 任务 6：三语指南与 scripts/desktop/README 的版本表述已改齐；changelog 片段 `changelog.d/python-314-line.changed.md` 已加（措辞按更正后的 D-4：停用 + 手动重装一次）。
- 自动化测试汇总（本机 Node 24.22.1）：根 `tsc -b` 与 CLI 型检查通过；`apps/cli/test/components` + `repos/graphify.test.ts` 196/196；web ComponentsSettings 45/45；`scripts/desktop/graphify*.test.mjs` 21/21；bundle/stage-package/staging 40/41——唯一失败 `bundle-cli.test.mjs` 的 import.meta.url 路径断言与 CLI 全套件唯一的 `siwc.test.ts` 回环绑定断言，经在干净 main（9764afb）上复跑确认同为失败，属本机 VM 环境既有问题（绝对路径/网络接口形状），与本线无关，留待 CI 判定。
