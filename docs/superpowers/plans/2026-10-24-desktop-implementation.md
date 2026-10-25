# Local Desktop and Public Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Electron installers for Windows/macOS with a shared, independently launchable localhost Web runtime and tag-triggered public prereleases.

**Architecture:** Reuse React/Next UI, hub domain modules, Room validation, and CLI adapters. A bundled local supervisor owns a disk database, manages the hub/daemon and production Web child, and exposes a protected same-origin gateway to Electron or the browser. Release builds carry their runtime and core Git dependency; Docker, a database server, global Node/npm, and historical source commits are unnecessary to run the app.

**Tech Stack:** TypeScript/Node.js (existing engine floor >=22), React/Next standalone, Electron, electron-builder, candidate disk PGlite, existing knowledge Git format, GitHub Actions/Releases.

**Spec:** [Approved design](../specs/2026-10-24-desktop-packaging-design.md); [product boundaries](../specs/2026-10-24-local-desktop-first.md).

## Global Constraints

- “用户优先考虑现有代码复用程度与尽快稳定交付。”
- “初始目标：Windows x64，macOS arm64 与 x64；其余环境保留本地 Web 运行路径。”
- “桌面与浏览器模式共用同一份本机数据。每个数据目录仅一个运行核心持有写入权。”
- “浏览器模式不依赖创建 Electron 窗口”；“不依赖用户全局 Node/npm”。
- “服务只绑定 loopback”；“界面不直接取得模型凭证或任意进程/文件操作权限。”
- “不要求用户先购买证书”；“开机自启动与应用自动更新首版不实现。”
- “全部目标通过后由单一发布 job 收集完整产物、SHA256 清单及发布说明，再创建/发布 Release。”
- Source-history reset is a future possibility, not a current operation. Read version from an explicit package version; never derive it from commit counts, `git describe`, or the presence of old tags. Never reset knowledge Git history.
- Preserve migrated, uncommitted work. Do not work on the NAS, discard incoming diffs, push tags, publish a release, or rewrite source history merely to validate a workflow. Tag publication is intentional, after release checks pass.
- Sync, backup features, team access, remote accounts, and server deployment are outside this implementation.

## Review Focus

1. Two launchers racing, stale discovery or reused PIDs: exactly one verified runtime may write a data directory (Task 4).
2. Crashes after partial knowledge writes or migrations: recover data and invalidate interrupted runs without duplicate completed writes (Tasks 1, 3, 9).
3. Malicious web origins, replayed tickets, loopback impostors: no unauthorized UI, API, SSE, or credential access (Task 5).
4. Paths with spaces/non-ASCII, removed dev tools, macOS arm64 nested assets: installed runtime must find packaged assets and bundled Git (Tasks 7, 8).
5. Shallow/fresh source history, failed matrix target, reruns and prerelease ordering: correct version and complete immutable release assets (Task 10).

## File Map and Dependency Order

- `apps/hub/src/db/pglite.ts`, `src/lifecycle.ts`: reusable persistent DB and managed hub; `main.ts` remains the legacy Compose entry.
- `apps/cli/src/daemon/{setup,runner,connection}.ts`: managed execution lifecycle, explicit CLI entry, no ownership of the desktop UI.
- New `apps/local`: Node supervisor, paths, locking, protected instance discovery, gateway, configuration bridge and browser launcher. It never imports Electron.
- `apps/web`: existing UI, same-origin local mode, configuration page, standalone output. Legacy developer/Compose mode remains functional during migration.
- New `apps/desktop`: Electron window/tray, package configuration and resource staging. It consumes the local runtime's authenticated launch interface.
- `scripts/desktop/`: runtime/Git staging, packaging, installed smoke checks and release manifest validation.
- `.github/workflows/desktop-release.yml`: native build matrix plus one publish job.
- New production entry points use exported lifecycle functions, not import-time CLI execution. Add workspace package manifests, lockfile entries and TS project references in the task introducing each workspace. Use existing Vitest workspace discovery; exclude AppleDouble `._*` fixture copies.
- Order: baseline → DB → hub/daemon lifecycle → supervisor → gateway → setup UI → production payload → Electron → data import/regressions → release workflow.

## Task 0: Preserve Incoming Work and Establish an Honest Baseline

**Files:** Modify only proven defects in inherited Windows test revisions; record results in `docs/reviews/2026-10-24-desktop-baseline.md`.
**Interfaces:** Produces a local feature workspace/checkpoint containing the migrated working tree, plus baseline command results and known failures; no new product API.

- [ ] Save a binary diff, incoming status and untracked source inventory outside the tracked tree. Use the agreed local workspace method; ensure migrated uncommitted files reach it. Do not create a clean worktree from the initial commit and accidentally omit the migration.
- [ ] Restore working Node/npm tooling for this shell without machine-wide configuration changes; run `npm ci` from the current lockfile and verify workspace links point into the working local checkout, never NAS/scratch.
- [ ] Run `npm run typecheck`, `npm run typecheck -w apps/cli`, `node --test scripts/setup.test.mjs`, and `npm test -- --maxWorkers=2`; capture structured failures. The previous full run was interrupted and is not evidence of a pass. Separate legacy Codex CLI POSIX assumptions from active product failures without hiding either.
- [ ] Repair incomplete inherited fixture edits only with a demonstrated failing check and native regression coverage. Record unresolved baseline failures and their affected tasks; they are not waived release gates. Commit a clearly labeled baseline checkpoint once changes are understood, without credentials or `.env`.

## Task 1: Validate Disk PGlite Against Actual Application Semantics

**Files:** Modify `apps/hub/src/db/pglite.ts`; create `apps/hub/test/persistentDb.test.ts`; modify `apps/hub/test/tasks.test.ts` only for meaningful concurrency cases; record `docs/reviews/2026-10-24-local-storage-validation.md`.
**Interfaces:** Export `createLocalDb(dataDir: string): Promise<Db & { close(): Promise<void> }>`; retain `createTestDb()` and `Db` signatures.

- [ ] Add failing tests `reopen preserves messages/settings/migration versions`, `transaction rolls back together`, `parallel claims never share task or workspace`, and `process crash reopens committed data`. Assert one owner, unchanged completed rows, and rollback of failed migrations. Execute real existing SQL, including `FOR UPDATE ... SKIP LOCKED` and search; do not strip SQL in a test adapter.
- [ ] Run `npx vitest run apps/hub/test/persistentDb.test.ts apps/hub/test/tasks.test.ts --maxWorkers=2`; expect missing factory or demonstrated SQL failure.
- [ ] Implement the disk factory with migration and explicit close, reusing the current wrapper. If queue SQL is unsupported, implement a documented equivalent within the single-owner runtime and prove concurrent calls are serialized; preserve the legacy PostgreSQL path. If equivalence cannot be established, stop this task and revise the engine decision instead of switching silently.
- [ ] Re-run the two test files, then hub tests and typecheck. Record engine/version, supported semantics, disk path and crash evidence. Commit the factory, tests and validation record.

## Task 2: Extract a Managed Hub Without Changing Domain Behavior

**Files:** Create `apps/hub/src/lifecycle.ts`, `apps/hub/test/lifecycle.test.ts`; modify `src/main.ts`, `daemonSocket.ts`, `reports.ts`.
**Interfaces:** `startHub(opts: { db: Db; dataDir: string; nemaHome: string; daemonToken: string; port: number; webOrigin: string; uiAuth?: MiddlewareHandler }): Promise<{ url: string; close(): Promise<void> }>`; `port: 0` binds an available loopback port. Add `close(): Promise<void>` to the socket attachment and return a stop function from fallback scheduling. Hub close never closes an injected DB; its owner does that.

- [ ] Write tests `import does not listen`, `port zero advertises real bound port`, `close releases HTTP/WS/timers`, and `failed startup cleans resources`. Reuse an actual temp DB and existing daemon handshake fixture.
- [ ] Run `npx vitest run apps/hub/test/lifecycle.test.ts`; expect missing lifecycle.
- [ ] Extract current startup, recovery and late-bound daemon wiring; retain `main.ts` as a thin environment/PG wrapper. Apply the real bound port to Host guards and task URLs. Ensure shutdown stops fallback timers, WebSockets and in-flight responses before return; do not requeue work during deliberate exit.
- [ ] Run lifecycle, daemonSocket, server and roomApi tests plus typecheck; commit with all pre-existing behavior preserved.

## Task 3: Make Daemon Execution Startable and Stoppable by an Owner

**Files:** Modify `apps/cli/src/daemon/{setup,runner,connection}.ts`, `apps/cli/src/claude/adapter.ts`; create `apps/cli/test/daemonLifecycle.test.ts`; retain current CLI entry behavior.
**Interfaces:** Extend setup with `cliEntry?: string` and `execPath?: string` for MCP subprocesses. Return `close(): Promise<void>` from `startDaemon`; runner exposes `stop(): Promise<void>` that refuses new work and resolves after cancellation/termination. Add optional `AbortSignal` to adapter `run`, forwarded to direct transport/Claude child termination.

- [ ] Write tests `packaged CLI entry reaches MCP argv`, `stop cancels active run and starts no queued run`, `intentional close never reconnects`, `late completion cannot finish interrupted task`, and `watchers/GitHub children stop`.
- [ ] Run `npx vitest run apps/cli/test/daemonLifecycle.test.ts`; expect missing stop behavior.
- [ ] Implement explicit entry selection and cancellation using existing adapter timeout/tree-termination mechanisms; preserve existing callers with defaults. Complete tasks as interrupted via hub-owned shutdown before closing transport, with run-token checks preventing a late callback from writing a second result.
- [ ] Run lifecycle, runner, connection and active adapter test files plus CLI typecheck. Commit lifecycle changes and tests.

## Task 4: Build the Single-Owner Local Supervisor and Discovery

**Files:** Create `apps/local/{package.json,tsconfig.json}`, `src/{paths,instance,runtime,index}.ts`, `test/{instance,runtime}.test.ts`; update root TS references/lockfile.
**Interfaces:** `startLocalRuntime(opts: { home: string; assetsDir: string; webPort?: number }): Promise<LocalRuntime>` with `LocalRuntime { origin: string; createLaunchTicket(): string; close(): Promise<void> }`. `ensureLocalRuntime(opts): Promise<{ origin: string; launchUrl: string; reused: boolean }>` performs authenticated discovery, never returns a bare unverified port. Home default is `~/.nema/desktop`, isolated from legacy `~/.nema/data`; knowledge repos remain at `<home>/data/repos/<workspace>`.

- [ ] Write real-process tests `two starts yield one owner`, `second start uses existing process`, `stale PID never kills unrelated process`, `forged descriptor is rejected`, `startup rollback leaves database reusable`, and `forced crash invalidates running tokens on reopen`.
- [ ] Run `npx vitest run apps/local/test/instance.test.ts apps/local/test/runtime.test.ts --maxWorkers=2`; expect missing workspace/runtime.
- [ ] Implement atomic ownership with OS-verifiable locking and protected discovery metadata, not a PID-only stale-lock heuristic. Metadata is private; it contains a per-instance secret and protocol/version marker. Reuse existing secret/ACL utilities without exporting the secret to Web code. Start disk DB, hub and daemon; clean partial startup in reverse order. Publish discovery only after readiness, remove only your own descriptor on shutdown.
- [ ] Re-run these tests and Tasks 1–3 tests; commit workspace, interfaces and ownership logic. If reliable Windows/macOS locking needs a dependency, pin it and include its build/runtime implications in packaging.

## Task 5: Serve a Protected Same-Origin Gateway to Both UI Modes

**Files:** Create `apps/local/src/{gateway,session}.ts`, `test/gateway.test.ts`; modify hub lifecycle/app only at the authentication extension; modify `apps/web/lib/hub.ts` and create `apps/web/test/localHub.test.ts`.
**Interfaces:** `startGateway({ webTarget, hubTarget, session, port }): Promise<{ origin: string; close(): Promise<void> }>`; `SessionManager.issueTicket(): string` and `consumeTicket(ticket: string): string | null`. Runtime tickets expire after 60 seconds, are consumed once at `/_nema/launch`, set HttpOnly/SameSite=Strict session cookies, and redirect to `/` without ticket. Local UI API/SSE/diagrams use same-origin `/api`; legacy `NEXT_PUBLIC_HUB_URL` mode remains available.

- [ ] Add tests for success, replay, expired ticket, absent/wrong cookie, hostile Host/Origin, cookie-less SSE, private-hub bypass, and unknown gateway routes. Assert no token in redirect URL/referrer/logs and that direct hub UI access cannot bypass session checks; keep Room/report/daemon token authentication distinct.
- [ ] Run `npx vitest run apps/local/test/gateway.test.ts apps/web/test/localHub.test.ts`; expect missing gateway/local URL mode.
- [ ] Implement streaming proxy without buffering SSE; only map defined paths to fixed targets. Do not build an arbitrary proxy from caller URLs. Bind internal targets and gateway to loopback; inject a private gateway credential for internal hub UI calls. Strip client attempts to supply that header and reject direct unauthenticated UI calls. Desktop and browser use the same cookie/HTTP scheme, no desktop-only API dependency.
- [ ] Run gateway, hub security/server tests and Web URL tests; commit. Test browser origin and HTTP cookie behavior in an actual browser before packaging acceptance.

## Task 6: Add Model Setup Without Requiring a Terminal

**Files:** Create `apps/local/src/settings.ts`, `test/settings.test.ts`, `apps/web/components/ModelSettings.tsx`, `apps/web/test/ModelSettings.test.tsx`; modify local gateway and Web navigation/i18n.
**Interfaces:** Authenticated `GET /_nema/settings` returns config plus redacted login status, `PATCH /_nema/settings` accepts existing `NemaConfig` fields, `POST /_nema/auth/login` starts a tracked login job, `GET /_nema/auth/status` returns redacted state, and `POST /_nema/auth/secret` accepts `{ kind: 'byok' | 'claude' | 'github'; value: string }`. Add explicit logout/probe operations reusing existing helpers; no endpoint reads a saved secret back.

- [ ] Tests pin schema validation, four existing model modes, invalid base URLs, cancelled/failed OAuth, duplicate login, no saved-secret readback, no secret in error/logging, explicit opt-in before a quota-consuming probe. Web tests assert status and validation in all three languages and clear submitted input.
- [ ] Run `npx vitest run apps/local/test/settings.test.ts apps/web/test/ModelSettings.test.tsx`; expect missing routes/component.
- [ ] Reuse `authLogin`, `saveConfig`, existing secret writers and adapter factories through a redacted service, not arbitrary CLI invocation strings. Restrict OAuth external opening to expected HTTPS login URLs. The user may type a new secret into a password field; never retrieve a saved credential into renderer state, storage or responses. Basic SIWC/BYOK chat works without optional Claude/GitHub tools installed.
- [ ] Run these tests plus existing config/auth tests, Web lint/type checks; commit settings and translations together.

## Task 7: Stage a Self-Contained Production Web/Core Payload

**Files:** Modify `apps/web/next.config.ts`; create `scripts/desktop/{stage-runtime,fetch-tools,smoke-runtime}.mjs`, `scripts/desktop/staging.test.mjs`; add `apps/local/src/browser.ts` and launcher templates; update package scripts/lockfile.
**Interfaces:** `node scripts/desktop/stage-runtime.mjs --platform <win32|darwin|linux> --arch <x64|arm64> --out <dir>` produces `runtime-manifest.json` with `{ schemaVersion:1, version, platform, arch, node, git, coreEntry, cliEntry, webEntry, licenses }`, using relative paths only. Browser launcher uses bundled Node to call `ensureLocalRuntime`, then platform browser opener. Linux source/local-Web mode remains available, without promising a Linux desktop installer.

- [ ] Staging tests reject missing static/WASM/migration/vendor/license files and mismatched target/runtime. Installed smoke creates temp data, starts browser-mode runtime without Electron, validates chat API/knowledge Git and restart persistence with fake model provider. Run with development Node/npm/git removed from PATH and paths containing spaces, quotes and Japanese text.
- [ ] Run `node --test scripts/desktop/staging.test.mjs`; expect missing staging. Build existing Web standalone output and demonstrate that runtime routes `/`, `/w/<id>`, CSS/fonts and SSE work from copied production artifacts, not repo-relative files.
- [ ] Stage Next standalone plus static/public assets, compiled local/hub/CLI/shared/knowledge code, migrations, PGlite WASM/data, archify and superpowers vendor files. Download pinned official Node and redistributable Git payloads for each target, verify upstream SHA256 against pinned trusted manifests, include distribution licenses/source notices as required. No network fetching during app first launch. Tool selection must not silently use host Git when a bundled tool is absent.
- [ ] Run `npm run desktop:stage` and `npm run desktop:smoke-runtime`; verify outputs and no global tool reliance. Commit scripts, pinned manifests, launchers and required notices; do not commit downloaded binaries.

## Task 8: Add Electron Shell, Resource Packaging and Installers

**Files:** Create `apps/desktop/{package.json,tsconfig.json,electron-builder.yml}`, `src/{main,window,tray}.ts`, `test/{window,lifecycle}.test.ts`; create `scripts/desktop/{make,smoke-desktop}.mjs`; update root scripts/lockfile.
**Interfaces:** Electron uses the Task 7 manifest/launcher, not a second embedded business implementation. `createMainWindow(launchUrl: string): BrowserWindow`; explicit quit invokes the authenticated runtime shutdown control only for this installation/data directory. Build commands `npm run desktop:make` and `npm run desktop:smoke`.

- [ ] Test window security options, navigation restrictions, external-link validation, activation without duplicate core, window-close/background semantics, explicit quit and crash leaving browser mode usable. Start a packaged window against the staged payload and verify visible app readiness and no developer path/runtime dependencies.
- [ ] Run `npx vitest run apps/desktop/test/window.test.ts apps/desktop/test/lifecycle.test.ts`; expect missing Electron shell.
- [ ] Implement window/tray menus for opening UI, browser mode and quitting. No renderer Node integration; context isolation and sandbox enabled. Stage runtime outside ASAR where executables/assets require real filesystem paths. Keep data out of install directories; preserve it during upgrade/uninstall unless explicitly requested.
- [ ] Package Windows x64 installer/ZIP and macOS arm64/x64 DMG/ZIP. Explicitly disable identity signing/notarization absent credentials, retaining necessary platform-local technical signing. Verify no certificate is required to build. Commit shell/config/scripts after local packaging smoke; macOS native jobs verify their corresponding output, not cross-build assumptions.

## Task 8c: Fully Custom Desktop Title Bar and Window Controls

**Approved amendment:** [2026-10-25 window-chrome design](../specs/2026-10-25-custom-window-chrome-design.md). Execute after the functional Task 8b desktop baseline is reviewed. Preserve the existing subagent-driven execution method.

**Files:** Create `apps/desktop/{preload,window-controls}.cjs`, `apps/desktop/test/window-controls.test.mjs`, and `apps/web/components/DesktopTitlebar.tsx`; modify desktop lifecycle/security/package resource lists, `apps/web/app/{layout.tsx,globals.css}`, and existing English/Japanese/Chinese message files. Extend packaged desktop smoke for the new chrome. Read Next's applicable bundled instructions before Web changes.

**Interfaces:** A sandboxed preload exposes only `window.nemaWindowControls` with `minimize()`, `toggleMaximize()`, `close()`, `getState(): Promise<{maximized:boolean}>`, and `onStateChanged(callback): unsubscribe`. No raw IPC object/channel parameter, filesystem, credentials or process execution. Main-process dispatch allows only those owning-window actions, validates sender/top-level frame and current verified origin, and disposes its handlers/listeners when appropriate. Ordinary browsers have no such object and render no desktop title bar.

- [ ] Write failing desktop tests for allowed owning-window actions, rejected foreign/subframe/unknown messages, maximize-state updates and cleanup; verify closing uses the window-close/tray path rather than authenticated Quit. Run the focused Node test and capture RED.
- [ ] Implement the narrow bridge and frameless window configuration, preserving sandbox/isolation/disabled Node integration. Render a roughly 36px light title bar with the existing monochrome palette, Nema identifier and custom accessible minimize/maximize-or-restore/close buttons. Reserve drag space and maintain content height; hide the in-window native menu row while retaining tray commands. Keep platform-appropriate application-menu behavior outside the window where applicable.
- [ ] Run desktop security/lifecycle/control tests and applicable Web/root typechecks. Validate ordinary browser layout has no desktop offset or controls. Do not add unrelated toolbar features, dependencies or arbitrary renderer authority.
- [ ] Stage/package changed Web resources and desktop code, then run the real copied-app smoke with a fresh UUID data/profile. Verify custom chrome, minimize/restore, maximize/restore, dragging, resizing, close-to-tray/reopen, authenticated Quit, and unchanged fake-chat persistence. Record an actual window screenshot; do not claim native macOS acceptance from Windows.
- [ ] Send task-scoped review with the exact diff and evidence, fix findings, then commit the bounded UI change. Preserve the functional 8b artifact as the earlier baseline; identify new artifact hashes clearly.

**Review focus:** top-level IPC sender checks; action allowlist without privileged renderer APIs; no duplicate handler/subscription after window reopen; frameless control/drag/resize hit areas; browser layout and independent-core lifecycle preservation.

## Task 8d: Workspace Creation Feedback

**User-requested UX amendment:** [workspace/settings design](../specs/2026-10-25-settings-workspace-ux.md). Execute before remaining Task9 work; preserve its interrupted files.

- [ ] Add delayed-request tests to `apps/web/test/Sidebar.test.tsx`: visible pending status, disabled input/actions, Enter/click duplicate suppression, success, retained draft on error/retry, and draft cancellation.
- [ ] Implement accessible confirm/cancel icons, keyboard behavior and pending feedback in Sidebar with matching existing CSS and en/ja/zh messages. Cancel is draft-only; no false server cancellation.
- [ ] Run focused tests, targeted lint/typechecks, inspect the UI, and obtain task review. Keep provider work separate and package once after8e.

## Task 8e: Understandable Existing Connection Settings

**User-selected scope:** same design; reorganize existing connections only. No new Provider protocols.

- [ ] Test dropdown selection and round-trip mappings for all four existing modes; preserve configured model/custom ID and authentication behavior.
- [ ] Replace technical radio modes with contextual Agent/service/login dropdowns and clear explanatory copy; show only relevant controls. Put Claude Code availability in its own connection and move global GitHub credential controls into the GitHub plugin view.
- [ ] Retain secret clearing, config-before-auth consistency, job cancellation, explicit opt-in probes, and ordinary browser/legacy mode compatibility. No implicit login or provider requests.
- [ ] Run focused UI/settings tests and relevant type/lint checks; inspect en/ja/zh actual UI, pending workspace feedback and plugin credentials with fake-only fixtures. Review the bounded diff and package/smoke the combined8d/8e change into fresh outputs once.

## Task 9: Preserve Legacy Data, Hooks and Existing Product Coverage

**Files:** Create `apps/local/src/{migration,import}.ts`, `test/{migration,import}.test.ts`, `apps/hub/src/db/export.ts`; modify `apps/cli/src/{index,report/commands,report/install}.ts` for safe desktop instance discovery; add `apps/cli/test/report/desktopDiscovery.test.ts`; update three READMEs and `docs/reviews/2026-10-24-desktop-validation.md`.
**Interfaces:** Versioned logical export `{ schemaVersion:1, appVersion, tableData, knowledgeManifest }`; `importLegacySnapshot(sourceDir: string, destinationHome: string): Promise<ImportSummary>`. Export reads an explicit PG connection and quiesced knowledge copy; it never uses or ships real user data in fixtures. Import validates to a staging directory, then atomically activates only an empty, non-running target. Never automatically import credentials. CLI report commands discover a verified desktop instance only when hub args/env are not explicitly supplied.

- [ ] Tests cover messages/entry-source links/Git SHA identity/settings, partial export, traversal/symlink entries, missing referenced messages, failed import leaving both old data and destination unchanged, interrupted migration, old credentials untouched, hook spooling while app stopped, and explicit CLI overrides winning over discovery.
- [ ] Run `npx vitest run apps/local/test/import.test.ts apps/local/test/migration.test.ts apps/cli/test/report/desktopDiscovery.test.ts`; expect missing import/discovery integration.
- [ ] Implement logical copy/validation, compatible migrations, safe atomic activation and hook address discovery using existing protected descriptors/tokens. Use distributed CLI/runtime absolute paths for MCP and hooks. Preserve all previous functional coverage: knowledge history, workpackages, repos, plugin availability, report verification and confidentiality boundaries.
- [ ] Run full suite, typechecks, Web lint/build and packaged runtime smoke. Resolve active Windows failures; capability-specific tests must state what they prove and equivalent native coverage, never count skips as platform acceptance. Update actual evidence and three-language install/unsigned-open/browser-mode/upgrade docs. Commit completed import/integration/docs.

## Task 10: Build All Targets on Tags and Publish One Complete Release

**Files:** Create `.github/workflows/desktop-release.yml`, `scripts/desktop/{release-version,release-manifest}.mjs`, `scripts/desktop/release.test.mjs`; modify `.github/workflows/ci.yml`, desktop package version and README download links.
**Interfaces:** `readReleaseVersion(tag: string, packageVersion: string): { version: string; prerelease: boolean }` accepts strict SemVer `v<version>` and rejects mismatch; manifest creation checks expected targets `{win32-x64,darwin-arm64,darwin-x64}` and all installers/ZIPs/checksums before publish. App/CLI runtime versions are coordinated from explicit version fields, not source history. All release job artifact names contain version/platform/arch.

- [ ] Tests cover stable/prerelease parsing, invalid tag and mismatch, missing matrix target, checksum mismatch, duplicate names, same-tag concurrent attempts, failed workflow, and packaging from a source copy without `.git`. A previously published tag is not overwritten; a pre-existing draft from a failed attempt must be validated/reused or refused explicitly.
- [ ] Run `node --test scripts/desktop/release.test.mjs`; expect missing release helpers.
- [ ] Add native Windows x64, macOS arm64 and x64 build/smoke jobs with pinned supported dependencies/action SHAs. Ordinary push/PR only validates; version-tag push drives release. Build with `--publish never`, upload Actions artifacts, and gate a single `contents: write` publish job on every target's success. Use tag/ref-scoped concurrency, mark prereleases correctly without promoting them to stable latest, attach SHA256 + build/source metadata, then publish complete assets.
- [ ] Validate workflow syntax and exercise local scripts/dry-run artifact collection without pushing a tag or creating a real Release. Produce a release checklist for intentional first tag, native first-install checks (including unsigned OS prompts), and anonymous asset download/hash verification. Source-history reset remains a separate future action; preserve release version identity independently.
- [ ] Commit release workflow/scripts/docs. Only after authorized intentional tag push and successful remote jobs record public download URLs as live; local workflow validation alone is not a published release.

## Plan Self-Review and Handoff

- Every approved component is covered: database/lifecycle/ownership (1–4), dual UI/security/setup (5–6), production runtime and Electron/installers (7–8), existing data/tools (9), and public tag release (10).
- Each Review Focus item is pinned to named tests in its owner task. Adjacent interface types are defined above; new APIs must match these signatures or update dependent tasks before execution.
- This plan does not promise clean-install evidence obtainable only on macOS/Windows runners or real machines from this Windows session. Record pending checks honestly, and do not publish until required release gates pass.
- Existing design is approved; implementation-plan review and execution method choice precede product-code changes under the invoked writing-plans workflow.
