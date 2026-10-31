import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";

// Windows exposes synthetic POSIX modes. Enforce a private DACL instead of treating 0666 as 0600.
// Only .NET calls, no cmdlets: autoloading Get-Item/New-Object took ~22s per call under the managed core's
// filtered environment on a GitHub Windows runner, while this script runs in ~0.2s there.
export const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$file = $env:NEMA_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ([System.IO.Directory]::Exists($file)) { $item = [System.IO.DirectoryInfo]::new($file); $isDirectory = $true }
elseif ([System.IO.File]::Exists($file)) { $item = [System.IO.FileInfo]::new($file); $isDirectory = $false }
else { throw 'Path not found' }
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
if ($env:NEMA_PRIVATE_ACTION -eq 'protect') {
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
`;

function windowsAcl(file: string, action: "protect" | "check"): void {
  const exe = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT], {
    env: { ...process.env, NEMA_PRIVATE_PATH: path.resolve(file), NEMA_PRIVATE_ACTION: action },
    // A cold PowerShell on a busy Windows runner can take longer than a local call.
    stdio: "ignore", windowsHide: true, timeout: 45_000,
  });
  if (result.error || result.status !== 0) {
    const reason = (result.error as NodeJS.ErrnoException | undefined)?.code ?? (result.status === null ? "unknown" : `powershell exit ${result.status}`);
    throw new Error(`${path.basename(file)}: 无法验证私有 Windows ACL / cannot verify private Windows ACL (${reason})`);
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
