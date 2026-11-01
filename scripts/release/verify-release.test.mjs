import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMMIT, OTHER_COMMIT, integrityOf, io, releaseAssets, world } from './fake-registry.fixture.mjs';
import { formatReport, main, npmPointers, parseArgs, pointerDecisions, readPointers, verifyRelease } from './verify-release.mjs';

const run = (w, options = {}, extra = {}) => verifyRelease({ version: '0.1.6', io: io(w, extra).io, ...options });
const states = (report) => Object.fromEntries(Object.entries(report.items).map(([id, item]) => [id, item.state]));

test('a complete set exits 0 and lists all four items of evidence', async () => {
  const report = await run(world());
  assert.deepEqual(states(report), { npm: 'ok', images: 'ok', release: 'ok', consistency: 'ok' });
  assert.equal(report.exitCode, 0);
  const text = formatReport(report);
  assert.match(text, /^ok\s+npm\s+@nema-project\/nema@0\.1\.6 integrity sha512-/m);
  assert.match(text, /^ok\s+release\s+v0\.1\.6 is published; 8 assets match/m);
  assert.match(text, new RegExp(`commit ${COMMIT}`));
  assert.match(text, /no revision label; image commit not compared/);
  assert.match(text, /signature not verified/);
  assert.match(text, /not a test, smoke, or acceptance result/);
});

test('#63 partial releases exit 1 and name what is missing', async () => {
  const onlyHub = world();
  delete onlyHub.images['nema-project/nema-room-web']['0.1.6'];
  let report = await run(onlyHub);
  assert.equal(report.exitCode, 1);
  assert.equal(report.items.images.state, 'missing');
  assert.match(report.items.images.detail, /nema-room-web:0\.1\.6 does not exist/);

  const desktopOnly = world('0.1.6', { npm: {}, provenance: {} });
  desktopOnly.images = { 'nema-project/nema-room-hub': {}, 'nema-project/nema-room-web': {} };
  report = await run(desktopOnly);
  assert.equal(report.exitCode, 1);
  assert.equal(report.items.npm.state, 'missing');
  assert.equal(report.items.images.state, 'missing');
  assert.equal(report.items.release.state, 'ok');

  report = await run(world('0.1.6', { npm: {} }));
  assert.equal(report.exitCode, 1);
  assert.match(report.items.npm.detail, /npm has no @nema-project\/nema@0\.1\.6/);

  report = await run(world('0.1.6', { denied: ['nema-project/nema-room-web'] }));
  assert.equal(report.exitCode, 1, 'an image an anonymous user cannot pull is not installable');
  assert.match(report.items.images.detail, /not anonymously readable/);

  const noCompose = world();
  delete noCompose.releases['v0.1.6'].assets['docker-compose.yml'];
  report = await run(noCompose);
  assert.equal(report.exitCode, 1);
  assert.match(report.items.release.detail, /missing docker-compose\.yml/);
});

test('commits must agree: tag, release manifest and npm provenance', async () => {
  let report = await run(world('0.1.6', { tags: { 'v0.1.6': { commit: OTHER_COMMIT, annotated: true } } }));
  assert.equal(report.exitCode, 1);
  assert.match(report.items.consistency.detail, /release manifest commit .* is not tag commit/);

  report = await run(world('0.1.6', { provenance: { '0.1.6': { commit: OTHER_COMMIT, ref: 'refs/tags/v0.1.6' } } }));
  assert.equal(report.exitCode, 1);
  assert.match(report.items.consistency.detail, /npm provenance commit 1{40} is not tag commit/);

  const label = world();
  label.images['nema-project/nema-room-hub']['0.1.6'].label = '0.1.5';
  report = await run(label);
  assert.equal(report.exitCode, 1);
  assert.match(report.items.consistency.detail, /hub image label is 0\.1\.5/);
});

test('an unanswered registry is undetermined, never missing', async () => {
  const report = await run(world('0.1.6', { throwOn: [/ghcr\.io/] }));
  assert.equal(report.items.images.state, 'unknown');
  assert.equal(report.overall, 'undetermined');
  assert.equal(report.exitCode, 2);
  assert.ok(Object.values(report.items).every((item) => item.state !== 'missing'));
  assert.match(formatReport(report), /Not a missing item, not ready/);
});

test('final stage: a draft Release is reported as a draft, not as missing', async () => {
  const w = world();
  w.releases['v0.1.6'].draft = true;
  const report = await run(w, {}, { token: 'read-token' });
  assert.equal(report.items.release.state, 'ok');
  assert.equal(report.items.release.evidence.draft, true);
  assert.match(report.items.release.detail, /still a draft;.*the GitHub latest pointer has not moved/);
  assert.equal(report.exitCode, 0);
});

test('candidate stage: npm may be absent, must match when present, and a published Release still passes', async () => {
  const w = world('0.1.6', { npm: {}, provenance: {} });
  w.releases['v0.1.6'].draft = true;
  const expected = integrityOf(w.tarball);
  let report = await run(w, { stage: 'candidate', expectedIntegrity: expected }, { token: 'read-token' });
  assert.equal(report.items.npm.state, 'pending');
  assert.equal(report.exitCode, 0);

  report = await run(world(), { stage: 'candidate', expectedIntegrity: integrityOf(world().tarball) });
  assert.equal(report.items.npm.state, 'ok');
  assert.equal(report.items.release.evidence.draft, false, 'a rerun after the Release went public is not blocked');
  assert.equal(report.exitCode, 0);

  report = await run(world(), { stage: 'candidate', expectedIntegrity: integrityOf('another tarball') });
  assert.equal(report.items.npm.state, 'missing');
  assert.match(report.items.npm.detail, /registry holds a different tarball/);
  assert.equal(report.exitCode, 1);

  await assert.rejects(run(world(), { stage: 'candidate' }), /expected-integrity/);
});

const pointer = (version) => (version === null ? { state: 'absent', version: null } : version === '?' ? { state: 'unknown', version: null } : { state: 'version', version });
const pointers = ({ latest = '0.1.6', next = null, hub = '0.1.6', web = '0.1.6', github = '0.1.6' } = {}) => ({
  npm: { latest: pointer(latest), next: pointer(next) },
  ghcr: { hub: pointer(hub), web: pointer(web) },
  github: { latest: pointer(github) },
});

test('pointer decisions are channel-aware and never move a stable pointer backward', () => {
  assert.deepEqual(pointerDecisions(pointers(), '0.1.7', false), { 'npm latest': 'move', 'npm next': 'skip', 'ghcr hub latest': 'move', 'ghcr web latest': 'move', 'github latest': 'move' });
  assert.deepEqual(pointerDecisions(pointers({ next: '0.1.0-rc.1' }), '0.1.7', false)['npm next'], 'skip');
  assert.deepEqual(pointerDecisions(pointers({ latest: '0.1.7', hub: '0.1.7', web: '0.1.7', github: '0.1.7' }), '0.1.6', false), { 'npm latest': 'keep', 'npm next': 'skip', 'ghcr hub latest': 'keep', 'ghcr web latest': 'keep', 'github latest': 'keep' });
  assert.equal(pointerDecisions(pointers(), '0.1.6', false)['npm latest'], 'move', 'equal is safe to set again');
  assert.deepEqual(pointerDecisions(pointers({ next: '0.1.7-rc.1' }), '0.1.8-rc.1', true), { 'npm latest': 'skip', 'npm next': 'move', 'ghcr hub latest': 'skip', 'ghcr web latest': 'skip', 'github latest': 'skip' });
  assert.equal(pointerDecisions(pointers({ hub: null, web: null }), '0.1.6', false)['ghcr hub latest'], 'move');
  assert.equal(pointerDecisions(pointers({ hub: '?' }), '0.1.7', false)['ghcr hub latest'], 'unknown');
  const halfMoved = pointerDecisions(pointers({ hub: '0.1.7', web: '0.1.6' }), '0.1.7', false);
  assert.equal(halfMoved['ghcr hub latest'], 'move');
  assert.equal(halfMoved['ghcr web latest'], 'move');
});

test('pointer reads: an unlabeled GHCR latest is unknown, an absent one is absent, a dist-tags outage is unknown', async () => {
  const w = world();
  w.images['nema-project/nema-room-hub'].latest = { label: null };
  delete w.images['nema-project/nema-room-web'].latest;
  let read = await readPointers(io(w).io);
  assert.equal(read.ghcr.hub.state, 'unknown');
  assert.equal(read.ghcr.web.state, 'absent');
  assert.deepEqual(read.npm.latest, { state: 'version', version: '0.1.6' });
  assert.equal(read.npm.next.state, 'absent');
  assert.deepEqual(read.github.latest, { state: 'version', version: '0.1.6' });

  const odd = world('0.1.6', { distTags: { latest: 'banana' } });
  read = await readPointers(io(odd).io);
  assert.equal(read.npm.latest.state, 'unknown');
  assert.match(read.npm.latest.detail, /not a release version/);
  assert.equal(pointerDecisions(read, '0.1.7', false)['npm latest'], 'unknown');

  read = await readPointers(io(world('0.1.6', { fail: [[/dist-tags/, 500]] })).io);
  assert.equal(read.npm.latest.state, 'unknown');
  assert.equal(pointerDecisions(read, '0.1.7', false)['npm latest'], 'unknown');
});

test('a definitive dist-tags unknown reaches the pointer, so a re-reading caller does not wait for it', async () => {
  // promote re-reads a pointer marked unknown; only a definitive answer may stop it on the first read.
  for (const fail of [[/dist-tags/, 403], [/dist-tags/, 200, '[]']]) {
    const read = await npmPointers(io(world('0.1.6', { fail: [fail] })).io);
    assert.equal(read.latest.state, 'unknown', JSON.stringify(fail));
    assert.equal(read.latest.definitive, true, 'a denial and a parsed wrong shape are both final');
    assert.equal(read.next.definitive, true, 'both pointers come from the one answer');
  }
  // A read failure stays undefined rather than false, so the old pointer shape is unchanged for callers that never set it.
  const outage = await npmPointers(io(world('0.1.6', { fail: [[/dist-tags/, 500]] })).io);
  assert.equal(outage.latest.state, 'unknown');
  assert.equal(outage.latest.definitive, undefined, 'a 5xx is worth another read');
  const absent = await npmPointers(io(world()).io);
  assert.equal(absent.latest.definitive, undefined);
  assert.equal(absent.next.definitive, undefined);
});

test('a package npm does not have at all reads as absent pointers, not as unreadable ones', async () => {
  // dist-tags answers 404 for a package that is not on npm: that was read, and it is an answer, so it must
  // not be filed under unknown (which means "could not be read") like the GHCR and GitHub sources already do.
  const pointers = await npmPointers(io(world('0.1.6', { fail: [[/dist-tags/, 404]] })).io);
  assert.deepEqual(pointers.latest, { state: 'absent', version: null });
  assert.deepEqual(pointers.next, { state: 'absent', version: null });
  // An absent pointer is one promote moves; an unknown one would stop it before it ever publishes.
  const decisions = pointerDecisions({ npm: pointers, ghcr: { hub: { state: 'version', version: '0.1.6' }, web: { state: 'version', version: '0.1.6' } }, github: { latest: { state: 'version', version: '0.1.6' } } }, '0.1.7', false);
  assert.equal(decisions['npm latest'], 'move');
});

test('a dist-tag holding something that is not a version is a final answer, not a read to retry', async () => {
  // The body parsed and is a tag map, so readNpmDistTags accepts it; the value itself is the wrong shape.
  for (const latest of ['banana', null, { version: '0.1.6' }]) {
    const pointers = await npmPointers(io(world('0.1.6', { distTags: { latest } })).io);
    assert.equal(pointers.latest.state, 'unknown', JSON.stringify(latest));
    assert.equal(pointers.latest.definitive, true, `${JSON.stringify(latest)} will not become a version on the next read`);
    assert.match(pointers.latest.detail, /not a release version/);
  }
  // A well-formed tag is a version pointer with no flag, and a missing tag is still absent.
  const ok = await npmPointers(io(world()).io);
  assert.deepEqual(ok.latest, { state: 'version', version: '0.1.6' });
  assert.deepEqual(ok.next, { state: 'absent', version: null });
});

test('the verifier is read-only', () => {
  for (const file of ['verify-release.mjs', 'registry-read.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/, file);
    assert.doesNotMatch(source, /writeFile|child_process|execFile|spawn/, file);
  }
});

test('CLI arguments: strict versions and known options only', () => {
  assert.equal(parseArgs(['0.1.6']).stage, 'final');
  assert.equal(parseArgs(['--pointers']).pointers, true);
  for (const bad of [['v0.1.6'], ['latest'], ['0.1'], [], ['0.1.6', '--wat'], ['0.1.6', '0.1.7'], ['0.1.6', '--stage', 'candidate'], ['0.1.6', '--stage', 'other']]) {
    assert.throws(() => parseArgs(bad), undefined, bad.join(' '));
  }
  const script = fileURLToPath(new URL('verify-release.mjs', import.meta.url));
  const usage = spawnSync(process.execPath, [script, 'v0.1.6'], { encoding: 'utf8' });
  assert.equal(usage.status, 64);
  assert.match(usage.stderr, /Usage:/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Never writes/);
});

test('the GitHub token is used for reads and never printed', async () => {
  const w = world();
  w.releases['v0.1.6'].draft = true;
  const fake = io(w);
  let out = '';
  let err = '';
  const sink = (append) => ({ write: (text) => append(text) });
  const code = await main(['0.1.6', '--json'], { env: { GITHUB_TOKEN: 'secret-value' }, fetchImpl: fake.io.fetchImpl, stdout: sink((t) => { out += t; }), stderr: sink((t) => { err += t; }) });
  assert.equal(code, 0, 'the token makes the draft visible');
  assert.equal(JSON.parse(out).items.release.evidence.draft, true);
  assert.doesNotMatch(out + err, /secret-value/);
});

// ---------- provenance a caller knows is still indexing (#174) ----------
// `release:verify` is a standalone command someone runs to accept a release. Its default must not get
// weaker: a version with no provenance is still `missing` and still exit 1. Only a caller that knows
// the 404 is an index delay it already bounded (promote, right after its own publish) may say so.

test('#174: without the new input, a provenance 404 is still missing and still exit 1', async () => {
  // This is the behaviour every standalone `npm run release:verify -- <version>` keeps.
  const w = world('0.1.6', { provenance: {} });
  const report = await run(w);
  assert.equal(report.items.consistency.state, 'missing');
  assert.match(report.items.consistency.detail, /npm has no provenance for @nema-project\/nema@0\.1\.6/);
  assert.doesNotMatch(report.items.consistency.detail, /waitable/);
  assert.equal(report.overall, 'incomplete');
  assert.equal(report.exitCode, 1);
});

test('#174: a pending provenance the caller vouched for is reported as waitable, never as missing and never as ok', async () => {
  const w = world('0.1.6', { provenance: {} });
  const report = await run(w, { provenanceIndex: { state: 'pending', detail: 'the registry declares provenance for 0.1.6 but has not served it after 60000ms' } });
  // Nothing is known to be missing, so the release set is complete...
  assert.equal(report.overall, 'complete');
  assert.equal(report.items.consistency.state, 'ok');
  // ...but the item is named, apart from the evidence that did agree, and never as an attestation that was read.
  assert.match(report.items.consistency.detail, /Waitable, not a gap: npm provenance/);
  assert.match(report.items.consistency.detail, /the registry declares provenance for 0\.1\.6 but has not served it/);
  assert.doesNotMatch(report.items.consistency.detail, /and npm provenance commit/, 'nothing was read, so nothing may claim it was');
  assert.deepEqual(report.items.consistency.waitable, ['npm provenance']);
  // The old behaviour would have said "npm has no provenance"; that sentence is now impossible here.
  assert.doesNotMatch(report.items.consistency.detail, /npm has no provenance/);
  assert.match(formatReport(report), /^ok\s+consistency/m);
});

test('#174: a real SLSA v1 body still wins over a caller-supplied hint, and a wrong commit is still missing', async () => {
  // The hint is about a 404 only. When the registry does serve the attestation, its content is checked
  // exactly as before, so a hint can never paper over a disagreeing commit.
  const served = await run(world(), { provenanceIndex: { state: 'pending', detail: 'not needed' } });
  assert.equal(served.items.consistency.state, 'ok');
  assert.equal(served.items.consistency.waitable, undefined, 'a served attestation is not a waitable item');
  assert.match(served.items.consistency.detail, /npm provenance read from the registry/);

  const wrong = await run(world('0.1.6', { provenance: { '0.1.6': { commit: OTHER_COMMIT, ref: 'refs/tags/v0.1.6' } } }), { provenanceIndex: { state: 'pending', detail: 'not needed' } });
  assert.equal(wrong.items.consistency.state, 'missing');
  assert.match(wrong.items.consistency.detail, /npm provenance commit 1{40} is not tag commit/);
  assert.equal(wrong.exitCode, 1);
});

test('#174: the hint cannot turn another missing item into a pass', async () => {
  // A 404 provenance is only ever waitable; everything else keeps its own verdict.
  const w = world('0.1.6', { provenance: {} });
  w.images['nema-project/nema-room-web']['0.1.6'].label = '0.1.5';
  const report = await run(w, { provenanceIndex: { state: 'pending', detail: 'index delay' } });
  assert.equal(report.items.consistency.state, 'missing');
  assert.match(report.items.consistency.detail, /web image label is 0\.1\.5/);
  assert.equal(report.exitCode, 1);
});

test('#174: a 401/403 on provenance is not turned into a waitable item by the hint either', async () => {
  // A denial is a definitive answer; the hint is only about a 404.
  const w = world('0.1.6', { fail: [[/attestations/, 403]] });
  const report = await run(w, { provenanceIndex: { state: 'pending', detail: 'index delay' } });
  // A denial means "could not be read", which is unknown (exit 2), never missing and never waitable.
  assert.equal(report.items.consistency.state, 'unknown');
  assert.match(report.items.consistency.detail, /attestations.*HTTP 403/);
  assert.doesNotMatch(report.items.consistency.detail, /waitable/);
  assert.equal(report.exitCode, 2);
});
