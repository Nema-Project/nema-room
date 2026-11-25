import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertComponentStatus, assertVersion, bumpInstalledPackage, installedBin, localTarballArg, lowerInstalledPackage, lowerPatch, parseSmokeArgs, releaseHost } from './smoke-pack.mjs';

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

test('--expect-skew lowers the installed package version below the hub floor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkgPath = path.join(root, 'node_modules', '@nema-project', 'nema', 'package.json');
  await mkdir(path.dirname(pkgPath), { recursive: true });
  await writeFile(pkgPath, JSON.stringify({ name: '@nema-project/nema', version: '0.3.2' }));
  assert.equal(await lowerInstalledPackage(root), '0.3.1');
  assert.equal(JSON.parse(await readFile(pkgPath, 'utf8')).version, '0.3.1');
});

test('lowerPatch steps down through zero components', () => {
  assert.equal(lowerPatch('0.3.2'), '0.3.1');
  assert.equal(lowerPatch('0.3.0'), '0.2.0');
  assert.equal(lowerPatch('1.0.0'), '0.0.0');
  assert.equal(lowerPatch('0.0.0'), '0.0.0');
  assert.throws(() => lowerPatch('test-version'), /cannot lower version/);
});

test('assertComponentStatus requires a download offer on a supported release host', () => {
  const host = { platform: 'linux', arch: 'x64', musl: false };
  const notInstalled = (totalBytes) => JSON.stringify({ name: 'graphify', status: { state: 'not-installed' }, offer: { totalBytes } });
  assert.equal(assertComponentStatus(notInstalled(123), host).status.state, 'not-installed');
  assert.throws(() => assertComponentStatus(notInstalled(0), host), /must offer a Graphify download/);
  assert.throws(() => assertComponentStatus(notInstalled('123'), host), /must offer a Graphify download/);
  const unsupported = JSON.stringify({ name: 'graphify', status: { state: 'failed', reason: 'unsupported-platform', detail: 'No Graphify build is pinned for linux-x64' } });
  assert.throws(() => assertComponentStatus(unsupported, host), /must offer a Graphify download/);
  assert.throws(() => assertComponentStatus(JSON.stringify({ name: 'graphify', status: { state: 'installed' } }), host), /empty home reported graphify installed/);
});

test('assertComponentStatus allows unsupported-platform on a genuinely unsupported host', () => {
  const unsupported = JSON.stringify({ name: 'graphify', status: { state: 'failed', reason: 'unsupported-platform', detail: 'musl' } });
  assert.equal(assertComponentStatus(unsupported, { platform: 'linux', arch: 'x64', musl: true }).status.state, 'failed');
  assert.equal(assertComponentStatus(unsupported, { platform: 'linux', arch: 'riscv64', musl: false }).status.state, 'failed');
  const unreadable = JSON.stringify({ name: 'graphify', status: { state: 'failed', reason: 'lock-unreadable', detail: 'nope' } });
  assert.throws(() => assertComponentStatus(unreadable, { platform: 'linux', arch: 'x64', musl: true }), /cannot read its Graphify lock/);
});

test('releaseHost reads support from the host, not the packed lock', () => {
  assert.equal(releaseHost({ platform: 'linux', arch: 'x64', musl: false }).supported, true);
  assert.equal(releaseHost({ platform: 'linux', arch: 'arm64', musl: false }).supported, true);
  assert.equal(releaseHost({ platform: 'darwin', arch: 'arm64' }).supported, true);
  assert.equal(releaseHost({ platform: 'win32', arch: 'x64' }).supported, true);
  assert.equal(releaseHost({ platform: 'linux', arch: 'x64', musl: true }).supported, false);
  assert.equal(releaseHost({ platform: 'linux', arch: 'riscv64' }).supported, false);
});
