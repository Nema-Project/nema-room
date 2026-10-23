import { spawnSync } from "node:child_process";
import { closeSync, statSync, chmodSync } from "node:fs";
import { expect } from "vitest";
import { openPrivateFile } from "../src/secrets/permissions.js";

/** Exercise native privacy rather than Windows' synthetic POSIX mode bits. */
export function expectPrivate(file: string, mode = 0o600): void {
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(mode);
  } else if (statSync(file).isFile()) {
    closeSync(openPrivateFile(file));
  } else {
    const script = `
$acl = Get-Acl -LiteralPath $env:NEMA_TEST_PRIVATE_PATH
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 1 }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and @($sid, 'S-1-5-18', 'S-1-5-32-544') -notcontains $rule.IdentityReference.Value) { exit 2 }
}
`;
    expect(spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, NEMA_TEST_PRIVATE_PATH: file }, windowsHide: true,
    }).status).toBe(0);
  }
}

export function makePublic(file: string): void {
  if (process.platform === "win32") {
    expect(spawnSync("icacls.exe", [file, "/grant", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" }).status).toBe(0);
  } else chmodSync(file, 0o644);
}
