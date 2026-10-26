import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from './docs-check.mjs';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'ci-docs-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), {recursive:true});
    await writeFile(join(root, path), content);
  }
  return root;
}

test('relative and repository-root links resolve while remote links, anchors and code are ignored', async t => {
  const root = await fixture(t, {'README.md':'ok', 'docs/a.md': '[up](../README.md) [root](/README.md#x) [fragment](#x) [web](https://example.com/no) ` [code](missing) `\n```md\n[x](missing)\n```\n', 'site/index.html':'<a href="../README.md">ok</a><img src="https://example.com/a.png">'});
  assert.deepEqual(await checkDocs({root, paths:['docs/a.md', 'site/index.html', 'deleted.md']}), []);
});

test('broken changed-document and HTML links fail even if target was deleted', async t => {
  const root = await fixture(t, {'docs/a.md':'[missing](deleted.md)', 'site/index.html':'<img src="missing.png">'});
  const errors = await checkDocs({root, paths:['docs/a.md','site/index.html','docs/deleted.md']});
  assert.equal(errors.length, 2); assert.match(errors.join('\n'), /deleted.md/); assert.match(errors.join('\n'), /missing.png/);
});

test('unsupported reference links are reported, and path traversal fails', async t => {
  const root = await fixture(t, {'docs/a.md':'[label][target]\n[target]: elsewhere.md'});
  assert.match((await checkDocs({root, paths:['docs/a.md']})).join('\n'), /unsupported/i);
  await assert.rejects(checkDocs({root, paths:['../outside.md']}));
});
