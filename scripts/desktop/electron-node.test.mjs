import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertElectronNodeEngines, readElectronNodeVersion } from './electron-node.mjs';

test('Electron Node must meet the engines.node major floor', () => {
  assert.throws(() => assertElectronNodeEngines('21.7.0', '>=22'), /does not satisfy/);
  assert.throws(() => assertElectronNodeEngines('not-a-version', '>=22'), /does not satisfy/);
  assert.doesNotThrow(() => assertElectronNodeEngines('22.0.0', '>=22'));
  assert.doesNotThrow(() => assertElectronNodeEngines('24.22.1', '>=22'));
  assert.throws(() => assertElectronNodeEngines('24.22.1', '>=22.0.0'), /Unsupported engines.node/);
});

test('the staging probe reads Node from the Electron binary', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-electron-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'apps/desktop'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/electron/dist'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ engines: { node: '>=22' } }));
  await writeFile(path.join(root, 'apps/desktop/package.json'), JSON.stringify({ devDependencies: { electron: '45.1.0' } }));
  const name = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  await writeFile(path.join(root, 'node_modules/electron/path.txt'), `${name}\n`);
  const binary = path.join(root, 'node_modules/electron/dist', name);
  const script = (version) => process.platform === 'win32'
    ? `@echo off\r\n<nul set /p=${version}\r\n`
    : `#!/bin/sh\nprintf %s "${version}"\n`;
  await writeFile(binary, script('24.22.1'));
  if (process.platform !== 'win32') await chmod(binary, 0o755);
  assert.deepEqual(await readElectronNodeVersion(root), {
    source: 'electron',
    electronVersion: '45.1.0',
    version: '24.22.1',
    engines: '>=22',
    license: 'runtime/licenses/node',
    invocation: 'ELECTRON_RUN_AS_NODE=1',
  });
  await writeFile(binary, script('21.0.0'));
  if (process.platform !== 'win32') await chmod(binary, 0o755);
  await assert.rejects(readElectronNodeVersion(root), /does not satisfy/);
});
