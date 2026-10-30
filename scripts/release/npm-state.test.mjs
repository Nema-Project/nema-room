import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, npmPublishState, tarballIntegrity } from './npm-state.mjs';

const EXPECTED = 'sha512-tPeM3qLsKaAr/Y46xo6sjo/RpD6AvQaIL4z/FHpml19/7qPDR9R2itNhlBoL+TJuyfgTJlBSKam+az4K+KTLIQ==';
const OTHER = 'sha512-WBQM9fuLkpBn60cFcU9GUnOBEyhwVxbOpyle0gD/abK/W01QtcFtEsDGj3RZYWrpP2UxasHjQ2plCE6FrzLYdg==';
const URL_0_1_7 = 'https://registry.npmjs.org/@nema-project/nema/0.1.7';
const reply = (status, body) => async (url) => {
  assert.equal(url, URL_0_1_7, 'asks for the exact package version');
  return { status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
};

test('404 is absent, equal integrity is same, another integrity is different', async () => {
  assert.equal((await npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(404, {}) })).state, 'absent');
  assert.equal((await npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(200, { version: '0.1.7', dist: { integrity: EXPECTED } }) })).state, 'same');
  const different = await npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(200, { version: '0.1.7', dist: { integrity: OTHER } }) });
  assert.equal(different.state, 'different');
  assert.equal(different.integrity, OTHER);
});

test('an unanswered or unreadable registry throws instead of looking absent', async () => {
  for (const fetchImpl of [reply(500, {}), reply(401, {}), reply(200, '{oops'), reply(200, { version: '0.1.8' }), async () => { throw new TypeError('fetch failed'); }]) {
    await assert.rejects(npmPublishState({ version: '0.1.7', expectedIntegrity: EXPECTED, fetchImpl }), /cannot tell whether @nema-project\/nema@0\.1\.7 exists/);
  }
});

test('inputs are strict', async () => {
  await assert.rejects(npmPublishState({ version: 'v0.1.7', expectedIntegrity: EXPECTED, fetchImpl: reply(404, {}) }));
  for (const bad of ['sha1-AAAA', 'sha512-AAAA', `${EXPECTED.slice(0, -4)}AA==`.replace(/.{2}==$/, '=='), `sha512-${Buffer.alloc(48).toString('base64')}`, `${EXPECTED} `]) {
    await assert.rejects(npmPublishState({ version: '0.1.7', expectedIntegrity: bad, fetchImpl: reply(404, {}) }), /sha512/, bad);
  }
});

test('only canonical base64 counts: unused padding bits set would never equal npm\'s own form', async () => {
  // Same 64 bytes as EXPECTED, but the last base64 char before == carries non-zero unused bits.
  const tail = EXPECTED.at(-3);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const noncanonical = `${EXPECTED.slice(0, -3)}${alphabet[alphabet.indexOf(tail) + 1]}==`;
  assert.deepEqual(Buffer.from(noncanonical.slice(7), 'base64'), Buffer.from(EXPECTED.slice(7), 'base64'));
  await assert.rejects(npmPublishState({ version: '0.1.7', expectedIntegrity: noncanonical, fetchImpl: reply(404, {}) }), /sha512/);
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
  assert.equal(await main(['0.1.7', EXPECTED], { fetchImpl: reply(200, { version: '0.1.7', dist: { integrity: OTHER } }), stdout: sink(), stderr: sink() }), 3);
  out = sink();
  assert.equal(await main(['0.1.7', EXPECTED], { fetchImpl: reply(200, { version: '0.1.7', dist: { integrity: EXPECTED } }), stdout: out, stderr: sink() }), 0);
  assert.equal(out.text, 'same\n');
  assert.equal(await main(['0.1.7', EXPECTED], { fetchImpl: reply(503, {}), stdout: sink(), stderr: sink() }), 2);
  assert.equal(await main(['0.1.7'], { stdout: sink(), stderr: sink() }), 2);
});
