import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractPortableZip, nsisSilentCommandLine, parseSmokeArgs } from './smoke-desktop.mjs';

test('the smoke takes either the Windows installer or the separate portable ZIP', () => {
  assert.equal(parseSmokeArgs(['--installer', 'dist/Nema-0.1.1-win32-x64.exe']).installer, path.resolve('dist/Nema-0.1.1-win32-x64.exe'));
  assert.equal(parseSmokeArgs(['--zip', 'dist/Nema-0.1.1-win32-x64.zip']).zip, path.resolve('dist/Nema-0.1.1-win32-x64.zip'));
  assert.match(parseSmokeArgs([]).installer, /Nema-.+-win32-x64\.exe$/);
  assert.equal(parseSmokeArgs([]).zip, undefined);
  assert.throws(() => parseSmokeArgs(['--zip']), /Usage/);
  assert.throws(() => parseSmokeArgs(['--installer']), /Usage/);
  assert.throws(() => parseSmokeArgs(['--installer', 'a.exe', '--zip', 'b.zip']), /Usage/);
});

test('NSIS gets /D= last and unquoted, even for a path with spaces and Japanese characters', () => {
  const dir = path.join('C:', 'Temp', 'Nema proof 東京', 'installed app with spaces');
  assert.equal(nsisSilentCommandLine(dir), `/S /D=${dir}`);
});

test('portable ZIP extraction lands in a non-ASCII directory', async (t) => {
  if (process.platform !== 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-smoke-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'Nema.exe'), 'fixture');
  const zip = path.join(root, 'app.zip');
  const packed = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', zip, '-C', source, 'Nema.exe'], { windowsHide: true });
  const code = await new Promise((resolve, reject) => {
    packed.once('error', reject);
    packed.once('exit', resolve);
  });
  assert.equal(code, 0);
  const installDir = path.join(root, 'Nema proof 東京', 'copied app resources with spaces');
  await extractPortableZip(zip, installDir);
  assert.equal(await readFile(path.join(installDir, 'Nema.exe'), 'utf8'), 'fixture');
});
