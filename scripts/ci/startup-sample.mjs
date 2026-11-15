import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const usage = 'usage: startup-sample.mjs [cold <dir> | warm <dir>]';
const root = fileURLToPath(new URL('../..', import.meta.url));

function command() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return { mode: 'parent' };
  if ((argv[0] === 'cold' || argv[0] === 'warm') && argv.length === 2) return { mode: argv[0], dir: argv[1] };
  process.stderr.write(`${usage}\n`);
  process.exit(1);
}

function wrap(client) {
  return {
    async query(sql, params) {
      if (!params || params.length === 0) {
        const res = await client.exec(sql);
        return res[res.length - 1]?.rows ?? [];
      }
      return (await client.query(sql, params)).rows;
    },
    async tx(fn) {
      return client.transaction((tx) => fn(wrap(tx)));
    },
  };
}

async function measureDir(dir) {
  mkdirSync(dir, { recursive: true });
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import(pathToFileURL(join(root, 'apps/hub/src/db/db.ts')).href);
  const started = performance.now();
  const client = new PGlite(dir);
  await client.waitReady;
  const ready = performance.now();
  await migrate(wrap(client));
  const migrated = performance.now();
  await client.close();
  process.stdout.write(`${JSON.stringify({
    readyMs: Math.round(ready - started),
    migrateMs: Math.round(migrated - ready),
    totalMs: Math.round(migrated - started),
  })}\n`);
}

function runChild(mode, dir) {
  const run = spawnSync(process.execPath, [
    '--conditions=development',
    '--import', 'tsx',
    fileURLToPath(import.meta.url),
    mode,
    dir,
  ], { encoding: 'utf8', cwd: root });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || `${mode} sample failed`);
  const line = run.stdout.trim().split(/\r?\n/).filter((item) => item.startsWith('{')).at(-1);
  if (!line) throw new Error(`${mode} sample printed no JSON\n${run.stdout}`);
  return JSON.parse(line);
}

async function windowsAclSample(dir) {
  // Loaded only on Windows, after argument checks. The module is TypeScript, so a plain
  // `node scripts/ci/startup-sample.mjs --bad` must be able to reject the argument first.
  const { protectPrivatePath, openPrivateFile, windowsAclHelperStarts } = await import('@nema/cli/secrets/permissions');
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let emptyMs = 0;
  for (let index = 0; index < 8; index += 1) {
    const started = performance.now();
    const result = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('powershell.exe exit 0 failed');
    emptyMs += performance.now() - started;
  }
  const before = windowsAclHelperStarts();
  let helperMs = 0;
  const aclDir = join(dir, 'acl');
  mkdirSync(aclDir, { recursive: true });
  for (let index = 0; index < 4; index += 1) {
    const file = join(aclDir, `file-${index}`);
    writeFileSync(file, 'placeholder', { mode: 0o600 });
    let started = performance.now();
    protectPrivatePath(file);
    helperMs += performance.now() - started;
    started = performance.now();
    closeSync(openPrivateFile(file));
    helperMs += performance.now() - started;
  }
  return {
    emptyProcess: { count: 8, totalMs: Math.round(emptyMs) },
    helperCalls: { count: 8, totalMs: Math.round(helperMs), starts: windowsAclHelperStarts() - before },
  };
}

async function parent() {
  const temp = await mkdtemp(join(tmpdir(), 'nema-startup-sample-'));
  try {
    const dir = join(temp, 'db');
    const cold = runChild('cold', dir);
    const warm = runChild('warm', dir);
    const windowsAcl = process.platform === 'win32' ? await windowsAclSample(temp) : null;
    process.stdout.write(`${JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cold,
      warm,
      windowsAcl,
    })}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const parsed = command();
if (parsed.mode === 'parent') await parent();
else await measureDir(parsed.dir);
