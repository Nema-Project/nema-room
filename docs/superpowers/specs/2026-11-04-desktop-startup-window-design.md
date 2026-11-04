# Desktop startup window and overlapped web start

Issue: [#186](https://github.com/Nema-Project/nema-room/issues/186). Serves [issue #45](https://github.com/Nema-Project/nema-room/issues/45): opening the shared room has to be perceptible, so a person can tell starting, stuck, and failed apart. This is not a new product surface.

[#188](https://github.com/Nema-Project/nema-room/issues/188) (startup bench) and [#134](https://github.com/Nema-Project/nema-room/issues/134) (Node dedupe) are closed. This slice uses that bench's `startup-phase` lines. It does not record new packaged before/after numbers.

## In this change

1. The main window is created and shown before `ensureLocalRuntime` resolves. `backgroundColor` matches the web theme paper: `#ffffff` when `nativeTheme.shouldUseDarkColors` is not true, `#141311` when it is. The same window loads a main-process `data:` document that says the app is starting, then the verified loopback launch URL. There is no second splash window.
2. If core startup throws and the window is still open, that document shows the error text and the thrown error is marked `startupShown`. The modal `showErrorBox` is skipped for that error. If the window cannot show the document, the existing dialog remains.
3. Managed web HTTP readiness overlaps `createLocalDb` and `startHub`. The 15s readiness budget starts after that work, not at process spawn. The daemon connects only after web is HTTP-ready, so a web timeout cannot interrupt a task the daemon already claimed. `startGateway` still waits until web is HTTP-ready, because the gateway proxies to web. `assertWebAlive` still runs before hub, daemon, gateway, and publish. Teardown still stops the web child and closes the database. The `web` startup-phase timestamp is written when HTTP becomes ready, not when the gateway starts.

## Out of this change

- Batching Windows ACL PowerShell calls. Private-file checks stay as they are.
- Cold-start PGlite migration changes.
- Renderer work: skipping `/` → `/w/<id>`, skeletons, `next/dynamic`.
- Streaming `startup-phase` into the startup document. That needs a channel from the detached core.
- Packaged Windows x64 and macOS arm64 bench numbers. `npm run desktop:bench` stays manual.

## Window behavior

The shell stays frameless, sandboxed, and preloaded, same as today's main window. macOS keeps the native traffic lights. Windows and Linux close this window from the taskbar or Alt+F4; those paths already destroy the window and leave the tray. The startup document does not get a close IPC of its own: window-control handlers still require the runtime origin, and a `data:` page has no such origin. The document text is escaped. The page is not a navigation the runtime handler allows later; `data:` stays blocked once that handler is installed.

A failed open leaves the window up and clears the "ready main window" flag. The next Open / activate retries core startup in that same window.

## Roadmap

Add P1-10 for #186, status 进行中. Do not mark it done: packaged bench numbers and the items above are still open. Do not change the version map. v0.3.0 stays P2-04. This item's target version is uncommitted.

## Acceptance for this slice

- A deferred `ensureLocalRuntime` still leaves a shown window whose `backgroundColor` is the theme paper and whose document says it is starting.
- A rejected core startup puts the error in that document and does not call `showErrorBox` from the shell catch when `startupShown` is set.
- With the test web held before listen, `startup-phase` `db` is recorded before the web process is released, and `db` milliseconds are less than `web` milliseconds.
- A web process that exits before listen still fails startup and leaves no published instance.
