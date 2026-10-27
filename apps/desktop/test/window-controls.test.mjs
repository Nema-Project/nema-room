import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerWindowControls } = require('../window-controls.cjs');

function harness() {
  const handlers = new Map();
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel)),
  };
  const events = new Map();
  const frame = { url: 'http://127.0.0.1:43001/work' };
  const window = {
    webContents: { mainFrame: frame, send: vi.fn(), isDestroyed: () => false },
    isDestroyed: () => false,
    isMaximized: vi.fn(() => false),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event, callback) => events.set(event, callback)),
    once: vi.fn((event, callback) => events.set(event, callback)),
    removeListener: vi.fn((event) => events.delete(event)),
  };
  const cleanup = registerWindowControls({ ipcMain, window, runtimeOrigin: 'http://127.0.0.1:43001' });
  const call = (action, sender = window.webContents, senderFrame = frame) => {
    const handler = handlers.get(`nema:window:${action}`);
    if (!handler) throw new Error('Unknown window control');
    return handler({ sender, senderFrame });
  };
  return { handlers, ipcMain, events, frame, window, cleanup, call };
}

describe('owning Electron window controls', () => {
  it('dispatches controls to each registered owner and retains shared handlers until the last closes', () => {
    const first = harness();
    const secondWindow = {
      ...first.window,
      webContents: { mainFrame: { url: first.frame.url }, send: vi.fn(), isDestroyed: () => false },
      isDestroyed: () => false,
      minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(), close: vi.fn(),
      on: vi.fn(), once: vi.fn(), removeListener: vi.fn(),
    };
    const secondCleanup = registerWindowControls({ ipcMain: first.ipcMain, window: secondWindow, runtimeOrigin: 'http://127.0.0.1:43001' });
    expect(first.ipcMain.handle).toHaveBeenCalledTimes(4);
    const minimize = first.handlers.get('nema:window:minimize');
    expect(() => minimize({ sender: secondWindow.webContents, senderFrame: secondWindow.webContents.mainFrame })).not.toThrow();
    expect(secondWindow.minimize).toHaveBeenCalledOnce();
    expect(first.window.minimize).not.toHaveBeenCalled();
    first.cleanup();
    expect(first.ipcMain.removeHandler).not.toHaveBeenCalled();
    secondCleanup();
    expect(first.ipcMain.removeHandler).toHaveBeenCalledTimes(4);
  });

  it('dispatches only the fixed minimize, maximize, close, and state actions', () => {
    const h = harness();
    expect(h.call('minimize')).toBeUndefined();
    expect(h.call('toggle-maximize')).toBeUndefined();
    expect(h.call('close')).toBeUndefined();
    expect(h.call('get-state')).toEqual({ maximized: false, fullScreen: false });
    expect(h.window.minimize).toHaveBeenCalledOnce();
    expect(h.window.maximize).toHaveBeenCalledOnce();
    expect(h.window.close).toHaveBeenCalledOnce();
    expect(() => h.call('quit')).toThrow('Unknown window control');
  });

  it('rejects foreign windows, subframes, and senders outside the verified origin', () => {
    const h = harness();
    expect(() => h.call('minimize', {})).toThrow();
    expect(() => h.call('close', h.window.webContents, { url: h.frame.url })).toThrow();
    h.frame.url = 'https://example.invalid/';
    expect(() => h.call('get-state')).toThrow();
    expect(h.window.minimize).not.toHaveBeenCalled();
  });

  it('publishes maximize and fullscreen state and removes handlers and listeners on cleanup', () => {
    const h = harness();
    h.window.isMaximized.mockReturnValue(true);
    h.window.isFullScreen = () => true;
    h.events.get('maximize')();
    expect(h.window.webContents.send).toHaveBeenCalledWith('nema:window:state-changed', { maximized: true, fullScreen: true });
    h.window.isMaximized.mockReturnValue(false);
    h.window.isFullScreen = () => false;
    h.events.get('leave-full-screen')();
    expect(h.window.webContents.send).toHaveBeenCalledWith('nema:window:state-changed', { maximized: false, fullScreen: false });
    h.cleanup();
    expect(h.ipcMain.removeHandler).toHaveBeenCalledTimes(4);
    expect(h.window.removeListener).toHaveBeenCalledWith('maximize', expect.any(Function));
    expect(h.window.removeListener).toHaveBeenCalledWith('unmaximize', expect.any(Function));
    expect(h.window.removeListener).toHaveBeenCalledWith('enter-full-screen', expect.any(Function));
    expect(h.window.removeListener).toHaveBeenCalledWith('leave-full-screen', expect.any(Function));
  });
});
