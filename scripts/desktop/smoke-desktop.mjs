import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFile } from '@electron/asar';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appVersion = JSON.parse(readFileSync(path.join(repo, 'apps/desktop/package.json'), 'utf8')).version;

export function parseSmokeArgs(args) {
  if (args.length === 0) return { installer: path.join(repo, 'dist/desktop-artifacts', 'win32-x64', `Nema-${appVersion}-win32-x64.exe`) };
  if (args.length !== 2 || args[0] !== '--installer' || !args[1] || args[1].startsWith('--')) throw new Error('Usage: desktop:smoke [--installer <native-Windows-NSIS-installer>]');
  return { installer: path.resolve(args[1]) };
}

/** NSIS reads /D= only as the last argument and takes the rest of the line verbatim, so it must not be quoted. */
export function nsisSilentCommandLine(installDir) {
  return `/S /D=${installDir}`;
}

const INSTALL_TIMEOUT_MS = 15 * 60_000;

/** Silently install the NSIS package the release ships; a stalled installer fails here instead of hanging the job. */
async function installSilently(installer, installDir) {
  const child = spawn(installer, [nsisSilentCommandLine(installDir)], { stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  const code = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`NSIS installer did not finish within ${INSTALL_TIMEOUT_MS}ms`)); }, INSTALL_TIMEOUT_MS);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (exitCode) => { clearTimeout(timer); resolvePromise(exitCode); });
  });
  if (code !== 0) throw new Error(`NSIS installer exited with ${code}`);
}

function sseFrame(value) {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

async function startFakeProvider() {
  const requests = [];
  const responseText = 'Packaged desktop smoke used the local fake provider.';
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      if (request.method === 'GET' && request.url?.startsWith('/v1/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [] }));
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses' || request.headers.authorization !== 'Bearer fake-desktop-smoke-key') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'response.created', response: { id: 'desktop-smoke-response' } },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'desktop-smoke-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: responseText, annotations: [] }] } },
        { type: 'response.completed', response: { id: 'desktop-smoke-response', status: 'completed' } },
      ];
      for (const event of events) response.write(sseFrame(event));
      response.end();
    });
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, responseText, server };
}

function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('exit', onExit); reject(new Error(`Smoke-owned Electron main ${child.pid ?? ''} did not exit within ${timeoutMs}ms`)); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(); };
    child.once('exit', onExit);
  });
}

async function startDesktop(executable, cwd, env) {
  const logPath = path.join(env.NEMA_DESKTOP_TEST_USER_DATA, 'smoke-electron.log');
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(executable, [], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, detached: true });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.smokeLogPath = logPath;
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  if (spawnError) throw new Error(`Could not launch copied desktop app: ${spawnError.message}`, { cause: spawnError });
  if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Copied desktop app exited on startup (${child.exitCode ?? child.signalCode})`);
  child.unref();
  return child;
}

async function stopOwnedMain(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await waitForChildExit(child);
}

async function findExecutable(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === 'nema.exe') return candidate;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = await findExecutable(candidate);
      if (found) return found;
    }
  }
  return null;
}

async function ticketSession(origin, launchUrl) {
  const launch = await fetch(launchUrl, { redirect: 'manual' });
  if (launch.status !== 303 || launch.headers.get('location') !== '/') throw new Error(`Packaged UI ticket contract failed: HTTP ${launch.status}`);
  const cookie = launch.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Packaged UI ticket did not issue an authenticated session cookie');
  const page = await fetch(`${origin}/`, { headers: { cookie } });
  if (!page.ok) throw new Error(`Packaged authenticated UI failed: HTTP ${page.status}`);
  return { cookie, html: await page.text() };
}

async function readWebAssets(origin, cookie, html) {
  if (html.includes('class="desktop-titlebar"')) throw new Error('The ordinary browser response must not render native desktop chrome');
  const cssPath = html.match(/<link[^>]+href=["']([^"']+\.css(?:\?[^"']*)?)["'][^>]*>/i)?.[1];
  if (!cssPath) throw new Error('Packaged UI HTML did not reference a stylesheet');
  const css = await fetch(new URL(cssPath, origin), { headers: { cookie } });
  if (css.status !== 200 || !(css.headers.get('content-type') ?? '').includes('text/css')) throw new Error(`Packaged CSS failed: HTTP ${css.status}`);
  const body = await css.text();
  if (!body.includes('.desktop-titlebar') || !body.includes('.nema-desktop-window')) throw new Error('Packaged CSS is missing custom desktop chrome or its desktop-only layout scope');
  const fontRef = body.match(/url\(["']?([^"')]+\.woff2)(?:\?[^"')]*)?["']?\)/i)?.[1];
  if (!fontRef) throw new Error('Packaged production CSS did not reference a generated font');
  const font = await fetch(new URL(fontRef, new URL(cssPath, origin)), { headers: { cookie } });
  if (font.status !== 200 || !(font.headers.get('content-type') ?? '').includes('font')) throw new Error(`Packaged font failed: HTTP ${font.status}`);
  return { cssPath, fontPath: new URL(fontRef, new URL(cssPath, origin)).pathname, ordinaryBrowserHasNoDesktopTitlebar: !html.includes('class="desktop-titlebar"') };
}

async function jsonRequest(origin, cookie, pathname, method = 'GET', value) {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers: { cookie, ...(value === undefined ? {} : { 'content-type': 'application/json' }) },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const raw = await response.text();
  let decoded;
  try { decoded = JSON.parse(raw); } catch { decoded = raw; }
  if (!response.ok) throw new Error(`${method} ${pathname} failed (${response.status}): ${raw}`);
  return decoded;
}

async function waitUntil(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error(`${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function loadRuntime(payload) {
  const modulePath = path.join(payload, 'app/node_modules/@nema/local/dist/src/index.js');
  return import(pathToFileURL(modulePath).href);
}

async function smoke(args) {
  const { installer } = parseSmokeArgs(args);
  await access(installer);
  const id = randomUUID();
  const tempRoot = path.join(await realpath(os.tmpdir()), `Nema proof 東京-${id}`);
  await mkdir(tempRoot, { recursive: false });
  const installDir = path.join(tempRoot, 'installed app with spaces');
  const profile = path.join(tempRoot, `Electron profile 東京-${id}`);
  const home = path.join(profile, '.nema', 'desktop');
  const codexHome = path.join(tempRoot, 'isolated Codex home');
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const artifactStat = await stat(installer);
  const installStarted = Date.now();
  await installSilently(installer, installDir);
  const installMs = Date.now() - installStarted;
  process.stderr.write(`Installed NSIS package in ${installMs}ms\n`);
  const executable = await findExecutable(installDir);
  if (!executable) throw new Error('NSIS installer did not install Nema.exe');
  const asarPath = path.join(path.dirname(executable), 'resources', 'app.asar');
  const packagedPreload = extractFile(asarPath, 'preload.cjs').toString('utf8');
  const packagedControls = extractFile(asarPath, 'window-controls.cjs').toString('utf8');
  if (!packagedPreload.includes("exposeInMainWorld('nemaWindowControls'") || !packagedPreload.includes('toggleMaximize')) throw new Error('Copied app ASAR is missing the narrow titlebar preload bridge');
  if (!packagedControls.includes('Untrusted window-control sender') || !packagedControls.includes("'closed'")) throw new Error('Copied app ASAR is missing owning-window validation or lifecycle cleanup');
  const payload = path.join(path.dirname(executable), 'resources', 'payload');
  const manifest = JSON.parse(await readFile(path.join(payload, 'runtime-manifest.json'), 'utf8'));
  if (manifest.platform !== 'win32' || manifest.arch !== 'x64' || manifest.version !== appVersion) throw new Error('Copied app contains an unexpected runtime target/version');
  const electronNotices = ['runtime/licenses/electron/LICENSE', 'runtime/licenses/electron/LICENSES.chromium.html'];
  const electronNoticeEvidence = [];
  for (const relative of electronNotices) {
    await access(path.join(payload, relative));
    const bytes = await readFile(path.join(payload, relative));
    electronNoticeEvidence.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }

  await mkdir(profile, { recursive: false });
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: false });
  const git = path.join(payload, ...manifest.git.split('/'));
  const env = {
    PATH: [path.dirname(git), path.join(systemRoot, 'System32')].join(path.delimiter),
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    HOME: profile,
    USERPROFILE: profile,
    CODEX_HOME: codexHome,
    LANG: 'en_US.UTF-8',
    NEMA_DESKTOP_TEST_HOME: home,
    NEMA_DESKTOP_TEST_USER_DATA: profile,
    NEMA_DESKTOP_DISABLE_GPU: '1',
    NEMA_LOCAL_CORE_LOG: path.join(tempRoot, 'local-core.log'),
  };
  const fake = await startFakeProvider();
  let appProcess;
  let nextAppProcess;
  let finalAppProcess;
  let runtimeApi;
  let instanceId;
  let workspaceId;
  let messageId;
  let assetEvidence;
  let providerRequest;
  let gracefulCoreRestart;
  try {
    runtimeApi = await loadRuntime(payload);
    appProcess = await startDesktop(executable, path.dirname(executable), env);
    const first = await waitUntil(async () => {
      const instance = await runtimeApi.discoverInstance(home);
      return instance?.installationId ? instance : null;
    }, 'Copied packaged Electron app did not publish authenticated local-core readiness', 180_000);
    instanceId = first.instanceId;
    const sessionData = await ticketSession(first.origin, first.launchUrl);
    assetEvidence = await readWebAssets(first.origin, sessionData.cookie, sessionData.html);
    const created = await jsonRequest(first.origin, sessionData.cookie, '/api/workspaces', 'POST', { name: `Electron proof ${id.slice(0, 8)}` });
    workspaceId = created.id;
    const workspacePage = await fetch(`${first.origin}/w/${workspaceId}`, { headers: { cookie: sessionData.cookie } });
    if (workspacePage.status !== 200) throw new Error(`Packaged workspace route failed: HTTP ${workspacePage.status}`);
    await jsonRequest(first.origin, sessionData.cookie, '/_nema/settings', 'PATCH', {
      adapter: 'codex-direct', authMode: 'byok', model: 'desktop-smoke-model', reasoningEffort: 'low', byokBaseUrl: fake.baseUrl,
    });
    await jsonRequest(first.origin, sessionData.cookie, '/_nema/auth/secret', 'POST', { kind: 'byok', value: 'fake-desktop-smoke-key' });
    const posted = await jsonRequest(first.origin, sessionData.cookie, `/api/workspaces/${workspaceId}/messages`, 'POST', { content: 'Use the isolated desktop fake provider.' });
    messageId = posted.message.id;
    providerRequest = await waitUntil(async () => fake.requests.find((request) => request.url === '/v1/responses' && request.authorization === 'Bearer fake-desktop-smoke-key'), 'Packaged task did not reach the local fake Responses provider', 30_000);
    const completedMessages = await waitUntil(async () => {
      const messages = await jsonRequest(first.origin, sessionData.cookie, `/api/workspaces/${workspaceId}/messages`);
      return messages.some((message) => message.role === 'agent' && message.content === fake.responseText) ? messages : null;
    }, 'Fake provider response was not persisted in the packaged runtime');
    if (!completedMessages.some((message) => message.id === messageId && message.role === 'user')) throw new Error('Packaged user message did not persist');

    // Simulate an unexpected Electron main-process exit using only this smoke launch handle.
    await stopOwnedMain(appProcess);
    appProcess = undefined;
    const surviving = await waitUntil(() => runtimeApi.discoverInstance(home), 'Local core did not remain available after the Electron main process exited');
    if (surviving.instanceId !== instanceId) throw new Error('Electron main-process exit replaced the independently running core');
    const browser = spawn(path.join(payload, ...manifest.node.split('/')), [path.join(payload, 'app/node_modules/@nema/local/dist/src/browser.js'), '--assetsDir', payload, '--no-open'], {
      cwd: payload, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let browserUrl = '';
    let browserErrors = '';
    browser.stdout.setEncoding('utf8').on('data', (chunk) => { browserUrl += chunk; });
    browser.stderr.setEncoding('utf8').on('data', (chunk) => { browserErrors += chunk; });
    const browserExit = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => { browser.kill(); reject(new Error('Browser fallback launcher exceeded 15 seconds')); }, 15_000);
      browser.once('error', (error) => { clearTimeout(timer); reject(error); });
      browser.once('exit', (code) => { clearTimeout(timer); resolvePromise(code); });
    });
    if (browserExit !== 0 || !browserUrl.trim()) throw new Error(`Browser fallback did not reopen the core: ${browserErrors}`);

    nextAppProcess = await startDesktop(executable, path.dirname(executable), env);
    const reused = await waitUntil(() => runtimeApi.discoverInstance(home), 'Reopened desktop app did not reconnect to the existing core');
    if (reused.instanceId !== instanceId) throw new Error('Desktop reopen did not reuse the core after the Electron main-process exit');
    await stopOwnedMain(nextAppProcess);
    nextAppProcess = undefined;
    await runtimeApi.shutdownLocalRuntime({ home, assetsDir: payload, expectedInstanceId: reused.instanceId, timeoutMs: 45_000 });
    gracefulCoreRestart = { firstInstanceId: reused.instanceId, authenticatedQuit: true };

    finalAppProcess = await startDesktop(executable, path.dirname(executable), env);
    const restarted = await waitUntil(() => runtimeApi.discoverInstance(home), 'Packaged app did not start a fresh core after authenticated shutdown');
    if (restarted.instanceId === instanceId) throw new Error('Core instance identity did not rotate after authenticated shutdown');
    const persisted = await ticketSession(restarted.origin, restarted.launchUrl);
    const persistedWorkspaces = await jsonRequest(restarted.origin, persisted.cookie, '/api/workspaces');
    if (!persistedWorkspaces.some((workspace) => workspace.id === workspaceId)) throw new Error('Workspace did not persist across authenticated core restart');
    const persistedMessages = await jsonRequest(restarted.origin, persisted.cookie, `/api/workspaces/${workspaceId}/messages`);
    if (!persistedMessages.some((message) => message.role === 'agent' && message.content === fake.responseText) || !persistedMessages.some((message) => message.id === messageId)) {
      throw new Error('Fake-provider chat did not persist across authenticated core restart');
    }
  } catch (error) {
    for (const child of [appProcess, nextAppProcess, finalAppProcess]) {
      if (child?.exitCode === null && child?.signalCode === null) await stopOwnedMain(child).catch(() => {});
    }
    if (runtimeApi && instanceId) await runtimeApi.shutdownLocalRuntime({ home, assetsDir: payload, expectedInstanceId: instanceId, timeoutMs: 45_000 }).catch(() => {});
    const logPath = appProcess?.smokeLogPath ?? path.join(profile, 'smoke-electron.log');
    const tail = await readFile(logPath, 'utf8').catch(() => '');
    const exited = appProcess?.exitCode != null ? ` (desktop exit ${appProcess.exitCode})` : '';
    if (error instanceof Error && (exited || tail.trim())) error.message += `${exited}${tail.trim() ? `\nElectron log:\n${tail.slice(-2000)}` : ''}`;
    const coreLog = await readFile(env.NEMA_LOCAL_CORE_LOG, 'utf8').catch(() => '');
    if (error instanceof Error && coreLog.trim()) error.message += `\nLocal core log:\n${coreLog.slice(-4000)}`;
    throw error;
  } finally {
    fake.server.closeAllConnections();
    fake.server.close();
  }

  // Locally the final app and core stay up for visual acceptance; on CI nobody closes them and the step never ends.
  const leaveRunning = !process.env.CI;
  const restartedInstanceId = (await runtimeApi.discoverInstance(home))?.instanceId;
  const result = {
    result: 'passed',
    artifact: path.relative(repo, installer),
    installMs,
    artifactBytes: artifactStat.size,
    executable,
    copiedPayload: payload,
    packagedChrome: { preloadInAsar: true, ownerValidatedControlsInAsar: true, desktopOnlyCss: true },
    electronHome: home,
    electronUserDataProfile: profile,
    workspaceId,
    userMessageId: messageId,
    fakeProviderRequests: fake.requests.filter((request) => request.url === '/v1/responses').length,
    providerAuthorizationWasFakeOnly: providerRequest?.authorization === 'Bearer fake-desktop-smoke-key',
    cssAndFont: assetEvidence,
    electronNoticeEvidence,
    mainProcessCrashBrowserFallback: 'Electron main ChildProcess handle exited; authenticated core instance stayed the same; bundled browser launcher issued a fresh local ticket.',
    gracefulCoreRestart,
    restartedInstanceId,
    finalElectronPid: finalAppProcess?.pid,
    isolatedTestUserData: true,
    cleanup: leaveRunning
      ? 'Final copied Electron test app and authenticated core are left running for parent visual acceptance; temporary tree is preserved.'
      : 'CI: final copied Electron test app and authenticated core were shut down; temporary tree is preserved.',
  };
  const evidencePath = path.join(tempRoot, 'desktop-smoke-result.json');
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  if (!leaveRunning) {
    await stopOwnedMain(finalAppProcess);
    // Chromium helpers can inherit the log pipes and outlive the main process; drop our ends so Node can exit.
    finalAppProcess.stdout?.destroy();
    finalAppProcess.stderr?.destroy();
    if (restartedInstanceId) await runtimeApi.shutdownLocalRuntime({ home, assetsDir: payload, expectedInstanceId: restartedInstanceId, timeoutMs: 45_000 });
  }
  process.stdout.write(`${JSON.stringify({ ...result, evidencePath }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  smoke(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
