import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified, extractArchive } from './fetch-tools.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const lockPath = path.join(scriptDir, 'graphify-lock.json');
export const graphifyLock = JSON.parse(await readFile(lockPath, 'utf8').then((text) => text.replace(/^\uFEFF/, '')));

/** POSIX launcher. The Python path is relative to this file, never a developer install. */
export const POSIX_GRAPHIFY_LAUNCHER = `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec "$root/python/bin/python3" -m graphify "$@"
`;

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

async function resolveLink(linkPath, root) {
  let current = linkPath;
  for (let hop = 0; hop < 8; hop++) {
    const info = await lstat(current);
    if (!info.isSymbolicLink()) return current;
    const link = await readlink(current);
    if (!link || path.isAbsolute(link) || link.includes('\\') || /^[A-Za-z]:/.test(link)) throw new Error(`Unsafe Graphify archive symlink: ${current}`);
    const next = path.resolve(path.dirname(current), link);
    if (!inside(root, next)) throw new Error(`Graphify archive symlink escapes the payload: ${current}`);
    current = next;
  }
  throw new Error(`Graphify archive symlink chain is too long: ${linkPath}`);
}

/** Replace in-tree symlinks with file copies so the payload stays relocatable and link-free. */
export async function materializeSymlinks(root) {
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const current = path.join(dir, name);
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        const target = await resolveLink(current, root);
        const targetInfo = await lstat(target);
        if (targetInfo.isDirectory()) throw new Error(`Graphify archive directory symlink is not supported: ${current}`);
        await rm(current);
        await copyFile(target, current);
        if (process.platform !== 'win32') await chmod(current, targetInfo.mode & 0o777);
        continue;
      }
      if (info.isDirectory()) await walk(current);
      else if (!info.isFile()) throw new Error(`Graphify archive contains an unsupported entry: ${current}`);
    }
  }
  await walk(root);
}

const machineHomes = () => [...new Set([os.homedir(), os.homedir().replaceAll('\\', '/')].filter((value) => value && value.length >= 3))];
const homeNeedles = (homes) => homes.flatMap((home) => [Buffer.from(home), Buffer.from(home, 'utf16le')]);
const sha256 = (body) => createHash('sha256').update(body).digest('hex');

async function walkPayload(directory, visit) {
  async function walk(dir) {
    for (const name of await readdir(dir)) {
      const current = path.join(dir, name);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Graphify payload still contains a symlink: ${current}`);
      if (info.isDirectory()) {
        await walk(current);
        continue;
      }
      if (!info.isFile()) throw new Error(`Graphify payload contains an unsupported file: ${current}`);
      await visit(current, await readFile(current));
    }
  }
  await walk(directory);
}

/**
 * Files that already hold a home path straight out of the pinned archives, keyed by relative path with their digest.
 * Wheels built on GitHub runners embed that runner's home, which is our home on CI too.
 */
export async function homePathFiles(directory, homes = machineHomes()) {
  const needles = homeNeedles(homes);
  const found = new Map();
  await walkPayload(directory, (current, body) => {
    if (needles.some((needle) => body.includes(needle))) found.set(path.relative(directory, current), sha256(body));
  });
  return found;
}

/** Reject a home path anywhere except an unchanged upstream file, and a uv tool path anywhere. */
export async function rejectMachinePaths(directory, upstream = new Map(), homes = machineHomes()) {
  const needles = homeNeedles(homes);
  const uvPaths = [Buffer.from('uv\\tools\\graphifyy'), Buffer.from('uv/tools/graphifyy')];
  await walkPayload(directory, (current, body) => {
    if (needles.some((needle) => body.includes(needle)) && upstream.get(path.relative(directory, current)) !== sha256(body)) {
      throw new Error(`Graphify payload contains this machine's home path: ${current}`);
    }
    if (uvPaths.some((needle) => body.includes(needle))) throw new Error(`Graphify payload contains a uv tool path: ${current}`);
  });
}

/** CPython's license sits at the root on Windows and under lib/python3.x on Unix install_only builds. */
export async function pythonLicensePath(pythonRoot) {
  const candidates = [path.join(pythonRoot, 'LICENSE.txt')];
  const lib = await readdir(path.join(pythonRoot, 'lib')).catch((error) => { if (error.code !== 'ENOENT') throw error; return []; });
  for (const name of lib.filter((entry) => /^python3\.\d+$/.test(entry))) candidates.push(path.join(pythonRoot, 'lib', name, 'LICENSE.txt'));
  for (const candidate of candidates) {
    const info = await lstat(candidate).catch(() => null);
    if (info?.isFile()) return candidate;
  }
  throw new Error('Bundled CPython LICENSE.txt is missing');
}

async function sitePackages(pythonRoot) {
  const windows = path.join(pythonRoot, 'Lib', 'site-packages');
  try {
    const info = await lstat(windows);
    if (info.isDirectory() && !info.isSymbolicLink()) return windows;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const entries = await readdir(path.join(pythonRoot, 'lib'));
  const version = entries.find((name) => /^python3\.\d+$/.test(name));
  if (!version) throw new Error('Bundled CPython has no site-packages directory');
  const dir = path.join(pythonRoot, 'lib', version, 'site-packages');
  await mkdir(dir, { recursive: true });
  return dir;
}

async function installWheels(pin, sitePackagesDir, cacheDir, fetchImpl) {
  const scratch = path.join(sitePackagesDir, '..', '..', '.graphify-wheels');
  await mkdir(scratch, { recursive: true });
  try {
    for (const wheel of pin.wheels) {
      const archive = await downloadVerified(wheel, cacheDir, fetchImpl);
      const extracted = path.join(scratch, wheel.file);
      await extractArchive(await readFile(archive), 'zip', extracted);
      for (const entry of await readdir(extracted)) {
        if (entry.endsWith('.data')) throw new Error(`Wheel ${wheel.file} uses a .data layout this installer does not unpack`);
        const target = path.join(sitePackagesDir, entry);
        if (await lstat(target).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; })) throw new Error(`Wheel overwrites an existing file: ${entry}`);
        await renameAcross(path.join(extracted, entry), target);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function renameAcross(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await cp(source, target, { recursive: true, errorOnExist: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
}

function compileWindowsLauncher(sourceRoot, output) {
  const compiler = process.env.NEMA_WINDOWS_NATIVE_CC ?? 'clang';
  const source = path.join(sourceRoot, 'scripts', 'desktop', 'graphify-launcher.c');
  const result = spawnSync(compiler, ['-Wall', '-Wextra', '-Werror', '-municode', '-O2', source, '-o', output], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`Could not start Windows native compiler ${compiler}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Graphify launcher compiler failed with status ${result.status ?? result.signal}`);
}

/**
 * Download the pinned CPython and graphifyy wheels into `destination`.
 * Linux is not a desktop release target, so it leaves the directory untouched.
 * ponytail: the pin covers win32-x64 and darwin-arm64 only; add a lock target before staging those elsewhere.
 */
export async function fetchGraphify({ platform, arch, destination, cacheDir, sourceRoot, fetchImpl = fetch } = {}) {
  const key = `${platform}-${arch}`;
  const pin = graphifyLock.targets[key];
  if (!pin) {
    if (platform === 'linux') return null;
    throw new Error(`No pinned Graphify runtime for ${key}`);
  }
  if (!destination || !cacheDir || !sourceRoot) throw new Error('Graphify staging needs a destination, cache, and source root');
  destination = path.resolve(destination);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) throw new Error(`Graphify destination is not empty: ${destination}`);
  const pythonArchive = await downloadVerified(pin.python, cacheDir, fetchImpl);
  await extractArchive(await readFile(pythonArchive), pin.python.format, destination);
  await materializeSymlinks(destination);
  const pythonRoot = path.join(destination, 'python');
  const pythonExe = platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', 'python3');
  const pythonInfo = await lstat(pythonExe).catch(() => null);
  if (!pythonInfo?.isFile() || pythonInfo.isSymbolicLink()) throw new Error('Bundled CPython layout is missing its Python executable');
  const packages = await sitePackages(pythonRoot);
  await installWheels(pin, packages, cacheDir, fetchImpl);
  const upstream = await homePathFiles(destination);
  const distInfo = (await readdir(packages)).find((name) => name.startsWith('graphifyy-') && name.endsWith('.dist-info'));
  if (!distInfo) throw new Error('graphifyy license metadata is missing');
  await cp(path.join(packages, distInfo, 'licenses'), path.join(destination, 'licenses', 'graphify'), { recursive: true });
  for (const name of ['LICENSE', 'LICENSE-MIT', 'NOTICE']) {
    const license = path.join(destination, 'licenses', 'graphify', name);
    const info = await lstat(license).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`graphifyy ${name} is missing`);
  }
  await mkdir(path.join(destination, 'licenses', 'python'), { recursive: true });
  await copyFile(await pythonLicensePath(pythonRoot), path.join(destination, 'licenses', 'python', 'LICENSE.txt'));
  if (platform === 'win32') compileWindowsLauncher(sourceRoot, path.join(destination, 'graphify.exe'));
  else {
    const launcher = path.join(destination, 'graphify');
    await writeFile(launcher, POSIX_GRAPHIFY_LAUNCHER, { flag: 'wx', mode: 0o755 });
    await chmod(launcher, 0o755);
  }
  await rejectMachinePaths(destination, upstream);
  return destination;
}
