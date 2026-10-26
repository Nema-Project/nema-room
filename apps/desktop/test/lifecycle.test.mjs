import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createDesktopLifecycle, initialWindowSize } = require('../lifecycle.cjs');

function harness(overrides = {}) {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = vi.fn(() => overrides.lock !== false);
  app.whenReady = vi.fn(() => Promise.resolve());
  app.quit = vi.fn();
  app.getFileIcon = vi.fn(async () => ({}));
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.url = '';
      this.destroyed = false;
      this.setMenu = vi.fn();
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = vi.fn();
      windows.push(this);
    }
    async loadURL(url) { this.url = url; this.webContents.mainFrame = { url }; return url.includes('/w/') ? overrides.loadURL?.(this, url) : undefined; }
    close() { this.closeEvent = { preventDefault: vi.fn() }; this.emit('close', this.closeEvent); }
    show = vi.fn();
    focus = vi.fn();
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  const shell = { openExternal: vi.fn(async () => {}) };
  const ipcHandlers = new Map();
  const ipcMain = { handle: vi.fn((channel, handler) => ipcHandlers.set(channel, handler)), removeHandler: vi.fn((channel) => ipcHandlers.delete(channel)) };
  const dialog = { showErrorBox: vi.fn() };
  const Menu = { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn((value) => value) };
  const trays = [];
  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; trays.push(this); }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
  }
  const nativeImage = { createFromPath: (file) => ({ file, setTemplateImage(value) { this.template = value; } }) };
  const electron = {
    app,
    BrowserWindow,
    Menu,
    Tray,
    dialog,
    shell,
    session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
    ipcMain,
    nativeImage,
  };
  let launches = 0;
  const runtimeApi = {
    ensureLocalRuntime: vi.fn(async () => ({
      origin: 'http://127.0.0.1:43001',
      launchUrl: `http://127.0.0.1:43001/_nema/launch?ticket=${String(++launches).padStart(64, 'a')}`,
      instanceId: 'e7543210-bd2a-44c1-8c5c-37db1ef40123',
      installationId: 'b'.repeat(64),
    })),
    shutdownLocalRuntime: vi.fn(overrides.shutdown ?? (async () => ({ state: 'complete' }))),
  };
  const lifecycle = createDesktopLifecycle({
    electron,
    home: 'C:/Users/Test/.nema/desktop',
    assetsDir: 'C:/Nema/resources/payload',
    loadRuntimeApi: async () => runtimeApi,
    platform: overrides.platform ?? process.platform,
  });
  return { app, windows, trays, shell, dialog, electron, ipcHandlers, runtimeApi, lifecycle };
}

describe('Electron shell lifecycle', () => {
  it.each(['win32', 'darwin'])('loads shipped window and tray icons on %s and reopens from the tray', async (platform) => {
    const value = harness({ platform });
    await value.lifecycle.install();
    expect(value.windows[0].options.title).toBe('Nema Room');
    expect(value.windows[0].options).toMatchObject({ width: 1180, height: 820 });
    expect(path.basename(value.windows[0].options.icon)).toBe('icon.png');
    expect(existsSync(value.windows[0].options.icon)).toBe(true);
    expect(value.trays).toHaveLength(1);
    const tray = value.trays[0];
    expect(tray.tooltip).toBe('Nema Room');
    expect(path.basename(tray.icon.file)).toBe(platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');
    expect(existsSync(tray.icon.file)).toBe(true);
    if (platform === 'darwin') expect(tray.icon.template).toBe(true);
    expect(value.app.getFileIcon).not.toHaveBeenCalled();
    value.windows[0].close();
    tray.emit('click');
    await new Promise((resolve) => setImmediate(resolve));
    expect(value.windows).toHaveLength(2);
    expect(value.runtimeApi.shutdownLocalRuntime).not.toHaveBeenCalled();
  });
  it('opens across most of the work area instead of the 1180 fallback', () => {
    expect(initialWindowSize({ getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1032 } }) })).toEqual({ width: 1766, height: 949 });
    expect(initialWindowSize(undefined)).toEqual({ width: 1180, height: 820 });
  });

  it('does not start a second application without the single-instance lock', async () => {
    const value = harness({ lock: false });
    await value.lifecycle.install();
    expect(value.app.quit).toHaveBeenCalledOnce();
    expect(value.runtimeApi.ensureLocalRuntime).not.toHaveBeenCalled();
    expect(value.windows).toHaveLength(0);
  });

  it('removes the per-window native menu on Windows so Alt cannot reveal a second menu row', async () => {
    const value = harness();
    await value.lifecycle.install();
    if (process.platform !== 'darwin') expect(value.windows[0].setMenu).toHaveBeenCalledWith(null);
  });

  it('coalesces simultaneous activation requests while the shared core is still resolving', async () => {
    const value = harness();
    await value.lifecycle.install();
    value.windows[0].destroy();
    let resolveRuntime;
    const pendingRuntime = new Promise((resolve) => { resolveRuntime = resolve; });
    value.runtimeApi.ensureLocalRuntime.mockImplementation(() => pendingRuntime);

    value.app.emit('activate');
    value.app.emit('second-instance');
    value.app.emit('activate');
    await new Promise((resolve) => setImmediate(resolve));
    expect(value.runtimeApi.ensureLocalRuntime).toHaveBeenCalledTimes(2);

    resolveRuntime({
      origin: 'http://127.0.0.1:43001',
      launchUrl: `http://127.0.0.1:43001/_nema/launch?ticket=${'c'.repeat(64)}`,
      instanceId: 'e7543210-bd2a-44c1-8c5c-37db1ef40123',
      installationId: 'b'.repeat(64),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(value.windows).toHaveLength(2);
  });

  it('does not bind Windows window close to the explicit Quit Nema action', async () => {
    const value = harness();
    await value.lifecycle.install();
    const template = value.electron.Menu.setApplicationMenu.mock.calls[0][0];
    const quit = template[0].submenu.find((item) => item.label === 'Quit Nema Room');
    expect(quit.accelerator).not.toBe('Alt+F4');
    expect(quit.accelerator).toBe('Ctrl+Shift+Q');
  });

  it('keeps the core alive when its window closes and gets a fresh ticket on activation', async () => {
    const value = harness();
    await value.lifecycle.install();
    const first = value.windows[0];
    const closeEvent = { preventDefault: vi.fn() };
    first.emit('close', closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(first.destroyed).toBe(true);
    expect(value.runtimeApi.shutdownLocalRuntime).not.toHaveBeenCalled();
    value.app.emit('activate');
    await new Promise((resolve) => setImmediate(resolve));
    expect(value.windows).toHaveLength(2);
    expect(value.windows[1].url).not.toBe(first.url);
  });

  it('routes the custom close IPC through close-to-tray without authenticated Quit', async () => {
    const value = harness();
    await value.lifecycle.install();
    const window = value.windows[0];
    value.ipcHandlers.get('nema:window:close')({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
    expect(window.closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.destroyed).toBe(true);
    expect(value.runtimeApi.shutdownLocalRuntime).not.toHaveBeenCalled();
    expect(value.app.quit).not.toHaveBeenCalled();
  });

  it('waits for authenticated runtime drain before quitting', async () => {
    let finishDrain;
    const value = harness({ shutdown: () => new Promise((resolve) => { finishDrain = resolve; }) });
    await value.lifecycle.install();
    let settled = false;
    const quitting = value.lifecycle.quitNema().then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(value.app.quit).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    finishDrain({ state: 'complete' });
    await quitting;
    expect(value.runtimeApi.shutdownLocalRuntime).toHaveBeenCalledWith(expect.objectContaining({ expectedInstanceId: expect.any(String) }));
    expect(value.app.quit).toHaveBeenCalledOnce();
  });

  it('keeps the browser fallback available when authenticated shutdown fails', async () => {
    const value = harness({ shutdown: async () => { throw new Error('helper drain failed'); } });
    await value.lifecycle.install();
    await value.lifecycle.quitNema();
    expect(value.app.quit).not.toHaveBeenCalled();
    expect(value.dialog.showErrorBox).toHaveBeenCalledWith('Nema Room could not finish quitting', 'helper drain failed');
    await value.lifecycle.openBrowserMode();
    expect(value.shell.openExternal).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/127\.0\.0\.1:43001\/_nema\/launch\?ticket=/));
  });

  it('opens a same-origin diagram in its own window and still denies every other popup', async () => {
    const value = harness();
    await value.lifecycle.install();
    const origin = 'http://127.0.0.1:43001';
    const diagram = `${origin}/api/workspaces/ws_abc/diagrams/G-1.html`;
    const handler = value.windows[0].webContents.setWindowOpenHandler.mock.calls[0][0];

    expect(handler({ url: diagram })).toEqual({ action: 'deny' });
    expect(value.windows).toHaveLength(2);
    expect(value.windows[1].url).toBe(diagram);
    expect(value.windows[1].options.webPreferences).toMatchObject({
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    });
    expect(value.windows[1].options.webPreferences.preload).toBeUndefined();
    expect(value.windows[1].options.frame).not.toBe(false);

    const leaveDiagram = { preventDefault: vi.fn() };
    value.windows[1].webContents.emit('will-navigate', leaveDiagram, `${origin}/`);
    expect(leaveDiagram.preventDefault).toHaveBeenCalledOnce();
    const stayOnDiagram = { preventDefault: vi.fn() };
    value.windows[1].webContents.emit('will-navigate', stayOnDiagram, diagram);
    expect(stayOnDiagram.preventDefault).not.toHaveBeenCalled();

    const mainNav = { preventDefault: vi.fn() };
    value.windows[0].webContents.emit('will-navigate', mainNav, `${origin}/`);
    expect(mainNav.preventDefault).not.toHaveBeenCalled();

    expect(handler({ url: `${origin}/` })).toEqual({ action: 'deny' });
    expect(value.windows).toHaveLength(2);
    expect(handler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' });
    expect(value.shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });

  it('opens a same-origin thread URL in its own secure window and denies query variants', async () => {
    const value = harness();
    await value.lifecycle.install();
    const origin = 'http://127.0.0.1:43001';
    const url = `${origin}/w/ws_abc/t/m_xyz`;
    const handler = value.windows[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(handler({ url })).toEqual({ action: 'deny' });
    expect(value.windows).toHaveLength(2);
    const thread = value.windows[1];
    expect(thread.url).toBe(url);
    expect(thread.options.webPreferences.preload).toBeTruthy();
    expect(thread.options).toMatchObject({ frame: false });
    expect(handler({ url: `${url}?bad=1` })).toEqual({ action: 'deny' });
    expect(value.windows).toHaveLength(2);
  });

  it('focuses and reuses a thread window when reopened with another valid focus target', async () => {
    const value = harness();
    await value.lifecycle.install();
    const origin = 'http://127.0.0.1:43001';
    const base = `${origin}/w/ws_abc/t/m_xyz`;
    const handler = value.windows[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    handler({ url: `${base}?messageId=m_first` });
    const thread = value.windows[1];
    const show = vi.spyOn(thread, 'show');
    const focus = vi.spyOn(thread, 'focus');
    handler({ url: `${base}?messageId=m_second` });
    expect(value.windows).toHaveLength(2);
    expect(show).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(thread.url).toBe(`${base}?messageId=m_second`);
  });

  it('reveals a new thread window when its first page is ready', async () => {
    const value = harness();
    await value.lifecycle.install();
    const handler = value.windows[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    handler({ url: 'http://127.0.0.1:43001/w/ws_abc/t/m_xyz' });
    const thread = value.windows[1];
    expect(thread.options.show).toBe(false);
    thread.emit('ready-to-show');
    expect(thread.show).toHaveBeenCalledOnce();
    expect(thread.destroyed).toBe(false);
  });

  it('ignores a cancelled stale load after a replacement focus target starts', async () => {
    const deferredLoads = new Map();
    const value = harness({ loadURL: (_window, url) => new Promise((resolve, reject) => deferredLoads.set(url, { resolve, reject })) });
    await value.lifecycle.install();
    const handler = value.windows[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    const firstUrl = 'http://127.0.0.1:43001/w/ws_abc/t/m_xyz?messageId=m_first';
    const latestUrl = 'http://127.0.0.1:43001/w/ws_abc/t/m_xyz?messageId=m_latest';
    handler({ url: firstUrl });
    const thread = value.windows[1];
    handler({ url: latestUrl });
    deferredLoads.get(firstUrl).reject(new Error('ERR_ABORTED'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(thread.destroyed).toBe(false);
    expect(thread.url).toBe(latestUrl);
    deferredLoads.get(latestUrl).resolve();
  });

  it('handles a failed current replacement load and destroys the unusable thread window', async () => {
    const deferredLoads = new Map();
    const value = harness({ loadURL: (_window, url) => new Promise((resolve, reject) => deferredLoads.set(url, { resolve, reject })) });
    await value.lifecycle.install();
    const handler = value.windows[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    const firstUrl = 'http://127.0.0.1:43001/w/ws_abc/t/m_xyz?messageId=m_first';
    const latestUrl = 'http://127.0.0.1:43001/w/ws_abc/t/m_xyz?messageId=m_latest';
    handler({ url: firstUrl });
    const thread = value.windows[1];
    handler({ url: latestUrl });
    deferredLoads.get(latestUrl).reject(new Error('replacement failed'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(thread.destroyed).toBe(true);
    deferredLoads.get(firstUrl).reject(new Error('ERR_ABORTED'));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('destroys a crashed renderer without stopping the shared core', async () => {
    const value = harness();
    await value.lifecycle.install();
    const first = value.windows[0];
    first.webContents.emit('render-process-gone');
    expect(first.destroyed).toBe(true);
    expect(value.runtimeApi.shutdownLocalRuntime).not.toHaveBeenCalled();
    await value.lifecycle.createMainWindow();
    expect(value.windows).toHaveLength(2);
    expect(value.runtimeApi.ensureLocalRuntime).toHaveBeenCalledTimes(2);
  });
});
