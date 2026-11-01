# Desktop Node dedupe

Issue: [#134](https://github.com/Nema-Project/nema-room/issues/134). This records the decisions that issue left for the spec. It does not replace the issue's acceptance list.

Serves [issue #45](https://github.com/Nema-Project/nema-room/issues/45) by making the packaged Node's provenance explicit: one Node, Electron's, with the MIT notice kept, and with the old hook path rewritten instead of left as a silent break.

## Decision

Use option A. The packaged executable (`Nema.exe`, `Contents/MacOS/Nema`, or `Nema`) is the Node binary. Every child that must be Node sets `ELECTRON_RUN_AS_NODE=1`. Option B (`utilityProcess.fork`) is not used: the core, CLI, and report hooks run without an Electron main process.

`runAsNode` stays enabled. The previous payload already shipped a full `node` executable, so leaving the fuse on does not widen that boundary. npm installs and Docker keep using the host Node and do not set the variable.

## Launch

`runtime-manifest.json` stays schema 1 and omits `node`. `readManifest` uses `process.execPath` only when `process.versions.electron` is set or `ELECTRON_RUN_AS_NODE=1`. Otherwise it throws. A manifest that still has `node` keeps that path, so an older payload is unchanged. `desktop:make --staged` uses the same rule: a missing `node` is valid, and a present `node` must still be a file inside the payload.

`childEnvironment` copies `ELECTRON_RUN_AS_NODE=1` onto the core and the managed web process. Claude and Codex MCP configs that replace the environment also receive it, because those configs do not inherit the parent environment.

Launchers live in the payload and exec a payload-relative Electron path: `../../Nema.exe`, `../../MacOS/Nema`, or `../../Nema`. They export the variable. The staged-payload smoke has no packaged Electron beside the payload. It nests the copy in the packaged layout, puts the host Node at that relative path, and sets `ELECTRON_RUN_AS_NODE=1` so a manifest without `node` accepts `process.execPath`.

The build still downloads the pinned Node 24.22.1 archive. Staging uses it for `npm ci`. The payload copy skips `node/` and keeps `runtime/licenses/node`.

Staging asks the installed Electron binary for `process.versions.node` and refuses a major below the root `engines.node` floor (`>=22`). The staged `tools-source.json` keeps the nodejs.org pin for that build-time archive (`node.shipped: false`) and adds `runtimeNode`: Electron's version, Node's version, `runtime/licenses/node`, and `ELECTRON_RUN_AS_NODE=1`. Source-material policy points the Node notice at `runtime/licenses/node`. Publication validation requires that record. `release:verify` does not unpack a desktop installer, so the version gate stays in staging.

## Hook migration

`hookCommand` prefixes `ELECTRON_RUN_AS_NODE=1` on POSIX and `$env:ELECTRON_RUN_AS_NODE='1';` inside the Windows PowerShell encoded command when the installer is itself running as Electron's Node.

`startDaemon` calls `migrateReportHooks` only in that same case. It rewrites Nema hook commands that still point at `runtime/<target>/node` and leaves host or npm hooks, the skill file, and the report token alone. A second start with the same command changes nothing.

## Not measured here

Windows GUI-subsystem stdin (CLI prompts and hook JSON on stdin) was not run. This change does not add a second Windows console Node. If a packaged Windows run shows that stdin does not work, that result decides the fallback in issue #134 risk 3.

Packaged Windows x64 and macOS arm64 smokes, payload-size deltas, offline first launch, and a real hook invocation after upgrade were not run in this change. `payload size: node` is 0 when the `node/` directory is absent.
