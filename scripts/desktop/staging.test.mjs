import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSanitizedSourceSnapshot, npmCliPathFor, parseStageArgs, stageRuntime } from './stage-runtime.mjs';
import { toolsManifest } from './fetch-tools.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-stage-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const windows = platform === 'win32';
  const gitBinary = windows ? 'cmd/git.exe' : 'bin/git';
  const gitLicense = windows ? 'git/LICENSE.txt' : 'licenses/git/COPYING';
  const gitNotice = windows ? 'git/ucrt64/doc/git-credential-manager/NOTICE' : 'git/libexec/git-core/NOTICE';
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
    'apps/cli/src/report', 'vendor/archify', 'vendor/superpowers-rules', `node/${target}/node`, `node/${target}/git/${path.dirname(gitBinary)}`,
    'node_modules/@electric-sql/pglite/dist',
  ];
  for (const dir of dirs) await mkdir(path.join(source, dir), { recursive: true });
  await write('package.json', JSON.stringify({ version: '0.1.0' }));
  await write('LICENSE', 'Application license');
  await write('apps/web/.next/standalone/apps/web/server.js');
  await write('apps/web/.next/static/chunks/a.js');
  await write('apps/web/public/fonts/a.woff2');
  await write('apps/local/package.json', JSON.stringify({ name: '@nema/local', version: '0.1.0', type: 'module', dependencies: { '@nema/cli': '*', '@nema/hub': '*' } }));
  await write('apps/local/dist/src/index.js', 'export {};');
  await write('apps/local/dist/src/test/runtime.test.js', 'test fixture must not ship');
  for (const [pkg, dep] of [['hub', '@nema/knowledge'], ['cli', '@nema/shared'], ['shared', 'zod'], ['knowledge', '@nema/shared']]) {
    const dir = pkg.startsWith('hub') ? 'apps/hub' : pkg.startsWith('cli') ? 'apps/cli' : `packages/${pkg}`;
    const dist = pkg === 'hub' ? 'dist/src/index.js' : pkg === 'cli' ? 'dist/index.js' : 'dist/index.js';
    await write(`${dir}/package.json`, JSON.stringify({ name: `@nema/${pkg}`, version: pkg === 'local' || pkg === 'cli' ? '0.1.0' : '0.0.0', type: 'module', main: `./${dist}`, dependencies: { [dep]: '*' } }));
    await write(`${dir}/${dist}`, 'export {};');
  }
  await write('apps/hub/dist/src/db/migrations/0001.sql');
  await write('apps/cli/src/report/SKILL.md');
  await write('vendor/archify/LICENSE'); await write('vendor/archify/THIRD_PARTY_NOTICES.md'); await write('vendor/archify/bin/archify.mjs');
  await write('vendor/superpowers-rules/LICENSE'); await write('vendor/superpowers-rules/spec-rules.md'); await write('vendor/superpowers-rules/plan-rules.md');
  await write(`node/${target}/node/${windows ? 'node.exe' : 'bin/node'}`); await write(`node/${target}/node/LICENSE`);
  await write(`node/${target}/node/${windows ? 'node_modules' : 'lib/node_modules'}/npm/bin/npm-cli.js`);
  await write('node_modules/@electric-sql/pglite/dist/index.js');
  await write('node_modules/@electric-sql/pglite/dist/pglite.wasm');
  await write('node_modules/@electric-sql/pglite/dist/initdb.wasm');
  await write('node_modules/@electric-sql/pglite/dist/pglite.data');
  await write(`node/${target}/git/${gitBinary}`); await write(`node/${target}/${gitLicense}`); await write(`node/${target}/${gitNotice}`);
  const nodePin = toolsManifest.node.archive[target], gitPin = toolsManifest.git.archives[target];
  await write(`node/${target}/tools-source.json`, JSON.stringify({ target, node: { version: toolsManifest.node.version, archive: nodePin.file, sha256: nodePin.sha256 }, git: { version: toolsManifest.git.version, gitForWindowsVersion: toolsManifest.git.gitForWindowsVersion, dugiteNativeVersion: toolsManifest.git.dugiteNativeVersion, archive: gitPin.file, sha256: gitPin.sha256 }, sourceCorrespondence: { status: 'pending-task-7c' } }));
  const tools = { node: `${target}/node/${windows ? 'node.exe' : 'bin/node'}`, git: `${target}/git/${gitBinary}`, licenses: { node: `${target}/node/LICENSE`, git: `${target}/${gitLicense}`, gitTree: `${target}/git`, gitNotices: `${target}/${path.dirname(gitNotice)}`, gitNotice: `${target}/${gitNotice}`, sourceRecord: `${target}/tools-source.json` } };
  return { source, output, write, tools, options: { sourceRoot: source, outputDir: output, toolsRoot: path.join(source, 'node'), platform, arch, version: '0.1.0', tools, build: false } };
}

test('stages a relocatable manifest and all declared runtime resources from fixture artifacts', async (t) => {
  const f = await fixture(t);
  await stageRuntime(f.options);
  const target = path.join(f.output, `${process.platform}-${process.arch}`);
  const manifest = JSON.parse(await readFile(path.join(target, 'runtime-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['arch', 'cliEntry', 'coreEntry', 'git', 'licenses', 'node', 'platform', 'schemaVersion', 'version', 'webEntry'].sort());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.version, '0.1.0');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  for (const key of ['node', 'git', 'coreEntry', 'cliEntry', 'webEntry']) assert.ok((await readFile(path.join(target, manifest[key]))).length > 0, key);
  assert.ok((await readFile(path.join(target, manifest.licenses, 'node'))).length > 0);
  for (const file of ['web/apps/web/.next/static/chunks/a.js', 'web/apps/web/public/fonts/a.woff2', 'app/node_modules/@nema/local/package.json', 'app/node_modules/@nema/hub/dist/src/db/migrations/0001.sql', 'app/node_modules/@nema/cli/src/report/SKILL.md', 'vendor/archify/THIRD_PARTY_NOTICES.md', 'vendor/superpowers-rules/LICENSE', 'runtime/licenses/application']) {
    assert.ok((await readFile(path.join(target, file))).length > 0, file);
  }
  await assert.rejects(readFile(path.join(target, 'app/node_modules/@nema/local/dist/src/test/runtime.test.js')));
  const files = await readdir(target);
  assert.equal(files.includes('.env'), false);
  assert.equal(files.includes('.git'), false);
});

test('local staging accepts the documented collected source-material state', async (t) => {
  const f = await fixture(t);
  const sourceRecord = path.join(f.source, 'node', `${process.platform}-${process.arch}`, 'tools-source.json');
  const nodePin = toolsManifest.node.archive[`${process.platform}-${process.arch}`], gitPin = toolsManifest.git.archives[`${process.platform}-${process.arch}`];
  await writeFile(sourceRecord, JSON.stringify({ target: `${process.platform}-${process.arch}`, node: { version: toolsManifest.node.version, archive: nodePin.file, sha256: nodePin.sha256 }, git: { version: toolsManifest.git.version, gitForWindowsVersion: toolsManifest.git.gitForWindowsVersion, dugiteNativeVersion: toolsManifest.git.dugiteNativeVersion, archive: gitPin.file, sha256: gitPin.sha256 }, sourceCorrespondence: { status: 'source-materials-collected' } }));
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

test('refuses to label a staged output for a different native target', async (t) => {
  const f = await fixture(t);
  await assert.rejects(stageRuntime({ ...f.options, platform: process.platform === 'win32' ? 'darwin' : 'win32', arch: process.platform === 'win32' ? 'arm64' : 'x64' }), /target|platform|architecture/i);
});

test('refuses a payload version that differs from the explicit app package version', async (t) => {
  const f = await fixture(t);
  await assert.rejects(stageRuntime({ ...f.options, version: '9.9.9' }), /version.*does not match/i);
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

test('requires a concrete Git notice even when the supplemental notice directory is null', async (t) => {
  const f = await fixture(t);
  f.options.tools = { ...f.tools, licenses: { ...f.tools.licenses, gitNotices: null } };
  await rm(path.join(f.source, 'node', f.options.platform + '-' + f.options.arch, ...f.tools.licenses.gitNotice.split('/').slice(1)));
  await assert.rejects(stageRuntime(f.options), /Git notice/i);
});

test('rejects Node and Git executables supplied from another target', async (t) => {
  for (const executable of ['node', 'git']) {
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

test('rejects workspace dependency symlinks that resolve outside the source payload', async (t) => {
  const f = await fixture(t);
  const outside = path.join(path.dirname(f.source), 'outside-package');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'index.js'), 'export {};');
  await symlink(outside, path.join(f.source, 'node_modules', 'escape'), 'junction');
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
