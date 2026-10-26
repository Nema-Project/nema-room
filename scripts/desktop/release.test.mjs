import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPackageVersion, readReleaseVersion } from './release-version.mjs';
import { checksumFileName, collectReleaseManifest, expectedAssets, expectedTargets, writeTargetChecksums } from './release-manifest.mjs';
import { createSanitizedSourceSnapshot } from './stage-runtime.mjs';

const version = '1.2.3';

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function artifactsFixture(t, { skip = [] } = {}) {
  const root = await tempDir(t, 'nema-release-artifacts-');
  for (const target of expectedTargets) {
    if (skip.includes(target)) continue;
    const dir = path.join(root, target);
    await mkdir(dir, { recursive: true });
    for (const name of expectedAssets(version, target)) await writeFile(path.join(dir, name), `payload ${name}`);
    await writeTargetChecksums(dir, version, target);
  }
  return root;
}

test('readReleaseVersion accepts stable and prerelease tags', () => {
  assert.deepEqual(readReleaseVersion('v1.2.3', '1.2.3'), { version: '1.2.3', prerelease: false });
  assert.deepEqual(readReleaseVersion('v1.2.3-rc.1', '1.2.3-rc.1'), { version: '1.2.3-rc.1', prerelease: true });
  assert.deepEqual(readReleaseVersion('v0.1.0-0', '0.1.0-0'), { version: '0.1.0-0', prerelease: true });
});

test('readReleaseVersion rejects invalid tags and version mismatch', () => {
  for (const tag of ['1.2.3', 'V1.2.3', 'v1.2', 'v01.2.3', 'v1.2.3-', 'v1.2.3-01', 'v1.2.3+build', 'v1.2.3 ', 'refs/tags/v1.2.3', '', undefined]) {
    assert.throws(() => readReleaseVersion(tag, '1.2.3'), /Release tag/, String(tag));
  }
  assert.throws(() => readReleaseVersion('v1.2.4', '1.2.3'), /does not match package version/);
  assert.throws(() => readReleaseVersion('v1.2.3', undefined), /does not match package version/);
  assert.throws(() => readReleaseVersion('v1.2.3-rc.1', '1.2.3'), /does not match package version/);
});

test('collection accepts a complete matrix and writes a manifest, combined checksums and assets', async (t) => {
  const root = await artifactsFixture(t);
  const out = path.join(await tempDir(t, 'nema-release-out-'), 'release');
  const manifest = await collectReleaseManifest({ version, prerelease: false, artifactsRoot: root, outputDir: out, build: { commit: 'abc' } });
  assert.deepEqual(Object.keys(manifest.targets), [...expectedTargets]);
  const files = await readdir(out);
  assert.equal(files.length, 4 + 2);
  assert.ok(files.includes('Nema-1.2.3-win32-x64.exe') && files.includes('Nema-1.2.3-darwin-arm64.dmg'));
  // Releases ship installers only; the portable ZIPs are no longer built or published.
  assert.equal(files.some((name) => name.endsWith('.zip')), false);
  const sums = (await readFile(path.join(out, 'SHA256SUMS-1.2.3.txt'), 'utf8')).trim().split('\n');
  assert.equal(sums.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(out, 'release-manifest-1.2.3.json'), 'utf8')).build.commit, 'abc');
});

test('collection refuses a missing matrix target without copying anything', async (t) => {
  const root = await artifactsFixture(t, { skip: ['darwin-arm64'] });
  const out = path.join(await tempDir(t, 'nema-release-out-'), 'release');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: out }), /Missing release target darwin-arm64/);
  assert.equal(await stat(out).catch(() => null), null);
});

test('collection refuses a missing installer or checksum file and unexpected files, including a portable ZIP', async (t) => {
  for (const file of ['Nema-1.2.3-darwin-arm64.dmg', 'SHA256SUMS-1.2.3-darwin-arm64.txt']) {
    const root = await artifactsFixture(t);
    await rm(path.join(root, 'darwin-arm64', file));
    await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /Missing darwin-arm64 release file/, file);
  }
  const root = await artifactsFixture(t);
  await writeFile(path.join(root, 'win32-x64', 'latest.yml'), 'x');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /Unexpected file/);
  const zipRoot = await artifactsFixture(t);
  await writeFile(path.join(zipRoot, 'darwin-arm64', 'Nema-1.2.3-darwin-arm64.zip'), 'portable app');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: zipRoot, outputDir: path.join(zipRoot, 'out') }), /Unexpected file in darwin-arm64 artifact: Nema-1.2.3-darwin-arm64.zip/);
});

test('collection refuses a checksum mismatch', async (t) => {
  const root = await artifactsFixture(t);
  await writeFile(path.join(root, 'win32-x64', 'Nema-1.2.3-win32-x64.exe'), 'tampered after checksum');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /Checksum mismatch for win32-x64\/Nema-1.2.3-win32-x64.exe/);
});

test('collection refuses duplicate checksum entries', async (t) => {
  const root = await artifactsFixture(t);
  const sumsFile = path.join(root, 'win32-x64', checksumFileName(version, 'win32-x64'));
  const line = (await readFile(sumsFile, 'utf8')).split('\n')[0];
  await writeFile(sumsFile, `${line}\n${line}\n`);
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /Duplicate checksum entry/);
});

test('every published asset name is unique across the matrix and unknown targets are refused', () => {
  assert.throws(() => expectedAssets(version, 'linux-x64'), /Unexpected release target/);
  assert.throws(() => expectedAssets(version, 'darwin-x64'), /Unexpected release target/);
  const names = expectedTargets.flatMap((target) => [...expectedAssets(version, target), checksumFileName(version, target)]);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
});

test('collection refuses a checksum file that lists more or less than the set', async (t) => {
  const root = await artifactsFixture(t);
  const sumsFile = path.join(root, 'darwin-arm64', checksumFileName(version, 'darwin-arm64'));
  await writeFile(sumsFile, `${(await readFile(sumsFile, 'utf8')).split('\n')[0]}\n${'0'.repeat(64)}  Nema-1.2.3-darwin-arm64.zip\n`);
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /must list exactly/);
  await writeFile(sumsFile, `${'0'.repeat(64)}  Nema-1.2.3-darwin-arm64.zip\n`);
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /must list exactly/);
});

test('release version comes from package fields in a source copy without .git', async (t) => {
  const source = await tempDir(t, 'nema-release-source-');
  for (const dir of ['apps/desktop', 'apps/local']) {
    await mkdir(path.join(source, dir), { recursive: true });
    await writeFile(path.join(source, dir, 'package.json'), JSON.stringify({ name: dir, version: '1.2.3-rc.1' }));
  }
  assert.equal(await stat(path.join(source, '.git')).catch(() => null), null);
  const snapshot = path.join(await tempDir(t, 'nema-release-snapshot-'), 'snapshot');
  await createSanitizedSourceSnapshot(source, snapshot);
  assert.equal(await stat(path.join(snapshot, '.git')).catch(() => null), null);
  const packageVersion = await readPackageVersion(snapshot);
  assert.deepEqual(readReleaseVersion('v1.2.3-rc.1', packageVersion), { version: '1.2.3-rc.1', prerelease: true });
  await writeFile(path.join(snapshot, 'apps/local/package.json'), JSON.stringify({ version: '1.2.4' }));
  await assert.rejects(readPackageVersion(snapshot), /must match local runtime/);
});
