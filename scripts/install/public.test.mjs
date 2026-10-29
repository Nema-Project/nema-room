import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir, hostname as osHostRaw } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveInstall, applyInstall, interruptedInstall, latestComposeUrl, parseInstallArgs, versionedComposeUrl } from './public.mjs';
import { renderComposeAsset, composeAssetVersion } from '../images/check-images.mjs';

const template = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
const assetFor = (version) => renderComposeAsset(template, version);
const dirOf = (file) => path.dirname(fileURLToPath(new URL('../../docker-compose.yml', import.meta.url)));

const healthyFetch = async (url) => {
  if (String(url).startsWith('https://ghcr.io/token')) return { status: 200, ok: true, json: async () => ({ token: 't' }) };
  if (String(url).startsWith('https://registry.npmjs.org/')) return { status: 200, ok: true, json: async () => ({ version: String(url).split('/').pop() }) };
  if (String(url).startsWith('https://ghcr.io/v2/')) return { status: 200, ok: true, json: async () => ({ schemaVersion: 2 }) };
  throw new Error(`unexpected ${url}`);
};

/** Records each URL and answers with the given compose bytes for both the latest and versioned URL. */
function fakeFetchText(map) {
  const calls = [];
  const fetchText = async (url) => {
    calls.push(String(url));
    const entry = map[String(url)];
    if (entry === undefined) throw new Error(`404 not found: ${url}`);
    return entry;
  };
  return { fetchText, calls };
}

/** A plan for a directory whose state is stated up front, so presence is never an afterthought. */
function planIn(dir, fields, { envPresent = false, composePresent = false } = {}) {
  return {
    action: 'write', composeSource: 'latest', daemonCommand: '', notes: [],
    envPath: path.join(dir, '.env'), composePath: path.join(dir, 'docker-compose.yml'),
    envPresent, composePresent, ...fields,
  };
}

async function tmp(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nema-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const osHost = () => osHostRaw();

const readIf = async (file) => {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

test('a clean directory locks the latest version and writes both files', async (t) => {
  const dir = await tmp(t);
  const { fetchText, calls } = fakeFetchText({ [latestComposeUrl]: assetFor('1.2.3') });
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });

  assert.equal(plan.version, '1.2.3');
  assert.equal(plan.action, 'write');
  assert.equal(plan.composeSource, 'latest');
  assert.deepEqual(calls, [latestComposeUrl]);
  assert.match(plan.daemonCommand, /npm i -g @nema-project\/nema@1\.2\.3/);

  await applyInstall({ dir, plan });

  const env = await readFile(path.join(dir, '.env'), 'utf8');
  assert.match(env, /^NEMA_IMAGE_TAG=1\.2\.3$/m);
  assert.equal(await readFile(path.join(dir, 'docker-compose.yml'), 'utf8'), plan.composeText);
  assert.equal(composeAssetVersion(await readFile(path.join(dir, 'docker-compose.yml'), 'utf8')), '1.2.3');
});

test('applyInstall makes no network request and writes the resolved bytes verbatim', async (t) => {
  const dir = await tmp(t);
  const composeText = assetFor('2.0.0');
  const resolveDir = await tmp(t);
  let requests = 0;
  const counted = async (url) => { requests += 1; return healthyFetch(url); };
  const plan = await resolveInstall({ dir: resolveDir, fetchText: async () => composeText, fetchImpl: counted });
  // The resolve leg is allowed to talk to the registries; from here on nothing may. Watching the
  // injected fetch alone would miss a regression that reaches for globalThis.fetch by name, so the
  // global one is replaced as well and any call through it fails the test.
  const before = requests;
  const realFetch = globalThis.fetch;
  let globalCalls = 0;
  globalThis.fetch = async (...args) => { globalCalls += 1; throw new Error(`applyInstall reached globalThis.fetch for ${args[0]}`); };
  t.after(() => { globalThis.fetch = realFetch; });
  assert.equal(plan.composeText, composeText);
  await applyInstall({ dir, plan });
  assert.equal(requests, before, 'applyInstall must not use the injected fetch');
  assert.equal(globalCalls, 0, 'applyInstall must not reach globalThis.fetch');
  assert.equal(await readFile(path.join(dir, 'docker-compose.yml'), 'utf8'), composeText);
});

test('an existing lock reuses that version and never asks for latest', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.2\n');
  const { fetchText, calls } = fakeFetchText({ [versionedComposeUrl('1.2.2')]: assetFor('1.2.2') });
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });

  assert.equal(plan.action, 'reuse');
  assert.equal(plan.composeSource, 'versioned');
  assert.equal(plan.version, '1.2.2');
  assert.deepEqual(calls, [versionedComposeUrl('1.2.2')]);
  assert.ok(!calls.some((url) => url.includes('/latest/')), calls.join('\n'));
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), 'NEMA_IMAGE_TAG=1.2.2\n');
});

test('a versioned asset that pins another version is refused and nothing is written', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.2\n');
  const { fetchText } = fakeFetchText({ [versionedComposeUrl('1.2.2')]: assetFor('1.2.4') });
  await assert.rejects(resolveInstall({ dir, fetchText, fetchImpl: healthyFetch }), /1\.2\.4/);
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), 'NEMA_IMAGE_TAG=1.2.2\n');
  assert.equal(await readIf(path.join(dir, 'docker-compose.yml')), null);
});

test('an unusable existing value is refused by name and left alone', async (t) => {
  for (const bad of ['latest', 'v1.2.3', '', 'not-a-version', '1.2']) {
    const dir = await tmp(t);
    const original = `OTHER=1\nNEMA_IMAGE_TAG=${bad}\n`;
    await writeFile(path.join(dir, '.env'), original);
    await assert.rejects(resolveInstall({ dir, fetchText: async () => assetFor('1.2.3'), fetchImpl: healthyFetch }), /NEMA_IMAGE_TAG/, `value ${JSON.stringify(bad)}`);
    assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), original);
  }
});

test('other keys and comments survive the write byte for byte', async (t) => {
  const dir = await tmp(t);
  const original = '# my notes\nNEMA_HUB_PORT=4500\nNEMA_DATA_DIR=/tmp/x\n';
  await writeFile(path.join(dir, '.env'), original);
  const { fetchText } = fakeFetchText({ [latestComposeUrl]: assetFor('3.1.4') });
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
  assert.equal(plan.action, 'write');
  await applyInstall({ dir, plan });
  const after = await readFile(path.join(dir, '.env'), 'utf8');
  assert.ok(after.startsWith(original), after);
  assert.match(after, /^NEMA_IMAGE_TAG=3\.1\.4$/m);
});

test('compose pins that disagree are refused before any write', async (t) => {
  const dir = await tmp(t);
  const mismatched = assetFor('1.2.3').replace('nema-room-hub:1.2.3', 'nema-room-hub:1.2.4');
  const { fetchText } = fakeFetchText({ [latestComposeUrl]: mismatched });
  await assert.rejects(resolveInstall({ dir, fetchText, fetchImpl: healthyFetch }));
  assert.equal(await readIf(path.join(dir, '.env')), null);
});

test('a missing release artifact refuses the whole install', async (t) => {
  const dir = await tmp(t);
  const { fetchText } = fakeFetchText({ [latestComposeUrl]: assetFor('1.2.3') });
  const brokenNpm = async (url) => (String(url).startsWith('https://registry.npmjs.org/') ? { status: 404, ok: false, json: async () => ({}) } : healthyFetch(url));
  await assert.rejects(resolveInstall({ dir, fetchText, fetchImpl: brokenNpm }), /npm @nema-project\/nema@1\.2\.3/);
  assert.equal(await readIf(path.join(dir, '.env')), null);
});

test('check mode resolves without writing anything', async (t) => {
  const dir = await tmp(t);
  const { fetchText } = fakeFetchText({ [latestComposeUrl]: assetFor('1.2.3') });
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
  assert.equal(plan.action, 'write');
  assert.deepEqual(await readdir(dir), []);
});

test('a local compose file wins and is never overwritten', async (t) => {
  const dir = await tmp(t);
  const local = assetFor('1.2.3');
  await writeFile(path.join(dir, 'docker-compose.yml'), local);
  const { fetchText, calls } = fakeFetchText({});
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
  assert.equal(plan.composeSource, 'local');
  assert.deepEqual(calls, []);
  await applyInstall({ dir, plan });
  assert.equal(await readFile(path.join(dir, 'docker-compose.yml'), 'utf8'), local);
});

test('a local compose file on another version is refused', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.2\n');
  await writeFile(path.join(dir, 'docker-compose.yml'), assetFor('1.2.4'));
  const { fetchText } = fakeFetchText({});
  await assert.rejects(resolveInstall({ dir, fetchText, fetchImpl: healthyFetch }), /1\.2\.4/);
});

test('an install lock blocks a second install', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.nema-install.lock'), 'busy');
  const plan = planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') });
  await assert.rejects(applyInstall({ dir, plan }), /another install is already running/);
  assert.equal(await readIf(path.join(dir, '.env')), null);
  assert.equal(await readIf(path.join(dir, 'docker-compose.yml')), null);
});

test('two concurrent installs cannot both win', async (t) => {
  const dir = await tmp(t);
  const results = await Promise.allSettled([
    applyInstall({ dir, plan: planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') }) }),
    applyInstall({ dir, plan: planIn(dir, { version: '1.2.4', composeText: assetFor('1.2.4') }) }),
  ]);
  const ok = results.filter((row) => row.status === 'fulfilled');
  assert.ok(ok.length <= 1, 'at most one install may succeed');
  if (ok.length === 1) {
    const compose = await readFile(path.join(dir, 'docker-compose.yml'), 'utf8');
    const env = await readFile(path.join(dir, '.env'), 'utf8');
    assert.equal(composeAssetVersion(compose), env.match(/^NEMA_IMAGE_TAG=(.+)$/m)[1]);
  }
});

test('the lock is removed on success and on failure', async (t) => {
  const dir = await tmp(t);
  const plan = planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') });
  await applyInstall({ dir, plan });
  assert.equal(await readIf(path.join(dir, '.nema-install.lock')), null);
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=9.9.9\n');
  const settled = planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3'), action: 'reuse' }, { envPresent: true, composePresent: true });
  await assert.rejects(applyInstall({ dir, plan: settled }), /changed while installing/);
  assert.equal(await readIf(path.join(dir, '.nema-install.lock')), null);
});

test('a value written by someone else between resolve and apply aborts the whole patch', async (t) => {
  const dir = await tmp(t);
  const plan = planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') });
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=7.7.7\n');
  await assert.rejects(applyInstall({ dir, plan }), /changed|another install/i);
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), 'NEMA_IMAGE_TAG=7.7.7\n');
  assert.equal(await readIf(path.join(dir, 'docker-compose.yml')), null);
});

test('reuse with both files already in place writes nothing', async (t) => {
  const dir = await tmp(t);
  const composeText = assetFor('1.2.2');
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.2\n');
  await writeFile(path.join(dir, 'docker-compose.yml'), composeText);
  const envStat = await stat(path.join(dir, '.env'));
  const composeStat = await stat(path.join(dir, 'docker-compose.yml'));
  const plan = planIn(dir, { version: '1.2.2', action: 'reuse', composeText, composeSource: 'versioned' }, { envPresent: true, composePresent: true });
  await applyInstall({ dir, plan });
  assert.equal((await stat(path.join(dir, '.env'))).mtimeMs, envStat.mtimeMs);
  assert.equal((await stat(path.join(dir, 'docker-compose.yml'))).mtimeMs, composeStat.mtimeMs);
});

test('a reuse plan never downgrades or rewrites an equal lock', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.2\n');
  const { fetchText } = fakeFetchText({ [versionedComposeUrl('1.2.2')]: assetFor('1.2.2') });
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
  assert.ok(plan.notes.some((line) => line.includes('1.2.2')), plan.notes.join('\n'));
  await applyInstall({ dir, plan });
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), 'NEMA_IMAGE_TAG=1.2.2\n');
});

test('no temporary files survive a successful install', async (t) => {
  const dir = await tmp(t);
  const plan = planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') });
  await applyInstall({ dir, plan });
  const rows = await readdir(dir);
  assert.deepEqual(rows.sort(), ['.env', 'docker-compose.yml']);
});

test('a lock Compose would read differently from the installer is refused', async (t) => {
  // Compose takes the last assignment of a repeated key. Reading only the first would verify one
  // version and run another.
  const dir = await tmp(t);
  const original = 'NEMA_IMAGE_TAG=1.2.3\nNEMA_IMAGE_TAG=1.2.4\n';
  await writeFile(path.join(dir, '.env'), original);
  await assert.rejects(resolveInstall({ dir, fetchText: async () => assetFor('1.2.3'), fetchImpl: healthyFetch }), /more than once/);
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), original);
});

test('a repeated lock that already agrees is accepted and collapsed to one line', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.env'), 'OTHER=1\nNEMA_IMAGE_TAG=1.2.3\nNEMA_IMAGE_TAG=1.2.3\n');
  const { fetchText } = fakeFetchText({ [versionedComposeUrl('1.2.3')]: assetFor('1.2.3') });
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
  await applyInstall({ dir, plan });
  const after = await readFile(path.join(dir, '.env'), 'utf8');
  assert.equal(after.match(/^NEMA_IMAGE_TAG=/gm).length, 2, after);
});

test('inline comments and quotes are read the way Compose reads them', async (t) => {
  for (const line of ['NEMA_IMAGE_TAG=1.2.3 # pinned by hand', 'NEMA_IMAGE_TAG="1.2.3"', "NEMA_IMAGE_TAG='1.2.3'"]) {
    const dir = await tmp(t);
    await writeFile(path.join(dir, '.env'), `# notes\n${line}\n`);
    const { fetchText, calls } = fakeFetchText({ [versionedComposeUrl('1.2.3')]: assetFor('1.2.3') });
    const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
    assert.equal(plan.version, '1.2.3', line);
    assert.deepEqual(calls, [versionedComposeUrl('1.2.3')], line);
  }
});

test('a prerelease lock is refused by name', async (t) => {
  const dir = await tmp(t);
  const original = 'NEMA_IMAGE_TAG=1.2.3-rc.1\n';
  await writeFile(path.join(dir, '.env'), original);
  await assert.rejects(resolveInstall({ dir, fetchText: async () => assetFor('1.2.3'), fetchImpl: healthyFetch }), /prerelease/);
  assert.equal(await readFile(path.join(dir, '.env'), 'utf8'), original);
});

test('a local compose file that already matches the lock is not rewritten', async (t) => {
  const dir = await tmp(t);
  const local = assetFor('1.2.3');
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.3\n');
  await writeFile(path.join(dir, 'docker-compose.yml'), local);
  const before = await stat(path.join(dir, 'docker-compose.yml'));
  const { fetchText, calls } = fakeFetchText({});
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
  assert.equal(plan.composeSource, 'local');
  assert.deepEqual(calls, []);
  await applyInstall({ dir, plan });
  const after = await stat(path.join(dir, 'docker-compose.yml'));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(path.join(dir, 'docker-compose.yml'), 'utf8'), local);
});

test('a matching local compose file still needs the release set to exist', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.3\n');
  await writeFile(path.join(dir, 'docker-compose.yml'), assetFor('1.2.3'));
  const brokenNpm = async (url) => (String(url).startsWith('https://registry.npmjs.org/') ? { status: 404, ok: false, json: async () => ({}) } : healthyFetch(url));
  await assert.rejects(resolveInstall({ dir, fetchText: async () => { throw new Error('must not fetch'); }, fetchImpl: brokenNpm }), /npm @nema-project\/nema@1\.2\.3/);
});

test('a file that disappears between resolve and apply aborts instead of being restored', async (t) => {
  const dir = await tmp(t);
  const plan = planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') }, { envPresent: true });
  await assert.rejects(applyInstall({ dir, plan }), /disappeared/);
  assert.equal(await readIf(path.join(dir, '.env')), null);
  assert.equal(await readIf(path.join(dir, 'docker-compose.yml')), null);
});

test('an abandoned lock is cleared and the install proceeds', async (t) => {
  const dir = await tmp(t);
  // A lock written by a pid that cannot be running here: the owner is gone, so the next install must
  // not be blocked forever by a crash nobody cleaned up after.
  await writeFile(path.join(dir, '.nema-install.lock'), JSON.stringify({ pid: 999999, host: osHost(), version: '1.2.3', startedAt: new Date().toISOString() }));
  const plan = planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') });
  await applyInstall({ dir, plan });
  assert.equal(await readIf(path.join(dir, '.nema-install.lock')), null);
  assert.equal(composeAssetVersion(await readFile(path.join(dir, 'docker-compose.yml'), 'utf8')), '1.2.3');
});

test('an install interrupted between its two renames is finished at the version it was committing', async (t) => {
  const dir = await tmp(t);
  // The state a killed process leaves: `.env` already on the new version, compose still missing, the
  // lock still on disk. The retry must complete that version, never fall back to latest.
  await writeFile(path.join(dir, '.env'), 'NEMA_IMAGE_TAG=1.2.3\n');
  await writeFile(path.join(dir, '.nema-install.lock'), JSON.stringify({ pid: 999999, host: osHost(), version: '1.2.3', startedAt: new Date().toISOString() }));
  assert.equal(interruptedInstall(dir), '1.2.3');
  const { fetchText, calls } = fakeFetchText({ [versionedComposeUrl('1.2.3')]: assetFor('1.2.3') });
  const plan = await resolveInstall({ dir, fetchText, fetchImpl: healthyFetch });
  assert.deepEqual(calls, [versionedComposeUrl('1.2.3')]);
  assert.ok(plan.notes.some((line) => /interrupted/i.test(line)), plan.notes.join('\n'));
  await applyInstall({ dir, plan });
  assert.equal(composeAssetVersion(await readFile(path.join(dir, 'docker-compose.yml'), 'utf8')), '1.2.3');
  assert.equal(await readIf(path.join(dir, '.nema-install.lock')), null);
});

test('a lock held by a live process is left alone', async (t) => {
  const dir = await tmp(t);
  await writeFile(path.join(dir, '.nema-install.lock'), JSON.stringify({ pid: process.pid, host: osHost(), version: '1.2.3' }));
  assert.equal(interruptedInstall(dir), null);
  await assert.rejects(applyInstall({ dir, plan: planIn(dir, { version: '1.2.3', composeText: assetFor('1.2.3') }) }), /another install is already running/);
  assert.ok(await readIf(path.join(dir, '.nema-install.lock')) !== null, 'the live lock must survive');
});

test('the command line accepts exactly the documented flags', () => {
  const defaults = parseInstallArgs([]);
  assert.equal(defaults.check, false);
  assert.equal(defaults.lang, 'en');
  assert.equal(defaults.dir, process.cwd());

  const explicit = parseInstallArgs(['--check', '--dir', 'some/dir', '--lang', 'zh']);
  assert.equal(explicit.check, true);
  assert.equal(explicit.lang, 'zh');
  assert.equal(explicit.dir, path.resolve('some/dir'));

  assert.throws(() => parseInstallArgs(['--dir']), /--dir/);
  assert.throws(() => parseInstallArgs(['--lang', 'fr']), /--lang/);
  assert.throws(() => parseInstallArgs(['--nope']), /unknown argument/);
});
