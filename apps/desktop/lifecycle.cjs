'use strict';

const { createDiagramWindowOptions, createSecureWindowOptions, createShellWindowOptions, isDiagramWindowUrl, isExternalHttps, isMainMessageUrl, isThreadWindowUrl, threadWindowIdentity, navigationDecision, validateRuntimeLaunchUrl } = require('./security.cjs');
const { registerWindowControls } = require('./window-controls.cjs');
const { registerLoginItem } = require('./login-item.cjs');
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const RELEASE_PAGE = /^https:\/\/github\.com\/Nema-Project\/nema-room\/releases\/tag\/v?\d+\.\d+\.\d+$/;
const VERSION_TEXT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function shortCommit(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{7,64}$/i.test(value.trim())) return '';
  return value.trim().toLowerCase().slice(0, 7);
}

function readJson(file, readFile) {
  try { return JSON.parse(readFile(file, 'utf8')); }
  catch { return null; }
}

function readPackagedIdentity(app, assetsDir, readFile = readFileSync) {
  let version = '';
  try {
    const fromApp = app?.getVersion?.();
    if (typeof fromApp === 'string' && VERSION_TEXT.test(fromApp.trim())) version = fromApp.trim();
  } catch { /* a test double may omit getVersion */ }
  const manifest = readJson(path.join(assetsDir, 'runtime-manifest.json'), readFile) ?? {};
  if (!version && typeof manifest.version === 'string' && VERSION_TEXT.test(manifest.version.trim())) version = manifest.version.trim();
  let commit = shortCommit(manifest.commit) || shortCommit(manifest.build?.commit);
  if (!commit) {
    const meta = readJson(path.join(assetsDir, 'build-metadata.json'), readFile) ?? {};
    commit = shortCommit(meta.commit) || shortCommit(meta.build?.commit);
  }
  return { version, commit };
}

function releaseNotice(status) {
  if (!status || status.state !== 'newer' || typeof status.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(status.version)) return null;
  if (typeof status.url !== 'string' || !RELEASE_PAGE.test(status.url)) return null;
  const tag = status.url.slice(status.url.lastIndexOf('/') + 1);
  if (tag !== status.version && tag !== `v${status.version}`) return null;
  return { label: `Update available: ${status.version}`, url: status.url };
}

function requestReleaseCheck(home) {
  mkdirSync(home, { recursive: true });
  const file = path.join(home, 'update-check-request.json');
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ checkRequestedAt: Date.now() })}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function defaultReleaseBridge({ home, assetsDir, app }) {
  return {
    identity: readPackagedIdentity(app, assetsDir),
    readStatus() {
      return readJson(path.join(home, 'update-status.json'), readFileSync);
    },
    requestCheck() {
      requestReleaseCheck(home);
    },
  };
}

function initialWindowSize(screen) {
  const width = 1180;
  const height = 820;
  const area = screen?.getPrimaryDisplay?.()?.workArea;
  if (!area || !(area.width > 0) || !(area.height > 0)) return { width, height };
  return {
    width: Math.min(area.width - 48, Math.max(width, Math.round(area.width * 0.92))),
    height: Math.min(area.height - 48, Math.max(height, Math.round(area.height * 0.92))),
  };
}

function desktopBenchLine(mark, ms) {
  return `${JSON.stringify({ state: 'desktop-mark', mark, ms })}\n`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Paper, ink, and muted ink from apps/web/app/globals.css. The startup document uses the same pair so the handoff does not flash.
function startupPalette(nativeTheme) {
  if (nativeTheme?.shouldUseDarkColors === true) return { background: '#141311', foreground: '#f3f1ea', muted: '#8f8b82' };
  return { background: '#ffffff', foreground: '#111111', muted: '#8a8a8a' };
}

const STARTUP_PHASE_DETAIL = {
  begin: 'Starting...',
  'helper-scope': 'Preparing local helpers...',
  lease: 'Reserving the local instance...',
  'private-files': 'Checking private files...',
  web: 'Starting the interface...',
  db: 'Opening the database...',
  hub: 'Starting the hub...',
  daemon: 'Connecting the daemon...',
  gateway: 'Opening the gateway...',
  published: 'Opening the room...',
};

function startupDocumentUrl(palette, { title, detail }) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>html,body{margin:0;height:100%;background:${palette.background};color:${palette.foreground};font:15px/1.45 "Helvetica Neue",Arial,sans-serif}body{-webkit-app-region:drag}main{min-height:100%;display:grid;place-items:center;text-align:center;padding:32px}h1{margin:0 0 8px;font-size:20px;font-weight:700}p{margin:0;max-width:440px;color:${palette.muted};white-space:pre-wrap;word-break:break-word}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function startupFailureWasShown(error) {
  return Boolean(error && typeof error === 'object' && error.startupShown === true);
}

function markStartupShown(error) {
  if (error && typeof error === 'object') {
    try { error.startupShown = true; } catch { /* a frozen error still falls back to the dialog */ }
  }
}

function writeDesktopBench(bench, mark) {
  if (!bench) return;
  const line = desktopBenchLine(mark, Date.now() - bench.startedAt);
  if (typeof bench.log === 'function') bench.log(line);
  else process.stdout.write(line);
}

function createDesktopLifecycle({ electron, home, assetsDir, loadRuntimeApi, platform = process.platform, release, bench }) {
  const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, session, ipcMain, screen, nativeTheme } = electron;
  const releaseBridge = release ?? defaultReleaseBridge({ home, assetsDir, app });
  let releaseTimer;
  const brandAsset = (name) => path.join(__dirname, 'assets', name);
  let runtimeApi;
  let currentInstance;
  let mainWindow;
  let pendingMainWindow;
  let openingFailed = false;
  let launchLoadStarted = false;
  const shellEventsBound = new WeakSet();
  const runtimeBound = new WeakSet();
  const threadWindows = new Map();
  const threadLoadGeneration = new WeakMap();
  let tray;
  let isQuitting = false;
  let quitPending = false;

  function getRuntimeApi() {
    runtimeApi ??= loadRuntimeApi();
    return runtimeApi;
  }

  async function ensureCore(onStartupPhase) {
    const api = await getRuntimeApi();
    const instance = await api.ensureLocalRuntime({ home, assetsDir, onStartupPhase });
    currentInstance = instance;
    return instance;
  }

  function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Nema desktop operation failed', message);
    if (startupFailureWasShown(error)) return;
    dialog.showErrorBox('Nema Room could not open', message);
  }

  function openDiagramWindow(url, runtimeOrigin) {
    const child = new BrowserWindow({ ...createDiagramWindowOptions(), icon: brandAsset('icon.png') });
    if (platform !== 'darwin') child.setMenu(null);
    handleNavigation(child, runtimeOrigin, { diagramsOnly: true });
    child.webContents.on('render-process-gone', () => {
      if (!child.isDestroyed()) child.destroy();
    });
    void child.loadURL(url).catch(() => {
      if (!child.isDestroyed()) child.destroy();
    });
  }

  function openThreadWindow(url, runtimeOrigin) {
    const identity = threadWindowIdentity(url, runtimeOrigin);
    const existing = threadWindows.get(identity);
    if (existing && !existing.isDestroyed()) {
      if (existing.webContents.getURL?.() !== url) loadThreadUrl(existing, url);
      existing.show();
      existing.focus();
      return;
    }
    const child = new BrowserWindow({ ...createSecureWindowOptions(runtimeOrigin, platform), icon: brandAsset('icon.png') });
    if (platform !== 'darwin') child.setMenu(null);
    threadWindows.set(identity, child);
    threadLoadGeneration.set(child, 0);
    registerWindowControls({ ipcMain, window: child, runtimeOrigin });
    registerLoginItem({ ipcMain, app, window: child, runtimeOrigin });
    child.once('closed', () => { if (threadWindows.get(identity) === child) threadWindows.delete(identity); });
    handleNavigation(child, runtimeOrigin, { threadIdentity: identity });
    child.once('ready-to-show', () => { if (!child.isDestroyed()) child.show(); });
    child.webContents.on('render-process-gone', () => { if (!child.isDestroyed()) child.destroy(); });
    loadThreadUrl(child, url);
  }

  function loadThreadUrl(window, url) {
    const generation = (threadLoadGeneration.get(window) ?? 0) + 1;
    threadLoadGeneration.set(window, generation);
    let loading;
    try { loading = window.loadURL(url); }
    catch (error) { loading = Promise.reject(error); }
    void Promise.resolve(loading).catch(() => {
      if (threadLoadGeneration.get(window) === generation && !window.isDestroyed()) window.destroy();
    });
  }

  function handleNavigation(window, runtimeOrigin, { diagramsOnly = false, threadIdentity: ownThread } = {}) {
    window.webContents.on('will-navigate', (event, url) => {
      const decision = navigationDecision(url, runtimeOrigin);
      const allowed = diagramsOnly ? isDiagramWindowUrl(url, runtimeOrigin) : ownThread ? threadWindowIdentity(url, runtimeOrigin) === ownThread : decision === 'runtime';
      if (allowed) return;
      event.preventDefault();
      if (ownThread && isMainMessageUrl(url, runtimeOrigin)) {
        void focusMainMessage(url).catch(reportError);
        return;
      }
      if (decision === 'external' && isExternalHttps(url)) void shell.openExternal(url).catch(() => undefined);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (isThreadWindowUrl(url, runtimeOrigin)) openThreadWindow(url, runtimeOrigin);
      else if (isDiagramWindowUrl(url, runtimeOrigin)) openDiagramWindow(url, runtimeOrigin);
      else if (navigationDecision(url, runtimeOrigin) === 'external' && isExternalHttps(url)) void shell.openExternal(url).catch(() => undefined);
      return { action: 'deny' };
    });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  }

  function destroyWindowOnClose(window) {
    window.on('close', (event) => {
      if (isQuitting) return;
      event.preventDefault();
      window.destroy();
    });
    window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; });
  }

  function currentWindowUrl(window) {
    return typeof window.webContents.getURL === 'function' ? window.webContents.getURL() : window.url;
  }

  function isStartupDocument(window) {
    const current = currentWindowUrl(window);
    return typeof current === 'string' && current.startsWith('data:');
  }

  function attachShell(window) {
    if (shellEventsBound.has(window)) return;
    shellEventsBound.add(window);
    if (platform !== 'darwin') window.setMenu(null);
    destroyWindowOnClose(window);
    let sawLaunchShow = false;
    let sawLaunchLoad = false;
    window.on('ready-to-show', () => {
      if (!launchLoadStarted || isStartupDocument(window) || window.isDestroyed()) return;
      if (!sawLaunchShow) {
        sawLaunchShow = true;
        writeDesktopBench(bench, 'ready-to-show');
      }
      window.show();
    });
    window.webContents.on('did-finish-load', () => {
      if (!launchLoadStarted || isStartupDocument(window) || sawLaunchLoad) return;
      sawLaunchLoad = true;
      writeDesktopBench(bench, 'did-finish-load');
    });
    window.webContents.on('render-process-gone', () => {
      if (!window.isDestroyed()) window.destroy();
    });
    window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) console.error('Nema renderer load failed', code, description);
    });
  }

  function bindRuntime(window, origin) {
    if (runtimeBound.has(window)) return;
    runtimeBound.add(window);
    registerWindowControls({ ipcMain, window, runtimeOrigin: origin });
    registerLoginItem({ ipcMain, app, window, runtimeOrigin: origin });
    handleNavigation(window, origin);
  }

  function showStartup(window, palette, title, detail) {
    if (window.isDestroyed()) return;
    window.show();
    void window.loadURL(startupDocumentUrl(palette, { title, detail })).catch(() => undefined);
  }

  async function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed() && !openingFailed) {
      mainWindow.show();
      mainWindow.focus();
      return mainWindow;
    }
    if (pendingMainWindow) return pendingMainWindow;
    const opening = (async () => {
      const palette = startupPalette(nativeTheme);
      let window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
      if (!window) {
        window = new BrowserWindow({
          ...createShellWindowOptions(platform),
          ...initialWindowSize(screen),
          backgroundColor: palette.background,
          show: true,
          icon: brandAsset('icon.png'),
        });
        mainWindow = window;
        attachShell(window);
      }
      showStartup(window, palette, 'Nema Room', 'Starting...');
      try {
        const instance = await ensureCore((phase) => {
          const detail = STARTUP_PHASE_DETAIL[phase];
          if (!detail || window.isDestroyed() || !isStartupDocument(window)) return;
          showStartup(window, palette, 'Nema Room', detail);
        });
        writeDesktopBench(bench, 'runtime-ready');
        validateRuntimeLaunchUrl(instance.launchUrl, instance.origin);
        if (window.isDestroyed()) return window;
        bindRuntime(window, instance.origin);
        launchLoadStarted = true;
        await window.loadURL(instance.launchUrl);
        openingFailed = false;
        return window;
      } catch (error) {
        openingFailed = true;
        if (!window.isDestroyed()) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            await window.loadURL(startupDocumentUrl(palette, { title: 'Nema Room could not open', detail: message }));
            markStartupShown(error);
          } catch { /* the dialog remains the fallback when the window cannot show the error */ }
        }
        throw error;
      }
    })();
    pendingMainWindow = opening;
    try { return await opening; }
    finally { if (pendingMainWindow === opening) pendingMainWindow = undefined; }
  }

  async function focusMainMessage(url) {
    const window = await createMainWindow();
    await window.loadURL(url);
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  }

  async function openBrowserMode() {
    const instance = await ensureCore();
    validateRuntimeLaunchUrl(instance.launchUrl, instance.origin);
    await shell.openExternal(instance.launchUrl);
  }

  async function quitNema() {
    if (releaseTimer) clearInterval(releaseTimer);
    if (quitPending || isQuitting) return;
    quitPending = true;
    try {
      if (currentInstance?.instanceId) {
        const api = await getRuntimeApi();
        await api.shutdownLocalRuntime({ home, assetsDir, expectedInstanceId: currentInstance.instanceId, timeoutMs: 45_000 });
      }
      isQuitting = true;
      app.quit();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox('Nema Room could not finish quitting', message);
      if (!mainWindow || mainWindow.isDestroyed()) void createMainWindow().catch(reportError);
    } finally { quitPending = false; }
  }

  const open = () => { void createMainWindow().catch(reportError); };
  const browser = () => { void openBrowserMode().catch(reportError); };
  const quit = () => { void quitNema(); };

  function menuEntries() {
    const identity = releaseBridge.identity ?? {};
    const version = typeof identity.version === 'string' && VERSION_TEXT.test(identity.version) ? identity.version : '';
    const commit = shortCommit(identity.commit);
    let status = null;
    try { status = releaseBridge.readStatus?.() ?? null; }
    catch { status = null; }
    const notice = releaseNotice(status);
    const entries = [
      {
        label: `About Nema Room${version ? ` ${version}` : ''}${commit ? ` (${commit})` : ''}`,
        click: () => {
          if (typeof dialog.showMessageBox !== 'function') return;
          void dialog.showMessageBox({
            type: 'info',
            title: 'About Nema Room',
            message: version ? `Nema Room ${version}` : 'Nema Room',
            detail: commit ? `Build ${commit}` : '',
            buttons: ['OK'],
          });
        },
      },
      { type: 'separator' },
      { label: 'Open Nema Room', click: open },
      { label: 'Open in Browser', click: browser },
      { type: 'separator' },
      { label: 'Check for Updates', click: () => { try { releaseBridge.requestCheck(); } catch { /* preference write stays local and quiet */ } } },
    ];
    if (notice) entries.push({ label: notice.label, click: () => { void shell.openExternal(notice.url).catch(() => undefined); } });
    entries.push(
      { type: 'separator' },
      { label: 'Quit Nema Room', accelerator: platform === 'darwin' ? 'Command+Q' : 'Ctrl+Shift+Q', click: quit },
    );
    return entries;
  }

  function applyMenus() {
    const entries = menuEntries();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Nema Room', submenu: entries }]));
    if (tray) tray.setContextMenu(Menu.buildFromTemplate(entries));
  }

  function refreshReleaseMenu() {
    applyMenus();
  }

  function buildMenus() {
    try {
      const icon = nativeImage.createFromPath(brandAsset(platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
      if (platform === 'darwin') icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip('Nema Room');
      tray.on('click', open);
    } catch (error) { console.error('Nema Room tray icon failed', error); }
    applyMenus();
  }

  async function install() {
    if (!app.requestSingleInstanceLock()) {
      app.quit();
      return false;
    }
    app.on('second-instance', () => { void createMainWindow().catch(reportError); });
    app.on('before-quit', (event) => {
      if (isQuitting) return;
      event.preventDefault();
      void quitNema();
    });
    // An empty listener suppresses Electron's default quit-on-last-window behavior.
    app.on('window-all-closed', () => {});
    app.on('activate', () => { void createMainWindow().catch(reportError); });
    await app.whenReady();
    writeDesktopBench(bench, 'app-ready');
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    buildMenus();
    if (process.env.VITEST !== 'true') {
      releaseTimer = setInterval(() => refreshReleaseMenu(), 5_000);
      releaseTimer.unref?.();
    }
    await createMainWindow();
    return true;
  }

  return { createMainWindow, install, openBrowserMode, quitNema, refreshReleaseMenu };
}

module.exports = { createDesktopLifecycle, desktopBenchLine, initialWindowSize, readPackagedIdentity, releaseNotice, requestReleaseCheck, startupDocumentUrl, startupFailureWasShown, startupPalette };
