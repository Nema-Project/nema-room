# Desktop startup remainder: one Windows ACL process

Issue: [#186](https://github.com/Nema-Project/nema-room/issues/186). Continues the slices already on main in [startup window](2026-11-04-desktop-startup-window-design.md) and [startup remainder](2026-11-04-desktop-startup-remainder-design.md) (PR #213, released in v0.2.4). Serves [issue #45](https://github.com/Nema-Project/nema-room/issues/45): opening the shared room has to stay perceptible. A multi-second block inside synchronous PowerShell is indistinguishable from a hang, so the evidence for "starting" is wrong even when the startup window is already on screen. This is not a new product surface.

Checked against `main` `1bb9389b66f086b0ad27879851b3a6a9cfcebda5`. PR #213's three leftovers are still open in the code and in the P1-10 row. The magnitudes in the issue were measured on installed v0.2.1 on Windows 11. They are not reused below.

## What was measured

Host: Linux x64, 4 vCPU, `/proc/cpuinfo` model name `Intel(R) Xeon(R) Processor`, Node v22.23.4. Not Windows, not macOS, not a packaged installer. Homes were directories created with `mkdtemp` under the temp directory. Nothing read or wrote a user profile.

PGlite is `@electric-sql/pglite` 0.5.12. `migrate()` is the hub function and the 18 SQL files under `apps/hub/src/db/migrations` (13512 bytes). Each sample below is a new process, so WASM compile is included the way a desktop launch pays it.

| Sample | ready ms | migrate ms | total ms |
| --- | ---: | ---: | ---: |
| Cold empty dir, run 1 | 1571 | 102 | 1673 |
| Cold empty dir, run 2 | 1500 | 105 | 1605 |
| Cold empty dir, run 3 | 1457 | 99 | 1556 |
| Cold median | 1500 | 102 | 1605 |
| Warm existing dir, run 1 | 210 | 61 | 272 |
| Warm existing dir, run 2 | 203 | 61 | 264 |
| Warm existing dir, run 3 | 202 | 61 | 263 |
| Warm median | 203 | 61 | 264 |
| `loadDataDir` of a migrated dump, one run | 552 | 6 | 559 |

The dump was 4773482 bytes. `gzip -c` of that file was 4570575 bytes. Against the cold median, that one load was 1046 ms shorter (1605 − 559). An in-process `relaxedDurability: true` cold open in a process that had already compiled WASM was 1203 ms total, next to other in-process colds around 1211 ms. It is not a fresh-process sample and it is not a candidate.

A second probe started the real `ensureLocalRuntime` / `startLocalRuntime` path with `ELECTRON_RUN_AS_NODE=1`, the test `fake-web.mjs`, and the test `fake-cli.mjs`. Those stand-ins answer HTTP immediately and do not start Next, so every phase except the database is only a shape check. One cold and one warm:

| | Cold | Warm |
| --- | ---: | ---: |
| Parent wall until `ensureLocalRuntime` returns | 2982 ms | 1215 ms |
| Core `uptimeMs` at `begin` (tsx, not a packaged load) | 873 | 751 |
| Core `db` phase (cumulative from `begin`) | 1926 | 301 |
| Core `published` | 2042 | 424 |

`db` minus `private-files` was 1913 ms cold and 291 ms warm, in line with the fresh-process PGlite totals. Module-load `uptimeMs` is tsx compiling this checkout. It is not a packaged number.

### Windows ACL calls that still happen

`windowsAcl` is still one `spawnSync(powershell.exe)` per protect or check (`apps/cli/src/secrets/permissions.ts`). POSIX `chmod` does not spawn. The probe counted calls that take the Windows branch. Shutdown calls are listed separately and are not part of time-to-ready.

Until `ensureLocalRuntime` returned:

| Process | Cold | Warm |
| --- | --- | --- |
| Parent (`ensureLocalRuntime`) | protect home; on ready, protect home again and check `instance.json` | same 3 calls |
| Core | protect home, `data`, new `daemon-token`, `db`, `instance.json` temp | protect home, `data`, `db`, `instance.json` temp; check existing `daemon-token` |
| Total | 8 | 8 |

The parent calls are the ones that block the Electron main thread. The 75 ms poll no longer checks. In this single run the ready message was already set when `instance.json` appeared, so the "file appeared" discover did not add a check. That branch is still in `ensureLocalRuntime` and can add one more parent check if the file is observed first.

Shutdown, not part of the 8: the parent protects home and checks `instance.json` and the receipt; the core checks `instance.json` and protects the receipt temp. The same helper covers those calls because they go through `windowsAcl`. No separate shutdown design.

Issue #186's "~300 ms per PowerShell" and "8 calls, ~2.7 s" were one Windows 11 machine on v0.2.1. This host cannot start `powershell.exe`. Those milliseconds are not a current saving. What is current: a launch still starts **8** PowerShell processes before ready (3 in the main process, 5 in the core), or 9 in the main process's worst poll order (4 parent + 5 core). A helper that starts once per process removes 6 of those 8 process starts (7 of 9). The per-start cost has to be measured on a Windows runner.

### Packaged bench

`npm run desktop:bench` still requires `--app <packaged executable>`. This host has no Windows or macOS installer. That bench was not run. v0.2.4's acceptance note already records the same gap. A source-level sample on the existing Windows and macOS platform jobs can time `createLocalDb` and, on Windows, PowerShell process start versus the helper. It does not time a packaged Electron launch, `requireSystemGit` on a user's machine, or first paint.

## Approaches for the ACL process

1. **One PowerShell for the life of the process, every check still runs.** Recommended. `windowsAcl` stays synchronous. The first Windows call starts one hidden `powershell.exe` and one worker thread. Later calls send one path and one action and wait for that reply. The script keeps today's rules: current user, SYSTEM, Administrators; refuse a reparse point, a foreign owner, a missing owner read, and any other Allow. No result is remembered. A file widened between two calls fails the second call.
2. **One `spawnSync` per wave of paths that already exist.** Fewer starts, but create-then-protect (`daemon-token`, the descriptor temp, the receipt temp) still needs a new wave. The main thread still pays a process start several times.
3. **Cache a path after the first success.** Rejected. The issue requires the private-file meaning to stay. A cache would accept a file whose DACL changed after the first check.

`spawnSync` cannot host the long-lived process: it waits until the child exits. The main thread also cannot block on the pipe, because that blocks the event loop that would read the pipe. The worker thread owns the pipe. The main thread waits on a `SharedArrayBuffer` with a 45 s timeout, the same ceiling as today's `spawnSync`.

## D-1: pre-built PGlite data directory

Cold time on this Linux host is PGlite init (median ready 1500 ms), not the SQL (median migrate 102 ms). Warm migrate is 61 ms. Deferring or merging migration files does not remove the cold open. `relaxedDurability` did not move the in-process number.

| | What | Gain on the measured host | Cost |
| --- | --- | --- | --- |
| A | Ship a `dumpDataDir` blob, `loadDataDir` only when the db directory is empty, then `migrate()` | One fresh-process load was 559 ms versus cold median 1605 ms (~1.0 s) | 4773482 byte blob, 4570575 bytes after gzip. New payload bytes. Recovery if the load stops halfway: delete the partial directory and open empty. Template must be built from this PGlite version and these migrations. A directory that already has files is never replaced. |
| B | Do not change the database or the payload in this change. Recommended. | None beyond the ACL work | Windows and macOS cold numbers are still unknown. A format change waits until the platform sample records them. |
| C | `relaxedDurability: true` on the desktop open | Not observed | Weaker sync. Not used. |

Recommendation: **B.** The implementation does not ship a template, does not skip `migrate()`, and does not set `relaxedDurability`. The platform sample records one fresh-process cold total and one warm total for `createLocalDb` on `windows-latest` and `macos-latest`. A later change can pick A only with those numbers and a recovery note. D-1 does not block the ACL helper or the sample.

## In this change

1. On Windows, `protectPrivatePath`, `assertPrivateAcl`, and the check inside `openPrivateFile` share one PowerShell process per Node process. The script is still .NET calls only: no cmdlets, because a filtered core environment made cmdlet autoload take ~22 s. The path is base64 on stdin. The reply is one line, `ok` or `err` plus a fixed reason. Reasons that are not in the fixed set become `rejected`, so an unexpected .NET message cannot copy a path into the Error. The Node error stays `cannot verify private Windows ACL`, plus the basename, as today.
2. The first call pays for starting the worker and PowerShell. A timeout or a dead helper rejects that call and the next call starts a new helper. The helper is `unref`'d so it does not keep the process alive.
3. `NEMA_DESKTOP_BENCH=1` still prints one `windows-acl` JSON line per call, with the action and the elapsed milliseconds, and no path. The first line in a process includes helper startup. The count of lines does not drop; the sum of milliseconds should, once Windows measures it.
4. The platform job runs `scripts/ci/startup-sample.mjs` after typecheck. The script creates its own temp directory, prints one JSON object, and deletes the directory. It does not take a home path and does not read `~/.nema`. The object has `platform`, `arch`, `node`, one fresh-process cold `createLocalDb` total, one fresh-process warm total, and on Windows the milliseconds for eight `powershell.exe -Command "exit 0"` starts plus eight ACL calls on temp files through the helper and the helper start count. Those eight calls are a microbench, not a packaged launch and not `ensureLocalRuntime`. macOS prints the database totals and `windowsAcl: null`.

## Out of this change

- A pre-built PGlite directory, skipped migrations, or `relaxedDurability` (D-1, choice B).
- Remembering that a path was private.
- Who may read the file. Still the current user, SYSTEM, and Administrators.
- `npm run desktop:bench` on a packaged Windows or macOS app. Not run. The platform sample is not that bench.
- ROADMAP P1-10 stays 进行中. v0.3.0 stays P2-04. The implementation edits the P1-10 sentence so it no longer says the PowerShell merge is undone, and it appends an execution row. It does not mark the item done.

## Acceptance

- On Windows, protecting two files and opening them, then widening one ACL and opening it again, uses one helper start. The widened open throws `cannot verify private Windows ACL`. The repaired file opens. The error text does not contain the file body.
- The ACL script, including the loop, matches no cmdlet name (`Verb-Noun`).
- A missing path and a junction still throw `cannot verify private Windows ACL`.
- POSIX tests do not start PowerShell. Mode `0600` behavior is unchanged.
- The platform job log contains the sample JSON for `windows-latest` and `macos-latest`. Those numbers are the Windows and macOS evidence. The Linux table above is not a substitute.
- Non-private ACL is still rejected. No test uses a fake timer in place of a Windows process start.
