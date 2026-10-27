import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Strict SemVer 2.0.0 without build metadata; electron-builder and validate-release reject "+" as well.
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?$`);

function parseSemver(value) {
  if (typeof value !== 'string') throw new Error(`Not a release version: ${JSON.stringify(value)}`);
  const match = semver.exec(value);
  if (!match) throw new Error(`Not a release version: ${value}`);
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split('.'),
  };
}

function comparePre(left, right) {
  const count = Math.min(left.length, right.length);
  for (let i = 0; i < count; i += 1) {
    const a = left[i];
    const b = right[i];
    const aNum = /^(?:0|[1-9]\d*)$/.test(a);
    const bNum = /^(?:0|[1-9]\d*)$/.test(b);
    if (aNum && bNum) {
      if (Number(a) !== Number(b)) return Number(a) - Number(b);
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

/** Positive when `left` is newer. A release is newer than its prerelease. */
export function compareReleaseVersions(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  }
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return comparePre(a.pre, b.pre);
}

export function readReleaseVersion(tag, packageVersion) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) throw new Error(`Release tag must be v<SemVer>: ${JSON.stringify(tag)}`);
  const match = semver.exec(tag.slice(1));
  if (!match) throw new Error(`Release tag is not strict SemVer v<major>.<minor>.<patch>[-prerelease]: ${tag}`);
  const version = tag.slice(1);
  if (typeof packageVersion !== 'string' || packageVersion !== version) throw new Error(`Release tag ${tag} does not match package version ${packageVersion}`);
  return { version, prerelease: match[4] !== undefined };
}

// Versions come from explicit package fields so a source copy without .git releases identically.
export async function readPackageVersion(root) {
  const read = async (file) => JSON.parse(await readFile(path.join(root, file), 'utf8')).version;
  const desktop = await read('apps/desktop/package.json');
  const local = await read('apps/local/package.json');
  if (desktop !== local) throw new Error(`Desktop package ${desktop} must match local runtime ${local}`);
  return desktop;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [tag, extra] = process.argv.slice(2);
    if (!tag || extra) throw new Error('Usage: release-version.mjs <tag>');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const result = readReleaseVersion(tag, await readPackageVersion(root));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`Release version rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
