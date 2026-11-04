# Desktop startup remainder

Issue: [#186](https://github.com/Nema-Project/nema-room/issues/186). Continues [startup window spec](2026-11-04-desktop-startup-window-design.md). Serves [issue #45](https://github.com/Nema-Project/nema-room/issues/45): a person can tell starting, stuck, and failed apart, and the next open returns to the room they were in.

## In this change

1. The detached core sends `{ type: "startup-phase", phase }` on its launcher channel for the existing phase names. The shell updates the startup document with a fixed English sentence for that name. Any other phase name is ignored and is not written into the document.
2. Choosing a workspace stores its id in `localStorage` key `nema.workspace` and in a non-secret cookie `nema_workspace` (`Path=/`, `SameSite=Strict`, one-year `Max-Age`). The id must match `^ws_[A-Za-z0-9_-]{1,32}$`. The launch response uses that cookie as `/w/<id>`. Any other value, including a slash or a URL, stays on `/`. The room page still refuses an archived or missing id.
3. While the workspace list has not returned, the main area shows a skeleton with the existing loading string as its accessible name, not as visible body text. App settings and workspace settings, including plugins, load with `next/dynamic`.
4. `ensureLocalRuntime` does not run a private-file check on every 75ms poll. It stats `instance.json` and validates that file when it appears, and it calls `discoverInstance` after the child reports ready or a port collision. A caller that has just protected the home may pass `homeAlreadyProtected` so that same turn does not protect the directory again. Opening a descriptor still rejects a file that is not private.

## Out of this change

- Collapsing several file ACL checks into one PowerShell process. Each open still checks.
- Cold-start PGlite initialization or migration changes. That is a data-format change and needs its own compatibility plan.
- Packaged Windows x64 and macOS arm64 bench numbers.

## Acceptance

- A child `startup-phase` of `db` changes the startup document to the database sentence. `not-a-phase` does not.
- Launch with `nema_workspace=ws_savedroom` redirects to `/w/ws_savedroom`. `https://evil.test` and `ws_savedroom/admin` redirect to `/`.
- With the room list unresolved, the main area has a status skeleton and does not show the loading sentence as text.
- `discoverInstance(home, { homeAlreadyProtected: true })` does not tighten the directory mode, and a public `instance.json` is still rejected.
