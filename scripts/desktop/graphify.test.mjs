import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { canonicalJson, dedupePythonInterpreters, fetchGraphify, GRAPHIFY_LOCK_TARGETS, graphifyLock, graphifyLockHash, homePathFiles, machoLoadNames, manylinuxGlibc, materializeSymlinks, parseWheelName, pickManylinuxWheel, POSIX_GRAPHIFY_LAUNCHER, prunePythonRuntime, pythonLicensePath, refreshGraphifyLock, rejectMachinePaths, removeUnreferencedLibpython } from './fetch-graphify.mjs';
import { downloadVerified } from './fetch-tools.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const KEPT_PREFIXES = ['graphifyy-', 'networkx-', 'numpy-', 'pyyaml-', 'rapidfuzz-', 'tree_sitter-', 'tree_sitter_bash-', 'tree_sitter_c-', 'tree_sitter_c_sharp-', 'tree_sitter_cpp-', 'tree_sitter_go-', 'tree_sitter_java-', 'tree_sitter_javascript-', 'tree_sitter_json-', 'tree_sitter_kotlin-', 'tree_sitter_php-', 'tree_sitter_python-', 'tree_sitter_ruby-', 'tree_sitter_rust-', 'tree_sitter_swift-', 'tree_sitter_typescript-'];
const DROPPED_PREFIXES = ['tree_sitter_elixir-', 'tree_sitter_fortran-', 'tree_sitter_groovy-', 'tree_sitter_julia-', 'tree_sitter_lua-', 'tree_sitter_objc-', 'tree_sitter_powershell-', 'tree_sitter_scala-', 'tree_sitter_verilog-', 'tree_sitter_zig-'];
const PYTHON_TRIPLES = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

test('graphify lock pins the four targets and no install path', async () => {
  const raw = await readFile(path.join(scriptDir, 'graphify-lock.json'), 'utf8');
  assert.equal(raw.includes('Users'), false);
  assert.equal(raw.includes('AppData'), false);
  assert.equal(graphifyLock.graphifyy, '0.9.95');
  assert.equal(graphifyLock.python, '3.14.10');
  assert.equal(graphifyLock.cpythonRelease, '20261123');
  assert.equal(graphifyLock.extras.length, 0);
  assert.equal(graphifyLock.sourceCorrespondence.status, 'pending-task-7c');
  assert.deepEqual(Object.keys(graphifyLock.targets), GRAPHIFY_LOCK_TARGETS);
  for (const key of GRAPHIFY_LOCK_TARGETS) {
    const pin = graphifyLock.targets[key];
    assert.ok(pin, key);
    assert.equal(pin.wheels.length, 21, key);
    const files = pin.wheels.map((wheel) => wheel.file);
    for (const prefix of KEPT_PREFIXES) assert.equal(files.some((file) => file.startsWith(prefix)), true, `${key} ${prefix}`);
    for (const prefix of DROPPED_PREFIXES) assert.equal(files.some((file) => file.startsWith(prefix)), false, `${key} ${prefix}`);
    assert.equal(pin.python.format, 'tar.gz');
    assert.equal(pin.python.file, `cpython-3.14.10+20261123-${PYTHON_TRIPLES[key]}-install_only.tar.gz`, key);
    assert.match(pin.python.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/20261123\//);
    assert.match(pin.python.sha256, /^[a-f0-9]{64}$/);
    for (const wheel of pin.wheels) {
      assert.match(wheel.url, /^https:\/\/files\.pythonhosted\.org\/packages\//);
      assert.match(wheel.sha256, /^[a-f0-9]{64}$/);
      assert.equal(wheel.url.endsWith(`/${wheel.file}`), true, wheel.file);
    }
  }
  assert.equal(graphifyLock.targets['win32-x64'].python.sha256, 'c2344c6f2c1e86852d5f747e5bb61f45315fd369547a75cc24f04efee5da55c1');
  assert.equal(graphifyLock.targets['darwin-arm64'].python.sha256, '167ad04069d3c43f087d995336e36b879ec2ad8dfcf99112c034350240d9ecdb');
});

test('every lock file entry records a positive integer size and target file names are unique', () => {
  for (const key of GRAPHIFY_LOCK_TARGETS) {
    const pin = graphifyLock.targets[key];
    assert.ok(pin, key);
    const entries = [pin.python, ...pin.wheels];
    for (const entry of entries) assert.equal(Number.isSafeInteger(entry.size) && entry.size > 0, true, `${key} ${entry.file} size ${entry.size}`);
    const names = entries.map((entry) => entry.file);
    assert.equal(new Set(names).size, names.length, key);
  }
});

test('Linux targets pin only glibc manylinux wheels for their machine, with the same wheel set as win32-x64', () => {
  const windows = graphifyLock.targets['win32-x64'].wheels.map((wheel) => parseWheelName(wheel.file));
  for (const [key, machine] of [['linux-x64', 'x86_64'], ['linux-arm64', 'aarch64']]) {
    const pin = graphifyLock.targets[key];
    assert.ok(pin, key);
    const wheels = pin.wheels.map((wheel) => parseWheelName(wheel.file));
    assert.deepEqual(wheels.map((wheel) => [wheel.name.toLowerCase(), wheel.version, wheel.python, wheel.abi]), windows.map((wheel) => [wheel.name.toLowerCase(), wheel.version, wheel.python, wheel.abi]), key);
    for (const wheel of wheels) {
      if (wheel.platform === 'any') continue;
      const tags = wheel.platform.split('.');
      assert.equal(tags.some((tag) => tag.startsWith('musllinux')), false, `${key} ${wheel.name}`);
      assert.equal(tags.some((tag) => manylinuxGlibc(tag, machine)), true, `${key} ${wheel.name} ${wheel.platform}`);
    }
  }
});

test('lock-hash matches the shared fixture vectors', async () => {
  const dir = path.join(scriptDir, 'fixtures', 'lock-hash');
  const { vectors } = JSON.parse(await readFile(path.join(dir, 'vectors.json'), 'utf8'));
  assert.ok(vectors.length >= 2);
  for (const vector of vectors) {
    const canonical = await readFile(path.join(dir, vector.canonical), 'utf8');
    assert.equal(canonicalJson({ python: vector.target.python, wheels: vector.target.wheels }), canonical, vector.name);
    assert.equal(sha256(canonical), vector.sha256, vector.name);
    assert.equal(graphifyLockHash(vector.target), vector.sha256, vector.name);
  }
  assert.throws(() => canonicalJson({ size: Number.NaN }), /lock-hash/);
  assert.throws(() => canonicalJson({ size: undefined }), /lock-hash/);
});

test('a download whose length differs from the pinned size is refused, cached or fresh', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-size-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('archive-bytes');
  const asset = { file: 'a.whl', url: 'https://example.invalid/a.whl', sha256: sha256(bytes), size: bytes.length + 1 };
  await assert.rejects(downloadVerified(asset, path.join(root, 'fresh'), async () => new Response(bytes)), /size mismatch/);
  await mkdir(path.join(root, 'cached'));
  await writeFile(path.join(root, 'cached', 'a.whl'), bytes);
  await assert.rejects(downloadVerified(asset, path.join(root, 'cached'), async () => new Response(bytes)), /size mismatch/);
  assert.equal(await downloadVerified({ ...asset, size: bytes.length }, path.join(root, 'cached'), async () => { throw new Error('no fetch'); }), path.join(root, 'cached', 'a.whl'));
});

test('manylinux selection takes the oldest glibc for the machine and never musl', () => {
  assert.deepEqual(manylinuxGlibc('manylinux_2_28_x86_64', 'x86_64'), [2, 28]);
  assert.deepEqual(manylinuxGlibc('manylinux2014_aarch64', 'aarch64'), [2, 17]);
  assert.equal(manylinuxGlibc('manylinux2014_aarch64', 'x86_64'), null);
  assert.equal(manylinuxGlibc('musllinux_1_2_x86_64', 'x86_64'), null);
  const files = [
    'numpy-2.4.6-cp314-cp314-musllinux_1_2_x86_64.whl',
    'numpy-2.4.6-cp314-cp314-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl',
    'numpy-2.4.6-cp314-cp314-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
    'numpy-2.4.6-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl',
    'numpy-2.4.6-cp314-cp314-manylinux_2_17_aarch64.manylinux2014_aarch64.whl',
  ].map((filename) => ({ filename, packagetype: 'bdist_wheel' }));
  assert.equal(pickManylinuxWheel('numpy-2.4.6-cp314-cp314-win_amd64.whl', files, 'x86_64').filename, 'numpy-2.4.6-cp314-cp314-manylinux_2_17_x86_64.manylinux2014_x86_64.whl');
  assert.equal(pickManylinuxWheel('numpy-2.4.6-cp314-cp314-win_amd64.whl', files, 'aarch64').filename, 'numpy-2.4.6-cp314-cp314-manylinux_2_17_aarch64.manylinux2014_aarch64.whl');
  assert.throws(() => pickManylinuxWheel('numpy-2.4.6-cp314-cp314-win_amd64.whl', files.slice(0, 1), 'x86_64'), /No manylinux/);
});

/** A fake upstream: CPython archives, SHA256SUMS, PyPI JSON and wheel bytes, all local. */
function fakeUpstream(overrides = {}) {
  const body = (name) => Buffer.from(`bytes of ${name}`);
  const pyFile = (triple) => `cpython-3.14.10+20261123-${triple}-install_only.tar.gz`;
  const files = new Map();
  const add = (url, name) => files.set(url, overrides[name] ?? body(name));
  const release = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261123';
  for (const triple of Object.values(PYTHON_TRIPLES)) add(`${release}/${pyFile(triple).replace('+', '%2B')}`, pyFile(triple));
  const linuxWheels = ['x86_64', 'aarch64'].map((machine) => `numpy-2.4.6-cp314-cp314-manylinux_2_17_${machine}.manylinux2014_${machine}.whl`);
  for (const name of ['graphifyy-0.9.95-py3-none-any.whl', 'numpy-2.4.6-cp314-cp314-win_amd64.whl', 'numpy-2.4.6-cp314-cp314-macosx_11_0_arm64.whl', ...linuxWheels]) {
    add(`https://files.pythonhosted.org/packages/x/${name}`, name);
  }
  const sums = Object.values(PYTHON_TRIPLES).map((triple) => `${sha256(body(pyFile(triple)))}  ${pyFile(triple)}`).join('\n');
  files.set(`${release}/SHA256SUMS`, Buffer.from(`${sums}\n`));
  files.set('https://pypi.org/pypi/numpy/2.4.6/json', Buffer.from(JSON.stringify({
    urls: [...linuxWheels, 'numpy-2.4.6-cp314-cp314-musllinux_1_2_x86_64.whl'].map((filename) => ({
      filename, packagetype: 'bdist_wheel', url: `https://files.pythonhosted.org/packages/x/${filename}`, size: body(filename).length, digests: { sha256: sha256(body(filename)) },
    })),
  })));
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    const bytes = files.get(url);
    return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
  };
  const entry = (url, name) => ({ file: name, url, sha256: sha256(body(name)) });
  const target = (triple, numpy) => ({
    python: { ...entry(`${release}/${pyFile(triple).replace('+', '%2B')}`, pyFile(triple)), format: 'tar.gz' },
    wheels: [entry('https://files.pythonhosted.org/packages/x/graphifyy-0.9.95-py3-none-any.whl', 'graphifyy-0.9.95-py3-none-any.whl'), entry(`https://files.pythonhosted.org/packages/x/${numpy}`, numpy)],
  });
  const lock = {
    schemaVersion: 1, graphifyy: '0.9.95', python: '3.14.10', cpythonRelease: '20261123', extras: [], sourceCorrespondence: { status: 'pending-task-7c' },
    targets: { 'win32-x64': target(PYTHON_TRIPLES['win32-x64'], 'numpy-2.4.6-cp314-cp314-win_amd64.whl'), 'darwin-arm64': target(PYTHON_TRIPLES['darwin-arm64'], 'numpy-2.4.6-cp314-cp314-macosx_11_0_arm64.whl') },
  };
  return { lock, fetchImpl, requested, body };
}

test('lock refresh records downloaded sizes and pins the Linux targets from a fake upstream', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = fakeUpstream();
  const next = await refreshGraphifyLock({ lock: upstream.lock, cacheDir: path.join(root, 'cache'), fetchImpl: upstream.fetchImpl });
  assert.deepEqual(Object.keys(next.targets), GRAPHIFY_LOCK_TARGETS);
  for (const key of GRAPHIFY_LOCK_TARGETS) {
    for (const entry of [next.targets[key].python, ...next.targets[key].wheels]) {
      assert.equal(entry.size, upstream.body(entry.file).length, `${key} ${entry.file}`);
      assert.equal(entry.sha256, sha256(upstream.body(entry.file)), `${key} ${entry.file}`);
    }
  }
  assert.deepEqual(Object.keys(next.targets['win32-x64'].python), ['file', 'url', 'sha256', 'size', 'format']);
  assert.equal(next.targets['linux-arm64'].wheels[1].file, 'numpy-2.4.6-cp314-cp314-manylinux_2_17_aarch64.manylinux2014_aarch64.whl');
  assert.equal(next.targets['linux-x64'].wheels[0].url, upstream.lock.targets['win32-x64'].wheels[0].url);
  assert.equal(upstream.requested.some((url) => url.includes('musllinux')), false);
});

test('lock refresh refuses an existing pin whose bytes changed upstream', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-refresh-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = fakeUpstream({ 'numpy-2.4.6-cp314-cp314-win_amd64.whl': Buffer.from('tampered') });
  await assert.rejects(refreshGraphifyLock({ lock: upstream.lock, cacheDir: path.join(root, 'cache'), fetchImpl: upstream.fetchImpl }), /does not match the pin/);
});

test('lock refresh validates existing Linux pins instead of re-deriving them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-refresh-linux-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const upstream = fakeUpstream();
  const first = await refreshGraphifyLock({ lock: upstream.lock, cacheDir: path.join(root, 'cache-1'), fetchImpl: upstream.fetchImpl });
  const linuxWheel = 'numpy-2.4.6-cp314-cp314-manylinux_2_17_x86_64.manylinux2014_x86_64.whl';
  const tampered = fakeUpstream({ [linuxWheel]: Buffer.from('tampered') });
  await assert.rejects(refreshGraphifyLock({ lock: first, cacheDir: path.join(root, 'cache-2'), fetchImpl: tampered.fetchImpl }), /does not match the pin/);
  const honest = fakeUpstream();
  const second = await refreshGraphifyLock({ lock: first, cacheDir: path.join(root, 'cache-3'), fetchImpl: honest.fetchImpl });
  assert.deepEqual(second.targets['linux-x64'], first.targets['linux-x64']);
  assert.deepEqual(second.targets['linux-arm64'], first.targets['linux-arm64']);
});

test('lock refresh drops cache bytes that failed verification', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-refresh-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  const wheel = 'numpy-2.4.6-cp314-cp314-win_amd64.whl';
  const upstream = fakeUpstream({ [wheel]: Buffer.from('tampered') });
  await assert.rejects(refreshGraphifyLock({ lock: upstream.lock, cacheDir, fetchImpl: upstream.fetchImpl }), /does not match the pin/);
  assert.equal((await readdir(cacheDir)).includes(wheel), false);
});

test('launcher sources name only the bundled Python', async () => {
  const source = await readFile(path.join(scriptDir, 'graphify-launcher.c'), 'utf8');
  assert.match(source, /python\\python\.exe/);
  assert.equal(source.includes('Users'), false);
  assert.match(POSIX_GRAPHIFY_LAUNCHER, /python\/bin\/python3\.14/);
  assert.equal(POSIX_GRAPHIFY_LAUNCHER.includes('Users'), false);
});

test('refuses a Graphify download whose bytes do not match the pin', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-pin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(fetchGraphify({
    platform: 'win32',
    arch: 'x64',
    destination: path.join(root, 'out'),
    cacheDir: path.join(root, 'cache'),
    sourceRoot: root,
    fetchImpl: async () => new Response(Buffer.from('not-the-archive')),
  }), /checksum mismatch/);
});

test('replaces an in-tree symlink with the target file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'python3.14'), 'python-bytes');
  try {
    await symlink('python3.14', path.join(root, 'python3'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'ENOTSUP') {
      t.skip('creating a symlink needs extra privilege');
      return;
    }
    throw error;
  }
  await materializeSymlinks(root);
  const info = await lstat(path.join(root, 'python3'));
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(await readFile(path.join(root, 'python3'), 'utf8'), 'python-bytes');
});

test('finds the CPython license in the Windows and Unix install_only layouts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-license-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const windows = path.join(root, 'win', 'python');
  await mkdir(windows, { recursive: true });
  await writeFile(path.join(windows, 'LICENSE.txt'), 'psf');
  assert.equal(await pythonLicensePath(windows), path.join(windows, 'LICENSE.txt'));
  const unix = path.join(root, 'unix', 'python');
  await mkdir(path.join(unix, 'lib', 'python3.14'), { recursive: true });
  await writeFile(path.join(unix, 'lib', 'python3.14', 'LICENSE.txt'), 'psf');
  assert.equal(await pythonLicensePath(unix), path.join(unix, 'lib', 'python3.14', 'LICENSE.txt'));
  await assert.rejects(pythonLicensePath(path.join(root, 'missing')), /CPython LICENSE\.txt/);
});

test('allows home paths only in unchanged upstream files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Wheels built on a GitHub runner carry that runner's home, which equals ours on CI.
  const homes = ['/Users/runner'];
  await mkdir(path.join(root, 'numpy'), { recursive: true });
  await writeFile(path.join(root, 'numpy', '__config__.py'), 'lib = "/Users/runner/work/numpy/build"');
  await writeFile(path.join(root, 'clean.py'), 'print(1)');
  const upstream = await homePathFiles(root, homes);
  assert.deepEqual([...upstream.keys()], [path.join('numpy', '__config__.py')]);
  await rejectMachinePaths(root, upstream, homes);

  await writeFile(path.join(root, 'graphify'), 'exec /Users/runner/python3');
  await assert.rejects(rejectMachinePaths(root, upstream, homes), /home path: .*graphify$/);
  await rm(path.join(root, 'graphify'));

  await writeFile(path.join(root, 'numpy', '__config__.py'), 'lib = "/Users/runner/other"');
  await assert.rejects(rejectMachinePaths(root, upstream, homes), /home path: .*__config__\.py/);
});

test('rejects a uv tool path even in upstream files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-uv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'site.py'), 'p = "uv/tools/graphifyy/lib"');
  await assert.rejects(rejectMachinePaths(root, await homePathFiles(root, ['/nowhere']), ['/nowhere']), /uv tool path/);
});

test('prunes debug symbols, installers and Tcl/Tk but keeps the runtime and licenses', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-graphify-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const touch = async (relative) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), 'x');
  };
  const exists = (relative) => lstat(path.join(root, relative)).then(() => true, () => false);
  const windowsGone = ['win/python311.pdb', 'win/DLLs/_ctypes.pdb', 'win/DLLs/_tkinter.pyd', 'win/DLLs/tcl86t.dll', 'win/DLLs/tk86t.dll', 'win/tcl/tcl8.6/init.tcl',
    'win/Lib/tkinter/__init__.py', 'win/Lib/idlelib/idle.py', 'win/Lib/ensurepip/__init__.py', 'win/Lib/turtle.py',
    'win/Lib/site-packages/pip/__init__.py', 'win/Lib/site-packages/pip-26.2.2.dist-info/RECORD', 'win/Lib/site-packages/setuptools/__init__.py',
    'win/Lib/site-packages/setuptools-84.2.0.dist-info/RECORD', 'win/Lib/site-packages/_distutils_hack/__init__.py', 'win/Lib/site-packages/distutils-precedence.pth'];
  const windowsKept = ['win/python.exe', 'win/python311.dll', 'win/LICENSE.txt', 'win/DLLs/_ctypes.pyd', 'win/Lib/encodings/__init__.py',
    'win/Lib/site-packages/numpy/__init__.py', 'win/Lib/site-packages/pipx_like/__init__.py', 'win/Lib/site-packages/graphifyy-0.9.95.dist-info/RECORD'];
  for (const file of [...windowsGone, ...windowsKept]) await touch(file);
  await prunePythonRuntime(path.join(root, 'win'), 'win32');
  for (const file of windowsGone) assert.equal(await exists(file), false, file);
  for (const file of windowsKept) assert.equal(await exists(file), true, file);

  const unixGone = ['mac/lib/python3.14/tkinter/__init__.py', 'mac/lib/python3.14/ensurepip/__init__.py', 'mac/lib/python3.14/lib-dynload/_tkinter.cpython-311-darwin.so',
    'mac/lib/python3.14/site-packages/pip/__init__.py', 'mac/lib/tcl9.0/init.tcl', 'mac/lib/tk9.0/tk.tcl', 'mac/lib/libtcl9.0.dylib', 'mac/lib/libtcl9tk9.0.dylib'];
  const unixKept = ['mac/bin/python3', 'mac/lib/libpython3.14.dylib', 'mac/lib/python3.14/LICENSE.txt', 'mac/lib/python3.14/lib-dynload/_ctypes.cpython-311-darwin.so',
    'mac/lib/python3.14/site-packages/numpy/__init__.py'];
  for (const file of [...unixGone, ...unixKept]) await touch(file);
  await prunePythonRuntime(path.join(root, 'mac'), 'darwin');
  for (const file of unixGone) assert.equal(await exists(file), false, file);
  for (const file of unixKept) assert.equal(await exists(file), true, file);
});

function macho64(commands) {
  const parts = commands.map((command) => {
    const name = Buffer.from(`${command.name}\0`);
    const aligned = Math.ceil((24 + name.length) / 8) * 8;
    const body = Buffer.alloc(aligned);
    body.writeUInt32LE(command.cmd, 0);
    body.writeUInt32LE(aligned, 4);
    body.writeUInt32LE(24, 8);
    name.copy(body, 24);
    return body;
  });
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(parts.reduce((sum, part) => sum + part.length, 0), 20);
  return Buffer.concat([header, ...parts]);
}

test('macho load names ignore an id command and read a FAT slice', () => {
  assert.deepEqual(machoLoadNames(macho64([{ cmd: 0x0d, name: 'libpython3.14.dylib' }])), []);
  const slice = macho64([{ cmd: 0x0c, name: 'libpython3.14.dylib' }]);
  const fat = Buffer.alloc(8 + 20 + slice.length);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(slice.length, 8 + 12);
  fat.writeUInt32BE(28, 8 + 8);
  slice.copy(fat, 28);
  assert.deepEqual(machoLoadNames(fat), ['libpython3.14.dylib']);
  assert.deepEqual(machoLoadNames(Buffer.from('not macho!!')), []);
});

test('dedupe removes only byte-identical python copies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-python-dedupe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'python3.14'), 'same-bytes');
  await writeFile(path.join(bin, 'python'), 'same-bytes');
  await writeFile(path.join(bin, 'python3'), 'same-bytes');
  assert.deepEqual(await dedupePythonInterpreters(root), ['python', 'python3']);
  assert.equal(await readFile(path.join(bin, 'python3.14'), 'utf8'), 'same-bytes');
  await assert.rejects(lstat(path.join(bin, 'python')));
  await writeFile(path.join(bin, 'python3'), 'different');
  await assert.rejects(dedupePythonInterpreters(root), /not a byte copy/);
  assert.equal(await readFile(path.join(bin, 'python3'), 'utf8'), 'different');
});

test('libpython is removed only when no Mach-O loads it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-libpython-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const python = path.join(root, 'python');
  await mkdir(path.join(python, 'bin'), { recursive: true });
  await mkdir(path.join(python, 'lib'), { recursive: true });
  await writeFile(path.join(python, 'bin', 'python3.14'), macho64([]));
  await writeFile(path.join(python, 'lib', 'libpython3.14.dylib'), 'library');
  await writeFile(path.join(python, 'lib', 'extension.so'), macho64([{ cmd: 0x0c, name: 'libpython3.14.dylib' }]));
  assert.equal(await removeUnreferencedLibpython(python), false);
  assert.equal(await readFile(path.join(python, 'lib', 'libpython3.14.dylib'), 'utf8'), 'library');
  await writeFile(path.join(python, 'lib', 'extension.so'), macho64([]));
  assert.equal(await removeUnreferencedLibpython(python), true);
  await assert.rejects(lstat(path.join(python, 'lib', 'libpython3.14.dylib')));
  await writeFile(path.join(python, 'lib', 'libpython3.14.dylib'), 'library');
  await writeFile(path.join(python, 'lib', 'broken.so'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1]));
  assert.equal(await removeUnreferencedLibpython(python), false);
  assert.equal(await readFile(path.join(python, 'lib', 'libpython3.14.dylib'), 'utf8'), 'library');
});
