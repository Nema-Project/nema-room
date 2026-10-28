import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = path.join(repo, 'scripts/images/stamp-compose.mjs');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compose-stamp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'docker-compose.yml'), await readFile(path.join(repo, 'docker-compose.yml')));
  return root;
}
async function stamp(args) { return (await import('./stamp-compose.mjs')).stampCompose(args); }

test('renders both images to the given version and leaves the template untouched', async (t) => {
  const root = await fixture(t), original = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
  const { text } = await stamp({ root, version: '9.9.9' });
  assert.match(text, /nema-room-hub:9\.9\.9/); assert.match(text, /nema-room-web:9\.9\.9/);
  assert.ok(!text.includes(':-latest')); assert.equal(await readFile(path.join(root, 'docker-compose.yml'), 'utf8'), original);
});
test('writes the output only after the version assertion passes', async (t) => {
  const root = await fixture(t), out = path.join(root, 'asset.yml');
  const { text } = await stamp({ root, version: '9.9.9', out });
  assert.equal(await readFile(out, 'utf8'), text);
});
test('refuses the repository template path and a non-release version', async (t) => {
  const root = await fixture(t), out = path.join(root, 'asset.yml');
  await assert.rejects(stamp({ root, version: '1.2.3', out: path.join(root, 'docker-compose.yml') }), /refusing to overwrite/);
  for (const version of ['v1.2.3', 'latest', '1.2', '']) await assert.rejects(stamp({ root, version, out }));
  await assert.rejects(readFile(out), { code: 'ENOENT' });
});
test('writes nothing when the rendered file fails the assertion', async (t) => {
  const root = await fixture(t), template = path.join(root, 'docker-compose.yml'), out = path.join(root, 'asset.yml');
  const text = await readFile(template, 'utf8');
  await writeFile(template, text.replace('nema-room-web:${NEMA_IMAGE_TAG:-latest}', 'nema-room-web:${OTHER_TAG:-latest}'));
  await writeFile(out, 'old'); await assert.rejects(stamp({ root, version: '9.9.9', out }));
  assert.equal(await readFile(out, 'utf8'), 'old');
});
test('--check prints the result and writes nothing', () => {
  const run = spawnSync(process.execPath, [cli, '--check', '9.9.9'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, 'compose asset: 9.9.9 ok\n');
});
test('creates a missing output directory', async (t) => {
  const root = await fixture(t), out = path.join(root, 'a/b/docker-compose.yml');
  const { text } = await stamp({ root, version: '9.9.9', out }); assert.equal(await readFile(out, 'utf8'), text);
});
test('stdout mode emits only the compose document', () => {
  const run = spawnSync(process.execPath, [cli, '9.9.9'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.ok(parse(run.stdout).services); assert.doesNotMatch(run.stdout, /compose asset|wrote/);
  assert.match(run.stderr, /compose asset: 9.9.9 ok/);
});
test('file mode writes nothing to stdout', async (t) => {
  const root = await fixture(t), out = path.join(root, 'asset.yml');
  const run = spawnSync(process.execPath, [cli, '9.9.9', out], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, ''); assert.match(run.stderr, /wrote/); assert.match(run.stderr, /compose asset: 9.9.9 ok/);
});
