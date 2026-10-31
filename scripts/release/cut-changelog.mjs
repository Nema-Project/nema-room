import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withReleaseLock } from './release-lock.mjs';
import { assertStrictVersion } from './stamp-version.mjs';

const UNRELEASED = '## [Unreleased]';
const CATEGORIES = ['added', 'changed', 'fixed', 'removed', 'security'];
const CATEGORY_HEADINGS = {
  added: '### Added',
  changed: '### Changed',
  fixed: '### Fixed',
  removed: '### Removed',
  security: '### Security',
};
const HEADING_CATEGORY = new Map(Object.entries(CATEGORY_HEADINGS).map(([category, heading]) => [heading, category]));
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** Calendar day in `timeZone`, or in the runtime's local zone when omitted. */
export function localCutDate(now = new Date(), timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit' };
  if (timeZone) options.timeZone = timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Could not format cut date from ${now.toISOString()}`);
  return date;
}

function assertCutDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Cut date must be YYYY-MM-DD: ${JSON.stringify(date)}`);
  const [year, month, day] = date.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error(`Cut date is not a calendar day: ${date}`);
  }
}

/** `## [version]` heading test shared by the cut and the journal replay. */
function versionHeading(version) {
  return new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\](?:\\s|$)`);
}

function trimEdgeBlank(lines) {
  const copy = [...lines];
  if (copy[0] === '') copy.shift();
  if (copy.at(-1) === '') copy.pop();
  return copy;
}

/**
 * Move `[Unreleased]` entries into `## [version] - date` directly under the empty heading.
 * `date` is the cut day. The file is not rewritten when this throws.
 */
export function cutChangelogText(markdown, version, date) {
  assertStrictVersion(version);
  assertCutDate(date);
  // CRLF is normalized before parsing. The cut file is written with LF, matching `*.md text eol=lf` in .gitattributes.
  const normalized = markdown.replace(/\r\n/g, '\n');
  const ended = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  const unreleasedCount = lines.filter((line) => line === UNRELEASED).length;
  if (unreleasedCount === 0) throw new Error('CHANGELOG.md has no [Unreleased] section');
  if (unreleasedCount > 1) throw new Error('CHANGELOG.md has more than one [Unreleased] section');
  const unreleased = lines.indexOf(UNRELEASED);
  const heading = versionHeading(version);
  if (lines.some((line) => heading.test(line))) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  let next = lines.findIndex((line, index) => index > unreleased && line.startsWith('## ['));
  if (next < 0) next = lines.length;
  const bodyLines = lines.slice(unreleased + 1, next);
  if (!/^- /m.test(bodyLines.join('\n'))) throw new Error('CHANGELOG [Unreleased] has no entries');
  const middle = [UNRELEASED, '', `## [${version}] - ${date}`, '', ...trimEdgeBlank(bodyLines), ''];
  let text = [...lines.slice(0, unreleased), ...middle, ...lines.slice(next)].join('\n');
  if (ended && !text.endsWith('\n')) text += '\n';
  if (!ended && text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

function parseFragmentName(name) {
  if (!name.endsWith('.md')) throw new Error(`changelog.d/${name} is not a markdown fragment`);
  const stem = name.slice(0, -3);
  const dot = stem.lastIndexOf('.');
  if (dot <= 0) throw new Error(`changelog.d/${name} has an unparseable slug`);
  const slug = stem.slice(0, dot);
  const category = stem.slice(dot + 1);
  if (!CATEGORIES.includes(category)) throw new Error(`changelog.d/${name} has unknown category "${category}"`);
  if (!SLUG.test(slug)) throw new Error(`changelog.d/${name} has an unparseable slug`);
  return category;
}

function fragmentBody(name, raw) {
  const lines = trimEdgeBlank(raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n'));
  if (lines.some((line) => /^#{1,6}(?:\s|$)/.test(line))) {
    throw new Error(`changelog.d/${name} must not contain a heading`);
  }
  if (lines.some((line) => line !== '' && !line.startsWith('- '))) {
    throw new Error(`changelog.d/${name} must contain only bullet entries`);
  }
  if (!lines.some((line) => line.startsWith('- '))) throw new Error(`changelog.d/${name} has no entries`);
  return lines.join('\n');
}

async function readFragments(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const fragments = [];
  for (const name of names.sort()) {
    const full = path.join(directory, name);
    if ((await stat(full)).isDirectory()) continue;
    const category = parseFragmentName(name);
    const raw = await readFile(full, 'utf8');
    fragments.push({ name, category, body: fragmentBody(name, raw), raw, path: full });
  }
  return fragments;
}

function insertMissingCategories(existing, needed) {
  const order = [...existing];
  for (const category of CATEGORIES) {
    if (!needed.has(category) || order.includes(category)) continue;
    const rank = CATEGORIES.indexOf(category);
    let index = order.length;
    for (let i = 0; i < order.length; i += 1) {
      if (CATEGORIES.indexOf(order[i]) > rank) {
        index = i;
        break;
      }
    }
    order.splice(index, 0, category);
  }
  return order;
}

function composeUnreleased(bodyLines, fragments) {
  const preamble = [];
  const sections = new Map();
  const seen = [];
  let bucket = preamble;
  for (const line of bodyLines) {
    const category = HEADING_CATEGORY.get(line);
    if (category) {
      if (!sections.has(category)) {
        sections.set(category, []);
        seen.push(category);
      }
      bucket = sections.get(category);
      continue;
    }
    bucket.push(line);
  }
  for (const category of sections.keys()) sections.set(category, trimEdgeBlank(sections.get(category)));
  const grouped = new Map();
  for (const fragment of [...fragments].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    const list = grouped.get(fragment.category) ?? [];
    list.push(fragment.body);
    grouped.set(fragment.category, list);
  }
  const order = insertMissingCategories(seen, new Set([...seen, ...grouped.keys()]));
  const chunks = [];
  const intro = trimEdgeBlank(preamble);
  if (intro.length) chunks.push(intro.join('\n'));
  for (const category of order) {
    const parts = [];
    const existing = sections.get(category) ?? [];
    if (existing.length) parts.push(existing.join('\n'));
    for (const body of grouped.get(category) ?? []) parts.push(body);
    chunks.push(parts.length ? `${CATEGORY_HEADINGS[category]}\n\n${parts.join('\n\n')}` : CATEGORY_HEADINGS[category]);
  }
  if (!chunks.length) return bodyLines;
  return ['', ...chunks.join('\n\n').split('\n'), ''];
}

function mergeFragments(markdown, fragments) {
  if (fragments.length === 0) return markdown;
  const normalized = markdown.replace(/\r\n/g, '\n');
  const ended = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  const unreleasedCount = lines.filter((line) => line === UNRELEASED).length;
  if (unreleasedCount === 0) throw new Error('CHANGELOG.md has no [Unreleased] section');
  if (unreleasedCount > 1) throw new Error('CHANGELOG.md has more than one [Unreleased] section');
  const unreleased = lines.indexOf(UNRELEASED);
  let next = lines.findIndex((line, index) => index > unreleased && line.startsWith('## ['));
  if (next < 0) next = lines.length;
  const mergedBody = composeUnreleased(lines.slice(unreleased + 1, next), fragments);
  let text = [...lines.slice(0, unreleased + 1), ...mergedBody, ...lines.slice(next)].join('\n');
  if (ended && !text.endsWith('\n')) text += '\n';
  if (!ended && text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

/** Journal of one in-flight cut: what it wrote, and which fragments it may delete. */
const JOURNAL_NAME = '.nema-release-cut.json';
const JOURNAL_SCHEMA = 1;
const SHA256 = /^[0-9a-f]{64}$/;

export function cutJournalPath(file) {
  return path.join(path.dirname(file), JOURNAL_NAME);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertJournal(record, journal) {
  const problem = (detail) => new Error(`cut journal ${journal} ${detail}; delete it after checking CHANGELOG.md and changelog.d`);
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw problem('is not readable');
  if (record.schemaVersion !== JOURNAL_SCHEMA) throw problem(`has schemaVersion ${JSON.stringify(record.schemaVersion)}, expected ${JOURNAL_SCHEMA}`);
  if (typeof record.version !== 'string') throw problem('has no version');
  if (typeof record.changelogSha256 !== 'string' || !SHA256.test(record.changelogSha256)) throw problem('has no changelog hash');
  if (!Array.isArray(record.fragments)) throw problem('has no fragment list');
  for (const item of record.fragments) {
    if (item === null || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.sha256 !== 'string' || !SHA256.test(item.sha256)) {
      throw problem('has a fragment entry without a name and a hash');
    }
    // A hand-edited journal must not be able to point the deletions outside changelog.d.
    if (path.basename(item.name) !== item.name || !item.name.endsWith('.md')) {
      throw problem(`names ${JSON.stringify(item.name)}, which is not a bare changelog.d file name`);
    }
  }
  return record;
}

async function readJournal(journal) {
  let raw;
  try {
    raw = await readFile(journal, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  return assertJournal(parsed, journal);
}

/**
 * Delete the fragments a previous cut recorded, but only the ones whose content it actually consumed.
 * A fragment edited after the interruption stays for the next release; an already absent one is done.
 */
async function replayFragmentDeletions(file, record) {
  const directory = path.join(path.dirname(file), 'changelog.d');
  const kept = [];
  for (const item of record.fragments) {
    const target = path.join(directory, item.name);
    let body;
    try {
      body = await readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (sha256(body) !== item.sha256) {
      kept.push(item.name);
      continue;
    }
    await unlink(target);
  }
  return kept;
}

/** Remove a scratch file, tolerating a concurrent or repeated removal. */
async function removeIfPresent(target) {
  try {
    await unlink(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Compose `changelog.d` fragments into `[Unreleased]`, then cut, under the shared release lock.
 * A journal records the intended deletions before the changelog write, so a cut interrupted after
 * that write is finished by a rerun instead of being refused as a duplicate section. Every cut
 * writes it, including a cut with no fragments: the interruption it protects against happens after
 * the write, and only the record of that write lets a rerun tell the section is its own.
 * `options.writeFile` replaces the changelog write and `options.afterWrite` runs right after it,
 * so a failing write and an interruption before the deletions can both be injected.
 */
export async function cutChangelogFile(file, version, date, options = {}) {
  assertStrictVersion(version);
  assertCutDate(date);
  return withReleaseLock(path.dirname(file), 'release:cut', () => cutLocked(file, version, date, options), options);
}

async function cutLocked(file, version, date, options) {
  const write = options.writeFile ?? writeFile;
  const journal = cutJournalPath(file);
  const pending = await readJournal(journal);
  if (pending && pending.version !== version) {
    throw new Error(
      `cut journal ${journal} belongs to ${pending.version}, not ${version}. ` +
        `Run npm run release:cut -- ${pending.version} first so its fragments are cleaned up, then cut ${version}.`,
    );
  }

  const before = await readFile(file, 'utf8');
  if (pending) {
    if (sha256(before) === pending.changelogSha256) {
      // The write landed; only the deletions were interrupted.
      const kept = await replayFragmentDeletions(file, pending);
      await removeIfPresent(journal);
      if (kept.length > 0) {
        // The journal is finished: its remaining entries were not consumed, so they belong to the next cut.
        options.warn?.(`kept ${kept.join(', ')}: content changed since the interrupted cut, so they stay for the next release`);
      }
      return { wrote: false, recovered: true, kept };
    }
    const lines = before.split('\n');
    if (lines.some((line) => versionHeading(version).test(line))) {
      throw new Error(
        `cut journal ${journal} recorded a different ${version} section than the one in ${file}, ` +
          'so it cannot tell which cut wrote it. Check CHANGELOG.md and changelog.d, then delete the journal.',
      );
    }
    // The write never landed; the pending journal is replaced by this run's record.
  }

  const fragments = await readFragments(path.join(path.dirname(file), 'changelog.d'));
  const next = cutChangelogText(mergeFragments(before, fragments), version, date);
  const record = {
    schemaVersion: JOURNAL_SCHEMA,
    version,
    date,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    changelogSha256: sha256(next),
    fragments: fragments.map((fragment) => ({ name: fragment.name, sha256: sha256(fragment.raw) })),
  };
  await writeFile(journal, `${JSON.stringify(record, null, 2)}\n`);
  await write(file, next);
  if (options.afterWrite) await options.afterWrite();
  for (const fragment of fragments) await unlink(fragment.path);
  // Only reached once this run's changelog write has landed and its deletions are done, so the
  // journal on disk is this run's own record, even when it lists no fragments. Another cut of this
  // tree cannot own it: they all journal under the same lock, which this run still holds.
  await removeIfPresent(journal);
  return { wrote: true, recovered: false, kept: [] };
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const [version, extra] = argv;
  if (!version || extra) throw new Error('Usage: cut-changelog.mjs <x.y.z>');
  const file = options.file ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md');
  const warn = options.warn ?? ((message) => process.stderr.write(`${message}\n`));
  const result = await cutChangelogFile(file, version, localCutDate(options.now ?? new Date(), options.timeZone), { warn });
  if (!result.wrote) process.stdout.write(`finished an interrupted cut of ${version}; ${result.kept.length} fragment(s) kept\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
