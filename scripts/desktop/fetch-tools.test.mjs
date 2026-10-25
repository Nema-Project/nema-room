import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { assetsFor, extractArchive, sha256File, findRequiredFile, downloadVerified, publishStagedDirectory, gitLayoutFor, fetchTools, rejectSymlinkPath } from './fetch-tools.mjs';

const tmp = async () => mkdtemp(path.join(os.tmpdir(), 'nema-tools-'));
const tarEntry = (name, body, type = '0', linkname = '') => {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100); h.write('0644\0', 100, 8); h.write('0000000\0', 108, 8); h.write('0000000\0', 116, 8);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124, 12); h.write('00000000000\0', 136, 12); h.fill(32, 148, 156);
  h.write(type, 156, 1); h.write(linkname, 157, 100); h.write('ustar\0', 257, 6); h.write('00', 263, 2);
  let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([h, body, Buffer.alloc((512 - body.length % 512) % 512)]);
};
const tarGz = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const zipEntry = (name, body) => {
  const nameBytes = Buffer.from(name), payload = Buffer.from(body);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(0, 10); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(nameBytes.length, 28);
  const header = Buffer.concat([local, nameBytes, payload]);
  const directory = Buffer.concat([central, nameBytes]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(header.length, 16);
  return Buffer.concat([header, directory, eocd]);
};

test('a symlinked ancestor is canonical, a symlinked directory is refused', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = path.join(root, 'actual');
  const linkParent = path.join(root, 'link-parent');
  await mkdir(actual);
  try {
    await symlink(actual, linkParent, 'dir');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') return;
    throw error;
  }
  await rejectSymlinkPath(path.join(linkParent, 'nested', 'out'));
  const leaf = path.join(root, 'leaf');
  await symlink(actual, leaf, 'dir');
  await assert.rejects(rejectSymlinkPath(leaf), /symlink/);
});

test('manifest pins all four runtime targets to exact official versioned URLs and hashes', () => {
  const expected = [['win32','x64'],['darwin','arm64'],['linux','x64'],['linux','arm64']];
  for (const [platform, arch] of expected) {
    const entries = assetsFor(platform, arch);
    assert.equal(entries.node.version, '24.22.1');
    assert.match(entries.node.url, /node-v24\.22\.1/);
    assert.match(entries.git.url, /dugite-native-v2\.56\.0-7ce66f8/);
    assert.match(entries.node.sha256, /^[a-f0-9]{64}$/);
    assert.match(entries.git.sha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => assetsFor('freebsd', 'x64'), /unsupported/i);
  assert.throws(() => assetsFor('win32', 'arm64'), /unsupported/i);
});

test('sha256File computes the trusted digest of a cache artifact', async () => {
  const root = await tmp();
  try {
    const file = path.join(root, 'payload'); await writeFile(file, 'trusted');
    assert.equal(await sha256File(file), createHash('sha256').update('trusted').digest('hex'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('injected network payload is checked against the pinned digest, not response metadata', async () => {
  const root = await tmp();
  try {
    const asset = assetsFor('win32', 'x64').node;
    const fakeFetch = async () => ({ ok: true, headers: { get: () => '0'.repeat(64) }, arrayBuffer: async () => Buffer.from('tampered') });
    await assert.rejects(downloadVerified(asset, root, fakeFetch), /checksum mismatch/i);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tar extraction rejects traversal before writing outside destination', async () => {
  const root = await tmp(); const out = path.join(root, 'out');
  try {
    await mkdir(out);
    await assert.rejects(extractArchive(tarGz(tarEntry('../escape', Buffer.from('bad'))), 'tar.gz', out), /unsafe|traversal/i);
    await assert.rejects(readFile(path.join(root, 'escape')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('zip extraction rejects traversal before writing outside destination', async () => {
  const root = await tmp(); const out = path.join(root, 'out');
  try {
    await mkdir(out);
    await assert.rejects(extractArchive(zipEntry('../escape', 'bad'), 'zip', out), /unsafe|traversal/i);
    await assert.rejects(readFile(path.join(root, 'escape')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manifest selection rejects mismatched platform and architecture', () => {
  assert.throws(() => assetsFor('win32', 'arm64'), /unsupported/i);
  assert.throws(() => assetsFor('darwin', 'x64'), /unsupported/i);
  assert.throws(() => assetsFor('freebsd', 'x64'), /unsupported/i);
});

test('required license notices reject incomplete distribution trees', async () => {
  const root = await tmp();
  try {
    await assert.rejects(findRequiredFile(root, ['LICENSE', 'NOTICE'], 'Git'), /license|notice/i);
    await writeFile(path.join(root, 'LICENSE'), 'license');
    assert.equal(await findRequiredFile(root, ['LICENSE', 'NOTICE'], 'Git'), 'LICENSE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('TAR extraction rejects descendants whose destination parent is an archive symlink', async () => {
  const root = await tmp(); const out = path.join(root, 'out');
  try {
    await mkdir(out);
    await assert.rejects(extractArchive(tarGz(
      tarEntry('a', Buffer.alloc(0), '2', '.'),
      tarEntry('a/b', Buffer.from('outside'), '0'),
    ), 'tar.gz', out), /symlink.*parent|parent.*symlink/i);
    await assert.rejects(lstat(path.join(out, 'a')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(out, 'outside')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pinned macOS Git layout uses bin/git and carries a concrete upstream notice', async () => {
  const layout = gitLayoutFor('darwin', 'arm64');
  assert.equal(layout.binary, 'bin/git');
  assert.match(layout.licenseSource.url, /git\/a018953688f1b10bddf91bff8747068f5f4746a4\/COPYING$/);
  assert.match(layout.licenseSource.sha256, /^[a-f0-9]{64}$/);
  assert.ok(layout.noticeCandidates.includes('libexec/git-core/NOTICE'));
});

test('pinned Ubuntu Git layouts use the bin/git path from the upstream build script', () => {
  for (const arch of ['x64', 'arm64']) assert.equal(gitLayoutFor('linux', arch).binary, 'bin/git');
});

test('macOS archive fixture resolves Git executable and notice at the pinned layout paths', async () => {
  const root = await tmp(); const unpack = path.join(root, 'unpack');
  try {
    const tar = tarGz(
      tarEntry('bin/git', Buffer.from('git-bin')),
      tarEntry('libexec/git-core/NOTICE', Buffer.from('upstream notice')),
    );
    await extractArchive(tar, 'tar.gz', unpack);
    const layout = gitLayoutFor('darwin', 'arm64');
    assert.equal(await readFile(path.join(unpack, layout.binary), 'utf8'), 'git-bin');
    assert.equal(await findRequiredFile(unpack, layout.noticeCandidates, 'Git notice'), 'libexec/git-core/NOTICE');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication refuses a target created after staging and leaves its contents intact', async () => {
  const root = await tmp(); const stage = path.join(root, 'stage'); const target = path.join(root, 'target');
  try {
    await mkdir(stage); await writeFile(path.join(stage, 'ours'), 'ours');
    await mkdir(target); await writeFile(path.join(target, 'foreign'), 'keep');
    await assert.rejects(publishStagedDirectory(stage, target));
    assert.equal(await readFile(path.join(target, 'foreign'), 'utf8'), 'keep');
    assert.equal(await readFile(path.join(stage, 'ours'), 'utf8'), 'ours');
    const emptyTarget = path.join(root, 'empty-target');
    await mkdir(emptyTarget);
    await assert.rejects(publishStagedDirectory(stage, emptyTarget));
    assert.equal((await readdir(emptyTarget)).length, 0);
    assert.equal(await readFile(path.join(stage, 'ours'), 'utf8'), 'ours');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed fetch never recursively removes an output target created by a concurrent invocation', async () => {
  const root = await tmp(); const cache = path.join(root, 'cache'); const out = path.join(root, 'out');
  await mkdir(cache); await mkdir(out);
  const target = path.join(out, 'win32-x64');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      await mkdir(target);
      await writeFile(path.join(target, 'foreign-owner'), 'keep');
      return { ok: false, status: 503 };
    };
    await assert.rejects(fetchTools({ platform: 'win32', arch: 'x64', cacheDir: cache, outDir: out }), /download failed/i);
    assert.equal(await readFile(path.join(target, 'foreign-owner'), 'utf8'), 'keep');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('verified packaging preserves a target claimed concurrently during archive verification', async () => {
  const root = await tmp(); const out = path.join(root, 'out'); await mkdir(out);
  const target = path.join(out, 'win32-x64');
  const cache = path.resolve('.superpowers/sdd/2026-10-24-desktop-implementation/tool-cache');
  let stop = false;
  const watcher = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    while (!stop) {
      try { await mkdir(target); await writeFile(path.join(target, 'foreign-owner'), 'keep', { flag: 'wx' }); return; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      try { await access(target); return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();
  try {
    await assert.rejects(fetchTools({ platform: 'win32', arch: 'x64', cacheDir: cache, outDir: out }));
    stop = true; await watcher;
    assert.equal(await readFile(path.join(target, 'foreign-owner'), 'utf8'), 'keep');
  } finally { stop = true; await watcher; await rm(root, { recursive: true, force: true }); }
});

const windowsToolCache = path.resolve('.superpowers/sdd/2026-10-24-desktop-implementation/tool-cache');
let hasWindowsToolCache = process.platform === 'win32';
for (const file of [assetsFor('win32', 'x64').node.file, assetsFor('win32', 'x64').git.file, 'git-COPYING-v2.56.0']) {
  try { await access(path.join(windowsToolCache, file)); } catch { hasWindowsToolCache = false; }
}
test('published Windows target contains only documented entries, no unpack or owner-marker residue', { skip: !hasWindowsToolCache }, async () => {
  const root = await tmp(); const out = path.join(root, 'out');
  try {
    const result = await fetchTools({ platform: 'win32', arch: 'x64', cacheDir: windowsToolCache, outDir: out });
    const target = path.join(out, 'win32-x64');
    const entries = (await readdir(target)).sort();
    assert.deepEqual(entries, ['git', 'node', 'tools-source.json']);
    assert.equal(result.node, 'win32-x64/node/node.exe');
    assert.equal(result.git, 'win32-x64/git/cmd/git.exe');
    assert.ok(entries.every((entry) => !entry.includes('unpack') && !entry.includes('owner')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
