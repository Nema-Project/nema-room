# How Hermes and Multica attach other agent runtimes

Input to `docs/superpowers/specs/2026-10-23-agent-runtimes-design.md`. No CLIs were launched, no logins were read.

Research date: 2026-10-23.

## Sources (pinned commits)

- **Hermes:** `NousResearch/hermes-agent` @ `dc0fe3e476a06cfa9c0cb289f3604b0f80bc2734`. Below, `H:` means `https://github.com/NousResearch/hermes-agent/blob/dc0fe3e476a06cfa9c0cb289f3604b0f80bc2734/`.
- **Multica:** `multica-ai/multica`. `M6:` means commit `6be7adcb` (`server/pkg/agent/agent.go`, `hermes.go`). `M34:` means commit `34d4cd3a` (`server/pkg/agent/claude.go`). These are the blobs fetched on 2026-10-23, not a claim that both files share one commit.
- **Unmerged, not Hermes behavior:** PR `NousResearch/hermes-agent#98533` (`claude-code-cli` provider). Cited only as a proposal. It is not on the pinned commit.

Labels: **[C]** confirmed by the cited source. **[I]** inferred. **[U]** unknown.

---

## 1. They attach a runtime in two different directions

**[C] Multica is a client of many CLIs.** One Go interface runs a prompt:

```go
type Backend interface {
    Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error)
}
```

`New(agentType, cfg)` switches on a whitelist (`claude`, `codebuddy`, `codex`, `copilot`, `opencode`, `deveco`, `openclaw`, `hermes`, `pi`, `cursor`, `kimi`, `kiro`, `antigravity`, `qoder`, `traecli`, `grok`, `qwen`). The server never sees API keys; the daemon shells out to a binary on `PATH`.

- Source: `M6:server/pkg/agent/agent.go` (package comment, `Backend`, `ExecOptions`, `SupportedTypes`, `New`).

**[C] Hermes is mostly its own tool loop plus a provider plugin.** A provider is a `ProviderProfile` registered from `plugins/model-providers/<name>/`. An out-of-tree provider can supply its own client via `create_client` without editing core. The shipped example that is an external *agent process* rather than an HTTP API is `copilot-acp`.

- Source: `H:plugins/model-providers/copilot-acp/__init__.py` (module docstring and `CopilotACPProfile`).

**[C] Hermes can also *be* the runtime.** `hermes acp` / `python -m acp_adapter.entry` starts an ACP JSON-RPC server on stdio. That is how Multica drives Hermes (`hermes acp`), not how Hermes drives Claude or Cursor.

- Sources: `H:acp_adapter/entry.py` (module docstring). `M6:server/pkg/agent/hermes.go` (spawns `hermes acp`).

**[C] Hermes's opt-in Codex runtime hands the whole turn to `codex app-server`.** `api_mode` may be `codex_app_server`, and only when `model.openai_runtime == "codex_app_server"` and the provider is `openai` or `openai-codex`. Default Hermes does not do this.

- Source: `H:hermes_cli/runtime_provider.py` (`_VALID_API_MODES`, comment above it).

---

## 2. Three wire families, one result shape (Multica)

**[C] Claude Code (and CodeBuddy) use stream-json.** `buildClaudeArgs` always passes:

- `-p`
- `--output-format stream-json` and `--input-format stream-json`
- `--verbose`
- `--strict-mcp-config`
- `--permission-mode bypassPermissions`
- `--disallowedTools AskUserQuestion`

Optional: `--model`, `--effort`, `--max-turns`, `--append-system-prompt`, `--resume`. User `custom_args` cannot override the protocol flags (`claudeBlockedArgs`).

- Source: `M34:server/pkg/agent/claude.go` `buildClaudeArgs`, `claudeBlockedArgs`.

**[C] Codex uses its own JSON-RPC app-server**, not ACP. Multica spawns `codex app-server --listen stdio://`. Session resume is `thread/resume`, with a fresh thread if the saved one is gone.

- Source: `M6:server/pkg/agent/codex.go` (type comment on `codexBackend`). Docs page `apps/docs/content/docs/providers.mdx` at `a48b6f70` says the same.

**[C] Everyone else Multica cares about speaks ACP** (Hermes, Kimi, Kiro, Qoder, Grok, Trae). MCP servers are translated into the ACP `session/new` shape. Malformed `mcp_config` fails the launch; it is not dropped.

- Source: `M6:server/pkg/agent/hermes.go` (`Execute` builds `mcpServers` and returns on error). `M6:server/pkg/agent/grok.go` (reuses `hermesClient`).

**[C] The prompt is not one field for every backend.** `ExecOptions.SystemPrompt` is empty for most providers. The task brief is a file in the workdir (`CLAUDE.md`, `AGENTS.md`, …). A new backend that only reads `SystemPrompt` silently gets nothing.

- Source: `M6:server/pkg/agent/agent.go` `ExecOptions.SystemPrompt` comment. `M6:server/pkg/agent/hermes.go` logs that it ignores `SystemPrompt`.

**[I] Session resume is a product feature for Multica and a non-feature for Nema.** Nema tasks are stateless (design spec 4.5). Copying `--resume` / `thread/resume` / ACP `session/load` would keep a conversation the hub did not author.

---

## 3. Credentials stay inside the vendor process

**[C] Copilot ACP: Hermes does not hold the token.** `auth_type="external_process"`, `env_vars=()`, `base_url="acp://copilot"`, launch `copilot --acp --stdio`. Model listing opens a short signed-in ACP session because the CLI may keep the login in the OS credential store, where Hermes cannot read it. `api_key` and `base_url` arguments are ignored.

- Source: `H:plugins/model-providers/copilot-acp/__init__.py` `fetch_models` and the `register_provider` call.

**[C] The Copilot shim does not give Hermes native tool calls.** It tells the child, in the prompt, to print `<tool_call>{...}</tool_call>` text, then parses that text back into an OpenAI tool-call shape. The child still has its own tools.

- Source: `H:agent/copilot_acp_client.py` `_PROMPT_PREAMBLE`.

**[C] Multica's Claude path does not isolate the user's Claude config.** The args above do not set `CLAUDE_CONFIG_DIR`, do not pass `--setting-sources`, and do not restrict built-in tools except `AskUserQuestion`. `--permission-mode bypassPermissions` is there so the coding agent can act without a UI.

- Source: `M34:server/pkg/agent/claude.go` `buildClaudeArgs`.

**[U] Whether a current `claude` binary emits an init event whose `tools` array lists built-ins.** Not executed in this research. The design must fail closed if that proof is missing, rather than assume a flag list is complete.

**[C, unmerged only]** PR 98533 proposes the isolation Nema already sketched in design spec 6.6: own `CLAUDE_CONFIG_DIR`, `--setting-sources ""`, `--strict-mcp-config`, a long-lived `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`, and no use of the interactive keychain login (refresh-token sharing). That PR is not merged. Do not treat those flags as verified on the installed CLI until `claude --help` shows them.

---

## 4. What Nema should take, and what it must not

Taken:

- One adapter behind the existing `AgentAdapter.run`. Protocol details stay inside the adapter. Multica's `Backend` / `Session` split is not needed; Nema already has `onEvent` plus `AgentResult`.
- Fail closed on a bad MCP config. Block any user-supplied args from removing `--strict-mcp-config` or the tool allowlist. Nema does not have user `custom_args` today; do not add them.
- The vendor CLI owns the subscription login. The daemon injects a token it was explicitly given, and does not read or refresh `~/.claude` / the keychain.
- PATH detection belongs in `nema doctor`. A missing binary fails that adapter's task. No second adapter runs instead.

Not taken:

- Multica's workdir brief (`CLAUDE.md` / `AGENTS.md`), `bypassPermissions`, session resume, and the 17-runtime whitelist. Those exist so a coding agent can edit a repo. Nema's model may only call Room.
- Hermes's text `<tool_call>` bridge. Room tools go through the existing `nema mcp` stdio server (`NEMA_HUB_URL`, `NEMA_RUN_TOKEN`), which is the same shape the retired Codex CLI adapter used.
- Hermes `codex_app_server`. Design spec 6.7 retired the Codex CLI on 2026-10-23. This work does not put it back.
- A provider-plugin directory. One TypeScript adapter per runtime matches this repo. Cursor is the next runtime after Claude Code (design spec 6.2) and is out of this change.

---

## 5. BYOK is a key on Hermes's own loop, not a key on the server

**[C] Hermes API-key providers are still Hermes's tool loop.** A `ProviderProfile` carries `env_vars` and `base_url`. The registry auto-wires auth, model list, and the chat-completions transport. The Anthropic profile sends `x-api-key`, not `Authorization: Bearer`. A custom endpoint is any `base_url` plus a key.

- Sources: `H:plugins/model-providers/README.md` (the "Adding a new provider" sample). `H:plugins/model-providers/anthropic/__init__.py` (`x-api-key` in `fetch_models`). `H:plugins/model-providers/custom/__init__.py` (module docstring: any endpoint registered as `custom`).

**[C] Current Multica does not call the agent model with a server-side key.** The install doc says the server never sees API keys; the CLI the daemon spawns holds the login, including an `ANTHROPIC_API_KEY` in that CLI's own environment. `MULTICA_LLM_API_KEY` / `MULTICA_LLM_BASE_URL` exist for server-internal one-shots such as a chat title, and the comment on that config says the generic passthrough was removed.

- Sources: `multica-ai/multica` `apps/docs/content/docs/install-agent-runtime.mdx` @ `a48b6f70`. `server/internal/handler/handler.go` @ `6ced54b4` (`LLMAPIKey` comment). `server/pkg/llm/client.go` @ `47f6e970` (package comment).

**[I] The useful copy for Nema is the Hermes shape.** Nema already has an in-process Responses loop (`codex-direct`). A BYOK mode is a bearer key and a base URL on that loop. Putting the key in the hub would break design spec 6.2. Putting it in the Claude CLI would bring back the shell Nema is trying not to expose.
