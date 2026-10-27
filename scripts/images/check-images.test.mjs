import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { devComposeUpArgs } from '../compose-dev.mjs';
import { assertComposeImages, assertImageBudget, assertPackageVersions, IMAGE_BUDGET_BYTES, shouldMoveLatest } from './check-images.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const published = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
const desktopVersion = JSON.parse(readFileSync(new URL('../../apps/desktop/package.json', import.meta.url), 'utf8')).version;

function composeConfig(files, env = {}) {
  const base = { ...process.env };
  if (!Object.hasOwn(env, 'NEMA_HUB_URL')) delete base.NEMA_HUB_URL;
  const run = spawnSync('docker', ['compose', ...files.flatMap((file) => ['-f', file]), 'config', '--format', 'json'], {
    cwd: root,
    env: { ...base, ...env },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('published compose pins hub and web and rejects drifted fixtures', () => {
  assert.doesNotThrow(() => assertComposeImages(published, desktopVersion));
  assert.throws(() => assertComposeImages(published.replaceAll(`:${desktopVersion}`, ':latest'), desktopVersion), /latest tag/);
  assert.throws(() => assertComposeImages(published.replace('nema-room-hub', 'nema-room-other'), desktopVersion), /missing/);
  const withBuild = published.replace('image: ghcr.io/nema-project/nema-room-hub', 'build:\n      context: .\n    image: ghcr.io/nema-project/nema-room-hub');
  assert.throws(() => assertComposeImages(withBuild, desktopVersion), /hub must not build/);
  assert.throws(() => assertComposeImages(published.replace('127.0.0.1:${NEMA_HUB_PORT:-4400}:${NEMA_HUB_PORT:-4400}', '127.0.0.1:4400:4400'), desktopVersion), /NEMA_HUB_PORT/);
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
  assert.equal(plain.services.hub.image, `ghcr.io/nema-project/nema-room-hub:${desktopVersion}`);
  assert.equal(plain.services.web.image, `ghcr.io/nema-project/nema-room-web:${desktopVersion}`);
  assert.equal(plain.services.postgres.image, 'postgres:17');
  assert.equal(plain.services.hub.ports.length, 1);
  assert.equal(String(plain.services.hub.ports[0].published), '4400');
  assert.equal(plain.services.hub.ports[0].target, 4400);
  assert.equal(String(plain.services.web.ports[0].published), '3000');
  assert.ok(plain.services.hub.healthcheck);
  assert.ok(plain.services.web.healthcheck);

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
