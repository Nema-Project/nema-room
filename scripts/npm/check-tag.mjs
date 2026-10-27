import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseVersion } from '../desktop/release-version.mjs';

async function readVersion(root, rel) {
  return JSON.parse(await readFile(path.join(root, rel), 'utf8')).version;
}

export async function readReleaseTrio(root) {
  return {
    cli: await readVersion(root, 'apps/cli/package.json'),
    desktop: await readVersion(root, 'apps/desktop/package.json'),
    local: await readVersion(root, 'apps/local/package.json'),
  };
}

export function assertReleaseTrio(tag, versions) {
  const { cli, desktop, local } = versions;
  const mismatches = [];
  if (desktop !== cli) mismatches.push(`desktop ${desktop}`);
  if (local !== cli) mismatches.push(`local ${local}`);
  if (cli !== desktop || cli !== local) mismatches.unshift(`cli ${cli}`);
  if (mismatches.length > 0) {
    throw new Error(`cli, desktop, and local versions differ: ${mismatches.join(', ')}`);
  }
  try {
    const release = readReleaseVersion(tag, cli);
    return { ...release, distTag: release.prerelease ? 'next' : 'latest' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (cli ${cli}, desktop ${desktop}, local ${local})`);
  }
}

async function main() {
  const [tag, rootArg, extra] = process.argv.slice(2);
  if (!tag || extra) throw new Error('Usage: check-tag.mjs <tag> [root]');
  const root = rootArg ? path.resolve(rootArg) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let versions;
  try {
    versions = await readReleaseTrio(root);
    const result = assertReleaseTrio(tag, versions);
    process.stdout.write(`${JSON.stringify({ ...result, ...versions })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const actual = versions ? `cli ${versions.cli}, desktop ${versions.desktop}, local ${versions.local}` : 'versions unread';
    process.stderr.write(`Release tag rejected: ${message}\n${actual}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
