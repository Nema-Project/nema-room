import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPushRunJobs, assertTagRunJobs, completeRuns, preflight, promote } from './promote.mjs';

const COMMIT = 'a'.repeat(40);
const INTEGRITY = 'sha512-EXPECTED';
const DIGESTS = { hub: `sha256:${'1'.repeat(64)}`, web: `sha256:${'2'.repeat(64)}` };
const v = (version) => ({ state: 'version', version });
const ABSENT = { state: 'absent', version: null };
/** A GHCR latest pointer on the verified index of `version`. */
const vd = (version, target) => ({ state: 'version', version, digest: DIGESTS[target] });

/** A small world: registry state plus an ordered log of every read that matters and every write. */
function world({ version = '0.1.7', npm = 'absent', npmLatest = v('0.1.6'), npmNext = ABSENT, hub = v('0.1.6'), web = v('0.1.6'), github = v('0.1.6'), draft = true, fail = {}, landsAnyway = {}, tagMovesAt = null, digests = DIGESTS, maintenance = false, releasePrerelease, latestAfterPublish, npmReads, tagReads } = {}) {
  const state = {
    npm, npmLatest, npmNext, hub, web, github, draft, releasePrerelease, writes: [], log: [], tagChecks: 0,
    // What the registry answers after the publish run succeeded, read by read; the last entry repeats.
    // `null` means "the publish lands at once", which is what a fake registry without lag does.
    npmQueue: npmReads ? [...npmReads] : null,
    tagQueue: tagReads ? [...tagReads] : null,
    published: false,
    clock: 0,
    sleeps: [],
    npmReads: 0,
    // Reads made after the publish run succeeded: the ones the visibility wait makes.
    npmReadsAfterPublish: 0,
    tagPointerReads: 0,
  };
  const boom = (name) => {
    if (fail[name]) throw new Error(`${name} failed`);
  };
  const { prerelease } = { prerelease: version.includes('-') };
  const io = {
    async tagWorkflows() {
      state.log.push('tag workflows');
      boom('tagWorkflows');
      return ['image-publish push run 11: success, Pull published images passed', 'desktop-release push run 12: success'];
    },
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
      state.npmReads += 1;
      if (state.published) state.npmReadsAfterPublish += 1;
      if (state.npmQueue && state.published) {
        const next = state.npmQueue.length > 1 ? state.npmQueue.shift() : state.npmQueue[0];
        state.npm = typeof next === 'string' ? next : next.state;
        return typeof next === 'string' ? { state: next } : next;
      }
      return { state: state.npm };
    },
    async npmPointers() {
      boom('npmPointers');
      state.tagPointerReads += 1;
      if (state.tagQueue && state.published) {
        const next = state.tagQueue.length > 1 ? state.tagQueue.shift() : state.tagQueue[0];
        if (next.latest !== undefined) state.npmLatest = next.latest;
        if (next.next !== undefined) state.npmNext = next.next;
      }
      return { latest: state.npmLatest, next: state.npmNext };
    },
    now: () => state.clock,
    async sleep(ms) {
      state.sleeps.push(ms);
      state.clock += ms;
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
      state.published = true;
      // A scripted registry answers the reads that follow; the publish itself only exits 0.
      if (state.npmQueue) return;
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
  assert.deepEqual(state.log, ['tag workflows', 'verify candidate', 'npm dispatch', 'verify final', 'ghcr hub latest', 'ghcr web latest', 'tag workflows', 'release']);
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest', 'ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.match(text, /- image-publish push run 11: success, Pull published images passed\n- desktop-release push run 12: success/);
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
    // The bounded wait re-reads each of these until the budget is spent, then stops where the old code did.
    const { result, state, text } = await run({ latestAfterPublish });
    assert.equal(result.ok, false, JSON.stringify(latestAfterPublish));
    assert.deepEqual(state.writes, ['npm dispatch']);
    assert.match(text, /npm publish run finished but the registry does not confirm 0\.1\.7/);
    const expected = latestAfterPublish.state === 'unknown' ? /- npm registry after publish: unknown — npm latest/ : /- npm registry after publish: published; channel pointer unconfirmed — npm latest/;
    assert.match(text, expected, 'an unreadable tag is unknown; a readable tag that stayed put is not "not written"');
    assert.doesNotMatch(text, /not written/, 'the package itself was visible, so nothing may claim it was not written');
    assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000, 'the whole budget, then a stop');
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

test('an older stable whose publish moved npm latest backwards stops before GHCR', async () => {
  // latest was 0.2.0 before the dispatch; a publisher that ignored maintenance leaves it on 0.1.7.
  const { result, state, text } = await run({ npmLatest: v('0.2.0'), hub: vd('0.2.0', 'hub'), web: vd('0.2.0', 'web'), github: v('0.2.0'), latestAfterPublish: v('0.1.7') });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /npm latest moved backwards from 0\.2\.0 to 0\.1\.7/);
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
    { name: 'verify / npm pack smoke (windows-latest)', conclusion: 'success' },
    { name: 'verify / npm pack smoke (macos-latest)', conclusion: 'success' },
    { name: 'Publish to npm', conclusion: 'skipped' },
  ];
  assert.doesNotThrow(() => assertPushRunJobs(ok, 1, ok.length));
  const without = (prefix) => ok.filter((job) => !job.name.startsWith(prefix));
  const set = (prefix, conclusion) => ok.map((job) => (job.name.startsWith(prefix) ? { ...job, conclusion } : job));
  assert.throws(() => assertPushRunJobs(without('Pack'), 1, without('Pack').length), /Pack and smoke nema did not run and pass \(no such job\)/);
  assert.throws(() => assertPushRunJobs(without('verify / Full'), 1, without('verify / Full').length), /Full application tests and web build did not run/);
  assert.throws(() => assertPushRunJobs(set('verify / npm pack smoke', 'skipped'), 1, set('verify / npm pack smoke', 'skipped').length), /npm pack smoke \(ubuntu-latest\) did not run and pass/);
  assert.throws(() => assertPushRunJobs(set('verify / Platform checks (windows', 'skipped'), 1, set('verify / Platform checks (windows', 'skipped').length), /Platform checks \(windows-latest\) did not run and pass/);
  assert.throws(() => assertPushRunJobs([...ok, { name: 'verify / Something new', conclusion: 'skipped' }], 1, [...ok, { name: 'verify / Something new', conclusion: 'skipped' }].length), /Something new=skipped/);
  // A jobs page that does not hold every job of the run cannot prove the rest passed.
  assert.doesNotThrow(() => assertPushRunJobs(ok, 1, ok.length));
  assert.throws(() => assertPushRunJobs(ok, 1, ok.length + 1), /lists 9 of 10 jobs/);
  // Every matrix leg by its exact name: a run whose answer lacks one leg is refused even when its count agrees.
  for (const leg of ['verify / Platform checks (windows-latest)', 'verify / npm pack smoke (macos-latest)']) {
    const short = ok.filter((job) => job.name !== leg);
    assert.throws(() => assertPushRunJobs(short, 1, short.length), new RegExp(`${leg.replace(/[()]/g, '\\$&')} did not run and pass \\(no such job\\)`));
  }
  assert.throws(() => assertPushRunJobs(ok, 1, undefined), /did not report its job count/);
});

test('image-publish or desktop-release push runs that did not pass stop before verify and before any write', async () => {
  const { result, state, text } = await run({ fail: { tagWorkflows: true } });
  assert.equal(result.ok, false);
  assert.deepEqual(state.log, ['tag workflows']);
  assert.deepEqual(state.writes, []);
  assert.match(text, /stopped:\*\* tag workflows: tagWorkflows failed/);
  // The Candidate preflight step checks them too, before it reads the npm tarball.
  const { state: pre, io } = world({ fail: { tagWorkflows: true } });
  await assert.rejects(preflight({ version: '0.1.7', io }), /tagWorkflows failed/);
  assert.deepEqual(pre.log, ['tag workflows']);
  const { state: okState, io: okIo } = world();
  assert.equal((await preflight({ version: '0.1.7', io: okIo })).ok, true);
  assert.deepEqual(okState.log, ['tag workflows', 'verify candidate']);
});

test('the image-publish push run must have passed its pull smoke, the desktop run its builds and publish', () => {
  const verify = ['verify / Workflow lint', 'verify / Full application tests and web build', 'verify / Platform checks (macos-latest)', 'verify / Platform checks (windows-latest)', 'verify / npm pack smoke (ubuntu-latest)', 'verify / npm pack smoke (windows-latest)', 'verify / npm pack smoke (macos-latest)'];
  const image = ['Resolve release version', ...verify, 'Build and smoke images', 'Publish images', 'Pull published images'].map((name) => ({ name, conclusion: 'success' }));
  const desktop = ['Resolve release version', ...verify, 'Build and smoke (darwin-arm64)', 'Build and smoke (win32-x64)', 'Publish release'].map((name) => ({ name, conclusion: 'success' }));
  assert.doesNotThrow(() => assertTagRunJobs('image-publish.yml', image, 1, image.length));
  assert.doesNotThrow(() => assertTagRunJobs('desktop-release.yml', desktop, 2, desktop.length));
  const set = (jobs, name, conclusion) => jobs.map((job) => (job.name === name ? { ...job, conclusion } : job));
  assert.throws(() => assertTagRunJobs('image-publish.yml', set(image, 'Pull published images', 'failure'), 1, image.length), /image-publish push run 1: Pull published images did not run and pass \(Pull published images=failure\)/);
  assert.throws(() => assertTagRunJobs('image-publish.yml', image.filter((job) => job.name !== 'Pull published images'), 1, image.length - 1), /Pull published images did not run and pass \(no such job\)/);
  assert.throws(() => assertTagRunJobs('desktop-release.yml', set(desktop, 'Build and smoke (win32-x64)', 'skipped'), 2, desktop.length), /Build and smoke \(win32-x64\) did not run and pass/);
  // A missing matrix leg is refused even when total_count agrees with the shorter answer.
  const noWin = desktop.filter((job) => job.name !== 'Build and smoke (win32-x64)');
  assert.throws(() => assertTagRunJobs('desktop-release.yml', noWin, 2, noWin.length), /Build and smoke \(win32-x64\) did not run and pass \(no such job\)/);
  const noPlatform = image.filter((job) => job.name !== 'verify / Platform checks (macos-latest)');
  assert.throws(() => assertTagRunJobs('image-publish.yml', noPlatform, 1, noPlatform.length), /Platform checks \(macos-latest\) did not run and pass/);
  assert.throws(() => assertTagRunJobs('image-publish.yml', set(image, 'verify / Workflow lint', 'cancelled'), 1, image.length), /verify \/ Workflow lint=cancelled/);
  assert.throws(() => assertTagRunJobs('image-publish.yml', image, 1, image.length + 1), /lists 11 of 12 jobs/);
  assert.throws(() => assertTagRunJobs('image-publish.yml', image, 1, undefined), /did not report its job count/);
  assert.throws(() => assertTagRunJobs('npm-publish.yml', image, 1, image.length), /no job list/);
});

test('the tag workflows are checked again right before the Release is published', async () => {
  // A desktop-release rerun started after the first check may be replacing draft assets: stop before publishing.
  const { state, io } = world();
  let calls = 0;
  const first = io.tagWorkflows;
  io.tagWorkflows = async () => {
    calls += 1;
    if (calls === 2) {
      state.log.push('tag workflows');
      throw new Error('desktop-release push run 12 is in_progress/null');
    }
    return first();
  };
  const lines = [];
  const result = await promote({ version: '0.1.7', tag: 'v0.1.7', commit: COMMIT, io, summary: (line) => lines.push(line) });
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
  assert.deepEqual(state.log, ['tag workflows', 'verify candidate', 'npm dispatch', 'verify final', 'ghcr hub latest', 'ghcr web latest', 'tag workflows']);
  assert.equal(state.draft, true, 'the Release stays a draft');
  assert.match(lines.join('\n'), /stopped:\*\* tag workflows before the release: desktop-release push run 12 is in_progress/);
});

test('a workflow runs answer that does not hold every run of the commit is refused', () => {
  const runs = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(completeRuns({ total_count: 2, workflow_runs: runs }, 'x'), runs);
  assert.throws(() => completeRuns({ total_count: 21, workflow_runs: runs }, 'image-publish push runs'), /image-publish push runs: the runs answer lists 2 of 21 runs/);
  assert.throws(() => completeRuns({ workflow_runs: runs }, 'x'), /did not report its run count/);
  assert.throws(() => completeRuns({ total_count: 0 }, 'x'), /did not report its run count/);
});

// ---------- npm registry visibility after the publish run (issue #158) ----------
// The publish run exiting 0 does not mean the registry serves the version: v0.2.0 answered 404 for ~18s.
// These pin what may wait, what must not, and what the record says when the budget is spent.

const DIFFERENT = { state: 'different', integrity: 'sha512-OTHER', detail: 'registry holds sha512-OTHER for 0.1.7' };

test('acceptance 1: absent then same, dist-tag visible afterwards: one promote, one npm dispatch', async () => {
  const { result, state, text } = await run({ npmReads: ['absent', 'same'], tagReads: [{ latest: ABSENT, next: ABSENT }, { latest: v('0.1.7') }] });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest', 'ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.equal(state.writes.filter((write) => write === 'npm dispatch').length, 1, 'npm is dispatched once');
  assert.equal(state.npmReadsAfterPublish, 2, 'the package was re-read, not re-published');
  // One poll for the package (absent -> same) and one for the pointer (absent -> 0.1.7).
  assert.match(text, /npm 0\.1\.7: published by run 42; npm latest -> 0\.1\.7 after 10000ms/);
  assert.deepEqual(state.sleeps, [5_000, 5_000]);
});

test('acceptance 2: the package is visible at once but the dist-tag lags: bounded wait, no second publish', async () => {
  const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.6') }, { latest: v('0.1.6') }, { latest: v('0.1.7') }] });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes.slice(0, 1), ['npm dispatch']);
  assert.equal(state.writes.filter((write) => write === 'npm dispatch').length, 1);
  assert.equal(state.npmReadsAfterPublish, 1, 'the package was read once and never published again');
  assert.equal(state.tagPointerReads, 3);
  assert.deepEqual(state.sleeps, [5_000, 5_000]);
  assert.match(text, /npm latest -> 0\.1\.7 after 10000ms/);
});

test('acceptance 3: another integrity fails at once, waits for nothing, and moves no other pointer', async () => {
  const { result, state, text } = await run({ npmReads: [DIFFERENT] });
  assert.equal(result.ok, false);
  assert.deepEqual(state.sleeps, [], 'a definitive answer is not an index delay');
  assert.equal(state.npmReadsAfterPublish, 1, 'one read is enough: this is not a lag');
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /registry holds sha512-OTHER for 0\.1\.7; the registry gave a definitive answer/);
  assert.match(text, /- npm registry after publish: different — /);
  assert.match(text, /- not flipped: npm latest, ghcr hub latest, ghcr web latest, github latest/);
});

test('acceptance 4a: the version stays absent through the budget: a timeout, nothing else moves', async () => {
  const { result, state, text } = await run({ npmReads: ['absent'] });
  assert.equal(result.ok, false);
  assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000, 'exactly the budget');
  assert.ok(state.sleeps.every((ms) => ms <= 5_000), 'polls stay short');
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.ok(!state.log.includes('verify final'));
  assert.match(text, /the registry still answers 404 for 0\.1\.7 after 120000ms; confirmed not written/);
  assert.match(text, /- npm registry after publish: not written — /);
  assert.match(text, /- flipped by this run: none/);
  assert.match(text, /- not flipped: npm latest, ghcr hub latest, ghcr web latest, github latest/);
});

test('acceptance 4b: an old dist-tag through the budget: a timeout, nothing else moves', async () => {
  const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.6') }] });
  assert.equal(result.ok, false);
  assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.ok(!state.log.includes('verify final'));
  assert.match(text, /npm latest still reads 0\.1\.6 after 120000ms; the package is published, but npm latest did not move to 0\.1\.7/);
  // The exact version read back as same, so the package *was* written: only the pointer is unconfirmed.
  assert.match(text, /- npm registry after publish: published; channel pointer unconfirmed — /);
  assert.doesNotMatch(text, /not written/);
});

test('a transient read is retried inside the budget and a later answer decides', async () => {
  const transient = { state: 'transient', detail: 'cannot tell whether @nema-project/nema@0.1.7 exists: HTTP 503' };
  const { result, state, text } = await run({ npmReads: [transient, transient, 'same'], tagReads: [{ latest: v('0.1.7') }] });
  assert.equal(result.ok, true);
  assert.deepEqual(state.sleeps, [5_000, 5_000]);
  assert.match(text, /npm latest -> 0\.1\.7 after 10000ms/);
});

test('a registry that stays unreadable ends as unknown, never as "not written"', async () => {
  const transient = { state: 'transient', detail: 'cannot tell whether @nema-project/nema@0.1.7 exists: HTTP 503' };
  const { result, state, text } = await run({ npmReads: [transient] });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /whether 0\.1\.7 is published is unknown/);
  assert.match(text, /- npm registry after publish: unknown — /);
  assert.doesNotMatch(text, /confirmed not written|not written —/);
});

test('an unreadable dist-tag ends as unknown rather than as a pointer that did not move', async () => {
  const { result, text } = await run({ npmReads: ['same'], tagReads: [{ latest: { state: 'unknown', version: null, detail: 'dist-tags timed out' } }] });
  assert.equal(result.ok, false);
  assert.match(text, /whether it points at 0\.1\.7 is unknown/);
  assert.match(text, /- npm registry after publish: unknown — /);
  assert.doesNotMatch(text, /confirmed it did not move/);
});

test('an answer the reader may not see or cannot interpret waits for nothing', async () => {
  for (const denial of [{ state: 'denied', detail: 'cannot tell whether @nema-project/nema@0.1.7 exists: HTTP 403' }, { state: 'untrusted', detail: 'cannot tell whether @nema-project/nema@0.1.7 exists: unparsable registry answer' }]) {
    const { result, state, text } = await run({ npmReads: ['absent', denial] });
    assert.equal(result.ok, false, JSON.stringify(denial));
    assert.deepEqual(state.sleeps, [5_000], 'one poll after the first absent answer, then no more');
    assert.deepEqual(state.writes, ['npm dispatch']);
    assert.match(text, /the registry gave a definitive answer, not an index delay/);
  }
});

test('a prerelease next that moved past this version is a contradiction, not a lag', async () => {
  const { result, state, text } = await run({ version: '0.2.0-rc.1', npmReads: ['same'], tagReads: [{ latest: v('0.1.6'), next: v('0.2.0-rc.2') }] });
  assert.equal(result.ok, false);
  assert.deepEqual(state.sleeps, [], 'waiting cannot explain a pointer that moved forward');
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /npm next is 0\.2\.0-rc\.2, newer than 0\.2\.0-rc\.1; that is not a visibility delay/);
});

test('a stable publish beside a newer latest stays maintenance, not a delay timeout', async () => {
  const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.2.0') }], hub: vd('0.2.0', 'hub'), web: vd('0.2.0', 'web'), github: v('0.2.0') });
  assert.equal(result.ok, true);
  assert.deepEqual(state.sleeps, [], 'an older stable under maintenance is not a lag');
  assert.match(text, /published by run 42 under maintenance; npm latest stays 0\.2\.0/);
});

test('an unreadable answer before the publish stops without dispatching', async () => {
  const { result, state, text } = await run({ npm: 'transient' });
  assert.equal(result.ok, false);
  assert.deepEqual(state.writes, []);
  assert.match(text, /cannot tell whether 0\.1\.7 is already on npm/);
});

test('a definitive dist-tag answer stops at once instead of waiting out the budget', async () => {
  // 401/403 and a parsed body of the wrong shape cannot become readable by waiting (CodeRabbit finding 2).
  for (const detail of ['https://registry.npmjs.org/-/package/@nema-project/nema/dist-tags: HTTP 403', 'https://registry.npmjs.org/-/package/@nema-project/nema/dist-tags: not a tag map']) {
    const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: { state: 'unknown', version: null, detail, definitive: true } }] });
    assert.equal(result.ok, false, detail);
    assert.deepEqual(state.sleeps, [], 'a definitive answer is not retried');
    assert.deepEqual(state.writes, ['npm dispatch']);
    assert.match(text, /the registry gave a definitive answer, so this is not an index delay/);
    assert.match(text, /- npm registry after publish: unknown — /);
  }
});

test('an unparsable tag body is re-read, unlike a denial', async () => {
  // A body that arrived truncated is a read failure, not an answer: it is retried within the budget.
  const { result, state } = await run({ npmReads: ['same'], tagReads: [{ latest: { state: 'unknown', version: null, detail: 'timeout' } }, { latest: v('0.1.7') }] });
  assert.equal(result.ok, true);
  assert.deepEqual(state.sleeps, [5_000]);
});

test('an older npm next is the lag this wait exists for, not a moved pointer', async () => {
  // rc.2 is published; next still reads rc.1 for one poll, then moves. Nothing is "newer" here.
  const { result, state, text } = await run({ version: '0.2.0-rc.2', npmReads: ['same'], tagReads: [{ latest: v('0.1.6'), next: v('0.2.0-rc.1') }, { latest: v('0.1.6'), next: v('0.2.0-rc.2') }] });
  assert.equal(result.ok, true);
  assert.deepEqual(state.sleeps, [5_000], 'one poll, then the pointer arrives');
  assert.match(text, /npm 0\.2\.0-rc\.2: published by run 42; npm next -> 0\.2\.0-rc\.2 after 5000ms/);
});

test('an older npm next that never moves times out as unconfirmed, never as "newer"', async () => {
  const { result, state, text } = await run({ version: '0.2.0-rc.2', npmReads: ['same'], tagReads: [{ latest: v('0.1.6'), next: v('0.2.0-rc.1') }] });
  assert.equal(result.ok, false);
  assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000);
  assert.doesNotMatch(text, /newer than|tag-moved/);
  assert.match(text, /npm next still reads 0\.2\.0-rc\.1 after 120000ms/);
});

test('a dist-tag whose value is not a version stops at once, like a denial', async () => {
  // npmPointers marks a malformed tag value definitive; the wait must not spend the budget on it.
  const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: { state: 'unknown', version: null, detail: 'npm dist-tag latest holds "banana", not a release version', definitive: true } }] });
  assert.equal(result.ok, false);
  assert.deepEqual(state.sleeps, [], 'a value that is not a version is not a lag');
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /the registry gave a definitive answer, so this is not an index delay/);
});
