import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_NAME = /^nema-image-smoke-[a-f0-9]{12}$/;

export function newSmokeProject() {
  return `nema-image-smoke-${randomBytes(6).toString('hex')}`;
}

export function assertDisposableProject(name) {
  if (typeof name !== 'string' || !PROJECT_NAME.test(name)) {
    throw new Error(`refusing compose project ${JSON.stringify(name)}`);
  }
}

export function assertProjectAvailable({ project, containers, volumes }) {
  assertDisposableProject(project);
  const present = [];
  if (containers?.length) present.push(`${containers.length} containers`);
  if (volumes?.length) present.push(`${volumes.length} volumes`);
  if (present.length) throw new Error(`refusing ${project}: already has ${present.join(' and ')}`);
}

function commandLines(command, args) {
  const run = spawnSync(command, args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error((run.stderr || `${command} failed`).trim());
  return run.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function inspectProject(project) {
  assertDisposableProject(project);
  const filter = `label=com.docker.compose.project=${project}`;
  return {
    containers: commandLines('docker', ['ps', '-aq', '--filter', filter]),
    volumes: commandLines('docker', ['volume', 'ls', '-q', '--filter', filter]),
  };
}

export function assertNoBuild(config) {
  for (const [name, service] of Object.entries(config?.services ?? {})) {
    if (service?.build) throw new Error(`${name} compose config has build`);
  }
}

export function assessHubProbe({ status, cors, origin }) {
  if (status !== 200) throw new Error(`hub /api/daemon/status returned ${status}`);
  if (cors !== origin) throw new Error(`hub CORS ${JSON.stringify(cors)} did not match origin ${origin}`);
}

export function assessWorkspace({ ok, id }) {
  if (!ok || typeof id !== 'string' || !id) throw new Error('workspace was not created');
}

export function assessBundle(found, hubUrl) {
  if (!found) throw new Error(`web bundle missing ${hubUrl}`);
}

export function parseArgs(argv) {
  const out = {
    project: null,
    pull: 'never',
    keep: false,
    hubPort: 4400,
    webPort: 3000,
    file: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      return value;
    };
    if (arg === '--pull') {
      const value = next();
      if (value !== 'never' && value !== 'always') throw new Error(`unsupported --pull ${value}`);
      out.pull = value;
    } else if (arg === '--project') {
      out.project = next();
      assertDisposableProject(out.project);
    }
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--hub-port') out.hubPort = portNumber(next(), arg);
    else if (arg === '--web-port') out.webPort = portNumber(next(), arg);
    else if (arg === '--file') out.file = next();
    else throw new Error(`unknown arg ${arg}`);
  }
  if (out.hubPort === out.webPort) throw new Error('hub and web ports must differ');
  return out;
}

function portNumber(value, flag) {
  if (!/^\d+$/.test(value) || +value < 1 || +value > 65535) throw new Error(`${flag} must be a TCP port`);
  return +value;
}

function compose(project, files, args, extra = {}) {
  return spawnSync('docker', ['compose', '-p', project, ...files.flatMap((file) => ['-f', file]), ...args], {
    encoding: 'utf8',
    ...extra,
  });
}

function overrideText({ hubPort, webPort }) {
  return `services:
  postgres:
    ports: !override
      - "127.0.0.1:55432:5432"
  hub:
    environment:
      NEMA_HUB_PORT: "${hubPort}"
      NEMA_WEB_ORIGIN: http://localhost:${webPort},http://127.0.0.1:${webPort}
    ports: !override
      - "127.0.0.1:${hubPort}:${hubPort}"
  web:
    ports: !override
      - "127.0.0.1:${webPort}:3000"
`;
}

function bundleScript(hubUrl) {
  return `const fs = require('node:fs');
const path = require('node:path');
const needle = ${JSON.stringify(hubUrl)};
const root = '/app/apps/web/.next';
let found = false;
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const info = fs.statSync(file);
    if (info.isDirectory()) walk(file);
    else if (info.size <= 5000000 && fs.readFileSync(file).includes(needle)) found = true;
  }
};
walk(root);
if (!found) process.exit(1);
`;
}

export async function smokeCompose(options, root) {
  const project = options.project ?? newSmokeProject();
  assertDisposableProject(project);
  const file = path.resolve(root, options.file ?? 'docker-compose.yml');
  const directory = await mkdtemp(path.join(tmpdir(), 'nema-image-smoke-'));
  const override = path.join(directory, 'ports.yml');
  const dataDir = path.join(directory, 'data');
  await writeFile(override, overrideText(options));
  await mkdir(dataDir, { mode: 0o700 });
  const files = [file, override];
  const env = {
    ...process.env,
    NEMA_DATA_HOST_DIR: dataDir,
    // Callers can pin the container user. The default is the current uid, which owns the
    // data directory on a daemon that bind-mounts this machine's filesystem.
    NEMA_UID: process.env.NEMA_UID || String(process.getuid?.() ?? 1000),
    NEMA_GID: process.env.NEMA_GID || String(process.getgid?.() ?? 1000),
  };
  const run = (args, extra = {}) => compose(project, files, args, { cwd: root, env, ...extra });
  let ownsProject = false;
  let failed = null;
  try {
    const found = inspectProject(project);
    assertProjectAvailable({ project, containers: found.containers, volumes: found.volumes });
    ownsProject = true;
    const configured = run(['config', '--format', 'json']);
    if (configured.status !== 0) throw new Error(configured.stderr || 'docker compose config failed');
    assertNoBuild(JSON.parse(configured.stdout));
    // `--pull never` keeps the locally tagged hub and web images. Postgres is not one of
    // those images, so fetch it alone or a fresh runner has nothing to start.
    if (options.pull === 'never') {
      const base = run(['pull', 'postgres']);
      if (base.status !== 0) throw new Error(base.stderr || base.stdout || 'docker compose pull postgres failed');
    }
    const up = run(['up', '-d', '--wait', '--wait-timeout', '180', '--pull', options.pull]);
    if (up.status !== 0) throw new Error(up.stderr || up.stdout || 'docker compose up failed');
    const origin = `http://127.0.0.1:${options.webPort}`;
    const hubUrl = `http://127.0.0.1:${options.hubPort}`;
    const status = await fetch(`${hubUrl}/api/daemon/status`, { headers: { Origin: origin } });
    assessHubProbe({ status: status.status, cors: status.headers.get('access-control-allow-origin'), origin });
    const created = await fetch(`${hubUrl}/api/workspaces`, {
      method: 'POST',
      headers: { Origin: origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'image-smoke' }),
    });
    const body = await created.json().catch(() => ({}));
    assessWorkspace({ ok: created.ok, id: body.id });
    const bundle = run(['exec', '-T', 'web', 'node', '-'], { input: bundleScript(hubUrl) });
    assessBundle(bundle.status === 0, hubUrl);
    process.stdout.write(`image smoke: project ${project} hub ${hubUrl} accepted ${origin} and created ${body.id}\n`);
  } catch (error) {
    failed = error;
    if (ownsProject) {
      const logs = run(['logs', '--tail', '80']);
      process.stderr.write(`${logs.stdout ?? ''}${logs.stderr ?? ''}`);
    }
  } finally {
    if (ownsProject && !options.keep) {
      const down = run(['down', '-v']);
      if (down.status !== 0) {
        const message = (down.stderr || down.stdout || 'compose teardown failed').trim();
        process.stderr.write(`${message}\n`);
        const teardown = `teardown failed for ${project}: ${message}`;
        failed = failed ? new Error(`${failed.message}\n${teardown}`) : new Error(teardown);
      }
      await rm(directory, { recursive: true, force: true });
    } else if (options.keep && failed) {
      process.stderr.write(`image smoke kept ${directory}\n`);
    } else if (!ownsProject) {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (failed) throw failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  smokeCompose(parseArgs(process.argv.slice(2)), root).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
