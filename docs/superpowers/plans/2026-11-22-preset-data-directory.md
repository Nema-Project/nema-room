# 预置数据目录实施计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Commit, push or open a PR only when the task you were assigned says so.

**目标**：桌面版首次运行时，用随包的预置数据目录种子跳过「从零建库」段（PGlite 空目录初始化 + 22 个迁移），把 windows 冷启动 DB 中位从 3484ms 压到 1600ms 量级；既有库、既有行为、迁移完整性一律不变。

**规格**：[2026-11-22 预置数据目录设计](../specs/2026-11-22-preset-data-directory-design.md)，D-1～D-7 已于 2026-11-22 由维护者全部按推荐定案。Issue：[#265](https://github.com/Nema-Project/nema-room/issues/265)。ROADMAP：P2-11（v0.3.2）。

**已核对的现状**（对照 HEAD `a571728`）：桌面 home 为 `~/.nema/desktop`，库目录 `<home>/db`（`apps/local/src/paths.ts`）；`createLocalDb`（`apps/hub/src/db/pglite.ts`）= `new PGlite(dataDir)` + `migrate`（`apps/hub/src/db/db.ts`，按序逐事务应用 `apps/hub/src/db/migrations/` 的 .sql，`schema_migrations` 记账）；运行时经 `apps/local/src/runtime.ts` 的 `readManifest` 解析 assetsDir 里的运行时清单（schemaVersion 1，各条目为 assetsDir 内相对路径、逐个校验），`stage-runtime.mjs` 生成载荷并由 `payload-size.mjs` 的 `checkSlimPayload`/`reportPayload` 记账；`scripts/ci/startup-sample.mjs` 以父进程派冷/热子进程测 `new PGlite` + `migrate` 并输出一行 JSON，verify.yml 的平台 job 持续跑它。

## 全局约束

- 只进桌面载荷（D-1）：npm/Compose 与开发态没有种子清单条目时，运行时行为与今天逐字节一致——种子是清单里的**可选**条目，缺失即跳过，不报错。
- 种子只在 `<home>/db` 不存在时落地（D-4）；任何情况下不读、不改、不覆盖既有库。
- `createLocalDb` 与 `migrate` 本身不改：种子落地后照常调 `createLocalDb`，由 `migrate` 自己确认零待执行。禁止为了种子给 migrate 加跳过参数或信任标记。
- 种子落地失败必须回退全量初始化且只留一条诊断（D-5）；落地中途的半成品目录必须清掉再回退，不得把半成品留给 PGlite 打开。
- 种子的归档解开必须防路径逃逸（绝对路径、`..`、符号链接逃逸一律拒绝并走回退），与组件安装器归档处理（`apps/cli/src/components/archive.ts`）同一安全口径；能复用就复用，不另写一份弱实现。
- 种子归档每 target ≤10 MiB（D-6），超限让 staging 失败，不静默放行。
- 不动 ACL 检查的次数与时机；种子落地发生在 home 权限收紧的既有流程之内，不新增路径。
- 静态检查、自动化测试、CI 平台数字、真机验收分开记录；桌面真机不主动测（2026-11-16 测试政策）。

## 文件与职责（预计）

- `scripts/desktop/make-preset-db.mjs`（新）：种子生成器。用构建产物对临时目录跑 `createLocalDb` 并关闭，断言 `schema_migrations` 集合与迁移文件集合相等，打成单个归档并输出大小；自带 `make-preset-db.test.mjs` 覆盖断言与归档往返。
- `scripts/desktop/stage-runtime.mjs`：staging 时按 target 调生成器，把归档放进载荷（如 `preset/preset-db.tar.gz`），并在运行时清单里写可选条目 `presetDb`。
- `scripts/desktop/payload-size.mjs`：新增 `preset-db` 记账段（计入 total、单列报告），>10 MiB 时 `checkSlimPayload` 失败。
- `apps/local/src/presetDb.ts`（新）：种子落地函数——清单条目解析后的归档路径 + 目标 db 目录，解开到临时名目录后原子改名就位；失败清场并返回「未落地」让调用方走原路径。配套 `apps/local/test/presetDb.test.ts`。
- `apps/local/src/runtime.ts`：`readManifest` 解析可选 `presetDb` 条目；在 `db` 阶段、`createLocalDb(paths.db)` 之前调落地函数；诊断走既有日志通道。`runtime.test.ts` 的 fake assets 保持无该条目（证明缺失即跳过），另加带条目的用例。
- `scripts/ci/startup-sample.mjs`：新增 `preset` 口径（父进程现生成一份种子，子进程在全新目录上落地种子后测 `createLocalDb` 等价段），JSON 行增加 `preset` 字段；既有冷/热口径不变。
- `changelog.d/preset-db-startup.changed.md`、桌面 README 与三份指南中涉及数据目录/首次启动的段落（任务 6 核对后决定改否）。

### 任务 1：D-2 形态实测（归档解压 vs 整树拷贝）

- [x] 在 windows-latest 的 CI 环境实测同一份种子内容两种落地形态的耗时：单归档解压到目标目录就绪、整树拷贝到目标目录就绪，各至少 5 次取中位；macOS 同口径参考。
- [x] 把实测数字与结论记进本任务的 PR 描述与 #265 评论。若归档形态不慢于拷贝（预期），按 D-2 定案走归档；若拷贝显著更快且实现不更复杂，改选 B 并在 spec 的 D-2 状态行下补记改选理由（不改定案本身，需维护者知情）。
- [x] 若改选 B（松散目录），任务 2–5 中一切「归档」按「种子目录树」读：生成器产出目录树（体积门按全树字节数计）、清单条目指向该目录、落地为整树拷贝、采样口径测拷贝落地；安全口径不变（拷贝同样拒绝符号链接逃逸）。本条即 B 形态下任务 2–5 的对应步骤，不另立任务。

### 任务 2：种子生成器与构建断言

- [x] 先写失败测试：`schema_migrations` 集合与迁移文件集合不等时生成器报错；归档解开后目录可被 PGlite 打开且 `migrate` 零待执行。
- [x] 实现 `make-preset-db.mjs`：用构建产物（与 staging 同一份 hub 构建）对临时目录 `createLocalDb` → 查询 `schema_migrations` 与迁移目录文件集合比对 → `close()` → 打归档 → 打印归档字节数。
- [x] 生成器在归档字节数 >10 MiB 时以非零退出（D-6 的体积门在生成端先拦一道）。
- [x] 本机（Linux）跑通生成器与测试全绿；真实归档在本机解开后 `createLocalDb` 打开成功、状态正常。

### 任务 3：staging 与清单集成

- [x] `stage-runtime.mjs` 在组装载荷时调生成器（仅桌面两 target；沿用既有「拒绝非原生 target 在本机 staging」的口径，生成器只在原生 runner 上跑），归档落到载荷固定相对路径，清单写可选条目 `presetDb`。
- [x] `payload-size.mjs` 新增 `preset-db` 段：归档计入 total 并单列一行 `payload size: preset-db X MiB`；`checkSlimPayload` 对该段 >10 MiB 硬失败。补 `payload-size.test.mjs` 用例。
- [x] staging 相关既有测试全绿；本机 Linux staging 仍按既有口径失败于非原生 target（不为本项改这条），以 CI 平台 job 的 staging 成功为集成证据。

### 任务 4：运行时落地（种子规则与回退）

- [x] 先写失败测试（`apps/local/test/presetDb.test.ts`）：db 目录不存在 + 归档完好 → 落地后 PGlite 可打开且迁移零待执行；归档损坏/含逃逸路径 → 返回未落地、半成品清净、随后全量 `createLocalDb` 成功；db 目录已存在 → 函数不被调用或立即返回、既有内容逐字节不变。
- [x] 实现 `presetDb.ts`：解开到 `<home>/db.preset-<随机>` 临时目录，成功后 `renameSync` 就位；任何异常清掉临时目录并返回未落地。归档安全规则与组件安装器同口径（拒绝绝对路径、`..`、符号链接逃逸）。
- [x] `runtime.ts` 接入：种子检查必须放在现有 `ensureOwnedDirectory(paths.home, paths.db, "database")`（runtime.ts:529，紧临 `createLocalDb` 之前）**之前**——该调用会先把 db 目录建出来，检查若排在其后，种子条件永不成立。顺序为：清单条目缺失 → 跳过；存在且 db 目录不存在 → 先落地种子，随后既有 `ensureOwnedDirectory` 照常执行（对已落地的目录做真实目录校验与 0700 保护，其 mkdir 对已存在目录无操作），再 `createLocalDb`。成败各留一条诊断（成功记 `preset-db: seeded`、回退记原因）；`db` 阶段与既有 phase 名不变。
- [x] `apps/local` 与 `apps/hub` 测试全绿，根 `typecheck` 与 CLI 型检查通过。

### 任务 5：startup-sample 预置口径

- [x] `startup-sample.mjs` 增加 `preset` 子进程模式：父进程先按任务 2 的同口径现生成种子归档，子进程的计时从落地开始：`preset.totalMs` = 落地耗时 + `new PGlite` 就绪 + `migrate`，并单列 `landingMs`（另保留 `readyMs`/`migrateMs` 分项），冷/热字段保持原样。验收比较的必须是含落地的 `totalMs`——真实首次运行付的是全程。
- [x] verify.yml 平台 job 无需改动即带出新字段（若其断言/汇总对 JSON 形状有校验则同步更新）；在本项 PR 的 CI 运行上确认 windows/macos 两个平台 job 的日志各有一行带 `preset` 的 JSON。

### 任务 6：文档与 changelog

- [x] 核对四份 README、桌面 README 与三份指南中「数据目录/首次启动」段落：本项无用户可见的安装/配置/用法变化时，只在桌面 README 的数据目录段补一句首次运行种子与回退行为；有出入按实际改齐。
- [x] 加 changelog 片段 `changelog.d/preset-db-startup.changed.md`（每行以 "- " 开头）。

### 任务 7：验收与收口（#265）

- [x] 取实现合入后 windows-latest 最近 5 次含 `preset` 口径的 CI 样本，中位（取含落地耗时的 `preset.totalMs`）对照 D-6：≤1600ms 量级且较 3484ms 至少降一半；种子归档两 target 实测大小对照 ≤10 MiB 上限，均记进 #265 验收评论。任一不达：按 spec D-6 回到定案，不带病收口。
- [x] 在 #265 贴验收记录（自动化测试、CI 数字、载荷记账三类证据分开写；注明桌面真机未测是政策决定），达标后关闭 #265。
- [x] ROADMAP：P2-11 改已完成、v0.3.2 一节 #265 行按验收结果更新，执行记录补一行。

## 执行证据

（实现阶段填写：每个任务的命令与结果、未验证项与环境限制。未执行前留空，不预先声称任何结果。）

**2026-11-22 实现轮（任务 2–6 代码、测试、文档；分支 `feat/265-preset-db`，未提交、未推送）**

- 已写代码（未经执行验证，上面所有复选框因此保持未勾）：
  - 任务 2：`scripts/desktop/make-preset-db.mjs`（生成器：`createLocalDb` → `schema_migrations` 与迁移文件集合相等断言 → ustar+gzip 打包，无 pax 头 → >10 MiB 非零退出）；`make-preset-db.test.mjs`（集合断言、归档往返后 `createLocalDb` 打开且 `applied_at` 全早于打开时刻、集合不等失败不留输出、体积门、命令非零退出、拒绝符号链接）；verify.yml `test` job 在 hub/CLI 构建后跑该测试。
  - 任务 3：`stage-runtime.mjs` 用已暂存的 hub（`app/node_modules/@nema/hub`）在原生 runner 上生成 `preset/preset-db.tar.gz`，清单写可选 `presetDb`；`presetDbBuilder` 可注入（fixture 测试的 PGlite 是替身）；`payload-size.mjs` 新增 `preset-db` 段（计入 total、单列一行），`checkSlimPayload` 对 >10 MiB 硬失败（release 校验同样经过它）；`make.mjs` 的打包前清单校验在 `presetDb` 存在时校验其为载荷内文件。非原生 target 的 staging 拒绝未改。
  - 任务 4：`apps/local/src/presetDb.ts`（解到 `<home>/db.preset-<随机>` 后 `renameSync` 就位；失败清场返回未落地）；归档解开**复用** `apps/cli/src/components/archive.ts` 的 `extractTarGz`（`@nema/cli` 新增 `./components/archive` 导出；`@nema/local` 原本就依赖 `@nema/cli`，方向不变）；`runtime.ts` 在 `ensureOwnedDirectory(paths.home, paths.db, "database")` **之前**检查并落地；清单条目解析失败只停用种子、不阻塞启动；诊断为核心 stdout 既有 JSON 行通道上的一行 `{"state":"preset-db","result":"seeded","ms":…}` 或 `{"state":"preset-db","result":"fallback","reason":…}`。`createLocalDb`/`migrate` 未改。
  - 任务 5：`startup-sample.mjs` 增 `generate`/`preset` 子进程模式；JSON 行增 `preset`：`landingMs`、`readyMs`、`migrateMs`、`totalMs`（含落地）、`appliedOnOpen`、`archiveBytes`，以及供 D-2 形态比较的 `copyLandingMs`（同一份种子松散树拷贝到兄弟目录再改名，每次运行一次）；冷/热字段不变。
  - 任务 6：`apps/desktop` 下没有 README；桌面构建指南 `scripts/desktop/README.md` 没有数据目录段，在其列举清单条目的「Managed payload staging」段补了 `presetDb`/首次运行种子/回退，在载荷记账句补了 `preset-db` 硬上限。三份指南的「数据位置」与升级段在本项后仍然正确，未改；四份 README 未改。changelog 片段 `changelog.d/preset-db-startup.changed.md`。
- 已执行的检查：`git diff --check`（已跟踪文件）无输出。
- **未执行（阻塞）**：本轮会话的权限模式不允许执行脚本或写 git——`node --test`、`npx tsc -b`、`npx vitest`、`npm run build -w apps/hub`、`git add` 均要求人工批准而本会话无人可批。因此生成器本机端到端、归档字节数、全部单测、根 typecheck 与 CLI typecheck、`startup-sample` 本机运行、docs-check 均未跑，没有任何结果可记。本机 `apps/hub/dist` 迁移副本是旧的（20 个，源码 22 个），跑生成器测试前须先 `npm run build -w apps/hub`。

**2026-11-22 监督验证（Muse 在本机逐项执行，Linux 开发 VM，1.5 CPU）**

- 构建：`npm run build -w apps/hub`、`npm run build -w apps/cli` 均成功（hub 的 dist 迁移副本已刷新为 22 个）。
- 任务 2：`node --test scripts/desktop/make-preset-db.test.mjs` 7/7 通过，含端到端一条：生成的种子落地后 `createLocalDb` 打开、零迁移待执行；集合不等与超体积均失败且不写出。归档实测 4,828,237 字节（约 4.6 MiB，`startup-sample` 同口径读数），低于 D-6 的 10 MiB 上限。
- 任务 3：`node --test scripts/desktop/payload-size.test.mjs scripts/desktop/staging.test.mjs` 与 vitest 的 `apps/desktop/test/make.test.mjs` 全绿（staging 的种子构建走可注入替身；原生 target 的真实 staging 证据待本 PR 的 CI 平台 job——任务 3 第三条因此暂不勾）。
- 任务 4：`npx vitest run --project @nema/local --maxWorkers=1` 全量 18 个文件 278 通过、1 跳过（既有跳过），含新增 `presetDb.test.ts` 与 `runtime.test.ts` 的种子用例；根 `npx tsc -b` 与 `npm run typecheck -w apps/cli` 均通过。apps/hub 无文件改动，其套件未重跑。
- 任务 5：`node --test scripts/ci/startup-sample.test.mjs` 2/2 通过；本机实跑一行 JSON：cold totalMs 4372、warm 674、preset{landingMs 323、totalMs 858、appliedOnOpen 0、copyLandingMs 218、archiveBytes 4828237}。本机被限流（冷口径远高于 CI Linux 基线），只作形状与量级参考；windows/macos 平台 job 的 JSON 待本 PR 的 CI（任务 5 第二条、任务 1 暂不勾）。
- 任务 6：docs-check 对本计划通过；README/指南经实现轮核对后未改（原文仍正确），桌面构建指南的补记见实现轮记录。

**2026-11-23 验收收口（Muse，5 份合入后 main 样本）**

- 任务 1：形态结论以合入后 5 份 Windows 样本（CI run 45032739644 / 45032811052 / 45034035968 / 45034633144 / 45035216897）定案：归档落地耗时 716 / 998 / 1291 / 860 / 941 ms（中位 941），整树拷贝 952 / 1706 / 1544 / 697 / 1480 ms（中位 1480）。归档在 4/5 份样本中更快、中位快约 36%，D-2 的归档形态确认，无需改选 B。macOS 的 PR 样本同向（归档 573 vs 拷贝 815 ms）。
- 任务 3：PR #277 的 Build and smoke（win32-x64、darwin-arm64）均以原生 runner 真实生成种子并通过 payload 记账（preset-db 各 4.6 MiB，total win 79.7 / mac 77.5 MiB，均在 80 MiB 上限内）。
- 任务 5：PR #277 与合入后 main 运行的 windows/macos 平台 job 日志各有一行含 `preset` 的 JSON，字段齐备（landingMs/totalMs/appliedOnOpen/copyLandingMs/archiveBytes）。
- 任务 7：5 份合入后 Windows 样本的预置首次总耗时 1090 / 1126 / 1419 / 1510 / 1693 ms，中位 **1419 ms** ≤ D-6 的 1600 ms，且较 3484 ms 基线降 59.3%（≥50%）；`appliedOnOpen` 5 份均为 0；种子归档 4,827,790–4,828,260 字节（约 4.6 MiB）≤ 10 MiB。同期冷启动中位 3062 ms（较基线仅低 12.1%，runner 波动，不计入验收口径）。验收记录贴在 #265（验收评论 + 一条数字归属更正：59.3% 是预置中位相对基线的降幅，不是冷启动中位的），#265 已于 2026-11-23 关闭。桌面真机未测（2026-11-16 测试政策）。
