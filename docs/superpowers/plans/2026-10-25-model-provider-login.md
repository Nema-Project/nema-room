# Model provider and login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Agent-runtime dropdown with one model-provider dropdown whose options are ChatGPT subscription, Claude subscription, and API key.

**Architecture:** The settings screen already maps four UI modes (`siwc`, `compat`, `byok`, `claude`) onto `codex-direct` / `claude-code` and saves on change through `applyProvider`. This change only regroups those modes under one select. Persistence, auth, and the model block stay.

**Tech Stack:** Next.js React, vitest, Testing Library, the existing `messages/{en,ja,zh}.json` catalogs.

**Spec:** `docs/superpowers/specs/2026-10-25-model-provider-login-design.md`

## Global Constraints

- Stored pairs stay `codex-direct/siwc`, `codex-direct/compat`, `codex-direct/byok`, and `claude-code` with `authMode` left unchanged.
- Labels: en "Model provider" / "ChatGPT subscription" / "Claude subscription" / "API key"; zh "模型提供方" / "ChatGPT 订阅" / "Claude 订阅" / "API 密钥"; ja "モデル提供元" / "ChatGPT サブスクリプション" / "Claude サブスクリプション" / "API キー".
- No Agent runtime control. No one-item Claude sign-in dropdown.
- ChatGPT still shows "ChatGPT sign-in" / "ChatGPT 登录方式" / "ChatGPT のログイン方法".
- Selecting ChatGPT from Claude or API key saves browser login (`siwc`). Selecting Claude saves `adapter: "claude-code"` and does not send a new `authMode` change beyond the existing `applyProvider("claude")` body, which keeps the stored `authMode`.
- English, Japanese, and Chinese catalogs keep the same keys.
- Do not add a GitHub token field. Do not change model-list or probe behavior.

## Review Focus

- A saved Claude configuration must open on "Claude subscription" and must not show ChatGPT sign-in or the API key field.
- A saved API-key configuration must open on "API key" and must not show ChatGPT sign-in.
- A saved Codex-login configuration must open on "ChatGPT subscription" with the Codex sign-in still selected.
- Switching to Claude while a probe job is running must leave Cancel available and must not start a probe.
- The provider select is disabled while an auth job is running, including after the drawer is closed and reopened.

---

### Task 1: One provider dropdown

**Files:**
- Modify: `apps/web/components/ModelSettings.tsx` (provider form, about the select block)
- Modify: `apps/web/messages/en.json`, `apps/web/messages/ja.json`, `apps/web/messages/zh.json` (`model.agent*`, `model.service*`)
- Modify: `apps/web/test/ModelSettings.test.tsx`
- Modify: `apps/web/test/WorkspaceShell.test.tsx` (the empty-workspace model-settings assertion)
- Modify: `README.md`, `README.en.md`, `README.ja.md`, `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-10-25-settings-workspace-ux.md` (supersession note only)

**Interfaces:**
- Consumes: existing `SettingMode` and `applyProvider(next: SettingMode)`
- Produces: one select, `aria-label` `model.service`, option values `chatgpt` | `claude` | `api`. Choosing `chatgpt` calls `applyProvider("siwc")`. That only fires when leaving Claude or API key, so a saved Codex login stays `compat` until the sign-in dropdown changes it. `claude` calls `applyProvider("claude")`. `api` calls `applyProvider("byok")`.

- [x] **Step 1: Write the failing test**

In `ModelSettings.test.tsx`, replace the locale case that expects "Agent runtime" and "Model service" with:

```tsx
["en", "Model provider", "ChatGPT sign-in", "Model", "ChatGPT subscription", "Claude subscription", "API key"],
["ja", "モデル提供元", "ChatGPT のログイン方法", "モデル", "ChatGPT サブスクリプション", "Claude サブスクリプション", "API キー"],
["zh", "模型提供方", "ChatGPT 登录方式", "模型", "ChatGPT 订阅", "Claude 订阅", "API 密钥"],
```

Assert those three option texts, in that order, on the provider select, and assert no option whose name matches `/built-in|組み込み|内置/`. Point every "Agent runtime" query at "Model provider" and every "Model service" query at "Model provider". The saved-config case expects provider value `claude`, `api`, or `chatgpt` (Codex login stays `chatgpt` plus sign-in value `codex`). Claude and API key assert `ChatGPT sign-in` is absent. In `WorkspaceShell.test.tsx`, expect the provider value `chatgpt` and delete the "Agent runtime" / `nema` assertion.

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/test/ModelSettings.test.tsx apps/web/test/WorkspaceShell.test.tsx`
Expected: FAIL because the label is still "Agent runtime" or the option text is still "Nema built-in Agent".

- [x] **Step 3: Implement the dropdown and copy**

Remove the Agent runtime select. Change the model-service select into the provider select above, shown for every mode. Keep ChatGPT sign-in only for `siwc` and `compat`, the Claude install sentence only for `claude`, and the service address only for `byok`. Delete `model.agent`, `model.agent.nema`, and `model.agent.claude`. Set `model.service` and `model.service.chatgpt` / `model.service.api` to the labels in Global Constraints, and add `model.service.claude`.

Update the three README bullets and add a `CHANGELOG.md` `### Changed` entry under `[Unreleased]`: model settings choose ChatGPT subscription, Claude subscription, or API key on one level; the Agent runtime control is gone; stored adapter and auth mode are unchanged. Add a supersession note to the top of `docs/superpowers/specs/2026-10-25-settings-workspace-ux.md` pointing at this spec. Leave the extension-management spec alone.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/web/test/ModelSettings.test.tsx apps/web/test/WorkspaceShell.test.tsx apps/web/test/i18n.test.tsx`
Expected: PASS

- [x] **Step 5: Commit**

Do not commit. `main` already has unrelated uncommitted work, and this task's files overlap that work. Leave the diff in the working tree.
