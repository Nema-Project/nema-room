import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, cp, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { electronExecutableRelative } from './stage-runtime.mjs';
import { reportPayload } from './payload-size.mjs';
import { systemGitDirectory } from './system-git.mjs';
import { startFakeResponsesServer, sse } from '../../apps/cli/test/fixtures/fake-responses-server.ts';

const execFileAsync = promisify(execFile);
const childCloseEvents = new WeakMap();
const closedChildren = new WeakSet();

function trackChildClose(child) {
  let closeEvent = childCloseEvents.get(child);
  if (!closeEvent) {
    closeEvent = new Promise((resolve) => child.once('close', (exitCode, signalCode) => {
      closedChildren.add(child);
      resolve({ exitCode, signalCode });
    }));
    childCloseEvents.set(child, closeEvent);
  }
  return closeEvent;
}

/** Nest a copied payload the way the packaged app does, so the launcher's Electron path stays inside the temp root. */
export function installedSmokePaths(temporaryRoot, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = p.resolve(temporaryRoot);
  const appRoot = p.join(root, "installed runtime ' 東京");
  const install = platform === 'darwin'
    ? p.join(appRoot, 'Contents', 'Resources', 'payload')
    : p.join(appRoot, 'resources', 'payload');
  const electronPath = p.resolve(install, electronExecutableRelative(platform));
  const escaped = p.relative(root, electronPath);
  if (!escaped || escaped === '..' || escaped.startsWith(`..${p.sep}`) || p.isAbsolute(escaped)) {
    throw new Error('Smoke Electron path escapes the temporary root');
  }
  return { install, electronPath };
}

export function validatePayloadDirectory(directory) {
  const root = path.resolve(directory);
  let manifest;
  try { manifest = JSON.parse(requireText(path.join(root, 'runtime-manifest.json'))); }
  catch { throw new Error(`Not a staged runtime payload: ${root}`); }
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('Runtime payload schema or native target does not match this host');
  }
  for (const key of ['coreEntry', 'cliEntry', 'webEntry', 'licenses', ...(manifest.node === undefined ? [] : ['node'])]) {
    const value = manifest[key];
    if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Runtime manifest has an invalid ${key} path`);
    }
  }
  return { root, manifest };
}

function requireText(file) {
  return readFileSync(file, 'utf8');
}

export function parseRuntimeLine(line) {
  try {
    const value = JSON.parse(line);
    if (value?.state !== 'ready' || typeof value.origin !== 'string') return null;
    const url = new URL(value.origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash) return null;
    return { origin: url.origin };
  } catch { return null; }
}

function waitForChildExit(child, timeoutMs = 6_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('exit', onExit); reject(new Error(`Owned process ${child.pid ?? ''} did not exit within ${timeoutMs}ms`)); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(); };
    child.once('exit', onExit);
    child.once('error', onExit);
  });
}

function waitForChildClose(child, timeoutMs = 6_000) {
  const closeEvent = trackChildClose(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Owned process ${child.pid ?? ''} did not close stdio within ${timeoutMs}ms`)), timeoutMs);
    closeEvent.then((result) => { clearTimeout(timer); resolve(result); });
  });
}

async function startCore(node, payload, home, env, onOwned) {
  const manifest = JSON.parse(await readFile(path.join(payload, 'runtime-manifest.json'), 'utf8'));
  const core = path.join(payload, ...manifest.coreEntry.split('/'));
  const child = spawn(node, [core, '--serve', home, payload], { cwd: payload, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  trackChildClose(child);
  let spawnError;
  let output = '';
  let errors = '';
  child.once('error', (error) => { spawnError = error; });
  const owned = { child, origin: '', webPort: 0, errors: () => errors };
  onOwned(owned);
  const lines = [];
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk;
    while (output.includes('\n')) {
      const index = output.indexOf('\n');
      lines.push(output.slice(0, index).trim());
      output = output.slice(index + 1);
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { errors += chunk; });
  const deadline = Date.now() + 60_000;
  let runtime;
  let webPort;
  while (Date.now() < deadline && !runtime) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error(`Owned core exited before ready (${child.exitCode ?? child.signalCode ?? spawnError?.message}): ${errors}`);
    for (const line of lines.splice(0)) {
      const parsed = parseRuntimeLine(line);
      if (parsed) runtime = parsed;
      else {
        try { const value = JSON.parse(line); if (value?.state === 'web-ready' && Number.isInteger(value.port)) webPort = value.port; } catch { /* unrelated diagnostic */ }
      }
    }
    if (runtime) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!runtime) throw new Error(`Owned core did not report ready: ${errors}`);
  while (!webPort && Date.now() < deadline) {
    for (const line of lines.splice(0)) {
      try { const value = JSON.parse(line); if (value?.state === 'web-ready' && Number.isInteger(value.port)) webPort = value.port; } catch { /* unrelated diagnostic */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if (!webPort) throw new Error(`Owned core did not report managed Web readiness: ${errors}`);
  owned.origin = runtime.origin;
  owned.webPort = webPort;
  return owned;
}

async function browserLaunch(node, payload, env) {
  let command = node;
  let args = [path.join(payload, 'app', 'node_modules', '@nema', 'local', 'dist', 'src', 'browser.js'), '--assetsDir', payload, '--no-open'];
  if (process.platform === 'win32') {
    command = path.join(env.SystemRoot, 'System32', 'cmd.exe');
    args = ['/d', '/s', '/c', 'call "Nema Browser.cmd" --no-open'];
  }
  const child = spawn(command, args, { cwd: payload, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
  trackChildClose(child);
  let stdout = '';
  let stderr = '';
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try { await waitForChildClose(child, 30_000); }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForChildClose(child, 5_000).catch(() => {});
    throw new Error(`Native browser launcher did not exit: ${stderr}`, { cause: error });
  }
  if (spawnError || child.exitCode !== 0) throw new Error(`Browser launcher failed (${child.exitCode ?? spawnError?.message}): ${stderr}`);
  const launchUrl = stdout.trim().split(/\r?\n/).at(-1);
  const url = new URL(launchUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/_nema/launch' || !/^[0-9a-f]{64}$/.test(url.searchParams.get('ticket') ?? '')) {
    throw new Error(`Browser launcher did not produce a verified ticket URL: ${stdout}`);
  }
  return url.href;
}

async function cliLauncherUsage(payload, env) {
  let command = path.join(payload, process.platform === 'darwin' ? 'Nema CLI.command' : 'nema-cli');
  let args = ['report', 'install', '--help'];
  if (process.platform === 'win32') {
    command = path.join(env.SystemRoot, 'System32', 'cmd.exe');
    args = ['/d', '/s', '/c', 'call "Nema CLI.cmd" report install --help'];
  }
  const child = spawn(command, args, { cwd: payload, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
  trackChildClose(child);
  let stdout = '';
  let stderr = '';
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try { await waitForChildClose(child, 30_000); }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForChildClose(child, 5_000).catch(() => {});
    throw new Error(`Native CLI launcher did not exit: ${stderr}`, { cause: error });
  }
  if (spawnError || child.exitCode !== 0) throw new Error(`CLI launcher failed (${child.exitCode ?? spawnError?.message}): ${stderr}`);
  if (!/Usage:.*report install/.test(stdout) || !stdout.includes('--agent')) throw new Error(`CLI launcher did not print report install usage: ${stdout}`);
}

async function graphifyExtractOnce(install, env) {
  const launcher = path.join(install, 'tools', 'graphify', process.platform === 'win32' ? 'graphify.exe' : 'graphify');
  const info = await lstat(launcher).catch(() => null);
  if (!info) {
    if (process.platform === 'linux') return;
    throw new Error('Packaged Graphify launcher is missing');
  }
  const corpus = path.join(path.dirname(install), 'graphify-smoke');
  await mkdir(corpus, { recursive: true });
  await writeFile(path.join(corpus, 'hello.js'), 'function smokeGreet() { return 1; }\n');
  await writeFile(path.join(corpus, 'chip.v'), 'module chip; endmodule\n');
  const child = spawn(launcher, ['extract', corpus, '--code-only'], {
    cwd: corpus,
    env: { ...env, GRAPHIFY_BACKEND: 'none', PYTHONNOUSERSITE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  trackChildClose(child);
  let stdout = '';
  let stderr = '';
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  try { await waitForChildClose(child, 120_000); }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForChildClose(child, 5_000).catch(() => {});
    throw new Error(`Graphify extract did not finish: ${stderr}`, { cause: error });
  }
  const output = `${stdout}\n${stderr}`;
  if (spawnError || child.exitCode !== 0) throw new Error(`Graphify extract failed (${child.exitCode ?? spawnError?.message}): ${output}`);
  if (output.includes('Traceback')) throw new Error(`Graphify extract crashed: ${output}`);
  if (!/verilog/i.test(output) || !output.includes('not installed')) throw new Error(`Graphify extract did not skip the missing verilog grammar: ${output}`);
  const graph = await readFile(path.join(corpus, 'graphify-out', 'graph.json'), 'utf8');
  if (!graph.includes('smokeGreet')) throw new Error('Graphify extract did not index smokeGreet');
}

export async function closeCore(core) {
  const { child } = core;
  if (child.exitCode !== null || child.signalCode !== null) {
    try {
      const result = await waitForChildClose(child, 3_000);
      return { ...result, graceful: false, fallback: false, alreadyExited: true };
    } catch (error) { throw error; }
  }
  if (child.exitCode === null && child.signalCode === null) child.stdin?.end('close\n');
  try {
    const result = await waitForChildClose(child, 8_000);
    return { ...result, graceful: result.exitCode === 0 && result.signalCode === null, fallback: false };
  }
  catch (timeoutError) {
    if (child.exitCode !== null || child.signalCode !== null) throw timeoutError;
    child.kill();
    try { await waitForChildClose(child, 3_000); }
    catch {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await waitForChildClose(child, 3_000);
    }
    return { graceful: false, fallback: true, exitCode: child.exitCode, signalCode: child.signalCode };
  }
}

async function until(test, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await test(); if (last) return last; } catch { /* service is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function ticketSession(origin, launchUrl) {
  const launch = await fetch(launchUrl, { redirect: 'manual' });
  if (launch.status !== 303 || launch.headers.get('location') !== '/') throw new Error(`Ticket redirect contract failed: HTTP ${launch.status}`);
  const cookie = launch.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Ticket redirect did not issue its session cookie');
  const root = await fetch(`${origin}/`, { headers: { cookie } });
  if (root.status !== 200) throw new Error(`Authenticated clean URL did not load: HTTP ${root.status}`);
  return { cookie, html: await root.text() };
}

async function checkWebAssets(origin, cookie, html) {
  const cssPath = html.match(/<link[^>]+href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/i)?.[1];
  if (!cssPath) throw new Error('Production HTML did not reference a stylesheet');
  const css = await fetch(new URL(cssPath, origin), { headers: { cookie } });
  if (css.status !== 200 || !(css.headers.get('content-type') ?? '').includes('text/css')) throw new Error(`Production CSS failed: HTTP ${css.status}`);
  const cssText = await css.text();
  const fontRef = cssText.match(/url\(["']?([^"')]+\.woff2)(?:\?[^"')]*)?["']?\)/i)?.[1];
  if (!fontRef) throw new Error('Production CSS did not reference a generated Next font');
  const font = await fetch(new URL(fontRef, new URL(cssPath, origin)), { headers: { cookie } });
  if (font.status !== 200 || !(font.headers.get('content-type') ?? '').includes('font')) throw new Error(`Generated Next font failed: HTTP ${font.status}`);
  return { cssPath, fontUrl: new URL(fontRef, new URL(cssPath, origin)).pathname };
}

async function jsonRequest(origin, cookie, pathname, method = 'GET', body) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${text}`);
  return value;
}

async function readGit(git, repo) {
  const { stdout } = await execFileAsync(git, ['-C', repo, 'log', '--format=%H %s', '--all'], { windowsHide: true });
  return stdout.trim().split(/\r?\n/).filter(Boolean);
}

async function runSmoke(sourcePayload) {
  const selected = validatePayloadDirectory(sourcePayload);
  await reportPayload(selected.root);
  const temporaryPrefix = "nema installed smoke ' 東京 ";
  const temporaryParent = await realpath(os.tmpdir());
  const temporaryRoot = await mkdtemp(path.join(temporaryParent, temporaryPrefix));
  const temporaryIdentity = await lstat(temporaryRoot);
  const profile = path.join(temporaryRoot, "managed profile ' 東京");
  const home = path.join(profile, '.nema', 'desktop');
  const codexHome = path.join(temporaryRoot, 'isolated Codex home');
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  let fake;
  const cores = [];
  let historyBefore = [];
  const cleanupErrors = [];
  let primaryError;
  try {
    const installed = installedSmokePaths(temporaryRoot);
    const install = installed.install;
    await mkdir(path.dirname(install), { recursive: true });
    await cp(selected.root, install, { recursive: true, force: false, errorOnExist: true });
    const copied = validatePayloadDirectory(install);
    if (!copied.manifest.node) {
      await mkdir(path.dirname(installed.electronPath), { recursive: true });
      // A hard link shares the host Node inode. chmod would change that binary's mode.
      let copiedStandIn = false;
      try { await link(process.execPath, installed.electronPath); }
      catch {
        await copyFile(process.execPath, installed.electronPath);
        copiedStandIn = true;
      }
      if (copiedStandIn && process.platform !== 'win32') await chmod(installed.electronPath, 0o755);
    }
    const node = copied.manifest.node ? path.join(install, ...copied.manifest.node.split('/')) : process.execPath;
    const env = {
      // Only the user's own git and the OS directories, as a desktop app launched from the shell would see.
      PATH: [systemGitDirectory(), process.platform === 'win32' ? path.join(systemRoot, 'System32') : '/usr/bin:/bin'].join(path.delimiter),
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
      HOME: profile,
      USERPROFILE: profile,
      CODEX_HOME: codexHome,
      LANG: 'en_US.UTF-8',
      // Host Node ignores this. A payload with no `node` field accepts process.execPath only when it is set.
      ...(copied.manifest.node ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    };
    fake = await startFakeResponsesServer();
    let core = await startCore(node, copied.root, home, env, (owned) => cores.push(owned));
    const descriptorBeforeLaunches = JSON.parse(await readFile(path.join(home, 'instance.json'), 'utf8'));
    const firstUrl = await browserLaunch(node, install, env);
    const secondUrl = await browserLaunch(node, install, env);
    if (new URL(firstUrl).origin !== new URL(secondUrl).origin) throw new Error('Duplicate browser launch did not reuse the same local runtime');
    await cliLauncherUsage(install, env);
    await graphifyExtractOnce(install, env);
    const descriptorBefore = JSON.parse(await readFile(path.join(home, 'instance.json'), 'utf8'));
    if (descriptorBeforeLaunches.instanceId !== descriptorBefore.instanceId || descriptorBeforeLaunches.pid !== descriptorBefore.pid) throw new Error('Duplicate browser launches did not share the same authenticated runtime owner');
    const { cookie, html } = await ticketSession(core.origin, firstUrl);
    const assetEvidence = await checkWebAssets(core.origin, cookie, html);
    const workspaces = await jsonRequest(core.origin, cookie, '/api/workspaces');
    if (!Array.isArray(workspaces)) throw new Error('Authenticated same-origin workspaces API did not return a list');
    let created;
    try { created = await jsonRequest(core.origin, cookie, '/api/workspaces', 'POST', { name: 'Installed production smoke' }); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\nCore diagnostics: ${core.errors()}`); }
    const workspace = created.id;
    const page = await fetch(`${core.origin}/w/${workspace}`, { headers: { cookie } });
    if (page.status !== 200) throw new Error(`Production workspace page failed: HTTP ${page.status}`);
    const patched = await jsonRequest(core.origin, cookie, `/_nema/settings`, 'PATCH', {
      adapter: 'codex-direct', authMode: 'byok', model: 'smoke-model', reasoningEffort: 'low', byokBaseUrl: fake.baseUrl,
    });
    if (patched.config?.model !== 'smoke-model') throw new Error('Settings PATCH did not save the smoke model');
    await jsonRequest(core.origin, cookie, '/_nema/auth/secret', 'POST', { kind: 'byok', value: 'fake-local-smoke-key-only' });
    const status = await jsonRequest(core.origin, cookie, '/_nema/settings');
    if (status.auth?.state !== 'connected' || JSON.stringify(status).includes('fake-local-smoke-key-only')) throw new Error('BYOK status did not report connected with the secret redacted');

    let postedMessageId;
    let releaseToolReply;
    const toolReplyReady = new Promise((resolve) => { releaseToolReply = resolve; });
    fake.responses(
      async (res) => {
        await toolReplyReady;
        const tool = { type: 'function_call', id: 'fc_smoke', call_id: 'call_smoke', name: 'upsert_entry', arguments: JSON.stringify({ kind: 'decision', title: 'Installed runtime proof', body: 'The copied production runtime wrote this knowledge entry.', reason: 'Installed runtime acceptance', sourceMessages: [postedMessageId], basis: 'stated' }), status: 'completed' };
        sse([
          { type: 'response.created', response: { id: 'smoke-tool-response' } },
          { type: 'response.output_item.done', output_index: 0, item: tool },
          { type: 'response.completed', response: { id: 'smoke-tool-response', status: 'completed', output: [tool] } },
        ])(res);
      },
      sse([
        { type: 'response.created', response: { id: 'smoke-final-response' } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_smoke', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Installed smoke completed through the fake Responses provider.', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'smoke-final-response', status: 'completed' } },
      ]),
    );
    const eventController = new AbortController();
    const eventsResponse = await fetch(`${core.origin}/api/workspaces/${workspace}/events`, { headers: { cookie }, signal: eventController.signal });
    if (!eventsResponse.ok || !eventsResponse.body) throw new Error(`Could not open production SSE: HTTP ${eventsResponse.status}`);
    const reader = eventsResponse.body.getReader();
    try {
      const posted = await jsonRequest(core.origin, cookie, `/api/workspaces/${workspace}/messages`, 'POST', { content: 'Record this installed runtime proof.' });
      postedMessageId = posted.message.id;
      releaseToolReply();
      let eventText = '';
      const eventDeadline = Date.now() + 5_000;
      while (!eventText.includes('task.updated') && Date.now() < eventDeadline) {
        let timer;
        const event = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Production SSE did not deliver task creation within 5s')), 5_000); }),
        ]).finally(() => clearTimeout(timer));
        if (event.done) throw new Error('Production SSE ended before task creation delivery');
        eventText += new TextDecoder().decode(event.value);
      }
      if (!eventText.includes('task.updated')) throw new Error(`Production SSE did not deliver task creation before stream end: ${eventText.slice(0, 500)}`);
      // The fake tool call refers to the real authenticated chat message and is revalidated by the hub.
      const requestsDeadline = Date.now() + 15_000;
      let providerRequest;
      let taskFailure;
      let active = { running: null };
      let currentMessages = [];
      while (!providerRequest && Date.now() < requestsDeadline) {
        providerRequest = fake.requests.find((request) => request.url === '/v1/responses' && request.headers.authorization === 'Bearer fake-local-smoke-key-only');
        if (providerRequest) break;
        [active, currentMessages] = await Promise.all([
          jsonRequest(core.origin, cookie, `/api/workspaces/${workspace}/tasks/active`),
          jsonRequest(core.origin, cookie, `/api/workspaces/${workspace}/messages`),
        ]);
        taskFailure = currentMessages.find((row) => row.role === 'system' && row.taskId === posted.task.id);
        if (taskFailure) break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!providerRequest) {
        const taskErrors = currentMessages.filter((row) => row.role === 'system').map((row) => String(row.content).slice(0, 500));
        const diagnostics = core.errors().replaceAll('fake-local-smoke-key-only', '[redacted-test-key]').slice(-3000);
        const fakeRoutes = fake.requests.map(({ method, url }) => `${method} ${url}`);
        throw new Error(`The actual task did not reach the explicit fake BYOK provider${taskFailure ? ' because it failed before provider dispatch' : ' within 15s'}; active=${JSON.stringify(active.running ? { status: active.running.status, error: active.running.error } : null)}; systemMessages=${JSON.stringify(taskErrors)}; fakeRoutes=${JSON.stringify(fakeRoutes)}; core=${diagnostics}`);
      }
      const messages = await until(async () => {
        const rows = await jsonRequest(core.origin, cookie, `/api/workspaces/${workspace}/messages`);
        return rows.some((row) => row.role === 'agent' || row.role === 'system') ? rows : null;
      }, 'Actual chat task did not finish');
      const assistant = messages.find((row) => row.role === 'agent');
      if (assistant?.content !== 'Installed smoke completed through the fake Responses provider.') throw new Error('Fake provider final response did not arrive in the actual chat');
      const roomRequest = fake.requests.find((request) => request.url === '/v1/responses' && request.headers.authorization === 'Bearer fake-local-smoke-key-only');
      if (!roomRequest || !postedMessageId) throw new Error('Missing fake provider request or persisted user message id');
      const repo = path.join(home, 'data', 'repos', workspace);
      historyBefore = await readGit('git', repo);
      if (historyBefore.length !== 2 || !historyBefore.some((line) => line.includes('Installed runtime proof'))) throw new Error(`Knowledge Git operation did not produce the expected entry and init history: ${historyBefore.join('; ')}`);
      const settingsConfig = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
      if (settingsConfig.model !== 'smoke-model') throw new Error('Settings were not persisted on disk');
      await reader.cancel();
    } finally { eventController.abort(); await reader.cancel().catch(() => {}); }

    const gracefulClose = await closeCore(core);
    if (!gracefulClose.graceful) throw new Error(`Core did not exit through its smoke-owned stdin close protocol; status=${core.child.exitCode ?? core.child.signalCode}`);
    cores.splice(cores.indexOf(core), 1);
    core = await startCore(node, copied.root, home, env, (owned) => cores.push(owned));
    const afterRestartUrl = await browserLaunch(node, install, env);
    const restarted = await ticketSession(core.origin, afterRestartUrl);
    const persisted = await jsonRequest(core.origin, restarted.cookie, '/api/workspaces');
    if (!persisted.some((item) => item.id === workspace)) throw new Error('Workspace did not persist across graceful restart');
    const persistedMessages = await jsonRequest(core.origin, restarted.cookie, `/api/workspaces/${workspace}/messages`);
    if (!persistedMessages.some((item) => item.role === 'agent' && item.content === 'Installed smoke completed through the fake Responses provider.')) {
      throw new Error('Actual chat response did not persist across graceful restart');
    }
    const historyAfterRestart = await readGit('git', path.join(home, 'data', 'repos', workspace));
    if (JSON.stringify(historyAfterRestart) !== JSON.stringify(historyBefore)) throw new Error('Exact knowledge Git history did not persist across graceful restart');

    const webProbe = await fetch(`http://127.0.0.1:${core.webPort}/`);
    if (webProbe.status !== 200) throw new Error('Owned production Next child was not serving before forced core death');
    const deadPort = core.webPort;
    core.child.kill('SIGKILL');
    await waitForChildExit(core.child, 8_000);
    await waitForChildClose(core.child, 8_000);
    const forcedCrashStatus = { exitCode: core.child.exitCode, signalCode: core.child.signalCode };
    cores.splice(cores.indexOf(core), 1);
    await until(async () => {
      try { const response = await fetch(`http://127.0.0.1:${deadPort}/`); response.body?.cancel(); return false; }
      catch { return true; }
    }, 'Production Next Web listener remained after its owning core died');
    const descriptorAfterCrash = await readFile(path.join(home, 'instance.json'), 'utf8').catch(() => '');
    const forcedCrashRecovery = await startCore(node, copied.root, home, env, (owned) => cores.push(owned));
    const recoveryUrl = await browserLaunch(node, install, env);
    const recoverySession = await ticketSession(forcedCrashRecovery.origin, recoveryUrl);
    const recovered = await jsonRequest(forcedCrashRecovery.origin, recoverySession.cookie, '/api/workspaces');
    if (!recovered.some((item) => item.id === workspace)) throw new Error('Workspace did not recover after forced core crash');
    const recoveryHistory = await readGit('git', path.join(home, 'data', 'repos', workspace));
    if (JSON.stringify(recoveryHistory) !== JSON.stringify(historyAfterRestart)) throw new Error('Knowledge Git history changed across forced core crash recovery');
    if (fake.requests.some((request) => !request.url.startsWith('/v1/'))) throw new Error('Unexpected request escaped the fake provider server');
    const instanceAfter = JSON.parse(await readFile(path.join(home, 'instance.json'), 'utf8'));
    if (descriptorBefore.instanceId === instanceAfter.instanceId || !descriptorAfterCrash) throw new Error('Runtime instance ownership did not rotate across restart/recovery');
    return {
      install,
      home,
      origin: forcedCrashRecovery.origin,
      workspace,
      assetEvidence,
      responseRequests: fake.requests.filter((request) => request.url === '/v1/responses').length,
      knowledgeHistory: historyAfterRestart,
      deadWebPort: deadPort,
      gracefulShutdown: { method: 'stdin close command + EOF', fallbackUsed: false, exitCode: gracefulClose.exitCode, signalCode: gracefulClose.signalCode },
      forcedCoreCrash: { method: 'SIGKILL on smoke-owned core ChildProcess handle', ...forcedCrashStatus },
      parentDeath: 'actual staged Next listener refused requests after owned core child exit',
      cleanup: 'owned core handles and fake provider closed in finally; temporary tree removed',
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    for (const core of [...cores]) {
      try { await closeCore(core); } catch (error) {
        cleanupErrors.push(error);
        if (core.child.exitCode === null && core.child.signalCode === null) {
          try { core.child.kill(); await waitForChildExit(core.child, 4_000); await waitForChildClose(core.child, 4_000); } catch (killError) { cleanupErrors.push(killError); }
        }
      }
      if (core.webPort) {
        try {
          await until(async () => {
            try { const response = await fetch(`http://127.0.0.1:${core.webPort}/`); await response.body?.cancel(); return false; }
            catch { return true; }
          }, `Managed Web listener ${core.webPort} remained after cleanup`, 5_000);
        } catch (error) { cleanupErrors.push(error); }
      }
    }
    try { await fake?.close(); } catch (error) { cleanupErrors.push(error); }
    if (cores.every((core) => closedChildren.has(core.child))) {
      try {
        const [canonicalRoot, canonicalParent, currentRoot] = await Promise.all([
          realpath(temporaryRoot), realpath(path.dirname(temporaryRoot)), lstat(temporaryRoot),
        ]);
        const stillOwned = canonicalRoot === temporaryRoot && canonicalParent === temporaryParent &&
          path.dirname(temporaryRoot) === temporaryParent && path.basename(temporaryRoot).startsWith(temporaryPrefix) &&
          !currentRoot.isSymbolicLink() && currentRoot.isDirectory() &&
          currentRoot.dev === temporaryIdentity.dev && currentRoot.ino === temporaryIdentity.ino;
        if (!stillOwned) throw new Error(`Refusing to remove smoke tree after ownership/path identity changed: ${temporaryRoot}`);
        await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      } catch (error) { cleanupErrors.push(error); }
    } else cleanupErrors.push(new Error(`Refusing to remove smoke resources while ${cores.filter((core) => core.child.exitCode === null && core.child.signalCode === null).length} owned core process(es) remain alive or child cleanup is unverified`));
    if (cleanupErrors.length) throw new AggregateError(primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors, 'Installed runtime smoke cleanup was incomplete');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const payload = process.argv[2] ?? path.resolve('dist', 'desktop-7b2-verified', `${process.platform}-${process.arch}`);
  runSmoke(payload).then((evidence) => {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  }).catch((error) => {
    const details = error instanceof AggregateError ? `${error.stack ?? error}\n${error.errors.map((item) => item instanceof Error ? item.stack : String(item)).join('\n')}` : error.stack ?? String(error);
    process.stderr.write(`${details}\n`);
    process.exitCode = 1;
  });
}
