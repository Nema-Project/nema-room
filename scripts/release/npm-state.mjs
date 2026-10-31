// Decide what an npm publish of one exact version should do, from the registry's own answer.
//   absent    - the registry said 404 for that exact version: publishing is the next step
//   same      - the registry holds a tarball whose integrity equals the expected one: already done
//   different - the registry holds another tarball: refuse, never overwrite or republish
// One read is classified, not merely thrown on, so a caller that re-reads after a publish can tell
// "not written yet" from "not readable right now" from "wrote something else".
//   denied    - 401/403: the reader may not see this package; waiting cannot change that
//   untrusted - any other answer this reader cannot interpret (other status, unparsable body, another
//               version, no sha512 integrity); never treated as absent
//   transient - a timeout, network error, 429 or 5xx, or a body that did not finish arriving:
//               worth one more read within a budget
// Network, auth, 5xx and parse errors still throw from npmPublishState: "cannot tell" is never absent.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseVersion } from '../desktop/release-version.mjs';

const PACKAGE = '@nema-project/nema';
const TIMEOUT_MS = 15_000;

/** The same `sha512-<base64>` form npm stores in `dist.integrity`. */
export async function tarballIntegrity(file) {
  return `sha512-${createHash('sha512').update(await readFile(file)).digest('base64')}`;
}

/** `sha512-` plus the canonical base64 of exactly 64 bytes, as npm writes it. */
export function isSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const bytes = Buffer.from(value.slice(7), 'base64');
  // Re-encode: base64 with non-zero unused bits decodes to the same bytes but is not npm's string.
  return bytes.length === 64 && bytes.toString('base64') === value.slice(7);
}

const cannotTell = (version, detail) => `cannot tell whether ${PACKAGE}@${version} exists: ${detail}`;

/**
 * One classified read. `same`/`absent`/`different` are definitive answers about the registry;
 * `denied`/`untrusted`/`transient` say the answer could not be read and carry a `detail` naming why.
 */
export async function probeNpmVersion({ version, expectedIntegrity, fetchImpl = globalThis.fetch }) {
  readReleaseVersion(`v${version}`, version);
  if (!isSha512Integrity(expectedIntegrity)) throw new Error('expected integrity must be sha512-<base64 of 64 bytes>');
  const url = `https://registry.npmjs.org/${PACKAGE}/${version}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return { state: 'transient', detail: cannotTell(version, error instanceof Error ? error.message : String(error)) };
  }
  if (response.status === 404) return { state: 'absent' };
  if (response.status === 401 || response.status === 403) return { state: 'denied', detail: cannotTell(version, `HTTP ${response.status}`) };
  if (response.status === 429 || response.status >= 500) return { state: 'transient', detail: cannotTell(version, `HTTP ${response.status}`) };
  if (response.status !== 200) return { state: 'untrusted', detail: cannotTell(version, `HTTP ${response.status}`) };
  let body;
  try {
    body = await response.json();
  } catch (error) {
    // The 200 headers arrived but the body did not finish: a timeout or a reset is a read failure, and
    // another read inside the budget can still succeed. Only a body that arrived and does not parse is
    // an answer this reader cannot trust.
    if (!(error instanceof SyntaxError)) {
      return { state: 'transient', detail: cannotTell(version, error instanceof Error ? error.message : String(error)) };
    }
    return { state: 'untrusted', detail: cannotTell(version, 'unparsable registry answer') };
  }
  if (body?.version !== version || typeof body?.dist?.integrity !== 'string') {
    return { state: 'untrusted', detail: cannotTell(version, `registry answered ${JSON.stringify(body?.version)} without integrity`) };
  }
  return body.dist.integrity === expectedIntegrity
    ? { state: 'same', integrity: body.dist.integrity }
    : { state: 'different', integrity: body.dist.integrity, detail: `registry holds ${body.dist.integrity} for ${version}` };
}

/** The strict form: only a definitive answer is returned, anything else throws its own detail. */
export async function npmPublishState({ version, expectedIntegrity, fetchImpl = globalThis.fetch }) {
  const result = await probeNpmVersion({ version, expectedIntegrity, fetchImpl });
  if (result.state === 'same' || result.state === 'absent' || result.state === 'different') return result;
  throw new Error(result.detail);
}

const USAGE = 'Usage: npm-state.mjs --integrity <tarball> | npm-state.mjs <x.y.z> <expected-integrity>';

export async function main(argv, { fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    if (argv[0] === '--integrity' && argv.length === 2) {
      stdout.write(`${await tarballIntegrity(argv[1])}\n`);
      return 0;
    }
    if (argv.length !== 2 || argv[0].startsWith('-')) throw new Error(USAGE);
    const result = await npmPublishState({ version: argv[0], expectedIntegrity: argv[1], fetchImpl });
    stdout.write(`${result.state}\n`);
    if (result.state === 'different') {
      stderr.write(`registry holds ${result.integrity} for ${argv[0]}, not ${argv[1]}; refusing to publish\n`);
      return 3;
    }
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
