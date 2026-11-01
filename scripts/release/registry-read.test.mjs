import assert from 'node:assert/strict';
import test from 'node:test';
import { COMMIT, integrityOf, io, releaseAssets, world } from './fake-registry.fixture.mjs';
import {
  checkReleaseAssets,
  expectedReleaseAssets,
  npmProvenanceDeclared,
  readImage,
  readNpmDistTags,
  readNpmProvenance,
  readNpmPublishedAt,
  readNpmVersion,
  readRelease,
  readTagCommit,
} from './registry-read.mjs';

const HUB = 'nema-project/nema-room-hub';

test('npm: present is ok, 404 is missing, and only authoritative answers are missing', async () => {
  let { io: ok } = io(world());
  const present = await readNpmVersion(ok, '0.1.6');
  assert.equal(present.state, 'ok');
  assert.equal(present.evidence.integrity, integrityOf(world().tarball), 'the registry value, not just any sha512');

  const absent = io(world());
  assert.equal((await readNpmVersion(absent.io, '9.9.9')).state, 'missing');
  assert.equal(absent.calls.length, 1, 'a 404 is not retried');

  const failing = io(world('0.1.6', { fail: [[/registry\.npmjs\.org/, 500]] }));
  const serverError = await readNpmVersion(failing.io, '0.1.6');
  assert.equal(serverError.state, 'unknown');
  assert.equal(failing.calls.length, 3, 'unknown is retried twice');

  ({ io: ok } = io(world('0.1.6', { throwOn: [/registry\.npmjs\.org/] })));
  assert.equal((await readNpmVersion(ok, '0.1.6')).state, 'unknown', 'a network failure or timeout is unknown');

  ({ io: ok } = io(world('0.1.6', { fail: [[/registry\.npmjs\.org/, 200, '{not json']] })));
  assert.equal((await readNpmVersion(ok, '0.1.6')).state, 'unknown', 'unparsable JSON is unknown');

  ({ io: ok } = io(world('0.1.6', { fail: [[/registry\.npmjs\.org/, 429]] })));
  assert.equal((await readNpmVersion(ok, '0.1.6')).state, 'unknown', 'rate limiting is unknown');
});

test('npm dist-tags: a denial or a parsed non-object is unknown and definitive, a read failure is not', async () => {
  const { io: ok } = io(world());
  assert.equal((await readNpmDistTags(ok)).state, 'ok');

  for (const status of [401, 403]) {
    const denied = io(world('0.1.6', { fail: [[/dist-tags/, status]] }));
    const result = await readNpmDistTags(denied.io);
    assert.equal(result.state, 'unknown', String(status));
    assert.equal(result.evidence.definitive, true, 'a denial will not change on the next read');
    assert.equal(denied.calls.length, 1, 'a 401/403 is not retried');
  }

  for (const body of ['[]', '"latest"']) {
    const wrongShape = io(world('0.1.6', { fail: [[/dist-tags/, 200, body]] }));
    const shape = await readNpmDistTags(wrongShape.io);
    assert.equal(shape.state, 'unknown', body);
    assert.equal(shape.evidence.definitive, true, `a parsed ${body} is not a tag map and will not change on the next read`);
  }

  // A body that did not arrive, and 5xx/429, stay retryable: they are read failures, not answers.
  const broken = io(world('0.1.6', { fail: [[/dist-tags/, 200, '{not json']] }));
  const unparsable = await readNpmDistTags(broken.io);
  assert.equal(unparsable.state, 'unknown');
  assert.equal(unparsable.evidence.definitive, undefined, 'a truncated body is worth another read');

  const failing = io(world('0.1.6', { fail: [[/dist-tags/, 500]] }));
  const serverError = await readNpmDistTags(failing.io);
  assert.equal(serverError.state, 'unknown');
  assert.equal(serverError.evidence.definitive, undefined);
  assert.equal(failing.calls.length, 3, 'a 5xx is retried');
});

test('npm provenance is read from the registry and marked unverified', async () => {
  const { io: ok } = io(world());
  const result = await readNpmProvenance(ok, '0.1.6');
  assert.equal(result.state, 'ok');
  assert.equal(result.evidence.commit, COMMIT);
  assert.equal(result.evidence.workflowPath, '.github/workflows/npm-publish.yml');
  assert.equal(result.evidence.workflowRef, 'refs/tags/v0.1.6');
  assert.equal(result.evidence.signatureVerified, false);

  const reordered = world('0.1.6', { provenance: { '0.1.6': { commit: COMMIT, ref: 'refs/tags/v0.1.6', otherDependencyFirst: true } } });
  const second = await readNpmProvenance(io(reordered).io, '0.1.6');
  assert.equal(second.evidence.commit, COMMIT, 'the repository source is found even when it is not listed first');
});

test('GHCR: walks the nested index to the linux/amd64 version label', async () => {
  const { io: ok } = io(world());
  const result = await readImage(ok, HUB, '0.1.6');
  assert.equal(result.state, 'ok');
  assert.equal(result.evidence.label, '0.1.6');
  assert.equal(result.evidence.revision, null, 'the published images carry no revision label');
  assert.equal(result.evidence.platformDigest, 'sha256:amd64-0.1.6');
});

test('GHCR: missing tag, denied anonymous access and an attestation-only index are missing; token outage is unknown', async () => {
  let { io: ok } = io(world());
  const absent = await readImage(ok, HUB, '9.9.9');
  assert.equal(absent.state, 'missing');
  assert.equal(absent.evidence.reason, 'absent');

  ({ io: ok } = io(world('0.1.6', { denied: [HUB] })));
  const denied = await readImage(ok, HUB, '0.1.6');
  assert.equal(denied.state, 'missing');
  assert.equal(denied.evidence.reason, 'denied');

  const w = world();
  w.images[HUB]['0.1.6'].noPlatform = true;
  ({ io: ok } = io(w));
  const attestationOnly = await readImage(ok, HUB, '0.1.6');
  assert.equal(attestationOnly.state, 'missing');
  assert.match(attestationOnly.detail, /no linux\/amd64 image/);

  ({ io: ok } = io(world('0.1.6', { fail: [[/ghcr\.io\/token/, 503]] })));
  assert.equal((await readImage(ok, HUB, '0.1.6')).state, 'unknown');

  for (const broken of ['brokenChild', 'brokenConfig']) {
    const b = world();
    b.images[HUB]['0.1.6'][broken] = true;
    const result = await readImage(io(b).io, HUB, '0.1.6');
    assert.equal(result.state, 'missing', `${broken}: a referenced manifest or blob answering 404 is missing`);
    assert.match(result.detail, /which does not exist/);
  }
});

test('GitHub: lightweight and annotated tags resolve to the commit', async () => {
  const w = world('0.1.6', { tags: { 'v0.1.6': { commit: COMMIT, annotated: true }, 'v0.1.7': { commit: COMMIT, annotated: false } } });
  const { io: ok } = io(w);
  assert.equal((await readTagCommit(ok, 'v0.1.6')).evidence.commit, COMMIT);
  assert.equal((await readTagCommit(ok, 'v0.1.7')).evidence.commit, COMMIT);
  assert.equal((await readTagCommit(ok, 'v9.9.9')).state, 'missing');
});

test('GitHub: an anonymous 404 may hide a draft, so it is unknown; with a token it is missing', async () => {
  const w = world();
  w.releases['v0.1.6'].draft = true;
  const anonymous = io(w).io;
  const hidden = await readRelease(anonymous, 'v0.1.6');
  assert.equal(hidden.state, 'unknown');
  assert.match(hidden.detail, /missing, or a draft/);
  const withToken = io(w, { token: 'read-token' }).io;
  const draft = await readRelease(withToken, 'v0.1.6');
  assert.equal(draft.state, 'ok');
  assert.equal(draft.evidence.isDraft, true);
  assert.equal((await readRelease(withToken, 'v9.9.9')).state, 'missing');

  const weak = world('0.1.6', { tokenPush: false });
  weak.releases['v0.1.6'].draft = true;
  const hiddenFromWeakToken = await readRelease(io(weak, { token: 'read-only-token' }).io, 'v9.9.9');
  assert.equal(hiddenFromWeakToken.state, 'unknown', 'a token without push access cannot see drafts, so its 404 proves nothing');
});

test('GitHub: a draft is never served by the by-tag endpoint, so it is found in the full release list', async () => {
  const w = world();
  w.releases['v0.1.6'].draft = true;
  const { io: reader, calls } = io(w, { token: 'push-token' });
  const draft = await readRelease(reader, 'v0.1.6');
  assert.equal(draft.state, 'ok');
  assert.equal(draft.evidence.isDraft, true);
  assert.ok(calls.some((call) => String(call.url ?? call).includes('/releases?per_page=100&page=1')), 'the list was read');

  const twice = world();
  twice.releases['v0.1.6'].draft = true;
  twice.releases['v0.1.6-copy'] = twice.releases['v0.1.6'];
  const fakeFetch = io(twice, { token: 'push-token' }).io.fetchImpl;
  const duplicated = { fetchImpl: async (url, init) => {
    const response = await fakeFetch(url, init);
    if (!String(url).includes('/releases?')) return response;
    const body = await response.json();
    return { status: 200, json: async () => body.map((release) => ({ ...release, tag_name: release.tag_name.replace('-copy', '') })) };
  }, token: 'push-token', sleep: async () => {} };
  assert.equal((await readRelease(duplicated, 'v0.1.6')).state, 'unknown', 'two releases on one tag cannot be told apart');

  const broken = world('0.1.6', { listFails: 403 });
  broken.releases['v0.1.6'].draft = true;
  const failed = await readRelease(io(broken, { token: 'push-token' }).io, 'v0.1.6');
  assert.equal(failed.state, 'unknown');
  assert.match(failed.detail, /HTTP 403/);
});

test('GitHub: a workflow token that holds contents: write is trusted to see drafts without a permissions field', async () => {
  // An installation token's GET /repos answer need not carry `permissions`; the list still shows it drafts.
  const w = world('0.1.6', { hidePermissions: true });
  w.releases['v0.1.6'].draft = true;
  assert.equal((await readRelease(io(w, { token: 'actions-token' }).io, 'v9.9.9')).state, 'unknown');
  const trusted = io(w, { token: 'actions-token', draftsVisible: true }).io;
  assert.equal((await readRelease(trusted, 'v9.9.9')).state, 'missing');
  assert.equal((await readRelease(trusted, 'v0.1.6')).evidence.isDraft, true);
});

test('the expected asset set comes from code, as v0.1.6 publishes it', () => {
  assert.deepEqual(expectedReleaseAssets('0.1.6'), [
    'Nema-0.1.6-darwin-arm64.dmg',
    'Nema-0.1.6-win32-x64.exe',
    'Nema-0.1.6-win32-x64.zip',
    'SHA256SUMS-0.1.6-darwin-arm64.txt',
    'SHA256SUMS-0.1.6-win32-x64.txt',
    'SHA256SUMS-0.1.6.txt',
    'docker-compose.yml',
    'release-manifest-0.1.6.json',
  ].sort());
});

async function assetCheck(assets) {
  const w = world();
  w.releases['v0.1.6'].assets = assets;
  const { io: ok } = io(w);
  const release = await readRelease(ok, 'v0.1.6');
  return checkReleaseAssets(ok, '0.1.6', release.evidence);
}

test('the asset check reports a missing name, an extra name, and a target left out of both manifest and Release', async () => {
  const complete = await assetCheck(releaseAssets('0.1.6'));
  assert.equal(complete.state, 'ok');
  assert.equal(complete.evidence.manifestCommit, COMMIT);
  assert.equal(complete.evidence.assets, 8);

  const lacking = releaseAssets('0.1.6');
  delete lacking['docker-compose.yml'];
  const noCompose = await assetCheck(lacking);
  assert.equal(noCompose.state, 'missing');
  assert.match(noCompose.detail, /missing docker-compose\.yml/);

  const extra = await assetCheck(releaseAssets('0.1.6', { extra: ['notes.txt'] }));
  assert.equal(extra.state, 'missing');
  assert.match(extra.detail, /unexpected notes\.txt/);

  const noMac = await assetCheck(releaseAssets('0.1.6', { dropTarget: 'darwin-arm64' }));
  assert.equal(noMac.state, 'missing');
  assert.match(noMac.detail, /Nema-0\.1\.6-darwin-arm64\.dmg/);

  const malformed = await assetCheck(releaseAssets('0.1.6', { mutateManifest: (m) => ({ ...m, targets: { ...m.targets, 'win32-x64': 'oops' } }) }));
  assert.equal(malformed.state, 'missing');
  assert.match(malformed.detail, /win32-x64 entry is malformed/);

  const listedButGone = releaseAssets('0.1.6');
  listedButGone['docker-compose.yml'] = null;
  const gone = await assetCheck(listedButGone);
  assert.equal(gone.state, 'missing');
  assert.match(gone.detail, /docker-compose\.yml is listed but its download answers 404/);
});

test('the Compose asset must match the manifest hash and pin this version', async () => {
  const wrongHash = await assetCheck(releaseAssets('0.1.6', { composeSha: '0'.repeat(64) }));
  assert.equal(wrongHash.state, 'missing');
  assert.match(wrongHash.detail, /sha256 .* differs from the manifest/);

  const wrongPin = await assetCheck(releaseAssets('0.1.6', { composeVersion: '0.1.5' }));
  assert.equal(wrongPin.state, 'missing');
  assert.match(wrongPin.detail, /pins 0\.1\.5, not 0\.1\.6/);
});

// ---------- provenance declaration and publish time (#174) ----------
// Promote tells "index still catching up" from "never attested" with these two reads, so they have to
// answer correctly against the fake registry that every other release test shares.

test('#174: the version document declares provenance exactly when the endpoint would serve it', async () => {
  const withProvenance = world();
  const declared = await npmProvenanceDeclared(io(withProvenance).io, '0.1.6');
  assert.equal(declared.state, 'ok');
  assert.deepEqual(declared.evidence, { declared: true, predicateType: 'https://slsa.dev/provenance/v1' });

  const without = world('0.1.6', { provenance: {} });
  const absent = await npmProvenanceDeclared(io(without).io, '0.1.6');
  assert.equal(absent.state, 'ok');
  assert.deepEqual(absent.evidence, { declared: false, predicateType: null });

  // A version document that is itself missing proves nothing: the publish index can lag the same way.
  assert.equal((await npmProvenanceDeclared(io(world()).io, '9.9.9')).state, 'unknown');
  assert.equal((await npmProvenanceDeclared(io(world('0.1.6', { fail: [[/registry\.npmjs\.org/, 503]] })).io, '0.1.6')).state, 'unknown');
});

test('#174: a 404 is pending or missing by the caller\'s choice, never missing by accident', async () => {
  const { io: absent } = io(world('0.1.6', { provenance: {} }));
  assert.equal((await readNpmProvenance(absent, '0.1.6')).state, 'missing', 'the default keeps verify-release strict');
  const pending = await readNpmProvenance(absent, '0.1.6', { when404: 'pending' });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.evidence.reason, 'not-indexed');
  // A served attestation and an answered-but-empty body are not affected by the option.
  assert.equal((await readNpmProvenance(io(world()).io, '0.1.6', { when404: 'pending' })).state, 'ok');
  const empty = await readNpmProvenance(io(world('0.1.6', { fail: [[/attestations/, 200, { attestations: [] }]] })).io, '0.1.6', { when404: 'pending' });
  assert.equal(empty.state, 'missing', 'the registry answered: no SLSA v1 attestation is a definite absence, not a pending one');
});

test('#174: the publish time comes from the packument time map, and an unreadable one is unknown', async () => {
  const at = 1_700_000_000_000;
  const published = await readNpmPublishedAt(io(world('0.1.6', { publishedAt: at })).io, '0.1.6');
  assert.equal(published.state, 'ok');
  assert.equal(published.evidence.publishedAt, at);

  // A per-version map: the fake must not stamp one time onto every version (CodeRabbit, PR #177).
  const older = 1_600_000_000_000;
  const two = world('0.1.6', { publishedAt: { '0.1.6': at, '0.1.5': older } });
  two.npm['0.1.5'] = two.npm['0.1.6'];
  assert.equal((await readNpmPublishedAt(io(two).io, '0.1.6')).evidence.publishedAt, at);
  assert.equal((await readNpmPublishedAt(io(two).io, '0.1.5')).evidence.publishedAt, older, 'each version keeps its own publish time');

  // No time entry, an unreadable packument, and a version the registry does not have are all unknown:
  // an absent signal must never be read as "so it cannot be lagging" (or as anything else).
  assert.equal((await readNpmPublishedAt(io(world()).io, '0.1.6')).state, 'unknown');
  assert.equal((await readNpmPublishedAt(io(world('0.1.6', { fail: [[/registry\.npmjs\.org/, 503]] })).io, '0.1.6')).state, 'unknown');
});
