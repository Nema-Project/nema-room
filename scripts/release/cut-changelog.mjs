import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertStrictVersion } from './stamp-version.mjs';

const UNRELEASED = '## [Unreleased]';

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
  const ended = markdown.endsWith('\n');
  const lines = markdown.split('\n');
  const unreleased = lines.indexOf(UNRELEASED);
  if (unreleased < 0) throw new Error('CHANGELOG.md has no [Unreleased] section');
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

export async function cutChangelogFile(file, version, date) {
  const before = await readFile(file, 'utf8');
  const next = cutChangelogText(before, version, date);
  await writeFile(file, next);
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
