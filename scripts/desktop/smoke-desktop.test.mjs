import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractPortableZip } from './smoke-desktop.mjs';

test('portable ZIP extraction lands in a non-ASCII directory', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-smoke-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'payload.txt'), 'fixture');
  const zip = path.join(root, 'app.zip');
  const packed = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', source, 'payload.txt'], { windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    packed.once('error', reject);
    packed.once('exit', resolve);
  });
  assert.equal(code, 0);
  const installDir = path.join(root, 'Nema proof 東京', 'copied app resources with spaces');
  await extractPortableZip(zip, installDir);
  assert.equal(await readFile(path.join(installDir, 'payload.txt'), 'utf8'), 'fixture');
});
