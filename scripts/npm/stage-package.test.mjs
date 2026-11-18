import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setupCommand } from '../setup.mjs';
import { derivePublishManifest, stagePackage } from './stage-package.mjs';

const cliPackage = {
  name: '@nema/cli',
  license: 'MIT',
  version: '0.1.3',
  private: true,
  type: 'module',
  bin: { nema: 'dist/index.js' },
  files: ['dist', 'src/report/SKILL.md'],
  exports: { './config': { import: './dist/config.js' } },
  dependencies: {
    '@modelcontextprotocol/sdk': '^1.32.1',
    '@nema/shared': '*',
    commander: '^15.0.0',
    'smol-toml': '^1.9.1',
    ws: '^8.22.0',
    zod: '^4.6.7',
  },
};

const LOCK_FIXTURE = '{"fixture":"graphify lock"}\n';

async function writeLock(root) {
  await mkdir(path.join(root, 'scripts/desktop'), { recursive: true });
  await writeFile(path.join(root, 'scripts/desktop/graphify-lock.json'), LOCK_FIXTURE);
}

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nema-stage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('publish manifest is the scoped nema app, not the private workspace package', () => {
  const manifest = derivePublishManifest(cliPackage);
  assert.equal(manifest.name, '@nema-project/nema');
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.bin, { nema: 'dist/index.js' });
  assert.equal(manifest.engines.node, '>=22');
  assert.match(JSON.stringify(manifest.repository), /https:\/\/github\.com\/Nema-Project\/nema-room/);
  assert.equal(Object.hasOwn(manifest, 'exports'), false);
  assert.equal(manifest.version, '0.1.3');
  assert.equal(manifest.dependencies['@nema/shared'], undefined);
  assert.equal(manifest.dependencies.commander, '^15.0.0');
  assert.equal(manifest.dependencies.zod, '^4.6.7');
});

test('an internal dependency other than the bundled shared package is rejected', () => {
  assert.throws(() => derivePublishManifest({ ...cliPackage, dependencies: { ...cliPackage.dependencies, '@nema/hub': '*' } }), /@nema\/hub/);
});

test('stage copies the runtime files and packs a tarball', async (t) => {
  const root = await temp(t);
  const cliDir = path.join(root, 'apps/cli');
  await mkdir(path.join(cliDir, 'dist'), { recursive: true });
  await mkdir(path.join(cliDir, 'src/report'), { recursive: true });
  await writeFile(path.join(cliDir, 'package.json'), JSON.stringify(cliPackage));
  await writeFile(path.join(cliDir, 'dist/index.js'), 'export const bin = true;\n');
  await writeFile(path.join(cliDir, 'src/report/SKILL.md'), '# skill\n');
  await writeFile(path.join(root, 'LICENSE'), 'MIT\n');
  await writeLock(root);
  const outDir = path.join(root, 'dist-npm');
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir });
  const manifest = JSON.parse(await readFile(path.join(staged.dir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@nema-project/nema');
  assert.equal(path.basename(staged.tarball), 'nema-project-nema-0.1.3.tgz');
  assert.equal(Object.hasOwn(manifest, 'exports'), false);
  assert.equal(manifest.dependencies['@nema/shared'], undefined);
  assert.equal(existsSync(path.join(staged.dir, 'dist/index.js')), true);
  assert.equal(existsSync(path.join(staged.dir, 'src/report/SKILL.md')), true);
  assert.equal(existsSync(path.join(staged.dir, 'LICENSE')), true);
  assert.equal(existsSync(path.join(staged.dir, 'vendor')), false);
  assert.equal(await readFile(path.join(staged.dir, 'dist/resources/graphify-lock.json'), 'utf8'), LOCK_FIXTURE);
  const packed = spawnSync('tar', ['-tzf', staged.tarball], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  assert.match(packed.stdout, /^package\/dist\/resources\/graphify-lock\.json$/m);
});

test('stage replaces a stale lock left in the CLI build with the repository lock', async (t) => {
  const root = await temp(t);
  const cliDir = path.join(root, 'apps/cli');
  await mkdir(path.join(cliDir, 'dist/resources'), { recursive: true });
  await mkdir(path.join(cliDir, 'src/report'), { recursive: true });
  await writeFile(path.join(cliDir, 'package.json'), JSON.stringify(cliPackage));
  await writeFile(path.join(cliDir, 'dist/index.js'), 'export {};\n');
  await writeFile(path.join(cliDir, 'dist/resources/graphify-lock.json'), '{"stale":true}\n');
  await writeFile(path.join(cliDir, 'src/report/SKILL.md'), '# skill\n');
  await writeFile(path.join(root, 'LICENSE'), 'MIT\n');
  await writeLock(root);
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'out') });
  assert.equal(await readFile(path.join(staged.dir, 'dist/resources/graphify-lock.json'), 'utf8'), LOCK_FIXTURE);
});

test('CLI runtime does not ship vendored files', async (t) => {
  // apps/cli/src has no vendor/ reference and does not build a runtime path into vendor/.
  const root = await temp(t);
  const cliDir = path.join(root, 'apps/cli');
  await mkdir(path.join(cliDir, 'dist'), { recursive: true });
  await mkdir(path.join(cliDir, 'src/report'), { recursive: true });
  await mkdir(path.join(root, 'vendor/archify'), { recursive: true });
  await writeFile(path.join(cliDir, 'package.json'), JSON.stringify(cliPackage));
  await writeFile(path.join(cliDir, 'dist/index.js'), 'export {};\n');
  await writeFile(path.join(cliDir, 'src/report/SKILL.md'), '# skill\n');
  await writeFile(path.join(root, 'LICENSE'), 'MIT\n');
  await writeLock(root);
  await writeFile(path.join(root, 'vendor/archify/LICENSE'), 'upstream\n');
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'out') });
  assert.equal(existsSync(path.join(staged.dir, 'vendor')), false);
  const packed = spawnSync('tar', ['-tzf', staged.tarball], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  assert.equal(packed.stdout.includes('vendor/'), false);
  // The lock is a KB-sized index of upstream archives; no runtime, interpreter or Graphify payload ships.
  const shipped = packed.stdout.split('\n').filter((line) => line !== 'package/dist/resources/graphify-lock.json').join('\n');
  assert.equal(/node(?:\.exe)?$|python|graphify/m.test(shipped), false);
  const info = await stat(staged.tarball);
  assert.ok(info.size > 0);
  assert.match(staged.sizeLine, new RegExp(`npm package size: ${info.size}`));
});

test('npm install exposes the nema bin and npx runs the scoped package', async (t) => {
  const root = await temp(t);
  const cliDir = path.join(root, 'apps/cli');
  await mkdir(path.join(cliDir, 'dist'), { recursive: true });
  await mkdir(path.join(cliDir, 'src/report'), { recursive: true });
  await writeFile(path.join(cliDir, 'package.json'), JSON.stringify({ ...cliPackage, dependencies: {} }));
  await writeFile(path.join(cliDir, 'dist/index.js'), '#!/usr/bin/env node\nprocess.stdout.write("nema-bin-ok\\n");\n');
  await writeFile(path.join(cliDir, 'src/report/SKILL.md'), '# skill\n');
  await writeFile(path.join(root, 'LICENSE'), 'MIT\n');
  await writeLock(root);
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'dist-npm') });
  assert.equal(path.basename(staged.tarball), 'nema-project-nema-0.1.3.tgz');
  const installDir = path.join(root, 'install');
  await mkdir(installDir);
  const packedName = path.basename(staged.tarball);
  await copyFile(staged.tarball, path.join(installDir, packedName));
  const npm = setupCommand('npm', ['install', '--ignore-scripts', '--no-fund', '--no-audit', `./${packedName}`]);
  const installed = spawnSync(npm.bin, npm.args, { cwd: installDir, encoding: 'utf8' });
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const binName = process.platform === 'win32' ? 'nema.cmd' : 'nema';
  const bin = path.join(installDir, 'node_modules', '.bin', binName);
  const ran = spawnSync(bin, [], { cwd: installDir, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(ran.status, 0, ran.stderr || ran.stdout);
  assert.equal(ran.stdout.trim(), 'nema-bin-ok');
  assert.equal(existsSync(path.join(installDir, 'node_modules', '@nema-project', 'nema', 'package.json')), true);
  const exec = setupCommand('npm', ['exec', '--offline', '--no-fund', '--no-audit', '--', '@nema-project/nema']);
  const viaNpx = spawnSync(exec.bin, exec.args, { cwd: installDir, encoding: 'utf8' });
  assert.equal(viaNpx.status, 0, viaNpx.stderr || viaNpx.stdout);
  assert.match(viaNpx.stdout, /nema-bin-ok/);
});

async function fakeCli(root) {
  const cliDir = path.join(root, 'apps/cli');
  await mkdir(path.join(cliDir, 'dist/components'), { recursive: true });
  await mkdir(path.join(cliDir, 'src/report'), { recursive: true });
  await writeFile(path.join(cliDir, 'package.json'), JSON.stringify(cliPackage));
  await writeFile(path.join(cliDir, 'dist/index.js'), 'export {};\n');
  for (const name of ['install', 'lock', 'download', 'store', 'pack', 'componentsCommands']) await writeFile(path.join(cliDir, `dist/components/${name}.js`), 'export {};\n');
  await writeFile(path.join(cliDir, 'src/report/SKILL.md'), '# skill\n');
  await writeFile(path.join(root, 'LICENSE'), 'MIT\n');
  await writeLock(root);
  return cliDir;
}

const fakeLauncher = (size = 4096) => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(size - 2, 0x90)]);

test('the npm package carries the lock, the installer and the Windows launcher, and nothing large', async (t) => {
  const root = await temp(t);
  const cliDir = await fakeCli(root);
  const launcher = path.join(root, 'graphify-launcher.exe');
  await writeFile(launcher, fakeLauncher());
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'out'), windowsLauncher: launcher, requireWindowsLauncher: true });
  assert.deepEqual(await readFile(path.join(staged.dir, 'dist/resources/graphify-launcher.exe')), fakeLauncher());
  assert.equal(staged.windowsLauncherBytes, 4096);
  const listed = spawnSync('tar', ['-tzf', staged.tarball], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const names = listed.stdout.trim().split('\n');
  for (const name of ['package/dist/resources/graphify-lock.json', 'package/dist/resources/graphify-launcher.exe', 'package/dist/components/install.js', 'package/dist/components/lock.js', 'package/dist/components/pack.js', 'package/dist/components/componentsCommands.js']) {
    assert.ok(names.includes(name), name);
  }
  // Only the lock and the launcher are Graphify resources; no runtime, interpreter or wheel ships.
  assert.deepEqual(names.filter((name) => /graphify|python|\.whl$|\.tar\.gz$/.test(name)).sort(), ['package/dist/resources/graphify-launcher.exe', 'package/dist/resources/graphify-lock.json']);
  // Nothing large: every staged file (what npm pack read) stays KB-scale.
  const sizes = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else sizes.push([path.relative(staged.dir, file), (await stat(file)).size]);
    }
  };
  await walk(staged.dir);
  for (const [name, size] of sizes) assert.ok(size < 1024 * 1024, `${name} is ${size} bytes`);
});

test('the launcher can be compiled during the stage and the scratch copy is removed', async (t) => {
  const root = await temp(t);
  const cliDir = await fakeCli(root);
  const outDir = path.join(root, 'out');
  const calls = [];
  const buildWindowsLauncher = async ({ sourceRoot, output }) => {
    calls.push(sourceRoot);
    await writeFile(output, fakeLauncher(2048));
  };
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir, windowsLauncher: 'build', requireWindowsLauncher: true, buildWindowsLauncher });
  assert.deepEqual(calls, [root]);
  assert.equal((await stat(path.join(staged.dir, 'dist/resources/graphify-launcher.exe'))).size, 2048);
  assert.equal(existsSync(path.join(outDir, 'graphify-launcher.exe')), false);
});

test('a release pack without the launcher fails; a dev pack leaves it out, never shipping a stale copy', async (t) => {
  const root = await temp(t);
  const cliDir = await fakeCli(root);
  await mkdir(path.join(cliDir, 'dist/resources'), { recursive: true });
  await writeFile(path.join(cliDir, 'dist/resources/graphify-launcher.exe'), fakeLauncher());
  await assert.rejects(
    stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'out'), requireWindowsLauncher: true }),
    /needs the Windows Graphify launcher/,
  );
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'out') });
  assert.equal(existsSync(path.join(staged.dir, 'dist/resources/graphify-launcher.exe')), false);
  assert.equal(staged.windowsLauncherBytes, 0);
});

test('a launcher that is not a small Windows executable is refused', async (t) => {
  const root = await temp(t);
  const cliDir = await fakeCli(root);
  const notPe = path.join(root, 'not-pe.exe');
  await writeFile(notPe, '#!/bin/sh\necho hi\n');
  await assert.rejects(stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'out'), windowsLauncher: notPe }), /not a Windows executable/);
  const huge = path.join(root, 'huge.exe');
  await writeFile(huge, fakeLauncher(2 * 1024 * 1024));
  await assert.rejects(stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir: path.join(root, 'out'), windowsLauncher: huge }), /expected a KB-scale binary/);
});
