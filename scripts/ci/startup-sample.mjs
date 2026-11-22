import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const usage = 'usage: startup-sample.mjs [cold <dir> | warm <dir> | generate <seedDir> <archive> | preset <archive> <dir>]';
const root = fileURLToPath(new URL('../..', import.meta.url));

function command() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return { mode: 'parent' };
  if ((argv[0] === 'cold' || argv[0] === 'warm') && argv.length === 2) return { mode: argv[0], dir: argv[1] };
  if ((argv[0] === 'generate' || argv[0] === 'preset') && argv.length === 3) return { mode: argv[0], args: argv.slice(1) };
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

// #265: the same seed the desktop generator builds, from the source hub and its migrations.
async function generateSeed(seedDir, archive) {
  const { makePresetDb } = await import(pathToFileURL(join(root, 'scripts/desktop/make-preset-db.mjs')).href);
  const result = await makePresetDb({
    output: archive,
    workDir: seedDir,
    pgliteModule: join(root, 'apps/hub/src/db/pglite.ts'),
    migrationsDir: join(root, 'apps/hub/src/db/migrations'),
    stdout: { write() {} },
  });
  process.stdout.write(`${JSON.stringify({ archiveBytes: result.bytes, migrations: result.migrations })}\n`);
}

// #265 first run: land the seed with the runtime's own function, then open it as createLocalDb would. The clock
// starts before landing because a real first run pays for it; totalMs is landing + ready + migrate.
async function measurePreset(archive, dir) {
  const { seedPresetDb } = await import(pathToFileURL(join(root, 'apps/local/src/presetDb.ts')).href);
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import(pathToFileURL(join(root, 'apps/hub/src/db/db.ts')).href);
  const startedAt = new Date();
  const started = performance.now();
  const seeded = await seedPresetDb(archive, dir);
  if (!seeded.seeded) throw new Error(`preset seed did not land: ${seeded.reason}`);
  const landed = performance.now();
  const client = new PGlite(dir);
  await client.waitReady;
  const ready = performance.now();
  await migrate(wrap(client));
  const migrated = performance.now();
  // Outside the timed span: migrate stamps applied_at with now(), so a non-zero count means the seed was stale.
  const appliedOnOpen = Number((await client.query('select count(*)::int as n from schema_migrations where applied_at >= $1', [startedAt])).rows[0].n);
  await client.close();
  process.stdout.write(`${JSON.stringify({
    landingMs: Math.round(landed - started),
    readyMs: Math.round(ready - landed),
    migrateMs: Math.round(migrated - ready),
    totalMs: Math.round(migrated - started),
    appliedOnOpen,
  })}\n`);
}

// Spec D-2 form B, for the form comparison only: the same seed content landed by copying the loose tree to a
// sibling and renaming it into place. One landing per run.
async function copyLanding(seedDir, dir) {
  const staging = `${dir}.copy-tmp`;
  const started = performance.now();
  await cp(seedDir, staging, { recursive: true, errorOnExist: true, force: false });
  renameSync(staging, dir);
  return Math.round(performance.now() - started);
}

function runChild(mode, ...args) {
  const run = spawnSync(process.execPath, [
    '--conditions=development',
    '--import', 'tsx',
    fileURLToPath(import.meta.url),
    mode,
    ...args,
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
    const seedDir = join(temp, 'seed');
    const archive = join(temp, 'preset-db.tar.gz');
    const generated = runChild('generate', seedDir, archive);
    const presetHome = join(temp, 'preset-home');
    mkdirSync(presetHome);
    const preset = runChild('preset', archive, join(presetHome, 'db'));
    const copyHome = join(temp, 'copy-home');
    mkdirSync(copyHome);
    const copyLandingMs = await copyLanding(seedDir, join(copyHome, 'db'));
    const windowsAcl = process.platform === 'win32' ? await windowsAclSample(temp) : null;
    process.stdout.write(`${JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cold,
      warm,
      preset: { ...preset, copyLandingMs, archiveBytes: generated.archiveBytes },
      windowsAcl,
    })}\n`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const parsed = command();
if (parsed.mode === 'parent') await parent();
else if (parsed.mode === 'generate') await generateSeed(...parsed.args);
else if (parsed.mode === 'preset') await measurePreset(...parsed.args);
else await measureDir(parsed.dir);
