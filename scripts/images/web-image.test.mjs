import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const entrypoint = readFileSync(new URL('./web-entrypoint.sh', import.meta.url), 'utf8');
const nextConfig = readFileSync(new URL('../../apps/web/next.config.ts', import.meta.url), 'utf8');

function stages(text) {
  const out = {};
  for (const part of text.split(/^FROM /m).slice(1)) {
    const header = part.split('\n', 1)[0];
    const name = header.match(/\bAS ([A-Za-z0-9_-]+)\s*$/)?.[1];
    if (!name) continue;
    out[name] = part.slice(header.length + 1);
  }
  return out;
}

const stage = stages(dockerfile);

test('web build bakes the published hub URL and enables standalone before the Next build', () => {
  const webBuild = stage['web-build'];
  assert.ok(webBuild, 'web-build stage');
  assert.match(webBuild, /ARG NEXT_PUBLIC_HUB_URL=http:\/\/127\.0\.0\.1:4400/);
  const flag = webBuild.indexOf('ENV NEMA_DOCKER_WEB=1');
  const build = webBuild.indexOf('npm run build -w apps/web');
  assert.ok(flag !== -1 && build !== -1 && flag < build, 'NEMA_DOCKER_WEB must be set before next build');
});

test('web runtime copies the standalone server, static assets, and public files', () => {
  const web = stage.web;
  assert.ok(web, 'web stage');
  assert.doesNotMatch(web, /COPY --from=web-build \/app \.\/?\s*$/m);
  assert.match(web, /COPY --from=web-build \/app\/apps\/web\/\.next\/standalone \.\//);
  assert.match(web, /COPY --from=web-build \/app\/apps\/web\/\.next\/static \.\/apps\/web\/\.next\/static/);
  assert.match(web, /COPY --from=web-build \/app\/apps\/web\/public \.\/apps\/web\/public/);
  assert.match(web, /COPY apps\/web\/app\/fonts\/inter\/OFL\.txt \/app\/licenses\/fonts\/inter\/OFL\.txt/);
  assert.match(web, /COPY apps\/web\/app\/fonts\/jetbrains-mono\/OFL\.txt \/app\/licenses\/fonts\/jetbrains-mono\/OFL\.txt/);
  assert.match(dockerfile, /ENTRYPOINT \["\/entrypoint\.sh"\]/);
  assert.match(web, /NEMA_HUB_URL=http:\/\/127\.0\.0\.1:4400/);
});

test('entrypoint listens on all interfaces at port 3000', () => {
  assert.match(entrypoint, /^export HOSTNAME=0\.0\.0\.0$/m);
  assert.match(entrypoint, /^export PORT="\$\{PORT:-3000\}"$/m);
  assert.match(entrypoint, /^exec node apps\/web\/server\.js$/m);
});

test('NEMA_DOCKER_WEB uses the managed standalone Next config', () => {
  assert.match(nextConfig, /NEMA_DOCKER_WEB === "1"/);
  assert.match(nextConfig, /output: "standalone"/);
  assert.match(nextConfig, /NEMA_MANAGED_LOCAL_BUILD === "1"/);
});

test('hub runtime still serves vendored knowledge tools', () => {
  const hub = stage.hub;
  assert.ok(hub, 'hub stage');
  assert.match(hub, /COPY vendor\/archify vendor\/archify/);
  assert.match(hub, /COPY vendor\/superpowers-rules vendor\/superpowers-rules/);
  assert.match(hub, /CMD \["node", "apps\/hub\/dist\/src\/main\.js"\]/);
});
