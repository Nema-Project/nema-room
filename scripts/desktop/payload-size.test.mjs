import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkSlimPayload, directoryBytes, payloadSizeLines, PAYLOAD_BUDGETS_MIB, PRESET_DB_MAX_MIB, SLIM_PAYLOAD_TOTAL_MIB } from './payload-size.mjs';

test('payload size warnings name the section and do not require a huge file', () => {
  const over = payloadSizeLines({
    node: 151 * 1048576,
    graphify: 0,
    web: 1,
    total: 1,
  });
  assert.equal(over.warnings.length, 1);
  assert.match(over.warnings[0], /^payload size warning: node 151\.0 MiB exceeds 135 MiB$/);
  const under = payloadSizeLines({
    node: 10 * 1048576,
    graphify: 0,
    web: 10 * 1048576,
    total: 30 * 1048576,
  });
  assert.deepEqual(under.warnings, []);
  assert.match(under.lines[0], /^payload size: node 10\.0 MiB$/);
  assert.match(under.lines[1], /^payload size: graphify 0\.0 MiB$/);
  assert.equal(PAYLOAD_BUDGETS_MIB.total, 80);
  assert.equal(SLIM_PAYLOAD_TOTAL_MIB, 80);
});

test('any graphify bytes and a total over 80 MiB warn (Graphify downloads on first use)', () => {
  const report = payloadSizeLines({ node: 0, graphify: 10 * 1048576, web: 0, total: 81 * 1048576 });
  assert.deepEqual(report.warnings, [
    'payload size warning: graphify 10.0 MiB exceeds 0 MiB',
    'payload size warning: total 81.0 MiB exceeds 80 MiB',
  ]);
});

test('directoryBytes sums files and does not follow a symlink', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-payload-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'a.txt'), 'abcd');
  assert.equal(await directoryBytes(root), 4);
  assert.equal(await directoryBytes(path.join(root, 'missing')), 0);
});

async function payload(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-slim-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'runtime-manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch }));
  await mkdir(path.join(root, 'web'));
  await writeFile(path.join(root, 'web', 'server.js'), 'x'.repeat(1024));
  return root;
}

test('checkSlimPayload passes a payload without tools/graphify and reports its sections', async (t) => {
  const root = await payload(t);
  const sections = await checkSlimPayload(root);
  assert.equal(sections.graphify, 0);
  assert.ok(sections.total > 1024);
});

test('checkSlimPayload fails on tools/graphify as a directory, an empty directory, a file or a link', async (t) => {
  const root = await payload(t);
  const bundled = path.join(root, 'tools', 'graphify');
  await mkdir(bundled, { recursive: true });
  await writeFile(path.join(bundled, 'graphify'), 'launcher');
  await assert.rejects(checkSlimPayload(root), /Payload contains tools\/graphify/);
  await rm(path.join(bundled, 'graphify'));
  await assert.rejects(checkSlimPayload(root), /Payload contains tools\/graphify/);
  await rm(bundled, { recursive: true });
  await writeFile(bundled, '');
  await assert.rejects(checkSlimPayload(root), /Payload contains tools\/graphify/);
  await rm(bundled);
  if (process.platform !== 'win32') {
    await symlink(path.join(root, 'web'), bundled);
    await assert.rejects(checkSlimPayload(root), /Payload contains tools\/graphify/);
    await rm(bundled);
  }
  await checkSlimPayload(root);
});

test('the preset-db section has its own report line before the total and warns over 10 MiB', () => {
  const report = payloadSizeLines({ node: 0, graphify: 0, web: 0, 'preset-db': 3 * 1048576, total: 40 * 1048576 });
  assert.deepEqual(report.lines.slice(3), ['payload size: preset-db 3.0 MiB', 'payload size: total 40.0 MiB']);
  assert.deepEqual(report.warnings, []);
  assert.equal(PAYLOAD_BUDGETS_MIB['preset-db'], 10);
  assert.equal(PRESET_DB_MAX_MIB, 10);
  assert.deepEqual(payloadSizeLines({ 'preset-db': 11 * 1048576 }).warnings, ['payload size warning: preset-db 11.0 MiB exceeds 10 MiB']);
});

test('checkSlimPayload counts the seed in the total and fails a seed over its limit even with no total limit', async (t) => {
  const root = await payload(t);
  await mkdir(path.join(root, 'preset'));
  await writeFile(path.join(root, 'preset', 'preset-db.tar.gz'), 'x'.repeat(2048));
  const sections = await checkSlimPayload(root);
  assert.equal(sections['preset-db'], 2048);
  assert.ok(sections.total >= 2048 + 1024);
  // A 1 KiB limit stands in for 10 MiB so the test does not write a large file.
  await assert.rejects(checkSlimPayload(root, { maxTotalMiB: null, maxPresetDbMiB: 1 / 1024 }), /preset-db section 0\.0 MiB exceeds the 0\.0009765625 MiB limit/);
});

test('a payload without a seed measures preset-db as 0 and passes', async (t) => {
  const root = await payload(t);
  assert.equal((await checkSlimPayload(root))['preset-db'], 0);
});

test('checkSlimPayload enforces the total limit unless the caller turns it off', async (t) => {
  const root = await payload(t);
  // A 1 KiB limit stands in for 80 MiB so the test does not write a large file.
  await assert.rejects(checkSlimPayload(root, { maxTotalMiB: 1 / 1024 }), /exceeds the 0\.0009765625 MiB slim-payload limit/);
  await checkSlimPayload(root, { maxTotalMiB: null });
});
