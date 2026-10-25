# Extension Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Nema one extension record for Skills, MCP, and plugins, and make the plugins page read that record instead of a fixed install flag.

**Architecture:** The daemon owns a directory of extension records under the Nema data dir. Bundled plugins are computed, not stored as files Nema can delete. Managed installs live only in `extensions/<id>`. External items are references. The hub proxies fixed operations; the web page renders provision, install, and use as separate fields. Skill download, MCP processes, and the Graphify runtime package are later plans in this series.

**Tech Stack:** TypeScript, Node.js fs, Vitest, existing hub RPC and Next plugins page.

**Spec:** [Extension management design](../specs/2026-10-25-extension-management-design.md).

## Global Constraints

- Nema installs into its own directory. Discovered external items can be attached and detached. Detach does not delete the external files.
- Bundled items can be enabled, disabled, and repaired. They cannot be uninstalled.
- GitHub has no token form and no gh install/login status on the plugins page or workspace settings. Workspace enablement and `allowWrites` stay as they are.
- Do not edit the migration files another session is using for tasks 9a, 9b, and 10: `apps/hub/src/db/export.ts`, `apps/local/src/migration.ts`, `apps/local/test/migration.test.ts`, `apps/local/package.json`.
- Icon checks at 100%, 150%, and 200% wait until this extension work is finished.
- A missing bundled runtime is a repairable package error. The text must not tell the user to run `uv tool install`.
- Web submits named operations only. It does not receive a shell or an arbitrary path.

## Review Focus

1. A managed id that resolves outside `extensions/` through `..` or a directory junction must not be deleted. Test in Task 1.
2. Detaching an external item must leave the external file in place. Test in Task 1.
3. An `installing` record must not be shown as installed. Test in Task 1.
4. The plugins page must not append gh login or token text to GitHub. Existing `PluginsPage` test stays, and Task 3 adds the split statuses.
5. Bundled Graphify must not render a uv install command. Task 3 asserts the repair code's translated text.

## Later plans

- Skills: parse a GitHub or skills.sh source, install only the chosen skill into the managed directory, record the commit.
- MCP: save a stdio or HTTP config, start and stop it with the existing owned-helper scope, and keep credentials off the page.
- Graphify package: ship a runtime that indexes a repo with no system Python or uv. Until that plan, the record stays `missing-dependency` with `bundled-runtime-missing`.

---

### Task 1: Extension records

**Files:**
- Create: `apps/cli/src/extensions/store.ts`
- Test: `apps/cli/test/extensions/store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `ExtensionRecord`, `bundledExtensions()`, `openExtensionStore(root: string)` with `list()`, `putManaged(record)`, `removeManaged(id)`, `detach(id)`

- [x] **Step 1: Write the failing test**

Cover bundled seeds (`code`, `diagram`, `superpowers`, `grill`, `github`), refusal to remove a bundled id, refusal to delete a junction that points outside `extensions/`, detach leaving the external file, and an `installing` record staying `installing`.

- [x] **Step 2: Run the test and confirm it fails because the module is missing**

Run: `node node_modules/vitest/vitest.mjs run apps/cli/test/extensions/store.test.ts`

- [x] **Step 3: Implement the store**

Ids match `^[a-z][a-z0-9-]{0,63}$`. Records other than the bundled seeds live in `index.json`. Managed bytes live only in `extensions/<id>`. `removeManaged` realpath-checks that directory and refuses anything else. `detach` deletes only an `external` record.

- [x] **Step 4: Run the test and confirm it passes**

- [ ] **Step 5: Commit** when the user asks

### Task 2: Daemon list operation

**Files:**
- Modify: `apps/cli/src/daemon/setup.ts` only to register the new method, without changing the GitHub provider wiring if that file is still dirty from the other session. If it is dirty, add the registration in a new file the setup already imports, or wait until that diff is committed.
- Test: `apps/cli/test/extensions/store.test.ts` already covers the store. Add an RPC test only if registration is touched.

**Interfaces:**
- Consumes: `openExtensionStore`
- Produces: daemon method `extensions.list` returning `ExtensionRecord[]`

- [x] **Step 1: Register `extensions.list` against the data dir's `extensions` folder**
- [x] **Step 2: Test that the method returns the bundled seeds**

### Task 3: Page reads the three statuses

**Files:**
- Modify: `apps/hub/src/plugins.ts` to proxy `extensions.list` when the daemon is up, and to return bundled seeds when it is down
- Modify: `apps/web/components/PluginsPage.tsx`
- Modify: `apps/web/messages/{en,zh,ja}.json` and `apps/web/test/i18n.test.tsx`
- Test: `apps/web/test/PluginsPage.test.tsx`

**Interfaces:**
- Consumes: `ExtensionRecord`
- Produces: page title "扩展管理" / "Extensions" / "拡張管理", and separate lines for provision, install, and use

- [x] **Step 1: Fail the page test on the old single "Installed …detail" line**
- [x] **Step 2: Render the three statuses. Map `bundled-runtime-missing` to translated copy that does not mention uv.**
- [x] **Step 3: Keep GitHub free of connection and token text**

### Task 4: Managed install and uninstall operations

**Files:**
- Modify: `apps/cli/src/extensions/store.ts`
- Test: `apps/cli/test/extensions/store.test.ts`

**Interfaces:**
- Consumes: `openExtensionStore`
- Produces: `installManaged` and `removeManaged` as the only file operations. A failed install leaves the previous installed record. Cancelling an `installing` record returns it to `absent` without deleting unrelated directories.

This task does not download from GitHub yet. It accepts a directory the caller already staged.

- [x] **Step 1: Fail tests for a missing stage, a cancelled install, and activating a staged directory**
- [x] **Step 2: Implement `installManaged` and `cancelInstall`**
- [x] **Step 3: Run the store tests and confirm they pass**
