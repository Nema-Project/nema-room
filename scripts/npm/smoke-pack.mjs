import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

export async function bumpInstalledPackage(installDir) {
  const file = path.join(installDir, 'node_modules', 'nema', 'package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.version = bumpPatch(pkg.version);
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
  return pkg.version;
}

function runNode(entry, args, cwd) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${entry} failed`);
  return result.stdout;
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
  const npm = setupCommand('npm', ['install', '--ignore-scripts', '--no-fund', '--no-audit', path.resolve(options.tarball)]);
  const installed = spawnSync(npm.bin, npm.args, { cwd: root, encoding: 'utf8' });
  if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout || installed.error?.message || 'npm install failed');
  const entry = path.join(root, 'node_modules', 'nema', 'dist', 'index.js');
  const printed = runNode(entry, ['--version'], root);
  if (!options.expectSkew) assertVersion(printed, expected);
  process.stdout.write(`nema --version ${printed.trim()}\n`);
  const installJs = path.join(root, 'node_modules', 'nema', 'dist', 'report', 'install.js');
  const skill = fileURLToPath(new URL('../../src/report/SKILL.md', pathToFileURL(installJs)));
  await readFile(skill, 'utf8');
  if (options.expectSkew) await bumpInstalledPackage(root);
  if (!options.hubUrl) return { root, version: printed.trim() };
  const child = spawn(process.execPath, [entry, 'daemon', '--hub', options.hubUrl, '--token-file', options.tokenFile], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const pattern = options.expectSkew ? /run: npm i -g nema@\d+\.\d+\.\d+/ : /\[nema\] daemon connected to /;
    const output = await waitForOutput(child, pattern, timeoutMs);
    if (options.expectSkew && output.includes('[nema] daemon connected to ')) throw new Error(`skewed daemon was welcomed:\n${output}`);
    if (!options.expectSkew && /run: npm i -g nema@/.test(output)) throw new Error(`matching daemon was rejected:\n${output}`);
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
