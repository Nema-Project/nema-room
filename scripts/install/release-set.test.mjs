import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseSetItems, checkReleaseSet } from './release-set.mjs';
import { renderComposeAsset } from '../images/check-images.mjs';

const root = path.dirname(fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)));
const template = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const assetFor = (version) => renderComposeAsset(template, version);

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() {
    if (body === undefined) throw new SyntaxError('Unexpected token');
    return body;
  },
});

/** Fake fetch: a token endpoint, an npm registry, and GHCR manifests keyed by repository. */
function fakeFetch({ npm = 'ok', hub = 'ok', web = 'ok', token = 'ok', throwing = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (throwing) throw new TypeError('fetch failed');
    if (String(url).startsWith('https://ghcr.io/token')) {
      if (token !== 'ok') return jsonResponse(token === 'missing-token' ? { access_token: 'x' } : undefined, 200);
      return jsonResponse({ token: 'anonymous-token' });
    }
    if (String(url).startsWith('https://registry.npmjs.org/')) {
      if (npm === '404') return jsonResponse({ error: 'Not found' }, 404);
      if (npm === 'wrong-version') return jsonResponse({ version: '9.9.9' });
      return jsonResponse({ version: url.split('/').pop() });
    }
    if (String(url).startsWith('https://ghcr.io/v2/')) {
      assert.ok(init.headers?.Authorization === 'Bearer anonymous-token', 'GHCR manifest needs the anonymous token');
      const repository = String(url).includes('nema-room-hub') ? 'hub' : 'web';
      const outcome = repository === 'hub' ? hub : web;
      if (outcome === '404') return jsonResponse({}, 404);
      if (outcome === '403') return jsonResponse({}, 403);
      return jsonResponse({ schemaVersion: 2 });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { fetchImpl, calls };
}

test('four artifacts produce one evidence line each', async () => {
  const version = '1.2.3';
  const items = releaseSetItems(version);
  assert.equal(items.length, 4);
  const { fetchImpl } = fakeFetch();
  const result = await checkReleaseSet({ version, composeText: assetFor(version), fetchImpl });
  assert.equal(result.version, version);
  assert.equal(result.evidence.length, 4);
  for (const item of items) assert.ok(result.evidence.some((line) => line.includes(item)), `evidence covers ${item}`);
});

test('a missing npm version names the exact package', async () => {
  const version = '1.2.3';
  const { fetchImpl } = fakeFetch({ npm: '404' });
  await assert.rejects(
    checkReleaseSet({ version, composeText: assetFor(version), fetchImpl }),
    /npm @nema-project\/nema@1\.2\.3/,
  );
});

test('a missing hub image and a forbidden web image are both reported', async () => {
  const version = '1.2.3';
  const { fetchImpl } = fakeFetch({ hub: '404', web: '403' });
  await assert.rejects(checkReleaseSet({ version, composeText: assetFor(version), fetchImpl }), (error) => {
    assert.match(error.message, /hub image/);
    assert.match(error.message, /web image/);
    return true;
  });
});

test('a compose pin for another version counts as missing and names the actual value', async () => {
  const version = '1.2.3';
  const { fetchImpl } = fakeFetch();
  await assert.rejects(
    checkReleaseSet({ version, composeText: assetFor('1.2.4'), fetchImpl }),
    /compose asset.*1\.2\.4/,
  );
});

test('several missing items are listed in one error', async () => {
  const version = '1.2.3';
  const { fetchImpl } = fakeFetch({ npm: '404', hub: '404', web: '403' });
  await assert.rejects(checkReleaseSet({ version, composeText: assetFor('1.2.4'), fetchImpl }), (error) => {
    for (const item of releaseSetItems(version)) assert.ok(error.message.includes(item), `error names ${item}`);
    assert.equal(error.message.split('; ').length, 4);
    return true;
  });
});

test('a network failure is never evidence that an artifact exists', async () => {
  const version = '1.2.3';
  const { fetchImpl } = fakeFetch({ throwing: true });
  await assert.rejects(checkReleaseSet({ version, composeText: assetFor(version), fetchImpl }), /not installable/);
});

test('a token response without a token field counts as missing', async () => {
  const version = '1.2.3';
  const { fetchImpl } = fakeFetch({ token: 'missing-token' });
  await assert.rejects(checkReleaseSet({ version, composeText: assetFor(version), fetchImpl }), /hub image/);
});

test('the npm request keeps the scope slash unencoded', async () => {
  const version = '1.2.3';
  const { fetchImpl, calls } = fakeFetch();
  await checkReleaseSet({ version, composeText: assetFor(version), fetchImpl });
  assert.ok(calls.includes('https://registry.npmjs.org/@nema-project/nema/1.2.3'), calls.join('\n'));
});

test('both GHCR manifests are requests for the anonymous token', async () => {
  const version = '1.2.3';
  const { fetchImpl, calls } = fakeFetch();
  await checkReleaseSet({ version, composeText: assetFor(version), fetchImpl });
  assert.ok(calls.some((url) => url.includes('scope=repository:nema-project/nema-room-hub:pull')));
  assert.ok(calls.some((url) => url.includes('scope=repository:nema-project/nema-room-web:pull')));
  assert.ok(calls.includes(`https://ghcr.io/v2/nema-project/nema-room-hub/manifests/${version}`));
  assert.ok(calls.includes(`https://ghcr.io/v2/nema-project/nema-room-web/manifests/${version}`));
});
