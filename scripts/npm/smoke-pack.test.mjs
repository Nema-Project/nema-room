import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertVersion, bumpInstalledPackage, installedBin, localTarballArg, parseSmokeArgs } from './smoke-pack.mjs';

test('parseSmokeArgs reads the tarball and optional hub flags', () => {
  assert.deepEqual(parseSmokeArgs(['nema-project-nema-0.1.3.tgz']), {
    tarball: 'nema-project-nema-0.1.3.tgz',
    hubUrl: undefined,
    tokenFile: undefined,
    expectSkew: false,
  });
  assert.deepEqual(parseSmokeArgs(['pkg.tgz', '--hub-url', 'http://127.0.0.1:4400', '--token-file', '/tmp/daemon-token', '--expect-skew']), {
    tarball: 'pkg.tgz',
    hubUrl: 'http://127.0.0.1:4400',
    tokenFile: '/tmp/daemon-token',
    expectSkew: true,
  });
  assert.throws(() => parseSmokeArgs([]), /tarball/);
  assert.throws(() => parseSmokeArgs(['pkg.tgz', '--hub-url', 'http://127.0.0.1:4400']), /token-file/);
  assert.throws(() => parseSmokeArgs(['pkg.tgz', '--expect-skew']), /expect-skew/);
});

test('version comparison names both sides', () => {
  assert.equal(assertVersion('0.1.3\n', '0.1.3'), undefined);
  assert.throws(() => assertVersion('0.1.4', '0.1.3'), /0\.1\.4/);
  assert.throws(() => assertVersion('0.1.4', '0.1.3'), /0\.1\.3/);
});

test('a relative tarball passed to npm keeps a ./ prefix', () => {
  assert.equal(localTarballArg('nema-project-nema-0.1.3.tgz'), './nema-project-nema-0.1.3.tgz');
  assert.equal(localTarballArg('./nema-project-nema-0.1.3.tgz'), './nema-project-nema-0.1.3.tgz');
  assert.equal(localTarballArg('../dist-npm/nema-project-nema-0.1.3.tgz'), '../dist-npm/nema-project-nema-0.1.3.tgz');
  const abs = path.resolve('nema-project-nema-0.1.3.tgz');
  assert.equal(localTarballArg(abs), abs);
});

test('smoke invokes the installed nema bin', () => {
  const root = path.join('install-root');
  assert.equal(installedBin(root), path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'nema.cmd' : 'nema'));
});

test('--expect-skew bumps the installed package version by one patch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkgPath = path.join(root, 'node_modules', '@nema-project', 'nema', 'package.json');
  await mkdir(path.dirname(pkgPath), { recursive: true });
  await writeFile(pkgPath, JSON.stringify({ name: '@nema-project/nema', version: '0.1.3' }));
  assert.equal(await bumpInstalledPackage(root), '0.1.4');
  assert.equal(JSON.parse(await readFile(pkgPath, 'utf8')).version, '0.1.4');
});
