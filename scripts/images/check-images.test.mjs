import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { devComposeUpArgs } from '../compose-dev.mjs';
import { assertComposeTemplate, assertComposeAsset, renderComposeAsset, composeAssetVersion, assertImageBudget, assertPackageVersions, IMAGE_BUDGET_BYTES, shouldMoveLatest } from './check-images.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const template = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
const desktopVersion = JSON.parse(readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')).version;
const asset = renderComposeAsset(template, desktopVersion);

function composeConfig(files, env = {}) {
  const base = { ...process.env };
  if (!Object.hasOwn(env, 'NEMA_HUB_URL')) delete base.NEMA_HUB_URL;
  if (!Object.hasOwn(env, 'NEMA_IMAGE_TAG')) delete base.NEMA_IMAGE_TAG;
  const run = spawnSync('docker', ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'], {
    cwd: root,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('template shape assertions and asset version assertions reject drifted fixtures', () => {
  assert.doesNotThrow(() => assertComposeTemplate(template));
  assert.doesNotThrow(() => assertComposeAsset(asset, desktopVersion));
  assert.throws(() => assertComposeAsset(asset.replaceAll(`:${desktopVersion}`, ':latest'), desktopVersion), /latest/);
  assert.throws(() => assertComposeAsset(asset.replace('nema-room-hub', 'nema-room-other'), desktopVersion), /missing/);
  assert.throws(() => assertComposeTemplate(template.replace('image: ghcr.io/nema-project/nema-room-hub:${NEMA_IMAGE_TAG:-latest}', 'image: ghcr.io/nema-project/nema-room-hub:0.1.5')), /NEMA_IMAGE_TAG/);
  const withBuild = template.replace('image: ghcr.io/nema-project/nema-room-hub', 'build:\n      context: .\n    image: ghcr.io/nema-project/nema-room-hub');
  assert.throws(() => assertComposeTemplate(withBuild), /hub must not build/);
  assert.throws(() => assertComposeTemplate(template.replace('127.0.0.1:${NEMA_HUB_PORT:-4400}:${NEMA_HUB_PORT:-4400}', '127.0.0.1:4400:4400')), /NEMA_HUB_PORT/);
});

test('package versions must match the release tag', () => {
  assert.equal(assertPackageVersions({ tag: 'v1.2.3', desktop: '1.2.3', local: '1.2.3', cli: '1.2.3' }), '1.2.3');
  assert.throws(() => assertPackageVersions({ tag: 'v1.2.3', desktop: '1.2.3', local: '1.2.4', cli: '1.2.3' }), /desktop 1\.2\.3, local 1\.2\.4, cli 1\.2\.3/);
  assert.throws(() => assertPackageVersions({ tag: '1.2.3', desktop: '1.2.3', local: '1.2.3', cli: '1.2.3' }), /v<SemVer>/);
  assert.throws(() => assertPackageVersions({ tag: 'v1.2', desktop: '1.2', local: '1.2', cli: '1.2' }), /strict SemVer/);
});

test('latest moves only when the candidate is not older', () => {
  assert.equal(shouldMoveLatest('', '0.1.4'), true);
  assert.equal(shouldMoveLatest(null, '0.1.4'), true);
  assert.equal(shouldMoveLatest('0.1.3', '0.1.3'), true);
  assert.equal(shouldMoveLatest('0.1.3', '0.1.10'), true);
  assert.equal(shouldMoveLatest('0.1.4', '0.1.3'), false);
  assert.equal(shouldMoveLatest('1.0.0-rc.1', '1.0.0'), true);
  assert.equal(shouldMoveLatest('1.0.0', '1.0.0-rc.2'), false);
  assert.throws(() => shouldMoveLatest('latest', '0.1.3'), /Not a release version/);
  const move = spawnSync(process.execPath, ['scripts/images/check-images.mjs', '--move-latest', '0.1.3', '0.2.0'], { cwd: root, encoding: 'utf8' });
  assert.equal(move.status, 0, move.stderr);
  assert.equal(move.stdout, 'move\n');
  const keep = spawnSync(process.execPath, ['scripts/images/check-images.mjs', '--move-latest', '0.2.0', '0.1.9'], { cwd: root, encoding: 'utf8' });
  assert.equal(keep.status, 0, keep.stderr);
  assert.equal(keep.stdout, 'keep\n');
});

test('image budget fails closed above 800 MiB', () => {
  assert.match(assertImageBudget('hub', IMAGE_BUDGET_BYTES), /^image size: hub 800\.0 MiB$/);
  assert.throws(() => assertImageBudget('web', IMAGE_BUDGET_BYTES + 1), /image size: web 800\.0 MiB exceeds 800 MiB/);
  assert.throws(() => assertImageBudget('hub', -1), /byte count/);
});

test('repository compose file matches the desktop version', () => {
  const run = spawnSync(process.execPath, ['scripts/images/check-images.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`image versions: ${desktopVersion}`));
  const wrong = spawnSync(process.execPath, ['scripts/images/check-images.mjs', 'v0.0.1'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /desktop .* local .* cli /);
});

test('ports and the hub URL follow env on the published file and the source build', () => {
  const plain = composeConfig(['docker-compose.yml']);
  assert.equal(plain.services.hub.build, undefined);
  assert.equal(plain.services.web.build, undefined);
  assert.equal(plain.services.hub.image, 'ghcr.io/nema-project/nema-room-hub:latest');
  assert.equal(plain.services.web.image, 'ghcr.io/nema-project/nema-room-web:latest');
  assert.equal(plain.services.postgres.image, 'postgres:17');
  assert.equal(plain.services.hub.ports.length, 1);
  assert.equal(String(plain.services.hub.ports[0].published), '4400');
  assert.equal(plain.services.hub.ports[0].target, 4400);
  assert.equal(String(plain.services.web.ports[0].published), '3000');
  assert.ok(plain.services.hub.healthcheck);
  assert.ok(plain.services.web.healthcheck);

  const pinned = composeConfig(['docker-compose.yml'], { NEMA_IMAGE_TAG: '9.9.9' });
  assert.equal(pinned.services.hub.image, 'ghcr.io/nema-project/nema-room-hub:9.9.9');
  assert.equal(pinned.services.web.image, 'ghcr.io/nema-project/nema-room-web:9.9.9');

  const moved = composeConfig(['docker-compose.yml'], { NEMA_HUB_PORT: '4410', NEMA_WEB_PORT: '3010' });
  assert.equal(String(moved.services.hub.ports[0].published), '4410');
  assert.equal(moved.services.hub.ports[0].target, 4410);
  assert.equal(String(moved.services.hub.environment.NEMA_HUB_PORT), '4410');
  assert.equal(moved.services.web.environment.NEMA_HUB_URL, 'http://127.0.0.1:4410');
  assert.equal(String(moved.services.web.ports[0].published), '3010');
  assert.equal(moved.services.web.ports[0].target, 3000);
  assert.match(String(moved.services.hub.environment.NEMA_WEB_ORIGIN), /127\.0\.0\.1:3010/);
  const customUrl = composeConfig(['docker-compose.yml'], { NEMA_HUB_PORT: '4410', NEMA_HUB_URL: 'http://127.0.0.1:9999' });
  assert.equal(customUrl.services.web.environment.NEMA_HUB_URL, 'http://127.0.0.1:9999');

  const built = composeConfig(['docker-compose.yml', 'docker-compose.build.yml'], { NEMA_HUB_PORT: '5500' });
  assert.equal(built.services.hub.ports.length, 1);
  assert.equal(String(built.services.hub.ports[0].published), '5500');
  assert.equal(built.services.hub.ports[0].target, 5500);
  assert.equal(String(built.services.hub.environment.NEMA_HUB_PORT), '5500');
  assert.equal(built.services.web.environment.NEMA_HUB_URL, 'http://127.0.0.1:5500');
  assert.equal(built.services.hub.build.target, 'hub');
  assert.equal(built.services.web.build.target, 'web');
  assert.equal(built.services.web.build.args, undefined);
  assert.equal(String(built.services.web.ports[0].published), '3000');
});

test('npm run up and the setup wizard build from source', () => {
  assert.deepEqual(devComposeUpArgs(), ['compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.build.yml', 'up', '-d', '--build']);
  const up = readFileSync(new URL('../up.mjs', import.meta.url), 'utf8');
  const setup = readFileSync(new URL('../setup.mjs', import.meta.url), 'utf8');
  assert.match(up, /devComposeUpArgs\(/);
  assert.match(setup, /devComposeUpArgs\(/);
});

test('renderComposeAsset replaces the template header with one that names the pinned version', () => {
  // A Windows checkout with core.autocrlf can read the template with CRLF endings.
  const lfTemplate = template.replace(/\r\n/g, '\n');
  assert.match(lfTemplate, /^# This compose file is a template, not an installable version\.\n/);
  const rendered = renderComposeAsset(template, '1.2.3');
  assert.doesNotMatch(rendered, /is a template|not an installable version/);
  assert.match(rendered, /^# Nema Room 1\.2\.3 release asset\. Hub and web are pinned to 1\.2\.3\.\n/);
  assert.match(rendered.split('\n\n')[0], /NEMA_IMAGE_TAG=1\.2\.3/);
  assert.match(rendered.split('\n\n')[0], /@nema-project\/nema@1\.2\.3/);
  assert.equal(rendered.slice(rendered.indexOf('\nservices:')), lfTemplate.slice(lfTemplate.indexOf('\nservices:')).replaceAll('${NEMA_IMAGE_TAG:-latest}', '1.2.3'));
  assert.equal(renderComposeAsset(lfTemplate.replace(/\n/g, '\r\n'), '1.2.3'), rendered);
  assert.equal(composeAssetVersion(rendered), '1.2.3');
  assert.throws(() => renderComposeAsset(`services:\n# This compose file is a template, not an installable version.\n${template.slice(template.indexOf('\nservices:') + 10)}`, '1.2.3'), /template header/i);
});

test('renderComposeAsset pins both images and rejects a template without interpolation', async () => {
  assert.ok(!renderComposeAsset(template, '1.2.3').includes(':-latest'));
  assert.throws(() => renderComposeAsset('image: x:y', '1.2.3'));
  assert.throws(() => renderComposeAsset(template.replace('${NEMA_IMAGE_TAG:-latest}', '${NEMA_IMAGE_TAG}'), '1.2.3'));
  assert.throws(() => renderComposeAsset(template, 'latest'));
});

test('composeAssetVersion reads the shared pin', async () => {
  assert.equal(composeAssetVersion(asset), desktopVersion);
  assert.throws(() => composeAssetVersion(asset.replace(`nema-room-hub:${desktopVersion}`, 'nema-room-hub:1.2.3')), new RegExp(`1\\.2\\.3.*${desktopVersion.replaceAll('.', '\\.')}`));
});

for (const name of ['hub', 'web']) {
  const addDuplicate = (text) => text.replace(
    new RegExp(`(    image: ghcr.io/nema-project/nema-room-${name}:[^\\n]+)`),
    '$1\n    image: ghcr.io/nema-project/nema-room-' + name + ':9.9.9',
  );
  test(`template rejects duplicate ${name} image keys`, () => {
    assert.throws(() => assertComposeTemplate(addDuplicate(template)), /image/);
  });
  test(`asset rejects duplicate ${name} image keys`, () => {
    assert.throws(() => assertComposeAsset(addDuplicate(asset), desktopVersion), /image/);
  });
  test(`asset version rejects duplicate ${name} image keys`, () => {
    assert.throws(() => composeAssetVersion(addDuplicate(asset)), /image/);
  });
}
