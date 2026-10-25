import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";

// Windows exposes synthetic POSIX modes. Enforce a private DACL instead of treating 0666 as 0600.
const ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$file = $env:NEMA_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $file -Force
if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused' }
if ($env:NEMA_PRIVATE_ACTION -eq 'protect') {
  if ($item.PSIsContainer) { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
  else { $acl = New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($principal)
    if ($item.PSIsContainer) {
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    } else {
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
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
  const result = spawnSync(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ACL_SCRIPT], {
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

export function privateModeMatches(st: { mode: number }, platform: NodeJS.Platform = process.platform): boolean {
  // Windows callers must also use openPrivateFile, which checks the actual ACL.
  return platform === "win32" || (st.mode & 0o777) === 0o600;
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
