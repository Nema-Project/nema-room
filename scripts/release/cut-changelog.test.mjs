import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changelogNotes } from '../release-notes.mjs';
import { cutChangelogFile, cutChangelogText, localCutDate, main } from './cut-changelog.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const script = fileURLToPath(new URL('./cut-changelog.mjs', import.meta.url));
const notesScript = fileURLToPath(new URL('../release-notes.mjs', import.meta.url));

const sample = `# Changelog

Intro stays.

## [Unreleased]

### Changed

- Stamp versions from one command.

### Fixed

- Empty sections stay put.

## [0.1.5] - 2026-10-28

### Added

- Older note.
`;

const cutSample = `# Changelog

Intro stays.

## [Unreleased]

## [0.2.0] - 2026-10-28

### Changed

- Stamp versions from one command.

### Fixed

- Empty sections stay put.

## [0.1.5] - 2026-10-28

### Added

- Older note.
`;

async function tempChangelog(t, text) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nema-cut-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'CHANGELOG.md');
  await writeFile(file, text);
  return file;
}

test('local cut date uses the given time zone, not the UTC calendar day', () => {
  const instant = new Date('2026-10-28T15:30:00Z');
  assert.equal(localCutDate(instant, 'UTC'), '2026-10-28');
  assert.equal(localCutDate(instant, 'Asia/Tokyo'), '2026-10-29');
  assert.equal(localCutDate(instant, 'America/Los_Angeles'), '2026-10-28');
});

test('cut moves Unreleased entries under a dated section and leaves the heading empty', async (t) => {
  assert.equal(cutChangelogText(sample, '0.2.0', '2026-10-28'), cutSample);
  const file = await tempChangelog(t, sample);
  await main(['0.2.0'], { file, now: new Date('2026-10-28T15:30:00Z'), timeZone: 'UTC' });
  const next = await readFile(file, 'utf8');
  assert.equal(next, cutSample);
  assert.match(changelogNotes(next, '0.2.0'), /Stamp versions from one command/);
  assert.match(changelogNotes(next, '0.2.0'), /Empty sections stay put/);
  assert.doesNotMatch(changelogNotes(next, '0.1.5'), /Stamp versions/);
  const check = spawnSync(process.execPath, [notesScript, '--check', file, '0.2.0'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});

test('an empty Unreleased section is refused and the file is left untouched', async (t) => {
  const empty = sample.replace(/\n### Changed[\s\S]*?Empty sections stay put\.\n/, '\n');
  assert.throws(() => cutChangelogText(empty, '0.2.0', '2026-10-28'), /no entries/);
  const file = await tempChangelog(t, empty);
  await assert.rejects(cutChangelogFile(file, '0.2.0', '2026-10-28'), /no entries/);
  assert.equal(await readFile(file, 'utf8'), empty);
});

test('a heading without entries, a duplicate section, and a bad version do not write', async (t) => {
  const headingOnly = '## [Unreleased]\n\n### Added\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- old\n';
  const file = await tempChangelog(t, headingOnly);
  await assert.rejects(cutChangelogFile(file, '0.2.0', '2026-10-28'), /no entries/);
  await assert.rejects(cutChangelogFile(file, '0.1.0', '2026-10-28'), /already has a section/);
  await assert.rejects(cutChangelogFile(file, 'v0.2.0', '2026-10-28'), /v prefix/);
  await assert.rejects(cutChangelogFile(file, '0.2.0', '2026-02-31'), /not a calendar day/);
  assert.equal(await readFile(file, 'utf8'), headingOnly);
  assert.throws(() => cutChangelogText('# Changelog\n', '0.2.0', '2026-10-28'), /no \[Unreleased\]/);
});

test('the repository changelog can be cut in memory and the command refuses a bad argument', async () => {
  const original = await readFile(path.join(repo, 'CHANGELOG.md'), 'utf8');
  const next = cutChangelogText(original, '9.9.9', '2026-10-28');
  assert.match(next, /## \[Unreleased\]\n\n## \[9\.9\.9\] - 2026-10-28\n/);
  assert.match(changelogNotes(next, '9.9.9'), /release:stamp/);
  assert.equal(await readFile(path.join(repo, 'CHANGELOG.md'), 'utf8'), original);
  const run = spawnSync(process.execPath, [script, 'v0.2.0'], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /v prefix/);
  assert.equal(await readFile(path.join(repo, 'CHANGELOG.md'), 'utf8'), original);
  const usage = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Usage: cut-changelog\.mjs <x\.y\.z>/);
});
