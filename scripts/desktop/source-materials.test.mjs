import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectSourceMaterials, validatePublicationEligibility } from './source-materials.mjs';
import { parseReleaseValidationArgs } from './validate-release.mjs';
import { parseSourceCollectionArgs } from './collect-source-materials.mjs';

const rootFixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-source-materials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload');
  const toolsManifest = path.join(root, 'tools-manifest.json');
  await mkdir(path.join(payload, 'runtime/win32-x64'), { recursive: true });
  await writeFile(toolsManifest, JSON.stringify({ schemaVersion: 1, node: { version: '24.22.1', archive: { 'win32-x64': { file: 'node-v24.22.1-win-x64.zip', sha256: 'a'.repeat(64) } } }, git: { version: '2.56.0', gitForWindowsVersion: '2.56.0.windows.2', dugiteNativeVersion: '2.56.0-1', archives: { 'win32-x64': { file: 'dugite-native-v2.56.0-7ce66f8-windows-x64.tar.gz', sha256: 'b'.repeat(64) } } } }));
  await writeFile(path.join(payload, 'runtime/win32-x64/tools-source.json'), JSON.stringify({ schemaVersion: 1, target: 'win32-x64', node: { version: '24.22.1', archive: 'node-v24.22.1-win-x64.zip', sha256: 'a'.repeat(64) }, git: { version: '2.56.0', gitForWindowsVersion: '2.56.0.windows.2', dugiteNativeVersion: '2.56.0-1', archive: 'dugite-native-v2.56.0-7ce66f8-windows-x64.tar.gz', sha256: 'b'.repeat(64) }, sourceCorrespondence: { status: 'pending-task-7c' } }));
  await writeFile(path.join(payload, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', platform: 'win32', arch: 'x64' }));
  await mkdir(path.join(payload, 'runtime/win32-x64/git/etc'), { recursive: true });
  await writeFile(path.join(payload, 'runtime/win32-x64/git/etc/package-versions.txt'), 'git 2.56.0\nmsys2 20261024\n');
  return { root, payload, toolsManifest };
};
const completeInputs = (sha256) => [
  { id: 'node-source', component: 'Node.js 24.22.1', status: 'complete', correspondence: 'verified', version: '24.22.1', immutableRef: 'v24.22.1', archiveTarget: 'win32-x64', tool: 'node', correspondenceEvidence: { toolArchiveSha256: 'a'.repeat(64), immutableRef: 'v24.22.1', basis: 'fixture upstream source hash and binary version pin' }, sourcePath: 'arbitrary.txt', sha256 },
  { id: 'mingit-component-sources', component: 'Git for Windows 2.56.0.windows.2', status: 'complete', correspondence: 'verified', version: '2.56.0.windows.2', immutableRef: 'fixture-commit', archiveTarget: 'win32-x64', tool: 'git', correspondenceEvidence: { toolArchiveSha256: 'b'.repeat(64), immutableRef: 'fixture-commit', basis: 'fixture source package reconciliation' }, sourcePath: 'arbitrary.txt', sha256 },
  { id: 'font-sources', component: 'Inter and JetBrains Mono', status: 'complete', correspondence: 'verified', version: 'fixture-fonts', immutableRef: 'fixture-commit', archiveTarget: 'win32-x64', tool: 'web', correspondenceEvidence: { basis: 'fixture font provenance mapping', fontAssetHashes: [{ path: 'web/apps/web/.next/static/media/Inter.woff2', sha256: 'aa0ac38cd3f2459bc65140b9035ec40965415e256eb7bf1a22b0ede5860b90db' }] }, sourcePath: 'arbitrary.txt', sha256 },
];
const populateCompleteNotices = async (f) => {
  const files = ['runtime/win32-x64/node/LICENSE', 'runtime/win32-x64/git/LICENSE.txt', 'runtime/licenses/application', 'vendor/archify/LICENSE', 'vendor/superpowers-rules/LICENSE', 'app/node_modules/example/LICENSE', 'runtime/win32-x64/git/bin/git', 'runtime/win32-x64/node/node.exe', 'runtime/win32-x64/node/node_modules/npm/package.json', 'runtime/win32-x64/node/node_modules/corepack/package.json'];
  for (const file of files) {
    await mkdir(path.dirname(path.join(f.payload, file)), { recursive: true });
    await writeFile(path.join(f.payload, file), `fixture ${file}`);
  }
  await writeFile(path.join(f.payload, 'app/node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }));
  await mkdir(path.join(f.payload, 'web/apps/web/.next/static/media'), { recursive: true });
  await writeFile(path.join(f.payload, 'web/apps/web/.next/static/media/Inter.woff2'), 'fixture woff2 bytes');
  await writeFile(path.join(f.payload, 'web/apps/web/.next/static/media/JetBrains.woff2'), 'fixture jetbrains woff2 bytes');
  await writeFile(path.join(f.payload, 'runtime/win32-x64/node/node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: '11.19.1' }));
  await writeFile(path.join(f.payload, 'runtime/win32-x64/node/node_modules/corepack/package.json'), JSON.stringify({ name: 'corepack', version: '0.36.0' }));
  const fonts = [];
  for (const id of ['inter-ofl', 'jetbrains-mono-ofl']) {
    const sourcePath = `${id}.txt`;
    await writeFile(path.join(f.root, sourcePath), `fixture ${id} OFL`);
    fonts.push({ id, component: id, immutableRef: 'fixture-font-license-commit', url: `https://github.com/google/fonts/blob/fixture/${id}.txt`, sourcePath });
  }
  return fonts;
};
const pathHash = async (file) => {
  const { createHash } = await import('node:crypto');
  const bytes = await (await import('node:fs/promises')).readFile(file);
  return createHash('sha256').update(bytes).digest('hex');
};
const posixFixture = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-posix-source-materials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload');
  const toolsManifest = path.join(root, 'tools-manifest.json');
  const target = 'darwin-arm64';
  await mkdir(path.join(payload, 'runtime', target, 'git/bin'), { recursive: true });
  await writeFile(path.join(payload, 'runtime', target, 'git/bin/git'), 'fixture git');
  await mkdir(path.join(payload, 'runtime', target), { recursive: true });
  await writeFile(path.join(payload, 'runtime', target, 'tools-source.json'), JSON.stringify({ target, node: { version: '24.22.1', archive: 'node-darwin.tar.gz', sha256: 'a'.repeat(64) }, git: { version: '2.56.0', archive: 'git-darwin.tar.gz', sha256: 'b'.repeat(64) }, sourceCorrespondence: { status: 'pending-task-7c' } }));
  await writeFile(path.join(payload, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', platform: 'darwin', arch: 'arm64' }));
  await writeFile(toolsManifest, JSON.stringify({ node: { version: '24.22.1', archive: { [target]: { file: 'node-darwin.tar.gz', sha256: 'a'.repeat(64) } } }, git: { version: '2.56.0', archives: { [target]: { file: 'git-darwin.tar.gz', sha256: 'b'.repeat(64) } } } }));
  return { root, payload, toolsManifest };
};
const writeResolvedFixture = async (f, upstreamNotices) => {
  const { createHash } = await import('node:crypto');
  const materials = [];
  const materialByKey = new Map();
  let archiveIndex = 0;
  const addMaterial = async (id, roleComponent, role, tool, version) => {
    const bytes = Buffer.from(`unique fixture ${id}`);
    const sourceRelative = `archives/${id}.tar`;
    await mkdir(path.dirname(path.join(f.root, sourceRelative)), { recursive: true });
    await writeFile(path.join(f.root, sourceRelative), bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const material = { id, component: roleComponent, status: 'complete', version, immutableRef: `fixture-ref-${id}`, archiveTarget: 'win32-x64', tool, sourcePath: sourceRelative, sha256 };
    materials.push(material);
    materialByKey.set(id, material);
    archiveIndex++;
    return material;
  };
  const reference = (material, role) => ({ materialId: material.id, role, sha256: material.sha256, immutableRef: material.immutableRef, tool: material.tool, target: material.archiveTarget, version: material.version });
  const noticeReference = async (id, role) => ({ kind: 'notice', noticeId: id, role, sha256: await pathHash(path.join(f.root, `${id}.txt`)), immutableRef: upstreamNotices.find((notice) => notice.id === id).immutableRef });
  const filesFor = async (paths) => Promise.all(paths.map(async (file) => ({ path: file, sha256: await pathHash(path.join(f.payload, ...file.split('/'))) })));
  const nodeRuntime = await addMaterial('node-runtime-source', 'Node 24', 'source', 'node', '24.22.1');
  const nodeRecipe = await addMaterial('node-runtime-recipe', 'Node build', 'recipe', 'node', '24.22.1');
  const npmSource = await addMaterial('npm-source', 'npm 11', 'source', 'node', '11.19.1');
  const npmRecipe = await addMaterial('npm-recipe', 'npm build', 'recipe', 'node', '11.19.1');
  const corepackSource = await addMaterial('corepack-source', 'Corepack 0.36', 'source', 'node', '0.36.0');
  const corepackRecipe = await addMaterial('corepack-recipe', 'Corepack build', 'recipe', 'node', '0.36.0');
  const nodeFiles = ['runtime/win32-x64/node/LICENSE', 'runtime/win32-x64/node/node.exe'];
  const npmFiles = ['runtime/win32-x64/node/node_modules/npm/package.json'];
  const corepackFiles = ['runtime/win32-x64/node/node_modules/corepack/package.json'];
  const gitSources = [
    await addMaterial('git-package-source', 'MinGit package source git', 'source', 'git', '2.56.0.windows.2'),
    await addMaterial('git-package-patch', 'MinGit package patch git', 'patch', 'git', '2.56.0.windows.2'),
    await addMaterial('git-package-recipe', 'MinGit package recipe git', 'recipe', 'git', '2.56.0.windows.2'),
    await addMaterial('msys-package-source', 'MinGit package source msys', 'source', 'git', '2.56.0.windows.2'),
    await addMaterial('msys-package-patch', 'MinGit package patch msys', 'patch', 'git', '2.56.0.windows.2'),
    await addMaterial('msys-package-recipe', 'MinGit package recipe msys', 'recipe', 'git', '2.56.0.windows.2'),
  ];
  const fontInterSource = await addMaterial('inter-source', 'Inter fixture source', 'source', 'web', 'fixture-inter');
  const fontJetSource = await addMaterial('jetbrains-source', 'JetBrains fixture source', 'source', 'web', 'fixture-jetbrains');
  const gitFiles0 = ['runtime/win32-x64/git/LICENSE.txt', 'runtime/win32-x64/git/bin/git'];
  const gitFiles1 = ['runtime/win32-x64/git/etc/package-versions.txt'];
  const component = (id, requiredRoles, mappings) => {
    const coverage = id === 'node-source'
      ? { kind: 'files', root: 'runtime/win32-x64/node', requiredMappingKeys: ['node-runtime', 'npm-package', 'corepack-package'] }
      : id === 'mingit-component-sources'
        ? { kind: 'git-package-set', root: 'runtime/win32-x64/git' }
        : { kind: 'font-assets' };
    return { id, status: 'resolved', requiredRoles, coverage, mappings };
  };
  const mappings = [
    component('node-source', ['source', 'recipe'], [
      { key: 'node-runtime', files: await filesFor(nodeFiles), packages: [], materialRefs: [reference(nodeRuntime, 'source'), reference(nodeRecipe, 'recipe')] },
      { key: 'npm-package', files: await filesFor(npmFiles), packages: [], materialRefs: [reference(npmSource, 'source'), reference(npmRecipe, 'recipe')] },
      { key: 'corepack-package', files: await filesFor(corepackFiles), packages: [], materialRefs: [reference(corepackSource, 'source'), reference(corepackRecipe, 'recipe')] },
    ]),
    component('mingit-component-sources', ['source', 'patch', 'recipe'], [
      { key: 'package:0', files: await filesFor(gitFiles0), packages: [{ index: 0, entry: 'git 2.56.0' }], materialRefs: gitSources.slice(0, 3).map((m, i) => reference(m, ['source', 'patch', 'recipe'][i])) },
      { key: 'package:1', files: await filesFor(gitFiles1), packages: [{ index: 1, entry: 'msys2 20261024' }], materialRefs: gitSources.slice(3, 6).map((m, i) => reference(m, ['source', 'patch', 'recipe'][i])) },
    ]),
    component('font-sources', ['source', 'license'], [
      { key: 'font:web/apps/web/.next/static/media/Inter.woff2', family: 'inter', files: await filesFor(['web/apps/web/.next/static/media/Inter.woff2']), packages: [], materialRefs: [reference(fontInterSource, 'source'), await noticeReference('inter-ofl', 'license')] },
      { key: 'font:web/apps/web/.next/static/media/JetBrains.woff2', family: 'jetbrains-mono', files: await filesFor(['web/apps/web/.next/static/media/JetBrains.woff2']), packages: [], materialRefs: [reference(fontJetSource, 'source'), await noticeReference('jetbrains-mono-ofl', 'license')] },
    ]),
  ];
  const policyPath = path.join(f.root, 'trusted-fixture-policy.json');
  await writeFile(policyPath, JSON.stringify({ schemaVersion: 1, targets: { 'win32-x64': { status: 'resolved', components: mappings } } }));
  return { policyPath, materials };
};

test('collects hashed notices without asserting source correspondence', async (t) => {
  const f = await rootFixture(t);
  await mkdir(path.join(f.payload, 'runtime/licenses'), { recursive: true });
  await writeFile(path.join(f.payload, 'runtime/licenses/git'), 'Git license');
  await writeFile(path.join(f.payload, 'runtime/licenses/node'), 'Node license');
  const result = await collectSourceMaterials({ payloadRoot: f.payload, outputRoot: path.join(f.root, 'bundle'), target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest });
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.notices.length >= 2);
  assert.ok(result.notices.every((notice) => /^[a-f0-9]{64}$/.test(notice.sha256)));
  assert.equal(result.publicationEligibility, 'pending');
});

test('publication gate rejects missing source manifest', async (t) => {
  const f = await rootFixture(t);
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /source-materials|missing/i);
});

test('publication gate rejects pending correspondence while local inventory remains valid', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  await collectSourceMaterials({ payloadRoot: f.payload, outputRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, upstreamNotices, inputRoot: f.root });
  assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(path.join(f.payload, 'source-materials.json'), 'utf8')).publicationEligibility, 'pending');
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /pending|unresolved/i);
});

test('publication gate cross-checks trusted target and tool archive pins', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  await collectSourceMaterials({ payloadRoot: f.payload, outputRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, upstreamNotices, inputRoot: f.root });
  const toolsRecordPath = path.join(f.payload, 'runtime/win32-x64/tools-source.json');
  const record = JSON.parse(await (await import('node:fs/promises')).readFile(toolsRecordPath, 'utf8'));
  record.node.sha256 = 'c'.repeat(64);
  await writeFile(toolsRecordPath, JSON.stringify(record));
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /trusted|hash|pin|mismatch/i);
});

test('publication gate rejects traversal and symlink-parent escapes in material refs', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  await writeFile(path.join(f.payload, 'outside.bin'), 'x');
  await collectSourceMaterials({ payloadRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, upstreamNotices, inputRoot: f.root });
  await symlink(f.root, path.join(f.payload, 'escape'), 'junction');
  const manifestPath = path.join(f.payload, 'source-materials.json');
  const base = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
  base.materials[0] = { id: 'node-source', status: 'complete', correspondence: 'verified', version: '24.22.1', archive: { path: '../outside.bin', sha256: '2d711642b726b04401627ca9fbac32f5da7e5f4c8a32d0b4c5d7f5c8b8f8e6d5', target: 'win32-x64', version: '24.22.1', tool: 'node', immutableRef: 'v24.22.1' } };
  await writeFile(manifestPath, JSON.stringify(base));
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /unsafe|traversal|path/i);
  base.materials[0].archive.path = 'escape/outside.bin';
  await writeFile(manifestPath, JSON.stringify(base));
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /symlink|parent|unsafe/i);
});

test('collector refuses an output symlink parent without changing outside files', async (t) => {
  const f = await rootFixture(t);
  await mkdir(path.join(f.payload, 'runtime/licenses'), { recursive: true });
  await writeFile(path.join(f.payload, 'runtime/licenses/node'), 'Node license');
  const output = path.join(f.root, 'output');
  const outside = path.join(f.root, 'outside');
  await mkdir(output); await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'untouched');
  await symlink(outside, path.join(output, 'source-materials'), 'junction');
  await assert.rejects(collectSourceMaterials({ payloadRoot: f.payload, outputRoot: output, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest }), /symlink.*output path/i);
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
  await assert.rejects((await import('node:fs/promises')).readFile(path.join(outside, 'source-materials.json')));
});

test('collector aborts a source response as soon as its bounded byte limit is exceeded', async (t) => {
  const f = await rootFixture(t);
  await assert.rejects(collectSourceMaterials({
    payloadRoot: f.payload,
    outputRoot: path.join(f.root, 'bounded-output'),
    target: 'win32-x64',
    appVersion: '0.1.0',
    toolsManifestPath: f.toolsManifest,
    maxArchiveBytes: 4,
    fetchImpl: async () => {
      const response = new Response('five bytes', { status: 200, headers: { 'content-length': '10' } });
      Object.defineProperty(response, 'url', { value: 'https://nodejs.org/node.tar.gz' });
      return response;
    },
    sourceMaterials: [{ id: 'node-source', component: 'Node', status: 'pending', correspondence: 'unverified', version: '24.22.1', immutableRef: 'v24.22.1', archiveTarget: 'win32-x64', tool: 'node', url: 'https://nodejs.org/node.tar.gz' }],
  }), /bounded download size/i);
});

test('caller-declared complete material cannot override the committed pending policy', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  const archive = path.join(f.root, 'node-source.tar.gz');
  await writeFile(archive, 'fixture source archive');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update('fixture source archive').digest('hex');
  await writeFile(path.join(f.root, 'arbitrary.txt'), 'fixture source archive');
  const result = await collectSourceMaterials({ payloadRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, sourceMaterials: completeInputs(sha256), upstreamNotices, inputRoot: f.root });
  assert.equal(result.publicationEligibility, 'pending');
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /trusted.*policy|policy.*pending/i);
});

test('resolved trusted fixture policy requires exact file/package coverage and distinct bound source roles', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  const trusted = await writeResolvedFixture(f, upstreamNotices);
  const result = await collectSourceMaterials({ payloadRoot: f.payload, outputRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, policyPath: trusted.policyPath, sourceMaterials: trusted.materials, upstreamNotices, inputRoot: f.root });
  assert.equal(result.publicationEligibility, 'eligible');
  assert.equal((await validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest, policyPath: trusted.policyPath, expectedTarget: 'win32-x64', expectedAppVersion: '0.1.0' })).eligible, true);
});

test('trusted policy rejects missing shipped-file/package coverage and wrong bound hashes', async (t) => {
  for (const tamper of ['file-coverage', 'file-hash', 'package-coverage', 'source-reference']) {
    const f = await rootFixture(t);
    const upstreamNotices = await populateCompleteNotices(f);
    const trusted = await writeResolvedFixture(f, upstreamNotices);
    const policy = JSON.parse(await (await import('node:fs/promises')).readFile(trusted.policyPath, 'utf8'));
    if (tamper === 'file-coverage') policy.targets['win32-x64'].components[0].mappings[0].files.pop();
    else if (tamper === 'file-hash') policy.targets['win32-x64'].components[0].mappings[0].files[0].sha256 = 'f'.repeat(64);
    else if (tamper === 'package-coverage') policy.targets['win32-x64'].components[1].mappings[0].packages.pop();
    else policy.targets['win32-x64'].components[0].mappings[0].materialRefs[0].sha256 = 'f'.repeat(64);
    await writeFile(trusted.policyPath, JSON.stringify(policy));
    await assert.rejects(collectSourceMaterials({ payloadRoot: f.payload, outputRoot: path.join(f.root, 'bundle'), target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, policyPath: trusted.policyPath, sourceMaterials: trusted.materials, upstreamNotices, inputRoot: f.root }), /cover|trusted material reference|hash mismatch|does not match shipped file bytes/i, tamper);
  }
});

test('macOS Git inventory does not require the Windows pacman package-version file', async (t) => {
  const f = await posixFixture(t);
  const result = await collectSourceMaterials({ payloadRoot: f.payload, outputRoot: path.join(f.root, 'bundle'), target: 'darwin-arm64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest });
  assert.equal(result.gitDistribution.packageVersions, null);
  assert.equal(result.gitDistribution.shippedGitFiles.count, 1);
  assert.equal(result.publicationEligibility, 'pending');
});

test('collector rejects source and notice junction escapes under the explicit input root', async (t) => {
  for (const kind of ['source', 'notice']) {
    const f = await rootFixture(t);
    const inputRoot = path.join(f.root, 'input');
    const outside = path.join(f.root, 'outside');
    await mkdir(inputRoot); await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside secret');
    await symlink(outside, path.join(inputRoot, 'escape'), 'junction');
    const options = { payloadRoot: f.payload, outputRoot: path.join(f.root, 'bundle'), target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, inputRoot };
    if (kind === 'source') options.sourceMaterials = [{ id: 'node-source', component: 'Node', status: 'pending', version: '24.22.1', immutableRef: 'v24.22.1', archiveTarget: 'win32-x64', tool: 'node', sourcePath: 'escape/secret.txt' }];
    else options.upstreamNotices = [{ id: 'foreign-license', component: 'fixture', immutableRef: 'fixture-ref', url: 'https://github.com/example/repo/blob/fixture/LICENSE', sourcePath: 'escape/secret.txt' }];
    await assert.rejects(collectSourceMaterials(options), /symlink|unsafe.*input|escape/i, kind);
    assert.equal(await (await import('node:fs/promises')).readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside secret');
    await assert.rejects((await import('node:fs/promises')).readFile(path.join(f.root, 'bundle/source-materials/archives/node-source/secret.txt')));
  }
});

test('source and notice fetches reject final HTTP redirects even on allowlisted hosts', async (t) => {
  const f = await rootFixture(t);
  const downgrade = async () => {
    const response = new Response('fixture', { status: 200 });
    Object.defineProperty(response, 'url', { value: 'http://github.com/allowed-but-insecure' });
    return response;
  };
  await assert.rejects(collectSourceMaterials({ payloadRoot: f.payload, outputRoot: path.join(f.root, 'source-bundle'), target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, fetchImpl: downgrade, sourceMaterials: [{ id: 'node-source', component: 'Node', status: 'pending', version: '24.22.1', immutableRef: 'v24.22.1', archiveTarget: 'win32-x64', tool: 'node', url: 'https://nodejs.org/source.tar.gz' }] }), /HTTPS|redirect/i);
  await assert.rejects(collectSourceMaterials({ payloadRoot: f.payload, outputRoot: path.join(f.root, 'notice-bundle'), target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, fetchImpl: downgrade, upstreamNotices: [{ id: 'notice', component: 'fixture', immutableRef: 'fixture-commit', url: 'https://github.com/example/repo/blob/fixture/LICENSE' }] }), /HTTPS|redirect/i);
});

test('publication gate rejects changed source archive bytes and wrong correspondence version', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  const archive = path.join(f.root, 'node-source.tar.gz');
  await writeFile(archive, 'fixture source archive');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update('fixture source archive').digest('hex');
  await writeFile(path.join(f.root, 'arbitrary.txt'), 'fixture source archive');
  await collectSourceMaterials({ payloadRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, sourceMaterials: completeInputs(sha256), upstreamNotices, inputRoot: f.root });
  const manifestPath = path.join(f.payload, 'source-materials.json');
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'));
  await writeFile(path.join(f.payload, manifest.materials[0].archive.path), 'changed bytes');
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /hash mismatch/i);
  await writeFile(path.join(f.payload, manifest.materials[0].archive.path), 'fixture source archive');
  manifest.materials[0].archive.version = '9.9.9';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /target\/tool\/version mismatch|manifest/i);
});

test('publication gate requires every declared source component category', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  const archive = path.join(f.root, 'node-source.tar.gz');
  await writeFile(archive, 'fixture source archive');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update('fixture source archive').digest('hex');
  await writeFile(path.join(f.root, 'arbitrary.txt'), 'fixture source archive');
  await collectSourceMaterials({ payloadRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, sourceMaterials: completeInputs(sha256).slice(0, 1), upstreamNotices, inputRoot: f.root });
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /pending|unresolved/i);
});

test('trusted source policy rejects a self-consistent wrong source-entry tool and version', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  const trusted = await writeResolvedFixture(f, upstreamNotices);
  trusted.materials[0].tool = 'git';
  trusted.materials[0].version = '9.9.9';
  await assert.rejects(collectSourceMaterials({ payloadRoot: f.payload, outputRoot: path.join(f.root, 'bundle'), target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, policyPath: trusted.policyPath, sourceMaterials: trusted.materials, upstreamNotices, inputRoot: f.root }), /trusted material reference/i);
});

test('publication gate rejects an omitted production dependency notice instead of accepting one generic license', async (t) => {
  const f = await rootFixture(t);
  const upstreamNotices = await populateCompleteNotices(f);
  const missingPackage = path.join(f.payload, 'app/node_modules/no-license');
  await mkdir(missingPackage, { recursive: true });
  await writeFile(path.join(missingPackage, 'package.json'), JSON.stringify({ name: 'no-license', version: '4.5.6' }));
  const archive = path.join(f.root, 'node-source.tar.gz');
  await writeFile(archive, 'fixture source archive');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update('fixture source archive').digest('hex');
  await writeFile(path.join(f.root, 'arbitrary.txt'), 'fixture source archive');
  await collectSourceMaterials({ payloadRoot: f.payload, target: 'win32-x64', appVersion: '0.1.0', toolsManifestPath: f.toolsManifest, sourceMaterials: completeInputs(sha256), upstreamNotices, inputRoot: f.root });
  await assert.rejects(validatePublicationEligibility(f.payload, { toolsManifestPath: f.toolsManifest }), /production dependency notice inventory has unresolved packages/i);
});

test('release validation CLI requires an explicit native target and version', () => {
  assert.deepEqual(parseReleaseValidationArgs(['payload', 'win32-x64', '0.1.0']), { payloadRoot: path.resolve('payload'), expectedTarget: 'win32-x64', expectedAppVersion: '0.1.0' });
  assert.throws(() => parseReleaseValidationArgs(['payload', 'win32-x64']), /usage/i);
  assert.throws(() => parseReleaseValidationArgs(['payload', 'win32-arm32', '0.1.0']), /target/i);
});

test('source collection CLI requires payload, output, target, version, and an explicit source plan', () => {
  assert.deepEqual(parseSourceCollectionArgs(['payload', 'cache', 'win32-x64', '0.1.0', 'plan.json']), { payloadRoot: path.resolve('payload'), outputRoot: path.resolve('cache'), target: 'win32-x64', appVersion: '0.1.0', sourcePlanPath: path.resolve('plan.json') });
  assert.throws(() => parseSourceCollectionArgs(['payload', 'cache', 'win32-x64', '0.1.0']), /usage/i);
  assert.throws(() => parseSourceCollectionArgs(['payload', 'cache', 'win32-arm32', '0.1.0', 'plan.json']), /target/i);
});

test('collector CLI reads local archive and notice paths under a plan-relative inputRoot and rejects junction escapes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-source-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const planDir = path.join(root, 'plans');
  const inputRoot = path.join(planDir, 'materials');
  const payload = path.join(root, 'payload');
  const output = path.join(root, 'bundle');
  const target = 'win32-x64';
  const toolsManifest = JSON.parse((await (await import('node:fs/promises')).readFile(fileURLToPath(new URL('./tools-manifest.json', import.meta.url)), 'utf8')).replace(/^\uFEFF/, ''));
  await mkdir(path.join(inputRoot, 'archives'), { recursive: true });
  await mkdir(path.join(inputRoot, 'notices'), { recursive: true });
  await mkdir(path.join(payload, 'runtime', target, 'git/etc'), { recursive: true });
  const archiveBytes = Buffer.from('offline cached source archive');
  const noticeBytes = Buffer.from('offline cached upstream notice');
  await writeFile(path.join(inputRoot, 'archives/node.tar.gz'), archiveBytes);
  await writeFile(path.join(inputRoot, 'notices/THIRD-PARTY.txt'), noticeBytes);
  await writeFile(path.join(payload, 'runtime', target, 'git/etc/package-versions.txt'), 'git 2.56.0\nmsys2 20261024\n');
  await writeFile(path.join(payload, 'runtime-manifest.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', platform: 'win32', arch: 'x64' }));
  await writeFile(path.join(payload, 'runtime', target, 'tools-source.json'), JSON.stringify({
    schemaVersion: 1,
    target,
    node: { version: toolsManifest.node.version, archive: toolsManifest.node.archive[target].file, sha256: toolsManifest.node.archive[target].sha256 },
    git: { version: toolsManifest.git.version, gitForWindowsVersion: toolsManifest.git.gitForWindowsVersion, dugiteNativeVersion: toolsManifest.git.dugiteNativeVersion, archive: toolsManifest.git.archives[target].file, sha256: toolsManifest.git.archives[target].sha256 },
  }));
  const planPath = path.join(planDir, 'source-plan.json');
  const sha256 = (await import('node:crypto')).createHash('sha256');
  const plan = {
    schemaVersion: 1,
    inputRoot: 'materials',
    sourceMaterials: [{ id: 'node-source', component: 'Node fixture', status: 'pending', correspondence: 'unverified', reason: 'CLI fixture only', version: toolsManifest.node.version, immutableRef: 'v24.22.1', archiveTarget: target, tool: 'node', sourcePath: 'archives/node.tar.gz', sha256: sha256.update(archiveBytes).digest('hex') }],
    upstreamNotices: [{ id: 'offline-sample', component: 'fixture notice', immutableRef: 'fixture-commit', url: 'https://github.com/example/repo/blob/fixture/LICENSE', sourcePath: 'notices/THIRD-PARTY.txt' }],
  };
  await writeFile(planPath, JSON.stringify(plan));
  const cli = fileURLToPath(new URL('./collect-source-materials.mjs', import.meta.url));
  const run = (planFile, outputDir) => spawnSync(process.execPath, [cli, payload, outputDir, target, '0.1.0', planFile], { cwd: root, encoding: 'utf8' });

  const collected = run(planPath, output);
  assert.equal(collected.status, 0, collected.stderr);
  assert.match(collected.stdout, /publication pending/i);
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(output, 'source-materials.json'), 'utf8'));
  const materialArchive = path.join(output, ...manifest.materials[0].archive.path.split('/'));
  const stagedNotice = path.join(output, ...manifest.notices.find((item) => item.sourcePath === 'upstream:offline-sample').bundlePath.split('/'));
  assert.deepEqual(await (await import('node:fs/promises')).readFile(materialArchive), archiveBytes);
  assert.deepEqual(await (await import('node:fs/promises')).readFile(stagedNotice), noticeBytes);

  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'untouched');
  await symlink(outside, path.join(inputRoot, 'escape'), 'junction');
  const escapedPlan = { ...plan, upstreamNotices: [{ ...plan.upstreamNotices[0], sourcePath: 'escape/sentinel.txt' }] };
  const escapedPlanPath = path.join(planDir, 'escaped-plan.json');
  await writeFile(escapedPlanPath, JSON.stringify(escapedPlan));
  const escaped = run(escapedPlanPath, path.join(root, 'escaped-bundle'));
  assert.notEqual(escaped.status, 0);
  assert.match(escaped.stderr, /symlink|unsafe/i);
  assert.equal(await (await import('node:fs/promises')).readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'untouched');
});

test('collector CLI preserves five-argument operation for plans without local source paths', async (t) => {
  const f = await rootFixture(t);
  const planPath = path.join(f.root, 'url-only-plan.json');
  await writeFile(planPath, JSON.stringify({ schemaVersion: 1, sourceMaterials: [], upstreamNotices: [] }));
  const cli = fileURLToPath(new URL('./collect-source-materials.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, f.payload, path.join(f.root, 'bundle'), 'win32-x64', '0.1.0', planPath], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publication pending/i);
});
