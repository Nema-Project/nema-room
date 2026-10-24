import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [serveFlag, home, _assetsDir, permissionsPath, mode = 'delayed', rawDelay = '3500'] = process.argv.slice(2);
if (serveFlag !== '--serve' || !home || !permissionsPath || !['delayed', 'stall', 'error-stall'].includes(mode)) {
  throw new Error('delayed owner fixture received invalid test arguments');
}

const { protectPrivatePath } = await import(pathToFileURL(permissionsPath).href);
const descriptorPath = join(home, 'instance.json');
const previous = JSON.parse(readFileSync(descriptorPath, 'utf8'));
const port = Number(new URL(previous.controlOrigin).port);
const protocol = 'nema-local-v1';
let published;
let closing = false;

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function proofFor(challenge) {
  return createHmac('sha256', Buffer.from(published.secret, 'hex'))
    .update(JSON.stringify([protocol, published.homeHash, published.instanceId, published.controlOrigin, published.origin, challenge]))
    .digest('hex');
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', previous.controlOrigin);
  if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined) return json(res, 400, { error: 'invalid request' });
  if (req.method === 'GET' && url.pathname === '/_nema/instance') {
    if (mode === 'stall' || mode === 'error-stall') return;
    if (!published) return json(res, 503, { error: 'not ready' });
    const challenge = url.searchParams.get('challenge') ?? '';
    return json(res, 200, {
      protocol,
      homeHash: published.homeHash,
      instanceId: published.instanceId,
      controlOrigin: published.controlOrigin,
      origin: published.origin,
      challenge,
      proof: proofFor(challenge),
    });
  }
  if (req.method === 'POST' && url.pathname === '/_nema/launch') {
    if (!published || req.headers.authorization !== `Bearer ${published.secret}`) return json(res, 401, { error: 'unauthorized' });
    const ticket = randomBytes(32).toString('hex');
    return json(res, 200, { origin: published.origin, launchUrl: `${published.origin}/_nema/launch?ticket=${ticket}`, instanceId: published.instanceId });
  }
  return json(res, 404, { error: 'not found' });
});

function publishFreshDescriptor() {
  const instanceId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const origin = previous.origin;
  published = {
    schemaVersion: 1,
    protocol,
    homeHash: previous.homeHash,
    instanceId,
    pid: process.pid,
    controlOrigin: previous.controlOrigin,
    origin,
    secret,
  };
  const temporary = `${descriptorPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(published), { mode: 0o600 });
  protectPrivatePath(temporary, 0o600);
  renameSync(temporary, descriptorPath);
}

async function closeFixture() {
  if (closing) return;
  closing = true;
  try {
    const current = JSON.parse(readFileSync(descriptorPath, 'utf8'));
    if (published && current.instanceId === published.instanceId) unlinkSync(descriptorPath);
  } catch { /* Cleanup is scoped to this fixture's synthetic descriptor. */ }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (process.connected) process.disconnect();
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (chunk.includes('close')) void closeFixture(); });
process.once('SIGTERM', () => { void closeFixture(); });

server.listen(port, '127.0.0.1', () => {
  if (mode === 'delayed') {
    const shared = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(shared, 0, 0, Number(rawDelay));
    try {
      const current = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      if (current.instanceId === previous.instanceId) unlinkSync(descriptorPath);
    } catch { /* the synthetic descriptor is already absent */ }
    setTimeout(() => {
      publishFreshDescriptor();
      process.send?.({ type: 'core-ready' });
    }, 200);
  } else if (mode === 'error-stall') {
    setTimeout(() => process.send?.({ type: 'core-error', code: 'NEMA_LOCAL_TEST_START_FAILED', message: 'Synthetic owner startup failure' }), 100);
  }
});
