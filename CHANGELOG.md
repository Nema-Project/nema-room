# Changelog

## [Unreleased]

### Added

- The sidebar opens a plugins page with each plugin's name, local or external tag, install status, and functions. Workspace settings adds a code section to bind a repository, see whether the last fetch worked, and turn a plugin or its read-only functions on or off. External plugins note that calls leave the machine, and the section states that code the Agent reads is sent to the model provider.
- `nema doctor` reports `graphify 可用：<version>` when `graphify --version` runs, or `graphify 未安装：请运行 uv tool install graphifyy` when the binary is missing. That line is informational and never fails doctor.
- The daemon checks each bound repo's main branch every 5 minutes. The hub sends `repos.sync` (including `lastMainSha`) on welcome and when bindings change. Binding stores the indexed sha as `lastMainSha` without emitting `repo.moved`. A null `lastMainSha` is recorded once and does not emit `repo.moved` or update the index; a later sha updates the graphify index from the changed files (a rename removes the old path; a missing index is rebuilt in full) and emits `repo.moved` even when indexing fails. Each check emits `repo.fetched`. A failed fetch keeps the last sha. A repo without origin follows the local branch. The hub stores `last_main_sha` on `repo.moved`, `last_fetch_at` only on a successful `repo.fetched`, and `last_fetch_error`; settings shows a failure next to the last successful fetch time.
- The daemon executes code plugin calls (`plugin.call`: `code__search`, `code__explain`, `code__path`, `code__read`, `code__changes`). A missing graph snapshot is indexed before a graph query. A graph query value that starts with `-` is refused with `参数不能以 - 开头：<value>`. A missing or ill-typed argument is `<name> 参数无效：<field>`; an unknown name is `未知函数 <name>`. `plugins.status` reports graphify's version, or `graphify 未安装：请运行 uv tool install graphifyy`.
- Room tasks can list and call enabled workspace plugin tools (`GET /room/plugins`, `POST /room/plugins/:name`). A call is checked against the workspace, forwarded to the daemon as `plugin.call`, and recorded in `plugin_calls` once it passes the enabled-function check. Daemon offline or timeout is 503 with `daemon 未连接`, `daemon 已断开`, or `daemon 响应超时`; any other daemon error is 502.
- Workspace plugin settings: `GET /api/plugins` (registry plus daemon install status), `GET /api/workspaces/:id/plugins`, and `PATCH /api/workspaces/:id/plugins/:pluginId`. Local plugins default to enabled, including in a confidential workspace. `task.assign` sends that workspace's enabled plugin tools.

- A workspace can bind a local git repository (`GET/POST /api/workspaces/:id/repos`, `PATCH/DELETE /api/workspaces/:id/repos/:repoId`). Binding asks the daemon to inspect the path and index `origin/<main>` with graphify. The same git common dir returns 409. With no daemon, binding returns 503 `daemon 未连接`. A main branch that is not a single branch name (for example a refspec with `:`) returns 400 `主分支名称无效`. The stored origin URL has any `user:secret@` removed.
- Read-only git helpers can inspect a bound repo, fetch `origin/<main>`, and read that ref. Paths under `~/.nema`, `..` paths, and symlink blobs are refused. Snapshot export does not materialize symlink blobs.
- The web knowledge list marks an inferred basis and a source unconfirmed for more than 90 days; the detail shows basis, times, and quotes, and can confirm the entry. History labels a system author.
- An interrupted task is retried at most 3 times. The fourth interruption fails it and posts a system message.
- The hub can call a connected daemon with `rpc.request` and wait for `rpc.response` while a task is still running. No daemon, a timeout (30s), and a dropped socket reject the call with `daemon 未连接`, `daemon 响应超时`, and `daemon 已断开`.
- The shared plugin registry exposes the local `code` plugin (`graphify`) and its five read-only `code__*` functions. `task.assign` requires `pluginTools`, and the daemon protocol adds `rpc.request`, `rpc.response`, `repo.moved`, and `repo.fetched`.
- `POST /api/workspaces/:id/entries/:eid/confirm` with body `{}` confirms an entry as the user, re-indexes it, and emits `knowledge.changed`. A missing entry returns 404.
- Hub startup commits uncommitted knowledge entry files, including in archived workspaces, as `system` recover commits. Unparseable files, deletions, and non-entry paths are left untouched.
- Knowledge entries persist `basis`, `ingested_at`, `confirmed_at`, and `quotes`. Files written before those keys still load; missing values are null or an empty quote list.
- 支持 Claude Code 适配器：`npx nema config set adapter claude-code`，用 `claude setup-token` 取出 token 后由 `nema auth claude` 从 stdin 写入；不打印 token，失败不退回 Codex。
- 支持 BYOK 按量 API：设置 `authMode=byok`、`model` 和可选的 `byokBaseUrl`（默认 `https://api.openai.com/v1`），再用 `nema auth byok` 从 stdin 写入 key；它不使用订阅额度，遇到 401 也不会刷新 key。
- `authMode=compat` uses the existing Codex login file (`~/.codex/auth.json`) to call the Codex responses endpoint directly. Nema reads that file and does not refresh or rewrite it.
- Workspace names in the sidebar can be archived from a right-click menu, or permanently deleted after a red confirmation.

### Changed

- Codex direct, Claude Code, and `nema mcp` declare the task's plugin functions next to the three Room functions. Claude's `--allowedTools` and the init tool-face check use `mcp__room__<name>` for those functions. There is still one MCP server named `room`, and Claude still launches with `--tools ""`.
- The composer hint no longer announces Markdown support.
- The sidebar connection line shows only whether the nema daemon is online.
- `PUT /api/workspaces/:id/entries/:eid` ignores the client's `basis` and `confirmed`. A decision becomes `decided`; every other kind becomes `stated`; `confirmedAt` refreshes.
- `POST /room/entries` requires `basis` (`stated`, `decided`, or `inferred`). Quote text must be an exact substring of a cited source message. Rewriting an active decision's title, body, or status returns 409 unless `basis` is `stated` or `decided` and a cited message is from the user.
- The Codex CLI adapter is retired. Codex runs only in-process; `authMode=compat` reads the existing Codex login file instead of launching the `codex` command. A saved `adapter` of `codex` or `codex-cli` loads as `codex-direct` with `authMode=compat`.
- Right-click menu labels use a bold weight.
- Delete-workspace confirmation buttons use a bold weight.
- The knowledge panel divider can be dragged. The width is remembered in this browser.
- Dragging the workspace list or the knowledge panel below 160px collapses that column to a rail. Dragging or clicking the rail opens it again.
- While a column divider is dragged, the handle shows a warm gray. The resting lines stay the pale rule.
- Settings shows a small geometric mark beside its label. Each column divider has a square button that collapses and expands that column.

### Fixed

- A workspace with enough messages no longer stretches the three-column layout past the window. The message list scrolls, and the composer and sidebar footer stay on screen.
- A main-branch move is recorded only after `repo.moved` is sent. A closed socket, a failed send, or a throw leaves the previous sha so the next tick retries the index update and the message. A tick that is already running is not started again.
- A failure while checking one bound repo no longer skips the other repos in that tick. The failed repo keeps its last sha and is tried again on the next tick.
- `code__changes` with `to` omitted passes the bound main ref as a commit SHA. A bind onto a branch other than origin's HEAD no longer fails with `无效的提交 origin/<branch>`.
- A graphify process that times out, exits on a signal, or reports a null status fails the index instead of returning a sha. Binding surfaces `daemon 未连接`, `daemon 已断开`, and `daemon 响应超时` as 503 with that text, inspect failures as 400 with their Chinese text, and a missing repo as 404 `找不到仓库：…`. Inspect failures typecheck as HTTP 400. Incremental updates can read git blobs again.
- Indexing a bound repo continues when `git fetch` fails, including a repository with no origin. The snapshot is the local branch, or the remote ref already present.
- `readFileAtRef` rejects `.`, `foo/..`, and a pathspec magic string instead of returning a different blob.
- A second click on confirm while the first request is in flight does not write another confirm.
- Claude Code 的错误结果不再当成成功回复。登录失败会提示重新运行 `claude setup-token`，错误信息里不包含 stderr 或令牌。
- Deleting a workspace from the web app is no longer blocked by the hub CORS preflight.
- Clicking a reason in an entry's Why tab opens that history version and scrolls the chat to the source message for that version.
