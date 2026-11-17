import { compareReleaseVersions, readReleaseVersion } from '../desktop/release-version.mjs';

/**
 * The shared image model: repository names, platform rules, and the compose
 * version reader. This module is a leaf on purpose — both the check-images
 * CLI and the release registry reader build on it. registry-read.mjs must
 * never import the check-images CLI entry: the CLI's `--registry` mode
 * imports the registry reader, and that cycle deadlocks the CLI's top-level
 * await (Node exits 13, "unsettled top-level await") when check-images is
 * the entry module.
 */

export const HUB_IMAGE = 'ghcr.io/nema-project/nema-room-hub';
export const WEB_IMAGE = 'ghcr.io/nema-project/nema-room-web';

export const IMAGE_PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
export const INDEX_MEDIA_TYPES = Object.freeze([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

/** Attestations are not runnable platforms. Duplicate platform choices are ambiguous. */
export function assertMultiarchManifest(manifest) {
  if (manifest?.schemaVersion !== 2 || !INDEX_MEDIA_TYPES.includes(manifest?.mediaType) || !Array.isArray(manifest?.manifests)) {
    throw new Error('Expected an OCI index or Docker manifest list');
  }
  for (const platform of IMAGE_PLATFORMS) {
    const entries = manifest.manifests.filter((entry) => `${entry?.platform?.os}/${entry?.platform?.architecture}` === platform);
    if (entries.length !== 1) throw new Error(`Expected exactly one ${platform} image, found ${entries.length}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(entries[0].digest ?? '')) throw new Error(`Invalid ${platform} digest`);
    if (!['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(entries[0].mediaType)) {
      throw new Error(`Expected a runnable ${platform} image manifest`);
    }
  }
}

export function serviceBlocks(text) {
  const blocks = {};
  let name = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      name = header[1];
      blocks[name] = '';
      continue;
    }
    if (!name) continue;
    if (line.startsWith('    ') || line.trim() === '' || line.trim().startsWith('#')) {
      blocks[name] += `${line}\n`;
      continue;
    }
    if (!line.startsWith(' ') && !line.startsWith('#')) name = null;
  }
  return blocks;
}

export function assertSingleImageKey(block, name) {
  if ((block?.match(/^    image\s*:/gm) ?? []).length !== 1) throw new Error(`${name} must have exactly one image key`);
}

export function validateVersion(version) {
  if (typeof version !== 'string' || version.startsWith('v')) throw new Error(`Not a release version: ${version}`);
  readReleaseVersion(`v${version}`, version);
}

export function composeAssetVersion(text) {
  const services = serviceBlocks(text);
  const versions = [['hub', HUB_IMAGE], ['web', WEB_IMAGE]].map(([name, image]) => {
    assertSingleImageKey(services[name], name);
    const line = (services[name] ?? '').split('\n').map(line => line.trim()).find(line => line.startsWith(`image: ${image}:`));
    if (!line) throw new Error(`Published compose is missing ${image}`);
    return line.slice(`image: ${image}:`.length);
  });
  if (versions[0] !== versions[1]) throw new Error(`Image versions differ: hub ${versions[0]}, web ${versions[1]}`);
  validateVersion(versions[0]);
  return versions[0];
}

/** True when `next` should replace the tag `latest` currently labels as `current`. An empty current means latest is absent. */
export function shouldMoveLatest(current, next) {
  if (current == null || current === '') return true;
  return compareReleaseVersions(current, next) <= 0;
}
