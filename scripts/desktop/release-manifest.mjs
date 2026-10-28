import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const expectedTargets = Object.freeze(['win32-x64', 'darwin-arm64']);
const installerExtension = { win32: 'exe', darwin: 'dmg' };

export function checksumFileName(version, target) {
  return `SHA256SUMS-${version}-${target}.txt`;
}

export function expectedAssets(version, target) {
  if (!expectedTargets.includes(target)) throw new Error(`Unexpected release target: ${target}`);
  const platform = target.split('-')[0];
  const installer = `Nema-${version}-${target}.${installerExtension[platform]}`;
  // Windows publishes two independent downloads. The ZIP is the unpacked app, not a
  // bundle that also contains the installer. macOS publishes the DMG only.
  if (platform === 'win32') return [installer, `Nema-${version}-${target}.zip`];
  return [installer];
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

export function parseChecksums(text, source) {
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *]([^/\\\s][^/\\]*)$/.exec(line);
    if (!match) throw new Error(`Malformed checksum line in ${source}: ${line}`);
    if (entries.has(match[2])) throw new Error(`Duplicate checksum entry for ${match[2]} in ${source}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

// Run in each build job after packaging: records the exact assets the publish job compares against.
export async function writeTargetChecksums(directory, version, target) {
  const lines = [];
  for (const name of expectedAssets(version, target)) {
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (!info?.isFile()) throw new Error(`Cannot checksum missing ${target} asset: ${name}`);
    lines.push(`${await hashFile(path.join(directory, name))}  ${name}`);
  }
  const file = path.join(directory, checksumFileName(version, target));
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

export async function verifyTargetChecksums(directory, version, target) {
  const wanted = expectedAssets(version, target);
  const checksumName = checksumFileName(version, target);
  const sums = parseChecksums(await readFile(path.join(directory, checksumName), 'utf8'), `${target}/${checksumName}`);
  if (sums.size !== wanted.length || wanted.some((name) => !sums.has(name))) {
    throw new Error(`Checksum file for ${target} must list exactly ${wanted.join(', ')}`);
  }
  for (const name of wanted) {
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Cannot verify missing ${target} asset: ${name}`);
    if (await hashFile(file) !== sums.get(name)) throw new Error(`Checksum mismatch for ${target}/${name}`);
  }
}

// artifactsRoot/<target>/ holds the downloaded build-job artifact for each target. Nothing is copied unless every check passes.
export async function collectReleaseManifest({ version, prerelease = false, artifactsRoot, outputDir, build = {}, composeAsset = null }) {
  const seen = new Map();
  const targets = {};
  const plan = [];
  for (const target of expectedTargets) {
    const directory = path.join(artifactsRoot, target);
    const names = await readdir(directory).catch(() => null);
    if (!names) throw new Error(`Missing release target ${target}: no artifact directory`);
    const wanted = expectedAssets(version, target);
    const checksumName = checksumFileName(version, target);
    for (const name of names) {
      if (name !== checksumName && !wanted.includes(name)) throw new Error(`Unexpected file in ${target} artifact: ${name}`);
    }
    for (const name of [...wanted, checksumName]) {
      if (!names.includes(name)) throw new Error(`Missing ${target} release file: ${name}`);
      const info = await stat(path.join(directory, name));
      if (!info.isFile() || info.size === 0) throw new Error(`Release file is empty or not a regular file: ${target}/${name}`);
    }
    const sums = parseChecksums(await readFile(path.join(directory, checksumName), 'utf8'), `${target}/${checksumName}`);
    if (sums.size !== wanted.length || wanted.some((name) => !sums.has(name))) throw new Error(`Checksum file for ${target} must list exactly ${wanted.join(', ')}`);
    targets[target] = [];
    for (const name of [...wanted, checksumName]) {
      const key = name.toLowerCase();
      if (seen.has(key)) throw new Error(`Duplicate release asset name ${name} in ${seen.get(key)} and ${target}`);
      seen.set(key, target);
      const file = path.join(directory, name);
      const sha256 = await hashFile(file);
      if (name !== checksumName && sha256 !== sums.get(name)) throw new Error(`Checksum mismatch for ${target}/${name}`);
      targets[target].push({ name, size: (await stat(file)).size, sha256 });
      plan.push({ from: file, name });
    }
  }
  let compose;
  if (composeAsset !== null) {
    if (path.basename(composeAsset) !== 'docker-compose.yml') throw new Error('Compose asset must be named docker-compose.yml');
    const info = await stat(composeAsset).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error('Compose asset is missing or empty');
    compose = { name: 'docker-compose.yml', size: info.size, sha256: await hashFile(composeAsset) };
    plan.push({ from: composeAsset, name: compose.name });
  }
  const manifest = { schemaVersion: 1, version, prerelease, targets, build, ...(compose ? { compose } : {}) };
  await mkdir(outputDir, { recursive: true });
  for (const item of plan) await copyFile(item.from, path.join(outputDir, item.name));
  const combined = Object.values(targets).flat().filter((asset) => !asset.name.startsWith('SHA256SUMS-')).map((asset) => `${asset.sha256}  ${asset.name}`).join('\n');
  await writeFile(path.join(outputDir, `SHA256SUMS-${version}.txt`), `${combined}\n${compose ? `${compose.sha256}  ${compose.name}\n` : ''}`);
  await writeFile(path.join(outputDir, `release-manifest-${version}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'checksums' && rest.length === 3) {
    const file = await writeTargetChecksums(path.resolve(rest[0]), rest[1], rest[2]);
    process.stdout.write(`Wrote ${file}\n`);
  } else if (command === 'verify' && rest.length === 3) {
    await verifyTargetChecksums(path.resolve(rest[0]), rest[1], rest[2]);
    process.stdout.write(`Verified ${rest[2]} checksums\n`);
  } else if (command === 'collect' && (rest.length === 4 || rest.length === 5)) {
    const [artifactsRoot, outputDir, version, prerelease, composeAsset] = rest;
    if (!['true', 'false'].includes(prerelease)) throw new Error('prerelease must be true or false');
    const build = { commit: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF, runId: process.env.GITHUB_RUN_ID, repository: process.env.GITHUB_REPOSITORY };
    const manifest = await collectReleaseManifest({ version, prerelease: prerelease === 'true', artifactsRoot: path.resolve(artifactsRoot), outputDir: path.resolve(outputDir), build, composeAsset: composeAsset ? path.resolve(composeAsset) : null });
    process.stdout.write(`Collected ${Object.values(manifest.targets).flat().length} files for ${expectedTargets.length} targets\n`);
  } else {
    throw new Error('Usage: release-manifest.mjs checksums <dir> <version> <target> | verify <dir> <version> <target> | collect <artifacts-root> <output-dir> <version> <prerelease:true|false> [compose-file]');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Release manifest failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
