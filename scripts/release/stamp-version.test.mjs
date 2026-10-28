import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertStrictVersion, stampVersion } from './stamp-version.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(new URL('./stamp-version.mjs', import.meta.url));
const checkTag = fileURLToPath(new URL('../npm/check-tag.mjs', import.meta.url));
const copied = ['apps/cli/package.json', 'apps/desktop/package.json', 'apps/local/package.json', 'package-lock.json', 'docker-compose.yml'];

function git(root, args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return run.stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'nema-stamp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const rel of copied) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await cp(path.join(repo, rel), path.join(root, rel));
  }
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

async function snapshot(root) {
  const out = new Map();
  for (const rel of copied) out.set(rel, await readFile(path.join(root, rel), 'utf8'));
  return out;
}

test('strict version rejects a v prefix, a short version, and build metadata', () => {
  assert.doesNotThrow(() => assertStrictVersion('1.2.3'));
  assert.doesNotThrow(() => assertStrictVersion('1.2.3-rc.1'));
  assert.throws(() => assertStrictVersion('v1.2.3'), /without a v prefix/);
  assert.throws(() => assertStrictVersion('1.2'), /strict SemVer/);
  assert.throws(() => assertStrictVersion('1.2.3+build'), /strict SemVer/);
});

test('usage errors do not stamp the repository', async () => {
  const rels = ['apps/cli/package.json', 'apps/desktop/package.json', 'apps/local/package.json', 'package-lock.json'];
  const before = new Map(await Promise.all(rels.map(async (rel) => [rel, await readFile(path.join(repo, rel), 'utf8')])));
  const run = (args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });
  const missing = run([]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Usage: stamp-version\.mjs <x\.y\.z>/);
  const prefixed = run(['v1.2.3']);
  assert.notEqual(prefixed.status, 0);
  assert.match(prefixed.stderr, /without a v prefix/);
  for (const [rel, text] of before) assert.equal(await readFile(path.join(repo, rel), 'utf8'), text, rel);
});

test('an inconsistent trio fails before any write', async (t) => {
  const root = await fixture(t);
  const desktop = path.join(root, 'apps/desktop/package.json');
  const text = await readFile(desktop, 'utf8');
  await writeFile(desktop, text.replace('"version": "0.1.5"', '"version": "0.1.4"'));
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'diverge desktop']);
  const before = await snapshot(root);
  const head = git(root, ['rev-parse', 'HEAD']);
  await assert.rejects(stampVersion(root, '9.9.9'), /cli 0\.1\.5, desktop 0\.1\.4, local 0\.1\.5/);
  for (const [rel, text] of before) assert.equal(await readFile(path.join(root, rel), 'utf8'), text, rel);
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
});

test('a lockfile record behind the trio is refused before any write', async (t) => {
  const root = await fixture(t);
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  lock.packages['apps/cli'].version = '0.1.4';
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'drift cli lock']);
  const before = await snapshot(root);
  const head = git(root, ['rev-parse', 'HEAD']);
  await assert.rejects(
    stampVersion(root, '0.2.0'),
    /apps\/cli: package\.json 0\.1\.5 vs package-lock\.json 0\.1\.4/,
  );
  for (const [rel, text] of before) assert.equal(await readFile(path.join(root, rel), 'utf8'), text, rel);
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
});

test('a missing lockfile record is refused before any write', async (t) => {
  const root = await fixture(t);
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  delete lock.packages['apps/desktop'];
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const before = await snapshot(root);
  await assert.rejects(stampVersion(root, '0.2.0'), /package-lock\.json has no apps\/desktop record/);
  for (const [rel, text] of before) assert.equal(await readFile(path.join(root, rel), 'utf8'), text, rel);
});

test('stamping a consistent tree updates only the version files while compose keeps its pin', async (t) => {
  const root = await fixture(t);
  const head = git(root, ['rev-parse', 'HEAD']);
  const compose = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const beforeLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const source = await readFile(script, 'utf8');
  assert.match(source, /renderComposeAsset/);

  await stampVersion(root, '9.9.9');

  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
  assert.equal(await readFile(path.join(root, 'docker-compose.yml'), 'utf8'), compose);
  assert.deepEqual(git(root, ['diff', '--name-only']).split('\n').filter(Boolean).sort(), [
    'apps/cli/package.json',
    'apps/desktop/package.json',
    'apps/local/package.json',
    'package-lock.json',
  ]);
  const afterLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  for (const workspace of ['apps/cli', 'apps/desktop', 'apps/local']) {
    assert.equal(afterLock.packages[workspace].version, '9.9.9');
    afterLock.packages[workspace].version = beforeLock.packages[workspace].version;
  }
  assert.deepEqual(afterLock, beforeLock);
  for (const rel of ['apps/cli/package.json', 'apps/desktop/package.json', 'apps/local/package.json']) {
    assert.equal(JSON.parse(await readFile(path.join(root, rel), 'utf8')).version, '9.9.9');
  }
  const tag = spawnSync(process.execPath, [checkTag, 'v9.9.9', root], { encoding: 'utf8' });
  assert.equal(tag.status, 0, tag.stderr);
});

test('a failed post-write check restores the version files', async (t) => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const head = git(root, ['rev-parse', 'HEAD']);
  await assert.rejects(
    stampVersion(root, '9.9.9', async () => {
      throw new Error('check-tag failed for v9.9.9: injected');
    }),
    /check-tag failed for v9\.9\.9: injected[\s\S]*Version files were restored/,
  );
  for (const [rel, text] of before) assert.equal(await readFile(path.join(root, rel), 'utf8'), text, rel);
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(git(root, ['rev-parse', 'HEAD']), head);
});


test('refuses when the compose template cannot render at the new version', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'docker-compose.yml');
  await writeFile(file, (await readFile(file, 'utf8')).replace('${NEMA_IMAGE_TAG:-latest}', '${NEMA_IMAGE_TAG}'));
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'break template']);
  const before = await snapshot(root);
  await assert.rejects(stampVersion(root, '9.9.9'), /compose template failed at v9\.9\.9[\s\S]*Version files were restored/);
  for (const [rel, text] of before) assert.equal(await readFile(path.join(root, rel), 'utf8'), text, rel);
  assert.equal(git(root, ['status', '--porcelain']), '');
});
