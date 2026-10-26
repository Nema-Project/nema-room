import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPaths, gatePasses } from './policy.mjs';

test('only the documentation allowlist skips application verification', () => {
  for (const paths of [['README.md', 'docs/guide.zh.md'], ['site/index.html'], ['.github/workflows/pages.yml']]) {
    assert.equal(classifyPaths(paths), 'docs');
  }
  for (const paths of [[], ['README.md', 'apps/hub/src/app.ts'], ...[
    'AGENTS.md', 'CLAUDE.md', 'docs/AGENTS.md', 'site/nested/CLAUDE.md',
    'vendor/rules.md', 'package-lock.json', '.github/workflows/ci.yml', 'unknown',
    'docs/../scripts/x.mjs', '/docs/a.md', 'docs/a.js', 'docs/run.sh',
  ].map(p => [p])]) assert.equal(classifyPaths(paths), 'full', JSON.stringify(paths));
  for (const paths of [null, 'README.md', [null], [''], ['a\0b']]) assert.throws(() => classifyPaths(paths));
});

test('every required failure, cancellation, skip or missing result blocks CI', () => {
  const good = {mode: 'full', classify: 'success', docs: 'success', verify: 'success'};
  assert.equal(gatePasses(good), true);
  for (const mode of ['full', 'docs']) {
    for (const key of ['classify', 'docs', 'verify']) {
      for (const result of ['failure', 'cancelled', 'skipped', undefined, 'unknown']) {
        assert.equal(gatePasses({...good, mode, [key]: result}), mode === 'docs' && key === 'verify' && result === 'skipped', `${mode}/${key}/${result}`);
      }
    }
  }
  assert.equal(gatePasses({...good, mode: 'docs'}), true);
  for (const mode of ['', undefined, 'unknown']) assert.equal(gatePasses({...good, mode}), false);
});
