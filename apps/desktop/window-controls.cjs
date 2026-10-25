'use strict';

const CHANNELS = Object.freeze({
  minimize: 'nema:window:minimize',
  toggleMaximize: 'nema:window:toggle-maximize',
  close: 'nema:window:close',
  getState: 'nema:window:get-state',
  stateChanged: 'nema:window:state-changed',
});

function registerWindowControls({ ipcMain, window, runtimeOrigin }) {
  const webContents = window.webContents;
  let disposed = false;
  const isTrustedOwner = (event) => {
    if (disposed || window.isDestroyed() || webContents.isDestroyed?.() || event.sender !== webContents || event.senderFrame !== webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === runtimeOrigin; }
    catch { return false; }
  };
  const handlers = new Map([
    [CHANNELS.minimize, () => window.minimize()],
    [CHANNELS.toggleMaximize, () => window.isMaximized() ? window.unmaximize() : window.maximize()],
    [CHANNELS.close, () => window.close()],
    [CHANNELS.getState, () => ({ maximized: window.isMaximized() })],
  ]);
  for (const [channel, action] of handlers) {
    ipcMain.handle(channel, (event) => {
      if (!isTrustedOwner(event)) throw new Error('Untrusted window-control sender');
      return action();
    });
  }
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
    for (const channel of handlers.keys()) ipcMain.removeHandler(channel);
    window.removeListener('maximize', publishState);
    window.removeListener('unmaximize', publishState);
  };
  window.once('closed', cleanup);
  return cleanup;
}

module.exports = { CHANNELS, registerWindowControls };
