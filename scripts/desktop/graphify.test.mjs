import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchGraphify, graphifyLock, materializeSymlinks, POSIX_GRAPHIFY_LAUNCHER } from './fetch-graphify.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

test('graphify lock pins the release targets and no install path', async () => {
  const raw = await readFile(path.join(scriptDir, 'graphify-lock.json'), 'utf8');
  assert.equal(raw.includes('Users'), false);
  assert.equal(raw.includes('AppData'), false);
  assert.equal(graphifyLock.graphifyy, '0.9.95');
  assert.equal(graphifyLock.python, '3.11.17');
  assert.equal(graphifyLock.extras.length, 0);
  assert.equal(graphifyLock.sourceCorrespondence.status, 'pending-task-7c');
  for (const key of ['win32-x64', 'darwin-arm64']) {
    const pin = graphifyLock.targets[key];
    assert.equal(pin.wheels.length, 31);
    assert.equal(pin.python.format, 'tar.gz');
    assert.match(pin.python.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\//);
    assert.match(pin.python.sha256, /^[a-f0-9]{64}$/);
    for (const wheel of pin.wheels) {
      assert.match(wheel.url, /^https:\/\/files\.pythonhosted\.org\/packages\//);
      assert.match(wheel.sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.equal(graphifyLock.targets['win32-x64'].python.sha256, '136bbb2e50fe037fd5e32126e70e95b35d1fa5dac5bd04a55b8088415ee99540');
  assert.equal(graphifyLock.targets['darwin-arm64'].python.sha256, 'b5199d66966141fb6d5447512d2b2fe0398d417da37b1949f58db3792d314eac');
});

test('launcher sources name only the bundled Python', async () => {
  const source = await readFile(path.join(scriptDir, 'graphify-launcher.c'), 'utf8');
  assert.match(source, /python\\python\.exe/);
  assert.equal(source.includes('Users'), false);
  assert.match(POSIX_GRAPHIFY_LAUNCHER, /python\/bin\/python3/);
  assert.equal(POSIX_GRAPHIFY_LAUNCHER.includes('Users'), false);
});

test('refuses a Graphify download whose bytes do not match the pin', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(fetchGraphify({
    platform: 'win32',
    arch: 'x64',
    destination: path.join(root, 'out'),
    cacheDir: path.join(root, 'cache'),
    sourceRoot: root,
    fetchImpl: async () => new Response(Buffer.from('not-the-archive')),
  }), /checksum mismatch/);
});

test('replaces an in-tree symlink with the target file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'python3.11'), 'python-bytes');
  try {
    await symlink('python3.11', path.join(root, 'python3'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
      t.skip('creating a symlink needs extra privilege');
      return;
    }
    throw error;
  }
  await materializeSymlinks(root);
  const info = await lstat(path.join(root, 'python3'));
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(await readFile(path.join(root, 'python3'), 'utf8'), 'python-bytes');
});
