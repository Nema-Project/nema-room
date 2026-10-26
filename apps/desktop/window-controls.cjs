'use strict';

const CHANNELS = Object.freeze({
  minimize: 'nema:window:minimize',
  toggleMaximize: 'nema:window:toggle-maximize',
  close: 'nema:window:close',
  getState: 'nema:window:get-state',
  stateChanged: 'nema:window:state-changed',
});

const registries = new WeakMap();

function registerWindowControls({ ipcMain, window, runtimeOrigin }) {
  const webContents = window.webContents;
  let disposed = false;
  const handlers = new Map([
    [CHANNELS.minimize, () => window.minimize()],
    [CHANNELS.toggleMaximize, () => window.isMaximized() ? window.unmaximize() : window.maximize()],
    [CHANNELS.close, () => window.close()],
    [CHANNELS.getState, () => ({ maximized: window.isMaximized() })],
  ]);
  let registry = registries.get(ipcMain);
  if (!registry) {
    registry = { owners: new Map(), channels: new Set() };
    registries.set(ipcMain, registry);
  }
  for (const channel of handlers.keys()) {
    if (registry.channels.has(channel)) continue;
    ipcMain.handle(channel, (event, ...args) => {
      const owner = registry.owners.get(event.sender);
      if (!owner || owner.disposed || owner.window.isDestroyed() || owner.webContents.isDestroyed?.() || event.senderFrame !== owner.webContents.mainFrame) throw new Error('Untrusted window-control sender');
      try { if (new URL(event.senderFrame.url).origin !== owner.runtimeOrigin) throw new Error(); }
      catch { throw new Error('Untrusted window-control sender'); }
      return owner.handlers.get(channel)(...args);
    });
    registry.channels.add(channel);
  }
  const owner = { window, webContents, runtimeOrigin, handlers, disposed: false };
  registry.owners.set(webContents, owner);
  const publishState = () => {
    if (!disposed && !window.isDestroyed() && !webContents.isDestroyed?.()) {
      webContents.send(CHANNELS.stateChanged, { maximized: window.isMaximized() });
    }
  };
  window.on('maximize', publishState);
  window.on('unmaximize', publishState);
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    owner.disposed = true;
    registry.owners.delete(webContents);
    if (registry.owners.size === 0) {
      for (const channel of registry.channels) ipcMain.removeHandler(channel);
      registry.channels.clear();
      registries.delete(ipcMain);
    }
    window.removeListener('maximize', publishState);
    window.removeListener('unmaximize', publishState);
  };
  window.once('closed', cleanup);
  return cleanup;
}

module.exports = { CHANNELS, registerWindowControls };
