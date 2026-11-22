import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./startup-sample.mjs', import.meta.url));

test('startup sample child modes for the preset seed require both paths', () => {
  for (const args of [['generate', '/tmp/seed'], ['preset', '/tmp/preset-db.tar.gz'], ['preset', 'a', 'b', 'c']]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(run.status, 0, args.join(' '));
    assert.match(`${run.stderr}`, /usage: .*generate <seedDir> <archive> \| preset <archive> <dir>/);
  }
});

test('startup sample rejects an explicit home', () => {
  const run = spawnSync(process.execPath, [script, '--home', '/tmp/not-a-user-home'], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stderr}`, /usage/i);
});
