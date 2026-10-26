import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedPaths } from './changes.mjs';

test('complete NUL-delimited diff preserves strange names, deletions and both rename paths', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ci-diff-'));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();
  git('init', '-q'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture');
  await writeFile(join(cwd, 'executable.sh'), 'echo example\n');
  await writeFile(join(cwd, 'deleted.md'), 'old');
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  await rename(join(cwd, 'executable.sh'), join(cwd, 'README.md'));
  await rm(join(cwd, 'deleted.md'));
  const names = [...Array.from({length:350}, (_,i) => `doc-${i}.md`), '空 格.md', 'line\nbreak.md', '$(touch injected).md'];
  for (const name of names) await writeFile(join(cwd, name), 'test');
  git('add', '.'); git('commit', '-qm', 'head'); const head = git('rev-parse', 'HEAD');
  assert.deepEqual(new Set(await changedPaths({cwd, base, head})), new Set([...names, 'executable.sh', 'README.md', 'deleted.md']));
  await assert.rejects(changedPaths({cwd, base:'HEAD; echo injected', head}));
  await assert.rejects(changedPaths({cwd, base:'f'.repeat(40), head}));
});
