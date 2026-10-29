import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { composeAssetVersion } from '../images/check-images.mjs';
import { checkReleaseSet } from './release-set.mjs';

const REPO = 'https://github.com/Nema-Project/nema-room';
export const latestComposeUrl = `${REPO}/releases/latest/download/docker-compose.yml`;
export const versionedComposeUrl = (version) => `${REPO}/releases/download/v${version}/docker-compose.yml`;

const LOCK = '.nema-install.lock';
const ENV_FILE = '.env';
const COMPOSE_FILE = 'docker-compose.yml';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const readIf = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

const LOCK_LINE = /^\s*(?:export\s+)?NEMA_IMAGE_TAG\s*=\s*(.*)$/;

/**
 * The value Compose would read from one assignment.
 *
 * Compose honours a quoted value and treats ` #` as the start of an inline comment, so `1.2.3 # pinned`
 * locks 1.2.3. Parsing the same way keeps a hand-edited lock usable instead of rejecting it as a
 * malformed version.
 */
function assignmentValue(raw) {
  const text = raw.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end === -1) throw new Error('NEMA_IMAGE_TAG has an unterminated quote in .env');
    const body = text.slice(1, end);
    return quote === '"' ? body.replace(/\\(["\\])/g, '$1') : body;
  }
  const comment = text.search(/\s#/);
  return (comment === -1 ? text : text.slice(0, comment)).trim();
}

/**
 * The value of NEMA_IMAGE_TAG in an `.env` body, or null when the key is absent.
 *
 * Compose resolves a repeated key to whichever assignment it reaches last, so a file carrying two
 * different values means the version this installer verified need not be the one Compose runs.
 * Refusing is the only safe reading; two assignments that already agree are harmless.
 */
export function readLockedVersion(envText) {
  if (envText === null) return null;
  const values = envText
    .split('\n')
    .map((line) => line.match(LOCK_LINE))
    .filter((match) => match !== null)
    .map((match) => assignmentValue(match[1]));
  if (values.length === 0) return null;
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(`NEMA_IMAGE_TAG is assigned more than once in .env (${distinct.join(', ')}); keep exactly one so Compose cannot run a version this installer did not verify`);
  }
  return distinct[0];
}

function assertUsableLock(value) {
  if (value === '') throw new Error('NEMA_IMAGE_TAG is empty in .env; set a released version or remove the key');
  if (value === 'latest') throw new Error('NEMA_IMAGE_TAG=latest cannot be locked; a released version is required');
  if (value.startsWith('v')) throw new Error(`NEMA_IMAGE_TAG=${value} must not carry a v prefix`);
  if (!SEMVER.test(value)) throw new Error(`NEMA_IMAGE_TAG=${value} is not a strict SemVer version; a value Compose reads literally (including a trailing comment) cannot be locked`);
  // A prerelease resolves its images the same way, but a release asset set is only promised for a
  // stable tag, so accepting one here would lock a version the rest of the flow never publishes.
  if (value.includes('-')) throw new Error(`NEMA_IMAGE_TAG=${value} is a prerelease; only a stable release can be locked`);
}

/** Replace the NEMA_IMAGE_TAG line, or append one, leaving every other byte untouched. */
function withLockedVersion(envText, version) {
  const line = `NEMA_IMAGE_TAG=${version}`;
  if (envText === null) return `# Locked by the Nema installer. Do not edit while installing.\n${line}\n`;
  const lines = envText.split('\n');
  const indexes = lines.flatMap((row, index) => (LOCK_LINE.test(row) ? [index] : []));
  if (indexes.length === 0) {
    const body = envText.endsWith('\n') || envText === '' ? envText : `${envText}\n`;
    return `${body}${line}\n`;
  }
  // Every assignment is rewritten: they hold the same value by the time we get here, and leaving a
  // second one behind would put Compose back in charge of the version.
  for (const index of indexes) lines[index] = line;
  return lines.join('\n');
}

/**
 * Decide what to install and where, without writing anything.
 *
 * `composeText` is the exact bytes that passed the version check; `applyInstall` writes those and
 * never fetches again.
 */
export async function resolveInstall({ dir, fetchText, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const envPath = path.join(dir, ENV_FILE);
  const composePath = path.join(dir, COMPOSE_FILE);
  const envText = readIf(envPath);
  const locked = readLockedVersion(envText);
  if (locked !== null) assertUsableLock(locked);

  const local = readIf(composePath);
  const interrupted = interruptedInstall(dir);
  if (local !== null) {
    const localVersion = composeAssetVersion(local);
    if (locked !== null && localVersion !== locked && interrupted !== locked) {
      throw new Error(`Local docker-compose.yml pins ${localVersion} but .env locks ${locked}; refusing to guess`);
    }
    if (locked !== null && localVersion !== locked) {
      // An install of `locked` died after committing `.env`; the compose file is the half that never
      // landed. Falling through re-fetches that exact version's asset, never latest.
      return resolveLocked(locked, [`finished an interrupted install of ${locked}; the local Docker Compose file was still on ${localVersion}`]);
    }
    // A local file that matches the lock is still only installable if the release set exists; without
    // this the flow would promise a version whose images or package were never published.
    await checkReleaseSet({ version: localVersion, composeText: local, fetchImpl });
    return plan({ version: localVersion, action: locked === null ? 'write' : 'reuse', composeText: local, composeSource: 'local', envPath, composePath, notes: [] });
  }

  if (locked !== null) {
    // A lock left by a dead process means the pair below is being completed, not chosen afresh.
    const note = interrupted === locked ? [`finished an interrupted install of ${locked}`] : [];
    return resolveLocked(locked, note);
  }

  const composeText = await fetchText(latestComposeUrl);
  const version = composeAssetVersion(composeText);
  await checkReleaseSet({ version, composeText, fetchImpl });
  return plan({ version, action: 'write', composeText, composeSource: 'latest', envPath, composePath, notes: [`resolved ${now().toISOString()} from the latest release`] });

  async function resolveLocked(version, leadingNotes) {
    const url = versionedComposeUrl(version);
    const text = await fetchText(url);
    const assetVersion = composeAssetVersion(text);
    if (assetVersion !== version) {
      throw new Error(`Release v${version} publishes a compose file pinning ${assetVersion}; refusing to install a different version`);
    }
    await checkReleaseSet({ version, composeText: text, fetchImpl });
    return plan({ version, action: 'reuse', composeText: text, composeSource: 'versioned', envPath, composePath, notes: [...leadingNotes, `install stays on ${version}; this asset came from ${url}`] });
  }

  function plan(fields) {
    // Presence is part of the decision: `applyInstall` refuses to act if the directory changed shape
    // after this ran, because writing a file that vanished would restore whatever the user deleted.
    return {
      ...fields,
      envPresent: envText !== null,
      composePresent: local !== null,
      daemonCommand: `npm i -g @nema-project/nema@${fields.version}`,
    };
  }
}

function writeAtomic(target, body) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomBytes(6).toString('hex')}`);
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

function assertCommitted(dir, version) {
  const env = readLockedVersion(readFileSync(path.join(dir, ENV_FILE), 'utf8'));
  const compose = composeAssetVersion(readFileSync(path.join(dir, COMPOSE_FILE), 'utf8'));
  if (env !== version || compose !== version) {
    throw new Error(`Install wrote inconsistent versions: .env has ${env}, compose pins ${compose}, expected ${version}`);
  }
}

// A lock is abandoned when the process that made it is gone. Two files take milliseconds to write,
// so a lock this old belongs to nobody even when the pid check cannot prove it (another host, a
// container, a recycled pid).
const STALE_LOCK_MS = 10 * 60 * 1000;

/** Whether the process that wrote this lock is still running on this host. */
function holderAlive(holder) {
  if (holder?.host !== os.hostname() || !Number.isInteger(holder.pid)) return null;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM' ? true : false;
  }
}

/** Remove an abandoned lock so a crashed install does not block every later one. */
function clearStaleLock(lockPath) {
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    holder = null;
  }
  const alive = holderAlive(holder);
  if (alive === true) return false;
  const age = Date.now() - statSync(lockPath).mtimeMs;
  if (alive === false || age > STALE_LOCK_MS) {
    rmSync(lockPath, { force: true });
    return true;
  }
  return false;
}

function takeLock(dir, version) {
  const lockPath = path.join(dir, LOCK);
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), version });
  // `wx` is O_EXCL: the loser of a race gets EEXIST here and writes nothing.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return lockPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt === 0 && clearStaleLock(lockPath)) continue;
      throw new Error(`another install is already running in ${dir} (lock ${lockPath})`);
    }
  }
  throw new Error(`another install is already running in ${dir} (lock ${lockPath})`);
}

/**
 * The version an abandoned install was committing, or null when no abandoned lock exists.
 *
 * The two renames cannot be atomic together, so a process killed between them leaves `.env` on the
 * new version and the compose file on the old one. The lock is the proof of what was in flight, which
 * is why the retry can finish the pair instead of asking a person to repair two files by hand.
 */
export function interruptedInstall(dir) {
  const lockPath = path.join(dir, LOCK);
  if (!existsSync(lockPath)) return null;
  let holder = null;
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  if (holderAlive(holder) === true) return null;
  const age = Date.now() - statSync(lockPath).mtimeMs;
  if (holderAlive(holder) === null && age <= STALE_LOCK_MS) return null;
  return typeof holder?.version === 'string' ? holder.version : null;
}

/**
 * Commit the two files as a pair. `.env` is renamed first, compose second, and both are re-read
 * afterwards so a mismatch is reported instead of silently accepted.
 */
export async function applyInstall({ dir, plan }) {
  mkdirSync(dir, { recursive: true });
  const lockPath = takeLock(dir, plan.version);

  const temps = [];
  try {
    const envPath = path.join(dir, ENV_FILE);
    const composePath = path.join(dir, COMPOSE_FILE);
    const envText = readIf(envPath);
    const current = readLockedVersion(envText);
    if (current !== null && current !== plan.version) {
      throw new Error(`.env changed while installing: NEMA_IMAGE_TAG is ${current}, expected ${plan.version}`);
    }
    // A file that disappeared after the plan was made is a change too: writing it back would undo a
    // deliberate deletion instead of reporting that the directory moved under us.
    if ((envText !== null) !== plan.envPresent) {
      throw new Error(`.env ${envText === null ? 'disappeared' : 'appeared'} while installing; run the installer again`);
    }
    const composeText = readIf(composePath);
    if ((composeText !== null) !== plan.composePresent) {
      throw new Error(`${COMPOSE_FILE} ${composeText === null ? 'disappeared' : 'appeared'} while installing; run the installer again`);
    }
    if (composeText !== null && composeText !== plan.composeText) {
      throw new Error(`${COMPOSE_FILE} changed while installing; refusing to overwrite it`);
    }
    const envDone = current === plan.version;
    // A file already holding the planned bytes is left alone: renaming over it would replace a
    // symlink or drop the mode someone chose, for no gain.
    const composeDone = composeText === plan.composeText;
    if (envDone && composeDone) {
      assertCommitted(dir, plan.version);
      return;
    }

    // Both temporaries are written before either rename, so an interrupted run leaves old files.
    let envTemp = null;
    if (!envDone) {
      envTemp = writeAtomic(envPath, withLockedVersion(envText, plan.version));
      temps.push(envTemp);
    }
    let composeTemp = null;
    if (!composeDone) {
      composeTemp = writeAtomic(composePath, plan.composeText);
      temps.push(composeTemp);
    }
    if (envTemp !== null) renameSync(envTemp, envPath);
    if (composeTemp !== null) renameSync(composeTemp, composePath);
    temps.length = 0;
    assertCommitted(dir, plan.version);
  } finally {
    for (const temp of temps) rmSync(temp, { force: true });
    rmSync(lockPath, { force: true });
  }
}

const USAGE = [
  'node scripts/install/public.mjs [--dir <path>] [--check] [--lang en|zh|ja]',
  '',
  'Resolves the release to install, verifies its four artifacts, and locks that version into',
  '`<dir>/.env` next to a matching `docker-compose.yml`.',
  '',
  '  --dir <path>   where to install (default: the current directory)',
  '  --check        resolve and verify only; write nothing',
  '  --lang         en, zh, or ja (default: en)',
].join('\n');

const CLI_TEXT = {
  en: {
    plan: 'version', action: 'action', compose: 'compose', daemon: 'daemon', next: 'Install the matching daemon with:',
    check: 'Verified. Nothing was written.', wrote: 'Wrote .env and docker-compose.yml. Run the daemon with:',
  },
  zh: {
    plan: '版本', action: '操作', compose: 'compose 来源', daemon: 'daemon', next: '安装同版 daemon：',
    check: '校验通过，未写入任何文件。', wrote: '已写入 .env 与 docker-compose.yml。启动 daemon：',
  },
  ja: {
    plan: 'バージョン', action: '操作', compose: 'compose の取得元', daemon: 'デーモン', next: '同じバージョンのデーモンを入れるには:',
    check: '検証できました。ファイルは書き換えていません。', wrote: '.env と docker-compose.yml を書き込みました。デーモンの起動:',
  },
};

export function parseInstallArgs(args) {
  const options = { dir: process.cwd(), check: false, lang: 'en' };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--dir') {
      const value = args[i + 1];
      if (!value) throw new Error('--dir needs a path');
      options.dir = path.resolve(value);
      i += 1;
    } else if (arg === '--lang') {
      const value = args[i + 1];
      if (!['en', 'zh', 'ja'].includes(value)) throw new Error('--lang must be en, zh, or ja');
      options.lang = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** Fetch a text body, or fail with the reason instead of an unparsable compose file. */
async function fetchTextStrict(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`could not download ${url} (HTTP ${response.status}); is that release published?`);
  return response.text();
}

export async function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseInstallArgs(args);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const t = CLI_TEXT[options.lang];
  try {
    const plan = await resolveInstall({ dir: options.dir, fetchText: fetchTextStrict });
    console.log(`${t.plan}: ${plan.version}\n${t.action}: ${plan.action}\n${t.compose}: ${plan.composeSource}`);
    for (const note of plan.notes) console.log(note);
    if (options.check) {
      console.log(`${t.check}\n${t.daemon}: ${plan.daemonCommand}`);
      return;
    }
    await applyInstall({ dir: options.dir, plan });
    console.log(`${t.wrote}\n${plan.daemonCommand}\nnpx @nema-project/nema@${plan.version} --version`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
