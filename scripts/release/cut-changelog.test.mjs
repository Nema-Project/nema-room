import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const emptyUnreleased = `# Changelog

## [Unreleased]

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

async function writeFragment(changelogFile, name, text) {
  const dir = path.join(path.dirname(changelogFile), 'changelog.d');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, text);
  return file;
}

async function missing(file) {
  await assert.rejects(access(file), { code: 'ENOENT' });
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

test('a CRLF changelog is cut into the version section and written with LF', async (t) => {
  const crlf = sample.replace(/\n/g, '\r\n');
  assert.equal(cutChangelogText(crlf, '0.2.0', '2026-10-28'), cutSample);
  const file = await tempChangelog(t, crlf);
  await cutChangelogFile(file, '0.2.0', '2026-10-28');
  const next = await readFile(file, 'utf8');
  assert.equal(next, cutSample);
  assert.equal(next.includes('\r'), false);
});

test('a second [Unreleased] heading is refused before any write', async (t) => {
  const duplicate = sample.replace(
    '## [0.1.5] - 2026-10-28',
    '## [Unreleased]\n\n- Second heading entry.\n\n## [0.1.5] - 2026-10-28',
  );
  assert.throws(
    () => cutChangelogText(duplicate, '0.2.0', '2026-10-28'),
    /CHANGELOG\.md has more than one \[Unreleased\] section/,
  );
  const file = await tempChangelog(t, duplicate);
  await assert.rejects(
    cutChangelogFile(file, '0.2.0', '2026-10-28'),
    /CHANGELOG\.md has more than one \[Unreleased\] section/,
  );
  assert.equal(await readFile(file, 'utf8'), duplicate);
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

test('fragments fill an empty Unreleased section and are deleted after the write', async (t) => {
  const file = await tempChangelog(t, emptyUnreleased);
  const added = await writeFragment(file, '70.added.md', '- Fragment added.\n');
  const fixed = await writeFragment(file, '71.fixed.md', '- Fragment fixed.\n');
  await cutChangelogFile(file, '0.2.0', '2026-10-28');
  const next = await readFile(file, 'utf8');
  assert.match(next, /## \[Unreleased\]\n\n## \[0\.2\.0\] - 2026-10-28\n\n### Added\n\n- Fragment added\.\n\n### Fixed\n\n- Fragment fixed\.\n\n## \[0\.1\.5\]/);
  await missing(added);
  await missing(fixed);
});

test('existing Unreleased bullets stay ahead of fragment bullets', async (t) => {
  const file = await tempChangelog(t, sample);
  await writeFragment(file, '70.changed.md', '- Fragment change.\n');
  await writeFragment(file, '71.fixed.md', '- Fragment fix.\n');
  await cutChangelogFile(file, '0.2.0', '2026-10-28');
  const next = await readFile(file, 'utf8');
  const changed = next.indexOf('- Stamp versions from one command.');
  const fragmentChange = next.indexOf('- Fragment change.');
  const fixed = next.indexOf('- Empty sections stay put.');
  const fragmentFix = next.indexOf('- Fragment fix.');
  assert.ok(changed >= 0 && fragmentChange > changed);
  assert.ok(fixed >= 0 && fragmentFix > fixed);
  assert.ok(fragmentChange < fixed);
});

test('fragments follow category order and filename order inside a category', async (t) => {
  const file = await tempChangelog(t, emptyUnreleased);
  await writeFragment(file, 'b.fixed.md', '- Fixed b.\n');
  await writeFragment(file, 'c.changed.md', '- Changed c.\n');
  await writeFragment(file, 'a.changed.md', '- Changed a.\n');
  await writeFragment(file, 'a.added.md', '- Added a.\n');
  await writeFragment(file, 'd.security.md', '- Security d.\n');
  await cutChangelogFile(file, '0.2.0', '2026-10-28');
  const next = await readFile(file, 'utf8');
  const positions = ['### Added', '- Added a.', '### Changed', '- Changed a.', '- Changed c.', '### Fixed', '- Fixed b.', '### Security', '- Security d.']
    .map((needle) => next.indexOf(needle));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.ok(positions.every((index) => index >= 0));
});

test('a missing category heading is created in canonical order', async (t) => {
  const fixedOnly = `# Changelog

## [Unreleased]

### Fixed

- Existing fix.

## [0.1.5] - 2026-10-28

### Added

- Older note.
`;
  const file = await tempChangelog(t, fixedOnly);
  await writeFragment(file, '2.security.md', '- Fragment security.\n');
  await writeFragment(file, '1.added.md', '- Fragment added.\n');
  await cutChangelogFile(file, '0.2.0', '2026-10-28');
  const next = await readFile(file, 'utf8');
  const added = next.indexOf('### Added');
  const fixed = next.indexOf('### Fixed');
  const security = next.indexOf('### Security');
  assert.ok(added >= 0 && added < fixed && fixed < security);
  assert.match(next, /### Added\n\n- Fragment added\.\n\n### Fixed\n\n- Existing fix\.\n\n### Security\n\n- Fragment security\./);
});

test('an unknown category is rejected and nothing is written or deleted', async (t) => {
  const file = await tempChangelog(t, emptyUnreleased);
  const fragment = await writeFragment(file, '90.bogus.md', '- Should stay.\n');
  let wrote = false;
  await assert.rejects(
    cutChangelogFile(file, '0.2.0', '2026-10-28', { writeFile: async () => { wrote = true; } }),
    /changelog\.d\/90\.bogus\.md has unknown category "bogus"/,
  );
  assert.equal(wrote, false);
  assert.equal(await readFile(file, 'utf8'), emptyUnreleased);
  assert.equal(await readFile(fragment, 'utf8'), '- Should stay.\n');
});

test('a non-markdown file in changelog.d is rejected and nothing is written or deleted', async (t) => {
  const file = await tempChangelog(t, sample);
  const extra = await writeFragment(file, 'notes.txt', 'not a fragment\n');
  let wrote = false;
  await assert.rejects(
    cutChangelogFile(file, '0.2.0', '2026-10-28', { writeFile: async () => { wrote = true; } }),
    /changelog\.d\/notes\.txt is not a markdown fragment/,
  );
  assert.equal(wrote, false);
  assert.equal(await readFile(file, 'utf8'), sample);
  assert.equal(await readFile(extra, 'utf8'), 'not a fragment\n');
});

test('an unparseable slug is rejected and nothing is written or deleted', async (t) => {
  const file = await tempChangelog(t, emptyUnreleased);
  const fragment = await writeFragment(file, '70.extra.changed.md', '- Should stay.\n');
  await assert.rejects(
    cutChangelogFile(file, '0.2.0', '2026-10-28'),
    /changelog\.d\/70\.extra\.changed\.md has an unparseable slug/,
  );
  assert.equal(await readFile(file, 'utf8'), emptyUnreleased);
  assert.equal(await readFile(fragment, 'utf8'), '- Should stay.\n');
});

test('a failed changelog write leaves the fragments in place', async (t) => {
  const file = await tempChangelog(t, emptyUnreleased);
  const fragment = await writeFragment(file, '70.changed.md', '- Should stay.\n');
  await assert.rejects(
    cutChangelogFile(file, '0.2.0', '2026-10-28', {
      writeFile: async () => { throw new Error('disk full'); },
    }),
    /disk full/,
  );
  assert.equal(await readFile(file, 'utf8'), emptyUnreleased);
  assert.equal(await readFile(fragment, 'utf8'), '- Should stay.\n');
});

test('a CRLF fragment is normalised to LF in the cut changelog', async (t) => {
  const file = await tempChangelog(t, emptyUnreleased.replace(/\n/g, '\r\n'));
  await writeFragment(file, '70.changed.md', '- From fragment.\r\n');
  await cutChangelogFile(file, '0.2.0', '2026-10-28');
  const next = await readFile(file, 'utf8');
  assert.equal(next.includes('\r'), false);
  assert.match(next, /### Changed\n\n- From fragment\.\n/);
});

test('the repository changelog can be cut in memory and the command refuses a bad argument', async () => {
  const original = await readFile(path.join(repo, 'CHANGELOG.md'), 'utf8');
  // Right after a release cut the repository's [Unreleased] is empty, so add one entry in memory.
  const latest = original.match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m)?.[1];
  assert.ok(latest, 'the repository changelog has a released version section');
  const withEntry = original.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n- In-memory entry for this test.\n');
  assert.notEqual(withEntry, original);
  const next = cutChangelogText(withEntry, '9.9.9', '2026-10-28');
  assert.match(next, /## \[Unreleased\]\n\n## \[9\.9\.9\] - 2026-10-28\n/);
  assert.match(changelogNotes(next, '9.9.9'), /In-memory entry for this test/);
  assert.ok(next.indexOf('## [9.9.9]') < next.indexOf(`## [${latest}]`), 'the new section sits above the latest release');
  assert.equal(changelogNotes(next, latest), changelogNotes(original, latest));
  assert.equal(await readFile(path.join(repo, 'CHANGELOG.md'), 'utf8'), original);
  const run = spawnSync(process.execPath, [script, 'v0.2.0'], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /v prefix/);
  assert.equal(await readFile(path.join(repo, 'CHANGELOG.md'), 'utf8'), original);
  const usage = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Usage: cut-changelog\.mjs <x\.y\.z>/);
});
