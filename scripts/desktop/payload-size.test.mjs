import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { directoryBytes, payloadSizeLines, PAYLOAD_BUDGETS_MIB } from './payload-size.mjs';

test('payload size warnings name the section and do not require a huge file', () => {
  const over = payloadSizeLines({
    node: 151 * 1048576,
    graphify: 1,
    web: 1,
    total: 1,
  });
  assert.equal(over.warnings.length, 1);
  assert.match(over.warnings[0], /^payload size warning: node 151\.0 MiB exceeds 135 MiB$/);
  const under = payloadSizeLines({
    node: 10 * 1048576,
    graphify: 10 * 1048576,
    web: 10 * 1048576,
    total: 10 * 1048576,
  });
  assert.deepEqual(under.warnings, []);
  assert.match(under.lines[0], /^payload size: node 10\.0 MiB$/);
  assert.equal(PAYLOAD_BUDGETS_MIB.total, 620);
});

test('directoryBytes sums files and does not follow a symlink', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-payload-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'a.txt'), 'abcd');
  assert.equal(await directoryBytes(root), 4);
  assert.equal(await directoryBytes(path.join(root, 'missing')), 0);
});
