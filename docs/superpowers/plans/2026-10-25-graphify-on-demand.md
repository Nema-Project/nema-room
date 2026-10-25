# Graphify on demand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the five-minute repository fetch, refresh a bound repository once per task when a code tool runs, and resolve Graphify only from the packaged path.

**Architecture:** `RepoWatcher.start` no longer arms a timer. `prepare(repoId, taskId)` runs the existing per-repo tick once per task. The hub adds `taskId` to code `plugin.call`s, and the daemon calls `prepare` before those calls. `graphifyBin` uses an injected path, else `NEMA_GRAPHIFY_BIN`, else `tools/graphify/graphify` under the payload root. A missing file returns `随包的 Graphify 运行环境缺失` and does not search `PATH`.

**Tech Stack:** Node daemon, vitest, the existing git and graphify test fakes.

**Spec:** `docs/superpowers/specs/2026-10-25-graphify-on-demand-design.md`

## Global Constraints

- Missing runtime text is exactly `随包的 Graphify 运行环境缺失`.
- No `uv tool install` instruction in the runtime, doctor, READMEs, or `docs/reference.zh-CN.md`.
- `start()` must not fetch. `intervalMs` may still be passed and must be ignored for scheduling.
- The same `taskId` plus `repoId` fetches once. No task id fetches every call. A later task id fetches again.
- Binding (`repo.index`) and `repo.tick` keep their current fetch behavior.
- Do not download Graphify. Do not mark the bundled extension `ready`.

## Review Focus

- A second code call in the same task must not see a commit pushed to origin after the first call.
- A `graphify` executable placed only on `PATH` must not run when the packaged path is missing.
- An injected `graphify.bin` must still beat `NEMA_GRAPHIFY_BIN`.
- GitHub `plugin.call`s must not gain a repository fetch.
- `start()` with `intervalMs: 15` must not fetch during a short wait.

---

### Task 1: Packaged Graphify path and on-demand refresh

**Files:**
- Modify: `apps/cli/src/repos/graphify.ts`, `apps/cli/src/repos/watcher.ts`, `apps/cli/src/repos/handlers.ts`, `apps/cli/src/daemon/setup.ts`
- Modify: `apps/hub/src/roomApi.ts`
- Modify: `apps/local/src/runtime.ts`
- Modify: tests listed in the spec's callers: `apps/cli/test/repos/graphify.test.ts`, `watcher.test.ts`, `handlers.test.ts`, `apps/cli/test/doctor.test.ts`, `apps/hub/test/roomApi.test.ts`
- Modify: `README.md`, `README.en.md`, `README.ja.md`, `CHANGELOG.md`, `docs/reference.zh-CN.md`
- Modify: `docs/superpowers/specs/2026-10-23-codebase-and-plugins-design.md` (one supersession line)

**Interfaces:**
- Consumes: `RepoWatcher.tickOne` behavior (fetch, index, `repo.fetched`, `repo.moved`)
- Produces: `packagedGraphifyBin(env?): string`. `RepoWatcher.prepare(repoId: string, taskId?: string): Promise<void>`. `registerRepoHandlers` accepts `prepareRepo?: (repoId: string, taskId?: string) => Promise<void>`. Code `plugin.call` params may include `taskId: string`.

- [x] **Step 1: Write the failing tests**

Assert the missing-runtime string everywhere the uv hint was asserted. Add: PATH is not searched; `start` with `intervalMs: 15` does not fetch; `prepare` fetches once per task and a new task fetches again; a handler `prepareRepo` runs once for two code calls with the same task id; the room API code call includes `taskId`.

- [x] **Step 2: Run the focused tests and confirm they fail**

Run: `node node_modules/vitest/vitest.mjs run apps/cli/test/repos/graphify.test.ts apps/cli/test/repos/watcher.test.ts apps/cli/test/repos/handlers.test.ts apps/cli/test/doctor.test.ts apps/hub/test/roomApi.test.ts`

- [x] **Step 3: Implement the spec**

- [x] **Step 4: Re-run those tests and expect them to pass**

- [x] **Step 5: Commit**

Do not commit unless the user asks. The working tree may contain other work.
