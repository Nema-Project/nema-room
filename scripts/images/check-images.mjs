import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compareReleaseVersions, readPackageVersion, readReleaseVersion } from '../desktop/release-version.mjs';

export const HUB_IMAGE = 'ghcr.io/nema-project/nema-room-hub';
export const WEB_IMAGE = 'ghcr.io/nema-project/nema-room-web';
export const IMAGE_BUDGET_BYTES = 800 * 1048576;

function serviceBlocks(text) {
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

/** Published compose pins hub and web to `version` and does not build them. */
export function assertComposeImages(text, version) {
  if (typeof version !== 'string' || version === 'latest' || version.startsWith('v')) {
    throw new Error(`Not a release version: ${JSON.stringify(version)}`);
  }
  if (/image:\s+\S+:latest\b/.test(text)) throw new Error('Published compose must not use the latest tag');
  const hub = `${HUB_IMAGE}:${version}`;
  const web = `${WEB_IMAGE}:${version}`;
  if (!text.includes(`image: ${hub}`)) throw new Error(`Published compose is missing ${hub}`);
  if (!text.includes(`image: ${web}`)) throw new Error(`Published compose is missing ${web}`);
  const services = serviceBlocks(text);
  for (const name of ['hub', 'web']) {
    const block = services[name];
    if (!block) throw new Error(`Published compose is missing ${name}`);
    if (/^\s*build:/m.test(block)) throw new Error(`${name} must not build in the published compose file`);
  }
  if (!services.hub.includes('127.0.0.1:${NEMA_HUB_PORT:-4400}:${NEMA_HUB_PORT:-4400}')) {
    throw new Error('Published hub port must default to ${NEMA_HUB_PORT:-4400} on the host and in the container');
  }
  if (!services.web.includes('127.0.0.1:${NEMA_WEB_PORT:-3000}:3000')) {
    throw new Error('Published web port must default to ${NEMA_WEB_PORT:-3000}');
  }
  if (!services.web.includes('NEMA_HUB_URL: ${NEMA_HUB_URL:-http://127.0.0.1:${NEMA_HUB_PORT:-4400}}')) {
    throw new Error('Published web NEMA_HUB_URL must follow NEMA_HUB_PORT');
  }
  if (!/image:\s*postgres:17\b/.test(services.postgres ?? '')) throw new Error('postgres image must stay postgres:17');
  if (!services.hub.includes('/api/daemon/status') || !services.web.includes('127.0.0.1:3000')) {
    throw new Error('Published hub and web need healthchecks');
  }
}

/** Tag shape plus desktop, local, and cli versions. Failures name all three versions. */
export function assertPackageVersions({ tag, desktop, local, cli }) {
  let version;
  try {
    version = readReleaseVersion(tag, tag.slice(1)).version;
  } catch (error) {
    throw new Error(`Release tag rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (desktop !== version || local !== version || cli !== version) {
    throw new Error(`Release ${tag} does not match desktop ${desktop}, local ${local}, cli ${cli}`);
  }
  return version;
}

/** True when `next` should replace the tag `latest` currently labels as `current`. An empty current means latest is absent. */
export function shouldMoveLatest(current, next) {
  if (current == null || current === '') return true;
  return compareReleaseVersions(current, next) <= 0;
}

/** `bytes` is `docker image inspect` Size. Returns the line the build log prints. */
export function assertImageBudget(name, bytes, budget = IMAGE_BUDGET_BYTES) {
  const value = Number(bytes);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`image size: ${name} is not a byte count`);
  const line = `image size: ${name} ${(value / 1048576).toFixed(1)} MiB`;
  if (value > budget) throw new Error(`${line} exceeds ${Math.round(budget / 1048576)} MiB`);
  return line;
}

async function readJsonVersion(root, rel) {
  return JSON.parse(await readFile(path.join(root, rel), 'utf8')).version;
}

export async function checkRepositoryImages(root, tag) {
  const desktop = await readJsonVersion(root, 'apps/desktop/package.json');
  const local = await readJsonVersion(root, 'apps/local/package.json');
  const cli = await readJsonVersion(root, 'apps/cli/package.json');
  const helper = await readPackageVersion(root);
  if (helper !== desktop) throw new Error(`desktop/local helper returned ${helper}, desktop package is ${desktop}`);
  const version = assertPackageVersions({ tag: tag ?? `v${desktop}`, desktop, local, cli });
  assertComposeImages(await readFile(path.join(root, 'docker-compose.yml'), 'utf8'), version);
  return version;
}

function moveLatestFromArgs(argv) {
  if (argv[0] !== '--move-latest') return null;
  const [, current, next, extra] = argv;
  if (next === undefined || extra) throw new Error('Usage: check-images.mjs --move-latest <current-or-empty> <next>');
  return shouldMoveLatest(current, next) ? 'move' : 'keep';
}

function budgetFromArgs(argv) {
  if (argv[0] !== '--budget') return null;
  const pairs = argv.slice(1);
  if (pairs.length === 0 || pairs.length % 2 !== 0) throw new Error('Usage: check-images.mjs --budget <name> <bytes>...');
  const lines = [];
  for (let i = 0; i < pairs.length; i += 2) lines.push(assertImageBudget(pairs[i], Number(pairs[i + 1])));
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const decision = moveLatestFromArgs(process.argv.slice(2));
    const lines = decision ? null : budgetFromArgs(process.argv.slice(2));
    if (decision) {
      process.stdout.write(`${decision}\n`);
    } else if (lines) {
      for (const line of lines) process.stdout.write(`${line}\n`);
    } else {
      const [tag, extra] = process.argv.slice(2);
      if (extra) throw new Error('Usage: check-images.mjs [v<version>]');
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
      const version = await checkRepositoryImages(root, tag);
      process.stdout.write(`image versions: ${version}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
