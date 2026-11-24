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

/** Every lock target, in the order the lock file lists them. Linux targets serve npm/Compose hosts only. */
export const GRAPHIFY_LOCK_TARGETS = ['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'];

/**
 * Canonical JSON for the lock-hash: object keys sorted by UTF-16 code unit, arrays kept in order, no
 * whitespace, values as JSON.stringify writes them. apps/cli/src/components/lock.ts must produce the
 * same bytes; both sides assert the vectors in scripts/desktop/fixtures/lock-hash-vectors.json.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'boolean' || value === null) return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  throw new Error(`Value cannot be part of a lock-hash: ${String(value)}`);
}

/** `<lock-hash>`: sha256 hex of the canonical JSON of one target's python entry and wheels array. */
export function graphifyLockHash(pin) {
  return createHash('sha256').update(canonicalJson({ python: pin.python, wheels: pin.wheels })).digest('hex');
}

/**
 * The POSIX interpreter name for a lock `python` version: `3.14.10` -> `python3.14`. Anything but a plain
 * `3.<minor>.<patch>` throws; there is no fallback name. Must agree with `pythonInterpreterName` in
 * apps/cli/src/components/lock.ts; a test keeps them equal.
 */
export function pythonInterpreterName(version) {
  const match = typeof version === 'string' ? /^3\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version) : null;
  if (!match) throw new Error(`Graphify lock has a malformed python version: ${JSON.stringify(version)}`);
  return `python3.${match[1]}`;
}

/** The interpreter name of the lock this script ships with, e.g. `python3.14`. */
export const GRAPHIFY_PYTHON_INTERPRETER = pythonInterpreterName(graphifyLock.python);

/** POSIX launcher for `interpreter`. The Python path is relative to this file, never a developer install. */
export function posixGraphifyLauncher(interpreter) {
  return `#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
exec "$root/python/bin/${interpreter}" -m graphify "$@"
`;
}

/** The POSIX launcher for the shipped lock's interpreter. */
export const POSIX_GRAPHIFY_LAUNCHER = posixGraphifyLauncher(GRAPHIFY_PYTHON_INTERPRETER);

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

/** Drop python and python3 copies byte-identical to `interpreter`. The payload cannot keep them as symlinks. */
export async function dedupePythonInterpreters(pythonRoot, interpreter = GRAPHIFY_PYTHON_INTERPRETER) {
  const canonical = path.join(pythonRoot, 'bin', interpreter);
  const info = await lstat(canonical).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return [];
  const canonicalBytes = await readFile(canonical);
  const removed = [];
  for (const name of ['python', 'python3']) {
    const file = path.join(pythonRoot, 'bin', name);
    const current = await lstat(file).catch(() => null);
    if (!current) continue;
    if (!current.isFile() || current.isSymbolicLink()) throw new Error(`Refusing to drop ${name}: only a regular file that copies ${interpreter} can be removed`);
    const bytes = await readFile(file);
    if (bytes.length !== canonicalBytes.length || !bytes.equals(canonicalBytes)) throw new Error(`Refusing to drop ${name}: it is not a byte copy of ${interpreter}`);
    await rm(file);
    removed.push(name);
  }
  return removed;
}

/**
 * Delete lib/lib<interpreter>.dylib (e.g. libpython3.14.dylib) when nothing loads it.
 * An unreadable Mach-O keeps the library. Windows has no such file and is unchanged.
 */
export async function removeUnreferencedLibpython(pythonRoot, interpreter = GRAPHIFY_PYTHON_INTERPRETER) {
  const library = `lib${interpreter}`;
  const dylib = path.join(pythonRoot, 'lib', `${library}.dylib`);
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
      if (name !== interpreter && !name.endsWith('.so') && !name.endsWith('.dylib')) continue;
      let names;
      try { names = machoLoadNames(await readFile(current)); }
      catch { referenced = true; return; }
      if (names.some((item) => item.includes(library))) referenced = true;
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
 * Build the Windows Graphify launcher (a KB-scale Nema binary, not part of any upstream archive) at `output`.
 * Desktop staging ships it beside the CLI's Graphify lock; the component installer copies it into each
 * installed version, so a user's machine never needs a compiler.
 */
export async function buildGraphifyLauncher({ sourceRoot, output }) {
  if (!sourceRoot || !output) throw new Error('The Graphify launcher build needs a source root and an output path');
  await mkdir(path.dirname(output), { recursive: true });
  compileWindowsLauncher(sourceRoot, output);
  return output;
}

/**
 * Download the pinned CPython and graphifyy wheels into `destination`.
 * Desktop staging no longer calls this: Graphify is an on-demand component installed through
 * apps/cli/src/components, and the payload carries only its lock and the Windows launcher. It stays for
 * lock making, size recording and component packs.
 * Linux is not a desktop release target, so it leaves the directory untouched. The lock's Linux targets
 * exist for the npm/Compose host daemon, which installs them through apps/cli/src/components.
 */
export async function fetchGraphify({ platform, arch, destination, cacheDir, sourceRoot, fetchImpl = fetch } = {}) {
  const key = `${platform}-${arch}`;
  if (platform === 'linux') return null;
  const pin = graphifyLock.targets[key];
  if (!pin) throw new Error(`No pinned Graphify runtime for ${key}`);
  if (!destination || !cacheDir || !sourceRoot) throw new Error('Graphify staging needs a destination, cache, and source root');
  destination = path.resolve(destination);
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) throw new Error(`Graphify destination is not empty: ${destination}`);
  const pythonArchive = await downloadVerified(pin.python, cacheDir, fetchImpl);
  await extractArchive(await readFile(pythonArchive), pin.python.format, destination);
  await materializeSymlinks(destination);
  const pythonRoot = path.join(destination, 'python');
  if (platform !== 'win32') await dedupePythonInterpreters(pythonRoot);
  const pythonExe = platform === 'win32' ? path.join(pythonRoot, 'python.exe') : path.join(pythonRoot, 'bin', GRAPHIFY_PYTHON_INTERPRETER);
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

const LINUX_BUILDS = {
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', machine: 'x86_64' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', machine: 'aarch64' },
};

/** `{name}-{version}(-{build})?-{python}-{abi}-{platform}.whl`, the wheel file name convention. */
export function parseWheelName(file) {
  if (!file.endsWith('.whl')) throw new Error(`Not a wheel: ${file}`);
  const parts = file.slice(0, -4).split('-');
  if (parts.length !== 5 && parts.length !== 6) throw new Error(`Unparseable wheel name: ${file}`);
  const [name, version] = parts;
  const [python, abi, platform] = parts.slice(-3);
  return { name, version, python, abi, platform };
}

/** Lowest glibc a manylinux platform tag needs on `machine`, as [major, minor]; null for any other tag (musllinux included). */
export function manylinuxGlibc(tag, machine) {
  const modern = new RegExp(`^manylinux_(\\d+)_(\\d+)_${machine}$`).exec(tag);
  if (modern) return [Number(modern[1]), Number(modern[2])];
  const legacy = { manylinux1: [2, 5], manylinux2010: [2, 12], manylinux2014: [2, 17] };
  const old = new RegExp(`^(manylinux1|manylinux2010|manylinux2014)_${machine}$`).exec(tag);
  return old ? legacy[old[1]] : null;
}

const compareGlibc = (a, b) => a[0] - b[0] || a[1] - b[1];

/**
 * The glibc wheel for `machine` with the same name, version, python and abi tags as `template`.
 * Among several, the one that needs the oldest glibc, so the lock runs on the widest set of hosts.
 */
export function pickManylinuxWheel(template, releaseFiles, machine) {
  const want = parseWheelName(template);
  const candidates = [];
  for (const entry of releaseFiles) {
    if (entry.packagetype !== undefined && entry.packagetype !== 'bdist_wheel') continue;
    if (!entry.filename?.endsWith('.whl')) continue;
    const got = parseWheelName(entry.filename);
    if (got.version !== want.version || got.python !== want.python || got.abi !== want.abi) continue;
    if (got.name.toLowerCase() !== want.name.toLowerCase()) continue;
    const tags = got.platform.split('.');
    if (tags.some((tag) => tag.startsWith('musllinux'))) continue;
    const glibc = tags.map((tag) => manylinuxGlibc(tag, machine)).filter(Boolean).sort(compareGlibc)[0];
    if (glibc) candidates.push({ entry, glibc });
  }
  candidates.sort((a, b) => compareGlibc(a.glibc, b.glibc) || a.entry.filename.localeCompare(b.entry.filename));
  if (!candidates.length) throw new Error(`No manylinux ${machine} wheel matches ${template}`);
  return candidates[0].entry;
}

async function fetchOk(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return response;
}

/**
 * Real bytes for one lock file, cached by file name under `cacheDir`. Returns the digest and length
 * of what was actually downloaded; nothing here is taken from an index or typed in.
 */
async function measure(file, url, cacheDir, fetchImpl) {
  const cached = path.join(cacheDir, file);
  let bytes = await readFile(cached).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
  if (!bytes) {
    bytes = Buffer.from(await (await fetchOk(url, fetchImpl)).arrayBuffer());
    await mkdir(cacheDir, { recursive: true });
    await writeFile(`${cached}.partial`, bytes);
    await rename(`${cached}.partial`, cached);
  }
  return { sha256: sha256(bytes), size: bytes.length };
}

/**
 * Regenerate the lock: every existing pin is downloaded again, must still hash to its pinned sha256,
 * and gains `size` from the downloaded bytes; the Linux targets are pinned from the same CPython
 * release and the manylinux variants of the win32-x64 wheel set. Throws on any disagreement.
 */
export async function refreshGraphifyLock({ lock = graphifyLock, cacheDir, fetchImpl = fetch, pypiBase = 'https://pypi.org', log = () => {} } = {}) {
  if (!cacheDir) throw new Error('refreshGraphifyLock needs a cacheDir');
  const pinned = async (entry) => {
    const actual = await measure(entry.file, entry.url, cacheDir, fetchImpl);
    if (entry.sha256 && actual.sha256 !== entry.sha256) {
      // Bytes that failed verification never stay in the cache: a later run would keep
      // re-reading them as the download for this file.
      await rm(path.join(cacheDir, entry.file), { force: true });
      throw new Error(`${entry.file}: downloaded sha256 ${actual.sha256} does not match the pin ${entry.sha256}`);
    }
    log(`${entry.file} ${actual.size}`);
    return actual;
  };
  const withSize = (entry, actual) => {
    const { file, url, sha256: hash, size: _old, ...rest } = entry;
    return { file, url, sha256: hash ?? actual.sha256, size: actual.size, ...rest };
  };
  const targets = {};
  for (const key of ['win32-x64', 'darwin-arm64']) {
    const pin = lock.targets[key];
    if (!pin) throw new Error(`The lock has no ${key} target to refresh`);
    const python = withSize(pin.python, await pinned(pin.python));
    const wheels = [];
    for (const wheel of pin.wheels) wheels.push(withSize(wheel, await pinned(wheel)));
    targets[key] = { python, wheels };
  }
  // Linux targets the lock already has are refreshed exactly like the two above:
  // re-downloaded and required to hash to their pins. Only a target the lock does not
  // have yet is derived from upstream below, so a refresh can never silently move an
  // existing Linux pin.
  for (const key of Object.keys(LINUX_BUILDS)) {
    const pin = lock.targets[key];
    if (!pin) continue;
    const python = withSize(pin.python, await pinned(pin.python));
    const wheels = [];
    for (const wheel of pin.wheels) wheels.push(withSize(wheel, await pinned(wheel)));
    targets[key] = { python, wheels };
  }

  const sumsUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.cpythonRelease}/SHA256SUMS`;
  const upstreamSums = new Map();
  for (const line of (await (await fetchOk(sumsUrl, fetchImpl)).text()).split('\n')) {
    const match = /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (match) upstreamSums.set(match[2], match[1]);
  }
  const template = targets['win32-x64'].wheels;
  const releases = new Map();
  for (const [key, { triple, machine }] of Object.entries(LINUX_BUILDS)) {
    if (targets[key]) continue; // Already pinned in the lock; refreshed above.
    const file = `cpython-${lock.python}+${lock.cpythonRelease}-${triple}-install_only.tar.gz`;
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.cpythonRelease}/${file.replace('+', '%2B')}`;
    const actual = await pinned({ file, url });
    if (upstreamSums.get(file) !== actual.sha256) {
      await rm(path.join(cacheDir, file), { force: true });
      throw new Error(`${file}: downloaded sha256 ${actual.sha256} disagrees with upstream SHA256SUMS (${upstreamSums.get(file) ?? 'not listed'})`);
    }
    const python = { file, url, sha256: actual.sha256, size: actual.size, format: 'tar.gz' };
    const wheels = [];
    for (const wheel of template) {
      const parsed = parseWheelName(wheel.file);
      if (parsed.platform === 'any') {
        wheels.push(wheel);
        continue;
      }
      const project = `${parsed.name.replaceAll('_', '-').toLowerCase()}/${parsed.version}`;
      if (!releases.has(project)) {
        releases.set(project, (await (await fetchOk(`${pypiBase}/pypi/${project}/json`, fetchImpl)).json()).urls ?? []);
      }
      const chosen = pickManylinuxWheel(wheel.file, releases.get(project), machine);
      const measured = await pinned({ file: chosen.filename, url: chosen.url });
      if (chosen.digests?.sha256 !== measured.sha256) {
        await rm(path.join(cacheDir, chosen.filename), { force: true });
        throw new Error(`${chosen.filename}: downloaded sha256 disagrees with the PyPI index`);
      }
      if (chosen.size !== undefined && chosen.size !== measured.size) {
        await rm(path.join(cacheDir, chosen.filename), { force: true });
        throw new Error(`${chosen.filename}: downloaded size disagrees with the PyPI index`);
      }
      wheels.push({ file: chosen.filename, url: chosen.url, sha256: measured.sha256, size: measured.size });
    }
    targets[key] = { python, wheels };
  }
  return { ...lock, targets };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'refresh-lock') {
  const cacheIndex = process.argv.indexOf('--cache');
  const cacheDir = cacheIndex > 0 ? path.resolve(process.argv[cacheIndex + 1]) : path.join(os.tmpdir(), 'nema-graphify-lock-cache');
  refreshGraphifyLock({ cacheDir, log: (line) => process.stdout.write(`${line}\n`) })
    .then((next) => writeFile(lockPath, `${JSON.stringify(next, null, 2)}\n`))
    .then(() => process.stdout.write(`wrote ${lockPath}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
