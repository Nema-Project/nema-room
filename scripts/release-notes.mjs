import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The heading is Keep a Changelog's `## [version] - date`. The version is matched whole,
// so 1.2.3 does not take the 1.2.30 section.
export function changelogNotes(markdown, version) {
  if (typeof version !== 'string' || version.length === 0) throw new Error('Release version is missing');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^## \\[${escaped}\\](?:\\s|$)`).test(line));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const next = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  const body = lines.slice(start + 1, next < 0 ? lines.length : next).join('\n').trim();
  if (!/^- /m.test(body)) throw new Error(`CHANGELOG.md section for ${version} has no notes`);
  return body;
}

export function releaseNotes({ version, changelog, commit, runUrl }) {
  const notes = changelogNotes(changelog, version);
  return [
    `Nema Room ${version}`,
    '',
    notes,
    '',
    'These installers are unsigned (Windows) or ad-hoc signed (macOS); the operating system will warn on first launch.',
    `Build: commit ${commit}, workflow run ${runUrl}.`,
    `Verify downloads against SHA256SUMS-${version}.txt. release-manifest-${version}.json lists every asset with size, hash and build metadata.`,
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const check = args[0] === '--check';
    const rest = check ? args.slice(1) : args;
    if (check) {
      if (rest.length !== 2) throw new Error('Usage: release-notes.mjs --check <changelog> <version>');
      changelogNotes(await readFile(rest[0], 'utf8'), rest[1]);
    } else {
      if (rest.length !== 4) throw new Error('Usage: release-notes.mjs <changelog> <version> <commit> <run-url>');
      const [file, version, commit, runUrl] = rest;
      process.stdout.write(releaseNotes({ version, changelog: await readFile(file, 'utf8'), commit, runUrl }));
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
