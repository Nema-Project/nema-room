import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertReleaseTrio } from './check-tag.mjs';

const script = fileURLToPath(new URL('./check-tag.mjs', import.meta.url));

async function rootWith(t, versions) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-tag-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [dir, version] of Object.entries(versions)) {
    await mkdir(path.join(root, 'apps', dir), { recursive: true });
    await writeFile(path.join(root, 'apps', dir, 'package.json'), JSON.stringify({ version }));
  }
  return root;
}

test('matching cli, desktop, and local versions accept a strict tag', () => {
  const versions = { cli: '1.2.3', desktop: '1.2.3', local: '1.2.3' };
  assert.deepEqual(assertReleaseTrio('v1.2.3', versions), { version: '1.2.3', prerelease: false, distTag: 'latest' });
  assert.deepEqual(assertReleaseTrio('v1.2.3-rc.1', { cli: '1.2.3-rc.1', desktop: '1.2.3-rc.1', local: '1.2.3-rc.1' }), {
    version: '1.2.3-rc.1', prerelease: true, distTag: 'next',
  });
});

test('a mismatched package or a bad tag fails and names the versions', async (t) => {
  const versions = { cli: '1.2.3', desktop: '1.2.4', local: '1.2.3' };
  assert.throws(() => assertReleaseTrio('v1.2.3', versions), /desktop 1\.2\.4/);
  assert.throws(() => assertReleaseTrio('v1.2.3', { cli: '1.2.2', desktop: '1.2.3', local: '1.2.3' }), /cli 1\.2\.2/);
  assert.throws(() => assertReleaseTrio('v1.2.3', { cli: '1.2.3', desktop: '1.2.3', local: '9.9.9' }), /local 9\.9\.9/);
  const same = { cli: '1.2.3', desktop: '1.2.3', local: '1.2.3' };
  assert.throws(() => assertReleaseTrio('1.2.3', same), /v<SemVer>/);
  assert.throws(() => assertReleaseTrio('v1.2', { cli: '1.2', desktop: '1.2', local: '1.2' }), /strict SemVer/);
  assert.throws(() => assertReleaseTrio('v1.2.4', same), /1\.2\.4/);
  const root = await rootWith(t, versions);
  const run = spawnSync(process.execPath, [script, 'v1.2.3', root], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /desktop 1\.2\.4/);
  assert.match(run.stderr, /cli 1\.2\.3/);
  assert.match(run.stderr, /local 1\.2\.3/);
});
