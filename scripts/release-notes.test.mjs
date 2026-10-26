import assert from 'node:assert/strict';
import test from 'node:test';
import { changelogNotes, releaseNotes } from './release-notes.mjs';

const changelog = `# Changelog

## [Unreleased]

### Changed

- not in a release yet

## [1.2.3] - 2026-10-26

### Added

- Index progress shows in chat.

### Fixed

- Search reads the index.

## [1.2.30] - 2026-10-01

### Fixed

- a different version

## [1.2.2] - 2026-09-01

### Fixed

- older
`;

test('changelog notes are the section for that version only', () => {
  const notes = changelogNotes(changelog, '1.2.3');
  assert.match(notes, /Index progress shows in chat/);
  assert.match(notes, /Search reads the index/);
  assert.doesNotMatch(notes, /not in a release yet/);
  assert.doesNotMatch(notes, /a different version/);
  assert.doesNotMatch(notes, /older/);
});

test('a missing or empty changelog section is refused', () => {
  assert.throws(() => changelogNotes(changelog, '9.9.9'), /no section for 9.9.9/);
  assert.throws(() => changelogNotes('## [1.2.3] - 2026-10-26\n\n## [1.2.2]\n\n- older\n', '1.2.3'), /no notes/);
  assert.throws(() => changelogNotes('## [1.2.3]\n\nNothing listed.\n', '1.2.3'), /no notes/);
});

test('release notes lead with the changelog and leave hashes to the attached file', () => {
  const text = releaseNotes({
    version: '1.2.3',
    changelog,
    commit: 'abc123',
    runUrl: 'https://github.com/example/nema-room/actions/runs/1',
  });
  assert.match(text, /^Nema Room 1\.2\.3\n\n### Added\n\n- Index progress shows in chat/);
  assert.match(text, /unsigned \(Windows\) or ad-hoc signed \(macOS\)/);
  assert.match(text, /commit abc123/);
  assert.match(text, /SHA256SUMS-1\.2\.3\.txt/);
  assert.doesNotMatch(text, /[0-9a-f]{64} {2}/);
});
