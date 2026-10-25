import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Strict SemVer 2.0.0 without build metadata; electron-builder and validate-release reject "+" as well.
const identifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const semver = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${identifier}(?:\\.${identifier})*))?$`);

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
