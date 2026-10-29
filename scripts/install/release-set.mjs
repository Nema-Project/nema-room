import { composeAssetVersion, HUB_IMAGE, WEB_IMAGE } from '../images/check-images.mjs';

const NPM_PACKAGE = '@nema-project/nema';
const GHCR = 'https://ghcr.io';
const TIMEOUT_MS = 15_000;
// Ask for every manifest media type a registry may return, or a modern index comes back 406.
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/**
 * The four artifacts a version must have before it can be called installable.
 * Kept as plain strings so a failure message can name them verbatim.
 */
export function releaseSetItems(version) {
  return [
    'compose asset',
    `hub image ${HUB_IMAGE}:${version}`,
    `web image ${WEB_IMAGE}:${version}`,
    `npm ${NPM_PACKAGE}@${version}`,
  ];
}

async function get(fetchImpl, url, init = {}) {
  // One attempt, no retry: an installer is better off failing than guessing.
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function npmExists(fetchImpl, version) {
  // The scope slash stays unencoded: the registry answers both spellings, so the readable one wins.
  const response = await get(fetchImpl, `https://registry.npmjs.org/${NPM_PACKAGE}/${version}`);
  if (response.status !== 200) return false;
  const body = await response.json();
  return body?.version === version;
}

async function manifestExists(fetchImpl, repository, version) {
  const tokenResponse = await get(fetchImpl, `${GHCR}/token?service=${GHCR}&scope=repository:${repository}:pull`);
  if (tokenResponse.status !== 200) return false;
  const tokenBody = await tokenResponse.json();
  if (typeof tokenBody?.token !== 'string' || !tokenBody.token) return false;
  const manifest = await get(fetchImpl, `${GHCR}/v2/${repository}/manifests/${version}`, {
    headers: { Authorization: `Bearer ${tokenBody.token}`, Accept: ACCEPT },
  });
  return manifest.status === 200;
}

/**
 * Check the released artifacts for one version. A network failure, a timeout, or unparsable JSON
 * counts as absent: the installer must not treat an unanswered request as evidence of an artifact.
 */
export async function checkReleaseSet({ version, composeText, fetchImpl = globalThis.fetch }) {
  const items = releaseSetItems(version);
  const missing = [];

  let composeVersion = null;
  try {
    composeVersion = composeAssetVersion(composeText);
  } catch (error) {
    missing.push(`${items[0]} (${error.message})`);
  }
  if (composeVersion !== null && composeVersion !== version) {
    missing.push(`${items[0]} (compose pins ${composeVersion})`);
  }

  const checks = [
    [items[1], () => manifestExists(fetchImpl, 'nema-project/nema-room-hub', version)],
    [items[2], () => manifestExists(fetchImpl, 'nema-project/nema-room-web', version)],
    [items[3], () => npmExists(fetchImpl, version)],
  ];
  for (const [item, check] of checks) {
    let present = false;
    try {
      present = await check();
    } catch {
      present = false;
    }
    if (!present) missing.push(item);
  }

  if (missing.length > 0) throw new Error(`Release ${version} is not installable: ${missing.join('; ')}`);

  const evidence = [
    `${items[0]}: compose pins ${version} on both images`,
    `${items[1]}: manifest present`,
    `${items[2]}: manifest present`,
    `${items[3]}: registry returns version ${version}`,
  ];
  return { version, evidence };
}
