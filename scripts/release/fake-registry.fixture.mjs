// Test-only fake of npm, GHCR and the GitHub API, shaped like the real v0.1.6 answers.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderComposeAsset } from '../images/check-images.mjs';
import { checksumFileName, expectedAssets, expectedTargets } from '../desktop/release-manifest.mjs';

const template = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
export const COMMIT = '280b224589ae13d4db99a4481bcd0baf58cf273d';
export const OTHER_COMMIT = '1111111111111111111111111111111111111111';
export const integrityOf = (text) => `sha512-${createHash('sha512').update(text).digest('base64')}`;

const response = (status, body, headers = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  async json() {
    if (typeof body === 'string') return JSON.parse(body);
    return body;
  },
  async text() {
    return Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body);
  },
  async arrayBuffer() {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  },
});

function provenance({ commit, path = '.github/workflows/npm-publish.yml', ref, event = 'push', otherDependencyFirst = false }) {
  const source = { uri: `git+https://github.com/Nema-Project/nema-room@${ref}`, digest: { gitCommit: commit } };
  const other = { uri: 'git+https://github.com/actions/runner-images@main', digest: { gitCommit: '2'.repeat(40) } };
  const statement = {
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { ref, repository: 'https://github.com/Nema-Project/nema-room', path } },
        internalParameters: { github: { event_name: event } },
        resolvedDependencies: otherDependencyFirst ? [other, source] : [source],
      },
    },
  };
  return {
    attestations: [
      { predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: { dsseEnvelope: { payload: '' } } },
      { predicateType: 'https://slsa.dev/provenance/v1', bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') } } },
    ],
  };
}

export function releaseAssets(version, { commit = COMMIT, dropTarget = null, composeVersion = version, composeSha = null, extra = [], mutateManifest = (m) => m } = {}) {
  const compose = renderComposeAsset(template, composeVersion);
  const targets = {};
  const assets = {};
  for (const target of expectedTargets) {
    if (target === dropTarget) continue;
    targets[target] = [];
    for (const name of [...expectedAssets(version, target), checksumFileName(version, target)]) {
      targets[target].push({ name, size: 3, sha256: 'x' });
      assets[name] = Buffer.from('bin');
    }
  }
  const sha256 = composeSha ?? createHash('sha256').update(compose).digest('hex');
  const manifest = { schemaVersion: 1, version, prerelease: false, targets, build: { commit, ref: `refs/tags/v${version}` }, compose: { name: 'docker-compose.yml', size: compose.length, sha256 } };
  assets['docker-compose.yml'] = Buffer.from(compose);
  assets[`SHA256SUMS-${version}.txt`] = Buffer.from('sums');
  assets[`release-manifest-${version}.json`] = Buffer.from(JSON.stringify(mutateManifest(manifest)));
  for (const name of extra) assets[name] = Buffer.from('extra');
  return assets;
}

/** A complete, consistent release of `version`. Every part can be overridden or removed. */
export function world(version = '0.1.6', overrides = {}) {
  const tarball = `tarball-${version}`;
  const base = {
    npm: { [version]: { integrity: integrityOf(tarball) } },
    distTags: { latest: version },
    provenance: { [version]: { commit: COMMIT, ref: `refs/tags/v${version}` } },
    images: {
      'nema-project/nema-room-hub': { [version]: { label: version }, latest: { label: version } },
      'nema-project/nema-room-web': { [version]: { label: version }, latest: { label: version } },
    },
    denied: [],
    tags: { [`v${version}`]: { commit: COMMIT, annotated: true } },
    releases: { [`v${version}`]: { draft: false, prerelease: false, assets: releaseAssets(version) } },
    latestRelease: `v${version}`,
    tokenPush: true,
    fail: [],
    throwOn: [],
  };
  return { ...base, ...overrides, tarball };
}

/** Builds fetchImpl over a world. `calls` records every URL. */
export function fakeFetch(w) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    calls.push(url);
    if (w.throwOn.some((pattern) => pattern.test(url))) throw new TypeError('fetch failed');
    const failing = w.fail.find(([pattern]) => pattern.test(url));
    if (failing) return response(failing[1], failing[2] ?? { error: 'fail' });
    let match;
    if ((match = /^https:\/\/registry\.npmjs\.org\/-\/package\/@nema-project\/nema\/dist-tags$/.exec(url))) return response(200, w.distTags);
    if ((match = /^https:\/\/registry\.npmjs\.org\/-\/npm\/v1\/attestations\/%40nema-project%2Fnema@(.+)$/.exec(url))) {
      const p = w.provenance[match[1]];
      return p ? response(200, provenance(p)) : response(404, { error: 'Not found' });
    }
    if ((match = /^https:\/\/registry\.npmjs\.org\/@nema-project\/nema\/(.+)$/.exec(url))) {
      const v = w.npm[match[1]];
      return v ? response(200, { version: match[1], dist: { integrity: v.integrity } }) : response(404, { error: 'Not found' });
    }
    if ((match = /^https:\/\/ghcr\.io\/token\?service=ghcr\.io&scope=repository:(.+):pull$/.exec(url))) {
      if (w.denied.includes(match[1]) || !w.images[match[1]]) return response(403, { errors: [{ code: 'DENIED' }] });
      return response(200, { token: `token-${match[1]}` });
    }
    if ((match = /^https:\/\/ghcr\.io\/v2\/(.+)\/(manifests|blobs)\/(.+)$/.exec(url))) {
      const [, repository, kind, reference] = match;
      if (init.headers?.Authorization !== `Bearer token-${repository}`) return response(401, { errors: [{ code: 'UNAUTHORIZED' }] });
      const images = w.images[repository] ?? {};
      if (kind === 'blobs') {
        const ref = reference.replace(/^sha256:config-/, '');
        const image = images[ref];
        if (image?.brokenConfig) return response(404, { errors: [{ code: 'BLOB_UNKNOWN' }] });
        const labels = { 'org.opencontainers.image.source': 'https://github.com/Nema-Project/nema-room' };
        if (image?.label) labels['org.opencontainers.image.version'] = image.label;
        return response(200, { os: 'linux', architecture: 'amd64', config: { Labels: labels } });
      }
      if (reference.startsWith('sha256:child-')) {
        const ref = reference.slice('sha256:child-'.length);
        if (images[ref]?.brokenChild) return response(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
        const entries = [];
        if (!images[ref]?.noPlatform) entries.push({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:amd64-${ref}`, platform: { os: 'linux', architecture: 'amd64' } });
        entries.push({ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:att-${ref}`, platform: { os: 'unknown', architecture: 'unknown' } });
        return response(200, { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: entries });
      }
      if (reference.startsWith('sha256:amd64-')) {
        const ref = reference.slice('sha256:amd64-'.length);
        return response(200, { schemaVersion: 2, config: { digest: `sha256:config-${ref}` }, layers: [] });
      }
      if (!images[reference]) return response(404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
      return response(200, { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', digest: `sha256:child-${reference}` }] }, { 'docker-content-digest': `sha256:top-${reference}` });
    }
    if ((match = /^https:\/\/api\.github\.com\/repos\/Nema-Project\/nema-room\/git\/ref\/tags\/(.+)$/.exec(url))) {
      const tag = w.tags[match[1]];
      if (!tag) return response(404, { message: 'Not Found' });
      return response(200, { object: tag.annotated ? { type: 'tag', sha: `tagobj-${match[1]}` } : { type: 'commit', sha: tag.commit } });
    }
    if ((match = /^https:\/\/api\.github\.com\/repos\/Nema-Project\/nema-room\/git\/tags\/tagobj-(.+)$/.exec(url))) {
      return response(200, { object: { type: 'commit', sha: w.tags[match[1]].commit } });
    }
    if (url === 'https://api.github.com/repos/Nema-Project/nema-room') {
      return response(200, init.headers?.Authorization ? { full_name: 'Nema-Project/nema-room', permissions: { pull: true, push: w.tokenPush } } : { full_name: 'Nema-Project/nema-room' });
    }
    if (url === 'https://api.github.com/repos/Nema-Project/nema-room/releases/latest') {
      return w.latestRelease ? response(200, { tag_name: w.latestRelease }) : response(404, { message: 'Not Found' });
    }
    if ((match = /^https:\/\/api\.github\.com\/repos\/Nema-Project\/nema-room\/releases\/tags\/(.+)$/.exec(url))) {
      const release = w.releases[match[1]];
      const visible = release && (!release.draft || init.headers?.Authorization);
      if (!visible) return response(404, { message: 'Not Found' });
      const assets = Object.keys(release.assets).map((name, id) => ({
        id,
        name,
        browser_download_url: `https://github.com/Nema-Project/nema-room/releases/download/${match[1]}/${name}`,
        url: `https://api.github.com/repos/Nema-Project/nema-room/releases/assets/${match[1]}/${name}`,
      }));
      return response(200, { tag_name: match[1], draft: release.draft, prerelease: release.prerelease, assets });
    }
    if ((match = /^https:\/\/(?:github\.com\/Nema-Project\/nema-room\/releases\/download|api\.github\.com\/repos\/Nema-Project\/nema-room\/releases\/assets)\/([^/]+)\/(.+)$/.exec(url))) {
      const body = w.releases[match[1]]?.assets[match[2]];
      return body ? response(200, body) : response(404, 'Not Found');
    }
    throw new Error(`fake registry has no route for ${url}`);
  };
  return { fetchImpl, calls };
}

export const io = (w, extra = {}) => {
  const fake = fakeFetch(w);
  return { io: { fetchImpl: fake.fetchImpl, sleep: async () => {}, ...extra }, calls: fake.calls };
};
