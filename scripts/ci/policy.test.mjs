import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPaths, gatePasses } from './policy.mjs';

const heavy = result => ({platform: result.platform, npmPack: result.npmPack, desktop: result.desktop, image: result.image});
const none = {platform: false, npmPack: false, desktop: false, image: false};

test('documentation allowlist stays docs and does not request heavy jobs', () => {
  for (const paths of [['README.md', 'docs/guide.zh.md'], ['site/index.html'], ['.github/workflows/pages.yml']]) {
    const result = classifyPaths(paths);
    assert.equal(result.mode, 'docs', JSON.stringify(paths));
    assert.deepEqual(heavy(result), none);
  }
});

test('agent instructions take the docs lane and do not request heavy jobs', () => {
  for (const paths of [['AGENTS.md'], ['CLAUDE.md'], ['docs/AGENTS.md'], ['site/nested/CLAUDE.md']]) {
    const result = classifyPaths(paths);
    assert.equal(result.mode, 'docs', JSON.stringify(paths));
    assert.deepEqual(heavy(result), none);
  }
});

test('changelog fragments are documentation and do not downgrade code', () => {
  const only = classifyPaths(['changelog.d/70.changed.md']);
  assert.equal(only.mode, 'docs');
  assert.deepEqual(heavy(only), none);
  assert.equal(classifyPaths(['changelog.d/nested/70.changed.md']).mode, 'docs');
  const mixed = classifyPaths(['changelog.d/70.changed.md', 'apps/desktop/main.cjs']);
  assert.equal(mixed.mode, 'app');
  assert.equal(mixed.platform, true);
  assert.equal(mixed.desktop, true);
  assert.equal(mixed.npmPack, false);
  assert.equal(mixed.image, false);
  assert.notEqual(classifyPaths(['changelog.d/70.changed.txt']).mode, 'docs');
});

test('markdown under desktop and image scripts requests no heavy job', () => {
  for (const path of ['scripts/desktop/RELEASE.md', 'scripts/desktop/README.md', 'scripts/images/RELEASE.md', 'scripts/desktop/notes/x.md']) {
    const result = classifyPaths([path]);
    assert.equal(result.mode, 'app', path);
    assert.deepEqual(heavy(result), none, path);
  }
  const script = classifyPaths(['scripts/desktop/smoke-desktop.test.mjs']);
  assert.equal(script.platform, true);
  assert.equal(script.desktop, true);
});

test('empty or unsafe paths fail closed onto the full suite', () => {
  for (const paths of [[], ['docs//guide.md'], ['docs/guide.md/'], ['docs/./a.md'], ['docs/../scripts/x.mjs'], ['/docs/a.md'], ['docs\\a.md']]) {
    assert.equal(classifyPaths(paths).mode, 'full', JSON.stringify(paths));
  }
});

test('path classes match the fast-gate table', () => {
  for (const path of ['apps/web/app/page.tsx', 'apps/hub/src/app.ts', 'vendor/rules.md', 'unknown', 'docs/a.js']) {
    const result = classifyPaths([path]);
    assert.equal(result.mode, 'app', path);
    assert.deepEqual(heavy(result), none, path);
  }
  const cli = classifyPaths(['apps/cli/src/index.ts']);
  assert.equal(cli.platform, true);
  assert.equal(cli.npmPack, true);
  assert.equal(cli.desktop, false);
  const shared = classifyPaths(['packages/shared/src/index.ts']);
  assert.deepEqual(heavy(shared), {platform: false, npmPack: true, desktop: false, image: false});
  for (const path of ['packages/knowledge/src/store.ts', 'scripts/security/reporting-status.test.mjs']) {
    assert.deepEqual(heavy(classifyPaths([path])), {platform: true, npmPack: false, desktop: false, image: false}, path);
  }
  for (const path of ['apps/desktop/package.json', 'scripts/desktop/smoke-desktop.test.mjs']) {
    assert.equal(classifyPaths([path]).platform, true, path);
    assert.equal(classifyPaths([path]).desktop, true, path);
  }
  const lock = classifyPaths(['package-lock.json']);
  assert.equal(lock.platform, true);
  assert.equal(lock.npmPack, true);
  assert.equal(lock.desktop, false);
  for (const path of ['Dockerfile', 'scripts/images/smoke-compose.mjs']) {
    assert.deepEqual(heavy(classifyPaths([path])), {platform: false, npmPack: false, desktop: false, image: true}, path);
  }
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/verify.yml', 'scripts/ci/policy.mjs']) {
    assert.equal(classifyPaths([path]).platform, true, path);
    assert.equal(classifyPaths([path]).npmPack, true, path);
  }
  assert.equal(classifyPaths(['README.md', 'apps/web/app/page.tsx']).mode, 'app');
  for (const paths of [null, 'README.md', [null], [''], ['a\0b']]) assert.throws(() => classifyPaths(paths));
});

test('gate accepts a skipped heavy job only when that class was not required', () => {
  const ok = {classify: 'success', docs: 'success', lint: 'success'};
  const docs = {...ok, mode: 'docs', app: 'skipped', platform: 'skipped', npmPack: 'skipped', platformRequired: false, npmPackRequired: false};
  assert.equal(gatePasses(docs), true);
  assert.equal(gatePasses({...docs, platformRequired: true}), false);
  assert.equal(gatePasses({...docs, npmPackRequired: true}), false);
  const app = {...ok, mode: 'app', app: 'success', platform: 'skipped', npmPack: 'skipped', platformRequired: false, npmPackRequired: false};
  assert.equal(gatePasses(app), true);
  assert.equal(gatePasses({...app, platformRequired: true}), false);
  assert.equal(gatePasses({...app, platform: 'success', platformRequired: true}), true);
  assert.equal(gatePasses({...app, platform: 'success', platformRequired: false}), true);
  for (const platformRequired of ['', undefined, 'maybe']) assert.equal(gatePasses({...app, platformRequired}), false, String(platformRequired));
  const full = {...ok, mode: 'full', app: 'success', platform: 'success', npmPack: 'success', platformRequired: true, npmPackRequired: true};
  assert.equal(gatePasses(full), true);
  assert.equal(gatePasses({...full, platformRequired: ''}), false);
  assert.equal(gatePasses({...full, platformRequired: undefined}), false);
  assert.equal(gatePasses({...full, npmPackRequired: ''}), false);
  for (const lint of ['skipped', 'failure', 'cancelled']) assert.equal(gatePasses({...full, lint}), false, lint);
  for (const key of ['classify', 'docs', 'lint', 'app', 'platform', 'npmPack']) {
    for (const result of ['failure', 'cancelled', '', undefined, 'unknown']) {
      assert.equal(gatePasses({...full, [key]: result}), false, `${key}/${String(result)}`);
    }
  }
});
