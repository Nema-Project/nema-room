import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPushRunJobs, promote } from './promote.mjs';

const COMMIT = 'a'.repeat(40);
const INTEGRITY = 'sha512-EXPECTED';
const DIGESTS = { hub: `sha256:${'1'.repeat(64)}`, web: `sha256:${'2'.repeat(64)}` };
const v = (version) => ({ state: 'version', version });
const ABSENT = { state: 'absent', version: null };
/** A GHCR latest pointer on the verified index of `version`. */
const vd = (version, target) => ({ state: 'version', version, digest: DIGESTS[target] });

/** A small world: registry state plus an ordered log of every read that matters and every write. */
function world({ version = '0.1.7', npm = 'absent', npmLatest = v('0.1.6'), npmNext = ABSENT, hub = v('0.1.6'), web = v('0.1.6'), github = v('0.1.6'), draft = true, fail = {}, landsAnyway = {}, tagMovesAt = null, digests = DIGESTS, maintenance = false, releasePrerelease, latestAfterPublish } = {}) {
  const state = { npm, npmLatest, npmNext, hub, web, github, draft, releasePrerelease, writes: [], log: [], tagChecks: 0 };
  const boom = (name) => {
    if (fail[name]) throw new Error(`${name} failed`);
  };
  const { prerelease } = { prerelease: version.includes('-') };
  const io = {
    async expectedIntegrity() { boom('expectedIntegrity'); return INTEGRITY; },
    async verify({ stage, expectedIntegrity }) {
      state.log.push(`verify ${stage}`);
      boom(`verify-${stage}`);
      if (stage === 'candidate') assert.equal(expectedIntegrity, INTEGRITY);
      const ok = stage === 'candidate' ? state.npm !== 'different' : state.npm === 'same';
      return { exitCode: ok ? 0 : 1, overall: ok ? 'complete' : 'incomplete', items: { images: { evidence: { hub: { digest: digests.hub }, web: { digest: digests.web } } } } };
    },
    async npmState({ expectedIntegrity }) {
      assert.equal(expectedIntegrity, INTEGRITY, 'npm is compared with the push-run integrity');
      boom('npmState');
      return state.npm;
    },
    async dispatchNpm() {
      boom('dispatchNpm');
      state.writes.push('npm dispatch');
      state.log.push('npm dispatch');
      return { id: 42 };
    },
    async waitNpm({ id }) {
      assert.equal(id, 42);
      if (landsAnyway.waitNpm) {
        state.npm = 'same';
        state.npmLatest = v(version);
      }
      boom('waitNpm');
      state.npm = 'same';
      if (prerelease) state.npmNext = v(version);
      else if (latestAfterPublish !== undefined) state.npmLatest = latestAfterPublish;
      else if (!maintenance) state.npmLatest = v(version);
    },
    async readPointers() {
      boom('readPointers');
      return { npm: { latest: state.npmLatest, next: state.npmNext }, ghcr: { hub: state.hub, web: state.web }, github: { latest: state.github } };
    },
    async moveGhcrLatest({ target, version: next, digest }) {
      assert.equal(digest, DIGESTS[target], 'latest is bound to the verified digest');
      if (landsAnyway[`move-${target}`]) state[target] = { ...v(next), digest };
      boom(`move-${target}`);
      state.writes.push(`ghcr ${target} latest`);
      state.log.push(`ghcr ${target} latest`);
      state[target] = { ...v(next), digest };
    },
    async releaseState() { return { draft: state.draft, prerelease: state.releasePrerelease ?? version.includes('-') }; },
    async publishRelease(options) {
      boom('publishRelease');
      state.writes.push(`release ${JSON.stringify(options)}`);
      state.log.push('release');
      state.draft = false;
      state.releasePrerelease = options.prerelease;
      if (options.makeLatest) state.github = v(version);
    },
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

test('all steps in order: preflight, npm, final verify, hub latest, web latest, then the Release as latest', async () => {
  const { result, state, text } = await run();
  assert.equal(result.ok, true);
  assert.deepEqual(state.log, ['verify candidate', 'npm dispatch', 'verify final', 'ghcr hub latest', 'ghcr web latest', 'release']);
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest', 'ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.match(text, /npm 0\.1\.7: published by run 42; npm latest -> 0\.1\.7/);
  assert.match(text, new RegExp(`ghcr hub latest: 0\\.1\\.6 -> 0\\.1\\.7 \\(${DIGESTS.hub}\\)`));
  assert.match(text, /GitHub Release v0\.1\.7: published, latest=true/);
  assert.match(text, /promote v0\.1\.7: done/);
});

test('an npm failure leaves GHCR and the Release untouched and says so', async () => {
  const { result, state, text } = await run({ fail: { waitNpm: true } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.ok(!state.log.includes('verify final'));
  assert.match(text, /stopped:\*\* npm publish run: waitNpm failed/);
  assert.match(text, /- flipped by this run: none/);
  assert.match(text, /- not flipped: npm latest, ghcr hub latest, ghcr web latest, github latest/);
});

test('hub moved but web failed: the Release stays a draft and the record lists both', async () => {
  const { result, state, text } = await run({ fail: { 'move-web': true } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest']);
  assert.equal(state.draft, true);
  assert.match(text, /- flipped by this run: npm latest, ghcr hub latest/);
  assert.match(text, /- not flipped: ghcr web latest, github latest/);
  assert.match(text, /partial window/);
});

test('a write that reports failure but landed is read back and counted as moved', async () => {
  const { result, state, text } = await run({ fail: { 'move-web': true }, landsAnyway: { 'move-web': true } });
  assert.equal(result.ok, true);
  assert.deepEqual(state.web, vd('0.1.7', 'web'));
  assert.match(text, /move ghcr web latest: the command reported "move-web failed", but the read-back shows it landed/);
  const npm = await run({ fail: { waitNpm: true }, landsAnyway: { waitNpm: true } });
  assert.equal(npm.result.ok, true, 'npm holding the expected tarball after a failed wait is published');
});

test('a newer stable pointer is kept, never moved backwards', async () => {
  const { result, state, text } = await run({ hub: v('0.2.0'), web: v('0.2.0'), github: v('0.2.0'), npm: 'same', npmLatest: v('0.2.0') });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['release {"tag":"v0.1.7","prerelease":false,"makeLatest":false}']);
  assert.match(text, /ghcr hub latest: kept at 0\.2\.0/);
});

test('a prerelease touches no stable pointer and publishes as a non-latest prerelease', async () => {
  const { result, state } = await run({ version: '0.2.0-rc.1' });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['npm dispatch', 'release {"tag":"v0.2.0-rc.1","prerelease":true,"makeLatest":false}']);
  assert.deepEqual(state.hub, v('0.1.6'));
  assert.deepEqual(state.npmLatest, v('0.1.6'));
});

test('a tag that moves mid-run stops before the next write', async () => {
  // checks: 1 start, 2 before npm dispatch, 3 before hub
  const { result, state, text } = await run({ tagMovesAt: 3 });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /v0\.1\.7 no longer points at a{12}/);
});

test('a tag that moves before the web latest write or before the Release write stops there', async () => {
  // checks: 1 start, 2 before npm dispatch, 3 before hub, 4 before web, 5 before the Release
  const web = await run({ tagMovesAt: 4 });
  assert.equal(web.result.ok, false);
  assert.deepEqual(web.state.writes, ['npm dispatch', 'ghcr hub latest']);
  const release = await run({ tagMovesAt: 5 });
  assert.equal(release.result.ok, false);
  assert.deepEqual(release.state.writes, ['npm dispatch', 'ghcr hub latest', 'ghcr web latest']);
  assert.equal(release.state.draft, true);
});

test('after the npm publish, an unreadable, absent or lagging dist-tag stops before GHCR', async () => {
  for (const latestAfterPublish of [{ state: 'unknown', version: null, detail: 'registry timed out' }, ABSENT, v('0.1.6')]) {
    const { result, state, text } = await run({ latestAfterPublish });
    assert.equal(result.ok, false, JSON.stringify(latestAfterPublish));
    assert.deepEqual(state.writes, ['npm dispatch']);
    assert.match(text, /npm 0\.1\.7 is published but npm latest reads/);
  }
});

test('an already-published prerelease behind npm next is not promoted', async () => {
  const { result, state, text } = await run({ version: '0.2.0-rc.1', npm: 'same', npmNext: v('0.2.0-rc.2') });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, []);
  assert.match(text, /an older prerelease is not promoted/);
});

test('a published Release whose prerelease flag disagrees with the tag is corrected', async () => {
  const { result, state, text } = await run({ version: '0.2.0-rc.1', npm: 'same', npmNext: v('0.2.0-rc.1'), draft: false, releasePrerelease: false });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['release {"tag":"v0.2.0-rc.1","prerelease":true,"makeLatest":false}']);
  assert.match(text, /prerelease flag corrected to true/);
});

test('npm already identical, with its dist-tag on this version, is recorded as done and not republished', async () => {
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.7') });
  assert.equal(result.ok, true);
  assert.ok(!state.writes.includes('npm dispatch'));
  assert.match(text, /npm 0\.1\.7: already published with the expected tarball; npm latest is 0\.1\.7/);
});

test('npm already published while its dist-tag lags stops and names the maintainer command', async () => {
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.6') });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, []);
  assert.match(text, /npm dist-tag add @nema-project\/nema@0\.1\.7 latest/);
});

test('npm holding a different tarball is refused before anything moves', async () => {
  const { result, state } = await run({ npm: 'different' });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, []);
});

test('rerun after a GHCR failure finishes GHCR and the Release without publishing npm again', async () => {
  const first = world({ fail: { 'move-web': true } });
  await promote({ version: '0.1.7', tag: 'v0.1.7', commit: COMMIT, io: first.io, summary: () => {} });
  assert.equal(first.state.npm, 'same');
  const again = world({ npm: 'same', npmLatest: v('0.1.7'), hub: vd('0.1.7', 'hub') });
  const lines = [];
  const result = await promote({ version: '0.1.7', tag: 'v0.1.7', commit: COMMIT, io: again.io, summary: (line) => lines.push(line) });
  assert.equal(result.ok, true);
  assert.deepEqual(again.state.writes, ['ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.match(lines.join('\n'), /ghcr hub latest: already 0\.1\.7/);
});

test('a rerun that fails again counts pointers found on this version as live, not as unflipped', async () => {
  const { result, text } = await run({ npm: 'same', npmLatest: v('0.1.7'), hub: vd('0.1.7', 'hub'), fail: { 'move-web': true } });
  assert.equal(result.ok, false);
  assert.match(text, /- already on 0\.1\.7 before this run: npm latest, ghcr hub latest/);
  assert.match(text, /- not flipped: ghcr web latest, github latest/);
  assert.match(text, /partial window/);
});

test('everything already done writes nothing (the v0.1.6 rehearsal shape)', async () => {
  const { result, state, text } = await run({ version: '0.1.6', npm: 'same', npmLatest: v('0.1.6'), hub: vd('0.1.6', 'hub'), web: vd('0.1.6', 'web'), github: v('0.1.6'), draft: false });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, []);
  assert.match(text, /GitHub Release v0\.1\.6: already published and latest/);
});

test('a published stable Release that should be latest but is not gets marked latest', async () => {
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.7'), hub: vd('0.1.7', 'hub'), web: vd('0.1.7', 'web'), github: v('0.1.6'), draft: false });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.match(text, /already published, now marked latest/);
});

test('an unreadable pointer stops instead of guessing', async () => {
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.7'), web: { state: 'unknown', version: null, detail: 'GHCR timed out' } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['ghcr hub latest']);
  assert.match(text, /ghcr web latest cannot be read: GHCR timed out/);
});

test('final verify without an image digest stops before any latest moves', async () => {
  const { result, state, text } = await run({ digests: { hub: null, web: DIGESTS.web } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /did not record a digest for hub/);
});

test('latest with this version label but another index is moved to the verified digest', async () => {
  const stray = { state: 'version', version: '0.1.7', digest: `sha256:${'9'.repeat(64)}` };
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.7'), hub: stray, web: vd('0.1.7', 'web') });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['ghcr hub latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.deepEqual(state.hub, vd('0.1.7', 'hub'));
  assert.match(text, /ghcr web latest: already 0\.1\.7/);
});

test('an older stable published under maintenance is reported as such, not as npm latest', async () => {
  const { result, text } = await run({ npmLatest: v('0.2.0'), hub: vd('0.2.0', 'hub'), web: vd('0.2.0', 'web'), github: v('0.2.0'), maintenance: true });
  assert.equal(result.ok, true);
  assert.match(text, /npm 0\.1\.7: published by run 42 under maintenance; npm latest stays 0\.2\.0/);
  assert.equal(result.flipped.includes('npm latest'), false);
});

test('a prerelease older than npm next is refused before it is published', async () => {
  const { result, state, text } = await run({ version: '0.2.0-rc.1', npmNext: v('0.2.0-rc.2') });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, []);
  assert.match(text, /npm next is 0\.2\.0-rc\.2, newer than 0\.2\.0-rc\.1/);
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

test('the push run must have run and passed the build job and the whole verify suite', () => {
  const ok = [
    { name: 'Pack and smoke nema', conclusion: 'success' },
    { name: 'verify / Workflow lint', conclusion: 'success' },
    { name: 'verify / Full application tests and web build', conclusion: 'success' },
    { name: 'verify / Platform checks (macos-latest)', conclusion: 'success' },
    { name: 'verify / Platform checks (windows-latest)', conclusion: 'success' },
    { name: 'verify / npm pack smoke (ubuntu-latest)', conclusion: 'success' },
    { name: 'Publish to npm', conclusion: 'skipped' },
  ];
  assert.doesNotThrow(() => assertPushRunJobs(ok, 1));
  const without = (prefix) => ok.filter((job) => !job.name.startsWith(prefix));
  const set = (prefix, conclusion) => ok.map((job) => (job.name.startsWith(prefix) ? { ...job, conclusion } : job));
  assert.throws(() => assertPushRunJobs(without('Pack'), 1), /Pack and smoke nema did not run and pass \(no such job\)/);
  assert.throws(() => assertPushRunJobs(without('verify / Full'), 1), /Full application tests and web build did not run/);
  assert.throws(() => assertPushRunJobs(set('verify / npm pack smoke', 'skipped'), 1), /npm pack smoke did not run and pass/);
  assert.throws(() => assertPushRunJobs(set('verify / Platform checks (windows', 'skipped'), 1), /Platform checks did not run and pass/);
  assert.throws(() => assertPushRunJobs([...ok, { name: 'verify / Something new', conclusion: 'skipped' }], 1), /Something new=skipped/);
});
