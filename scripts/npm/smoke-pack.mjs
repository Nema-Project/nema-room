import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupCommand } from '../setup.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function parseSmokeArgs(argv) {
  const parsed = { tarball: undefined, hubUrl: undefined, tokenFile: undefined, expectSkew: false };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === '--hub-url') parsed.hubUrl = required(rest.shift(), '--hub-url');
    else if (arg === '--token-file') parsed.tokenFile = required(rest.shift(), '--token-file');
    else if (arg === '--expect-skew') parsed.expectSkew = true;
    else if (!arg.startsWith('-') && parsed.tarball === undefined) parsed.tarball = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!parsed.tarball) throw new Error('Usage: smoke-pack.mjs <tarball> [--hub-url URL --token-file PATH] [--expect-skew]');
  if ((parsed.hubUrl === undefined) !== (parsed.tokenFile === undefined)) throw new Error('--hub-url and --token-file must be set together');
  if (parsed.expectSkew && parsed.hubUrl === undefined) throw new Error('--expect-skew requires --hub-url and --token-file');
  return parsed;
}

function required(value, flag) {
  if (!value || value.startsWith('-')) throw new Error(`${flag} needs a value`);
  return value;
}

export function assertVersion(actual, expected) {
  const got = String(actual).trim();
  if (got !== expected) throw new Error(`nema --version printed ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
}

export function bumpPatch(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(.*)$/.exec(version);
  if (!match) throw new Error(`cannot bump version ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}${match[4]}`;
}

/**
 * One version below `version`, for the skew smoke: under D-9 a newer CLI is welcomed, so a skew
 * daemon must report below the hub's minimum, not above the packed version. Drops any prerelease
 * suffix; the result only needs to sort below the installed version.
 */
export function lowerPatch(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(.*)$/.exec(version);
  if (!match) throw new Error(`cannot lower version ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  return '0.0.0';
}

export function localTarballArg(tarball) {
  if (path.isAbsolute(tarball)) return tarball;
  const spec = String(tarball).replace(/\\/g, '/');
  if (spec.startsWith('./') || spec.startsWith('../')) return spec;
  return `./${spec}`;
}

export function installedBin(installDir) {
  const name = process.platform === 'win32' ? 'nema.cmd' : 'nema';
  return path.join(installDir, 'node_modules', '.bin', name);
}

function installedPackageFile(installDir) {
  return path.join(installDir, 'node_modules', '@nema-project', 'nema', 'package.json');
}

export async function bumpInstalledPackage(installDir) {
  const file = installedPackageFile(installDir);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.version = bumpPatch(pkg.version);
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg.version;
}

/** Rewrites the installed package to a version below the packed one, so the hub refuses it as skewed. */
export async function lowerInstalledPackage(installDir) {
  const file = installedPackageFile(installDir);
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.version = lowerPatch(pkg.version);
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg.version;
}

function runBin(bin, args, cwd, env = process.env) {
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${bin} failed`);
  return result.stdout;
}

/** Release hosts the shipped lock is built for. Anything else (musl Linux, other arches) cannot install Graphify. */
export const SUPPORTED_RELEASE_HOSTS = new Set(['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);

/** Linux without a glibc runtime version in Node's diagnostic report is musl (Alpine and friends). */
export function detectMusl() {
  if (process.platform !== 'linux') return false;
  const report = process.report?.getReport?.();
  return typeof report?.header?.glibcVersionRuntime !== 'string';
}

/**
 * Whether this host can install Graphify, decided from the host itself — never from the packed lock,
 * so a lock that dropped a target cannot make the smoke pass on a host it left behind.
 */
export function releaseHost(info = {}) {
  const platform = info.platform ?? process.platform;
  const arch = info.arch ?? process.arch;
  const musl = info.musl ?? (platform === 'linux' ? detectMusl() : false);
  const key = `${platform}-${arch}`;
  return { platform, arch, musl, key, supported: SUPPORTED_RELEASE_HOSTS.has(key) && !musl };
}

/**
 * The installed package reads its shipped Graphify lock and reports the component without downloading:
 * `nema components status --json` against an empty home. A lock missing from the package shows up as
 * `lock-unreadable`; an installed component in an empty home would mean it read the wrong store. On a
 * supported release host the package must also offer a download: a lock without this host's target would
 * otherwise report `unsupported-platform` and the smoke would pass a package that cannot install Graphify.
 */
export function assertComponentStatus(stdout, info = {}) {
  const host = releaseHost(info);
  let view;
  try {
    view = JSON.parse(stdout);
  } catch {
    throw new Error(`nema components status --json printed no JSON:\n${stdout}`);
  }
  // The offer's size must be a number the CLI actually computed: a string would pass a `> 0`
  // comparison by coercion and let a malformed status through.
  const hasDownloadOffer = (v) => typeof v.offer?.totalBytes === 'number' && Number.isFinite(v.offer.totalBytes) && v.offer.totalBytes > 0;
  const status = view?.status;
  if (view?.name !== 'graphify' || typeof status?.state !== 'string') throw new Error(`unexpected components status:\n${stdout}`);
  if (status.state === 'failed' && status.reason === 'lock-unreadable') throw new Error(`the packed CLI cannot read its Graphify lock: ${status.detail}`);
  if (status.state === 'installed' || status.state === 'installing') throw new Error(`an empty home reported graphify ${status.state}`);
  if (host.supported) {
    if (status.state !== 'not-installed' || !hasDownloadOffer(view)) {
      throw new Error(`a supported release host (${host.key}) must offer a Graphify download; got ${status.state}${status.state === 'failed' ? ` (${status.reason})` : ''}:\n${stdout}`);
    }
  } else if (status.state === 'failed' && status.reason === 'unsupported-platform') {
    return view;
  }
  if (status.state === 'not-installed' && !hasDownloadOffer(view)) throw new Error(`no download offer for an installable platform:\n${stdout}`);
  return view;
}

function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`timed out waiting for ${pattern}. output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk;
      if (pattern.test(output)) finish(null, output);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => finish(new Error(`daemon exited ${code} before ${pattern}. output:\n${output}`)));
    child.once('error', (error) => finish(error));
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function smokePack(options, { cliVersion = undefined, timeoutMs = 20_000 } = {}) {
  const expected = cliVersion ?? JSON.parse(await readFile(path.join(repoRoot, 'apps/cli/package.json'), 'utf8')).version;
  const root = await mkdtemp(path.join(tmpdir(), 'nema-pack-smoke-'));
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'nema-pack-smoke', private: true })}\n`);
  const source = path.resolve(options.tarball);
  const packedName = path.basename(source);
  await copyFile(source, path.join(root, packedName));
  const spec = localTarballArg(packedName);
  const npm = setupCommand('npm', ['install', '--ignore-scripts', '--no-fund', '--no-audit', spec]);
  const installed = spawnSync(npm.bin, npm.args, { cwd: root, encoding: 'utf8' });
  if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout || installed.error?.message || 'npm install failed');
  const bin = installedBin(root);
  const printed = runBin(bin, ['--version'], root);
  if (!options.expectSkew) assertVersion(printed, expected);
  process.stdout.write(`nema --version ${printed.trim()}\n`);
  const installJs = path.join(root, 'node_modules', '@nema-project', 'nema', 'dist', 'report', 'install.js');
  const skill = fileURLToPath(new URL('../../src/report/SKILL.md', pathToFileURL(installJs)));
  await readFile(skill, 'utf8');
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  const componentEnv = { ...process.env, HOME: home, USERPROFILE: home, NEMA_GRAPHIFY_BIN: '' };
  const components = assertComponentStatus(runBin(bin, ['components', 'status', '--json'], root, componentEnv));
  process.stdout.write(`nema components status: graphify ${components.status.state}${components.status.reason ? ` (${components.status.reason})` : ''}\n`);
  // --expect-skew must produce a daemon the hub actually refuses. A newer CLI is welcomed under
  // D-9, so lower the installed version below the floor instead of bumping it above the hub.
  if (options.expectSkew) await lowerInstalledPackage(root);
  if (!options.hubUrl) return { root, version: printed.trim() };
  const child = spawn(bin, ['daemon', '--hub', options.hubUrl, '--token-file', options.tokenFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  try {
    const pattern = options.expectSkew ? /run: npm i -g @nema-project\/nema@\d+\.\d+\.\d+/ : /\[nema\] daemon connected to /;
    const output = await waitForOutput(child, pattern, timeoutMs);
    if (options.expectSkew && output.includes('[nema] daemon connected to ')) throw new Error(`skewed daemon was welcomed:\n${output}`);
    if (!options.expectSkew && /run: npm i -g @nema-project\/nema@/.test(output)) throw new Error(`matching daemon was rejected:\n${output}`);
    return { root, output };
  } finally {
    await stop(child);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokePack(parseSmokeArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
