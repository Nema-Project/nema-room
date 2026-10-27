import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dedupePythonInterpreters, fetchGraphify, graphifyLock, homePathFiles, machoLoadNames, materializeSymlinks, POSIX_GRAPHIFY_LAUNCHER, prunePythonRuntime, pythonLicensePath, rejectMachinePaths, removeUnreferencedLibpython } from './fetch-graphify.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

test('graphify lock pins the release targets and no install path', async () => {
  const raw = await readFile(path.join(scriptDir, 'graphify-lock.json'), 'utf8');
  assert.equal(raw.includes('Users'), false);
  assert.equal(raw.includes('AppData'), false);
  assert.equal(graphifyLock.graphifyy, '0.9.95');
  assert.equal(graphifyLock.python, '3.11.17');
  assert.equal(graphifyLock.extras.length, 0);
  assert.equal(graphifyLock.sourceCorrespondence.status, 'pending-task-7c');
  for (const key of ['win32-x64', 'darwin-arm64']) {
    const pin = graphifyLock.targets[key];
    assert.equal(pin.wheels.length, 21);
    const files = pin.wheels.map((wheel) => wheel.file);
    for (const prefix of ['graphifyy-', 'networkx-', 'numpy-', 'pyyaml-', 'rapidfuzz-', 'tree_sitter-', 'tree_sitter_bash-', 'tree_sitter_c-', 'tree_sitter_c_sharp-', 'tree_sitter_cpp-', 'tree_sitter_go-', 'tree_sitter_java-', 'tree_sitter_javascript-', 'tree_sitter_json-', 'tree_sitter_kotlin-', 'tree_sitter_php-', 'tree_sitter_python-', 'tree_sitter_ruby-', 'tree_sitter_rust-', 'tree_sitter_swift-', 'tree_sitter_typescript-']) {
      assert.equal(files.some((file) => file.startsWith(prefix)), true, prefix);
    }
    for (const prefix of ['tree_sitter_elixir-', 'tree_sitter_fortran-', 'tree_sitter_groovy-', 'tree_sitter_julia-', 'tree_sitter_lua-', 'tree_sitter_objc-', 'tree_sitter_powershell-', 'tree_sitter_scala-', 'tree_sitter_verilog-', 'tree_sitter_zig-']) {
      assert.equal(files.some((file) => file.startsWith(prefix)), false, prefix);
    }
    assert.equal(pin.python.format, 'tar.gz');
    assert.match(pin.python.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\//);
    assert.match(pin.python.sha256, /^[a-f0-9]{64}$/);
    for (const wheel of pin.wheels) {
      assert.match(wheel.url, /^https:\/\/files\.pythonhosted\.org\/packages\//);
      assert.match(wheel.sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.equal(graphifyLock.targets['win32-x64'].python.sha256, '136bbb2e50fe037fd5e32126e70e95b35d1fa5dac5bd04a55b8088415ee99540');
  assert.equal(graphifyLock.targets['darwin-arm64'].python.sha256, 'b5199d66966141fb6d5447512d2b2fe0398d417da37b1949f58db3792d314eac');
});

test('launcher sources name only the bundled Python', async () => {
  const source = await readFile(path.join(scriptDir, 'graphify-launcher.c'), 'utf8');
  assert.match(source, /python\\python\.exe/);
  assert.equal(source.includes('Users'), false);
  assert.match(POSIX_GRAPHIFY_LAUNCHER, /python\/bin\/python3\.11/);
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
  await writeFile(path.join(root, 'python3.11'), 'python-bytes');
  try {
    await symlink('python3.11', path.join(root, 'python3'));
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
  await mkdir(path.join(unix, 'lib', 'python3.11'), { recursive: true });
  await writeFile(path.join(unix, 'lib', 'python3.11', 'LICENSE.txt'), 'psf');
  assert.equal(await pythonLicensePath(unix), path.join(unix, 'lib', 'python3.11', 'LICENSE.txt'));
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

  const unixGone = ['mac/lib/python3.11/tkinter/__init__.py', 'mac/lib/python3.11/ensurepip/__init__.py', 'mac/lib/python3.11/lib-dynload/_tkinter.cpython-311-darwin.so',
    'mac/lib/python3.11/site-packages/pip/__init__.py', 'mac/lib/tcl9.0/init.tcl', 'mac/lib/tk9.0/tk.tcl', 'mac/lib/libtcl9.0.dylib', 'mac/lib/libtcl9tk9.0.dylib'];
  const unixKept = ['mac/bin/python3', 'mac/lib/libpython3.11.dylib', 'mac/lib/python3.11/LICENSE.txt', 'mac/lib/python3.11/lib-dynload/_ctypes.cpython-311-darwin.so',
    'mac/lib/python3.11/site-packages/numpy/__init__.py'];
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
  assert.deepEqual(machoLoadNames(macho64([{ cmd: 0x0d, name: 'libpython3.11.dylib' }])), []);
  const slice = macho64([{ cmd: 0x0c, name: 'libpython3.11.dylib' }]);
  const fat = Buffer.alloc(8 + 20 + slice.length);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(1, 4);
  fat.writeUInt32BE(slice.length, 8 + 12);
  fat.writeUInt32BE(28, 8 + 8);
  slice.copy(fat, 28);
  assert.deepEqual(machoLoadNames(fat), ['libpython3.11.dylib']);
  assert.deepEqual(machoLoadNames(Buffer.from('not macho!!')), []);
});

test('dedupe removes only byte-identical python copies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-python-dedupe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'python3.11'), 'same-bytes');
  await writeFile(path.join(bin, 'python'), 'same-bytes');
  await writeFile(path.join(bin, 'python3'), 'same-bytes');
  assert.deepEqual(await dedupePythonInterpreters(root), ['python', 'python3']);
  assert.equal(await readFile(path.join(bin, 'python3.11'), 'utf8'), 'same-bytes');
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
  await writeFile(path.join(python, 'bin', 'python3.11'), macho64([]));
  await writeFile(path.join(python, 'lib', 'libpython3.11.dylib'), 'library');
  await writeFile(path.join(python, 'lib', 'extension.so'), macho64([{ cmd: 0x0c, name: 'libpython3.11.dylib' }]));
  assert.equal(await removeUnreferencedLibpython(python), false);
  assert.equal(await readFile(path.join(python, 'lib', 'libpython3.11.dylib'), 'utf8'), 'library');
  await writeFile(path.join(python, 'lib', 'extension.so'), macho64([]));
  assert.equal(await removeUnreferencedLibpython(python), true);
  await assert.rejects(lstat(path.join(python, 'lib', 'libpython3.11.dylib')));
  await writeFile(path.join(python, 'lib', 'libpython3.11.dylib'), 'library');
  await writeFile(path.join(python, 'lib', 'broken.so'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 1]));
  assert.equal(await removeUnreferencedLibpython(python), false);
  assert.equal(await readFile(path.join(python, 'lib', 'libpython3.11.dylib'), 'utf8'), 'library');
});
