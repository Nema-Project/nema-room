import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { builderConfig } from './make.mjs';

const afterPack = createRequire(import.meta.url)('./after-pack.cjs');

async function tree(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-after-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'resources', 'payload', 'runtime', 'licenses', 'electron', 'LICENSES.chromium.html');
  const extra = path.join(root, 'Frameworks', 'Electron Framework.framework', 'Libraries', 'LICENSES.chromium.html');
  await mkdir(path.dirname(payload), { recursive: true });
  await mkdir(path.dirname(extra), { recursive: true });
  await writeFile(payload, 'ffmpeg LGPL v2.1 payload');
  await writeFile(extra, 'ffmpeg LGPL v2.1 framework');
  return { root, payload, extra };
}

test('afterPack deletes extra Chromium notices and keeps the payload copy', async (t) => {
  const { root, payload, extra } = await tree(t);
  const link = path.join(root, 'LICENSES.chromium.html');
  await symlink(extra, link);
  await afterPack({ appOutDir: root });
  assert.equal(await readFile(payload, 'utf8'), 'ffmpeg LGPL v2.1 payload');
  await assert.rejects(lstat(extra));
  await assert.rejects(lstat(link));
});

test('afterPack keeps every notice when the payload copy is missing', async (t) => {
  const { root, payload, extra } = await tree(t);
  await rm(payload);
  await assert.rejects(afterPack({ appOutDir: root }), /payload copy is missing/);
  assert.equal(await readFile(extra, 'utf8'), 'ffmpeg LGPL v2.1 framework');
});

test('desktop builder config points afterPack at the notice trimmer', () => {
  const config = builderConfig('/payload', '/out', { platform: 'darwin', arch: 'arm64' });
  assert.match(config.afterPack, /after-pack\.cjs$/);
});
