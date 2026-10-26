'use strict';

const { createDiagramWindowOptions, createSecureWindowOptions, isDiagramWindowUrl, isExternalHttps, isMainMessageUrl, isThreadWindowUrl, threadWindowIdentity, navigationDecision, validateRuntimeLaunchUrl } = require('./security.cjs');
const { registerWindowControls } = require('./window-controls.cjs');
const path = require('node:path');

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

function createDesktopLifecycle({ electron, home, assetsDir, loadRuntimeApi, platform = process.platform }) {
  const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, session, ipcMain, screen } = electron;
  const brandAsset = (name) => path.join(__dirname, 'assets', name);
  let runtimeApi;
  let currentInstance;
  let mainWindow;
  let pendingMainWindow;
  const threadWindows = new Map();
  const threadLoadGeneration = new WeakMap();
  let tray;
  let isQuitting = false;
  let quitPending = false;

  function getRuntimeApi() {
    runtimeApi ??= loadRuntimeApi();
    return runtimeApi;
  }

  async function ensureCore() {
    const api = await getRuntimeApi();
    const instance = await api.ensureLocalRuntime({ home, assetsDir });
    currentInstance = instance;
    return instance;
  }

  function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Nema desktop operation failed', message);
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
    const child = new BrowserWindow({ ...createSecureWindowOptions(runtimeOrigin), icon: brandAsset('icon.png') });
    if (platform !== 'darwin') child.setMenu(null);
    threadWindows.set(identity, child);
    threadLoadGeneration.set(child, 0);
    registerWindowControls({ ipcMain, window: child, runtimeOrigin });
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

  async function createMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return mainWindow;
    }
    if (pendingMainWindow) return pendingMainWindow;
    const opening = (async () => {
      const instance = await ensureCore();
      validateRuntimeLaunchUrl(instance.launchUrl, instance.origin);
      const window = new BrowserWindow({ ...createSecureWindowOptions(instance.origin), ...initialWindowSize(screen), icon: brandAsset('icon.png') });
      if (platform !== 'darwin') window.setMenu(null);
      mainWindow = window;
      registerWindowControls({ ipcMain, window, runtimeOrigin: instance.origin });
      destroyWindowOnClose(window);
      handleNavigation(window, instance.origin);
      window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
      window.webContents.on('render-process-gone', () => {
        if (!window.isDestroyed()) window.destroy();
      });
      window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) console.error('Nema renderer load failed', code, description);
      });
      await window.loadURL(instance.launchUrl);
      return window;
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

  function buildMenus() {
    const open = () => { void createMainWindow().catch(reportError); };
    const browser = () => { void openBrowserMode().catch(reportError); };
    const quit = () => { void quitNema(); };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Nema Room', submenu: [
        { label: 'Open Nema Room', click: open },
        { label: 'Open in Browser', click: browser },
        { type: 'separator' },
        { label: 'Quit Nema Room', accelerator: platform === 'darwin' ? 'Command+Q' : 'Ctrl+Shift+Q', click: quit },
      ] },
    ]));
    try {
      const icon = nativeImage.createFromPath(brandAsset(platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
      if (platform === 'darwin') icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip('Nema Room');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Nema Room', click: open },
        { label: 'Open in Browser', click: browser },
        { type: 'separator' },
        { label: 'Quit Nema Room', click: quit },
      ]));
      tray.on('click', open);
    } catch (error) { console.error('Nema Room tray icon failed', error); }
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
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    buildMenus();
    await createMainWindow();
    return true;
  }

  return { createMainWindow, install, openBrowserMode, quitNema };
}

module.exports = { createDesktopLifecycle, initialWindowSize };
