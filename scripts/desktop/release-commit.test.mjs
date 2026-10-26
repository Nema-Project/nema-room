import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveReleaseCommit } from './release-commit.mjs';

test('release resolver peels tags, allows main ancestors and rejects unmerged/missing/unsafe refs', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'release-commit-'));
  t.after(() => rm(cwd, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', args, {cwd, encoding:'utf8'}).trim();
  git('init','-q','-b','main'); git('config','user.email','fixture@example.com'); git('config','user.name','Fixture');
  git('commit','--allow-empty','-qm','initial'); const first = git('rev-parse','HEAD');
  git('tag','v1.0.0'); git('tag','-a','v1.0.1','-m','annotated');
  git('commit','--allow-empty','-qm','next');
  for (const ref of ['v1.0.0','v1.0.1',first]) assert.equal(await resolveReleaseCommit({cwd,ref,mainRef:'main'}),first);
  git('checkout','-qb','feature'); git('commit','--allow-empty','-qm','unmerged'); git('tag','off-main');
  for (const [ref,mainRef] of [['off-main','main'],['missing','main'],['v1.0.0','missing'],['--help','main'],['main; touch injected','main'],['main^{tree}','main']]) await assert.rejects(resolveReleaseCommit({cwd,ref,mainRef}));
});

test('remote tag movement or deletion after preflight cannot pass publication revalidation', async t => {
  const { verifyRemoteReleaseTag } = await import('./release-commit.mjs');
  assert.equal(typeof verifyRemoteReleaseTag, 'function');
  const cwd=await mkdtemp(join(tmpdir(),'release-remote-'));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q','-b','main');git('config','user.email','fixture@example.com');git('config','user.name','Fixture');
  git('commit','--allow-empty','-qm','verified');const commit=git('rev-parse','HEAD');
  git('clone','--bare','.',join(cwd,'remote.git'));git('remote','add','origin',join(cwd,'remote.git'));
  git('tag','-a','v1.2.3','-m','annotated');git('push','origin','refs/tags/v1.2.3');
  await verifyRemoteReleaseTag({cwd,ref:'refs/tags/v1.2.3',commit});
  git('commit','--allow-empty','-qm','unchecked');git('tag','-f','v1.2.3');git('push','--force','origin','refs/tags/v1.2.3');
  await assert.rejects(verifyRemoteReleaseTag({cwd,ref:'refs/tags/v1.2.3',commit}),/moved|mismatch/i);
  git('push','origin',':refs/tags/v1.2.3');
  await assert.rejects(verifyRemoteReleaseTag({cwd,ref:'refs/tags/v1.2.3',commit}));
});
