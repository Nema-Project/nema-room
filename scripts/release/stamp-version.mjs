import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readReleaseVersion } from '../desktop/release-version.mjs';
import { withReleaseLock } from './release-lock.mjs';
import { assertComposeAsset, assertComposeTemplate, renderComposeAsset } from '../images/check-images.mjs';

const checkTagScript = fileURLToPath(new URL('../npm/check-tag.mjs', import.meta.url));

export const PACKAGE_FILES = Object.freeze([
  'apps/cli/package.json',
  'apps/desktop/package.json',
  'apps/local/package.json',
]);

const LOCK_WORKSPACES = Object.freeze(['apps/cli', 'apps/desktop', 'apps/local']);
const PACKAGE_NAMES = Object.freeze({
  'apps/cli/package.json': 'cli',
  'apps/desktop/package.json': 'desktop',
  'apps/local/package.json': 'local',
});

/** Strict SemVer without a `v` prefix, same grammar as `release-version.mjs`. */
export function assertStrictVersion(version) {
  if (typeof version !== 'string' || version.startsWith('v')) {
    throw new Error(`Version must be strict SemVer without a v prefix: ${JSON.stringify(version)}`);
  }
  readReleaseVersion(`v${version}`, version);
}

export function replacePackageVersion(text, version) {
  const hits = text.match(/^  "version": "[^"]*",$/gm);
  if (!hits || hits.length !== 1) throw new Error('package.json must have one top-level version');
  return text.replace(/^  "version": "[^"]*",$/m, `  "version": "${version}",`);
}

function replaceLockWorkspaceVersion(text, workspace, version) {
  const header = `    "${workspace}": {\n`;
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`package-lock.json has no ${workspace} record`);
  if (text.indexOf(header, start + header.length) !== -1) {
    throw new Error(`package-lock.json has more than one ${workspace} record`);
  }
  const rest = text.slice(start + header.length);
  const endRel = rest.search(/\n    (?:"[^"]+"|\})/);
  if (endRel < 0) throw new Error(`package-lock.json ${workspace} record does not end`);
  const block = rest.slice(0, endRel);
  const hits = block.match(/^      "version": "[^"]*",$/gm);
  if (!hits || hits.length !== 1) throw new Error(`package-lock.json ${workspace} record must have one version`);
  const updated = block.replace(/^      "version": "[^"]*",$/m, `      "version": "${version}",`);
  return text.slice(0, start + header.length) + updated + rest.slice(endRel);
}

export function replaceLockVersions(text, version) {
  let next = text;
  for (const workspace of LOCK_WORKSPACES) next = replaceLockWorkspaceVersion(next, workspace, version);
  return next;
}

function walkDiff(before, after, trail, diffs) {
  if (Object.is(before, after)) return;
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (record(before) && record(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      walkDiff(before[key], after[key], trail.concat(key), diffs);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) diffs.push(trail);
}

function assertOnlyPackageVersionChanged(beforeText, afterText, version, rel) {
  const before = JSON.parse(beforeText);
  const after = JSON.parse(afterText);
  if (after.version !== version) throw new Error(`${rel} version was not set to ${version}`);
  const diffs = [];
  walkDiff({ ...before, version }, after, [], diffs);
  if (diffs.length > 0) throw new Error(`${rel} changed beyond version`);
}

function lockRecordVersion(parsed, workspace) {
  const record = parsed.packages?.[workspace];
  if (!record || typeof record !== 'object') throw new Error(`package-lock.json has no ${workspace} record`);
  if (typeof record.version !== 'string') throw new Error(`${workspace}: package-lock.json version is not a string`);
  return record.version;
}

/** All six version strings must already match. Runs before any write. */
function assertLockMatchesTrio(lockText, trio) {
  let parsed;
  try {
    parsed = JSON.parse(lockText);
  } catch {
    throw new Error('package-lock.json is not JSON');
  }
  const mismatches = [];
  for (const item of trio) {
    const workspace = item.rel.slice(0, item.rel.lastIndexOf('/'));
    const locked = lockRecordVersion(parsed, workspace);
    if (locked !== item.version) {
      mismatches.push(`${workspace}: package.json ${item.version} vs package-lock.json ${locked}`);
    }
  }
  if (mismatches.length > 0) throw new Error(mismatches.join('; '));
}

function assertOnlyLockVersionsChanged(beforeText, afterText, version) {
  const before = JSON.parse(beforeText);
  const after = JSON.parse(afterText);
  const diffs = [];
  walkDiff(before, after, [], diffs);
  for (const diff of diffs) {
    const allowed = diff.length === 3 && diff[0] === 'packages' && diff[2] === 'version' && LOCK_WORKSPACES.includes(diff[1]);
    if (!allowed) throw new Error(`package-lock.json changed beyond workspace versions: ${diff.join('/')}`);
  }
  for (const workspace of LOCK_WORKSPACES) {
    if (after.packages?.[workspace]?.version !== version) {
      throw new Error(`package-lock.json ${workspace} version is not ${version}`);
    }
  }
}

async function selfCheck(root, version) {
  const tag = `v${version}`;
  const run = spawnSync(process.execPath, [checkTagScript, tag, root], { encoding: 'utf8' });
  if (run.status !== 0) {
    throw new Error(`check-tag failed for ${tag}:\n${(run.stderr || run.stdout || 'no output').trim()}`);
  }
  try {
    const template = await readFile(path.join(root, 'docker-compose.yml'), 'utf8');
    assertComposeTemplate(template);
    assertComposeAsset(renderComposeAsset(template, version), version);
  } catch (error) {
    throw new Error(`compose template failed at ${tag}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write the three release package versions and their lockfile records under the shared release lock,
 * so a concurrent `release:cut` on the same tree fails instead of interleaving.
 * Does not commit, tag, or publish. A failed self-check restores the four files.
 * `options` forwards the lock's wait and poll budget to tests.
 */
export async function stampVersion(root, version, verify = selfCheck, options = {}) {
  return withReleaseLock(root, 'release:stamp', () => stampVersionLocked(root, version, verify), options);
}

async function stampVersionLocked(root, version, verify) {
  assertStrictVersion(version);
  const rels = [...PACKAGE_FILES, 'package-lock.json'];
  const originals = new Map();
  for (const rel of rels) originals.set(rel, await readFile(path.join(root, rel), 'utf8'));

  const trio = PACKAGE_FILES.map((rel) => {
    let parsed;
    try {
      parsed = JSON.parse(originals.get(rel));
    } catch {
      throw new Error(`${rel} is not JSON`);
    }
    if (typeof parsed.version !== 'string') throw new Error(`${rel} has no version`);
    return { rel, version: parsed.version };
  });
  if (new Set(trio.map((item) => item.version)).size !== 1) {
    const named = trio.map((item) => `${PACKAGE_NAMES[item.rel]} ${item.version}`).join(', ');
    throw new Error(`cli, desktop, and local versions differ: ${named}`);
  }
  assertLockMatchesTrio(originals.get('package-lock.json'), trio);

  const next = new Map();
  for (const rel of PACKAGE_FILES) {
    const updated = replacePackageVersion(originals.get(rel), version);
    assertOnlyPackageVersionChanged(originals.get(rel), updated, version, rel);
    next.set(rel, updated);
  }
  const lock = replaceLockVersions(originals.get('package-lock.json'), version);
  assertOnlyLockVersionsChanged(originals.get('package-lock.json'), lock, version);
  next.set('package-lock.json', lock);

  let started = false;
  try {
    started = true;
    for (const [rel, text] of next) {
      if (text !== originals.get(rel)) await writeFile(path.join(root, rel), text);
    }
    await verify(root, version);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!started) throw error;
    try {
      for (const [rel, text] of originals) await writeFile(path.join(root, rel), text);
    } catch (restoreError) {
      const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
      throw new Error(`${message}\nRestoring version files failed: ${restoreMessage}`);
    }
    throw new Error(`${message}\nVersion files were restored.`);
  }
}

async function main() {
  const [version, extra] = process.argv.slice(2);
  if (!version || extra) throw new Error('Usage: stamp-version.mjs <x.y.z>');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  await stampVersion(root, version);
  process.stdout.write(`stamped ${version}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
