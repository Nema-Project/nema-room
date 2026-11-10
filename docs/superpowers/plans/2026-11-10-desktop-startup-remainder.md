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
- Modify: `apps/cli/src/secrets/permissions.ts` (export only, so the new tests compile)

**Interfaces:**
- Consumes: `protectPrivatePath`, `openPrivateFile`, `WINDOWS_ACL_SCRIPT`
- Produces: `windowsAclHelperStarts(): number`

- [ ] **Step 1: Export a counter that stays at 0**

In `apps/cli/src/secrets/permissions.ts`, add:

```typescript
let windowsAclHelperStartCount = 0;

export function windowsAclHelperStarts(): number {
  return windowsAclHelperStartCount;
}
```

Do not increment it yet.

- [ ] **Step 2: Write the failing tests**

Add these imports to the test: `windowsAclHelperStarts`.

```typescript
test("POSIX mode checks do not start a Windows ACL helper", () => {
  const file = path.join(root, "posix-helper");
  writeFileSync(file, "placeholder", { mode: 0o600 });
  const before = windowsAclHelperStarts();
  protectPrivatePath(file);
  closeSync(openPrivateFile(file));
  if (process.platform === "win32") expect(windowsAclHelperStarts()).toBeGreaterThan(before);
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

- [ ] **Step 3: Run the tests and confirm the Windows assertion fails**

Run: `npx vitest run apps/cli/test/secrets/permissions.test.ts`

Expected on Linux: the POSIX test passes (counter stays 0) and the `runIf(win32)` test is skipped. Expected on Windows: the shared-process test fails because the counter stays 0.

### Task 2: One PowerShell process

**Files:**
- Modify: `apps/cli/src/secrets/permissions.ts`

**Interfaces:**
- Consumes: `windowsAclHelperStarts`
- Produces: the same `protectPrivatePath`, `assertPrivateAcl`, and `openPrivateFile` behavior, with one helper per process on Windows

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
    $message = $message.Replace("`r", ' ').Replace("`n", ' ')
    [Console]::Out.WriteLine('err ' + $message)
  }
  [Console]::Out.Flush()
}
```

- [ ] **Step 2: Talk to that process from a worker**

Add `import { Worker } from "node:worker_threads"`. Keep `spawnSync` imported only if a test file needs it; production `windowsAcl` no longer calls it. Remove the `spawnSync` import from `permissions.ts` if nothing else in the file uses it.

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

const workerSource = `
import { workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
const state = new Int32Array(workerData.sab);
const bytes = Buffer.from(workerData.sab);
const child = spawn(workerData.exe, workerData.args, {
  stdio: ["pipe", "pipe", "ignore"],
  windowsHide: true,
  env: process.env,
});
let pending = "";
const waiters = [];
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
child.on("exit", () => {
  const waiter = waiters.shift();
  if (waiter) waiter("err helper exited");
});
function roundtrip(line) {
  return new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(line + "\\n");
  });
}
while (true) {
  while (Atomics.load(state, 0) === 0) {
    const waited = Atomics.waitAsync(state, 0, 0);
    if (waited.async) await waited.value;
  }
  if (Atomics.load(state, 0) !== 1) continue;
  const length = Atomics.load(state, 1);
  const request = bytes.subarray(16, 16 + length).toString("utf8");
  const reply = String(await roundtrip(request)).slice(0, 400);
  const encoded = Buffer.from(reply);
  encoded.copy(bytes, 16);
  Atomics.store(state, 2, encoded.length);
  Atomics.store(state, 0, 2);
  Atomics.notify(state, 0);
}
`;

type AclHelper = { worker: Worker; state: Int32Array; bytes: Buffer };

let helper: AclHelper | undefined;

function dropHelper(): void {
  const current = helper;
  helper = undefined;
  void current?.worker.terminate();
}

function ensureHelper(): AclHelper {
  if (helper) return helper;
  const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const sab = new SharedArrayBuffer(65536);
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      exe,
      sab,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
    },
  });
  worker.unref();
  worker.on("error", () => dropHelper());
  windowsAclHelperStartCount += 1;
  helper = { worker, state: new Int32Array(sab), bytes: Buffer.from(sab) };
  return helper;
}

function askHelper(request: string): string {
  const current = ensureHelper();
  const encoded = Buffer.from(request);
  if (encoded.length > 60000) return "err rejected";
  encoded.copy(current.bytes, 16);
  Atomics.store(current.state, 1, encoded.length);
  Atomics.store(current.state, 0, 1);
  Atomics.notify(current.state, 0);
  const wait = Atomics.wait(current.state, 0, 1, 45_000);
  if (Atomics.load(current.state, 0) !== 2) {
    dropHelper();
    return wait === "timed-out" ? "err timeout" : "err helper exited";
  }
  const length = Atomics.load(current.state, 2);
  const reply = current.bytes.subarray(16, 16 + length).toString("utf8");
  Atomics.store(current.state, 0, 0);
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

Run: `npx vitest run apps/cli/test/secrets/permissions.test.ts apps/cli/test/secrets/file.test.ts`

Expected on Linux: pass. The Windows shared-process test runs only on `windows-latest`.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/secrets/permissions.ts apps/cli/test/secrets/permissions.test.ts
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

In the P1-10 matter cell, replace the sentence that says cold-start PGlite migration, merging ACL checks into one PowerShell, and packaged benches are all undone. State that Windows ACL checks in one process share one PowerShell and each check still runs; a pre-built PGlite directory was not shipped (D-1 choice B in [the spec](docs/superpowers/specs/2026-11-10-desktop-startup-remainder-design.md)); packaged `desktop:bench` numbers are still absent. Add the spec and plan links next to the existing startup spec links. Leave status 进行中. Leave the acceptance cell's packaged-bench sentence. Append an execution row dated 2026-11-10 for P1-10 pointing at this implementation PR, target version 未承诺, and say the Windows shared-process test is the ACL evidence while packaged bench and the PGlite template remain open.

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
npx vitest run apps/cli/test/secrets/permissions.test.ts apps/cli/test/secrets/file.test.ts
node --test scripts/ci/startup-sample.test.mjs
```

Expected: pass. On Linux, `windowsAclHelperStarts()` stays 0.

- [ ] **Step 2: Do not claim packaged or Windows milliseconds from this host**

The platform job log is the Windows and macOS evidence. Copy that JSON into the PR body after the job runs. Linux numbers in the spec stay labeled as Linux.
