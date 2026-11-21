import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Sampling carrier for #186 W4: platform jobs otherwise never produce the core's
// startup-phase lines, so this script starts one local runtime in-process from fake
// assets (the runtime.test.ts testAssets() recipe) and lets the phase lines land on
// stdout verbatim, where the job log keeps them. Each line's ms is cumulative since
// startup began; segment durations are differences between adjacent phases. This
// carrier only measures — it changes no startup order and no validation path.

const usage = 'usage: startup-phase-sample.mjs [run]';
const root = fileURLToPath(new URL('../..', import.meta.url));

function command() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return { mode: 'parent' };
  if (argv[0] === 'run' && argv.length === 1) return { mode: 'run' };
  process.stderr.write(`${usage}\n`);
  process.exit(1);
}

function buildFakeAssets(assets) {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const node = join(assets, 'node', nodeName);
  mkdirSync(dirname(node), { recursive: true });
  copyFileSync(process.execPath, node);
  let ownedHelperGuardian;
  if (process.platform === 'win32') {
    // startLocalRuntime refuses a Windows payload without its helper guardian, so
    // build it first, exactly as runtime.test.ts builds its guardian fixture.
    ownedHelperGuardian = 'runtime/owned-helper.exe';
    const guardianPath = join(assets, ownedHelperGuardian);
    mkdirSync(dirname(guardianPath), { recursive: true });
    execFileSync(process.execPath, [join(root, 'scripts/desktop/build-owned-helper.mjs'), '--output', guardianPath], { stdio: 'inherit', cwd: root });
  }
  mkdirSync(join(assets, 'licenses'), { recursive: true });
  cpSync(join(root, 'apps/local/test/fixtures'), join(assets, 'fixtures'), { recursive: true });
  writeFileSync(join(assets, 'runtime-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    version: 'test-version',
    platform: process.platform,
    arch: process.arch,
    node: `node/${nodeName}`,
    coreEntry: 'fixtures/core-child.mjs',
    cliEntry: 'fixtures/fake-cli.mjs',
    webEntry: 'fixtures/fake-web.mjs',
    licenses: 'licenses',
    ...(ownedHelperGuardian ? { ownedHelperGuardian } : {}),
  }));
  return assets;
}

async function runSample() {
  const temp = await mkdtemp(join(tmpdir(), 'nema-startup-phase-sample-'));
  try {
    const assetsDir = buildFakeAssets(join(temp, 'assets'));
    const home = join(temp, 'home');
    mkdirSync(home, { recursive: true });
    // Keep the sample hermetic: the settings service reads the Codex home.
    process.env.CODEX_HOME = join(home, 'codex-home');
    const { startLocalRuntime } = await import(pathToFileURL(join(root, 'apps/local/src/runtime.ts')).href);
    const runtime = await startLocalRuntime({ home, assetsDir });
    await runtime.close();
  } finally {
    // A cleanup failure must not fail an otherwise complete sample.
    await rm(temp, { recursive: true, force: true }).catch((error) => {
      process.stderr.write(`startup phase sample cleanup failed: ${error}\n`);
    });
  }
}

function runChild() {
  const run = spawnSync(process.execPath, [
    '--conditions=development',
    '--import', 'tsx',
    fileURLToPath(import.meta.url),
    'run',
  ], { encoding: 'utf8', cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || 'startup phase sample failed');
  const lines = run.stdout.split(/\r?\n/).filter((line) => {
    if (!line.startsWith('{')) return false;
    try {
      return JSON.parse(line).state === 'startup-phase';
    } catch {
      return false;
    }
  });
  if (lines.length === 0) throw new Error(`startup phase sample printed no startup-phase lines\n${run.stdout}`);
  return lines;
}

function parent() {
  for (const line of runChild()) process.stdout.write(`${line}\n`);
}

const parsed = command();
if (parsed.mode === 'parent') {
  parent();
} else {
  const watchdog = setTimeout(() => {
    process.stderr.write('startup phase sample timed out\n');
    process.exit(1);
  }, 180_000);
  try {
    await runSample();
  } finally {
    clearTimeout(watchdog);
  }
  // Flush buffered stdout before exiting so the parent captures every phase line,
  // and exit explicitly: a closed runtime can leave handles that would linger.
  await new Promise((resolvePromise) => { process.stdout.write('', () => resolvePromise()); });
  process.exit(0);
}
