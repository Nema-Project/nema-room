import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { registerLoginItem } = require('../login-item.cjs');

function harness(openAtLogin = false) {
  let enabled = openAtLogin;
  const app = {
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled })),
    setLoginItemSettings: vi.fn((value) => { enabled = value.openAtLogin === true; }),
  };
  const handlers = new Map();
  const ipcMain = {
    handle: vi.fn((channel, handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel) => handlers.delete(channel)),
  };
  const frame = { url: 'http://127.0.0.1:43001/work' };
  const window = {
    webContents: { mainFrame: frame, isDestroyed: () => false },
    isDestroyed: () => false,
    once: vi.fn(),
  };
  const cleanup = registerLoginItem({ ipcMain, app, window, runtimeOrigin: 'http://127.0.0.1:43001' });
  const call = (action, payload, sender = window.webContents, senderFrame = frame) => {
    const handler = handlers.get(`nema:login-item:${action}`);
    if (!handler) throw new Error('Unknown login item channel');
    return handler({ sender, senderFrame }, payload);
  };
  return { app, handlers, ipcMain, frame, window, cleanup, call };
}

describe('desktop open-at-login bridge', () => {
  it('reads and writes only openAtLogin for the owning runtime window', () => {
    const h = harness(true);
    expect(h.call('get')).toEqual({ openAtLogin: true });
    expect(h.call('set', { openAtLogin: false })).toEqual({ openAtLogin: false });
    expect(h.app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
    expect(h.call('get')).toEqual({ openAtLogin: false });
  });

  it('rejects a non-boolean and does not call Electron', () => {
    const h = harness(false);
    expect(() => h.call('set', { openAtLogin: 'yes' })).toThrow(/Invalid login item setting/);
    expect(() => h.call('set', null)).toThrow(/Invalid login item setting/);
    expect(h.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('rejects foreign windows, subframes, and senders outside the runtime origin', () => {
    const h = harness(false);
    expect(() => h.call('get', undefined, {})).toThrow(/Untrusted login-item sender/);
    expect(() => h.call('set', { openAtLogin: true }, h.window.webContents, { url: h.frame.url })).toThrow(/Untrusted login-item sender/);
    h.frame.url = 'https://example.invalid/work';
    expect(() => h.call('get')).toThrow(/Untrusted login-item sender/);
    expect(h.app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('keeps the shared handlers until the last registered window closes', () => {
    const first = harness(false);
    const secondWindow = {
      webContents: { mainFrame: { url: first.frame.url }, isDestroyed: () => false },
      isDestroyed: () => false,
      once: vi.fn(),
    };
    const secondCleanup = registerLoginItem({ ipcMain: first.ipcMain, app: first.app, window: secondWindow, runtimeOrigin: 'http://127.0.0.1:43001' });
    expect(first.ipcMain.handle).toHaveBeenCalledTimes(2);
    expect(first.handlers.get('nema:login-item:get')({ sender: secondWindow.webContents, senderFrame: secondWindow.webContents.mainFrame })).toEqual({ openAtLogin: false });
    first.cleanup();
    expect(first.ipcMain.removeHandler).not.toHaveBeenCalled();
    secondCleanup();
    expect(first.ipcMain.removeHandler).toHaveBeenCalledTimes(2);
  });
});
