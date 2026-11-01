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
function world({
  version = '0.1.7', npm = 'absent', npmLatest = v('0.1.6'), npmNext = ABSENT, hub = v('0.1.6'), web = v('0.1.6'),
  github = v('0.1.6'), draft = true, fail = {}, landsAnyway = {}, tagMovesAt = null, digests = DIGESTS, maintenance = false,
  releasePrerelease, latestAfterPublish, npmReads, tagReads,
  // Provenance (#174). `provenance` is what the attestations endpoint answers, read by read like npmReads;
  // `declared` is what the version document says (true/false/null for unreadable); `publishedAgoMs` is how
  // long before "now" this version was published (null for an unreadable publish time).
  provenance = 'ok', provenanceReads, declared = true, publishedAgoMs = 0, evidenceFailsFirst = false,
} = {}) {
  const state = {
    npm, npmLatest, npmNext, hub, web, github, draft, releasePrerelease, writes: [], log: [], tagChecks: 0,
    // What the registry answers after the publish run succeeded, read by read; the last entry repeats.
    // `null` means "the publish lands at once", which is what a fake registry without lag does.
    npmQueue: npmReads ? [...npmReads] : null,
    tagQueue: tagReads ? [...tagReads] : null,
    provenanceQueue: provenanceReads ? [...provenanceReads] : [provenance],
    declared,
    publishedAgoMs,
    // Fail the first attempt at each evidence read, so a test can pin that a failure is retried.
    evidenceFailsFirst,
    published: false,
    clock: 0,
    sleeps: [],
    npmReads: 0,
    provenanceReads: 0,
    declarationReads: 0,
    publishedAtReads: 0,
    verifyOptions: [],
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
    async verify({ stage, expectedIntegrity, provenanceIndex }) {
      state.log.push(`verify ${stage}`);
      state.verifyOptions.push({ stage, provenanceIndex });
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
    async npmProvenance() {
      boom('npmProvenance');
      state.provenanceReads += 1;
      const next = state.provenanceQueue.length > 1 ? state.provenanceQueue.shift() : state.provenanceQueue[0];
      if (next === 'ok') return { state: 'ok', detail: '', evidence: { workflowPath: '.github/workflows/npm-publish.yml', workflowRef: `refs/tags/v${version}`, commit: COMMIT, event: 'push', signatureVerified: false } };
      if (next === 'pending') return { state: 'pending', detail: `npm has not indexed provenance for @nema-project/nema@${version} yet`, evidence: { reason: 'not-indexed' } };
      if (next === 'denied') return { state: 'unknown', detail: 'https://registry.npmjs.org/-/npm/v1/attestations: HTTP 403', definitive: true, evidence: { definitive: true, reason: 'denied' } };
      if (next === 'transient') return { state: 'unknown', detail: 'https://registry.npmjs.org/-/npm/v1/attestations: HTTP 503' };
      if (next === 'absent') return { state: 'missing', detail: `npm provenance for ${version} has no SLSA v1 attestation` };
      throw new Error(`unknown provenance answer ${JSON.stringify(next)}`);
    },
    async npmProvenanceDeclared() {
      boom('npmProvenanceDeclared');
      state.declarationReads += 1;
      if (state.evidenceFailsFirst && state.declarationReads === 1) return { state: 'unknown', detail: 'https://registry.npmjs.org/@nema-project/nema/0.1.7: HTTP 503' };
      if (state.declared === null) return { state: 'unknown', detail: 'https://registry.npmjs.org/@nema-project/nema/0.1.7: HTTP 503' };
      return { state: 'ok', evidence: { declared: state.declared, predicateType: state.declared ? 'https://slsa.dev/provenance/v1' : null } };
    },
    async npmPublishedAt() {
      boom('npmPublishedAt');
      state.publishedAtReads += 1;
      if (state.evidenceFailsFirst && state.publishedAtReads === 1) return { state: 'unknown', detail: 'https://registry.npmjs.org/@nema-project/nema: HTTP 503' };
      if (state.publishedAgoMs === null) return { state: 'unknown', detail: 'https://registry.npmjs.org/@nema-project/nema: HTTP 503' };
      return { state: 'ok', evidence: { version, publishedAt: state.clock - state.publishedAgoMs } };
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

// ---------- npm provenance (#174) ----------
// v0.2.1's first promote stopped with `missing: npm has no provenance` although the attestation
// existed: the package answered 200 for over a minute before the attestations endpoint did, and the
// final verify that read the 404 ran after npm latest had already moved. These pin the three things
// that must now be true: a fresh publish waits for provenance inside the same budget; a provenance
// that could not be served is reported apart from one that does not exist; and neither is waited on
// when it cannot change.

test('#174 acceptance: the package is visible but attestations still 404, so the wait continues to success', async () => {
  const { result, state, text } = await run({
    npmReads: ['same'],
    tagReads: [{ latest: v('0.1.7') }],
    provenanceReads: ['pending', 'pending', 'ok'],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest', 'ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.equal(state.provenanceReads, 3, 'the attestation was re-read, not given up on');
  assert.deepEqual(state.sleeps, [5_000, 5_000], 'two polls between the three reads');
  assert.match(text, /npm 0\.1\.7: published by run 42; npm latest -> 0\.1\.7 after \d+ms; provenance served/);
  assert.doesNotMatch(text, /provenance absent|no provenance/);
});

test('#174 acceptance: the budget runs out with attestations still 404, and the outcome says "not indexed", not "absent"', async () => {
  const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }], provenanceReads: ['pending'] });
  assert.equal(result.ok, true, 'a waitable provenance item does not stop the promotion');
  assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000, 'exactly the budget, shared with the other reads');
  assert.deepEqual(state.writes, ['npm dispatch', 'ghcr hub latest', 'ghcr web latest', 'release {"tag":"v0.1.7","prerelease":false,"makeLatest":true}']);
  assert.match(text, /the registry declares provenance for 0\.1\.7 but has not served it after \d+ms; the attestation exists and its index has not caught up/);
  assert.match(text, /npm provenance: still a waitable item, not a gap/);
  // The wording that must never appear: the registry did not say there is none.
  assert.doesNotMatch(text, /definite gap/);
  assert.doesNotMatch(text, /no provenance/);
  assert.doesNotMatch(text, /not written/);
});

test('#174 acceptance: a version published long ago whose document declares no attestation is missing at once, without the budget', async () => {
  // Nothing shows an attestation exists: an old publish cannot still be indexing, so waiting is wasted
  // and the answer is the absence itself, not an uncertainty. The run stops, but it must say what it had
  // already done: npm latest moved, so the record names that instead of pretending nothing was published.
  const { result, state, text } = await run({
    npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }],
    provenanceReads: ['pending'], declared: false, publishedAgoMs: 3_600_000,
  });
  assert.equal(result.ok, false, 'a definite gap stops the run');
  assert.deepEqual(state.sleeps, [], 'no poll: this is not a lag');
  assert.equal(state.provenanceReads, 1);
  assert.equal(state.declarationReads, 1);
  assert.equal(state.publishedAtReads, 1);
  assert.equal(state.npmReadsAfterPublish, 1, 'the version was read once; the absence is what stopped it');
  assert.deepEqual(state.writes, ['npm dispatch'], 'nothing later moves: the gap is found where the package becomes visible');
  assert.match(text, /- flipped by this run: npm latest/, 'npm latest did move, and the record says so');
  assert.match(text, /- not flipped: ghcr hub latest, ghcr web latest, github latest/);
  assert.match(text, /stopped:\*\* npm provenance is a definite gap: npm has no provenance for 0\.1\.7: its version document was read and declares none, and it was published 3600000ms ago, longer than any index delay/);
  assert.match(text, /- npm provenance: a definite gap \(provenance-absent\)/);
  assert.doesNotMatch(text, /not written/, 'the package was published: nothing may claim it was not');
});

test('#174 acceptance: a provenance 404 the signals cannot rule out is waited on, then reported as unconfirmed (not "not indexed")', async () => {
  // Neither the document nor the publish time could be read, so nothing proves an attestation exists;
  // every read is still inside the index window, so it may land. The outcome must say "unconfirmed".
  const { result, state, text } = await run({
    npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }],
    provenanceReads: ['pending'], declared: null, publishedAgoMs: null,
  });
  assert.equal(result.ok, true);
  assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000);
  assert.match(text, /the registry still answers 404 for provenance of 0\.1\.7 after \d+ms and its version document could not be read; whether an attestation exists is unconfirmed/);
  assert.doesNotMatch(text, /has not served it/, '"unconfirmed" and "not indexed yet" are different answers');
  assert.doesNotMatch(text, /declares none/, 'nothing was read, so nothing may claim the document declares none');
});

test('#174 acceptance: a 401/403 on provenance stops at once and never spends the budget', async () => {
  const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }], provenanceReads: ['denied'] });
  assert.equal(result.ok, false);
  assert.deepEqual(state.sleeps, [], 'a denial is not an index delay');
  assert.equal(state.provenanceReads, 1);
  assert.deepEqual(state.writes, ['npm dispatch'], 'nothing after npm moved');
  assert.match(text, /npm provenance cannot be read .*HTTP 403.*; the registry gave a definitive answer, so this is not a delay/);
  assert.match(text, /npm provenance: a definite gap \(provenance-denied\)/);
  assert.match(text, /partial window/);
});

test('#174 acceptance: a 200 without a SLSA v1 attestation is a definite absence, and stops at once', async () => {
  const { result, state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }], provenanceReads: ['absent'] });
  assert.equal(result.ok, false);
  assert.deepEqual(state.sleeps, []);
  assert.deepEqual(state.writes, ['npm dispatch']);
  assert.match(text, /has no SLSA v1 attestation; the registry answered, so this is not a delay/);
  assert.match(text, /npm provenance: a definite gap \(provenance-absent\)/);
  assert.doesNotMatch(text, /not indexed/, 'an answered absence is never called "not indexed"');
});

test('#174: a rerun whose npm is already published settles the provenance it may have stopped on', async () => {
  // The v0.2.1 rerun scenario: npm is there, the previous run stopped on the attestation, and the index
  // has caught up. The rerun must read it rather than fall straight through to final verify.
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.7'), hub: vd('0.1.7', 'hub'), provenanceReads: ['pending', 'ok'] });
  assert.equal(result.ok, true);
  assert.equal(state.provenanceReads, 2);
  assert.match(text, /npm 0\.1\.7: already published with the expected tarball; npm latest is 0\.1\.7/);
  assert.match(text, /npm 0\.1\.7: provenance served after 5000ms/);
});

test('#174 acceptance: a rerun whose candidate preflight reads a still-indexing attestation is not stopped there', async () => {
  // The v0.2.1 rerun's own Candidate preflight read the 404 at 00:28:47Z and only saw the attestation at
  // 00:28:51Z. Both stages must be covered, so promote settles the provenance before the candidate step
  // and tells that stage too — otherwise the run meant to finish a promotion fails at its first step.
  const { result, state } = await run({ npm: 'same', npmLatest: v('0.1.7'), provenanceReads: ['pending'], declared: true });
  assert.equal(result.ok, true);
  const candidate = state.verifyOptions.find((entry) => entry.stage === 'candidate');
  assert.equal(candidate.provenanceIndex.state, 'pending', 'the candidate stage is told the 404 is an index delay');
  assert.match(candidate.provenanceIndex.detail, /declares provenance for 0\.1\.7 but has not served it/);
  const final = state.verifyOptions.find((entry) => entry.stage === 'final');
  assert.equal(final.provenanceIndex.state, 'pending', 'and so is final verify, which would otherwise repeat the 404');
  assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000, 'one budget, not two: the candidate answer stands for the whole run');
});

test('#174: a serve that lands before final verify clears the hint from both stages', async () => {
  // The pre-candidate settle misses the attestation, the second one finds it: final verify then reads the
  // real thing and no stage is told to treat a 404 as a delay.
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.7'), hub: vd('0.1.7', 'hub'), web: vd('0.1.7', 'web') });
  assert.equal(result.ok, true);
  assert.ok(state.verifyOptions.every((entry) => entry.provenanceIndex === undefined));
  assert.match(text, /npm 0\.1\.7: provenance served/);
});

test('#174: a candidate preflight on a version whose provenance is definite passes no hint, so it still fails properly', async () => {
  const { result, state, text } = await run({ npm: 'same', npmLatest: v('0.1.7'), provenanceReads: ['absent'] });
  assert.equal(result.ok, false);
  const candidate = state.verifyOptions.find((entry) => entry.stage === 'candidate');
  assert.equal(candidate.provenanceIndex, undefined, 'a definite gap is the strict 404 it is');
  assert.match(text, /stopped:\*\* npm provenance is a definite gap/);
});

test('#174: an npm version that is not published yet is not asked for provenance before the candidate preflight', async () => {
  // The ordinary first run: nothing to compare, so no read and no wait before the preflight.
  const { result, state } = await run({ npm: 'absent' });
  assert.equal(result.ok, true);
  assert.equal(state.provenanceReads, 1, 'only the post-publish settle reads provenance');
  assert.deepEqual(state.sleeps.filter((ms) => ms !== 5_000), []);
});

test('#174: a definite provenance gap never reaches final verify, so nothing can be reported as waitable', async () => {
  // Final verify is the step that would have failed on the 404 anyway; stopping before it, with the npm
  // move already recorded, keeps a definite gap on the same fail-closed path while naming what moved.
  const { state, text } = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }], provenanceReads: ['absent'] });
  assert.equal(state.verifyOptions.some((entry) => entry.stage === 'final'), false);
  assert.doesNotMatch(text, /waitable/);
});

test('#174: evidence that fails to read is retried, so a real absence stays definite (CodeRabbit, PR #177)', async () => {
  // The hole: one unreadable packument was remembered as "no evidence", so a version published days ago
  // that declares no attestation ended as `provenance-unconfirmed` — a waitable item, which promote hands
  // to verify as a pending hint. A release with no provenance at all could then be reported complete.
  const { result, state, text } = await run({
    npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }],
    provenanceReads: ['pending'],
    // The evidence reads fail on their first attempt and then answer.
    declared: false, publishedAgoMs: 86_400_000 * 10,
    evidenceFailsFirst: true,
  });
  assert.equal(result.ok, false, 'a definite absence still stops the run');
  assert.equal(state.declarationReads, 2, 'the failed declaration read was retried, not cached as "no evidence"');
  assert.equal(state.publishedAtReads, 2, 'and so was the publish time');
  assert.match(text, /npm provenance is a definite gap: npm has no provenance for 0\.1\.7/);
  assert.doesNotMatch(text, /unconfirmed/, 'an absence recovered from evidence is never reported as an uncertainty');
});

test('#174: evidence that never becomes readable is still only unconfirmed, never called an absence', async () => {
  // The inverse mistake: inventing "absent" from two failed reads would blame a release for a gap nobody saw.
  const { result, state, text } = await run({
    npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }],
    provenanceReads: ['pending'], declared: null, publishedAgoMs: null,
  });
  assert.equal(result.ok, true, 'a waitable item does not stop the promotion');
  assert.match(text, /whether an attestation exists is unconfirmed/);
  assert.doesNotMatch(text, /has no provenance/);
  assert.equal(state.declarationReads, 120_000 / 5_000 + 1, 'retried while the endpoint kept answering 404');
});

test('#174: the evidence is not re-read once it answered, and not read at all when provenance is served', async () => {
  // One successful read each is enough; polling them again would only add registry traffic to the wait.
  const settled = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }], provenanceReads: ['pending', 'pending'], declared: true });
  assert.equal(settled.state.declarationReads, 1);
  assert.equal(settled.state.publishedAtReads, 0, 'a declared attestation settles it: no publish time needed');
  const served = await run({ npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }] });
  assert.equal(served.state.declarationReads, 0, 'the happy path pays for no evidence reads at all');
  assert.equal(served.state.publishedAtReads, 0);
});

test('#174: an old publish whose version document could not be read is unconfirmed, not a definite absence (CodeRabbit, PR #177)', async () => {
  // The inverse mistake of the previous fix: an old publish time was treated as enough to declare an
  // absence even though the document that would prove it was never read. That asserts a fact nobody
  // read, stops the run, and tells a maintainer to cut a new tag for a gap that may not exist.
  const { result, state, text } = await run({
    npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }],
    provenanceReads: ['pending'], declared: null, publishedAgoMs: 3_600_000,
  });
  assert.equal(result.ok, true, 'an uncertainty does not stop the promotion');
  assert.equal(state.sleeps.reduce((sum, ms) => sum + ms, 0), 120_000, 'it waits out the budget instead of deciding at once');
  assert.match(text, /its version document could not be read; whether an attestation exists is unconfirmed/);
  assert.doesNotMatch(text, /has no provenance/, 'the absence was never established');
  assert.doesNotMatch(text, /definite gap/);
  // And final verify gets the waitable hint rather than the strict 404 the old behaviour produced.
  const final = state.verifyOptions.find((entry) => entry.stage === 'final');
  assert.equal(final.provenanceIndex.state, 'pending');
});

test('#174: only a document that was read as declaring none makes an old version a definite absence', async () => {
  // The same fixture data as above except the document answered: now the absence is established and
  // the run must stop at once. This is the pair that keeps the two outcomes from collapsing into one.
  const { result, state } = await run({
    npmReads: ['same'], tagReads: [{ latest: v('0.1.7') }],
    provenanceReads: ['pending'], declared: false, publishedAgoMs: 3_600_000,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(state.sleeps, [], 'a read declaration plus an old publish is decided at once');
});
