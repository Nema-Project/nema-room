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
exec "$root/python/bin/python3.11" -m graphify "$@"
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

/**
 * Drop what running graphify never loads: debug symbols, the installers (pip, setuptools, ensurepip) and
 * Tcl/Tk with its Python bindings and demos. On win32-x64 this was ~115MB of the ~290MB Python tree.
 */
export async function prunePythonRuntime(pythonRoot, platform) {
  const removed = [];
  const remove = async (target) => {
    if (!await lstat(target).catch(() => null)) return;
    await rm(target, { recursive: true, force: true });
    removed.push(path.relative(pythonRoot, target).split(path.sep).join('/'));
  };
  const removeMatching = async (dir, pattern) => {
    for (const name of await readdir(dir).catch(() => [])) if (pattern.test(name)) await remove(path.join(dir, name));
  };
  const windows = platform === 'win32';
  const lib = windows ? path.join(pythonRoot, 'Lib') : path.join(pythonRoot, 'lib', (await readdir(path.join(pythonRoot, 'lib'))).find((name) => /^python3\.\d+$/.test(name)) ?? 'python3');
  for (const name of ['ensurepip', 'idlelib', 'tkinter', 'turtledemo', 'turtle.py']) await remove(path.join(lib, name));
  await removeMatching(path.join(lib, 'site-packages'), /^(pip|setuptools)(-[^/]+\.dist-info)?$|^_distutils_hack$|^distutils-precedence\.pth$/);
  if (windows) {
    async function walk(dir) {
      for (const name of await readdir(dir)) {
        const current = path.join(dir, name);
        if ((await lstat(current)).isDirectory()) await walk(current);
        else if (name.toLowerCase().endsWith('.pdb')) await remove(current);
      }
    }
    await walk(pythonRoot);
    await remove(path.join(pythonRoot, 'tcl'));
    await removeMatching(path.join(pythonRoot, 'DLLs'), /^(_tkinter\.pyd|tcl\d+t\.dll|tk\d+t\.dll)$/i);
  } else {
    await removeMatching(path.join(pythonRoot, 'lib'), /^(tcl\d.*|tk\d.*|itcl\d.*|thread\d.*|libtcl.*\.dylib|libtk.*\.dylib)$/);
    await removeMatching(path.join(lib, 'lib-dynload'), /^_tkinter\./);
  }
  return removed;
}

const MACHO_LOAD = new Set([0x0c, 0x80000018, 0x8000001f, 0x80000023]);

function readMachONames(buffer, offset, end) {
  if (end - offset < 8) return [];
  const magicLe = buffer.readUInt32LE(offset);
  const magicBe = buffer.readUInt32BE(offset);
  if (magicBe === 0xcafebabe || magicBe === 0xbebafeca) {
    const be = magicBe === 0xcafebabe;
    const read32 = (at) => (be ? buffer.readUInt32BE(at) : buffer.readUInt32LE(at));
    const count = read32(offset + 4);
    if (count > 16) throw new Error('Unparseable Mach-O');
    const names = [];
    for (let index = 0; index < count; index += 1) {
      const arch = offset + 8 + index * 20;
      if (arch + 20 > end) throw new Error('Unparseable Mach-O');
      const sliceOffset = read32(arch + 8);
      const sliceSize = read32(arch + 12);
      if (sliceSize < 8 || sliceOffset + sliceSize > buffer.length) throw new Error('Unparseable Mach-O');
      names.push(...readMachONames(buffer, sliceOffset, sliceOffset + sliceSize));
    }
    return names;
  }
  const swapped = magicLe === 0xcffaedfe || magicLe === 0xcefaedfe;
  const is64 = magicLe === 0xfeedfacf || magicLe === 0xcffaedfe;
  const is32 = magicLe === 0xfeedface || magicLe === 0xcefaedfe;
  if (!is64 && !is32) return [];
  const read32 = (at) => (swapped ? buffer.readUInt32BE(at) : buffer.readUInt32LE(at));
  const headerSize = is64 ? 32 : 28;
  if (offset + headerSize > end) throw new Error('Unparseable Mach-O');
  const ncmds = read32(offset + 16);
  if (ncmds > 4096) throw new Error('Unparseable Mach-O');
  let cursor = offset + headerSize;
  const names = [];
  for (let index = 0; index < ncmds; index += 1) {
    if (cursor + 8 > end) throw new Error('Unparseable Mach-O');
    const cmd = read32(cursor);
    const cmdsize = read32(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > end) throw new Error('Unparseable Mach-O');
    if (MACHO_LOAD.has(cmd)) {
      if (cmdsize < 24) throw new Error('Unparseable Mach-O');
      const nameOffset = read32(cursor + 8);
      const start = cursor + nameOffset;
      if (nameOffset < 24 || start >= cursor + cmdsize) throw new Error('Unparseable Mach-O');
      const zero = buffer.indexOf(0, start);
      if (zero < 0 || zero >= cursor + cmdsize) throw new Error('Unparseable Mach-O');
      names.push(buffer.toString('utf8', start, zero));
    }
    cursor += cmdsize;
  }
  return names;
}

/** Dylib names from LC_LOAD* commands. LC_ID_DYLIB is not a load of itself. */
export function machoLoadNames(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return [];
  return readMachONames(buffer, 0, buffer.length);
}

/** Drop byte-identical python and python3 copies. The payload cannot keep them as symlinks. */
export async function dedupePythonInterpreters(pythonRoot) {
  const canonical = path.join(pythonRoot, 'bin', 'python3.11');
  const info = await lstat(canonical).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return [];
  const canonicalBytes = await readFile(canonical);
  const removed = [];
  for (const name of ['python', 'python3']) {
    const file = path.join(pythonRoot, 'bin', name);
    const current = await lstat(file).catch(() => null);
    if (!current) continue;
    if (!current.isFile() || current.isSymbolicLink()) throw new Error(`Refusing to drop ${name}: only a regular file that copies python3.11 can be removed`);
    const bytes = await readFile(file);
    if (bytes.length !== canonicalBytes.length || !bytes.equals(canonicalBytes)) throw new Error(`Refusing to drop ${name}: it is not a byte copy of python3.11`);
    await rm(file);
    removed.push(name);
  }
  return removed;
}

/**
 * Delete lib/libpython3.11.dylib when nothing loads it.
 * An unreadable Mach-O keeps the library. Windows has no such file and is unchanged.
 */
export async function removeUnreferencedLibpython(pythonRoot) {
  const dylib = path.join(pythonRoot, 'lib', 'libpython3.11.dylib');
  const info = await lstat(dylib).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  let referenced = false;
  async function walk(dir) {
    if (referenced) return;
    for (const name of await readdir(dir)) {
      if (referenced) return;
      const current = path.join(dir, name);
      if (current === dylib) continue;
      const currentInfo = await lstat(current);
      if (currentInfo.isSymbolicLink()) throw new Error(`Graphify payload still contains a symlink: ${current}`);
      if (currentInfo.isDirectory()) {
        await walk(current);
        continue;
      }
      if (!currentInfo.isFile()) continue;
      if (name !== 'python3.11' && !name.endsWith('.so') && !name.endsWith('.dylib')) continue;
      let names;
      try { names = machoLoadNames(await readFile(current)); }
      catch { referenced = true; return; }
      if (names.some((item) => item.includes('libpython3.11'))) referenced = true;
    }
  }
  await walk(pythonRoot);
  if (referenced) return false;
  await rm(dylib);
  return true;
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
  if (platform !== 'win32') await dedupePythonInterpreters(pythonRoot);
  const pythonExe = platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', 'python3.11');
  const pythonInfo = await lstat(pythonExe).catch(() => null);
  if (!pythonInfo?.isFile() || pythonInfo.isSymbolicLink()) throw new Error('Bundled CPython layout is missing its Python executable');
  const packages = await sitePackages(pythonRoot);
  await installWheels(pin, packages, cacheDir, fetchImpl);
  await prunePythonRuntime(pythonRoot, platform);
  if (platform === 'darwin') await removeUnreferencedLibpython(pythonRoot);
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
