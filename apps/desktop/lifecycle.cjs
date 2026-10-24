'use strict';

const { createSecureWindowOptions, isExternalHttps, navigationDecision, validateRuntimeLaunchUrl } = require('./security.cjs');

function createDesktopLifecycle({ electron, home, assetsDir, loadRuntimeApi }) {
  const { app, BrowserWindow, Menu, Tray, dialog, shell, session } = electron;
  let runtimeApi;
  let currentInstance;
  let mainWindow;
  let pendingMainWindow;
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
    dialog.showErrorBox('Nema could not open', message);
  }

  function handleNavigation(window, runtimeOrigin) {
    window.webContents.on('will-navigate', (event, url) => {
      const decision = navigationDecision(url, runtimeOrigin);
      if (decision === 'runtime') return;
      event.preventDefault();
      if (decision === 'external' && isExternalHttps(url)) void shell.openExternal(url).catch(() => undefined);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (navigationDecision(url, runtimeOrigin) === 'external' && isExternalHttps(url)) void shell.openExternal(url).catch(() => undefined);
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
      const window = new BrowserWindow(createSecureWindowOptions(instance.origin));
      mainWindow = window;
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
      dialog.showErrorBox('Nema could not finish quitting', message);
      if (!mainWindow || mainWindow.isDestroyed()) void createMainWindow().catch(reportError);
    } finally { quitPending = false; }
  }

  function buildMenus() {
    const open = () => { void createMainWindow().catch(reportError); };
    const browser = () => { void openBrowserMode().catch(reportError); };
    const quit = () => { void quitNema(); };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Nema', submenu: [
        { label: 'Open Nema', click: open },
        { label: 'Open in Browser', click: browser },
        { type: 'separator' },
        { label: 'Quit Nema', accelerator: process.platform === 'darwin' ? 'Command+Q' : 'Ctrl+Shift+Q', click: quit },
      ] },
    ]));
    void app.getFileIcon(process.execPath, { size: 'small' }).then((icon) => {
      tray = new Tray(icon);
      tray.setToolTip('Nema');
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Nema', click: open },
        { label: 'Open in Browser', click: browser },
        { type: 'separator' },
        { label: 'Quit Nema', click: quit },
      ]));
      tray.on('click', open);
    }).catch((error) => console.error('Nema tray icon failed', error));
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

module.exports = { createDesktopLifecycle };
