# Repository binding and settings groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Bind a repository from a modern folder picker and a preview, and tint the three model-settings groups.

**Architecture:** The Windows picker script changes inside `pickDirectory`. A new hub preview calls the existing `repo.inspect` and suggests a label. The add form renders that preview and sends it to the existing bind. Model settings only gains a group class and the sidebar tint.

**Tech Stack:** PowerShell `IFileOpenDialog`, Hono, React, vitest, the existing message catalogs.

**Spec:** `docs/superpowers/specs/2026-10-25-repo-bind-and-settings-groups-design.md`

## Global Constraints

- Do not add a Graphify binary, downloader, or repair action.
- Stored repo columns and the bind body stay `{ path, label, mainBranch? }`. Label remains required at bind and is still 1–40 code points.
- Cancel is an empty pick. A broken picker still throws `无法打开文件夹选择器`.
- macOS and Linux picker commands stay as they are.
- New message keys exist in en, ja, and zh with the spec's exact strings.
- Model groups use `--side` for the group and `--paper` for the drawer, inputs, and selects.
- Do not commit unless the user asks.

## Review Focus

- A cancelled Windows dialog must not bind and must not clear a preview already on screen.
- Picking a folder that is not a git root shows the daemon error and leaves Add disabled.
- A taken label cannot be submitted unchanged.
- Bind sends the preview root and the detected branch, not the raw dialog string and not a typed branch.
- The three model groups are separate tinted regions; the provider group does not swallow the sign-in group.

---

### Task 1: Windows folder picker

**Files:**
- Modify: `apps/cli/src/repos/pickDirectory.ts`
- Test: `apps/cli/test/repos/pickDirectory.test.ts`

**Interfaces:**
- Produces: `pickerCommand("win32")` still returns `cmd: "powershell.exe"` and args that include `-NoProfile`, `-STA`, and `-EncodedCommand`. The decoded UTF-16LE command contains `IFileOpenDialog` and `0x20` and does not contain `FolderBrowserDialog`. `pickDirectory` and `normalizePickedPath` stay as they are.

- [x] **Step 1: Write the failing test**

Decode `pickerCommand("win32").args` after `-EncodedCommand` from base64 UTF-16LE. Expect `IFileOpenDialog`, `0x20`, and no `FolderBrowserDialog`. Keep the existing cancel, normalize, darwin, and linux assertions.

- [x] **Step 2: Run test to verify it fails**

Run: `node .\node_modules\vitest\vitest.mjs run apps/cli/test/repos/pickDirectory.test.ts --reporter=dot`
Expected: FAIL because the script is still `FolderBrowserDialog`.

- [x] **Step 3: Implement the encoded IFileOpenDialog script**

Replace `WIN_SCRIPT` with a PowerShell script that defines `NemaFolderDialog`, calls `Show`, treats HRESULT `0x800704C7` as an empty string, and writes the filesystem path. Pass it as `-EncodedCommand`. Leave `normalizePickedPath` and the non-Windows commands unchanged.

- [x] **Step 4: Run test to verify it passes**

Run: `node .\node_modules\vitest\vitest.mjs run apps/cli/test/repos/pickDirectory.test.ts --reporter=dot`
Expected: PASS

### Task 2: Repository preview

**Files:**
- Modify: `apps/hub/src/repos.ts`
- Modify: `apps/hub/src/uiApi.ts` (`POST /workspaces/:id/repos/preview`)
- Test: `apps/hub/test/repos.test.ts`
- Test: `apps/hub/test/uiApi.test.ts`

**Interfaces:**
- Produces: `previewRepo(db, daemon, workspaceId, path) -> Promise<{ root, defaultBranch, hasOrigin, remoteUrl, label, labelTaken }>`. `label` is the last segment of `root`, at most 40 code points. `labelTaken` is true when that workspace already stores the label. `defaultBranch` is the inspect branch when `isBranchName` accepts it, otherwise `main`. The route is `POST /workspaces/:id/repos/preview` with `{ path }` and returns that object. Inspect and daemon failures use the same status mapping as bind.

- [x] **Step 1: Write the failing test**

In `repos.test.ts`, a preview of `/real/a` with remote `https://example.com/a.git` and branch `develop` returns `label: "a"`, `labelTaken: false`, and that branch. After a repo labeled `a` is bound, a second preview returns `labelTaken: true` and does not call `repo.index`. In `uiApi.test.ts`, `POST /api/workspaces/:id/repos/preview` returns the same shape from a stubbed `repo.inspect`.

- [x] **Step 2: Run test to verify it fails**

Run: `node .\node_modules\vitest\vitest.mjs run apps/hub/test/repos.test.ts apps/hub/test/uiApi.test.ts --reporter=dot`
Expected: FAIL because `previewRepo` or the route is missing.

- [x] **Step 3: Implement `previewRepo` and the route**

Call `repo.inspect`. Do not call `repo.index`. Reject an unknown or archived workspace the same way bind does.

- [x] **Step 4: Run test to verify it passes**

Run: `node .\node_modules\vitest\vitest.mjs run apps/hub/test/repos.test.ts apps/hub/test/uiApi.test.ts --reporter=dot`
Expected: PASS

### Task 3: Add-repository form

**Files:**
- Modify: `apps/web/lib/hub.ts`
- Modify: `apps/web/components/CodeAndPlugins.tsx`
- Modify: `apps/web/messages/en.json`, `apps/web/messages/ja.json`, `apps/web/messages/zh.json`
- Modify: `apps/web/test/CodeAndPlugins.test.tsx`
- Modify: `README.md`, `README.en.md`, `README.ja.md`, `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md` (replace the binding "尚未做" sentences with a pointer at this spec; keep the Graphify sentence)

**Interfaces:**
- Consumes: `previewRepo(workspaceId, path)` and `pickerCommand` from Task 1 only indirectly, through the existing pick endpoint.
- Produces: after a chosen path, the form shows `code.previewing`, then the root, `code.remote` plus `remoteUrl` or `code.noOrigin`, and `code.mainBranch` plus the branch. Add calls `bindRepo` with `{ path: root, label, mainBranch }`. The label box exists only when `labelTaken` is true, and Add is disabled while its value equals the taken label or is empty.

- [x] **Step 1: Write the failing test**

Replace `fill` so it mocks `previewRepo` and does not type a label unless `labelTaken` is true. The success case expects bind `{ path: "/real/app", label: "app", mainBranch: "develop" }` after a preview, and expects the remote URL on screen. The taken-label case shows `code.labelTaken`, refuses the unchanged name, and binds after the name changes. An inspect rejection shows the alert and does not call bind. A cancelled pick does not call preview.

- [x] **Step 2: Run test to verify it fails**

Run: `node .\node_modules\vitest\vitest.mjs run apps/web/test/CodeAndPlugins.test.tsx apps/web/test/i18n.test.tsx --reporter=dot`
Expected: FAIL because the form still requires a typed label.

- [x] **Step 3: Implement the form and the three message keys**

Remove the always-visible label and branch inputs from the add form. Leave them on a bound row. Update the README connect-code sentence and add a `CHANGELOG.md` `### Changed` entry: choosing a folder previews the remote and the detected branch, and the name and branch are filled from the repository.

- [x] **Step 4: Run test to verify it passes**

Run: `node .\node_modules\vitest\vitest.mjs run apps/web/test/CodeAndPlugins.test.tsx apps/web/test/i18n.test.tsx --reporter=dot`
Expected: PASS

### Task 4: Model settings groups

**Files:**
- Modify: `apps/web/components/ModelSettings.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/test/ModelSettings.test.tsx`

**Interfaces:**
- Produces: the model form, the provider form, and the sign-in section each have class `model-group`. `.model-settings .model-group` sets `background: var(--side)`, padding, and a 16px bottom margin, and clears the old `model-block` top border. Inputs and selects keep `background: var(--paper)`.

- [x] **Step 1: Write the failing test**

In the locale render test, expect three `.model-group` elements, and expect the model heading's group to precede the provider heading's group.

- [x] **Step 2: Run test to verify it fails**

Run: `node .\node_modules\vitest\vitest.mjs run apps/web/test/ModelSettings.test.tsx --reporter=dot`
Expected: FAIL because `model-group` is absent.

- [x] **Step 3: Add the class and point the tint at it**

- [x] **Step 4: Run test to verify it passes**

Run: `node .\node_modules\vitest\vitest.mjs run apps/web/test/ModelSettings.test.tsx --reporter=dot`
Expected: PASS

- [x] **Step 5: Do not commit**
