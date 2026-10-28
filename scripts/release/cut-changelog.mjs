import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
  const heading = new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\](?:\\s|$)`);
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
    fragments.push({ name, category, body: fragmentBody(name, await readFile(full, 'utf8')), path: full });
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

/**
 * Compose `changelog.d` fragments into `[Unreleased]`, then cut.
 * Consumed fragments are deleted only after the changelog write succeeds.
 * `options.writeFile` replaces that write so a failing write can be injected.
 */
export async function cutChangelogFile(file, version, date, options = {}) {
  const write = options.writeFile ?? writeFile;
  const before = await readFile(file, 'utf8');
  const fragments = await readFragments(path.join(path.dirname(file), 'changelog.d'));
  const next = cutChangelogText(mergeFragments(before, fragments), version, date);
  await write(file, next);
  for (const fragment of fragments) await unlink(fragment.path);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const [version, extra] = argv;
  if (!version || extra) throw new Error('Usage: cut-changelog.mjs <x.y.z>');
  const file = options.file ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md');
  await cutChangelogFile(file, version, localCutDate(options.now ?? new Date(), options.timeZone));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
