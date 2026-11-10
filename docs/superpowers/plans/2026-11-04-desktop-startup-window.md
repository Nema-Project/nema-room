# Desktop startup window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the desktop window before the local core is ready, and overlap managed web HTTP startup with database, hub, and daemon startup.

**Architecture:** The existing main `BrowserWindow` is created first, with the theme `backgroundColor` and a local `data:` startup document. After `ensureLocalRuntime` returns, that same window loads the verified launch URL. In `startLocalRuntime`, `httpReady` runs while `createLocalDb`, `startHub`, and `daemonReady` run; `startGateway` still awaits web HTTP.

**Tech Stack:** Electron 45 shell in `apps/desktop` (CommonJS), local runtime in `apps/local` (TypeScript), Vitest.

## Global Constraints

- Code, comments, and commit messages in English.
- `verified` / `confirmedBy: "user"` is not touched.
- No Windows ACL weakening. No PGlite format or migration change.
- No second splash window and no live `startup-phase` channel.
- Changelog is a `changelog.d/*.changed.md` fragment, not an edit under `[Unreleased]`.
- UI copy for this shell stays English, matching the existing tray menu. Guides and READMEs update in en, zh, and ja. `README.md` and `README.en.md` stay byte-identical.
- Theme paper colors are `#ffffff` / `#111111` / `#8a8a8a` (light) and `#141311` / `#f3f1ea` / `#8f8b82` (dark), from `apps/web/app/globals.css`.
- Do not mark ROADMAP P1-10 done. Do not change the v0.3.0 / P2-04 version map.

---

### Task 1: Startup window

**Files:**
- Modify: `apps/desktop/security.cjs`
- Modify: `apps/desktop/lifecycle.cjs`
- Modify: `apps/desktop/main.cjs`
- Test: `apps/desktop/test/lifecycle.test.mjs`
- Test: `apps/desktop/test/security.test.mjs`

**Interfaces:**
- Consumes: `createSecureWindowOptions`, `ensureLocalRuntime`, `nativeTheme.shouldUseDarkColors`
- Produces: `createShellWindowOptions(platform)`, `startupPalette(nativeTheme)`, `startupDocumentUrl(palette, { title, detail })`, `startupFailureWasShown(error)`

- [x] **Step 1: Write the failing lifecycle tests**

Assert three behaviors:

- While `ensureLocalRuntime` is deferred, one window exists, `show` has been called, `options.show` is true, `options.backgroundColor` is `#ffffff`, and the decoded `data:` URL contains `Starting...`. Its `webPreferences` match `createSecureWindowOptions('http://127.0.0.1:43001', platform)`.
- With `nativeTheme: { shouldUseDarkColors: true }`, `backgroundColor` is `#141311`.
- When `ensureLocalRuntime` rejects `new Error('git <missing> & "no"')`, `install()` rejects, `startupFailureWasShown(error)` is true, `showErrorBox` was not called, the document contains `git &lt;missing&gt;`, and a later activate reuses that one window and loads `/_nema/launch`.

- [x] **Step 2: Run the lifecycle test and confirm the new assertions fail**

Run: `npx vitest run apps/desktop/test/lifecycle.test.mjs`

Expected: the new tests fail because no window exists before `ensureLocalRuntime` resolves.

- [x] **Step 3: Implement**

`createShellWindowOptions(platform)` is `createSecureWindowOptions` without the origin check. `createSecureWindowOptions` calls it after the origin check.

`startupPalette` returns the light or dark triple above. `startupDocumentUrl` returns `data:text/html;charset=utf-8,` plus `encodeURIComponent` of a document whose title and detail are HTML-escaped (`& < > " '`). Body uses `-webkit-app-region: drag` and the palette colors.

In `createMainWindow`, before `ensureCore()`:

- Reuse `mainWindow` when `openingFailed` is set; otherwise create the shell window with `backgroundColor`, `show: true`, and `initialWindowSize`.
- `show()` it and `loadURL` the starting document without awaiting (attach `.catch(() => undefined)`).
- On success, bind window controls, login item, and navigation once, then `loadURL` the launch ticket. `ready-to-show` and `did-finish-load` bench marks record only when the current URL contains `/_nema/launch?ticket=`.
- On failure, set `openingFailed`, `loadURL` the error document, set `error.startupShown = true` when that load works, and rethrow.

`reportError` and `main.cjs`'s install catch return immediately when `startupFailureWasShown(error)` is true.

- [x] **Step 4: Re-run the lifecycle and security tests**

Run: `npx vitest run apps/desktop/test/lifecycle.test.mjs apps/desktop/test/security.test.mjs`

Expected: PASS

### Task 2: Overlap web HTTP with database, hub, and daemon

**Files:**
- Modify: `apps/local/src/runtime.ts`
- Modify: `apps/local/test/fixtures/fake-web.mjs`
- Test: `apps/local/test/runtime.test.ts`

**Interfaces:**
- Consumes: `httpReady`, `createLocalDb`, `startHub`, `daemonReady`, `startGateway`, `assertWebAlive`, `teardown`
- Produces: no new export. `startup-phase` `web` is still one JSON line, written when HTTP is ready.

- [x] **Step 1: Extend the web fixture and write the failing overlap test**

`fake-web.mjs` reads two optional sibling files, only in the copied assets directory:

- `web-exit-before-listen`: `process.exit(1)` before `listen`.
- `web-wait-for-release`: poll every 20ms, up to 30s, for sibling `web-release`, then `listen`. Exit 1 if the wait expires.

Test: copy assets, write `web-wait-for-release`, capture stdout, start `startLocalRuntime`. Within 15s, parsed phases must include `db` while `web-release` does not exist and `web` is absent. Then write `web-release`, await the runtime, and assert `phases.db < phases.web`. Always write `web-release` in `finally` and close the runtime.

Second test: write `web-exit-before-listen`. `startLocalRuntime` rejects with `/Managed Web|exited unexpectedly/`, and `discoverInstance(home)` is null.

- [x] **Step 2: Run the overlap test and confirm it times out**

Run: `npx vitest run apps/local/test/runtime.test.ts -t "opens the database before the managed web"`

Expected: FAIL by timeout. Serial startup cannot record `db` before web listens.

- [x] **Step 3: Implement**

After the web child listeners are attached:

```typescript
const webReady = httpReady(`http://127.0.0.1:${webPort}/`, webChild, WEB_READY_TIMEOUT_MS)
  .then(() => { phase("web"); });
void webReady.catch(() => undefined);
```

Do not await it yet. Open the database, start hub, and wait for the daemon as today, calling `assertWebAlive()` at those same points. `await webReady` immediately before `startGateway`, then `assertWebAlive()` again.

- [x] **Step 4: Re-run the runtime tests**

Run: `npx vitest run apps/local/test/runtime.test.ts`

Expected: PASS

### Task 3: Docs

**Files:**
- Modify: `ROADMAP.md` (P1-10 row, status 进行中; execution log after the PR exists)
- Modify: `docs/guide.en.md`, `docs/guide.zh.md`, `docs/guide.ja.md`
- Modify: `README.md`, `README.en.md`, `README.zh.md`, `README.ja.md`
- Modify: `scripts/desktop/README.md`
- Create: `changelog.d/desktop-startup-window.changed.md`

- [x] **Step 1: Document the visible behavior and the roadmap item**

Guide bullet and README step 1: the window opens immediately with a startup screen; a startup failure stays in that window. Desktop build guide: the shell shows that local page, then loads only the authenticated loopback URL. Changelog fragment is one Chinese `- ` bullet and has no heading. P1-10 links #186, #188, #134, and #45, and says the packaged bench is still unrecorded.

- [x] **Step 2: Check the English READMEs match**

Run: `cmp README.md README.en.md`

Expected: no output, exit 0
