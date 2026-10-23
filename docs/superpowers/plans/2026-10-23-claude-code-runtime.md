# Claude Code Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 本机 `adapter=claude-code` 时，daemon 拉起官方 `claude`，模型只能通过现有的 `nema mcp` 调用 Room 的三个函数。

**Architecture:** 配置多一个适配器名。token 单独放一个 0600 文件，经 `CLAUDE_CODE_OAUTH_TOKEN` 交给子进程。`prepareClaudeLaunch` 写这次运行的空目录和只含 `room` 的 MCP 配置。stream-json 的 init 事件证明工具面，证明不了就杀进程。失败不回退到 `codex-direct`。

**Tech Stack:** TypeScript、Node ≥ 22、现有 `AgentAdapter` / Vitest。不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md` 里的 Claude Code 部分。调研：`docs/reviews/2026-10-23-agent-runtime-research.md`。同份 spec 的 BYOK 由 `docs/superpowers/plans/2026-10-23-byok.md` 实现。本计划不要读 `byok-key`，也不要给 Claude 适配器加 `authMode` 分支。

## Global Constraints

- hub 不改：仍下发 `adapter: "auto"`，不接触凭证。
- 缺省配置和未写 `adapter` 的旧文件仍是 `codex-direct`。`codex` / `codex-cli` 仍迁移成 `codex-direct` + `authMode=compat`。
- token 文件是 `~/.nema/claude-code-token`（测试里是 `<nemaHome>/claude-code-token`），0600，一行。`nema auth claude` 从 stdin 读，不从参数读。拒绝符号链接。Nema 不刷新。
- 子进程环境只有 `PATH`、`LANG`、`LC_ALL`（有则传）、`TERM`（有则传）、`TMPDIR`、`HOME`、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_OAUTH_TOKEN`。
- 固定参数：`-p`、`--output-format stream-json`、`--input-format stream-json`、`--verbose`、`--strict-mcp-config`、`--mcp-config <path>`、`--setting-sources` `""`、`--allowedTools mcp__room__list_entries,mcp__room__read_entry,mcp__room__upsert_entry`、`--disallowedTools AskUserQuestion`、`--max-turns 24`。不传 `--permission-mode`、`--dangerously-skip-permissions`、`--resume`、`--append-system-prompt`、`--effort`。
- `config.model` 有值才追加 `--model`。`reasoningEffort` 不传给 Claude。
- init 的 `tools` 必须恰好是那三个名字的子集，`mcp_servers` 必须恰好是 `["room"]`。缺字段、多工具、或中途出现别的工具：杀进程并失败。60 次工具或 10 分钟同样失败。
- 不重试，不回退。`confidential` 不改变这条路径。错误文案不含 token、run token、prompt。
- 单元测试不启动真 `claude`，不读真 token。
- 实现前若本机 `claude --help` 没有 `--setting-sources` 或 `--allowedTools`，停下并报告，不要改旗标。

## Review Focus

1. init 的 `tools` 含 `Bash`：任务失败，`~/.nema/run/<taskId>` 被删，`codex-direct` 不被调用。→ Task 5。
2. 父进程环境里的 `AWS_SECRET_ACCESS_KEY` 和另一个 `NEMA_RUN_TOKEN`：不得进入子进程环境；MCP 文件里的 run token 只能是这次任务的。→ Task 3。
3. token 路径是符号链接：拒绝写入，不跟随。→ Task 2。
4. init 合法之后出现 `Bash`：失败，且该文本不能当作回复。→ Task 5。
5. 假 claude 在打印 init 之前就退出：失败文案不含 token，`codex-direct.run` 调用次数为 0。→ Task 5。

---

## File Structure

- `apps/cli/src/claude/token.ts` — 读写 token 文件。
- `apps/cli/src/claude/launch.ts` — 目录、MCP 文件、参数、环境。
- `apps/cli/src/claude/events.ts` — 一行 stream-json 的判定。
- `apps/cli/src/claude/adapter.ts` — `ClaudeCodeAdapter`。
- `apps/cli/src/config.ts`、`configCommands.ts` — 允许 `claude-code`。
- `apps/cli/src/doctor.ts`、`daemon/setup.ts`、`index.ts` — 注册、doctor、`nema auth claude`。
- 测试在 `apps/cli/test/claude/` 与现有的 config / doctor / index 测试。

### Task 1: 配置接受 `claude-code`

**Files:**
- Modify: `apps/cli/src/config.ts`
- Modify: `apps/cli/src/configCommands.ts`
- Test: `apps/cli/test/config.test.ts`、`apps/cli/test/indexCommands.test.ts`

**Interfaces:**
- Consumes: 现有 `loadConfig` / `saveConfig` / `configSet`。
- Produces: `NemaConfig["adapter"]` 为 `"codex-direct" | "claude-code"`。`ENUMS.adapter` 含这两项。

- [ ] **Step 1: 写失败测试**

在 `config.test.ts` 加：缺文件仍是 `codex-direct`；`{ "adapter": "claude-code" }` 能读回；`{ "adapter": "codex" }` 仍变成 `codex-direct` 且 `authMode=compat`。在 `indexCommands.test.ts` 加：`configSet` `adapter=claude-code` 返回 0 且文件里是 `claude-code`；`adapter=codex-cli` 仍返回 1。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --project @nema/cli test/config.test.ts test/indexCommands.test.ts`
Expected: FAIL，`claude-code` 被 schema 或 ENUMS 拒绝。

- [ ] **Step 3: 把 `claude-code` 加入 schema 和 `ENUMS.adapter`**

`config set` 的说明改为 `codex-direct | claude-code`。不要改 `migrateRetiredCli`。

- [ ] **Step 4: 再跑 Step 2 的测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/config.ts apps/cli/src/configCommands.ts apps/cli/src/index.ts apps/cli/test/config.test.ts apps/cli/test/indexCommands.test.ts
git commit -m "feat(cli): allow claude-code as an adapter name"
```

### Task 2: token 文件

**Files:**
- Create: `apps/cli/src/claude/token.ts`
- Create: `apps/cli/test/claude/token.test.ts`
- Modify: `apps/cli/src/index.ts`（`auth claude`）

**Interfaces:**
- Consumes: 无。
- Produces:
  - `claudeTokenPath(nemaHome: string): string` → `path.join(nemaHome, "claude-code-token")`
  - `saveClaudeToken(nemaHome: string, token: string): void` 原子写入，mode 0600。空字符串或含换行抛「token 必须是一行非空文本」。路径已是符号链接抛「Claude Code token 文件是符号链接，已拒绝。」
  - `readClaudeToken(nemaHome: string): string` 文件不存在抛「没有 Claude Code token。请运行 claude setup-token，再把令牌从标准输入交给 nema auth claude。」权限不是 0600 抛「Claude Code token 文件权限必须是 0600」。
  - `authClaude(o: { nemaHome: string; out: Out; stdin: NodeJS.ReadableStream }): Promise<number>` 读一行、trim、调用 `saveClaudeToken`。成功时 `out.log("已保存 Claude Code token")`，日志不含 token 原文。

- [ ] **Step 1: 写失败测试**

覆盖：往返读回同一行；mode 是 0600；空串和两行被拒绝；把目标换成指向别处的符号链接时抛「符号链接」且链接目标字节不变；`authClaude` 从 stdin 写入后，`out` 的全部输出不含 `sekret-token`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --project @nema/cli test/claude/token.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现上面四个函数，并在 `index.ts` 增加 `nema auth claude`，stdin 用 `process.stdin`**

不要把 token 放进 commander 参数。

- [ ] **Step 4: 再跑 Step 2 的测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/claude/token.ts apps/cli/test/claude/token.test.ts apps/cli/src/index.ts
git commit -m "feat(cli): store the Claude Code setup token"
```

### Task 3: 启动参数、目录和 MCP 文件

**Files:**
- Create: `apps/cli/src/claude/launch.ts`
- Create: `apps/cli/test/claude/launch.test.ts`

**Interfaces:**
- Consumes: 无（token 由调用方传入）。
- Produces:
  - `export const CLAUDE_ROOM_TOOLS = ["mcp__room__list_entries", "mcp__room__read_entry", "mcp__room__upsert_entry"] as const`
  - `prepareClaudeLaunch(o: { nemaHome: string; taskId: string; hubUrl: string; runToken: string; token: string; model?: string; cliEntry: string; execPath: string; parentEnv: NodeJS.ProcessEnv }): ClaudeLaunch`
  - `ClaudeLaunch = { args: string[]; env: NodeJS.ProcessEnv; runDir: string; mcpPath: string }`
  - `runDir` 是 `<nemaHome>/run/<taskId>`。其下 `claude-config/` 为 0700 且为空，`work/` 为空，`mcp.json` 为 0600。

- [ ] **Step 1: 核对旗标**

Run: `claude --help`
Expected: 输出含 `--setting-sources` 和 `--allowedTools`。否则停止本计划并报告，不要换旗标。

- [ ] **Step 2: 写失败测试**

`parentEnv` 含 `PATH`、`LANG`、`AWS_SECRET_ACCESS_KEY=sekret`、`NEMA_RUN_TOKEN=leak`。断言：

- `args` 含 Global Constraints 里的固定参数，且 `--allowedTools` 的值是三个工具用逗号拼成的一串。
- `args` 不含 `--permission-mode`、`--resume`、`--effort`、`--append-system-prompt`。
- 不传 `model` 时不含 `--model`；传入 `model: "sonnet"` 时含 `--model`, `sonnet`。
- `env` 有 `PATH` 和 `LANG`，没有 `AWS_SECRET_ACCESS_KEY`，没有 `NEMA_RUN_TOKEN`。`CLAUDE_CODE_OAUTH_TOKEN` 等于传入的 token。`HOME` 与 `CLAUDE_CONFIG_DIR` 都是 `claude-config` 目录。
- `mcp.json` 解析后只有 `mcpServers.room`，`command` 是 `execPath`，`args` 是 `[cliEntry, "mcp"]`，`env` 是 `{ NEMA_HUB_URL: hubUrl, NEMA_RUN_TOKEN: runToken }`，其中 run token 是任务的，不是 `leak`。

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run --project @nema/cli test/claude/launch.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 `prepareClaudeLaunch`**

从空对象组装 `env`，只复制白名单里父环境实际有的键。`TMPDIR` 用 `os.tmpdir()`。

- [ ] **Step 5: 再跑 Step 3 的测试**

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/claude/launch.ts apps/cli/test/claude/launch.test.ts
git commit -m "feat(cli): prepare an isolated Claude Code launch"
```

### Task 4: stream-json 判定

**Files:**
- Create: `apps/cli/src/claude/events.ts`
- Create: `apps/cli/test/claude/events.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_ROOM_TOOLS`。
- Produces:
  - `parseClaudeLine(line: string): { kind: "init"; tools: string[] | null; mcpServers: string[] | null } | { kind: "text"; text: string } | { kind: "tool"; name: string } | { kind: "result"; text: string } | { kind: "ignore" }`
  - `roomToolsOk(tools: string[] | null, mcpServers: string[] | null): { ok: true } | { ok: false; error: string }`
  - 失败文案以 `Claude 的工具面无法确认为只有 Room：` 开头。`tools` 或 `mcpServers` 为 `null`（字段缺失）时失败。二者都是数组时，每个 tool 名必须属于 `CLAUDE_ROOM_TOOLS`，且 `mcpServers` 深等于 `["room"]`。空的 `tools` 数组可以通过这一关。
  - init 认 `type=system` 且 `subtype=init`。缺 `tools` 或 `mcp_servers` 时对应字段为 `null`。`mcp_servers` 取每项的 `name`。tool 认 `type=assistant` 消息里的 `tool_use.name`。result 认 `type=result` 的 `result` 字符串。其余 `ignore`。一行非法 JSON 也是 `ignore`。

- [ ] **Step 1: 写失败测试**

断言：`roomToolsOk(三个名字, ["room"])` 为 `ok: true`；加上 `Bash` 为 `ok: false`；`mcpServers` 为 `["room", "other"]` 或 `[]` 为 `ok: false`；`roomToolsOk(null, ["room"])` 为 `ok: false`。一条没有 `tools` 字段的 init 行解析成 `tools: null`。一条 assistant `tool_use` 解析出名字。一条 `type=result` 解析出最终文本。垃圾行是 `ignore`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --project @nema/cli test/claude/events.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `parseClaudeLine` 和 `roomToolsOk`**

按 Interfaces 的判定实现，不要额外要求 `tools` 非空。

- [ ] **Step 4: 再跑 Step 2 的测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/claude/events.ts apps/cli/test/claude/events.test.ts
git commit -m "feat(cli): judge Claude Code stream-json events"
```

### Task 5: 适配器

**Files:**
- Create: `apps/cli/src/claude/adapter.ts`
- Create: `apps/cli/test/claude/adapter.test.ts`

**Interfaces:**
- Consumes: `readClaudeToken`、`prepareClaudeLaunch`、`parseClaudeLine`、`roomToolsOk`、`AgentAdapter`。
- Produces:
  - `class ClaudeCodeAdapter implements AgentAdapter`
  - `constructor(o: { nemaHome: string; cliEntry: string; claudeBin?: string; parentEnv?: NodeJS.ProcessEnv; execPath?: string; timeoutMs?: number })`
  - `name = "claude-code"`
  - 默认 `claudeBin` 为 `"claude"`，`timeoutMs` 为 `600_000`，`execPath` 为 `process.execPath`，`parentEnv` 为 `process.env`。工具上限恒为 60，不做成构造参数。
  - 找不到二进制：`{ ok: false, error: "找不到 claude。请先安装 Claude Code 并把它放到 PATH 上。" }`
  - 工具超过上限：`Claude 工具调用超过 60 次，任务已中止。`
  - 超时：`Claude 运行超过 10 分钟，任务已中止。` `timeoutMs` 只缩短时钟，不改变这句文案。
  - 越界工具：`Claude 调用了 Room 以外的工具 <name>，任务已中止。`
  - prompt 作为一条 stream-json user 消息写入 stdin，文本就是 `task.prompt`。
  - `finally` 删除 `runDir`。运行前后 token 文件字节不变。

- [ ] **Step 1: 写失败测试**

用一个 node 假二进制（测试把它写进临时目录并 `chmod 755`）按参数决定输出。五个用例：

1. init 含 `Bash`：`ok: false`，错误含「工具面」，`runDir` 不存在，传入的 `codex-direct` 桩的 `run` 未被调用（用 `Runner`，配置 `adapter: "claude-code"`，两个适配器都注册）。
2. init 合法，随后 tool 名 `Bash`，再来一条 `type=result` 文本 `should-not-stick`：`ok: false`，错误含「以外的工具」，回复不是 `should-not-stick`。
3. 假进程立刻退出且不打 init：`ok: false`，错误字符串不含测试 token `sekret-token`，也不含 `task.prompt`。`codex-direct.run` 次数为 0。
4. init 只有三个 Room 工具和 `room`，然后 `type=result` 为 `整理好了`：`ok: true, reply: "整理好了"`。stdin 里能找到 `task.prompt`。`confidential: true` 也同样成功。token 文件字节与运行前相同。
5. 合法 init 之后连续 61 条 Room 工具事件：错误恰为 `Claude 工具调用超过 60 次，任务已中止。` 另一个用例把 `timeoutMs` 设为 50，假进程打出合法 init 后不再退出：错误恰为 `Claude 运行超过 10 分钟，任务已中止。`

假二进制必须把收到的 argv 写到测试指定的文件，供第 4 个用例确认没有 `--permission-mode`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --project @nema/cli test/claude/adapter.test.ts`
Expected: FAIL，`ClaudeCodeAdapter` 不存在。

- [ ] **Step 3: 实现 `ClaudeCodeAdapter.run`**

`spawn` 的 `env` 只用 `prepareClaudeLaunch` 的结果，`cwd` 是 `work/`。先看 init，不合法则 `kill` 并失败。`progress` 用 text 事件，`tool_call` 用 Room 工具名。结果文本作为 `reply`。任何失败路径都不要把后续 result 文本当成成功。

- [ ] **Step 4: 再跑 Step 2 的测试**

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/claude/adapter.ts apps/cli/test/claude/adapter.test.ts
git commit -m "feat(cli): run tasks through Claude Code"
```

### Task 6: 接到 daemon、doctor 和说明

**Files:**
- Modify: `apps/cli/src/daemon/setup.ts`、`apps/cli/src/index.ts`、`apps/cli/src/doctor.ts`
- Modify: `apps/cli/test/indexCommands.test.ts`、`apps/cli/test/doctor.test.ts`、`apps/cli/test/connection.test.ts`（hello 的 adapters 若写死了列表）
- Modify: `README.md`、`CHANGELOG.md`

**Interfaces:**
- Consumes: `ClaudeCodeAdapter`、`readClaudeToken`、`claudeTokenPath`。
- Produces: `createRunner` 注册 `[codex-direct, claude-code]`，`cliEntry` 用 daemon 进程的 `process.argv[1]`。doctor 在 `adapter=claude-code` 时，缺二进制或缺 token 为 `ok: false`；其他适配器下这两项 `ok: true`，detail 含「仅 adapter=claude-code 需要」。两项 detail 都不含 token 文件内容。

- [ ] **Step 1: 写失败测试**

`createRunner(...).adapterNames` 等于 `["codex-direct", "claude-code"]`。doctor：适配器为 `claude-code`、PATH 上没有该二进制、token 文件不存在时，对应两项 `ok: false`。适配器为 `codex-direct` 时这两项 `ok: true`。token 文件内容是 `sekret-token` 时，所有 detail 都不含它。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run --project @nema/cli test/indexCommands.test.ts test/doctor.test.ts test/connection.test.ts`
Expected: FAIL，adapter 列表仍只有 `codex-direct`，或 doctor 没有新行。

- [ ] **Step 3: 注册适配器并加上 doctor 两行**

`README.md` 在「Codex 直连」后加一节「Claude Code」：`npx nema config set adapter claude-code`，token 用 `claude setup-token` 后 `nema auth claude` 从 stdin 写入，不打印 token，失败不退回 Codex。`CHANGELOG.md` 的 `[Unreleased]` / `Added` 加一条同样的话。doctor 的命令说明补上这两项检查。

- [ ] **Step 4: 再跑 Step 2 的测试，并跑 CLI 全量**

Run: `npx vitest run --project @nema/cli`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/daemon/setup.ts apps/cli/src/index.ts apps/cli/src/doctor.ts apps/cli/test/indexCommands.test.ts apps/cli/test/doctor.test.ts apps/cli/test/connection.test.ts README.md CHANGELOG.md
git commit -m "feat(cli): register the Claude Code adapter"
```
