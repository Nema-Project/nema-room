// Read-only check that one version is a complete, consistent release set (spec phase 3, step 1).
// "Complete" means the artifacts exist and agree. It is not a test, acceptance, or smoke result.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldMoveLatest } from '../images/check-images.mjs';
import { readReleaseVersion } from '../desktop/release-version.mjs';
import {
  IMAGE_REPOSITORIES,
  NPM_PACKAGE,
  checkReleaseAssets,
  missing,
  ok,
  readImage,
  readLatestRelease,
  readNpmDistTags,
  readNpmProvenance,
  readNpmVersion,
  readRelease,
  readTagCommit,
  unknown,
} from './registry-read.mjs';

const NPM_WORKFLOW = '.github/workflows/npm-publish.yml';
export const EXIT = Object.freeze({ complete: 0, incomplete: 1, undetermined: 2, usage: 64 });
const pending = (detail, evidence = {}) => ({ state: 'pending', detail, evidence });

export function parseVersion(value) {
  if (typeof value !== 'string' || value.startsWith('v')) throw new Error(`Version must be strict SemVer without a v prefix: ${JSON.stringify(value)}`);
  return readReleaseVersion(`v${value}`, value);
}

/** Missing wins over unknown, unknown over ok. `pending` counts as ok for the overall result. */
function combine(results, describe) {
  const missingOnes = results.filter((r) => r.state === 'missing');
  if (missingOnes.length) return missing(missingOnes.map((r) => r.detail).join('; '), describe());
  const unknownOnes = results.filter((r) => r.state === 'unknown');
  if (unknownOnes.length) return unknown(unknownOnes.map((r) => r.detail).join('; '), describe());
  return ok(describe());
}

async function npmItem(io, version, stage, expectedIntegrity) {
  const read = await readNpmVersion(io, version);
  if (stage === 'candidate' && read.state === 'missing') return pending(`${NPM_PACKAGE}@${version} is not on npm yet; promote publishes it`, { expectedIntegrity });
  if (read.state !== 'ok') return read;
  if (stage === 'candidate' && read.evidence.integrity !== expectedIntegrity) {
    return missing(`registry holds a different tarball: ${read.evidence.integrity}, expected ${expectedIntegrity}`, read.evidence);
  }
  return ok(read.evidence, `${NPM_PACKAGE}@${version} integrity ${read.evidence.integrity}`);
}

async function imagesItem(io, version) {
  const hub = await readImage(io, IMAGE_REPOSITORIES.hub, version);
  const web = await readImage(io, IMAGE_REPOSITORIES.web, version);
  const result = combine([hub, web], () => ({ hub: hub.evidence, web: web.evidence }));
  if (result.state === 'ok') result.detail = `hub ${hub.evidence.platformDigest ?? hub.evidence.digest}, web ${web.evidence.platformDigest ?? web.evidence.digest} (linux/amd64)`;
  return result;
}

async function releaseItem(io, version, stage) {
  const release = await readRelease(io, `v${version}`);
  if (release.state !== 'ok') return release;
  const checked = await checkReleaseAssets(io, version, release.evidence);
  if (checked.state !== 'ok') return checked;
  const draft = checked.evidence.draft;
  checked.detail = `v${version} ${draft ? 'is still a draft' : 'is published'}; ${checked.evidence.assets} assets match; docker-compose.yml pins ${version}`;
  if (draft && stage === 'final') checked.detail += '; the GitHub latest pointer has not moved';
  return checked;
}

async function consistencyItem(io, version, items) {
  const checks = [];
  const note = [];
  const tag = await readTagCommit(io, `v${version}`);
  if (tag.state !== 'ok') checks.push(tag);
  const tagCommit = tag.evidence.commit ?? null;

  const release = items.release;
  if (release.state === 'ok') {
    if (release.evidence.manifestVersion !== version) checks.push(missing(`release manifest version ${release.evidence.manifestVersion}`));
    if (tagCommit && release.evidence.manifestCommit !== tagCommit) checks.push(missing(`release manifest commit ${release.evidence.manifestCommit} is not tag commit ${tagCommit}`));
  } else {
    checks.push(unknown('release not checked'));
  }

  if (items.images.state === 'ok') {
    for (const name of ['hub', 'web']) {
      const label = items.images.evidence[name].label;
      if (label === null) checks.push(missing(`${name} image has no org.opencontainers.image.version label`));
      else if (label !== version) checks.push(missing(`${name} image label is ${label}, not ${version}`));
    }
    note.push('images carry no revision label; image commit not compared');
  } else {
    checks.push(unknown('images not checked'));
  }

  if (items.npm.state === 'ok') {
    const provenance = await readNpmProvenance(io, version);
    if (provenance.state !== 'ok') checks.push(provenance);
    else {
      const p = provenance.evidence;
      if (p.workflowPath !== NPM_WORKFLOW) checks.push(missing(`npm provenance workflow is ${p.workflowPath}`));
      if (p.workflowRef !== `refs/tags/v${version}`) checks.push(missing(`npm provenance ref is ${p.workflowRef}`));
      if (tagCommit && p.commit !== tagCommit) checks.push(missing(`npm provenance commit ${p.commit} is not tag commit ${tagCommit}`));
      note.push(`npm provenance read from the registry (${p.event}); signature not verified`);
    }
  } else if (items.npm.state === 'pending') {
    note.push('npm not published yet; provenance not compared');
  } else {
    checks.push(unknown('npm not checked'));
  }

  const result = combine(checks, () => ({ tagCommit }));
  // A prerequisite that is itself missing or unknown is reported on its own line; do not count it twice.
  if (result.state === 'unknown' && checks.every((c) => c.state === 'unknown' && / not checked$/.test(c.detail))) {
    result.detail = `not checked: ${checks.map((c) => c.detail.replace(/ not checked$/, '')).join(', ')} not ok`;
  }
  if (result.state === 'ok') result.detail = `versions ${version}; tag, release manifest${items.npm.state === 'ok' ? ' and npm provenance' : ''} commit ${tagCommit}`;
  if (note.length) result.detail = `${result.detail} (${note.join('; ')})`;
  return result;
}

/**
 * `io`: { fetchImpl, sleep?, token? }. stage 'final' (default) needs npm present; 'candidate' allows npm to be
 * absent and requires `expectedIntegrity` when it is present. Nothing here writes anywhere.
 */
export async function verifyRelease({ version, stage = 'final', expectedIntegrity = null, io }) {
  parseVersion(version);
  if (!['final', 'candidate'].includes(stage)) throw new Error(`Unknown stage ${stage}`);
  if (stage === 'candidate' && !/^sha512-/.test(expectedIntegrity ?? '')) throw new Error('candidate stage needs --expected-integrity sha512-...');
  const items = {};
  items.npm = await npmItem(io, version, stage, expectedIntegrity);
  items.images = await imagesItem(io, version);
  items.release = await releaseItem(io, version, stage);
  items.consistency = await consistencyItem(io, version, items);
  const states = Object.values(items).map((item) => item.state);
  const overall = states.includes('missing') ? 'incomplete' : states.includes('unknown') ? 'undetermined' : 'complete';
  return { version, stage, items, overall, exitCode: EXIT[overall] };
}

// ---------- pointers ----------

/** A pointer value from a registry is data: anything that is not a strict release version is unknown. */
function versionPointer(value, source) {
  try {
    parseVersion(value);
    return { state: 'version', version: value };
  } catch {
    return { state: 'unknown', version: null, detail: `${source} holds ${JSON.stringify(value)}, not a release version` };
  }
}

function pointerFromImage(result) {
  if (result.state === 'missing' && result.evidence.reason === 'absent') return { state: 'absent', version: null };
  if (result.state !== 'ok') return { state: 'unknown', version: null, detail: result.detail };
  if (!result.evidence.label) return { state: 'unknown', version: null, detail: `${result.evidence.reference} has no version label` };
  const pointer = versionPointer(result.evidence.label, result.evidence.reference);
  // The digest lets promote tell "latest has this version's label" from "latest is the verified index".
  return pointer.state === 'version' ? { ...pointer, digest: result.evidence.digest ?? null } : pointer;
}

export async function readPointers(io) {
  const tags = await readNpmDistTags(io);
  const npmPointer = (name) => {
    if (tags.state !== 'ok') return { state: 'unknown', version: null, detail: tags.detail };
    const value = tags.evidence.tags[name];
    return value === undefined ? { state: 'absent', version: null } : versionPointer(value, `npm dist-tag ${name}`);
  };
  const latestRelease = await readLatestRelease(io);
  const github = latestRelease.state === 'ok'
    ? versionPointer(latestRelease.evidence.tag.replace(/^v/, ''), `GitHub latest release ${latestRelease.evidence.tag}`)
    : latestRelease.state === 'missing' ? { state: 'absent', version: null } : { state: 'unknown', version: null, detail: latestRelease.detail };
  return {
    npm: { latest: npmPointer('latest'), next: npmPointer('next') },
    ghcr: { hub: pointerFromImage(await readImage(io, IMAGE_REPOSITORIES.hub, 'latest')), web: pointerFromImage(await readImage(io, IMAGE_REPOSITORIES.web, 'latest')) },
    github: { latest: github },
  };
}

/** Channel-aware: a stable release decides the stable pointers; a prerelease decides only npm next. */
export function pointerDecisions(pointers, version, prerelease) {
  const decide = (pointer) => {
    if (pointer.state === 'unknown') return 'unknown';
    if (pointer.state === 'absent') return 'move';
    try {
      return shouldMoveLatest(pointer.version, version) ? 'move' : 'keep';
    } catch {
      return 'unknown';
    }
  };
  const stable = (pointer) => (prerelease ? 'skip' : decide(pointer));
  return {
    'npm latest': stable(pointers.npm.latest),
    'npm next': prerelease ? decide(pointers.npm.next) : 'skip',
    'ghcr hub latest': stable(pointers.ghcr.hub),
    'ghcr web latest': stable(pointers.ghcr.web),
    'github latest': stable(pointers.github.latest),
  };
}

// ---------- output ----------

const LABEL = { ok: 'ok', missing: 'MISSING', unknown: 'UNKNOWN', pending: 'pending' };

export function formatReport(report) {
  const lines = [`verify-release ${report.version} (stage ${report.stage})`];
  for (const [id, item] of Object.entries(report.items)) lines.push(`${LABEL[item.state].padEnd(8)} ${id.padEnd(12)} ${item.detail}`);
  const meaning = {
    complete: 'every artifact exists and they agree. This is not a test, smoke, or acceptance result.',
    incomplete: 'at least one artifact is missing or disagrees; do not call this version installable.',
    undetermined: 'nothing is known to be missing, but some answers were unavailable; run again later. Not a missing item, not ready.',
  };
  lines.push(`result: ${report.overall} (exit ${report.exitCode}): ${meaning[report.overall]}`);
  return `${lines.join('\n')}\n`;
}

function describePointer(pointer) {
  if (pointer.state === 'version') return pointer.version;
  if (pointer.state === 'absent') return '(none)';
  return `UNKNOWN (${pointer.detail ?? 'unavailable'})`;
}

export function formatPointers(pointers, decisions, version) {
  const rows = [
    ['npm latest', pointers.npm.latest],
    ['npm next', pointers.npm.next],
    ['ghcr hub latest', pointers.ghcr.hub],
    ['ghcr web latest', pointers.ghcr.web],
    ['github latest', pointers.github.latest],
  ];
  const lines = ['pointers (read only; nothing is moved)'];
  for (const [name, pointer] of rows) lines.push(`${name.padEnd(16)} ${describePointer(pointer)}${decisions ? `  -> ${decisions[name]} for ${version}` : ''}`);
  return `${lines.join('\n')}\n`;
}

// ---------- CLI ----------

const USAGE = `Usage:
  node scripts/release/verify-release.mjs <x.y.z> [--stage final|candidate] [--expected-integrity sha512-...] [--json]
  node scripts/release/verify-release.mjs --pointers [<x.y.z>] [--json]
Reads npm, GHCR (anonymously) and the GitHub Release. Never writes. Set GITHUB_TOKEN to see a draft Release.
Exit: 0 complete, 1 incomplete, 2 undetermined, 64 usage.`;

export function parseArgs(argv) {
  const options = { stage: 'final', json: false, pointers: false, version: null, expectedIntegrity: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--pointers') options.pointers = true;
    else if (arg === '--stage') options.stage = argv[++i];
    else if (arg === '--expected-integrity') options.expectedIntegrity = argv[++i];
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else if (options.version === null) options.version = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (options.help) return options;
  if (options.version !== null) parseVersion(options.version);
  if (!options.pointers && options.version === null) throw new Error('A version is required');
  if (!['final', 'candidate'].includes(options.stage)) throw new Error(`--stage must be final or candidate`);
  if (options.stage === 'candidate' && !/^sha512-/.test(options.expectedIntegrity ?? '')) throw new Error('--stage candidate needs --expected-integrity sha512-...');
  return options;
}

export async function main(argv, { env = process.env, fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}\n`);
    return EXIT.usage;
  }
  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const io = { fetchImpl, token: env.GITHUB_TOKEN || null };
  if (options.pointers) {
    const pointers = await readPointers(io);
    const decisions = options.version ? pointerDecisions(pointers, options.version, parseVersion(options.version).prerelease) : null;
    stdout.write(options.json ? `${JSON.stringify({ pointers, decisions }, null, 2)}\n` : formatPointers(pointers, decisions, options.version));
    return 0;
  }
  const report = await verifyRelease({ version: options.version, stage: options.stage, expectedIntegrity: options.expectedIntegrity, io });
  stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`verify-release failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT.undetermined;
    },
  );
}
