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

- [ ] 在 windows-latest 的 CI 环境实测同一份种子内容两种落地形态的耗时：单归档解压到目标目录就绪、整树拷贝到目标目录就绪，各至少 5 次取中位；macOS 同口径参考。
- [ ] 把实测数字与结论记进本任务的 PR 描述与 #265 评论。若归档形态不慢于拷贝（预期），按 D-2 定案走归档；若拷贝显著更快且实现不更复杂，改选 B 并在 spec 的 D-2 状态行下补记改选理由（不改定案本身，需维护者知情）。

### 任务 2：种子生成器与构建断言

- [ ] 先写失败测试：`schema_migrations` 集合与迁移文件集合不等时生成器报错；归档解开后目录可被 PGlite 打开且 `migrate` 零待执行。
- [ ] 实现 `make-preset-db.mjs`：用构建产物（与 staging 同一份 hub 构建）对临时目录 `createLocalDb` → 查询 `schema_migrations` 与迁移目录文件集合比对 → `close()` → 打归档 → 打印归档字节数。
- [ ] 生成器在归档字节数 >10 MiB 时以非零退出（D-6 的体积门在生成端先拦一道）。
- [ ] 本机（Linux）跑通生成器与测试全绿；真实归档在本机解开后 `createLocalDb` 打开成功、状态正常。

### 任务 3：staging 与清单集成

- [ ] `stage-runtime.mjs` 在组装载荷时调生成器（仅桌面两 target；沿用既有「拒绝非原生 target 在本机 staging」的口径，生成器只在原生 runner 上跑），归档落到载荷固定相对路径，清单写可选条目 `presetDb`。
- [ ] `payload-size.mjs` 新增 `preset-db` 段：归档计入 total 并单列一行 `payload size: preset-db X MiB`；`checkSlimPayload` 对该段 >10 MiB 硬失败。补 `payload-size.test.mjs` 用例。
- [ ] staging 相关既有测试全绿；本机 Linux staging 仍按既有口径失败于非原生 target（不为本项改这条），以 CI 平台 job 的 staging 成功为集成证据。

### 任务 4：运行时落地（种子规则与回退）

- [ ] 先写失败测试（`apps/local/test/presetDb.test.ts`）：db 目录不存在 + 归档完好 → 落地后 PGlite 可打开且迁移零待执行；归档损坏/含逃逸路径 → 返回未落地、半成品清净、随后全量 `createLocalDb` 成功；db 目录已存在 → 函数不被调用或立即返回、既有内容逐字节不变。
- [ ] 实现 `presetDb.ts`：解开到 `<home>/db.preset-<随机>` 临时目录，成功后 `renameSync` 就位；任何异常清掉临时目录并返回未落地。归档安全规则与组件安装器同口径（拒绝绝对路径、`..`、符号链接逃逸）。
- [ ] `runtime.ts` 接入：清单条目缺失 → 跳过；存在且 db 不存在 → 落地，成败各留一条诊断（成功记 `preset-db: seeded`、回退记原因）；`db` 阶段的顺序与既有 phase 名不变。
- [ ] `apps/local` 与 `apps/hub` 测试全绿，根 `typecheck` 与 CLI 型检查通过。

### 任务 5：startup-sample 预置口径

- [ ] `startup-sample.mjs` 增加 `preset` 子进程模式：父进程先按任务 2 的同口径现生成种子归档，子进程在全新目录落地种子后测 `new PGlite` + `migrate`，JSON 行输出 `preset: { readyMs, migrateMs, totalMs }`，冷/热字段保持原样。
- [ ] verify.yml 平台 job 无需改动即带出新字段（若其断言/汇总对 JSON 形状有校验则同步更新）；在本项 PR 的 CI 运行上确认 windows/macos 两个平台 job 的日志各有一行带 `preset` 的 JSON。

### 任务 6：文档与 changelog

- [ ] 核对四份 README、桌面 README 与三份指南中「数据目录/首次启动」段落：本项无用户可见的安装/配置/用法变化时，只在桌面 README 的数据目录段补一句首次运行种子与回退行为；有出入按实际改齐。
- [ ] 加 changelog 片段 `changelog.d/preset-db-startup.changed.md`（每行以 "- " 开头）。

### 任务 7：验收与收口（#265）

- [ ] 取实现合入后 windows-latest 最近 5 次含 `preset` 口径的 CI 样本，中位对照 D-6：≤1600ms 量级且较 3484ms 至少降一半；种子归档两 target 实测大小对照 ≤10 MiB 上限，均记进 #265 验收评论。任一不达：按 spec D-6 回到定案，不带病收口。
- [ ] 在 #265 贴验收记录（自动化测试、CI 数字、载荷记账三类证据分开写；注明桌面真机未测是政策决定），达标后关闭 #265。
- [ ] ROADMAP：P2-11 改已完成、v0.3.2 一节 #265 行按验收结果更新，执行记录补一行。

## 执行证据

（实现阶段填写：每个任务的命令与结果、未验证项与环境限制。未执行前留空，不预先声称任何结果。）
