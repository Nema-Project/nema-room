import assert from 'node:assert/strict';
import test from 'node:test';
import { promote } from './promote.mjs';

const COMMIT = 'a'.repeat(40);
const INTEGRITY = 'sha512-EXPECTED';
const v = (version) => ({ state: 'version', version });
const ABSENT = { state: 'absent', version: null };

/** A small world: registry state plus a log of every write, in order. */
function world({ version = '0.1.7', npm = 'absent', hub = v('0.1.6'), web = v('0.1.6'), github = v('0.1.6'), draft = true, fail = {}, tagMovesAt = null } = {}) {
  const state = { npm, hub, web, github, draft, writes: [], tagChecks: 0 };
  const boom = (name) => {
    if (fail[name]) throw new Error(`${name} failed`);
  };
  const io = {
    async expectedIntegrity() { boom('expectedIntegrity'); return INTEGRITY; },
    async verify({ stage, expectedIntegrity }) {
      boom(`verify-${stage}`);
      if (stage === 'candidate') assert.equal(expectedIntegrity, INTEGRITY);
      const ok = stage === 'candidate' ? state.npm !== 'different' : state.npm === 'same';
      return { exitCode: ok ? 0 : 1, overall: ok ? 'complete' : 'incomplete' };
    },
    async npmState() { boom('npmState'); return state.npm; },
    async dispatchNpm() { boom('dispatchNpm'); state.writes.push('npm dispatch'); return { id: 42 }; },
    async waitNpm({ id }) { assert.equal(id, 42); boom('waitNpm'); state.npm = 'same'; },
    async readPointers() {
      boom('readPointers');
      return { npm: { latest: v('0.1.6'), next: ABSENT }, ghcr: { hub: state.hub, web: state.web }, github: { latest: state.github } };
    },
    async moveGhcrLatest({ target, version: next }) { boom(`move-${target}`); state.writes.push(`ghcr ${target} latest`); state[target] = v(next); },
    async releaseState() { return { draft: state.draft }; },
    async publishRelease(options) { boom('publishRelease'); state.writes.push(`release ${JSON.stringify(options)}`); state.draft = false; },
    async verifyRemoteTag({ tag, commit }) {
      assert.equal(commit, COMMIT);
      state.tagChecks += 1;
      if (tagMovesAt !== null && state.tagChecks >= tagMovesAt) throw new Error(`${tag} moved`);
    },
  };
  return { state, io };
}

async function run(options = {}, version = options.version ?? '0.1.7') {
  const { state, io } = world(options);
  const lines = [];
  const result = await promote({ version, tag: `v${version}`, commit: COMMIT, io, summary: (line) => lines.push(line) });
  return { result, state, text: lines.join('\n') };
}

test('all steps in order: npm, hub latest, web latest, then the Release as latest', async () => {
  const { result, state, text } = await run();
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest', 'ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.match(text, /npm 0\.1\.7: published by run 42/);
  assert.match(text, /ghcr hub latest: 0\.1\.6 -> 0\.1\.7/);
  assert.match(text, /GitHub Release v0\.1\.7: published, latest=true/);
  assert.match(text, /promote v0\.1\.7: done/);
});

test('an npm failure leaves GHCR and the Release untouched and says so', async () => {
  const { result, state, text } = await run({ fail: { waitNpm: true } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /stopped:\*\* npm publish run: waitNpm failed/);
  assert.match(text, /- flipped: none/);
  assert.match(text, /- not flipped: npm latest, ghcr hub latest, ghcr web latest, github latest/);
});

test('hub moved but web failed: the Release stays a draft and the record lists both', async () => {
  const { result, state, text } = await run({ fail: { 'move-web': true } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest']);
  assert.equal(state.draft, true);
  assert.match(text, /- flipped: npm latest \(or maintenance when latest is newer\), ghcr hub latest/);
  assert.match(text, /- not flipped: ghcr web latest, github latest/);
  assert.match(text, /partial window/);
});

test('a newer stable pointer is kept, never moved backwards', async () => {
  const { result, state, text } = await run({ hub: v('0.2.0'), web: v('0.2.0'), github: v('0.2.0'), npm: 'same' });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['release {"tag":"v0.1.7","prerelease":false,"makeLatest":false}']);
  assert.match(text, /ghcr hub latest: kept at 0\.2\.0/);
});

test('a prerelease touches no stable pointer and publishes as a non-latest prerelease', async () => {
  const { result, state } = await run({ version: '0.2.0-rc.1' });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['npm dispatch', 'release {"tag":"v0.2.0-rc.1","prerelease":true,"makeLatest":false}']);
  assert.deepEqual(state.hub, v('0.1.6'));
});

test('a tag that moves mid-run stops before the next write', async () => {
  // checks: 1 start, 2 before npm dispatch, 3 before hub
  const { result, state, text } = await run({ tagMovesAt: 3 });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /v0\.1\.7 no longer points at a{12}/);
});

test('npm already identical is recorded as done and not republished', async () => {
  const { result, state, text } = await run({ npm: 'same' });
  assert.equal(result.ok, true);
  assert.ok(!state.writes.includes('npm dispatch'));
  assert.match(text, /npm 0\.1\.7: already published with the expected tarball/);
});

test('npm holding a different tarball is refused before anything moves', async () => {
  const { result, state, text } = await run({ npm: 'different' });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, []);
  assert.match(text, /candidate preflight is incomplete|different/);
});

test('rerun after a GHCR failure finishes GHCR and the Release without publishing npm again', async () => {
  const first = world({ fail: { 'move-web': true } });
  const summary = () => {};
  await promote({ version: '0.1.7', tag: 'v0.1.7', commit: COMMIT, io: first.io, summary });
  assert.equal(first.state.npm, 'same');
  const again = world({ npm: 'same', hub: v('0.1.7') });
  const lines = [];
  const result = await promote({ version: '0.1.7', tag: 'v0.1.7', commit: COMMIT, io: again.io, summary: (line) => lines.push(line) });
  assert.equal(result.ok, true);
  assert.deepEqual(again.state.writes, ['ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.match(lines.join('\n'), /ghcr hub latest: already 0\.1\.7/);
});

test('everything already done writes nothing (the v0.1.6 rehearsal shape)', async () => {
  const { result, state, text } = await run({ version: '0.1.6', npm: 'same', hub: v('0.1.6'), web: v('0.1.6'), draft: false });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, []);
  assert.match(text, /GitHub Release v0\.1\.6: already published/);
});

test('an unreadable pointer stops instead of guessing', async () => {
  const { result, state, text } = await run({ npm: 'same', web: { state: 'unknown', version: null, detail: 'GHCR timed out' } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['ghcr hub latest']);
  assert.match(text, /ghcr web latest cannot be read: GHCR timed out/);
});

test('a failed preflight stops before npm', async () => {
  const { result, state } = await run({ fail: { 'verify-candidate': true } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, []);
});

test('tag and version must agree', async () => {
  const { io } = world();
  await assert.rejects(promote({ version: '0.1.7', tag: 'v0.1.8', commit: COMMIT, io, summary: () => {} }), /does not name/);
});
