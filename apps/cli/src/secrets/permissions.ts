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
const bytes = Buffer.from(workerData.sab);
const child = spawn(workerData.exe, workerData.args, {
  stdio: ["pipe", "pipe", "ignore"],
  windowsHide: true,
  env: process.env,
});
parentPort?.on("close", () => child.kill());
let pending = "";
const waiters = [];
let childGone = false;
function noteChildGone() {
  if (childGone) return;
  childGone = true;
  Atomics.store(state, 3, 0);
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
child.on("exit", noteChildGone);
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

type AclHelper = { worker: Worker; state: Int32Array; bytes: Buffer };

let helper: AclHelper | undefined;

function dropHelper(): void {
  const current = helper;
  helper = undefined;
  void current?.worker.terminate();
}

type AclCommand = { exe: string; args: string[] };

let commandForTests: AclCommand | undefined;

/** Test seam. Production leaves this unset and uses powershell.exe. */
export function setWindowsAclExecutableForTests(command: AclCommand | undefined): void {
  dropHelper();
  commandForTests = command;
}

function ensureHelper(): AclHelper {
  if (helper && Atomics.load(helper.state, 3) === 0) dropHelper();
  if (helper) return helper;
  const command = commandForTests ?? {
    exe: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT],
  };
  const sab = new SharedArrayBuffer(65536);
  const state = new Int32Array(sab);
  Atomics.store(state, 3, 1);
  // data: URL is an ES module on every Node 22. eval:true was a classic script before 22.7, so import failed there.
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(workerSource)}`), {
    workerData: {
      exe: command.exe,
      sab,
      args: command.args,
    },
  });
  worker.unref();
  worker.on("error", () => {
    if (helper?.worker === worker) dropHelper();
  });
  worker.on("exit", () => {
    if (helper?.worker === worker) helper = undefined;
  });
  windowsAclHelperStartCount += 1;
  helper = { worker, state, bytes: Buffer.from(sab) };
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
  const deadline = Date.now() + 45_000;
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
  if (Atomics.load(current.state, 3) === 0) dropHelper();
  return reply;
}

function askHelper(request: string): string {
  const first = askOnce(request);
  if (first !== "err helper exited") return first;
  dropHelper();
  return askOnce(request);
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
