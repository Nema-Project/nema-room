# Graphify on demand

User request: a built-in code plugin should not ask the user to install Graphify, and the daemon should fetch a bound repository when a task actually reads code, not on a five-minute clock. This supersedes the PATH install and the five-minute `git fetch` in `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md`. Binding a repository still indexes immediately. Settings still show the last fetch result.

## What the user does

Bind a local Git repository in workspace settings. That is the only setup step. The app does not tell the user to run `uv tool install`, and it does not look for `graphify` on `PATH`.

Graphify is the file `tools/graphify/graphify` (`graphify.exe` on Windows) under the desktop payload root. The desktop core passes that path into the daemon. A CLI daemon with no injected binary uses `NEMA_GRAPHIFY_BIN` when it is set, otherwise the same relative path under `NEMA_PAYLOAD_ROOT` or next to the Node executable. An injected test binary wins over the environment.

When that file is missing, doctor and `plugins.status` stay informational and say `随包的 Graphify 运行环境缺失`. The plugins page already shows that the packaged runtime can be repaired. There is still no repair action and no download on first launch. `desktop:stage` creates `tools/graphify/` from the pinned CPython and graphifyy lock in `docs/superpowers/specs/2026-10-25-graphify-package-design.md`. A payload built before that pin reports the missing packaged runtime.

## When fetch runs

The daemon does not start a timer. Idle bound repositories are not fetched.

These still fetch that one repository, then bring its private snapshot index up to the fetched main commit. A fetch failure is recorded and does not roll the saved sha backward. An unchanged sha does not rebuild the index.

- Binding a repository (`repo.index`), as today.
- `repo.tick`, the existing coding-agent hook, as today.
- The first `code__search`, `code__explain`, `code__path`, `code__read`, or `code__changes` call of a task.

The hub sends the room task id on that code `plugin.call`. The same task and repository do not fetch again, so later calls in the task read the tree from the first fetch. A call with no task id fetches every time. A different task fetches again. GitHub tool calls do not fetch.

`repo.fetched` and `repo.moved` still fire from that refresh, so the settings page and the main-moved diagram check update when a task reads code. They do not update while the workspace is idle. The hub's uncovered-commit fallback therefore also waits until a task has refreshed main.

## Non-goals

- No runtime download of Graphify, uv, or Python.
- No change to snapshot location, `origin/<main>`, or the five code functions' arguments.
- No periodic fetch retained as a backup.
