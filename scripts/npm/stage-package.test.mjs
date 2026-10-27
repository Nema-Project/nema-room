import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nema-stage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('publish manifest is the nema app, not the private workspace package', () => {
  const manifest = derivePublishManifest(cliPackage);
  assert.equal(manifest.name, 'nema');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.bin.nema, 'dist/index.js');
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
  const outDir = path.join(root, 'dist-npm');
  const staged = await stagePackage({ root, cliDir, licensePath: path.join(root, 'LICENSE'), outDir });
  const manifest = JSON.parse(await readFile(path.join(staged.dir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'nema');
  assert.equal(Object.hasOwn(manifest, 'exports'), false);
  assert.equal(manifest.dependencies['@nema/shared'], undefined);
  assert.equal(existsSync(path.join(staged.dir, 'dist/index.js')), true);
  assert.equal(existsSync(path.join(staged.dir, 'src/report/SKILL.md')), true);
  assert.equal(existsSync(path.join(staged.dir, 'LICENSE')), true);
  assert.equal(existsSync(path.join(staged.dir, 'vendor')), false);
  const info = await stat(staged.tarball);
  assert.ok(info.size > 0);
  assert.match(staged.sizeLine, new RegExp(`npm package size: ${info.size}`));
});
