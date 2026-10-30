import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, npmPublishState, tarballIntegrity } from './npm-state.mjs';

const EXPECTED = 'sha512-AAAA';
const reply = (status, body) => async () => ({ status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

test('404 is absent, equal integrity is same, another integrity is different', async () => {
  assert.equal((await npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(404, {}) })).state, 'absent');
  assert.equal((await npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(200, { version: '0.1.7', dist: { integrity: EXPECTED } }) })).state, 'same');
  const different = await npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(200, { version: '0.1.7', dist: { integrity: 'sha512-BBBB' } }) });
  assert.equal(different.state, 'different');
  assert.equal(different.integrity, 'sha512-BBBB');
});

test('an unanswered or unreadable registry throws instead of looking absent', async () => {
  for (const fetchImpl of [reply(500, {}), reply(401, {}), reply(200, '{oops'), reply(200, { version: '0.1.8' }), async () => { throw new TypeError('fetch failed'); }]) {
    await assert.rejects(npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl }), /cannot tell whether @nema-project\/nema@0\.1\.7 exists/);
  }
});

test('inputs are strict', async () => {
  await assert.rejects(npmPublishState({ version: 'v0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(404, {}) }));
  await assert.rejects(npmPublishState({ version: '0.1.7', expectedIntegrity: 'sha1-AAAA', fetchImpl: reply(404, {}) }), /sha512/);
});

test('tarballIntegrity matches the npm dist.integrity form', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'npm-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'a.tgz'), 'tarball');
  // printf tarball | openssl dgst -sha512 -binary | base64
  assert.equal(await tarballIntegrity(join(dir, 'a.tgz')), 'sha512-WBQM9fuLkpBn60cFcU9GUnOBEyhwVxbOpyle0gD/abK/W01QtcFtEsDGj3RZYWrpP2UxasHjQ2plCE6FrzLYdg==');
});

test('CLI exit codes: 0 for absent and same, 3 for different, 2 for cannot tell', async () => {
  const sink = () => ({ text: '', write(value) { this.text += value; } });
  let out = sink();
  assert.equal(await main(['0.1.7', EXPECTED], { fetchImpl: reply(404, {}), stdout: out, stderr: sink() }), 0);
  assert.equal(out.text, 'absent\n');
  assert.equal(await main(['0.1.7', EXPECTED], { fetchImpl: reply(200, { version: '0.1.7', dist: { integrity: 'sha512-BBBB' } }), stdout: sink(), stderr: sink() }), 3);
  assert.equal(await main(['0.1.7', EXPECTED], { fetchImpl: reply(503, {}), stdout: sink(), stderr: sink() }), 2);
  assert.equal(await main(['0.1.7'], { stdout: sink(), stderr: sink() }), 2);
});
