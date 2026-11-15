import { Worker } from "node:worker_threads";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";

// Windows exposes synthetic POSIX modes. Enforce a private DACL instead of treating 0666 as 0600.
// Only .NET calls, no cmdlets: autoloading Get-Item/New-Object took ~22s per call under the managed core's
// filtered environment on a GitHub Windows runner, while this script runs in ~0.2s there.
// One process serves every path. Each line is still evaluated; nothing is cached.
export const WINDOWS_ACL_SCRIPT = String.raw`
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
`;

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

const workerSource = String.raw`
import { parentPort, workerData } from "node:worker_threads";
import { spawn } from "node:child_process";
const state = new Int32Array(workerData.sab);
const control = new Int32Array(workerData.control);
const launcher = workerData.launcherModule ? await import(workerData.launcherModule) : { spawn };
const bytes = Buffer.from(workerData.sab);
// A timeout during module loading must not spawn a child after teardown failed.
if (Atomics.load(control, 0) !== 0) {
  Atomics.store(control, 2, 1);
  process.exit(0);
}
const child = launcher.spawn(workerData.exe, workerData.args, {
  stdio: ["pipe", "pipe", "ignore"],
  windowsHide: true,
  env: process.env,
});
// Publish synchronously too: a worker crash must not lose the PID message.
Atomics.store(control, 1, child.pid ?? 0);
Atomics.store(control, 2, 1);
parentPort.postMessage({ pid: child.pid });
parentPort.on("message", () => child.stdin.end());
let pending = "";
const waiters = [];
let childGone = false;
function noteChildGone() {
  if (childGone) return;
  childGone = true;
  Atomics.store(state, 3, 0);
  parentPort.postMessage({ broken: true });
  while (waiters.length) waiters.shift()("err helper exited");
}
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;
  let nl;
  while ((nl = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, nl).replace(/\r$/, "");
    pending = pending.slice(nl + 1);
    if (!line) continue;
    const waiter = waiters.shift();
    if (waiter) waiter(line);
  }
});
child.stdin.on("error", noteChildGone);
child.on("error", noteChildGone);
child.on("exit", () => { parentPort.postMessage({ childExited: true }); noteChildGone(); });
function roundtrip(line) {
  if (childGone) return Promise.resolve("err helper exited");
  return new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(line + "\n");
  });
}
while (true) {
  const current = Atomics.load(state, 0);
  if (current !== 1) {
    const waited = Atomics.waitAsync(state, 0, current);
    if (waited.async) await waited.value;
    continue;
  }
  const length = Atomics.load(state, 1);
  const request = bytes.subarray(16, 16 + length).toString("utf8");
  const reply = String(childGone ? "err helper exited" : await roundtrip(request)).slice(0, 400);
  const encoded = Buffer.from(reply);
  encoded.copy(bytes, 16);
  Atomics.store(state, 2, encoded.length);
  Atomics.store(state, 0, 2);
  Atomics.notify(state, 0);
  if (childGone) break;
}
`;

// The public API is synchronous. A separate supervisor can await process/worker exits
// while its caller is blocked in Atomics.wait; main-thread callbacks cannot do that.
const supervisorSource = String.raw`
import { Worker, workerData } from "node:worker_threads";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const state = new Int32Array(workerData.sab);
const control = new Int32Array(workerData.control);
const launcher = workerData.launcherModule ? await import(workerData.launcherModule) : undefined;
let pid = 0;
let childExited = false;
let workerExited = false;
let dropping;
const worker = new Worker(new URL(workerData.source), { workerData });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(id) {
  try { process.kill(id, 0); }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
  if (process.platform === "win32") return true;
  // An orphaned zombie cannot execute, even though kill(pid, 0) still succeeds.
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/" + id + "/stat", "utf8");
      return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0] !== "Z";
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }
  const result = spawnSync("ps", ["-o", "state=", "-p", String(id)], { encoding: "utf8", timeout: 1000 });
  if (result.error) throw result.error;
  return !result.stdout.trim().startsWith("Z");
}
async function killTree(id) {
  let deadline;
  if (launcher?.killTree) {
    deadline = Date.now() + 5000;
    let timer;
    try {
      await Promise.race([
        launcher.killTree(id),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("ACL child exit unconfirmed")), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } finally { clearTimeout(timer); }
  } else if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const killer = spawn("taskkill.exe", ["/PID", String(id), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", reject);
      killer.on("close", code => {
        if (code === 0 || childExited || !alive(id)) resolve();
        else reject(new Error("ACL child tree kill failed"));
      });
    });
  } else if (!childExited && alive(id)) {
    process.kill(id, "SIGKILL");
  }
  deadline ??= Date.now() + 5000;
  while (!childExited && alive(id)) {
    if (Date.now() >= deadline) throw new Error("ACL child exit unconfirmed");
    await delay(10);
  }
}
function drop() {
  if (dropping) return dropping;
  dropping = (async () => {
    Atomics.compareExchange(control, 0, 0, 1);
    // Do not terminate a worker between spawning its child and publishing the PID.
    const startupDeadline = Date.now() + 5000;
    while (!Atomics.load(control, 2) && !workerExited) {
      if (Date.now() >= startupDeadline) throw new Error("ACL child startup unconfirmed");
      await delay(10);
    }
    worker.postMessage({ stop: true });
    // Give EOF a bounded chance even if the ACL worker is stuck in a roundtrip.
    const deadline = Date.now() + 100;
    while (!childExited && Date.now() < deadline) await delay(10);
    const recorded = pid || Atomics.load(control, 1);
    if (recorded) await killTree(recorded);
    await worker.terminate();
    Atomics.store(state, 3, 0);
    Atomics.store(control, 0, 2);
    Atomics.notify(control, 0);
    // Wake a synchronous request only after teardown has finished.
    if (Atomics.load(state, 0) === 1) {
      Atomics.store(state, 0, 3);
      Atomics.notify(state, 0);
    }
  })().catch(() => {
    // Keep the singleton closed if death cannot be confirmed.
    Atomics.store(control, 0, 3);
    Atomics.notify(control, 0);
    Atomics.store(state, 0, 3);
    Atomics.notify(state, 0);
  });
  return dropping;
}
worker.on("message", message => {
  if (message.pid) pid = message.pid;
  if (message.childExited) childExited = true;
  if (message.broken) void drop();
});
worker.on("error", () => { void drop(); });
worker.on("exit", () => { workerExited = true; void drop(); });
while (Atomics.load(control, 0) === 0) {
  const waited = Atomics.waitAsync(control, 0, 0);
  if (waited.async) await waited.value;
}
await drop();
`;

type AclHelper = { worker: Worker; state: Int32Array; bytes: Buffer; control: Int32Array };
// control: [lifecycle (0 running, 1 dropping, 2 stopped, 3 unconfirmed), child PID, spawn settled].
let helper: AclHelper | undefined;

function dropHelper(): void {
  const current = helper;
  if (!current) return;
  Atomics.compareExchange(current.control, 0, 0, 1);
  Atomics.notify(current.control, 0);
  const deadline = Date.now() + 10_000;
  while (Atomics.load(current.control, 0) === 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("ACL helper teardown unconfirmed");
    Atomics.wait(current.control, 0, 1, remaining);
  }
  if (Atomics.load(current.control, 0) !== 2) throw new Error("ACL helper teardown failed");
  helper = undefined;
}

type AclCommand = { exe: string; args: string[]; launcherModule?: string; timeoutMs?: number };
let commandForTests: AclCommand | undefined;

/** Test seam. Production leaves this unset and uses powershell.exe. */
export function setWindowsAclExecutableForTests(command: AclCommand | undefined): void {
  dropHelper();
  commandForTests = command;
}

function ensureHelper(): AclHelper {
  if (helper && (Atomics.load(helper.state, 3) === 0 || Atomics.load(helper.control, 0) !== 0)) dropHelper();
  if (helper) return helper;
  const command = commandForTests ?? {
    exe: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
  };
  const sab = new SharedArrayBuffer(65536);
  const control = new Int32Array(new SharedArrayBuffer(12));
  const state = new Int32Array(sab);
  Atomics.store(state, 3, 1);
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(supervisorSource)}`), {
    workerData: { ...command, sab, control: control.buffer, source: `data:text/javascript,${encodeURIComponent(workerSource)}` },
  });
  worker.unref();
  // Supervisor failure is fail-closed: its shared state never permits replacement.
  worker.on("error", () => {});
  windowsAclHelperStartCount += 1;
  helper = { worker, state, bytes: Buffer.from(sab), control };
  return helper;
}

function askOnce(request: string): string {
  const current = ensureHelper();
  if (Atomics.load(current.state, 3) === 0) return "err helper exited";
  const encoded = Buffer.from(request);
  if (encoded.length > 60000) return "err rejected";
  encoded.copy(current.bytes, 16);
  Atomics.store(current.state, 1, encoded.length);
  Atomics.store(current.state, 0, 1);
  Atomics.notify(current.state, 0);
  const deadline = Date.now() + (commandForTests?.timeoutMs ?? 45_000);
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
  if (Atomics.load(current.state, 0) !== 2) {
    dropHelper();
    return wait === "timed-out" ? "err timeout" : "err helper exited";
  }
  const length = Atomics.load(current.state, 2);
  const reply = current.bytes.subarray(16, 16 + length).toString("utf8");
  Atomics.store(current.state, 0, 0);
  Atomics.notify(current.state, 0);
  if (Atomics.load(current.state, 3) === 0 || (reply !== "ok" && !/^err [^\r\n]+$/.test(reply))) {
    dropHelper();
    return "err helper exited";
  }
  return reply;
}

function askHelper(request: string): string {
  const reply = askOnce(request);
  if (reply === "err helper exited") dropHelper();
  return reply;
}

/** Drives the helper without a Windows ACL. The executable comes from setWindowsAclExecutableForTests. */
export function submitWindowsAclForTests(request: string): string {
  return askHelper(request);
}

let windowsAclHelperStartCount = 0;

export function windowsAclHelperStarts(): number {
  return windowsAclHelperStartCount;
}

/** One JSON line, no path: the desktop bench counts these calls. Quiet unless NEMA_DESKTOP_BENCH=1. */
export function recordWindowsAclBench(action: "protect" | "check", elapsedMs: number, write: (chunk: string) => void = (chunk) => { process.stdout.write(chunk); }): void {
  if (process.env.NEMA_DESKTOP_BENCH !== "1") return;
  write(`${JSON.stringify({ state: "windows-acl", action, ms: elapsedMs })}\n`);
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

export function protectPrivatePath(file: string, mode = 0o600): void {
  if (process.platform === "win32") windowsAcl(file, "protect");
  else chmodSync(file, mode);
}

/**
 * A private file is also this user's file. A mode-0600 file owned by someone else is not a credential we
 * should read or trust, so every private read checks ownership next to the mode bits.
 */
export function privateOwnerMatches(st: { uid?: number }, uid: number | null = process.getuid?.() ?? null): boolean {
  if (uid === null) return true; // no POSIX ownership on Windows
  return st.uid === undefined || st.uid === uid;
}

export function privateModeMatches(st: { mode: number }, platform: NodeJS.Platform = process.platform): boolean {
  // Windows callers must also use openPrivateFile, which checks the actual ACL.
  return platform === "win32" || (st.mode & 0o777) === 0o600;
}

/**
 * Verify the platform's real access control for a path on its own, without opening it.
 *
 * POSIX mode bits are checked by the callers directly; on Windows the synthetic mode bits carry no
 * meaning and the DACL is what decides, so anything that accepts a credential file *before* reading it
 * (a migration deciding whether a copy is private, a login it is about to trust) has to ask here.
 */
export function assertPrivateAcl(file: string): void {
  if (process.platform === "win32") windowsAcl(file, "check");
}

/** Refuse links on all platforms, and verify the Windows DACL and opened file identity. */
export function openPrivateFile(file: string): number {
  const before = lstatSync(file);
  if (before.isSymbolicLink()) throw Object.assign(new Error("Symbolic link refused"), { code: "ELOOP" });
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error("Private file changed while opening");
    if (process.platform === "win32") windowsAcl(file, "check");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * A private file, opened and *judged by its own descriptor*.
 *
 * `openPrivateFile` refuses a link, a non-regular file and a foreign Windows DACL, but it says nothing about
 * the POSIX mode bits or the owner. A credential this process is about to send somewhere has to pass those
 * too, and the stat that decides has to be taken from the descriptor that was opened: a path whose mode is
 * fixed between two stats would otherwise be read through the widened one.
 *
 * `expectedUid` exists so the ownership rule can be exercised by a test: a file owned by somebody else cannot
 * be produced without privilege on most hosts (and never on the Windows runner), and a test that silently
 * skips is no test at all. Production never passes it, so the rule it applies there is unchanged: the owner
 * of the opened file must be this process's user.
 */
export function openPrivateFileChecked(file: string, expectedUid: number | null = process.getuid?.() ?? null): number {
  const fd = openPrivateFile(file);
  try {
    const st = fstatSync(fd);
    if (!privateModeMatches(st) || !privateOwnerMatches(st, expectedUid)) {
      throw new Error(`${path.basename(file)} 不是私有文件（权限或属主不符），已拒绝读取。`);
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
