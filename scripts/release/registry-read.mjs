// Read-only views of the published artifacts for one release.
// Every reader answers with a tri-state result:
//   ok      - the registry positively showed the artifact
//   missing - the registry authoritatively said it is not there (404, MANIFEST_UNKNOWN, DENIED to an anonymous reader)
//   unknown - anything else: timeouts, 5xx, 429, unparsable bodies. Never reported as missing.
//               An unknown may carry `evidence.definitive` when the answer is final by itself (a 401/403,
//               or a body that parsed but is not the shape asked for): a re-reading caller must not wait.
// Nothing here writes. The installer's release-set.mjs counts unknown as absent on purpose; a report must not.
import { createHash } from 'node:crypto';
import { HUB_IMAGE, WEB_IMAGE, composeAssetVersion } from '../images/check-images.mjs';
import { checksumFileName, expectedAssets, expectedTargets } from '../desktop/release-manifest.mjs';

export const REPOSITORY = 'Nema-Project/nema-room';
export const NPM_PACKAGE = '@nema-project/nema';
const NPM = 'https://registry.npmjs.org';
const GHCR = 'https://ghcr.io';
const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;
const RETRY_DELAYS_MS = [2_000, 4_000];
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export const ok = (evidence = {}, detail = '') => ({ state: 'ok', detail, evidence });
export const missing = (detail, evidence = {}) => ({ state: 'missing', detail, evidence });
export const unknown = (detail, evidence = {}) => ({ state: 'unknown', detail, evidence });
/** Read, and the answer may still change: neither present nor authoritatively absent. */
export const pending = (detail, evidence = {}) => ({ state: 'pending', detail, evidence });

class Undetermined extends Error {}
/** An authoritative "not there" discovered deep inside a read (a listed asset or a referenced blob answering 404). */
class Absent extends Error {}

export const imageRepository = (image) => image.replace(/^ghcr\.io\//, '');
export const IMAGE_REPOSITORIES = Object.freeze({ hub: imageRepository(HUB_IMAGE), web: imageRepository(WEB_IMAGE) });

/**
 * `io` carries everything external: fetchImpl, sleep, and an optional GitHub token (read access only).
 * A response with a status the caller can interpret (2xx, 4xx other than 429) is returned as is.
 * Network errors, 5xx and 429 are retried, then raised as Undetermined.
 */
async function request(io, url, init = {}) {
  const sleep = io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = '';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const response = await io.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status >= 500 || response.status === 429) {
        last = `HTTP ${response.status}`;
        continue;
      }
      return response;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Undetermined(`${url}: ${last}`);
}

async function json(response, url) {
  try {
    return await response.json();
  } catch {
    throw new Undetermined(`${url}: unparsable JSON`);
  }
}

async function guard(read) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Absent) return missing(error.message);
    if (error instanceof Undetermined) return unknown(error.message);
    // A registry answer shaped in a way this reader does not expect is reported, not thrown.
    return unknown(`unexpected answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function githubHeaders(io, accept = 'application/vnd.github+json') {
  const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (io.token) headers.Authorization = `Bearer ${io.token}`;
  return headers;
}

// ---------- npm ----------

export function readNpmVersion(io, version) {
  return guard(async () => {
    const url = `${NPM}/${NPM_PACKAGE}/${version}`;
    const response = await request(io, url);
    if (response.status === 404) return missing(`npm has no ${NPM_PACKAGE}@${version}`);
    if (response.status !== 200) return unknown(`${url}: HTTP ${response.status}`);
    const body = await json(response, url);
    if (body?.version !== version) return unknown(`${url}: registry answered version ${JSON.stringify(body?.version)}`);
    const integrity = body?.dist?.integrity;
    if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) return unknown(`${url}: no sha512 dist.integrity`);
    return ok({ version, integrity });
  });
}

/**
 * Whether the registry's own version document declares provenance for this version, and which predicate
 * type. The registry writes `dist.attestations` into the version document as part of the publish, so this
 * is the one signal that separates "an attestation exists and its bundle index has not caught up"
 * (declared, endpoint still 404) from "nothing was ever attested".
 *
 * Answers `ok({ declared })` for a document that could be read, and `unknown` for one that could not: a
 * version document that is itself a 404 says nothing about attestations, because the publish index can be
 * lagging in exactly the same way. So `declared: false` is only ever returned for a document that was
 * actually read — the caller decides what that is worth (see awaitNpmProvenance).
 */
export function npmProvenanceDeclared(io, version) {
  return guard(async () => {
    const url = `${NPM}/${NPM_PACKAGE}/${version}`;
    const response = await request(io, url);
    if (response.status !== 200) return unknown(`${url}: HTTP ${response.status}`);
    const body = await json(response, url);
    const attestations = body?.dist?.attestations;
    if (attestations && typeof attestations === 'object' && typeof attestations.url === 'string') {
      return ok({ declared: true, predicateType: attestations.provenance?.predicateType ?? null });
    }
    return ok({ declared: false, predicateType: null });
  });
}

/**
 * Provenance as the registry reports it. The Sigstore bundle is not verified here.
 *
 * A 404 on the attestations endpoint has two meanings this reader cannot tell apart by itself: the
 * version was published without provenance (final), or it was published moments ago with provenance
 * and the endpoint's index has not caught up yet (transient: v0.2.1 answered 404 for over a minute
 * after the package itself was readable). Guessing "final" made promote stop with `missing` right
 * after its own publish; guessing "transient" would make a real absence wait out a budget and then
 * report an uncertainty instead of the absence. So the caller states which it is, through `when404`:
 *   'missing' (default) - a 404 is the answer. `verify-release` keeps exactly its old behaviour.
 *   'pending'           - a 404 is `pending` with `evidence.reason === 'not-indexed'`, which a caller
 *                         may re-read. Pending is not ok, so it still cannot pass for evidence; it is
 *                         not missing either, so no caller can read it as a definitive absence.
 *
 * `npmProvenanceDeclared` is the deciding signal: when the version document already carries
 * `dist.attestations`, a 404 from this endpoint can only be index lag.
 */
export function readNpmProvenance(io, version, { when404 = 'missing' } = {}) {
  return guard(async () => {
    const url = `${NPM}/-/npm/v1/attestations/${encodeURIComponent(NPM_PACKAGE)}@${version}`;
    const response = await request(io, url);
    if (response.status === 404) {
      if (when404 === 'pending') return pending(`npm has not indexed provenance for ${NPM_PACKAGE}@${version} yet`, { reason: 'not-indexed' });
      return missing(`npm has no provenance for ${NPM_PACKAGE}@${version}`);
    }
    // A denial is final: another read cannot make the bundle visible.
    if (response.status === 401 || response.status === 403) return unknown(`${url}: HTTP ${response.status}`, { definitive: true, reason: 'denied' });
    if (response.status !== 200) return unknown(`${url}: HTTP ${response.status}`);
    const body = await json(response, url);
    const slsa = (body?.attestations ?? []).find((item) => item?.predicateType === 'https://slsa.dev/provenance/v1');
    if (!slsa) return missing(`npm provenance for ${version} has no SLSA v1 attestation`);
    let statement;
    try {
      statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    } catch {
      return unknown(`${url}: unreadable SLSA statement`);
    }
    const definition = statement?.predicate?.buildDefinition ?? {};
    const workflow = definition.externalParameters?.workflow ?? {};
    // The source checkout is the dependency whose URI names this repository; do not assume it is listed first.
    const source = (definition.resolvedDependencies ?? []).find((dependency) => typeof dependency?.uri === 'string' && dependency.uri.startsWith(`git+https://github.com/${REPOSITORY}@`));
    const commit = source?.digest?.gitCommit ?? null;
    return ok({
      workflowPath: workflow.path ?? null,
      workflowRef: workflow.ref ?? null,
      commit,
      event: definition.internalParameters?.github?.event_name ?? null,
      signatureVerified: false,
    });
  });
}

/**
 * When the registry says this exact version was published, from the packument's own `time` map.
 * Promote uses it to decide whether a missing attestation can still be index lag: only a recent
 * publish can be lagging. Answers `{ state: 'ok', evidence: { publishedAt } }` with epoch ms, or
 * `unknown` when the packument or its time map cannot be read (which proves nothing either way).
 */
export function readNpmPublishedAt(io, version) {
  return guard(async () => {
    const url = `${NPM}/${NPM_PACKAGE}`;
    // The full packument, not the abbreviated one: only the full document carries `time`.
    const response = await request(io, url, { headers: { Accept: 'application/json' } });
    if (response.status === 404) return missing(`npm has no ${NPM_PACKAGE}`);
    if (response.status !== 200) return unknown(`${url}: HTTP ${response.status}`);
    const body = await json(response, url);
    const stamp = body?.time?.[version];
    if (typeof stamp !== 'string') return unknown(`${url}: no publish time for ${version}`);
    const publishedAt = Date.parse(stamp);
    if (!Number.isFinite(publishedAt)) return unknown(`${url}: unreadable publish time ${JSON.stringify(stamp)} for ${version}`);
    return ok({ version, publishedAt });
  });
}

export function readNpmDistTags(io) {
  return guard(async () => {
    const url = `${NPM}/-/package/${NPM_PACKAGE}/dist-tags`;
    const response = await request(io, url);
    if (response.status === 404) return missing(`npm has no ${NPM_PACKAGE}`);
    // Denial and an answer of the wrong shape are definitive: another read will not change them, so a
    // caller that re-reads within a budget (promote) must stop at once rather than wait out the budget.
    if (response.status === 401 || response.status === 403) return unknown(`${url}: HTTP ${response.status}`, { definitive: true, reason: 'denied' });
    if (response.status !== 200) return unknown(`${url}: HTTP ${response.status}`);
    const body = await json(response, url);
    // A dist-tags answer is a map of tag name to version. An array or a scalar parses but is not that map.
    if (!body || typeof body !== 'object' || Array.isArray(body)) return unknown(`${url}: not a tag map`, { definitive: true, reason: 'unparsable' });
    return ok({ tags: body });
  });
}

// ---------- GHCR ----------

async function ghcrToken(io, repository) {
  const url = `${GHCR}/token?service=ghcr.io&scope=repository:${repository}:pull`;
  const response = await request(io, url);
  if (response.status === 401 || response.status === 403) return { denied: true };
  if (response.status !== 200) throw new Undetermined(`${url}: HTTP ${response.status}`);
  const body = await json(response, url);
  if (typeof body?.token !== 'string' || !body.token) throw new Undetermined(`${url}: no token in the answer`);
  return { token: body.token };
}

async function ghcrGet(io, token, repository, kind, reference, accept) {
  const url = `${GHCR}/v2/${repository}/${kind}/${reference}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (accept) headers.Accept = accept;
  const response = await request(io, url, { headers });
  return { url, response };
}

/**
 * Resolve <repository>:<reference> anonymously down to its linux/amd64 image and read the version label.
 * The published index is nested: top index -> child index (no platform) -> linux/amd64 manifest plus an
 * unknown/unknown attestation entry. Up to three index levels are followed.
 */
export function readImage(io, repository, reference) {
  return guard(async () => {
    const auth = await ghcrToken(io, repository);
    if (auth.denied) return missing(`ghcr.io/${repository} is not anonymously readable (DENIED)`, { reason: 'denied' });
    const top = await ghcrGet(io, auth.token, repository, 'manifests', reference, MANIFEST_ACCEPT);
    if (top.response.status === 404) return missing(`ghcr.io/${repository}:${reference} does not exist (MANIFEST_UNKNOWN)`, { reason: 'absent' });
    if (top.response.status === 401 || top.response.status === 403) return missing(`ghcr.io/${repository}:${reference} is not anonymously readable`, { reason: 'denied' });
    if (top.response.status !== 200) return unknown(`${top.url}: HTTP ${top.response.status}`);
    const digest = top.response.headers?.get?.('docker-content-digest') ?? null;
    let manifest = await json(top.response, top.url);
    for (let depth = 0; depth < 3 && Array.isArray(manifest?.manifests); depth += 1) {
      const entries = manifest.manifests;
      const platform = entries.find((entry) => entry?.platform?.os === 'linux' && entry?.platform?.architecture === 'amd64');
      const nested = entries.filter((entry) => !entry?.platform && /index|manifest\.list/.test(entry?.mediaType ?? ''));
      const next = platform ?? (nested.length === 1 ? nested[0] : null);
      if (!next) return missing(`ghcr.io/${repository}:${reference} has no linux/amd64 image`, { reason: 'no-platform' });
      const child = await ghcrGet(io, auth.token, repository, 'manifests', next.digest, MANIFEST_ACCEPT);
      if (child.response.status === 404) return missing(`ghcr.io/${repository}:${reference} references ${next.digest}, which does not exist`, { reason: 'broken' });
      if (child.response.status !== 200) return unknown(`${child.url}: HTTP ${child.response.status}`);
      manifest = await json(child.response, child.url);
      if (platform) manifest = { ...manifest, platformDigest: next.digest };
    }
    const configDigest = manifest?.config?.digest;
    if (!configDigest) return missing(`ghcr.io/${repository}:${reference} has no linux/amd64 image config`, { reason: 'no-platform' });
    const config = await ghcrGet(io, auth.token, repository, 'blobs', configDigest);
    if (config.response.status === 404) return missing(`ghcr.io/${repository}:${reference} references config ${configDigest}, which does not exist`, { reason: 'broken' });
    if (config.response.status !== 200) return unknown(`${config.url}: HTTP ${config.response.status}`);
    const body = await json(config.response, config.url);
    const labels = body?.config?.Labels ?? {};
    return ok({
      reference: `ghcr.io/${repository}:${reference}`,
      digest,
      platformDigest: manifest.platformDigest ?? null,
      label: labels['org.opencontainers.image.version'] ?? null,
      revision: labels['org.opencontainers.image.revision'] ?? null,
    });
  });
}

// ---------- GitHub ----------

export function readTagCommit(io, tag) {
  return guard(async () => {
    const url = `${GITHUB_API}/repos/${REPOSITORY}/git/ref/tags/${tag}`;
    const response = await request(io, url, { headers: githubHeaders(io) });
    if (response.status === 404) return missing(`tag ${tag} does not exist`);
    if (response.status !== 200) return unknown(`${url}: HTTP ${response.status}`);
    let object = (await json(response, url))?.object;
    for (let depth = 0; depth < 3 && object?.type === 'tag'; depth += 1) {
      const tagUrl = `${GITHUB_API}/repos/${REPOSITORY}/git/tags/${object.sha}`;
      const tagResponse = await request(io, tagUrl, { headers: githubHeaders(io) });
      if (tagResponse.status !== 200) return unknown(`${tagUrl}: HTTP ${tagResponse.status}`);
      object = (await json(tagResponse, tagUrl))?.object;
    }
    if (object?.type !== 'commit' || !/^[0-9a-f]{40}$/.test(object?.sha ?? '')) return unknown(`${url}: tag does not resolve to a commit`);
    return ok({ tag, commit: object.sha });
  });
}

/** Whether the token can see draft Releases: only collaborators with push access can. */
async function tokenSeesDrafts(io) {
  const url = `${GITHUB_API}/repos/${REPOSITORY}`;
  const response = await request(io, url, { headers: githubHeaders(io) });
  if (response.status !== 200) return false;
  const body = await json(response, url);
  return body?.permissions?.push === true;
}

function releaseEvidence(tag, body) {
  const assets = (body?.assets ?? []).map((asset) => ({ name: asset.name, id: asset.id, url: asset.browser_download_url, apiUrl: asset.url }));
  return ok({ tag, isDraft: Boolean(body?.draft), isPrerelease: Boolean(body?.prerelease), assets });
}

const RELEASE_PAGES = 10;

/**
 * `GET /releases/tags/{tag}` answers only for published Releases: a draft is a 404 there for every caller,
 * push access or not. Drafts appear only in `GET /releases`, and only for callers with push access. So a 404
 * is followed by a full listing, and the listing is authoritative only for a token known to see drafts
 * (`io.draftsVisible`, set by a workflow that holds contents: write, or `permissions.push` on the repo).
 */
export function readRelease(io, tag) {
  return guard(async () => {
    const url = `${GITHUB_API}/repos/${REPOSITORY}/releases/tags/${tag}`;
    const response = await request(io, url, { headers: githubHeaders(io) });
    if (response.status === 200) return releaseEvidence(tag, await json(response, url));
    if (response.status !== 404) return unknown(`${url}: HTTP ${response.status}`);
    if (!io.token) return unknown(`release ${tag} is not visible anonymously: missing, or a draft; set GITHUB_TOKEN to tell`);
    if (!(io.draftsVisible === true || (await tokenSeesDrafts(io)))) return unknown(`release ${tag} is not visible to this token, which cannot be shown to see drafts: missing, or a draft`);
    const matches = [];
    for (let page = 1; ; page += 1) {
      if (page > RELEASE_PAGES) return unknown(`more than ${RELEASE_PAGES * 100} releases; ${tag} not found in the first ${RELEASE_PAGES} pages`);
      const listUrl = `${GITHUB_API}/repos/${REPOSITORY}/releases?per_page=100&page=${page}`;
      const list = await request(io, listUrl, { headers: githubHeaders(io) });
      if (list.status !== 200) return unknown(`${listUrl}: HTTP ${list.status}`);
      const body = await json(list, listUrl);
      if (!Array.isArray(body)) return unknown(`${listUrl}: not a list`);
      matches.push(...body.filter((release) => release?.tag_name === tag));
      if (body.length < 100) break;
    }
    if (matches.length === 0) return missing(`release ${tag} does not exist`);
    if (matches.length > 1) return unknown(`${matches.length} releases name ${tag}`);
    return releaseEvidence(tag, matches[0]);
  });
}

/** The latest published, non-prerelease Release, as GitHub's own latest pointer reports it. */
export function readLatestRelease(io) {
  return guard(async () => {
    const url = `${GITHUB_API}/repos/${REPOSITORY}/releases/latest`;
    const response = await request(io, url, { headers: githubHeaders(io) });
    if (response.status === 404) return missing('no published release is marked latest');
    if (response.status !== 200) return unknown(`${url}: HTTP ${response.status}`);
    const body = await json(response, url);
    if (typeof body?.tag_name !== 'string') return unknown(`${url}: no tag_name`);
    return ok({ tag: body.tag_name });
  });
}

/** Download one release asset as bytes. Drafts need the API URL and a token; published assets use the public URL. */
export async function readReleaseAsset(io, asset) {
  const useApi = Boolean(io.token && asset.apiUrl);
  const url = useApi ? asset.apiUrl : asset.url;
  const headers = useApi ? githubHeaders(io, 'application/octet-stream') : {};
  const response = await request(io, url, { headers, redirect: 'follow' });
  if (response.status === 404) throw new Absent(`release asset ${asset.name} is listed but its download answers 404`);
  if (response.status !== 200) throw new Undetermined(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The asset names every release from v0.1.6 on must carry, derived from code rather than from the manifest. */
export function expectedReleaseAssets(version) {
  const names = [];
  for (const target of expectedTargets) names.push(...expectedAssets(version, target), checksumFileName(version, target));
  names.push('docker-compose.yml', `SHA256SUMS-${version}.txt`, `release-manifest-${version}.json`);
  return names.sort();
}

/**
 * Check a Release against the code-derived asset set, its manifest, and its Compose asset.
 * Returns ok with commit evidence, or the first authoritative gap as missing.
 */
export function checkReleaseAssets(io, version, release) {
  return guard(async () => {
    const expected = expectedReleaseAssets(version);
    const actual = release.assets.map((asset) => asset.name).sort();
    const absent = expected.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !expected.includes(name));
    if (absent.length || extra.length) {
      const parts = [];
      if (absent.length) parts.push(`missing ${absent.join(', ')}`);
      if (extra.length) parts.push(`unexpected ${extra.join(', ')}`);
      return missing(`release v${version} asset set differs: ${parts.join('; ')}`);
    }
    const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
    const manifestText = (await readReleaseAsset(io, byName.get(`release-manifest-${version}.json`))).toString('utf8');
    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      return missing(`release-manifest-${version}.json is not JSON`);
    }
    if (manifest?.version !== version) return missing(`release manifest names version ${JSON.stringify(manifest?.version)}`);
    const targets = Object.keys(manifest?.targets ?? {}).sort();
    if (targets.join(',') !== [...expectedTargets].sort().join(',')) return missing(`release manifest targets are ${targets.join(', ') || 'empty'}; expected ${expectedTargets.join(', ')}`);
    for (const target of expectedTargets) {
      const entries = manifest.targets[target];
      if (!Array.isArray(entries) || entries.some((asset) => typeof asset?.name !== 'string')) return missing(`release manifest ${target} entry is malformed`);
      const listed = entries.map((asset) => asset.name).sort();
      const wanted = [...expectedAssets(version, target), checksumFileName(version, target)].sort();
      if (listed.join(',') !== wanted.join(',')) return missing(`release manifest ${target} lists ${listed.join(', ')}; expected ${wanted.join(', ')}`);
    }
    if (!manifest.compose) return missing('release manifest has no compose entry');
    const composeBytes = await readReleaseAsset(io, byName.get('docker-compose.yml'));
    const composeText = composeBytes.toString('utf8');
    const composeSha = createHash('sha256').update(composeBytes).digest('hex');
    if (composeSha !== manifest.compose.sha256) return missing(`docker-compose.yml sha256 ${composeSha} differs from the manifest's ${manifest.compose.sha256}`);
    let pinned;
    try {
      pinned = composeAssetVersion(composeText);
    } catch (error) {
      return missing(`docker-compose.yml: ${error.message}`);
    }
    if (pinned !== version) return missing(`docker-compose.yml pins ${pinned}, not ${version}`);
    return ok({
      tag: release.tag,
      draft: release.isDraft,
      prerelease: release.isPrerelease,
      assets: actual.length,
      manifestCommit: manifest.build?.commit ?? null,
      manifestVersion: manifest.version,
      composeSha256: composeSha,
    });
  });
}
