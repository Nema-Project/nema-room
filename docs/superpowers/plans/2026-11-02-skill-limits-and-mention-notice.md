# Skill limits and dropped-mention notice

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show skill runtime gaps, name/folder mismatch, and an unavailable count, and tell the user when an edit drops mentions.

**Architecture:** The daemon catalog adds diagnostic codes. The web maps those codes and the existing `runtimes[].missing` into two surfaces (plugin skill rows and the `/` menu) through one helper. Mention loss is computed in the editor with the shared `keepMentionsFor` rule and shown after a successful save.

**Tech Stack:** TypeScript, Vitest, React, the existing i18n `t(key, vars)` helper.

## Global Constraints

- Diagnostic payload is codes only. No paths, no file contents.
- Mention retention stays `keepMentionsFor`. Do not change the hub.
- New UI copy goes in `apps/web/messages/en.json`, `zh.json`, and `ja.json`.
- `README.md` and `README.en.md` stay identical.
- A merely disabled extension is not "unavailable".

---

### Task 1: Catalog diagnostics

**Files:**
- Modify: `apps/cli/src/skills/rpc.ts`
- Test: `apps/cli/test/skills/rpc.test.ts`

- [x] A name/folder mismatch row returns `diagnostics: ["name-folder-mismatch"]`. A matching row returns `[]`. The codes do not contain `SKILL.md` or the home path.

### Task 2: Plugin page and `/` menu

**Files:**
- Create: `apps/web/lib/skillLimits.ts`
- Modify: `apps/web/lib/slash.ts`, `apps/web/lib/skillMenu.ts`, `apps/web/lib/hub.ts`, `apps/web/components/PluginsPage.tsx`, `apps/web/components/Composer.tsx`, `apps/web/app/globals.css`
- Test: `apps/web/test/PluginsPage.test.tsx`, `apps/web/test/Composer.test.tsx`, `apps/web/test/slash.test.ts`

- [x] Skill row with `missing: ["scripts"]` on Claude Code and `name-folder-mismatch` shows both lines and does not invent a Codex line.
- [x] Installed section shows `{count} unavailable`, filters to failed and not-ready rows, and toggles back.

### Task 3: Edit notice

**Files:**
- Modify: `apps/web/components/MessageItem.tsx`
- Test: `apps/web/test/MessageItem.test.tsx`

- [x] Deleting `[D-12]` saves and shows "Removed 1 stale mention".
- [x] An edit that keeps the mention text shows no status line.

### Task 4: Copy and guides

**Files:**
- Modify: `apps/web/messages/{en,zh,ja}.json`, `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`, `docs/guide.{en,zh,ja}.md`
- Create: `changelog.d/skill-limits-and-mention-notice.added.md`

- [x] Key sets match. Guides state the notice and the Installed count.
