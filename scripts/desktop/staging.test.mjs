import assert from 'node:assert/strict';
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSanitizedSourceSnapshot, npmCliPathFor, parseStageArgs, recordedCommit, runtimeDependencyClosure, stageRuntime, writePlatformLaunchers } from './stage-runtime.mjs';
import { nodePayloadExcluded, toolsManifest } from './fetch-tools.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-stage-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const windows = platform === 'win32';
  const source = path.join(root, 'source');
  const output = path.join(root, '出力 folder');
  const write = async (name, body = 'fixture') => {
    const file = path.join(source, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return file;
  };
  const dirs = [
    'apps/web/.next/standalone/apps/web', 'apps/web/.next/static/chunks', 'apps/web/public/fonts',
    'apps/local/dist/src', 'apps/hub/dist/src/db/migrations', 'apps/cli/dist', 'packages/shared/dist', 'packages/knowledge/dist',
    'apps/cli/src/report', 'vendor/archify', 'vendor/superpowers-rules', `node/${target}/node`,
    'node_modules/@electric-sql/pglite/dist',
  ];
  for (const dir of dirs) await mkdir(path.join(source, dir), { recursive: true });
  await write('package.json', JSON.stringify({ version: '0.1.0' }));
  await write('LICENSE', 'Application license');
  await write('node_modules/electron/dist/LICENSE', 'Electron MIT license');
  await write('node_modules/electron/dist/LICENSES.chromium.html', 'Chromium third-party notices');
  await write('apps/web/.next/standalone/apps/web/server.js');
  await write('apps/web/.next/static/chunks/a.js');
  await write('apps/web/public/fonts/a.woff2');
  await write('apps/local/package.json', JSON.stringify({ name: '@nema/local', version: '0.1.0', type: 'module', dependencies: { '@nema/cli': '*', '@nema/hub': '*' } }));
  await write('apps/local/dist/src/index.js', 'export {};');
  await write('apps/local/dist/src/test/runtime.test.js', 'test fixture must not ship');
  for (const [pkg, dep] of [['hub', ['@nema/knowledge', '@electric-sql/pglite']], ['cli', ['@nema/shared']], ['shared', ['zod']], ['knowledge', ['@nema/shared']]]) {
    const dir = pkg.startsWith('hub') ? 'apps/hub' : pkg.startsWith('cli') ? 'apps/cli' : `packages/${pkg}`;
    const dist = pkg === 'hub' ? 'dist/src/index.js' : pkg === 'cli' ? 'dist/index.js' : 'dist/index.js';
    await write(`${dir}/package.json`, JSON.stringify({ name: `@nema/${pkg}`, version: pkg === 'local' || pkg === 'cli' ? '0.1.0' : '0.0.0', type: 'module', main: `./${dist}`, dependencies: Object.fromEntries(dep.map((name) => [name, '*'])) }));
    await write(`${dir}/${dist}`, 'export {};');
  }
  await write('apps/hub/dist/src/db/migrations/0001.sql');
  await write('apps/cli/src/report/SKILL.md');
  await write('vendor/archify/LICENSE'); await write('vendor/archify/THIRD_PARTY_NOTICES.md'); await write('vendor/archify/bin/archify.mjs');
  await write('vendor/superpowers-rules/LICENSE'); await write('vendor/superpowers-rules/spec-rules.md'); await write('vendor/superpowers-rules/plan-rules.md');
  await write(`node/${target}/node/${windows ? 'node.exe' : 'bin/node'}`); await write(`node/${target}/node/LICENSE`);
  await write(`node/${target}/node/${windows ? 'node_modules' : 'lib/node_modules'}/npm/bin/npm-cli.js`);
  await write('node_modules/@electric-sql/pglite/package.json', JSON.stringify({ name: '@electric-sql/pglite', version: '0.5.11' }));
  await write('node_modules/@electric-sql/pglite/dist/index.js');
  await write('node_modules/zod/package.json', JSON.stringify({ name: 'zod', version: '4.6.7' }));
  // Web-only: Next's standalone trace ships it under web/, so the core's app/node_modules must not.
  await write('node_modules/next/package.json', JSON.stringify({ name: 'next', version: '16.4.2', dependencies: { 'styled-jsx': '*' } }));
  await write('node_modules/styled-jsx/package.json', JSON.stringify({ name: 'styled-jsx', version: '5.1.6' }));
  await write('node_modules/@electric-sql/pglite/dist/pglite.wasm');
  await write('node_modules/@electric-sql/pglite/dist/initdb.wasm');
  await write('node_modules/@electric-sql/pglite/dist/pglite.data');
  if (windows) await write(`node/${target}/owned-helper.exe`, 'native guardian fixture');
  const nodePin = toolsManifest.node.archive[target];
  await write(`node/${target}/tools-source.json`, JSON.stringify({ target, node: { version: toolsManifest.node.version, archive: nodePin.file, sha256: nodePin.sha256 }, sourceCorrespondence: { status: 'pending-task-7c' } }));
  const tools = { node: `${target}/node/${windows ? 'node.exe' : 'bin/node'}`, ...(windows ? { ownedHelperGuardian: `${target}/owned-helper.exe` } : {}), licenses: { node: `${target}/node/LICENSE`, sourceRecord: `${target}/tools-source.json` } };
  const stageGraphify = async ({ destination, platform: graphifyPlatform }) => {
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, graphifyPlatform === 'win32' ? 'graphify.exe' : 'graphify'), 'graphify fixture');
    await mkdir(path.join(destination, 'licenses'), { recursive: true });
    await writeFile(path.join(destination, 'licenses', 'LICENSE'), 'graphify license fixture');
    return destination;
  };
  return { source, output, write, tools, options: { sourceRoot: source, outputDir: output, toolsRoot: path.join(source, 'node'), platform, arch, version: '0.1.0', tools, build: false, fetchGraphify: stageGraphify } };
}

test('runs the Electron installer when the binary has not been downloaded yet', async (t) => {
  const f = await fixture(t);
  await rm(path.join(f.source, 'node_modules/electron/dist'), { recursive: true });
  await writeFile(path.join(f.source, 'node_modules/electron/install.js'), `
    const fs = require('node:fs');
    const path = require('node:path');
    const dist = path.join(__dirname, 'dist');
    fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, 'LICENSE'), 'Electron MIT license');
    fs.writeFileSync(path.join(dist, 'LICENSES.chromium.html'), 'Chromium third-party notices');
  `);
  await stageRuntime(f.options);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  assert.equal(await readFile(path.join(target, 'runtime/licenses/electron/LICENSE'), 'utf8'), 'Electron MIT license');
});

test('records a full commit only when it is a 40-digit sha of this source root', () => {
  assert.equal(recordedCommit(os.tmpdir(), 'AB'.repeat(20)), 'ab'.repeat(20));
  assert.equal(recordedCommit(os.tmpdir(), 'nope'), undefined);
  assert.equal(recordedCommit(path.join(os.tmpdir(), 'nema-not-a-repository'), undefined), undefined);
});

test('stages a relocatable manifest and all declared runtime resources from fixture artifacts', async (t) => {
  const f = await fixture(t);
  await stageRuntime(f.options);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  const manifest = JSON.parse(await readFile(path.join(target, 'runtime-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['arch', 'cliEntry', 'coreEntry', 'licenses', 'node', 'platform', 'schemaVersion', 'version', 'webEntry', ...(process.platform === 'win32' ? ['ownedHelperGuardian'] : [])].sort());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  if (process.platform === 'win32') {
    assert.equal(manifest.ownedHelperGuardian, 'runtime/owned-helper.exe');
    assert.equal((await readFile(path.join(target, manifest.ownedHelperGuardian), 'utf8')), 'native guardian fixture');
  } else assert.equal(manifest.ownedHelperGuardian, undefined);
  for (const key of ['node', 'coreEntry', 'cliEntry', 'webEntry']) assert.ok((await readFile(path.join(target, manifest[key]))).length > 0, key);
  assert.ok((await readFile(path.join(target, manifest.licenses, 'node'))).length > 0);
  for (const file of ['web/apps/web/.next/static/chunks/a.js', 'web/apps/web/public/fonts/a.woff2', 'app/node_modules/@nema/local/package.json', 'app/node_modules/@nema/hub/dist/src/db/migrations/0001.sql', 'app/node_modules/@nema/cli/src/report/SKILL.md', 'vendor/archify/THIRD_PARTY_NOTICES.md', 'vendor/superpowers-rules/LICENSE', 'runtime/licenses/application', 'runtime/licenses/graphify-runtime/LICENSE', process.platform === 'win32' ? 'tools/graphify/graphify.exe' : 'tools/graphify/graphify']) {
    assert.ok((await readFile(path.join(target, file))).length > 0, file);
  }
  await assert.rejects(readFile(path.join(target, 'app/node_modules/@nema/local/dist/src/test/runtime.test.js')));
  assert.deepEqual((await readdir(path.join(target, 'app/node_modules'))).sort(), ['@electric-sql', '@nema', 'zod']);
  const files = await readdir(target);
  assert.equal(files.includes('.env'), false);
  assert.equal(files.includes('.git'), false);
});

test('requires the Windows helper guardian artifact before writing the manifest', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows-only guardian resource');
  const f = await fixture(t);
  const tools = { ...f.options.tools, ownedHelperGuardian: `${process.platform}-${process.arch}/missing-owned-helper.exe` };
  await assert.rejects(stageRuntime({ ...f.options, tools }), /Windows helper guardian executable.*missing|required/i);
});

test('local staging accepts the documented collected source-material state', async (t) => {
  const f = await fixture(t);
  const sourceRecord = path.join(f.source, 'node', `${process.platform}-${process.arch}`, 'tools-source.json');
  const nodePin = toolsManifest.node.archive[`${process.platform}-${process.arch}`];
  await writeFile(sourceRecord, JSON.stringify({ target: `${process.platform}-${process.arch}`, node: { version: toolsManifest.node.version, archive: nodePin.file, sha256: nodePin.sha256 }, sourceCorrespondence: { status: 'source-materials-collected' } }));
  await stageRuntime(f.options);
  assert.ok((await readFile(path.join(f.output, `${process.platform}-${process.arch}`, 'runtime-manifest.json'), 'utf8')).includes('"schemaVersion": 1'));
});

test('stages fixed native browser launchers beside the runtime manifest', async (t) => {
  const f = await fixture(t);
  await stageRuntime(f.options);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  const launcher = process.platform === 'win32' ? 'Nema Browser.cmd' : process.platform === 'darwin' ? 'Nema Browser.command' : 'nema-browser';
  const source = await readFile(path.join(target, launcher), 'utf8');
  assert.match(source, /local[\\/]dist[\\/]src[\\/]browser\.js/);
  assert.match(source, /--no-open/);
  const manifest = JSON.parse(await readFile(path.join(target, 'runtime-manifest.json'), 'utf8'));
  assert.equal(manifest.webEntry, 'web/apps/web/managed-parent.mjs');
  assert.match(source, /runtime/);
  assert.match(await readFile(path.join(target, manifest.webEntry), 'utf8'), /process\.once\("disconnect"/);
});

test('stages a CLI launcher that points at the bundled node and CLI entry', async (t) => {
  const f = await fixture(t);
  await stageRuntime(f.options);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  const launcher = process.platform === 'win32' ? 'Nema CLI.cmd' : process.platform === 'darwin' ? 'Nema CLI.command' : 'nema-cli';
  const source = await readFile(path.join(target, launcher), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(target, 'runtime-manifest.json'), 'utf8'));
  const native = (value) => value.replaceAll('/', path.sep);
  assert.ok(source.includes(native(manifest.node)));
  assert.ok(source.includes(native(manifest.cliEntry)));
  assert.equal(source.includes('{{'), false);
  assert.match(source, process.platform === 'win32' ? /%\*/ : /"$@"/);
  if (process.platform !== 'win32') assert.ok(((await stat(path.join(target, launcher))).mode & 0o111) !== 0);
});

test('the CLI launcher forwards arguments exactly and preserves exit codes from a path with spaces and Japanese characters', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-cli-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'インストール dir', 'resources', 'payload');
  const windows = process.platform === 'win32';
  const nodeRel = windows ? 'runtime/node/node.exe' : 'runtime/node/bin/node';
  const cliRel = 'app/node_modules/@nema/cli/dist/index.js';
  await mkdir(path.dirname(path.join(payload, nodeRel)), { recursive: true });
  await mkdir(path.dirname(path.join(payload, cliRel)), { recursive: true });
  try { await link(process.execPath, path.join(payload, nodeRel)); } catch { await copyFile(process.execPath, path.join(payload, nodeRel)); }
  await writeFile(path.join(payload, cliRel), "const [code, ...rest] = process.argv.slice(2); process.stdout.write(JSON.stringify({ rest, exec: process.execPath, entry: process.argv[1] })); process.exitCode = Number(code);");
  await mkdir(path.join(payload, 'web/apps/web'), { recursive: true });
  const manifest = { platform: process.platform, node: nodeRel, cliEntry: cliRel };
  const { cliLauncherPath } = await writePlatformLaunchers(payload, manifest);
  const run = (args) => windows
    ? spawnSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c', `"call "${cliLauncherPath}" ${args.join(' ')}"`], { cwd: payload, encoding: 'utf8', windowsVerbatimArguments: true })
    : spawnSync(cliLauncherPath, args, { cwd: payload, encoding: 'utf8' });
  const ok = run(['0', 'report', 'install', '--agent', 'claude', '"with space"', '日本語', '--home=x']);
  assert.equal(ok.status, 0, ok.stderr);
  const seen = JSON.parse(ok.stdout);
  assert.deepEqual(seen.rest, ['report', 'install', '--agent', 'claude', 'with space', '日本語', '--home=x']);
  assert.equal(path.normalize(seen.exec).toLowerCase(), path.join(payload, nodeRel).toLowerCase());
  assert.equal(path.normalize(seen.entry).toLowerCase(), path.join(payload, cliRel).toLowerCase());
  assert.equal(run(['7']).status, 7);
  assert.equal(run(['0']).status, 0);
});

test('stages Electron and Chromium notices inside the inventoried runtime license tree', async (t) => {
  const f = await fixture(t);
  await stageRuntime(f.options);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  assert.equal(await readFile(path.join(target, 'runtime/licenses/electron/LICENSE'), 'utf8'), 'Electron MIT license');
  assert.equal(await readFile(path.join(target, 'runtime/licenses/electron/LICENSES.chromium.html'), 'utf8'), 'Chromium third-party notices');
});

test('refuses to label a staged output for a different native target', async (t) => {
  const f = await fixture(t);
  await assert.rejects(stageRuntime({ ...f.options, platform: process.platform === 'win32' ? 'darwin' : 'win32', arch: process.platform === 'win32' ? 'arm64' : 'x64' }), /target|platform|architecture/i);
});

test('refuses a payload version that differs from the explicit app package version', async (t) => {
  const f = await fixture(t);
  await assert.rejects(stageRuntime({ ...f.options, version: '9.9.9' }), /version.*does not match/i);
});

test('payload omits Node headers, npm, Corepack, sharp, and source maps', async (t) => {
  assert.equal(nodePayloadExcluded('node/include/node.h'), true);
  assert.equal(nodePayloadExcluded('node/bin/node'), false);
  assert.equal(nodePayloadExcluded('node/LICENSE'), false);
  assert.equal(nodePayloadExcluded('node/lib/node_modules/npm/bin/npm-cli.js'), true);
  assert.equal(nodePayloadExcluded('node/node_modules/corepack/package.json'), true);
  assert.equal(nodePayloadExcluded('node/bin/npx'), true);
  assert.equal(nodePayloadExcluded('node/corepack.cmd'), true);
  assert.equal(nodePayloadExcluded('node/npm.ps1'), true);
  assert.equal(nodePayloadExcluded('tools-source.json'), false);
  const f = await fixture(t);
  const windows = process.platform === 'win32';
  const nodeRoot = `node/${process.platform}-${process.arch}/node`;
  await f.write(`${nodeRoot}/include/node.h`, 'header');
  await f.write(`${nodeRoot}/${windows ? 'node_modules' : 'lib/node_modules'}/corepack/package.json`, '{}');
  await f.write(`${nodeRoot}/${windows ? 'npm.cmd' : 'bin/npm'}`, 'shim');
  await f.write('apps/web/.next/standalone/node_modules/sharp/index.js', 'sharp');
  await f.write('apps/web/.next/standalone/node_modules/@img/sharp-darwin/lib.js', 'img');
  await f.write('apps/web/.next/static/chunks/a.js.map', '{"version":3}');
  await stageRuntime(f.options);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  const nodeDir = path.join(target, 'runtime', `${process.platform}-${process.arch}`, 'node');
  assert.ok((await readFile(path.join(nodeDir, windows ? 'node.exe' : 'bin/node'))).length > 0);
  assert.ok((await readFile(path.join(nodeDir, 'LICENSE'))).length > 0);
  await assert.rejects(readFile(path.join(nodeDir, 'include/node.h')));
  await assert.rejects(readFile(path.join(nodeDir, windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js')));
  await assert.rejects(readFile(path.join(nodeDir, windows ? 'node_modules/corepack/package.json' : 'lib/node_modules/corepack/package.json')));
  await assert.rejects(readFile(path.join(nodeDir, windows ? 'npm.cmd' : 'bin/npm')));
  await assert.rejects(readFile(path.join(target, 'web/node_modules/sharp/index.js')));
  await assert.rejects(readFile(path.join(target, 'web/node_modules/@img/sharp-darwin/lib.js')));
  await assert.rejects(readFile(path.join(target, 'web/apps/web/.next/static/chunks/a.js.map')));
  assert.equal(await readFile(path.join(target, 'runtime/licenses/electron/LICENSES.chromium.html'), 'utf8'), 'Chromium third-party notices');
  assert.ok((await readFile(path.join(target, 'web/apps/web/.next/static/chunks/a.js'))).length > 0);
});

test('resolves npm inside the Windows and POSIX pinned Node distribution layouts', async (t) => {
  const f = await fixture(t);
  const windowsNode = path.join(f.source, 'windows-node', 'node.exe');
  const posixNode = path.join(f.source, 'posix-node', 'bin', 'node');
  assert.equal(npmCliPathFor(windowsNode, 'win32'), path.join(f.source, 'windows-node', 'node_modules/npm/bin/npm-cli.js'));
  assert.equal(npmCliPathFor(posixNode, 'darwin'), path.join(f.source, 'posix-node/lib/node_modules/npm/bin/npm-cli.js'));
});

test('parses the documented named native staging flags and retains positional compatibility', () => {
  assert.deepEqual(parseStageArgs(['--platform', 'win32', '--arch', 'x64', '--out', 'some out', '--source-root', 'source']), {
    platform: 'win32', arch: 'x64', outputDir: 'some out', sourceRoot: 'source',
  });
  assert.deepEqual(parseStageArgs(['source', 'output']), { sourceRoot: 'source', outputDir: 'output' });
  assert.throws(() => parseStageArgs(['--platform', 'win32', '--arch']), /requires a value/i);
  assert.throws(() => parseStageArgs(['--unknown', 'value']), /unknown staging option/i);
});

test('refuses missing version, standalone output, static assets, public assets, or runtime resources', async (t) => {
  for (const [name, remove] of [
    ['version', async (f) => { f.options.version = ''; }],
    ['standalone server', async (f) => rm(path.join(f.source, 'apps/web/.next/standalone/apps/web/server.js'))],
    ['static output', async (f) => rm(path.join(f.source, 'apps/web/.next/static'), { recursive: true })],
    ['public font', async (f) => rm(path.join(f.source, 'apps/web/public'), { recursive: true })],
    ['PGlite WASM', async (f) => rm(path.join(f.source, 'node_modules/@electric-sql/pglite/dist/pglite.wasm'))],
    ['PGlite data', async (f) => rm(path.join(f.source, 'node_modules/@electric-sql/pglite/dist/pglite.data'))],
    ['migration', async (f) => rm(path.join(f.source, 'apps/hub/dist/src/db/migrations'), { recursive: true })],
    ['vendor notice', async (f) => rm(path.join(f.source, 'vendor/archify/THIRD_PARTY_NOTICES.md'))],
    ['application license', async (f) => rm(path.join(f.source, 'LICENSE'))],
    ['required license', async (f) => rm(path.join(f.source, 'node', f.options.platform + '-' + f.options.arch, 'node/LICENSE'))],
  ]) {
    const f = await fixture(t);
    await remove(f);
    await assert.rejects(stageRuntime(f.options), /missing|required|version|target|license|notice/i, name);
  }
});

test('rejects a Node executable supplied from another target', async (t) => {
  for (const executable of ['node']) {
    const f = await fixture(t);
    const wrong = `wrong-target/${executable}/bin/${executable}`;
    await f.write(`node/${wrong}`);
    f.options.tools = { ...f.tools, [executable]: wrong };
    await assert.rejects(stageRuntime(f.options), /selected target|target|path/i);
  }
});

test('requires concrete manifest core and CLI entry files', async (t) => {
  for (const entry of ['apps/local/dist/src/index.js', 'apps/cli/dist/index.js']) {
    const f = await fixture(t);
    await rm(path.join(f.source, entry));
    await assert.rejects(stageRuntime(f.options), /core entry|CLI entry|missing|required/i);
  }
});

test('rejects unsafe tool resource paths', async (t) => {
  const f = await fixture(t);
  f.options.tools = { ...f.tools, node: '../outside/node.exe' };
  await assert.rejects(stageRuntime(f.options), /path|escape|unsafe/i);
});

test('copies an in-tree tool symlink when the tools root is reached through a symlink', async (t) => {
  const f = await fixture(t);
  const linkRoot = path.join(path.dirname(f.source), 'node-link');
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await symlink(path.join(f.source, 'node'), linkRoot, kind);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EPERM') return;
    throw error;
  }
  const target = `${process.platform}-${process.arch}`;
  const nodeDir = path.join(f.source, 'node', target, 'node');
  const inside = path.join(nodeDir, 'inside');
  await mkdir(inside);
  await writeFile(path.join(inside, 'keep.txt'), 'fixture');
  await symlink(inside, path.join(nodeDir, 'linked-lib'), process.platform === 'win32' ? 'junction' : 'dir');
  await stageRuntime({ ...f.options, toolsRoot: linkRoot });
  const staged = path.join(f.output, target, 'runtime', target, 'node', 'linked-lib', 'keep.txt');
  assert.equal(await readFile(staged, 'utf8'), 'fixture');
});

test('rejects workspace dependency symlinks that resolve outside the source payload', async (t) => {
  const f = await fixture(t);
  const outside = path.join(path.dirname(f.source), 'outside-package');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'index.js'), 'export {};');
  await writeFile(path.join(outside, 'package.json'), JSON.stringify({ name: 'zod', version: '4.6.7' }));
  // A runtime dependency (zod, via @nema/shared) that links outside the payload source.
  await rm(path.join(f.source, 'node_modules', 'zod'), { recursive: true });
  await symlink(outside, path.join(f.source, 'node_modules', 'zod'), 'junction');
  await assert.rejects(stageRuntime(f.options), /escapes payload source/i);
});

test('sanitized build snapshot recursively excludes env, dist, and nested dependencies through source links', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-snapshot-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'checkout');
  const snapshot = path.join(root, 'snapshot');
  const linked = path.join(source, 'linked-assets');
  await mkdir(path.join(source, 'apps/web'), { recursive: true });
  await mkdir(path.join(linked, 'nested', 'dist'), { recursive: true });
  await mkdir(path.join(linked, 'node_modules', 'fixture'), { recursive: true });
  await writeFile(path.join(linked, 'nested', '.env.local'), 'fixture only');
  await writeFile(path.join(linked, 'nested', '._.env'), 'fixture only');
  await writeFile(path.join(linked, 'nested', 'dist', 'stale.js'), 'fixture only');
  await writeFile(path.join(linked, 'node_modules', 'fixture', 'index.js'), 'fixture only');
  await writeFile(path.join(linked, 'nested', 'keep.txt'), 'kept');
  await symlink(linked, path.join(source, 'apps/web/assets-link'), 'junction');
  await createSanitizedSourceSnapshot(source, snapshot);
  assert.equal(await readFile(path.join(snapshot, 'apps/web/assets-link/nested/keep.txt'), 'utf8'), 'kept');
  await assert.rejects(readFile(path.join(snapshot, 'apps/web/assets-link/nested/.env.local')));
  await assert.rejects(readFile(path.join(snapshot, 'apps/web/assets-link/nested/._.env')));
  await assert.rejects(readFile(path.join(snapshot, 'apps/web/assets-link/nested/dist/stale.js')));
  await assert.rejects(readFile(path.join(snapshot, 'apps/web/assets-link/node_modules/fixture/index.js')));
  assert.ok((await readdir(path.join(snapshot, 'apps/web/public'))).length === 0);
});

test('sanitized source snapshot rejects a symlink that escapes the checkout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-snapshot-escape-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'checkout');
  const outside = path.join(root, 'outside');
  await mkdir(source, { recursive: true }); await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'fixture only');
  await symlink(outside, path.join(source, 'outside-link'), 'junction');
  await assert.rejects(createSanitizedSourceSnapshot(source, path.join(root, 'snapshot')), /escapes checkout/i);
});

test('rejects output ownership collisions without deleting existing data', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'owner.txt'), 'foreign');
  await assert.rejects(stageRuntime(f.options), /exist|owned|output/i);
  assert.equal(await readFile(path.join(target, 'owner.txt'), 'utf8'), 'foreign');
});

test('runtime dependency closure follows declared, nested and optional dependencies only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-closure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = async (dir, value) => {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify(value));
  };
  await pkg('apps/core', { name: '@nema/core', dependencies: { a: '*', '@nema/shared': '*' }, optionalDependencies: { absent: '*' } });
  await pkg('node_modules/a', { name: 'a', dependencies: { b: '*', '@s/c': '*' } });
  await pkg('node_modules/a/node_modules/b', { name: 'b', dependencies: { d: '*' } });
  await pkg('node_modules/@s/c', { name: '@s/c', peerDependencies: { absentPeer: '*' } });
  await pkg('node_modules/d', { name: 'd' });
  await pkg('node_modules/b', { name: 'b', version: 'hoisted-but-shadowed' });
  await pkg('node_modules/unused', { name: 'unused' });
  const closure = await runtimeDependencyClosure(root, [path.join(root, 'apps/core')]);
  assert.deepEqual([...closure].sort(), ['@s/c', 'a', 'd']);
  await pkg('apps/broken', { name: '@nema/broken', dependencies: { missing: '*' } });
  await assert.rejects(runtimeDependencyClosure(root, [path.join(root, 'apps/broken')]), /missing.*@nema\/broken/);
});
