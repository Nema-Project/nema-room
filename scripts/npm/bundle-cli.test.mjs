import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundleCli } from './bundle-cli.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharedMarker = 'nema-local-v1';

async function filesUnder(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(abs));
    else if (entry.name.endsWith('.js')) out.push(abs);
  }
  return out;
}

function countMarker(texts) {
  return texts.reduce((n, text) => n + text.split(sharedMarker).length - 1, 0);
}

async function fixtureDist(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await mkdir(path.join(dist, 'direct'), { recursive: true });
  await mkdir(path.join(dist, 'report'), { recursive: true });
  await writeFile(path.join(dist, 'index.js'), [
    'import { parseHubToDaemon } from "@nema/shared";',
    'import { Command } from "commander";',
    'import "./direct/siwc.js";',
    'export { parseHubToDaemon, Command };',
    '',
  ].join('\n'));
  await writeFile(path.join(dist, 'direct', 'siwc.js'), [
    'import { parseDaemonToHub } from "@nema/shared";',
    'import { LOCAL_INSTANCE_PROTOCOL } from "@nema/shared/localInstance";',
    'export function cliVersion() {',
    '  return new URL("../../package.json", import.meta.url).href;',
    '}',
    'export const marker = LOCAL_INSTANCE_PROTOCOL;',
    'export const parse = parseDaemonToHub;',
    '',
  ].join('\n'));
  await writeFile(path.join(dist, 'report', 'install.js'), [
    'import { z } from "zod";',
    'export const skillSource = () => new URL("../../src/report/SKILL.md", import.meta.url);',
    'export { z };',
    '',
  ].join('\n'));
  await writeFile(path.join(dist, 'other.js'), [
    'import { runHelperFile } from "@nema/shared/ownedHelper";',
    'import { LOCAL_INSTANCE_PROTOCOL } from "@nema/shared/localInstance";',
    'export const helper = runHelperFile;',
    'export const protocol = LOCAL_INSTANCE_PROTOCOL;',
    '',
  ].join('\n'));
  return dist;
}

function assertBundledShape(dist, textsByFile) {
  const files = [...textsByFile.keys()];
  const texts = [...textsByFile.values()];
  const joined = texts.join('\n');
  assert.equal(joined.includes('@nema/shared'), false, 'external @nema/shared import remains');
  assert.equal(countMarker(texts), 1, 'shared marker should appear once');
  assert.ok(textsByFile.has(path.join(dist, 'index.js')));
  assert.ok(textsByFile.has(path.join(dist, 'direct', 'siwc.js')));
  assert.ok(textsByFile.has(path.join(dist, 'report', 'install.js')));
  for (const text of texts) {
    assert.match(text, /\bimport\b/);
    assert.doesNotMatch(text, /(?:^|\n)\s*\(function\s*\(|!\s*function\s*\(/);
  }
  assert.match(joined, /from ["']commander["']/);
  assert.match(joined, /from ["']zod["']/);
  const chunks = files.filter((file) => file.includes(`${path.sep}chunks${path.sep}`));
  assert.ok(chunks.length >= 1, 'expected a shared chunk');
  for (const chunk of chunks) {
    const text = textsByFile.get(chunk);
    assert.doesNotMatch(text, /import\.meta\.url/);
    assert.doesNotMatch(text, /SKILL\.md/);
    assert.doesNotMatch(text, /function cliVersion/);
    assert.match(text, /nema-local-v1|parseDaemonToHub|parseHubToDaemon|runHelperFile/);
  }
  for (const rel of ['direct/siwc.js', 'report/install.js']) {
    const text = readFileSync(path.join(dist, rel), 'utf8');
    assert.match(text, /import\.meta\.url/);
  }
}

test('bundle keeps CLI files in place and emits @nema/shared once', async (t) => {
  const shared = spawnSync(process.execPath, [path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', '--pretty', 'false'], {
    cwd: path.join(repo, 'packages/shared'),
    encoding: 'utf8',
  });
  assert.equal(shared.status, 0, shared.stderr || shared.stdout);
  const dist = await fixtureDist(t);
  await bundleCli({ distDir: dist, nodePaths: [path.join(repo, 'node_modules')] });
  const files = await filesUnder(dist);
  const textsByFile = new Map();
  for (const file of files) textsByFile.set(file, await readFile(file, 'utf8'));
  assertBundledShape(dist, textsByFile);
});

test('real dist modules that read import.meta.url stay on their original paths', async (t) => {
  const cli = path.join(repo, 'apps/cli');
  const tsc = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
  // A previous bundle rewrites dist in place; tsc -b would then treat that output as fresh.
  const clean = spawnSync(process.execPath, [tsc, '-b', '--clean'], { cwd: cli, encoding: 'utf8' });
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  const compiled = spawnSync(process.execPath, [tsc, '-b', '--pretty', 'false'], { cwd: cli, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-bundle-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await cp(path.join(cli, 'dist'), dist, { recursive: true });
  const before = (await filesUnder(dist)).filter((file) => readFileSync(file, 'utf8').includes('import.meta.url'));
  const relative = before.map((file) => path.relative(dist, file)).sort();
  assert.ok(relative.includes(path.join('direct', 'siwc.js')));
  assert.ok(relative.includes(path.join('report', 'install.js')));
  assert.ok(relative.includes('index.js'));
  await bundleCli({ distDir: dist });
  const files = await filesUnder(dist);
  const textsByFile = new Map();
  for (const file of files) textsByFile.set(file, await readFile(file, 'utf8'));
  for (const rel of relative) {
    const text = textsByFile.get(path.join(dist, rel));
    assert.ok(text, `missing original module ${rel}`);
    assert.match(text, /import\.meta\.url/);
  }
  const chunks = files.filter((file) => file.includes(`${path.sep}chunks${path.sep}`));
  assert.ok(chunks.length >= 1);
  for (const chunk of chunks) {
    const text = textsByFile.get(chunk);
    assert.doesNotMatch(text, /import\.meta\.url/);
    assert.doesNotMatch(text, /SKILL\.md/);
    assert.doesNotMatch(text, /function cliVersion/);
  }
  const texts = [...textsByFile.values()];
  assert.equal(texts.join('\n').includes('@nema/shared'), false);
  assert.equal(countMarker(texts), 1);
});
