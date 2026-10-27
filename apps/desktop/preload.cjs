'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const bridge = Object.freeze({
  // Sandboxed preload cannot require security.cjs. Keep this expression identical to usesNativeTrafficLights().
  nativeTrafficLights: process.platform === 'darwin',
  minimize: () => ipcRenderer.invoke('nema:window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('nema:window:toggle-maximize'),
  close: () => ipcRenderer.invoke('nema:window:close'),
  getState: () => ipcRenderer.invoke('nema:window:get-state'),
  onStateChanged(callback) {
    if (typeof callback !== 'function') throw new TypeError('A state callback is required');
    const listener = (_event, state) => {
      if (state && typeof state.maximized === 'boolean') callback({ maximized: state.maximized, fullScreen: state.fullScreen === true });
    };
    ipcRenderer.on('nema:window:state-changed', listener);
    return () => ipcRenderer.removeListener('nema:window:state-changed', listener);
  },
});

contextBridge.exposeInMainWorld('nemaWindowControls', bridge);
