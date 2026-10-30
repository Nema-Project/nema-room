# Skills 渐进载入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**状态：可实现。** D-1 到 D-6 已由用户在 2026-10-30 22:23–22:29 JST 决定（见 spec 末尾「已决定的事项」），实现不得改变这些选择。某项决定在当前 Claude Code 版本上做不到时（例如权限设置不生效），停下报告，不悄悄降级。

**Goal:** 让已启用的 Skill 在两种运行方式里按「目录 → 正文 → 资源」渐进载入：codex-direct 用 Nema 的 `read_skill`，Claude Code 用原生 Skill 加载并限定读取范围；再加 thread 内留存、绑定仓库的项目级 Skill 和 `/skill-name` 手动调用。

**Architecture:** daemon 每个任务取一份 Skill 快照（受管、外部、已信任仓库），带文件清单和版本标识。codex-direct 把目录接在 prompt 后面，并注册只读工具 `read_skill`。Claude Code 把快照复制进任务目录的 `.claude/skills`，用 `--tools Skill,Read`、`--setting-sources project` 和本任务的 `--settings` 文件限制读取和执行。激活经 Room API 报给 hub，记在 thread 上；hub 在后续任务的 `task.assign` 里带回，daemon 按当前状态重新预载。

**Tech Stack:** TypeScript、Node.js `fs` / `child_process`、Hono、Postgres 迁移、Next.js、Vitest。不新增依赖（`yaml` 只是根目录的 devDependency，不能在运行时用）。

**Spec:** [Skills 渐进载入设计](../specs/2026-10-30-skills-progressive-loading-design.md)。下文「§n」指该 spec「设计」一节的第 n 小节。

**Issue:** [#75](https://github.com/Nema-Project/nema-room/issues/75) 验收里的「Skills 渐进载入，而不是整段塞进 prompt」。

**Base:** 写本计划时的 `origin/main` 是 `f0827c3`（Merge pull request #125）。动手前 `git fetch origin main`，再看 `git diff --name-only f0827c3..origin/main -- apps/cli/src/claude apps/cli/src/direct apps/cli/src/extensions/store.ts apps/cli/src/extensions/source.ts apps/cli/src/extensions/install.ts apps/cli/src/room packages/shared/src/protocol.ts apps/hub/src/daemonSocket.ts apps/hub/src/prompt.ts apps/hub/src/roomApi.ts apps/hub/src/uiApi.ts apps/web/components/Composer.tsx apps/web/lib/slash.ts apps/web/components/PluginsPage.tsx apps/web/components/CodeAndPlugins.tsx`。有改动就先重读这些文件，与 spec「现状」不一致时先改本计划。

## 如何服务 #45

[#45](https://github.com/Nema-Project/nema-room/issues/45) 的判断标准见 spec「如何服务 #45」。本计划的每一批都保持那里的两条：Skill 是第三方说明，不是用户的陈述或决定；读取了哪个 Skill 的哪个版本，在任务事件里可以核对。

## Global Constraints

- **目标版本：** v0.2.0 发布前完成。D-4（Batch S5）或 D-5（Batch S6）来不及时，可以单独顺延到 v0.2.0 之后；顺延的能力在页面上照实显示为未提供。
- **工具面：** codex-direct 只多 `read_skill`；Claude Code 只多内置 `Skill` 和 `Read`。不开 Bash、PowerShell、Grep、Glob、Edit、Write、NotebookEdit、Agent、WebFetch。
- **Claude Code 版本门槛：** v2.1.309 或更新（`blockReadsOutsideWorkingDirectories` 要 v2.1.257+，`--add-dir` 重名前缀要 v2.1.309+）。低于门槛时 Skills 整体不可用，启动参数与现在完全一样。
- **Claude Code 设置文件内容固定为**：`{"permissions":{"blockReadsOutsideWorkingDirectories":true,"deny":["Read(//**/.git/**)"]},"disableSkillShellExecution":true,"disableAllHooks":true}`，文件 0600，放在 `<runDir>/claude-settings.json`。
- **大小限制：** codex-direct 目录 8000 字符；`read_skill` 每次 48 KB，每任务合计 512 KB；单文件 1 MiB，SKILL.md 256 KB；资源清单 200 项、深度 4；Claude Code 副本每任务 50 MiB；thread 留存预载 32 KB；手动调用正文超过 48 KB 截断；项目级 Skill 每个最多 500 个文件、单文件 5 MiB、合计 20 MiB。
- **Skill 名：** 规范规则：1-64 字符，`[a-z0-9-]`，不以连字符开头或结尾，没有连续连字符。对外 id 字符集 `[a-z0-9:-]`。
- **保留名：** `thread`、`progress`、`update`、以 `diagram:` 开头的名字。前端和 hub 用 `packages/shared` 导出的同一个常量。
- **协议兼容：** `task.assign` 新字段 `projectSkills`、`retainedSkills`、`manualSkill` 都是可选的；不改 `task.event` 的类型枚举。旧 hub 对 `POST /room/skills/activated` 回 404 时，daemon 忽略。
- **测试不联网**，只用临时 `nemaHome`、临时 git 仓库、假 Skill 目录和录好的 `stream-json` 夹具，不启动真实 Claude Code，不碰真实的 `~/.claude`。
- **避让：** 不改 `apps/cli/src/extensions/mcp*.ts`、`apps/cli/src/extensions/mcp/`、附件文档。`apps/cli/src/extensions/handlers.ts` 只改 `extensions.list` 一处：S1.4 加 `skill` 字段，S2.2 只换其中一个参数的来源。
- **迁移编号：** 实现时取 main 上最新号加一（写本计划时最新是 `014_message_attachments.sql`）。
- **文案：** 页面文字进 `apps/web/messages/{en,zh,ja}.json`，三种语言一起改。
- **只跑相关测试**：每个任务只跑它列出的测试文件和 `npm run typecheck`；全量测试交给 CI。

## Review Focus

- 所有路径检查都在打开之后复核（§2 第 5、6 项），不能只在打开前检查。
- Claude Code 的参数和设置文件逐项对照 spec §3、§4 的表；任何一项改动都要有官方文档依据。
- 任何地方都不存 Skill 正文到 hub。
- 旧 daemon、旧 hub 搭配新的一方时行为与现在一样。

## 文件结构

| 文件 | 职责 | 批次 |
| --- | --- | --- |
| `packages/shared/src/skills.ts`（新） | `SkillUsage`、`SkillGap`、`SkillNote`、`RESERVED_SLASH_NAMES`、`parseManualSkill`、`isSkillName` | S0 |
| `packages/shared/src/protocol.ts` | `task.assign` 三个可选字段 | S0 |
| `packages/shared/src/extensions.ts` | `ExtensionRecord.skill?: SkillUsage` | S0 |
| `apps/cli/src/skills/frontmatter.ts`（新） | 宽松 frontmatter 解析与诊断 | S0 |
| `apps/cli/src/skills/gaps.ts`（新） | 按文件和字段判定缺失能力，按运行方式算 `support` | S0 |
| `apps/cli/src/extensions/store.ts` | id 规则放宽 | S0 |
| `apps/cli/src/skills/safeRead.ts`（新） | 不跟链接、打开后复核的读取 | S1 |
| `apps/cli/src/skills/manifest.ts`（新） | 文件清单和 blob 摘要 | S1 |
| `apps/cli/src/skills/snapshot.ts`（新） | 每任务快照 | S1 |
| `apps/cli/src/skills/catalog.ts`（新） | codex-direct 目录文本 | S1 |
| `apps/cli/src/skills/readSkill.ts`（新） | `read_skill` 工具定义和执行 | S1 |
| `apps/cli/src/direct/tools.ts`、`direct/adapter.ts`、`direct/loop.ts` | 注册和分派 `read_skill` | S1 |
| `apps/cli/src/extensions/install.ts` | 安装时保存清单 | S1 |
| `apps/cli/src/skills/claudeSkills.ts`（新） | 副本、设置文件、参数片段 | S2 |
| `apps/cli/src/skills/claudeVersion.ts`（新） | `claude --version` 缓存与门槛 | S2 |
| `apps/cli/src/claude/launch.ts`、`claude/events.ts`、`claude/adapter.ts` | 接入副本和参数，识别激活 | S2 |
| `apps/hub/src/prompt.ts` | 第 127 条规则改写 | S2 |
| `apps/hub/src/db/migrations/0NN_thread_skill_activations.sql`（新） | 激活记录表 | S3 |
| `apps/hub/src/skillActivations.ts`（新） | 读写激活记录 | S3 |
| `apps/hub/src/roomApi.ts`、`apps/hub/src/daemonSocket.ts` | 报告接口、`retainedSkills` | S3 |
| `apps/cli/src/skills/preload.ts`（新） | 预载段落和预算 | S3 |
| `apps/cli/src/room/client.ts` | `reportSkillActivation` | S3 |
| `apps/web/components/PluginsPage.tsx`、`apps/web/messages/*.json`、`docs/guide.*.md`、`changelog.d/` | 显示与文档 | S4 |
| `apps/hub/src/db/migrations/0NN_repo_trust_skills.sql`（新）、`apps/hub/src/repos.ts`、`apps/hub/src/uiApi.ts` | 信任开关 | S5 |
| `apps/cli/src/skills/repoSkills.ts`（新） | 按提交扫描项目级 Skill | S5 |
| `apps/web/components/CodeAndPlugins.tsx` | 开关与列表 | S5 |
| `apps/cli/src/skills/rpc.ts`（新） | daemon RPC `skills.catalog` | S6 |
| `apps/web/lib/slash.ts`、`apps/web/components/Composer.tsx` | 菜单里的 Skills 组 | S6 |

## 批次与依赖

| 批次 | 依赖 | 可并行 |
| --- | --- | --- |
| S0 共享类型与解析 | — | — |
| S1 快照与 codex-direct `read_skill` | S0 | 与 S4 并行 |
| S2 Claude Code 原生加载 | S1 | 与 S4 并行 |
| S3 thread 留存 | S1、S2 | 与 S4 并行 |
| S4 页面显示、文案、文档 | S0 | 与 S1、S2、S3 并行 |
| S5 项目级 Skill（D-4） | S2；排在 S3 后（同改 `protocol.ts`、`daemonSocket.ts`） | 与 S6 串行 |
| S6 `/skill-name`（D-5） | S2；排在 S3 后（同上）；不依赖 S5 | 与 S5 串行 |
| S7 真实环境验收 | 已合并的各批 | — |

S5、S6 谁先做都可以；任何一个都可以单独顺延到 v0.2.0 之后，不影响另一个。每一批一个 PR，按顺序合并；可并行的批次各开一个 worktree。

---

## Batch S0：共享类型与解析

### Task S0.1：共享 Skill 类型、保留名和手动调用识别

**Files:**
- Create: `packages/shared/src/skills.ts`（从包入口 `packages/shared/src/index.ts` 导出）
- Modify: `packages/shared/src/extensions.ts:22-44`（`ExtensionRecord` 加可选 `skill?: SkillUsage`）
- Modify: `packages/shared/src/protocol.ts:36-48`（`task.assign` 加三个可选字段）
- Test: `packages/shared/test/skills.test.ts`、`packages/shared/test/protocol.test.ts`

**Interfaces:**
- Produces:
  - `type SkillAdapter = "claude-code" | "codex-direct"`
  - `type SkillGap = "scripts" | "shell-injection" | "allowed-tools" | "subagent" | "hooks" | "paths" | "binary-assets" | "skill-dir-variable" | "claude-code-too-old"`
  - `type SkillNote = "model-override" | "stop-not-enforced" | "reserved-slash-name"`
  - `type SkillUsage = { runtimes: Array<{ adapter: SkillAdapter; support: "full" | "partial" | "none"; missing: SkillGap[]; notes: SkillNote[] }>; compatibility: string | null; diagnostics: string[]; invocation: "model-and-user" | "user-only" | "model-only" }`
  - `const RESERVED_SLASH_NAMES: readonly string[] = ["thread", "progress", "update"]` 和 `isReservedSlashName(id: string): boolean`（另含 `diagram:` 前缀判断）
  - `isSkillName(name: string): boolean`：Global Constraints 里的规范规则
  - `parseManualSkill(content: string): { skillId: string; arguments: string } | null`：去掉开头空白后匹配 `^/([a-z0-9][a-z0-9:-]*)(?:\s+([\s\S]*))?$`；保留名返回 `null`；`arguments` 去掉首尾空白
  - `task.assign` 新字段：`projectSkills?: Array<{ repoId: string; label: string; path: string; mainBranch: string }>`、`retainedSkills?: string[]`、`manualSkill?: { skillId: string; arguments: string }`

- [ ] **Step 1: 写失败测试**：
  - `isSkillName`：`pdf-tools`、`3d-print` 合法；`-a`、`a-`、`a--b`、`A`、65 个字符不合法。
  - `parseManualSkill`：`"/tdd 写个测试"` → `{ skillId: "tdd", arguments: "写个测试" }`；`"  /web:deploy"` → `{ skillId: "web:deploy", arguments: "" }`；`"说 /tdd"`、`"/"`、`"/Tdd"` → `null`；`"/thread x"`、`"/diagram:flow"` → `null`；多行参数保留换行。
  - `protocol.test.ts`：带和不带三个新字段的 `task.assign` 都能解析；`manualSkill.skillId` 不是字符串时解析失败。
- [ ] **Step 2: 跑** `npx vitest run packages/shared/test/skills.test.ts packages/shared/test/protocol.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(shared): describe skill usage, reserved slash names and manual invocation`

### Task S0.2：宽松 frontmatter 解析

**Files:**
- Create: `apps/cli/src/skills/frontmatter.ts`
- Test: `apps/cli/test/skills/frontmatter.test.ts`

**Interfaces:**
- Consumes: `isSkillName`（S0.1）
- Produces: `parseSkillFile(text: string, folderName: string): { ok: true; meta: SkillMeta; body: string; diagnostics: string[] } | { ok: false; reason: "no-frontmatter" | "no-description" | "unparseable" }`
  - `SkillMeta = { name: string; description: string; whenToUse: string | null; license: string | null; compatibility: string | null; metadata: Record<string, string>; allowedTools: string | null; disableModelInvocation: boolean; userInvocable: boolean; context: string | null; agent: string | null; hooks: boolean; paths: string[] | null; model: string | null; effort: string | null }`
  - `body`：去掉 frontmatter 后的正文。

规则照 spec §「解析宽松度」：名字和目录不一致、超长、含保留词 `anthropic` / `claude` 或 XML 标签 → 写诊断，照常返回 `ok: true`；`description` 为空 → `no-description`；值里有未加引号的冒号时按整行取值（社区兜底）。只支持现有 `skillFrontMatter`（`apps/cli/src/extensions/source.ts:115-137`）已支持的标量、折叠和字面块，再加一层 `metadata:` 下的 `key: value` 映射和 `paths:` 下的 `- item` 列表。`hooks` 只记有没有，不解析内容。不引入 YAML 库。

- [ ] **Step 1: 写失败测试**：规范里的最小示例；带 `metadata` 和 `allowed-tools`；`description: Use when: x` 未加引号；`>` 折叠块；`disable-model-invocation: true`；`user-invocable: false`；`paths` 列表；名字与目录不同（有诊断、`ok: true`）；没有 frontmatter；空描述；CRLF 换行。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/frontmatter.test.ts` → FAIL。
- [ ] **Step 3: 实现。** `skillFrontMatter` 保持不变（安装流程仍用它），不改 `source.ts`。
- [ ] **Step 4: 跑** 同一条 → PASS。
- [ ] **Step 5: Commit** `feat(cli): parse SKILL.md front matter leniently`

### Task S0.3：缺失能力判定

**Files:**
- Create: `apps/cli/src/skills/gaps.ts`
- Test: `apps/cli/test/skills/gaps.test.ts`

**Interfaces:**
- Consumes: `SkillMeta`（S0.2），`SkillUsage` 等（S0.1）
- Produces: `skillUsage(input: { meta: SkillMeta; body: string; files: Array<{ path: string; executable: boolean; binary: boolean }>; diagnostics: string[]; claudeCodeOk: boolean; reservedSlash: boolean }): SkillUsage`

判定按 spec §5 能力表，只看文件和字段：
- `scripts/` 下有文件或任何文件可执行 → 两种运行方式都 `scripts`
- 正文有 `` !` `` 或以 ```` ```! ```` 开头的代码块 → 两种都 `shell-injection`
- `allowed-tools` → 两种都 `allowed-tools`
- `context: fork` 或 `agent` → 两种都 `subagent`
- `hooks` → 两种都 `hooks`
- `paths` → 两种都 `paths`
- 有二进制文件 → 只有 codex-direct `binary-assets`
- 正文有 `${CLAUDE_SKILL_DIR}` → 只有 codex-direct `skill-dir-variable`
- `model` 或 `effort` → Claude Code 加 note `model-override`
- Claude Code 一律加 note `stop-not-enforced`
- `claudeCodeOk: false` → Claude Code `support: "none"`，`missing: ["claude-code-too-old"]`
- `reservedSlash` → 两种都加 note `reserved-slash-name`
- 没有缺失 → `full`；有缺失 → `partial`
- `invocation`：`disable-model-invocation` → `user-only`；`user-invocable: false` → `model-only`；都没有 → `model-and-user`

- [ ] **Step 1: 写失败测试**：上面每一条各一例；一个纯说明 Skill 两种都是 `full`（Claude Code 仍有 `stop-not-enforced`）；同时有 `scripts/` 和图片的 Skill。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/gaps.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): work out per-runtime skill gaps`

### Task S0.4：id 规则放宽到规范

**Files:**
- Modify: `apps/cli/src/extensions/store.ts:8`
- Test: `apps/cli/test/extensions/store.test.ts`

现有规则 `^[a-z][a-z0-9-]{0,63}$` 不接受以数字开头的名字，也接受连续连字符。改成与 `isSkillName` 一致（MCP、插件记录的 id 也走这条，所以测试要覆盖它们仍能保存）。已有的不符合新规则的 id（以连字符结尾或含 `--`）仍要能读出和卸载：只在新建记录时校验新规则，读索引不校验。

- [ ] **Step 1: 写失败测试**：`3d-print` 可以安装；`a--b` 新建被拒；索引里已有的 `a--b` 能列出、能卸载；内置 id 仍不能重名。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/extensions/store.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条和 `apps/cli/test/extensions/handlers.test.ts` → PASS。
- [ ] **Step 5: Commit** `fix(cli): accept skill ids the Agent Skills spec allows`

---

## Batch S1：快照与 codex-direct `read_skill`

### Task S1.1：安全读取

**Files:**
- Create: `apps/cli/src/skills/safeRead.ts`
- Test: `apps/cli/test/skills/safeRead.test.ts`

**Interfaces:**
- Produces:
  - `normalizeSkillPath(raw: string): string | null`：反斜杠换 `/`；拒绝空串、绝对路径、盘符、UNC、NUL、`..` 段；去掉 `./`
  - `readInsideRoot(root: string, rel: string, maxBytes: number, hooks?: { afterCheck?: () => void }): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: "outside" | "link" | "not-file" | "too-large" | "changed" | "missing" }>`
  - `listResources(root: string, opts: { maxItems: 200; maxDepth: 4 }): Promise<string[]>`：跳过 `.git/`、`node_modules/`、链接

`readInsideRoot` 按 spec §2 第 5、6 项：逐段 `lstat` 并记下 `dev`/`ino`；POSIX 用 `O_RDONLY | O_NOFOLLOW` 打开，Windows 用普通打开再核对；`fstat` 核对最后一段，逐个上级目录重新 `lstat` 核对，再 `realpath` 确认在根内且是普通文件。字节只从这个描述符读。`afterCheck` 只给测试用，在检查和打开之间调用。

- [ ] **Step 1: 写失败测试**：`../x`、`/etc/passwd`、`C:\x`、`a\0b` 被拒；中间目录是链接被拒；文件是链接被拒；`afterCheck` 里把文件换成指向根外的链接 → `link` 或 `changed`；`afterCheck` 里把上级目录换掉 → `changed`；超过 `maxBytes` → `too-large`；`listResources` 跳过 `.git` 和链接、截到 200 项。POSIX 专属的测试用 `test.skipIf(process.platform === "win32")`。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/safeRead.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): read skill files without following links`

### Task S1.2：文件清单

**Files:**
- Create: `apps/cli/src/skills/manifest.ts`
- Modify: `apps/cli/src/extensions/install.ts:44-72`（安装完成时把 GitHub 树里每个文件的 blob SHA 写进 `<受管目录>/.nema-manifest.json`）
- Test: `apps/cli/test/skills/manifest.test.ts`、`apps/cli/test/extensions/install.test.ts`

**Interfaces:**
- Produces:
  - `type SkillManifest = { files: Array<{ path: string; size: number; blob: string; executable: boolean; binary: boolean }> }`
  - `gitBlobSha(bytes: Buffer): string`：`sha1("blob " + len + "\0" + bytes)`
  - `loadManifest(root: string, kind: "managed" | "external"): Promise<SkillManifest>`：受管 Skill 读 `.nema-manifest.json`，没有就现算并写入；外部 Skill 每次现算，不写入用户目录
  - `revisionOf(record: ExtensionRecord, manifest: SkillManifest): string`：受管是记录里的提交号；外部是 `local@` 加 SKILL.md blob 前 7 位

`binary`：前 8 KB 有 NUL 字节即算二进制。`.nema-manifest.json` 自己不进清单。

- [ ] **Step 1: 写失败测试**：`gitBlobSha` 与 `git hash-object` 对同一内容一致（夹具里写死期望值，不调 git）；受管目录没有清单时补算并写入；外部目录不写文件；安装后清单里的 blob 与假 GitHub 树一致。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/manifest.test.ts apps/cli/test/extensions/install.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): keep a per-file manifest for installed skills`

### Task S1.3：每任务快照

**Files:**
- Create: `apps/cli/src/skills/snapshot.ts`
- Test: `apps/cli/test/skills/snapshot.test.ts`

**Interfaces:**
- Consumes: `parseSkillFile`、`skillUsage`、`loadManifest`、`revisionOf`、`readInsideRoot`
- Produces:
  - `type SnapshotSkill = { id: string; source: "managed" | "external" | "repo"; recordId: string | null; repo: { repoId: string; label: string; slug: string; path: string; commit: string } | null; root: string | null; meta: SkillMeta; manifest: SkillManifest; revision: string; usage: SkillUsage }`（`root` 对仓库 Skill 为 `null`；仓库 Skill 的文件一律经 `readRepoFile` 读，见 S5.2）
  - `type SkillSnapshot = { skills: SnapshotSkill[]; warnings: string[] }`
  - `takeSnapshot(o: { nemaHome: string; claudeCodeOk: boolean; repoSkills?: SnapshotSkill[] }): Promise<SkillSnapshot>`
  - `stillReadable(nemaHome: string, skill: SnapshotSkill): Promise<boolean>`：重读索引，确认仍是 `installed` + `enabled`，并重做 `ownedDirectory` 或 `realpath` 核对

过滤条件见 spec §1。解析失败的 Skill 不进快照，写一条 warning。`repoSkills` 在 S5 前总是空。

- [ ] **Step 1: 写失败测试**：启用的受管、外部 Skill 进快照；停用、`installing`、`damaged` 的不进；SKILL.md 解析失败写 warning；外部目录被换成链接后 `stillReadable` 为 `false`；停用后 `stillReadable` 为 `false`。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/snapshot.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): snapshot enabled skills per task`

### Task S1.4：`extensions.list` 带上 `skill` 字段

**Files:**
- Modify: `apps/cli/src/extensions/handlers.ts:69`（`extensions.list`，`f20e2d6` 行号）
- Test: `apps/cli/test/extensions/handlers.test.ts`

对每条 `kind: "skill"` 的记录，用 S0.2、S0.3、S1.2 算出 `skill: SkillUsage`。Claude Code 门槛在 S2 前一律按通过算（`claudeCodeOk: true`）；S2.2 再接上真实结果。算不出（文件读不了）时不带 `skill` 字段，不让整个列表失败。

- [ ] **Step 1: 写失败测试**：带 `scripts/` 的 Skill，`extensions.list` 返回里两种运行方式都是 `partial` 并含 `scripts`；读不了的 Skill 没有 `skill` 字段，其余记录正常。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/extensions/handlers.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): report per-runtime skill support in extensions.list`

### Task S1.5：codex-direct 目录与 `read_skill`

**Files:**
- Create: `apps/cli/src/skills/catalog.ts`、`apps/cli/src/skills/readSkill.ts`
- Modify: `apps/cli/src/direct/tools.ts:90-154`（`roomTools` 接受可选的 `read_skill` 定义；`dispatchTool` 认识 `read_skill` 并转给 `SkillReader`）
- Modify: `apps/cli/src/direct/loop.ts:18-30`（选项加 `skills?: SkillReader`）、`apps/cli/src/direct/adapter.ts:192-216`（取快照、追加目录、传入 `SkillReader`）
- Test: `apps/cli/test/skills/catalog.test.ts`、`apps/cli/test/skills/readSkill.test.ts`、`apps/cli/test/direct/tools.test.ts`、`apps/cli/test/direct/adapter.test.ts`

**Interfaces:**
- Consumes: `SkillSnapshot`、`stillReadable`、`readInsideRoot`、`listResources`
- Produces:
  - `escapeSkillText(s: string): string`：转义 `& < > "`，去掉控制字符
  - `codexCatalog(snapshot: SkillSnapshot): { text: string; omitted: number } | null`：没有可列出的 Skill 返回 `null`
  - `readSkillTool(snapshot: SkillSnapshot): FunctionTool | null`：`name` 是快照 id 的枚举
  - `class SkillReader { constructor(o: { nemaHome: string; snapshot: SkillSnapshot; onActivated: (id: string, revision: string) => Promise<void>; onRead: (text: string) => void; readRepoFile?: (skill: SnapshotSkill, path: string, maxBytes: number) => Promise<Buffer> }); read(args: unknown): Promise<string>; markLoaded(id: string): void; settle(timeoutMs: number): Promise<void> }`
    - `readRepoFile` 在 S5 前不传；快照里有仓库 Skill 而没传它时，读取这个 Skill 报错（S5.2 接上）
    - `settle`：等所有 `onActivated` 返回的 Promise 结束，最多等 `timeoutMs`；adapter 在发 `task.finished` 之前调用 `settle(5000)`

行为逐条照 spec §2：目录格式、8000 字符降级顺序、`<skill_content>` 包装、资源清单、48 KB 分页和 `offset`、同页去重、512 KB 合计、二进制只报类型和大小、每次读都过 `stillReadable` 和清单摘要。`onRead` 发 `tool_call` 任务事件「读取 Skill <id>（<版本>）[<path>]」；不带 `path`、`offset` 为 0 的成功读取再调 `onActivated`（S3 接上报告）。`markLoaded` 给 S3、S6 的预载用。

`dispatchTool` 的签名加第五个可选参数 `skills?: SkillReader`；`read_skill` 只在传了 `skills` 时算已知函数。没有 Skill 时不注册工具、不追加目录（`codexCatalog` 返回 `null`），prompt 与现在逐字相同。

- [ ] **Step 1: 写失败测试**：
  - 目录：描述里有 `</description>` 被转义；`disable-model-invocation` 的不列出；缺能力的列出并有 `<missing>`；20 个长描述时先截短到不少于 200 字符，再省略并写「另有 N 个」；没有 Skill 返回 `null`。
  - `read_skill`：不在枚举里的名字被拒；正文去掉 frontmatter、带 `revision`；资源清单不含 `.git`；`path: "../x"` 被拒；100 KB 文件分三页，`offset` 连得上，在多字节字符中间不截断；同一页再读回「已载入」；第 513 KB 被拒；停用后读被拒；文件内容改了被拒并提示下个任务生效；PNG 只报类型和大小。
  - `dispatchTool`：没传 `skills` 时 `read_skill` 是未知函数。
  - adapter：有 Skill 时 `instructions` 以 hub prompt 开头、后接目录，`tools` 含 `read_skill`；没有 Skill 时与现在相同。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/catalog.test.ts apps/cli/test/skills/readSkill.test.ts apps/cli/test/direct/tools.test.ts apps/cli/test/direct/adapter.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(cli): progressive skill loading for codex-direct`

---

## Batch S2：Claude Code 原生加载

### Task S2.1：副本与设置文件

**Files:**
- Create: `apps/cli/src/skills/claudeSkills.ts`
- Test: `apps/cli/test/skills/claudeSkills.test.ts`

**Interfaces:**
- Consumes: `SkillSnapshot`、`readInsideRoot`、清单摘要
- Produces:
  - `CLAUDE_SKILL_SETTINGS`：Global Constraints 里的设置对象
  - `prepareClaudeSkills(o: { runDir: string; snapshot: SkillSnapshot; readRepoFile?: (skill: SnapshotSkill, path: string, maxBytes: number) => Promise<Buffer> }): Promise<ClaudeSkillPrep>`，`ClaudeSkillPrep = { settingsPath: string; addDirs: string[]; copied: string[]; skipped: Array<{ id: string; reason: "budget" | "changed" | "unreadable" }>; skillDirs: Map<string, string> }`
    - **调用顺序：** 必须在 `prepareClaudeLaunch` 之后调用。`prepareClaudeLaunch` 开头会 `rmSync(runDir)` 再重建（`launch.ts:43-45`），所以先建目录、再复制，复制完不再清理；`runDir` 必须已存在，否则抛错
    - 用户级 Skill 复制到 `<runDir>/work/.claude/skills/<id>/`
    - 仓库 Skill 复制到 `<runDir>/repo-skills/<slug>/.claude/skills/<name>/`（S5 前没有）。`slug` 取 `SnapshotSkill.repo.slug`（S5.2 保证合法且在本任务内唯一），绝不用原始标签；目录名再按 `isSkillName` 校验一次，拼出的路径 `path.resolve` 后必须仍在 `<runDir>/repo-skills/` 之下，否则跳过并记 `unreadable`
    - `skillDirs`：对外 id → 副本里 SKILL.md 的绝对路径，给激活识别用
    - 设置文件写到 `<runDir>/claude-settings.json`，0600

复制时：逐文件走 `readInsideRoot` 并核对 blob，不一致就整个 Skill 跳过（`changed`）；跳过 `.claude-plugin/`；新文件 0600、目录 0700；合计超过 50 MiB 的 Skill 跳过（`budget`）。

- [ ] **Step 1: 写失败测试**：两个 Skill 复制后的目录树；`repo.slug` 为 `../x` 时跳过、不在 `runDir` 外写任何东西；`.claude-plugin/plugin.json` 没有被复制；源里的链接没有被复制或跟随；超过预算的 Skill 在 `skipped`；复制前改文件 → `changed`；设置文件内容逐字等于 `CLAUDE_SKILL_SETTINGS`，权限 0600（POSIX）。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/claudeSkills.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): copy enabled skills into the Claude Code task dir`

### Task S2.2：版本门槛

**Files:**
- Create: `apps/cli/src/skills/claudeVersion.ts`
- Modify: `apps/cli/src/extensions/handlers.ts` 的 S1.4 调用处只改一个参数来源（把固定的 `claudeCodeOk: true` 换成 `(await claudeSkillsSupported()).ok`），不改别的。版本号不进 `SkillUsage`；版本过低时缺失项 `claude-code-too-old` 的文案里写固定的门槛 `MIN_CLAUDE_SKILLS_VERSION`
- Test: `apps/cli/test/skills/claudeVersion.test.ts`

**Interfaces:**
- Produces:
  - `MIN_CLAUDE_SKILLS_VERSION = "2.1.309"`
  - `parseClaudeVersion(stdout: string): string | null`（取第一个 `\d+\.\d+\.\d+`）
  - `claudeSkillsSupported(run?: () => Promise<string>): Promise<{ ok: boolean; version: string | null }>`：只运行一次并缓存；运行失败算 `ok: false`

- [ ] **Step 1: 写失败测试**：`"2.1.309 (Claude Code)"` 通过；`2.1.308`、`2.0.999` 不通过；`2.10.0` 通过（按数字比较）；无法解析不通过；第二次调用不再运行。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/claudeVersion.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): gate native skills on the Claude Code version`

### Task S2.3：启动参数、工具检查和激活识别

**Files:**
- Modify: `apps/cli/src/claude/launch.ts`（`prepareClaudeLaunch` 不变；新增 `withSkillArgs(args: string[], prep: ClaudeSkillPrep): string[]`，把 `--setting-sources` 和 `--tools` 后面的值换掉，再追加其余参数）
- Modify: `apps/cli/src/claude/events.ts`（`init` 带 `version`、`skills`；新增 `tool_use` 详情和 `tool_result` 解析；`roomToolsOk` 接受额外允许的内置工具）
- Modify: `apps/cli/src/claude/adapter.ts:100-220`（取快照、复制、追加 Skills 段落、允许集合加 `Skill` 和 `Read`、识别激活）
- Modify: `apps/hub/src/prompt.ts:127`
- Test: `apps/cli/test/claude/launch.test.ts`、`apps/cli/test/claude/events.test.ts`、`apps/cli/test/claude/adapter.test.ts`、`apps/hub/test/prompt.test.ts`
- Fixture: `apps/cli/test/fixtures/claude-skill-stream.jsonl`（新，手写的 `stream-json` 行）

**Interfaces:**
- Consumes: `prepareClaudeSkills`、`claudeSkillsSupported`、`takeSnapshot`
- Produces:
  - `ClaudeLine` 的 `init` 变体加 `version: string | null; skills: string[] | null`
  - 新变体 `{ kind: "tools"; names: string[]; uses: Array<{ id: string; name: string; input: unknown }> }`（`names` 保留，现有调用不变）
  - 新变体 `{ kind: "results"; results: Array<{ toolUseId: string; isError: boolean }> }`（来自 `type: "user"` 消息里的 `tool_result` 块）
  - `skillActivationFrom(use: { name: string; input: unknown }, skillDirs: Map<string, string>): string | null`

adapter 的顺序：`prepareClaudeLaunch` → `prepareClaudeSkills({ runDir: launch.runDir, … })` → `withSkillArgs(launch.args, prep)`。参数和设置照 spec §3 的表：有 Skill 时 `--setting-sources project`、`--tools Skill,Read`、`--allowedTools` 追加 `Skill,Read(/.claude/skills/**)`、每个 `addDirs` 一个 `--add-dir`、`--settings <settingsPath>`；不调用 `withSkillArgs` 时参数与现在逐字相同。版本不够、快照为空或复制后一个都没有时，都不调用它。

读取批准：Claude Code 文档写明，工作目录和 `--add-dir` 目录里的读取不需要批准（[权限](https://code.claude.com/docs/en/permissions) 开头的工具类型表）。所以 `repo-skills/<slug>` 下的读取不需要另加允许规则；`Read(/.claude/skills/**)` 只是把主工作目录的情况写明。S7 Step 2 实测这一点。

`roomToolsOk` 的允许集合加上 `Skill`、`Read`；`init` 里出现其他内置工具仍判失败。`init.version` 低于门槛或 `init.skills` 缺了已复制的 Skill 时，写一条进度警告，不让任务失败。

激活识别照 spec §3：`Skill` 的输入字段名在官方文档里没有写，`skillActivationFrom` 先从输入对象里取唯一一个字符串值，对到快照 id 或副本目录名；取不到返回 `null` 并写一条进度提示。S7 实测后把字段名写死，并更新这条测试。`Read` 的 `file_path` 等于 `skillDirs` 里某个值也算激活。只在对应 `tool_result` 不是错误时，才发「读取 Skill」事件、调 `onActivated`。

Skills 段落和 hub 第 127 条规则的新文字照 spec §3 逐字写。

- [ ] **Step 1: 写失败测试**：
  - `launch.test.ts`：`prepareClaudeLaunch` 的参数与现有测试的期望完全一样；`withSkillArgs` 逐项检查上面的参数，顺序固定，`--setting-sources`、`--tools` 各只出现一次。
  - `claudeSkills.test.ts` 加一例：先 `prepareClaudeLaunch` 再 `prepareClaudeSkills`，副本和设置文件都还在；`runDir` 不存在时抛错。
  - `events.test.ts`：夹具里的 `init` 解析出版本和 `skills`；`Skill` 调用和 `Read` 调用的 `uses`；`tool_result` 成功和失败。
  - `adapter.test.ts`（用现有的假 Claude 子进程写法）：`init` 里有 `Skill`、`Read` 不判失败，有 `Bash` 判失败；成功的 `Skill` 调用产生一条「读取 Skill」事件；失败的不产生；版本不够时参数与现在相同。
  - `prompt.test.ts`：第 127 条规则的新文字。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/claude/launch.test.ts apps/cli/test/claude/events.test.ts apps/cli/test/claude/adapter.test.ts apps/hub/test/prompt.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** 同一条和 `npm run typecheck` → PASS。
- [ ] **Step 5: Commit** `feat(cli): load skills natively in Claude Code with confined reads`

---

## Batch S3：thread 内留存（D-6）

### Task S3.1：hub 激活记录

**Files:**
- Create: `apps/hub/src/db/migrations/0NN_thread_skill_activations.sql`
- Create: `apps/hub/src/skillActivations.ts`
- Modify: `apps/hub/src/roomApi.ts`（加 `POST /skills/activated`，与 `/threads`、`/entries` 同一套 runToken 认证）
- Test: `apps/hub/test/skillActivations.test.ts`、`apps/hub/test/roomApi.test.ts`

**Interfaces:**
- Produces:
  - 表：`thread_skill_activations(thread_id text not null references threads(id) on delete cascade, skill_id text not null, last_activated_at timestamptz not null, last_task_id text not null, revision text not null, primary key (thread_id, skill_id))`（外键列类型照 `threads.id` 实际类型）
  - `recordActivation(db, o: { taskId: string; skillId: string; revision: string }): Promise<"recorded" | "not-thread">`：经任务的 `message_id` 找到消息所在 thread；主聊天返回 `not-thread`，不写
  - `retainedSkills(db, threadId: string): Promise<string[]>`：按 `last_activated_at` 从新到旧
  - Room API：请求体 `{ skillId: string; revision: string }`，`skillId` 不超过 130 字符、只含 `[a-z0-9:-]`；成功 204

- [ ] **Step 1: 写失败测试**：thread 里的任务写入；同一个 Skill 再激活只更新时间和任务；主聊天任务不写；thread 删除后记录没了；非法 `skillId` 400；runToken 不对 401。
- [ ] **Step 2: 跑** `npx vitest run apps/hub/test/skillActivations.test.ts apps/hub/test/roomApi.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(hub): remember which skills a thread activated`

### Task S3.2：派发时带上 `retainedSkills`

**Files:**
- Modify: `apps/hub/src/daemonSocket.ts:186-260`
- Test: `apps/hub/test/daemonSocket.test.ts`

任务的消息在 thread 里且有记录时，`task.assign` 带 `retainedSkills`；主聊天任务和没有记录的 thread 不带这个字段。

- [ ] **Step 1: 写失败测试**：上面三种情况。
- [ ] **Step 2: 跑** `npx vitest run apps/hub/test/daemonSocket.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(hub): send a thread's activated skills with its next task`

### Task S3.3：daemon 报告与预载

**Files:**
- Create: `apps/cli/src/skills/preload.ts`
- Modify: `apps/cli/src/room/client.ts`（加 `reportSkillActivation(skillId, revision)`；404 当作成功忽略）
- Modify: `apps/cli/src/direct/adapter.ts`、`apps/cli/src/claude/adapter.ts`（把 S1.5、S2.3 的 `onActivated` 接到 `reportSkillActivation`；追加预载段落）
- Test: `apps/cli/test/skills/preload.test.ts`、`apps/cli/test/room/client.test.ts`、`apps/cli/test/direct/adapter.test.ts`、`apps/cli/test/claude/adapter.test.ts`

**Interfaces:**
- Consumes: `SkillSnapshot`、`SkillReader.markLoaded`
- Produces: `preloadSection(o: { snapshot: SkillSnapshot; retained: string[]; budgetBytes: 32768; readBody: (skill: SnapshotSkill) => Promise<string> }): Promise<{ text: string | null; loaded: string[]; dropped: string[] }>`

报告要等：`onActivated` 返回 `reportSkillActivation` 的 Promise，adapter 在结束任务前调 `SkillReader.settle(5000)`（Claude Code 那边同样收集这些 Promise 再结束）。超时或失败写一条进度警告，不让任务失败。

规则照 spec §8：不在快照里的跳过；从新到旧放，放不下就停（后面的全进 `dropped`）；格式同 `<skill_content>`；预载不报告激活。codex-direct 对 `loaded` 调 `markLoaded`；Claude Code 在 Skills 段落里写「以下 Skill 已载入，不必再调用」。

- [ ] **Step 1: 写失败测试**：停用的跳过；升级后读到新正文；三个 15 KB 的 Skill 只放前两个（最新的两个）；`retained` 为空返回 `text: null`；`reportSkillActivation` 遇到 404 不抛错；codex-direct 读取正文后发了一次报告，预载的没有；报告的 Promise 未完成时任务不会先发 `task.finished`；报告超过 5 秒时任务照常结束并有警告。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/preload.test.ts apps/cli/test/room/client.test.ts apps/cli/test/direct/adapter.test.ts apps/cli/test/claude/adapter.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): report skill activations and preload them in threads`

---

## Batch S4：页面显示、文案、文档

可以在 S0 合并后与 S1–S3 并行。只读 `ExtensionRecord.skill`，没有这个字段时（旧 daemon）不显示能力行。

### Task S4.1：插件页能力行和停用提示

**Files:**
- Modify: `apps/web/components/PluginsPage.tsx`
- Modify: `apps/web/lib/types.ts`（如果 web 自己声明了扩展类型，加 `skill?: SkillUsage`；否则直接用 `@nema/shared`）
- Modify: `apps/web/messages/{en,zh,ja}.json`
- Test: `apps/web/test/PluginsPage.test.tsx`

每个 Skill 行写两行，例如「Claude Code：部分可用，缺少：执行脚本」「Nema 内置 Agent：部分可用，缺少：执行脚本、读取图片」。`claude-code-too-old` 显示「Claude Code 版本过低（需要 2.1.309 或更新），Skills 不可用」。`model-override`、`reserved-slash-name` 显示对应说明。停用确认加一句「正在运行的 Claude Code 任务仍可能读取它」。每个 `SkillGap`、`SkillNote` 都有三语文案。

- [ ] **Step 1: 写失败测试**：`partial` 的两行文字；`none` 和版本过低；没有 `skill` 字段时不显示；停用确认的新句子；三个语言文件的键集合相同（照现有 i18n 测试写法）。
- [ ] **Step 2: 跑** `npx vitest run apps/web/test/PluginsPage.test.tsx` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(web): show per-runtime skill support`

### Task S4.2：用户文档和 changelog

**Files:**
- Modify: `docs/guide.zh.md`、`docs/guide.en.md`、`docs/guide.ja.md`（Skills 一节）
- Create: `changelog.d/skills-progressive-loading.added.md`

写清：两种运行方式各能做什么（照 spec §5 的表）；不执行脚本；Claude Code 需要的版本；停用对进行中任务的影响。S5、S6 合并时再各自补充，不预先写还没做的功能。

- [ ] **Step 1:** 写文档。
- [ ] **Step 2: 跑** `node scripts/ci/docs-check.mjs <列出改动文件的 JSON 文件>` → 0 errors。
- [ ] **Step 3: Commit** `docs: describe progressive skill loading`

---

## Batch S5：绑定仓库的项目级 Skill（D-4）

可以单独顺延到 v0.2.0 之后。

### Task S5.1：信任开关（hub）

**Files:**
- Create: `apps/hub/src/db/migrations/0NN_repo_trust_skills.sql`（`alter table workspace_repos add column trust_skills boolean not null default false`）
- Modify: `apps/hub/src/repos.ts`（读出 `trustSkills`；`setRepoTrustSkills(db, workspaceId, repoId, value)`）
- Modify: `apps/hub/src/uiApi.ts`（`PATCH` 现有仓库更新接口接受 `trustSkills`；Room API 不加任何改它的路径）
- Modify: `apps/hub/src/daemonSocket.ts`（`task.assign` 带 `projectSkills`，只列 `trust_skills = true` 的仓库）
- Test: `apps/hub/test/repos.test.ts`、`apps/hub/test/uiApi.test.ts`、`apps/hub/test/daemonSocket.test.ts`

- [ ] **Step 1: 写失败测试**：默认 `false`；UI API 能改；Room API 改不了；解绑后记录随行删除；有信任仓库时 `projectSkills` 只含它们，没有时不带这个字段。
- [ ] **Step 2: 跑** `npx vitest run apps/hub/test/repos.test.ts apps/hub/test/uiApi.test.ts apps/hub/test/daemonSocket.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(hub): per-repo trust switch for project skills`

### Task S5.2：按提交扫描（daemon）

**Files:**
- Create: `apps/cli/src/skills/repoSkills.ts`
- Modify: `apps/cli/src/skills/snapshot.ts`（接收 `repoSkills`，处理重名前缀）
- Modify: `apps/cli/src/skills/readSkill.ts`、`apps/cli/src/skills/claudeSkills.ts`（仓库 Skill 用 git 读）
- Test: `apps/cli/test/skills/repoSkills.test.ts`、`apps/cli/test/skills/snapshot.test.ts`

**Interfaces:**
- Consumes: `mainRef`、`readFileAtRef`（`apps/cli/src/repos/git.ts:281`、`:316`）
- Produces:
  - `scanRepoSkills(repo: { repoId: string; label: string; path: string; mainBranch: string }): Promise<{ skills: SnapshotSkill[]; warnings: string[] }>`
  - `readRepoSkillFile(skill: SnapshotSkill, path: string, maxBytes: number): Promise<Buffer>`：用 `git ls-tree -z` 找到 blob（拒绝 `120000`、`160000`），先看 `git cat-file -s` 的大小，超过 `maxBytes` 就拒绝，再用 `gitRaw(['cat-file', 'blob', sha])` 读原始字节。**不用 `readFileAtRef`**，它按 UTF-8 解码并有行数和字节截断（`git.ts:316-345`），会损坏二进制和大文件
  - `repoSlugs(repos: Array<{ repoId: string; label: string }>): Map<string, string>`：先按 `skillId` 的规则把标签转成 slug；结果是 `diagram` 时改成 `repo-diagram`；为空时用 `repo`；本任务里两个仓库的 slug 相同时，两个都加 `-<repoId 前 6 位>`。所以仓库 Skill 的对外 id 和副本目录在本任务里一定唯一

取提交前先刷新：每个仓库调 `fetchMain`（`git.ts:290`），同一仓库 5 分钟内只取一次（daemon 内存里记时间）；失败（包括没有 origin）照常用 `mainRef` 现有的引用，并写一条警告。然后 `revParse(mainRef(...))` 得到提交号，本任务内的扫描、读取、复制都用这个提交号，不再用分支名。

规则照 spec §7：主分支提交固定在本任务；只看根下 `.agents/skills/<名字>/SKILL.md` 和 `.claude/skills/<名字>/SKILL.md`；`git ls-tree` 里模式 `120000` 和 `160000` 的条目拒绝；500 个文件 / 5 MiB / 20 MiB；同仓库同名取 `.agents/skills`；用户级 Skill 用不带前缀的名字，仓库 Skill 重名时用 `<slug>:<名字>`；版本标识 `<标签>@<提交前 7 位>`；清单的 blob 直接取树对象里的。git 命令都经现有 `systemGit` 封装，不读工作区。

- [ ] **Step 1: 写失败测试**（每个测试 `git init` 一个临时仓库并提交；需要 origin 时用另一个本地裸仓库当 origin，不联网）：origin 上的新提交在下一次扫描前被取到；5 分钟内不重复取；取失败时用已有引用并有警告；图片和 2 MiB 的文件按字节原样读出；超过 5 MiB 的被拒；两个标签都转成 `web` 的仓库得到不同的 slug；两个目录各一个 Skill；工作区里未提交的 Skill 不出现；树里的链接被拒；子模块被拒；超过 500 个文件被拒；同仓库两个目录同名取 `.agents`；与用户级同名时加前缀；两个仓库同名时都加前缀；标签 `Diagram` 的前缀是 `repo-diagram:`；新提交后下一次扫描读到新版本。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/repoSkills.test.ts apps/cli/test/skills/snapshot.test.ts` → FAIL。
- [ ] **Step 3: 实现。** `SnapshotSkill.repo` 填 `task.assign.projectSkills` 里的 `path` 和算出的 `slug`；codex-direct 把 `readRepoSkillFile` 作为 `readRepoFile` 传给 `SkillReader`；Claude Code 把它传给 `prepareClaudeSkills`，副本放在 `<runDir>/repo-skills/<slug>/.claude/skills/<名字>/`，由 `addDirs` 传 `--add-dir`。`path` 只用作 git 的工作目录，读取前确认它仍是 hub 绑定时记录的那个仓库（`git rev-parse --git-common-dir` 不变）。
- [ ] **Step 4: 跑** 同一条和 `apps/cli/test/skills/claudeSkills.test.ts`、`apps/cli/test/skills/readSkill.test.ts` → PASS。
- [ ] **Step 5: Commit** `feat(cli): load project skills from trusted repos at the main commit`

### Task S5.3：设置页开关

**Files:**
- Modify: `apps/web/components/CodeAndPlugins.tsx`、`apps/web/lib/hub.ts`（`updateRepo` 接受 `trustSkills`）、`apps/web/lib/types.ts`（`Repo.trustSkills`）
- Modify: `apps/web/messages/{en,zh,ja}.json`、`docs/guide.*.md`
- Test: `apps/web/test/CodeAndPlugins.test.tsx`

每个仓库一行「信任此仓库的 Skills」开关，打开前确认（文字照 spec §7）。打开后列出这个仓库的 Skill：对外名字、描述、两种运行方式的支持情况。列表来自 S6 的 `GET /api/workspaces/:id/skills`；S6 还没合并时只显示开关和「下个任务生效」。

- [ ] **Step 1: 写失败测试**：默认关闭；点开先出确认，取消不改；确认后调 `updateRepo`；关闭不用确认。
- [ ] **Step 2: 跑** `npx vitest run apps/web/test/CodeAndPlugins.test.tsx` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS；文档跑 docs-check。
- [ ] **Step 5: Commit** `feat(web): trust switch for a repo's skills`

---

## Batch S6：`/skill-name` 手动调用（D-5）

可以单独顺延到 v0.2.0 之后；不依赖 S5。

### Task S6.1：hub 识别和派发

**Files:**
- Modify: `apps/hub/src/daemonSocket.ts`（用 `parseManualSkill` 识别本任务的用户消息；带上 `manualSkill`）
- Test: `apps/hub/test/daemonSocket.test.ts`

消息正文原样保存。编辑后重跑的任务按新正文识别。保留名不识别。

- [ ] **Step 1: 写失败测试**：`/tdd 写测试` 带 `manualSkill`；`/thread x` 不带；正文中间的 `/tdd` 不带；编辑成 `/review` 后重跑带新的。
- [ ] **Step 2: 跑** `npx vitest run apps/hub/test/daemonSocket.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(hub): pass a leading /skill-name to the daemon`

### Task S6.2：daemon 预载手动调用

**Files:**
- Modify: `apps/cli/src/skills/preload.ts`（加 `manualSection`）
- Modify: `apps/cli/src/direct/adapter.ts`、`apps/cli/src/claude/adapter.ts`
- Test: `apps/cli/test/skills/preload.test.ts`、`apps/cli/test/direct/adapter.test.ts`、`apps/cli/test/claude/adapter.test.ts`

**Interfaces:**
- Produces: `manualSection(o: { snapshot: SkillSnapshot; manual: { skillId: string; arguments: string }; readBody: (skill: SnapshotSkill) => Promise<string> }): Promise<{ text: string; skill: SnapshotSkill | null }>`

规则照 spec §9：`disable-model-invocation` 的也能调用；`$ARGUMENTS` 替换，没有就末尾加 `ARGUMENTS: <参数>`；超过 48 KB 截断并提示续读方式；找不到写「用户调用的 Skill /x 不存在或已停用」。手动调用的段落放在 thread 留存段落之前，不占 32 KB 预算；算一次激活并报告。

- [ ] **Step 1: 写失败测试**：`$ARGUMENTS` 替换；没有占位符时追加一行；`disable-model-invocation` 可调用；不存在的提示；60 KB 正文截断；同时有留存时手动的在前且留存仍有完整 32 KB；报告了一次激活。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/preload.test.ts apps/cli/test/direct/adapter.test.ts apps/cli/test/claude/adapter.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat(cli): preload a skill the user invoked with /name`

### Task S6.3：`skills.catalog` RPC 和 UI API

**Files:**
- Create: `apps/cli/src/skills/rpc.ts`（`registerSkillHandlers(rpc, nemaHome)`，在 `apps/cli/src/daemon/setup.ts:88` 附近注册）
- Modify: `apps/hub/src/uiApi.ts`（`GET /api/workspaces/:id/skills`）
- Test: `apps/cli/test/skills/rpc.test.ts`、`apps/hub/test/uiApi.test.ts`

**Interfaces:**
- Produces:
  - RPC `skills.catalog`，参数 `{ projectSkills?: Array<{ repoId; label; path; mainBranch }> }`，返回 `Array<{ id: string; name: string; description: string; invocation: SkillUsage["invocation"]; runtimes: SkillUsage["runtimes"]; repoId: string | null }>`；`user-invocable: false` 和保留名的不返回
  - UI API 返回 `{ supported: boolean; skills: [...] }`；daemon 报「未知方法」时 `supported: false`、`skills: []`

- [ ] **Step 1: 写失败测试**：RPC 过滤规则；带信任仓库时包含仓库 Skill；hub 遇到旧 daemon 返回 `supported: false`。
- [ ] **Step 2: 跑** `npx vitest run apps/cli/test/skills/rpc.test.ts apps/hub/test/uiApi.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS。
- [ ] **Step 5: Commit** `feat: list invocable skills for the composer`

### Task S6.4：输入框菜单的 Skills 组

**Files:**
- Modify: `apps/web/lib/slash.ts`（加 Skill 行类型和过滤）、`apps/web/components/Composer.tsx`、`apps/web/lib/hub.ts`（`listSkills(workspaceId)`）
- Modify: `apps/web/messages/{en,zh,ja}.json`、`docs/guide.*.md`
- Test: `apps/web/test/Composer.test.tsx`、`apps/web/test/slash.test.ts`（没有就新建）

**Interfaces:**
- Consumes: `isReservedSlashName`（S0.1）、`GET /api/workspaces/:id/skills`
- Produces: `SlashItem` 加可选 `skill?: { id: string; description: string }`；`matchingItems(query: string, opts: { atMessageStart: boolean; skills: SkillRow[]; threadMode: boolean }): SlashItem[]`

照 spec §9「和内置 `/` 命令共存」：Skills 组只在 `/` 位于整条消息开头时出现；选中 Skill 填 `/<id> `；内置命令行为不变；键盘沿用现有逻辑（普通 Enter 换行、Shift+Enter 发送、菜单打开时 Enter/Tab 选中、Esc 关闭）；列表 30 秒内复用；附件区和发送拦截不变。

- [ ] **Step 1: 写失败测试**：第一行输入 `/td` 出现 `tdd`；第二行行首只有内置命令；选中后正文是 `/tdd `；`/thread x` 仍开 thread；带附件和 `/tdd` 一起发送，`onSend` 收到正文和附件 id；附件上传中不能发送；`supported: false` 时只有内置命令。
- [ ] **Step 2: 跑** `npx vitest run apps/web/test/Composer.test.tsx apps/web/test/slash.test.ts` → FAIL。
- [ ] **Step 3: 实现。**
- [ ] **Step 4: 跑** → PASS；文档跑 docs-check。
- [ ] **Step 5: Commit** `feat(web): offer skills in the / menu`

---

## Batch S7：真实环境验收

不写新功能，只记录结果。

**环境：** 用一次性的环境，不用日常的 Nema：临时 `NEMA_HOME`、只为验收新建的 workspace、一个只为验收建的本地测试仓库（S5 用），Skill 也用为验收写的假 Skill。真实的模型请求会消耗用户的 Claude Code 订阅和 codex-direct 额度，**开始前要先得到用户同意**，并说明大约要发多少个任务（本批约 10 个）。结束后删除临时 `NEMA_HOME` 和测试仓库。结果写进 PR 描述和 `docs/superpowers/specs/2026-10-30-skills-progressive-loading-design.md` 末尾新加的「验收记录」一节，与自动测试分开。

- [ ] **Step 1:** 记录实测的 Claude Code 版本（`claude --version`）和 codex-direct 模型。
- [ ] **Step 2: Claude Code：** 装一个纯说明 Skill 和一个带 `references/` 的 Skill，发一个与描述相符的任务：`init` 的 `skills` 含它们；模型调用了 Skill 工具；记下 Skill 工具的输入字段名，回到 S2.3 把解析写死并更新测试；让模型读 `references/` 成功；让模型读 `claude-config/` 和用户主目录下的文件被拒；带 `` !`date` `` 的 Skill 显示占位文字；带 `.claude-plugin/` 的 Skill 没有载入插件。
- [ ] **Step 3: codex-direct：** 同样的 Skill 和任务：先调 `read_skill`，再读资源；任务中途停用，下一次读取被拒。
- [ ] **Step 4: thread 留存：** 在 thread 里激活一个 Skill，下一条消息的任务里预载了它；停用后再下一条不再预载；主聊天不预载。
- [ ] **Step 5（S5 已合并时）:** 打开一个仓库的信任开关，主分支上的 `.agents/skills` Skill 出现；未提交的不出现；重名时前缀正确。
- [ ] **Step 6（S6 已合并时）:** `/name 参数` 预载正文和参数；`disable-model-invocation` 的 Skill 能手动调用；`/thread` 仍开 thread。
- [ ] **Step 7:** 有不符合 spec 的地方，停下报告，不改 spec 去迁就结果。全部通过后更新 ROADMAP 和 #75 的验收勾选。

## Self-Review

- **Spec 覆盖：** §1 → S1.2、S1.3；§2 → S1.1、S1.5；§3 → S2.1–S2.3；§4 → S2.1、S2.3 的参数测试和 S7 Step 2；§5 → S0.3、S1.4、S4.1；§6 → S1.3 `stillReadable`、S1.5、S4.1 停用提示；§7 → S5；§8 → S3；§9 → S0.1、S6；安全总结 → Review Focus 和各任务的拒绝测试；测试策略 → 各任务 Step 1；分批 → 本计划的批次表。
- **名称一致：** `SnapshotSkill`、`SkillSnapshot`、`SkillReader`、`prepareClaudeSkills`、`preloadSection`、`manualSection`、`parseManualSkill`、`isReservedSlashName` 在定义和使用处同名。
- **待实测的一处：** Skill 工具的输入字段名，S2.3 先用通用解析，S7 Step 2 定下来。这是 spec 写明的未知项，不是遗漏。
