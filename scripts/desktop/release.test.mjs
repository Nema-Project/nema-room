import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readPackageVersion, readReleaseVersion } from './release-version.mjs';
import { checksumFileName, collectReleaseManifest, expectedAssets, expectedTargets, verifyTargetChecksums, writeTargetChecksums } from './release-manifest.mjs';
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
  const composeAsset = path.join(await tempDir(t, 'nema-compose-'), 'docker-compose.yml');
  await writeFile(composeAsset, 'compose asset');
  const manifest = await collectReleaseManifest({ version, prerelease: false, artifactsRoot: root, outputDir: out, build: { commit: 'abc' }, composeAsset });
  assert.deepEqual(Object.keys(manifest.targets), [...expectedTargets]);
  const files = await readdir(out);
  assert.equal(files.length, 8);
  assert.ok(files.includes('Nema-1.2.3-win32-x64.exe') && files.includes('Nema-1.2.3-win32-x64.zip') && files.includes('Nema-1.2.3-darwin-arm64.dmg'));
  assert.equal(files.includes('Nema-1.2.3-darwin-arm64.zip'), false);
  const sums = (await readFile(path.join(out, 'SHA256SUMS-1.2.3.txt'), 'utf8')).trim().split('\n');
  assert.deepEqual(sums.map((line) => line.slice(66)), ['Nema-1.2.3-win32-x64.exe', 'Nema-1.2.3-win32-x64.zip', 'Nema-1.2.3-darwin-arm64.dmg', 'docker-compose.yml']);
  const written = JSON.parse(await readFile(path.join(out, 'release-manifest-1.2.3.json'), 'utf8'));
  assert.equal(written.build.commit, 'abc');
  assert.equal(written.compose.sha256, createHash('sha256').update('compose asset').digest('hex'));
  assert.deepEqual(written.targets['win32-x64'].map((asset) => asset.name), ['Nema-1.2.3-win32-x64.exe', 'Nema-1.2.3-win32-x64.zip', 'SHA256SUMS-1.2.3-win32-x64.txt']);
});

test('collection refuses a missing matrix target without copying anything', async (t) => {
  const root = await artifactsFixture(t, { skip: ['darwin-arm64'] });
  const out = path.join(await tempDir(t, 'nema-release-out-'), 'release');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: out }), /Missing release target darwin-arm64/);
  assert.equal(await stat(out).catch(() => null), null);
});

test('collection refuses a missing asset or checksum file and unexpected files', async (t) => {
  for (const file of ['Nema-1.2.3-darwin-arm64.dmg', 'SHA256SUMS-1.2.3-darwin-arm64.txt']) {
    const root = await artifactsFixture(t);
    await rm(path.join(root, 'darwin-arm64', file));
    await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /Missing darwin-arm64 release file/, file);
  }
  const missingZip = await artifactsFixture(t);
  await rm(path.join(missingZip, 'win32-x64', 'Nema-1.2.3-win32-x64.zip'));
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: missingZip, outputDir: path.join(missingZip, 'out') }), /Missing win32-x64 release file: Nema-1.2.3-win32-x64.zip/);
  const root = await artifactsFixture(t);
  await writeFile(path.join(root, 'win32-x64', 'latest.yml'), 'x');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /Unexpected file/);
  const duplicate = await artifactsFixture(t);
  await writeFile(path.join(duplicate, 'win32-x64', 'docker-compose.yml'), 'duplicate');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: duplicate, outputDir: path.join(duplicate, 'out') }), /Unexpected file/);
  const zipRoot = await artifactsFixture(t);
  await writeFile(path.join(zipRoot, 'darwin-arm64', 'Nema-1.2.3-darwin-arm64.zip'), 'portable app');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: zipRoot, outputDir: path.join(zipRoot, 'out') }), /Unexpected file in darwin-arm64 artifact: Nema-1.2.3-darwin-arm64.zip/);
  const bundle = await artifactsFixture(t);
  await writeFile(path.join(bundle, 'win32-x64', 'Nema-1.2.3-win32-x64.7z'), 'nested');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: bundle, outputDir: path.join(bundle, 'out') }), /Unexpected file in win32-x64 artifact: Nema-1.2.3-win32-x64.7z/);
});

test('collection refuses a checksum mismatch', async (t) => {
  const root = await artifactsFixture(t);
  await writeFile(path.join(root, 'win32-x64', 'Nema-1.2.3-win32-x64.zip'), 'tampered after checksum');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: path.join(root, 'out') }), /Checksum mismatch for win32-x64\/Nema-1.2.3-win32-x64.zip/);
  await assert.rejects(verifyTargetChecksums(path.join(root, 'win32-x64'), version, 'win32-x64'), /Checksum mismatch for win32-x64\/Nema-1.2.3-win32-x64.zip/);
});

test('verify accepts the Windows installer and portable ZIP checksums', async (t) => {
  const root = await artifactsFixture(t);
  await verifyTargetChecksums(path.join(root, 'win32-x64'), version, 'win32-x64');
  const sumsFile = path.join(root, 'win32-x64', checksumFileName(version, 'win32-x64'));
  const lines = (await readFile(sumsFile, 'utf8')).trim().split('\n');
  assert.deepEqual(lines.map((line) => line.slice(66)), ['Nema-1.2.3-win32-x64.exe', 'Nema-1.2.3-win32-x64.zip']);
  await writeFile(sumsFile, `${lines[0]}\n`);
  await assert.rejects(verifyTargetChecksums(path.join(root, 'win32-x64'), version, 'win32-x64'), /must list exactly/);
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


test('refuses a missing or empty compose asset', async (t) => {
  const root = await artifactsFixture(t), dir = await tempDir(t, 'nema-compose-');
  const out = path.join(dir, 'out'), missing = path.join(dir, 'missing', 'docker-compose.yml');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: out, composeAsset: missing }));
  const empty = path.join(dir, 'docker-compose.yml'); await writeFile(empty, '');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: out, composeAsset: empty }));
  const wrong = path.join(dir, 'compose.yml'); await writeFile(wrong, 'contents');
  await assert.rejects(collectReleaseManifest({ version, artifactsRoot: root, outputDir: out, composeAsset: wrong }));
  assert.equal(await stat(out).catch(() => null), null);
});
