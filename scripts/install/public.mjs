import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { composeAssetVersion } from '../images/check-images.mjs';
import { checkReleaseSet } from './release-set.mjs';

const REPO = 'https://github.com/Nema-Project/nema-room';
export const latestComposeUrl = `${REPO}/releases/latest/download/docker-compose.yml`;
export const versionedComposeUrl = (version) => `${REPO}/releases/download/v${version}/docker-compose.yml`;

const LOCK = '.nema-install.lock';
const ENV_FILE = '.env';
const COMPOSE_FILE = 'docker-compose.yml';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/** The value of NEMA_IMAGE_TAG in an `.env` body, or null when the key is absent. */
export function readLockedVersion(envText) {
  if (envText === null) return null;
  for (const line of envText.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?NEMA_IMAGE_TAG\s*=\s*(.*)$/);
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function assertUsableLock(value) {
  if (value === '') throw new Error('NEMA_IMAGE_TAG is empty in .env; set a released version or remove the key');
  if (value === 'latest') throw new Error('NEMA_IMAGE_TAG=latest cannot be locked; a released version is required');
  if (value.startsWith('v')) throw new Error(`NEMA_IMAGE_TAG=${value} must not carry a v prefix`);
  if (!SEMVER.test(value)) throw new Error(`NEMA_IMAGE_TAG=${value} is not a strict SemVer version`);
}

/** Replace the NEMA_IMAGE_TAG line, or append one, leaving every other byte untouched. */
function withLockedVersion(envText, version) {
  const line = `NEMA_IMAGE_TAG=${version}`;
  if (envText === null) return `# Locked by the Nema installer. Do not edit while installing.\n${line}\n`;
  const lines = envText.split('\n');
  const index = lines.findIndex((row) => /^\s*(?:export\s+)?NEMA_IMAGE_TAG\s*=/.test(row));
  if (index === -1) {
    const body = envText.endsWith('\n') || envText === '' ? envText : `${envText}\n`;
    return `${body}${line}\n`;
  }
  lines[index] = line;
  return lines.join('\n');
}

/**
 * Decide what to install and where, without writing anything.
 *
 * `composeText` is the exact bytes that passed the version check; `applyInstall` writes those and
 * never fetches again.
 */
export async function resolveInstall({ dir, fetchText, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const envPath = path.join(dir, ENV_FILE);
  const composePath = path.join(dir, COMPOSE_FILE);
  const envText = readIf(envPath);
  const locked = readLockedVersion(envText);
  if (locked !== null) assertUsableLock(locked);

  const local = readIf(composePath);
  if (local !== null) {
    const localVersion = composeAssetVersion(local);
    if (locked !== null && localVersion !== locked) {
      throw new Error(`Local docker-compose.yml pins ${localVersion} but .env locks ${locked}; refusing to guess`);
    }
    if (locked === null) await checkReleaseSet({ version: localVersion, composeText: local, fetchImpl });
    return plan({ version: localVersion, action: locked === null ? 'write' : 'reuse', composeText: local, composeSource: 'local', envPath, composePath, notes: [] });
  }

  if (locked !== null) {
    const url = versionedComposeUrl(locked);
    const composeText = await fetchText(url);
    const assetVersion = composeAssetVersion(composeText);
    if (assetVersion !== locked) {
      throw new Error(`Release v${locked} publishes a compose file pinning ${assetVersion}; refusing to install a different version`);
    }
    await checkReleaseSet({ version: locked, composeText, fetchImpl });
    return plan({ version: locked, action: 'reuse', composeText, composeSource: 'versioned', envPath, composePath, notes: [`install stays on ${locked}; this asset came from ${url}`] });
  }

  const composeText = await fetchText(latestComposeUrl);
  const version = composeAssetVersion(composeText);
  await checkReleaseSet({ version, composeText, fetchImpl });
  return plan({ version, action: 'write', composeText, composeSource: 'latest', envPath, composePath, notes: [`resolved ${now().toISOString()} from the latest release`] });

  function plan(fields) {
    return { ...fields, daemonCommand: `npm i -g @nema-project/nema@${fields.version}` };
  }
}

function writeAtomic(target, body) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomBytes(6).toString('hex')}`);
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

function assertCommitted(dir, version) {
  const env = readLockedVersion(readFileSync(path.join(dir, ENV_FILE), 'utf8'));
  const compose = composeAssetVersion(readFileSync(path.join(dir, COMPOSE_FILE), 'utf8'));
  if (env !== version || compose !== version) {
    throw new Error(`Install wrote inconsistent versions: .env has ${env}, compose pins ${compose}, expected ${version}`);
  }
}

/**
 * Commit the two files as a pair. `.env` is renamed first, compose second, and both are re-read
 * afterwards so a mismatch is reported instead of silently accepted.
 */
export async function applyInstall({ dir, plan }) {
  mkdirSync(dir, { recursive: true });
  const lockPath = path.join(dir, LOCK);
  // `wx` is O_EXCL: the loser of a race gets EEXIST here and writes nothing.
  try {
    closeSync(openSync(lockPath, 'wx'));
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`another install is already running in ${dir}`);
    throw error;
  }

  const temps = [];
  try {
    const envPath = path.join(dir, ENV_FILE);
    const composePath = path.join(dir, COMPOSE_FILE);
    const envText = readIf(envPath);
    const current = readLockedVersion(envText);
    if (plan.action === 'reuse' && current !== null && current !== plan.version) {
      throw new Error(`.env changed while installing: NEMA_IMAGE_TAG is ${current}, expected ${plan.version}`);
    }
    if (plan.action === 'write' && current !== null && current !== plan.version) {
      throw new Error(`.env changed while installing: NEMA_IMAGE_TAG is ${current}, expected ${plan.version}`);
    }
    const composeText = readIf(composePath);
    if (composeText !== null && composeText !== plan.composeText) {
      throw new Error(`${COMPOSE_FILE} changed while installing; refusing to overwrite it`);
    }
    if (plan.action === 'reuse' && current === plan.version && composeText === plan.composeText) {
      assertCommitted(dir, plan.version);
      return;
    }

    const envTemp = writeAtomic(envPath, withLockedVersion(envText, plan.version));
    temps.push(envTemp);
    const composeTemp = writeAtomic(composePath, plan.composeText);
    temps.push(composeTemp);
    // `.env` first: if the process dies between the two renames, the lock is what a re-run reads.
    renameSync(envTemp, envPath);
    renameSync(composeTemp, composePath);
    temps.length = 0;
    assertCommitted(dir, plan.version);
  } finally {
    for (const temp of temps) rmSync(temp, { force: true });
    rmSync(lockPath, { force: true });
  }
}
