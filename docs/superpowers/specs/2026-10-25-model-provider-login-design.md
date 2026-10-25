# Model provider and login

User request: the Agent-runtime dropdown and the model-service dropdown should not be two layers. To the user, ChatGPT and Claude are both "my subscription", and the useful difference is how that provider logs in. The words "built-in" / "内置" were a symptom of the extra layer. This replaces the connection organization in `docs/superpowers/specs/2026-10-25-settings-workspace-ux.md`. Workspace creation in that document is unchanged.

## What the user sees

Model settings keep the model block above the provider block. The provider block has one dropdown, labeled **Model provider** / **模型提供方** / **モデル提供元**, with three options:

- **ChatGPT subscription** / **ChatGPT 订阅** / **ChatGPT サブスクリプション**
- **Claude subscription** / **Claude 订阅** / **Claude サブスクリプション**
- **API key** / **API 密钥** / **API キー**

There is no Agent runtime control and no "Nema built-in Agent" / "本地 Claude Code" option.

What follows the provider:

- ChatGPT subscription shows the existing sign-in dropdown: browser login, or the existing local Codex login, plus the existing compatibility explanation when Codex login is selected.
- Claude subscription shows the existing Claude Code install sentence and the Claude Code token field. It does not show a sign-in dropdown with a single option. The token field is the login.
- API key shows the existing optional service address and the API key field. The address help still says a custom service must support the Responses API.

Choosing a provider or a ChatGPT sign-in method still saves immediately, the same way the current dropdowns do. The explicit "Save settings" button remains for the service address. Authentication, cancellation, quota opt-in, and logout stay as they are. Model list, Claude aliases, and reasoning effort stay as they are.

## What is stored

No new adapter, auth mode, or credential. The four stored pairs stay:

| Choice | `adapter` | `authMode` |
| --- | --- | --- |
| ChatGPT subscription, browser login | `codex-direct` | `siwc` |
| ChatGPT subscription, local Codex login | `codex-direct` | `compat` |
| API key | `codex-direct` | `byok` |
| Claude subscription | `claude-code` | unchanged |

Switching onto ChatGPT subscription from Claude or API key selects browser login. Switching onto Claude subscription does not change the stored `authMode`. Switching onto API key selects `byok` and keeps the saved service address. These are the transitions the current controls already save.

Internal names (`siwc`, `byok`, `codex-direct`, `claude-code`) stay out of the labels.

## Non-goals

- No new provider, transport, or credential migration.
- No change to which model list, alias, reasoning control, or connection test each saved mode already shows.
- No change to extension-management copy that talks about the in-process agent. That is a capability boundary, not this dropdown.
- No GitHub token field.

## Calls made while writing this

The user asked not to wait for approval, so these are the writer's calls:

- Claude subscription has no one-item login dropdown. The install sentence and token field already say that this subscription uses local Claude Code.
- The API option is labeled "API key", not the longer "OpenAI API or custom Responses API service". The address help keeps the Responses API requirement.
- The section heading stays "Provider" / "提供方" / "プロバイダー". The dropdown label is the longer "Model provider" / "模型提供方" / "モデル提供元".
- Copy keys `model.agent`, `model.agent.nema`, and `model.agent.claude` are removed. `model.service` becomes the provider dropdown label, and `model.service.claude` is added.
