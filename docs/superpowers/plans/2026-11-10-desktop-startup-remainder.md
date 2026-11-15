# Desktop startup remainder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Windows, private-file ACL checks in one process share one PowerShell, and the platform CI job records fresh-process PGlite time plus that helper's cost.

**Architecture:** `windowsAcl` stays synchronous. A worker thread owns one `powershell.exe` and the pipe. The main thread publishes one base64 request in a `SharedArrayBuffer`, waits up to 45 s, and reads one `ok` or `err` line. Every call is evaluated again. `scripts/ci/startup-sample.mjs` prints one JSON object from the existing platform job. It does not launch Electron.

**Tech Stack:** TypeScript in `apps/cli`, Node 22 worker threads, Windows PowerShell .NET ACL calls, Vitest, `node --test`, GitHub Actions `verify.yml`.

## Global Constraints

- Code, comments, and commit messages in English.
- Private-file meaning stays: current user, SYSTEM (`S-1-5-18`), Administrators (`S-1-5-32-544`); refuse a reparse point, a foreign owner, a missing owner read, and any other Allow.
- No cmdlets in the PowerShell script. The cmdlet-name test stays.
- No ACL result cache. A later wider DACL fails.
- One teardown path (`dropHelper`) for every helper failure: timeout, broken pipe or dead child, protocol error, worker error or exit. A replacement PowerShell never starts while the previous child is not confirmed exited.
- One teardown path (`dropHelper`) for every helper failure: timeout, broken pipe or dead child, protocol error, worker error or exit. A replacement PowerShell never starts while the previous child is not confirmed exited.
- No PGlite template, no skipped `migrate()`, no `relaxedDurability` (spec D-1 choice B).
- No packaged `desktop:bench`. The sample is not that bench.
- Do not mark ROADMAP P1-10 done. Do not change the v0.3.0 / P2-04 mapping.
- Changelog is `changelog.d/windows-acl-process.changed.md`, not an edit under `[Unreleased]`.
- The sample creates its own temp directory and never reads `~/.nema`.
- Error text keeps `cannot verify private Windows ACL` and the basename. A reason that is not in the fixed set is `rejected`.

---

### Task 1: Failing Windows helper tests

**Files:**
- Modify: `apps/cli/test/secrets/permissions.test.ts`
- Create: `apps/cli/test/secrets/windows-acl-helper.test.ts`
- Create: `apps/cli/test/secrets/fixtures/fake-acl-helper.mjs`
- Modify: `apps/cli/src/secrets/permissions.ts` (export only, so the new tests compile)

**Interfaces:**
- Consumes: `protectPrivatePath`, `openPrivateFile`, `WINDOWS_ACL_SCRIPT`
- Produces: `windowsAclHelperStarts(): number`, the launcher seam `setWindowsAclLauncherForTest`, `resetWindowsAclHelperForTest`, `windowsAclHelperWorkerForTest`, `windowsAclForTest`, `defaultWindowsAclKillTree`, and the types `WindowsAclLauncher` / `WindowsAclHelperEvent`

- [ ] **Step 1: Export a counter that stays at 0, and launcher seam stubs**

In `apps/cli/src/secrets/permissions.ts`, add:

```typescript
import type { Worker } from "node:worker_threads";

let windowsAclHelperStartCount = 0;

export function windowsAclHelperStarts(): number {
  return windowsAclHelperStartCount;
}

export type WindowsAclHelperEvent =
  | { type: "spawn"; pid: number }
  | { type: "kill"; pid: number }
  | { type: "child-exit"; pid: number }
  | { type: "worker-exit" };

export type WindowsAclLauncher = {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  graceMs: number;
  killConfirmMs: number;
  killTree(pid: number): void;
  onEvent?(event: WindowsAclHelperEvent): void;
};

export function defaultWindowsAclKillTree(_pid: number): void {}
export function setWindowsAclLauncherForTest(_next: Partial<WindowsAclLauncher> | undefined): void {}
export function resetWindowsAclHelperForTest(): void {}
export function windowsAclHelperWorkerForTest(): Worker | undefined {
  return undefined;
}
export function windowsAclForTest(file: string, action: "protect" | "check"): void {
  windowsAcl(file, action);
}
```

Do not increment the counter yet. The stubs ignore the launcher, so `windowsAclForTest` still runs today's one-shot `spawnSync(powershell.exe)` and reports no events.

- [ ] **Step 2: Write the failing tests**

Add these imports to the test: `windowsAclHelperStarts`.

```typescript
test("POSIX mode checks do not start a Windows ACL helper", () => {
  const file = path.join(root, "posix-helper");
  writeFileSync(file, "placeholder", { mode: 0o600 });
  const before = windowsAclHelperStarts();
  protectPrivatePath(file);
  closeSync(openPrivateFile(file));
  if (process.platform === "win32") expect(windowsAclHelperStarts()).toBe(before === 0 ? before + 1 : before);
  else expect(windowsAclHelperStarts()).toBe(before);
});

test.runIf(process.platform === "win32")("several ACL calls share one PowerShell and observe a widened DACL", () => {
  const first = path.join(root, "shared-one");
  const second = path.join(root, "shared-two");
  writeFileSync(first, "placeholder-one", { mode: 0o600 });
  writeFileSync(second, "placeholder-two", { mode: 0o600 });
  const before = windowsAclHelperStarts();
  protectPrivatePath(first);
  protectPrivatePath(second);
  closeSync(openPrivateFile(first));
  closeSync(openPrivateFile(second));
  const started = windowsAclHelperStarts();
  expect(started).toBe(before === 0 ? 1 : before);

  const widened = spawnSync("icacls.exe", [second, "/grant", "*S-1-1-0:R"], { stdio: "ignore", windowsHide: true });
  expect(widened.status).toBe(0);
  let message = "";
  try { openPrivateFile(second); } catch (error) { message = (error as Error).message; }
  expect(message).toMatch(/cannot verify private Windows ACL/);
  expect(message).not.toContain("placeholder-two");
  expect(windowsAclHelperStarts()).toBe(started);
  protectPrivatePath(second);
  closeSync(openPrivateFile(second));
  expect(windowsAclHelperStarts()).toBe(started);
});
```

Extend the cmdlet test so it still reads `WINDOWS_ACL_SCRIPT` after the loop is added. No assertion change in this step.

- [ ] **Step 3: Write the fake helper**

The helper lifecycle tests run on every platform. They swap PowerShell for a Node child through the launcher seam, so the spawns, kills, and exits they observe are real process events, not a fake timer. `apps/cli/test/secrets/fixtures/fake-acl-helper.mjs`:

```javascript
// Stands in for the PowerShell ACL loop: one request line in, one reply line out.
// The basename of the decoded path picks the behavior.
import { createInterface } from "node:readline";

const stubborn = process.argv.includes("--stubborn"); // outlives its worker: ignores stdin EOF
let stuck = false;
const keepAlive = () => setInterval(() => {}, 1 << 30);
if (stubborn) keepAlive();
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const file = Buffer.from(line.slice(line.indexOf(" ") + 1), "base64").toString("utf8");
  if (file.endsWith("hang")) {
    // Stuck inside an ACL call: never replies and ignores a graceful stop.
    stuck = true;
    keepAlive();
    return;
  }
  if (file.endsWith("die")) process.exit(3);
  if (file.endsWith("close-stdin")) {
    // Close the read end first, so the worker's next write hits a broken pipe while this process lives on.
    stuck = true;
    process.stdin.destroy();
    keepAlive();
  }
  process.stdout.write(file.endsWith("garble") ? "garbled\n" : "ok\n");
});
lines.on("close", () => {
  if (!stubborn && !stuck) process.exit(0);
});
```

- [ ] **Step 4: Write the failing helper lifecycle tests**

`apps/cli/test/secrets/windows-acl-helper.test.ts` is a separate file, so its module state (the helper singleton and the counter) does not leak into `permissions.test.ts`.

```typescript
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import {
  defaultWindowsAclKillTree,
  resetWindowsAclHelperForTest,
  setWindowsAclLauncherForTest,
  windowsAclForTest,
  windowsAclHelperWorkerForTest,
  type WindowsAclHelperEvent,
} from "../../src/secrets/permissions.js";

const fake = fileURLToPath(new URL("./fixtures/fake-acl-helper.mjs", import.meta.url));
const at = (name: string) => path.join(os.tmpdir(), `nema-acl-${name}`);
let events: WindowsAclHelperEvent[] = [];
let orphansAtSpawn: number[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawned(): number[] {
  return events.flatMap((event) => (event.type === "spawn" ? [event.pid] : []));
}

function useFake(options: { stubborn?: boolean; killTree?: (pid: number) => void } = {}): void {
  setWindowsAclLauncherForTest({
    command: process.execPath,
    args: [fake, ...(options.stubborn ? ["--stubborn"] : [])],
    timeoutMs: 1_000,
    graceMs: 200,
    killConfirmMs: 1_000,
    killTree: options.killTree ?? defaultWindowsAclKillTree,
    onEvent: (event) => {
      // Observed at the moment a replacement child exists: every earlier child must already be gone.
      if (event.type === "spawn") orphansAtSpawn.push(...spawned().filter(alive));
      events.push(event);
    },
  });
}

// No orphan: before each replacement spawn, the previous PID has a child-exit event and is not running.
function expectNoOrphan(): void {
  const pids = spawned();
  for (let i = 1; i < pids.length; i += 1) {
    const replacement = events.findIndex((event) => event.type === "spawn" && event.pid === pids[i]);
    const exited = events.findIndex((event) => event.type === "child-exit" && event.pid === pids[i - 1]);
    expect(exited).toBeGreaterThan(-1);
    expect(exited).toBeLessThan(replacement);
  }
  expect(orphansAtSpawn).toEqual([]);
  for (const pid of pids.slice(0, -1)) expect(alive(pid)).toBe(false);
}

afterEach(() => {
  resetWindowsAclHelperForTest();
  events = [];
  orphansAtSpawn = [];
});

test("timeout: the stuck child is killed by its recorded PID and confirmed gone before a replacement spawns", () => {
  useFake();
  expect(() => windowsAclForTest(at("hang"), "check")).toThrow(/cannot verify private Windows ACL \(timeout\)/);
  windowsAclForTest(at("fine"), "check");
  const [first, second] = spawned();
  expect(events).toEqual([
    { type: "spawn", pid: first },
    { type: "kill", pid: first },
    { type: "child-exit", pid: first },
    { type: "spawn", pid: second },
  ]);
  expectNoOrphan();
});

test("broken pipe: a child that closed its stdin but still runs is killed before a replacement spawns", () => {
  useFake();
  windowsAclForTest(at("close-stdin"), "check");
  expect(() => windowsAclForTest(at("fine"), "check")).toThrow(/\(helper exited\)/);
  windowsAclForTest(at("fine"), "check");
  const [first, second] = spawned();
  expect(events).toEqual([
    { type: "spawn", pid: first },
    { type: "kill", pid: first },
    { type: "child-exit", pid: first },
    { type: "spawn", pid: second },
  ]);
  expectNoOrphan();
});

test("child exit: a child that already exited is not killed, and its exit precedes the replacement", () => {
  useFake();
  expect(() => windowsAclForTest(at("die"), "check")).toThrow(/\(helper exited\)/);
  windowsAclForTest(at("fine"), "check");
  expect(events.map((event) => event.type)).toEqual(["spawn", "child-exit", "spawn"]);
  expectNoOrphan();
});

test("protocol error: a garbled reply rejects the call and goes through the same teardown", () => {
  useFake();
  expect(() => windowsAclForTest(at("garble"), "check")).toThrow(/\(rejected\)/);
  windowsAclForTest(at("fine"), "check");
  expect(events.map((event) => event.type)).toEqual(["spawn", "child-exit", "spawn"]);
  expectNoOrphan();
});

// Windows only: on POSIX the killed child of a dead worker stays a zombie that no loop reaps, and
// `process.kill(pid, 0)` still succeeds on a zombie. Production only takes this path on Windows.
test.runIf(process.platform === "win32")("worker crash: a child that outlives its worker is killed before a replacement spawns", async () => {
  useFake({ stubborn: true });
  windowsAclForTest(at("fine"), "check");
  const [first] = spawned();
  await windowsAclHelperWorkerForTest()?.terminate();
  await vi.waitFor(() => expect(events).toContainEqual({ type: "child-exit", pid: first }));
  windowsAclForTest(at("fine"), "check");
  const second = spawned()[1];
  expect(events).toEqual([
    { type: "spawn", pid: first },
    { type: "worker-exit" },
    { type: "kill", pid: first },
    { type: "child-exit", pid: first },
    { type: "spawn", pid: second },
  ]);
  expectNoOrphan();
});

test("a kill that does not take effect blocks every replacement until the old child is gone", () => {
  const ignored: number[] = [];
  useFake({ killTree: (pid) => ignored.push(pid) });
  expect(() => windowsAclForTest(at("hang"), "check")).toThrow(/\(timeout\)/);
  expect(() => windowsAclForTest(at("fine"), "check")).toThrow(/\(helper exited\)/);
  const [first] = spawned();
  expect(spawned()).toEqual([first]);
  expect(ignored).toEqual([first, first]);
  useFake();
  windowsAclForTest(at("fine"), "check");
  expect(spawned()).toHaveLength(2);
  expectNoOrphan();
});
```

- [ ] **Step 5: Run the tests and confirm the new assertions fail**

Run: `npx vitest run apps/cli/test/secrets/permissions.test.ts apps/cli/test/secrets/windows-acl-helper.test.ts`

Expected on Linux: the POSIX test passes (counter stays 0), the `runIf(win32)` tests are skipped, and every other lifecycle test in `windows-acl-helper.test.ts` fails because the stub ignores the launcher and records no `spawn` event. Expected on Windows: the shared-process test also fails because the counter stays 0.

### Task 2: One PowerShell process

**Files:**
- Modify: `apps/cli/src/secrets/permissions.ts`

**Interfaces:**
- Consumes: `windowsAclHelperStarts`
- Produces: the same `protectPrivatePath`, `assertPrivateAcl`, and `openPrivateFile` behavior, with one helper per process on Windows; a recorded child PID per helper; one ordered teardown (`dropHelper`) for every failure; the working launcher seam from Task 1

- [ ] **Step 1: Replace the one-shot script with a loop that has no cmdlets**

Replace `WINDOWS_ACL_SCRIPT` with this `String.raw` script. `UseNemaAcl` is the previous body, reading arguments instead of `NEMA_PRIVATE_PATH` / `NEMA_PRIVATE_ACTION`.

```powershell
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
function UseNemaAcl([string]$file, [string]$action) {
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if ([System.IO.Directory]::Exists($file)) { $item = [System.IO.DirectoryInfo]::new($file); $isDirectory = $true }
  elseif ([System.IO.File]::Exists($file)) { $item = [System.IO.FileInfo]::new($file); $isDirectory = $false }
  else { throw 'Path not found' }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
  if ($action -eq 'protect') {
    if ($isDirectory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $identity = [System.Security.Principal.SecurityIdentifier]::new($principal)
      if ($isDirectory) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      } else {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'Allow')
      }
      $acl.AddAccessRule($rule)
    }
    $item.SetAccessControl($acl)
  }
  $acl = $item.GetAccessControl()
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unexpected owner' }
  $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  $hasOwner = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($allowed -notcontains $rule.IdentityReference.Value) { throw 'Non-private ACL' }
      if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData)) { $hasOwner = $true }
    }
  }
  if (-not $hasOwner) { throw 'Owner cannot read' }
}
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Length -eq 0) { continue }
  try {
    $space = $line.IndexOf(' ')
    if ($space -lt 1) { throw 'protocol' }
    $action = $line.Substring(0, $space)
    if ($action -ne 'protect' -and $action -ne 'check') { throw 'protocol' }
    $file = $utf8.GetString([System.Convert]::FromBase64String($line.Substring($space + 1)))
    UseNemaAcl $file $action
    [Console]::Out.WriteLine('ok')
  } catch {
    $message = $_.Exception.Message
    if ($null -eq $message) { $message = 'rejected' }
    $message = $message.Replace([char]13, ' ').Replace([char]10, ' ')
    [Console]::Out.WriteLine('err ' + $message)
  }
  [Console]::Out.Flush()
}
```

- [ ] **Step 2: Talk to that process from a worker**

Replace the Task 1 `import type { Worker }` with `import { Worker } from "node:worker_threads"`, and replace the Task 1 seam stubs with the code below. Keep the `spawnSync` import: production `windowsAcl` no longer calls it, but `defaultWindowsAclKillTree` runs `taskkill.exe` through it.

Slots in the `SharedArrayBuffer` (`Int32Array` index): 0 request state (0 idle, 1 request, 2 reply, 3 stop), 1 request bytes, 2 reply bytes, 3 child usable, 4 child PID (`-1` when no process was spawned), 5 child exited, 6 worker done. Payload bytes start at offset 32, after the slots.

Teardown order in `dropHelper`, the only path that retires a helper:

1. Graceful stop: store 3 in slot 0. The worker ends PowerShell's stdin, and the script's `ReadLine` loop gets `$null` and exits. Wait up to `graceMs` (1 s) for slot 5.
2. Kill: if the child has not exited, call `killTree` with the recorded PID (`taskkill /PID <pid> /T /F` on Windows), then wait up to `killConfirmMs` (5 s) until the exit is confirmed by slot 5 or by `process.kill(pid, 0)` returning `ESRCH`. If neither confirms it, the helper stays `retiring`. Later calls retry steps 1–2 and return `helper exited` without spawning anything.
3. Worker: wait for slot 6, which is the worker's last statement, then `terminate()` it. After slot 6 the worker spawns nothing and writes no pipe. If slot 6 never arrives and the worker `exit` event has not fired, the helper stays `retiring`.
4. Only then clear the singleton, so the next call may create a new helper.

A child that has already reported its exit is not killed: once the worker reaps it, its PID may be reused. Before that, while the worker holds the child's handle, Windows does not reuse the PID. When the worker died first, `process.kill(pid, 0)` is the only exit evidence. One race window stays open and is listed as a PR limitation: the child exits and Windows reuses its PID after the worker's death but before the kill.

```typescript
const ACL_REASONS = new Set([
  "Path not found",
  "Reparse point refused",
  "Unexpected owner",
  "Non-private ACL",
  "Owner cannot read",
  "protocol",
  "helper exited",
  "timeout",
  "rejected",
]);

const DATA = 32;
const STOP = 3;
const WORKER_DONE_MS = 1_000;

const workerSource = `
import { workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
const DATA = 32;
const state = new Int32Array(workerData.sab);
const bytes = Buffer.from(workerData.sab);
function signal(slot, value) {
  Atomics.store(state, slot, value);
  Atomics.notify(state, slot);
}
let child;
let exited = Promise.resolve();
if (Atomics.load(state, 0) !== 3) {
  child = spawn(workerData.command, workerData.args, {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    env: process.env,
  });
  exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", () => {
      if (child.pid === undefined) resolve();
    });
  });
}
// Report the PID first, so the supervisor can kill this child even if this worker dies.
signal(4, child?.pid ?? -1);
exited.then(() => signal(5, 1));
let pending = "";
const waiters = [];
let childGone = !child;
if (childGone) Atomics.store(state, 3, 0);
function noteChildGone() {
  if (childGone) return;
  childGone = true;
  Atomics.store(state, 3, 0);
  while (waiters.length) waiters.shift()("err helper exited");
}
if (child) {
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf("\\n")) !== -1) {
      const line = pending.slice(0, nl).replace(/\\r$/, "");
      pending = pending.slice(nl + 1);
      if (!line) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(line);
    }
  });
  child.stdin.on("error", noteChildGone);
  child.on("error", noteChildGone);
  child.on("exit", noteChildGone);
}
function roundtrip(line) {
  if (childGone) return Promise.resolve("err helper exited");
  return new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(line + "\\n");
  });
}
while (true) {
  const current = Atomics.load(state, 0);
  if (current === 3) break;
  if (current !== 1) {
    const waited = Atomics.waitAsync(state, 0, current);
    if (waited.async) await waited.value;
    continue;
  }
  const length = Atomics.load(state, 1);
  const request = bytes.subarray(DATA, DATA + length).toString("utf8");
  const reply = String(childGone ? "err helper exited" : await roundtrip(request)).slice(0, 400);
  const encoded = Buffer.from(reply);
  encoded.copy(bytes, DATA);
  Atomics.store(state, 2, encoded.length);
  // A supervisor that gave up on this request has already stored 3. Do not overwrite it.
  if (Atomics.compareExchange(state, 0, 1, 2) !== 1) break;
  Atomics.notify(state, 0);
  if (childGone) break;
}
// Graceful stop: closing stdin makes the PowerShell loop read null and exit.
// The supervisor kills the recorded PID tree if it is still running after the grace period.
if (child && !child.stdin.destroyed) child.stdin.end();
await exited;
child?.stdout.destroy();
// Last statement: after this the worker spawns nothing and writes no pipe.
signal(6, 1);
`;

export type WindowsAclHelperEvent =
  | { type: "spawn"; pid: number }
  | { type: "kill"; pid: number }
  | { type: "child-exit"; pid: number }
  | { type: "worker-exit" };

/** How the helper child is started and stopped. Tests replace it; production uses `defaultLauncher()`. */
export type WindowsAclLauncher = {
  command: string;
  args: readonly string[];
  timeoutMs: number;
  graceMs: number;
  killConfirmMs: number;
  killTree(pid: number): void;
  onEvent?(event: WindowsAclHelperEvent): void;
};

export function defaultWindowsAclKillTree(pid: number): void {
  if (process.platform !== "win32") {
    // Only the cross-platform lifecycle tests reach this branch.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    return;
  }
  const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5_000 });
}

function defaultLauncher(): WindowsAclLauncher {
  return {
    command: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
    timeoutMs: 45_000,
    graceMs: 1_000,
    killConfirmMs: 5_000,
    killTree: defaultWindowsAclKillTree,
  };
}

let launcherOverride: Partial<WindowsAclLauncher> | undefined;

function launcher(): WindowsAclLauncher {
  return { ...defaultLauncher(), ...launcherOverride };
}

type AclHelper = {
  worker: Worker;
  state: Int32Array;
  bytes: Buffer;
  childPid: number; // 0 until the worker reports it, -1 when no process was spawned
  childExitReported: boolean;
  workerExited: boolean;
  retiring: boolean;
};

let helper: AclHelper | undefined;

function emit(event: WindowsAclHelperEvent): void {
  launcher().onEvent?.(event);
}

// True once the slot is nonzero; false after `ms`.
function waitSlot(state: Int32Array, slot: number, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (Atomics.load(state, slot) === 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(state, slot, 0, Math.min(remaining, 25));
  }
  return true;
}

function recordChildPid(current: AclHelper, ms: number): void {
  if (current.childPid !== 0 || !waitSlot(current.state, 4, ms)) return;
  current.childPid = Atomics.load(current.state, 4);
  if (current.childPid > 0) emit({ type: "spawn", pid: current.childPid });
}

function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function childGone(current: AclHelper, ms: number): boolean {
  const deadline = Date.now() + ms;
  while (true) {
    const gone =
      Atomics.load(current.state, 5) === 1 ||
      current.childPid === -1 ||
      (current.childPid === 0 && current.workerExited) ||
      (current.childPid > 0 && processGone(current.childPid));
    if (gone) {
      if (current.childPid > 0 && !current.childExitReported) {
        current.childExitReported = true;
        emit({ type: "child-exit", pid: current.childPid });
      }
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    Atomics.wait(current.state, 5, 0, Math.min(remaining, 25));
  }
}

// Every drop trigger ends here: timeout, broken pipe or dead child, protocol error, worker error or exit.
// The singleton is cleared only after the child is confirmed gone and the worker is done, so a
// replacement never runs next to a PowerShell that could still change an ACL.
function dropHelper(): void {
  const current = helper;
  if (!current) return;
  const run = launcher();
  current.retiring = true;
  // (a) Graceful stop, bounded by graceMs.
  Atomics.store(current.state, 0, STOP);
  Atomics.notify(current.state, 0);
  recordChildPid(current, 0);
  let gone = childGone(current, run.graceMs);
  // (b) Kill the recorded process tree and wait until the exit is confirmed.
  if (!gone) {
    recordChildPid(current, 0);
    if (current.childPid > 0) {
      emit({ type: "kill", pid: current.childPid });
      run.killTree(current.childPid);
      gone = childGone(current, run.killConfirmMs);
    }
  }
  if (!gone) return; // Still retiring: later calls retry and never start a replacement.
  // (c) Finish the worker: its last statement sets slot 6, then terminate it.
  if (!current.workerExited && !waitSlot(current.state, 6, WORKER_DONE_MS)) return;
  void current.worker.terminate();
  // (d) Only now may a later call create a fresh helper.
  if (helper === current) helper = undefined;
}

function ensureHelper(): AclHelper | undefined {
  if (helper && (helper.retiring || Atomics.load(helper.state, 3) === 0)) dropHelper();
  if (helper) return helper.retiring ? undefined : helper;
  const run = launcher();
  const sab = new SharedArrayBuffer(65536);
  const state = new Int32Array(sab);
  Atomics.store(state, 3, 1);
  // data: URL is a module on every Node 22. eval:true was a classic script before 22.7.
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {
    workerData: { command: run.command, args: run.args, sab },
  });
  worker.unref();
  const current: AclHelper = {
    worker,
    state,
    bytes: Buffer.from(sab),
    childPid: 0,
    childExitReported: false,
    workerExited: false,
    retiring: false,
  };
  worker.on("error", () => {
    if (helper === current) dropHelper();
  });
  worker.on("exit", () => {
    current.workerExited = true;
    emit({ type: "worker-exit" });
    if (helper === current) dropHelper();
  });
  windowsAclHelperStartCount += 1;
  helper = current;
  // Record the PID before any request, so every later teardown can kill it.
  recordChildPid(current, run.timeoutMs);
  if (current.childPid <= 0) {
    dropHelper();
    return undefined;
  }
  return current;
}

export function setWindowsAclLauncherForTest(next: Partial<WindowsAclLauncher> | undefined): void {
  launcherOverride = next;
}

export function resetWindowsAclHelperForTest(): void {
  dropHelper();
  launcherOverride = undefined;
}

export function windowsAclHelperWorkerForTest(): Worker | undefined {
  return helper?.worker;
}

export function windowsAclForTest(file: string, action: "protect" | "check"): void {
  windowsAcl(file, action);
}

function askOnce(request: string): string {
  const current = ensureHelper();
  if (!current || Atomics.load(current.state, 3) === 0) return "err helper exited";
  const encoded = Buffer.from(request);
  if (encoded.length > 60000) return "err rejected";
  encoded.copy(current.bytes, DATA);
  Atomics.store(current.state, 1, encoded.length);
  Atomics.store(current.state, 0, 1);
  Atomics.notify(current.state, 0);
  const deadline = Date.now() + launcher().timeoutMs;
  let wait: "ok" | "not-equal" | "timed-out" = "ok";
  while (Atomics.load(current.state, 0) === 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      wait = "timed-out";
      break;
    }
    wait = Atomics.wait(current.state, 0, 1, remaining);
    if (wait === "timed-out") break;
  }
  if (Atomics.load(current.state, 0) !== 2) return wait === "timed-out" ? "err timeout" : "err helper exited";
  const length = Atomics.load(current.state, 2);
  const reply = current.bytes.subarray(DATA, DATA + length).toString("utf8");
  Atomics.store(current.state, 0, 0);
  Atomics.notify(current.state, 0);
  return reply;
}

// The single place a failed call retires the helper. A helper that is already retiring was just
// retried by ensureHelper, so it is not torn down twice in one call.
function askHelper(request: string): string {
  const reply = askOnce(request);
  const helperFault =
    reply === "err timeout" ||
    reply === "err helper exited" ||
    reply === "err protocol" ||
    (reply !== "ok" && !reply.startsWith("err "));
  if (helperFault && helper && !helper.retiring) dropHelper();
  return reply;
}

function windowsAcl(file: string, action: "protect" | "check"): void {
  const started = process.env.NEMA_DESKTOP_BENCH === "1" ? Date.now() : 0;
  try {
    const reply = askHelper(`${action} ${Buffer.from(path.resolve(file), "utf8").toString("base64")}`);
    if (reply === "ok") return;
    const raw = reply.startsWith("err ") ? reply.slice(4) : "rejected";
    const reason = ACL_REASONS.has(raw) ? raw : "rejected";
    throw new Error(`${path.basename(file)}: 无法验证私有 Windows ACL / cannot verify private Windows ACL (${reason})`);
  } finally {
    if (started) recordWindowsAclBench(action, Date.now() - started);
  }
}
```

`protectPrivatePath`, `assertPrivateAcl`, and `openPrivateFile` keep calling `windowsAcl`. No other call site changes.

- [ ] **Step 3: Run the permission tests**

Run: `npx vitest run apps/cli/test/secrets/permissions.test.ts apps/cli/test/secrets/windows-acl-helper.test.ts apps/cli/test/secrets/file.test.ts`

Expected on Linux: pass, including the timeout, broken-pipe, child-exit, protocol-error, and failed-kill lifecycle tests. Each one checks the `spawn`, `kill`, and `child-exit` events from the launcher seam and that every earlier PID is gone when a replacement spawns. Do not substitute a count of `Worker` constructions or `windowsAclHelperStarts()` for those events. The Windows shared-process test and the worker-crash test run only on `windows-latest`. On Windows, the lifecycle tests run the same Node fake, and `defaultWindowsAclKillTree` takes its `taskkill.exe /T /F` branch.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/secrets/permissions.ts apps/cli/test/secrets/permissions.test.ts apps/cli/test/secrets/windows-acl-helper.test.ts apps/cli/test/secrets/fixtures/fake-acl-helper.mjs
git commit -m "fix(cli): share one PowerShell across Windows ACL checks"
```

### Task 3: Platform sample

**Files:**
- Create: `scripts/ci/startup-sample.mjs`
- Create: `scripts/ci/startup-sample.test.mjs`
- Modify: `.github/workflows/verify.yml` (platform job, after `npm run typecheck`)

**Interfaces:**
- Consumes: `createLocalDb` from `@nema/hub/db/local`, `migrate` timing split is not required; the child prints ready, migrate, and total. `protectPrivatePath`, `openPrivateFile`, `windowsAclHelperStarts` from `@nema/cli/secrets/permissions`.
- Produces: one JSON object on stdout

- [ ] **Step 1: Write the usage test**

`scripts/ci/startup-sample.test.mjs`:

```javascript
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./startup-sample.mjs', import.meta.url));

test('startup sample rejects an explicit home', () => {
  const run = spawnSync(process.execPath, [script, '--home', '/tmp/not-a-user-home'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stderr}`, /usage/i);
});
```

The script must parse argv before it opens a database. Unknown arguments throw `usage: startup-sample.mjs [cold <dir> | warm <dir>]`.

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test scripts/ci/startup-sample.test.mjs`

Expected: fail because the script does not exist.

- [ ] **Step 3: Implement the sample**

`scripts/ci/startup-sample.mjs` behavior:

- No args: create a temp directory, spawn this same executable twice with `node --conditions=development --import tsx <script> cold <dir>` and then `warm <dir>`, delete the temp directory in `finally`, print one JSON object.
- `cold <dir>` / `warm <dir>`: dynamic-import `PGlite` and `migrate` the same way `createLocalDb` does (`new PGlite(dir)`, `waitReady`, then `migrate`). Print `{ readyMs, migrateMs, totalMs }` and exit. Do not call `homedir()`.
- Parent JSON: `{ platform, arch, node, cold, warm, windowsAcl }`.
- `windowsAcl` is `null` unless `process.platform === 'win32'`. On Windows, time eight `spawnSync` runs of `powershell.exe -NoLogo -NoProfile -NonInteractive -Command exit 0`, then create four temp files and `protectPrivatePath` plus `openPrivateFile` each (eight calls). Record `{ emptyProcess: { count: 8, totalMs }, helperCalls: { count: 8, totalMs, starts } }` where `starts` is `windowsAclHelperStarts()` after those calls minus the count from before them.
- Close the PGlite client and the opened file descriptors.

- [ ] **Step 4: Add the platform step**

In `.github/workflows/verify.yml`, in job `platform`, after `npm run typecheck` and before the native credential vitest step:

```yaml
      - name: Source startup sample
        run: node --conditions=development --import tsx scripts/ci/startup-sample.mjs
```

- [ ] **Step 5: Run the usage test and typecheck**

Run: `node --test scripts/ci/startup-sample.test.mjs`

Expected: pass.

Run: `node --conditions=development --import tsx scripts/ci/startup-sample.mjs`

Expected: one JSON object, `windowsAcl: null` on Linux, temp directory removed.

If `scripts/ci/workflows.test.mjs` or `scripts/ci/policy.mjs` asserts the platform step list, update that assertion to include `startup-sample.mjs`.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci/startup-sample.mjs scripts/ci/startup-sample.test.mjs .github/workflows/verify.yml
git commit -m "ci: sample desktop database and Windows ACL startup cost"
```

### Task 4: Changelog and roadmap

**Files:**
- Create: `changelog.d/windows-acl-process.changed.md`
- Modify: `ROADMAP.md` (P1-10 cell and one execution row)

- [ ] **Step 1: Write the fragment**

`changelog.d/windows-acl-process.changed.md`:

```markdown
- On Windows, private-file checks during desktop startup share one PowerShell process per app process. A file that is no longer private is still rejected. Cold-start database initialization and packaged Windows and macOS startup numbers are unchanged.
```

- [ ] **Step 2: Update P1-10**

In the P1-10 matter cell, replace the sentence that says cold-start PGlite migration, merging ACL checks into one PowerShell, and packaged benches are all undone. State that Windows ACL checks in one process share one PowerShell and each check still runs; a pre-built PGlite directory was not shipped (D-1 choice B in [the spec](../specs/2026-11-10-desktop-startup-remainder-design.md)); packaged `desktop:bench` numbers are still absent. Add the spec and plan links next to the existing startup spec links. Leave status 进行中. Leave the acceptance cell's packaged-bench sentence. Append an execution row dated 2026-11-10 for P1-10 pointing at this implementation PR, target version 未承诺, and say the Windows shared-process test is the ACL evidence while packaged bench and the PGlite template remain open.

- [ ] **Step 3: Commit**

```bash
git add changelog.d/windows-acl-process.changed.md ROADMAP.md
git commit -m "docs: record the shared Windows ACL process"
```

### Task 5: Verify

- [ ] **Step 1: Typecheck and the touched tests**

Run:

```bash
npm run typecheck
npx vitest run apps/cli/test/secrets/permissions.test.ts apps/cli/test/secrets/windows-acl-helper.test.ts apps/cli/test/secrets/file.test.ts
node --test scripts/ci/startup-sample.test.mjs
```

Expected: pass. On Linux, `windowsAclHelperStarts()` stays 0 in `permissions.test.ts`. In `windows-acl-helper.test.ts`, the event log shows each replaced child's `kill` (when it was still running) and `child-exit` before the next `spawn`. No earlier PID is alive at a spawn. A kill that does not take effect produces no second spawn.

The worker-crash test and the real-PowerShell tests are Windows evidence only from the `windows-latest` job log. A Linux run does not stand in for them.

- [ ] **Step 2: Do not claim packaged or Windows milliseconds from this host**

The platform job log is the Windows and macOS evidence. Copy that JSON into the PR body after the job runs. Linux numbers in the spec stay labeled as Linux.
