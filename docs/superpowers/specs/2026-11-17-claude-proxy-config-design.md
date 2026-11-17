# Claude Code child-process proxy configuration

## Purpose and scope

Implement [issue #242](https://github.com/Nema-Project/nema-room/issues/242): in an environment whose only egress is an HTTP(S) proxy, a `claude-code` task cannot reach the Anthropic API because the daemon starts Claude Code with a scrubbed environment. Under the [product north star](https://github.com/Nema-Project/nema-room/issues/45), a daemon that cannot run its agent cannot add evidence-backed knowledge or reports to the shared room. When the failure looks like a generic run failure, the reason is also hidden from the people relying on that room. This change restores the run path behind an explicit, recorded setting and names the failure correctly. It adds no new integration, and it does not claim that a run that used a proxy proves anything about tests or acceptance.

The maintainer chose a configuration item over unconditional forwarding. This spec covers the config field, how its value reaches the launch, the environment it forwards, the user-facing ways to set it, one narrow error-presentation change, docs, and acceptance. The codex-direct adapter, the MCP room server child, desktop settings UI and `windowsRuntimeEnv` are out of scope (see Non-goals).

## Current evidence

Checked on `docs/242-proxy-config-spec` at `1f4ac78`.

- **Scrubbed child env.** `prepareClaudeLaunch` starts from `windowsRuntimeEnv(o.parentEnv)` (`apps/cli/src/claude/launch.ts:60`). On non-Windows hosts that is `{}` (`apps/cli/src/platform.ts:15-17`). On Windows it adds only `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP` and `TMP` (`platform.ts:18-21`). The launch then copies `PATH`, `LANG`, `LC_ALL` and `TERM` from the parent (`launch.ts:61-63`) and sets `TMPDIR`, `HOME`, `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` (`launch.ts:64-69`), plus the Windows profile variables (`launch.ts:71-78`). It never copies a proxy variable.
- **Single caller.** The only production call is in `ClaudeCodeAdapter.run` (`apps/cli/src/claude/adapter.ts:160-172`). It passes `parentEnv: this.opts.parentEnv ?? process.env`. The config is already loaded at the start of `run` (`adapter.ts:100-105`), so the adapter can read the new field without another file read. Tests call `prepareClaudeLaunch` directly in `apps/cli/test/claude/launch.test.ts`.
- **Config schema.** `ConfigSchema` is a zod `.strict()` object with `adapter`, `model`, `reasoningEffort`, `authMode` and `byokBaseUrl` (`apps/cli/src/config.ts:30-38`). `loadConfig` merges `DEFAULT_CONFIG` with the stored file and parses it (`config.ts:66-76`). `saveConfig` merges a patch into the loaded config, parses it, and writes atomically with mode `0600` (`config.ts:78-88`). Because the schema is strict, an older build that does not know the field will reject any `config.json` containing it.
- **Supported CLI surface already exists.** `nema config get [key]` and `nema config set <key> <value>` are registered in `apps/cli/src/index.ts:149-163` and implemented in `apps/cli/src/configCommands.ts`. Keys are a fixed list, `CONFIG_KEYS` (`configCommands.ts:6`). Enum values are checked against `ENUMS` before anything is written (`configCommands.ts:9-13, 48-52`). `configGet` prints `key=value` for each key, with `""` for an absent value (`configCommands.ts:35`). The help strings at `index.ts:153` and `index.ts:160` list keys by hand. The `get` help is already stale: it does not list `byokBaseUrl`.
- **Desktop settings API.** The desktop `configPatch` only allows the five existing keys (`apps/local/src/settings.ts:145-156`), and it writes through the same `saveConfig` (`settings.ts:280`). The settings response returns the whole loaded `config` (`settings.ts:100, 119-121`).
- **Precedent.** The `gh` helper already forwards `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lowercase forms to its child (`apps/cli/src/github/gh.ts:171-180`). That set matches the brief exactly.
- **Error detection surface.** `parseClaudeLine` maps a stream-json `result` line with `is_error: true` or an `error_*` subtype to `{ kind: "failure" }`. That value carries no text (`apps/cli/src/claude/events.ts:18, 101-105`). The adapter turns every `failure` into the fixed `RUN_FAILED` message (`adapter.ts:38, 346`). Stderr is buffered to 8 KiB and used only as an auth hint, never shown (`adapter.ts:41-43, 425-429, 438-441`). The only API-error text the adapter can see today is therefore the `result` field of that line, which the parser currently discards.
- **Docs surface.** `config set` is documented in the "Configure Claude Code" part of `docs/guide.{en,zh,ja}.md` (around lines 196-223 of each). `docs/reference.zh-CN.md` is the only technical reference and exists only in Chinese. None of the four READMEs mention `config set`.

Discrepancy with the brief: none in the code facts. One addition: the strict schema makes this field a rollback hazard. The design handles that below.

## Design

### Config field

Add one optional field to `ConfigSchema` in `apps/cli/src/config.ts`:

```ts
proxyEnv: z.enum(["off", "forward"]).optional(),
```

An absent field means `"off"`, which is exactly today's behaviour. `DEFAULT_CONFIG` is unchanged. Do not add `proxyEnv: "off"` to it, because doing so would write the key into every saved config. Any other value fails the schema, so `loadConfig` throws and `configErrorMessage` reports `proxyEnv：<zod message>`, the same as a bad `reasoningEffort` today. Config stores only the mode. It never stores proxy URLs or any other value.

Export a helper next to the schema:

```ts
export type ProxyEnvMode = "off" | "forward";
export const proxyEnvMode = (c: Pick<NemaConfig, "proxyEnv">): ProxyEnvMode => c.proxyEnv ?? "off";
```

**Compatibility and rollback.** A build without this field rejects a `config.json` that contains `proxyEnv`, because `.strict()` treats it as an unrecognized key. That would break every task on a downgraded daemon. To keep `off` safe to roll back, setting the mode to `off` through the supported surfaces removes the key rather than storing `"off"`. `configSet` turns `off` into `{ proxyEnv: undefined }`; `saveConfig` spreads it, zod's `.optional()` accepts it, and `JSON.stringify` omits it. A hand-written `"proxyEnv": "off"` is still accepted on load. The recovery step before downgrading is `nema config set proxyEnv off`, or deleting the key by hand. The guide and reference state this. No migration is needed: absent is the existing state for every current user.

### Setting it: `nema config`

Use the existing `nema config` surface. Do not add a new command.

- Add `"proxyEnv"` to `CONFIG_KEYS` and `proxyEnv: ["off", "forward"]` to `ENUMS` in `configCommands.ts`. Unknown values are refused with the existing `proxyEnv 的值必须是 off | forward（收到 "…"）` message before anything is written.
- `configSet` with `proxyEnv off` saves `{ proxyEnv: undefined }` as described above. The confirmation still prints `已设置 proxyEnv=off`.
- `configGet` prints the effective value: `proxyEnv=off` when the key is absent. Do not print an empty string, which reads like "unknown". This is a special case for this key only. `model` and `byokBaseUrl` keep printing `""`.
- Update the `get` and `set` help strings at `index.ts:153` and `index.ts:160` to include `proxyEnv (off|forward)`. Also add `byokBaseUrl` to the stale `get` help while editing that line.

The documented `config.json` field is a fallback for hand editing, not the primary surface.

Desktop settings UI is not extended. `configPatch` keeps refusing the key, and a desktop PATCH never removes it, because `saveConfig` merges onto the loaded config. The desktop settings response will include `proxyEnv` when it is set. That is harmless: the web reads only its typed fields (`apps/web/lib/modelSettings.ts:11-15`). The desktop runtime uses its own data directory, not `~/.nema`, so `nema config set` does not reach it. Desktop proxy use is listed under limits.

### Threading the mode to the launch

1. `ClaudeCodeAdapter.run` already holds `config` (`adapter.ts:100-105`). It passes `proxyEnv: proxyEnvMode(config)` into `prepareClaudeLaunch` (`adapter.ts:160-172`). The config is read once per task, so `nema config set` takes effect on the next task without restarting the daemon. That matches every other key.
2. `prepareClaudeLaunch` gains an optional option `proxyEnv?: ProxyEnvMode`. A caller that omits it, such as a test or a future caller, gets `"off"`. The launch never reads config itself, so it stays a pure function of its options.
3. `ClaudeLaunch` gains a field `proxyEnv: ProxyEnvMode` that echoes the mode it applied. `execute` already receives `launch`, including after `withSkillArgs` spreads it (`adapter.ts:186, 199`), so the error presentation can read the mode without another positional parameter.

### Forwarded environment

When the mode is `"forward"`, after the existing `PATH`/`LANG`/`LC_ALL`/`TERM` copy and before the fixed `Object.assign` (`launch.ts:61-69`), copy every entry of `o.parentEnv` that has a defined value and whose name is one of these eight:

```
HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
```

Export the set as `CLAUDE_PROXY_ENV_KEYS` from `launch.ts` so tests assert against one list. Matching is exact on POSIX. On `win32`, environment names are case-insensitive, so a name matches when its uppercase form is in the set. That follows the `gh.ts:178` precedent, and a variable stored as `Http_Proxy` there is the same variable. The original key casing is preserved. No variable outside the set is copied, including `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`, even though `gh.ts` forwards them. If a proxy needs a custom CA, the user has to configure that themselves. The guide says so, and it is a candidate follow-up, not part of this change. The fixed variables set afterwards cannot be overridden by a forwarded name, because none of the eight overlap them.

When the mode is `"off"` or absent, the code path is exactly today's code. No proxy variable reaches the child, even if the parent has one.

The MCP room server entry in `mcp.json` keeps its env (`launch.ts:53`). Claude Code starts that server as its own child and talks to the hub URL, which is normally local. Whether Claude Code passes its own env through to that server is up to Claude Code, and this change does not alter it.

### Error presentation for API-connection failures

This is feasible with a small, testable change, so it is in scope.

1. **Parser.** In `events.ts`, change the variant to `{ kind: "failure"; text: string | null }`, where `text` is `value.result` when it is a string and `null` otherwise. Add a pure export:

   ```ts
   export function isApiConnectionFailure(text: string | null): boolean
   ```

   It returns true when `text` matches `/Unable to connect to API|Connection error|\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPROTO|ENOTFOUND|EAI_AGAIN)\b/i`. It does not match HTTP status classes (401, 429, 5xx) or `error_max_turns`, so those still produce the generic message.
2. **Adapter.** At `adapter.ts:346`, a `failure` whose text passes `isApiConnectionFailure` finishes with a fixed connection message. Every other failure keeps `RUN_FAILED`. The matched text is never copied into the user-visible error. That follows the existing rule for stderr (`adapter.ts:42`): the text may contain hostnames or proxy URLs with credentials. The messages follow the adapter's existing Chinese copy:
   - mode `off`: `Claude 连不上 Anthropic API（网络或 API 连接失败），任务已中止。如果这台机器只能经代理出网，请运行 nema config set proxyEnv forward，让 Claude 子进程使用 daemon 环境里的代理变量。`
   - mode `forward`: `Claude 连不上 Anthropic API（网络或 API 连接失败），任务已中止。已转发 daemon 环境里的代理变量，请检查代理地址、NO_PROXY 与网络。`
3. **Not covered.** Stderr-only failures, a child that exits before `init`, and the `onClose` path (`adapter.ts:431-443`) keep their current messages. The connection error must arrive in the `result` line for this classification to apply. The exact line Claude Code emits under a dead proxy is pinned during the real-environment acceptance below. Unit fixtures use a `result` line with `is_error: true` and `result` text such as `API Error: Unable to connect to API (ECONNREFUSED)`. If the captured shape differs (for example, the text only arrives in an `assistant` text block or a `system` retry event), the parser change moves to that line type, and the plan's Task 3 is updated with the captured fixture. That is a fixture correction, not a redesign.

## Non-goals

- No change to the `codex-direct` adapter or the direct BYOK path. They run in the daemon process and already inherit its environment.
- No forwarding of any variable outside the eight proxy names, including CA bundle variables. No storing of proxy values.
- No change to `windowsRuntimeEnv` (`platform.ts:15-23`) or to the `gh` helper's environment.
- No change to the MCP room server's `env` in `mcp.json`.
- No desktop settings UI or `configPatch` key. No automatic detection that sets the mode.

## Security and privacy

With `forward`, the Claude Code child, and any process it starts, can read the proxy variables. Proxy URLs often embed credentials (`http://user:pass@proxy:8080`), so turning the mode on hands those credentials to the child, the same way the user's own shell already hands them to `claude`. Nothing is written to `config.json`, logs or task events. The connection error message is fixed text, and the `result` text is never echoed. A proxy also observes the child's traffic metadata, and for HTTPS through a TLS-inspecting proxy it observes the content. That is the operator's network policy, not something Nema can change. Default `off` keeps today's sandbox boundary, where the child sees only the variables listed in Current evidence. Opting in is an explicit, visible and reversible user decision. The guide and reference state these points in all three guide languages. Per AGENTS.md, the child's restricted tools are not an operating-system sandbox, and this setting does not make them one.

## Docs, changelog and roadmap

- `docs/guide.{en,zh,ja}.md`, in the "Configure Claude Code" part next to the existing `config set adapter claude-code` block: describe `config set proxyEnv forward|off`, the eight variables, the default, the credential note, the missing CA variables, the downgrade step, and that desktop does not expose it. Keep the three languages equivalent.
- `docs/reference.zh-CN.md`: one paragraph on the field, the strict-schema rollback rule, the forwarded set, and the connection-failure classification with its limits.
- `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`: add a short proxy note to the configuration/usage part — on a machine whose only egress is a proxy, `nema config set proxyEnv forward` lets Claude Code tasks reach the API. The READMEs do not mention `config set` today, but that does not exempt this change: AGENTS.md requires configuration changes to be reflected in all four READMEs and the affected guide sections, with the two English READMEs identical.
- `changelog.d/claude-proxy-env.added.md`: one English bullet.
- `ROADMAP.md`: after the code merges, note at the #131 item (line 29) that the #242 fix is merged and the Claude-family full run is still pending. Mark the S5.2 Claude gap closed and #131 ready to close only after the real-environment acceptance below is recorded on #131.

## Maintainer decisions

No blocking D-items. The config-item decision, field name and values, and forwarded set are given. Removing the key on `off`, printing an effective `off`, the Windows case rule, and the error-classification regex are compatibility or implementation details inside that decision. One non-blocking follow-up: whether CA variables (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`) should join the set later for TLS-inspecting proxies. That would need its own decision, because it widens "no other variables".

## Acceptance and limits

- **Schema** (`apps/cli/test/config.test.ts`): load and save accept `proxyEnv` absent, `"off"` and `"forward"`. They reject `"on"`, `""`, `true` and other values. Saving `{ proxyEnv: undefined }` removes the key from the file.
- **Config command** (`apps/cli/test/indexCommands.test.ts`): `config set proxyEnv forward` persists the value. `config set proxyEnv off` removes the key. A bad value is refused without writing. `config get proxyEnv` prints `off` when absent.
- **Launch env** (`apps/cli/test/claude/launch.test.ts`): with a parent env containing all eight names plus decoys (`SSL_CERT_FILE`, `FOO`, `HTTP_PROXY_EXTRA`): with `forward`, the env contains exactly the eight with their values, and no decoy. With `off`, and with the option omitted, the env contains none of the eight, and the rest of the env is identical to the `off` result. Names missing from the parent are not added. `launch.proxyEnv` echoes the mode.
- **Classification** (`apps/cli/test/claude/events.test.ts`, `apps/cli/test/claude/adapter.test.ts`): `parseClaudeLine` returns the `result` text on failure. `isApiConnectionFailure` is true for each listed code and phrase, and false for 401, 429, `error_max_turns` and `null`. The adapter, run with a fake `claude` that emits `init` and then a connection-error `result`, returns the `off` message when the config is absent and the `forward` message when it is `forward`. Neither message contains the raw `result` text. A non-connection error `result` still returns `RUN_FAILED`.
- **Suites**: `npm run typecheck`, `npm run typecheck -w apps/cli`, and the full CLI tests green. For desktop settings, `npx vitest run apps/local/test/settings.test.ts` must still pass unchanged.
- **Real environment**: in a proxy-only-egress VM, with the daemon's environment carrying `HTTPS_PROXY`/`NO_PROXY`, a real logged-in Claude account and Compose or the equivalent source deployment: with `proxyEnv` absent, a daemon-mediated `claude-code` task fails with the new `off` message. After `nema config set proxyEnv forward`, the same task completes end to end and its reply reaches the thread. Record the captured failing stream-json line (redacted) and the run on #131. This closes the #131 S5.2 Claude-family gap. It is a runtime run, not evidence that tests passed or that any requirement was accepted.
- **Limits**: unit tests do not prove real proxy behaviour. Windows and macOS hosts, TLS-inspecting proxies, SOCKS `ALL_PROXY` support inside Claude Code, and the desktop runtime are not covered by this acceptance.
