import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { assessBundle, assessHubProbe, assessServedHubUrl, assessWorkspace, assertDisposableProject, assertNoBuild, assertProjectAvailable, newSmokeProject, parseArgs } from './smoke-compose.mjs';

const source = readFileSync(new URL('./smoke-compose.mjs', import.meta.url), 'utf8');

test('smoke refuses a compose config that still builds', () => {
  assert.doesNotThrow(() => assertNoBuild({ services: { hub: { image: 'hub' }, web: { image: 'web' } } }));
  assert.throws(() => assertNoBuild({ services: { web: { image: 'web', build: { context: '.' } } } }), /web compose config has build/);
});

test('hub probe and workspace creation are explicit', () => {
  assert.doesNotThrow(() => assessHubProbe({ status: 200, cors: 'http://127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }));
  assert.throws(() => assessHubProbe({ status: 403, cors: null, origin: 'http://127.0.0.1:3000' }), /403/);
  assert.throws(() => assessHubProbe({ status: 200, cors: 'http://localhost:3000', origin: 'http://127.0.0.1:3000' }), /CORS/);
  assert.doesNotThrow(() => assessWorkspace({ ok: true, id: 'ws_abc' }));
  assert.throws(() => assessWorkspace({ ok: true, id: '' }), /not created/);
  assert.throws(() => assessBundle(false, 'http://127.0.0.1:4400'), /missing http:\/\/127\.0\.0\.1:4400/);
  assert.doesNotThrow(() => assessServedHubUrl('window.__NEMA_HUB_URL__="http://127.0.0.1:4410"', 'http://127.0.0.1:4410'));
  assert.throws(() => assessServedHubUrl('window.__NEMA_HUB_URL__="http://127.0.0.1:4400"', 'http://127.0.0.1:4410'), /missing/);
});

test('pull policy is fixed and the project name is disposable', () => {
  assert.equal(parseArgs([]).pull, 'never');
  assert.equal(parseArgs([]).project, null);
  assert.equal(parseArgs(['--pull', 'always']).pull, 'always');
  assert.throws(() => parseArgs(['--pull', 'missing']), /unsupported --pull missing/);
  assert.throws(() => parseArgs(['--project', 'nema-image-smoke']), /refusing compose project/);
  assert.throws(() => parseArgs(['--project', 'nema']), /refusing compose project/);
  const name = newSmokeProject();
  assert.equal(parseArgs(['--project', name]).project, name);
  assert.notEqual(newSmokeProject(), name);
  assert.throws(() => assertDisposableProject('nema-image-smoke'), /refusing/);
  assert.doesNotThrow(() => assertProjectAvailable({ project: name, containers: [], volumes: [] }));
  assert.throws(() => assertProjectAvailable({ project: name, containers: ['abc'], volumes: [] }), /already has 1 containers/);
  assert.throws(() => assertProjectAvailable({ project: name, containers: [], volumes: ['vol'] }), /already has 1 volumes/);
  assert.equal(parseArgs(['--hub-port', '4417', '--web-port', '3017']).hubPort, 4417);
});

test('cleanup always names the compose project', () => {
  assert.match(source, /'compose', '-p', project/);
  assert.match(source, /ownsProject && !options\.keep/);
  assert.match(source, /down\.status !== 0/);
  assert.match(source, /\['down', '-v'\]/);
  assert.doesNotMatch(source, /compose down -v/);
});

test('a local smoke still fetches the postgres image', () => {
  assert.match(source, /options\.pull === 'never'/);
  assert.match(source, /\['pull', 'postgres'\]/);
  assert.match(source, /process\.env\.NEMA_UID/);
});
