# Extension Page: Sections, Filter, Attach, Repair

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the page part of the extension management spec: the Installed and Discover & install sections, a type filter and a search box, Attach for external skills that were found on this machine, and Repair for bundled items.

**Architecture:** The page stays one component tree over the existing extension record. Sections, filter and search are pure view state on the list the daemon already returns. Discovery and attach are new daemon RPCs (`extensions.discover`, `extensions.attach`) behind fixed hub routes. Repair is a daemon RPC (`extensions.repair`) that re-runs a bundled item's own health check and stores only the result. The web never sends a shell command, and the only path it sends is a folder the person chose or that discovery listed. The daemon re-checks it.

**Tech Stack:** TypeScript, Node.js fs, Vitest, Testing Library, the existing hub RPC and Plugins page.

**Spec:** [Extension management design](../specs/2026-10-25-extension-management-design.md), sections 页面与核心交互, 界面安装、聊天安装与外部发现, and 内置默认项与 Graphify.

**Issue:** #75.

**North star ([#45](https://github.com/Nema-Project/nema-room/issues/45)):** This work does not add project knowledge itself. It belongs in Nema Room because the extensions on this page shape what agents in a room can do and what they report. People and agents can rely on that shared understanding only if everyone can see which skills and tools are actually in use. They also need to know where each one came from and whether it works:
- Sections and the filter make the installed set readable at a glance.
- Attach records an external skill with its real path instead of copying it silently, so its provenance stays visible.
- Repair reports a bundled item's real state from a check that was just run, not the shipped default.

None of this claims an integration that is not shipped. A failed check is shown as missing or damaged, not hidden.

## Global Constraints

- Only `extensions.*` keys are added to the three message files, and en, zh, and ja stay in sync.
- No edits to release files, the README install section, ROADMAP.md, or the evidence-return code. Those belong to other work lines.
- Attach never copies, moves, or deletes the external folder. Detach (Remove from list) already leaves it in place.
- Discovery reads only a fixed set of known skill folders plus a folder the person enters. It does not walk the disk. It reads only `SKILL.md` front matter.
- A bundled item still cannot be uninstalled. Repair re-checks the item. It never runs a package manager, and the text never tells the person to run `uv`.
- Tests use temporary directories and fakes only, with no network.

## PR 1: Sections, filter and search

### Task 1: Sections

**Files:** `apps/web/components/PluginsPage.tsx`, `apps/web/test/PluginsPage.test.tsx`, `apps/web/messages/{en,zh,ja}.json`, `apps/web/app/globals.css`

- [ ] Write failing tests:
  - The page has two headed regions, "Installed" and "Discover & install".
  - Every record whose install state is not `absent` is listed under Installed. A cancelled install that left an `absent` record is listed under Discover & install with Retry install.
  - The install panel sits under Discover & install.
- [ ] Implement the split and the headings.

### Task 2: Type filter and search

- [ ] Write failing tests:
  - The type filter (All / Skills / MCP / Plugins) is a radio group and narrows both sections by `kind`.
  - Search matches name, summary, source, and id, ignoring case. An empty result says so.
  - Filter and search never hide a row's running install progress once that row is shown again.
- [ ] Implement the filter and search as view state. No request is sent when they change.

### Task 3: Docs

- [ ] Add a paragraph to guide en/zh/ja, the extension paragraph in the four READMEs (English pair identical), and the reference. Add `changelog.d/extension-page-sections.added.md`.

## PR 2: Attach external skills, repair bundled items

### Task 4: Discovery (daemon)

**Files:** `apps/cli/src/extensions/discover.ts`, `apps/cli/src/extensions/handlers.ts`, `apps/cli/test/extensions/discover.test.ts`

- [ ] Write failing tests. `extensions.discover` lists the skill folders directly under the known locations (`~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, resolved from an injected home directory):
  - Each result gives the folder's real path, location label, front-matter name and description, derived id, and whether that path is already attached.
  - A result also gives a problem when the folder cannot be attached: missing front matter, an invalid id, an id taken by another record, or a symbolic link that points outside its location.
- [ ] Implement it without following links outside the location and without reading anything but `SKILL.md`. Cap the number of entries.

### Task 5: Attach (daemon + hub + page)

- [ ] Write failing tests. `extensions.attach({ path })`:
  - Accepts a folder from discovery or one the person typed, provided its `SKILL.md` has a name and description.
  - Writes an `external` skill record whose `externalPath` is the real path, with `installed` and `enabled` set. It copies nothing.
  - Refuses a bundled or taken id, a file, a missing folder, a relative path, and a second attach of the same path.
- [ ] Add hub `GET /api/extensions/discover` and `POST /api/extensions/attach`, with validated responses.
- [ ] Under Discover & install, show "Found on this computer" with an Attach button per item, plus an input for another folder. Once attached, the item moves to Installed and keeps Remove from list.

### Task 6: Repair bundled items

- [ ] Write failing tests. `extensions.repair({ id })`:
  - Is refused for anything that is not bundled.
  - For `code`, runs the packaged Graphify version check. Success stores `ready` and clears the error. Failure stores `missing-dependency` with `bundled-runtime-missing`.
  - For the other bundled items, confirms they are ready.
  - The list then shows the stored result instead of the hard-coded seed.
- [ ] Add a Repair button on bundled rows that are not ready, plus a "Check again" button on every bundled row. Show the result in the current language.
- [ ] Docs and a changelog fragment, as in Task 3.

## Verification

For each PR, run all of these:

- `npm run typecheck`
- `npm run typecheck -w apps/cli`
- `npm test -- --maxWorkers=2`
- `npm run lint -w apps/web`
- `npm run build -w apps/web`
- docs-check on the changed paths
- `node --test scripts/setup.test.mjs scripts/release-notes.test.mjs scripts/ci/*.test.mjs`
