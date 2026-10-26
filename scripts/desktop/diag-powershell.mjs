// Temporary diagnostic (PR #8): time the private-ACL PowerShell call on a Windows runner under the same
// environment and process chain as the managed local core. Delete once the smoke timeout is understood.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $item = Get-Item -LiteralPath $env:NEMA_PRIVATE_PATH -Force; $null = $item.GetAccessControl(); 'ok'";

function timeAcl(env, label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acl-'));
  const started = Date.now();
  const result = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, NEMA_PRIVATE_PATH: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 90_000,
  });
  return `${label.padEnd(34)} ${String(Date.now() - started).padStart(6)}ms status=${result.status} ${result.error?.code ?? ''} ${(result.stderr?.toString() ?? '').trim().slice(0, 200)}`;
}

if (process.argv[2] === '--child') {
  // Runs as the detached "core": same filtered env, measures from inside.
  const lines = [timeAcl(process.env, 'detached child, inherited env'), timeAcl(process.env, 'detached child, second call')];
  writeFileSync(process.argv[3], `${lines.join('\n')}\n`);
  process.exit(0);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'Nema proof 東京-'));
const sys32 = path.join(process.env.SystemRoot, 'System32');
// Smoke env -> Electron -> childEnvironment() keeps only these keys.
const coreEnv = { PATH: `C:\\Program Files\\Git\\cmd;${sys32}`, SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: tempRoot, TMP: tempRoot, HOME: tempRoot, LANG: 'en_US.UTF-8' };

console.log(timeAcl(process.env, 'full env, cold'));
console.log(timeAcl(process.env, 'full env, warm'));
console.log(timeAcl(coreEnv, 'core env'));
console.log(timeAcl({ ...coreEnv, USERPROFILE: process.env.USERPROFILE }, 'core env + real USERPROFILE'));
console.log(timeAcl({ ...coreEnv, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA }, 'core env + APPDATA/LOCALAPPDATA'));
console.log(timeAcl({ ...coreEnv, PSModulePath: process.env.PSModulePath ?? '' }, 'core env + PSModulePath'));
console.log(timeAcl({ ...coreEnv, PSModulePath: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }, 'core env + system-only PSModulePath'));
console.log(timeAcl({ ...coreEnv, SystemDrive: process.env.SystemDrive, ProgramData: process.env.ProgramData, ProgramFiles: process.env.ProgramFiles }, 'core env + SystemDrive/ProgramData/PF'));

for (const detached of [true, false]) {
  const out = path.join(tempRoot, `child-${detached}.txt`);
  const started = Date.now();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', out], {
    detached, env: coreEnv, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
  });
  await new Promise((resolve) => child.once('exit', resolve));
  console.log(`--- ${detached ? 'detached' : 'attached'} node child (core env), total ${Date.now() - started}ms`);
  process.stdout.write(readFileSync(out, 'utf8'));
}
