'use strict';

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, session, ipcMain, screen } = require('electron');
const { mkdirSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDesktopLifecycle, desktopBenchLine } = require('./lifecycle.cjs');

// Baseline for optional startup marks. Other marks in this process are milliseconds after this line.
const benchStartedAt = Date.now();
const bench = process.env.NEMA_DESKTOP_BENCH === '1' ? { startedAt: benchStartedAt } : undefined;
if (bench) process.stdout.write(desktopBenchLine('process-start', 0));

if (process.env.NEMA_DESKTOP_DISABLE_GPU === '1') app.disableHardwareAcceleration();

const testProfile = process.env.NEMA_DESKTOP_TEST_USER_DATA;
if (testProfile) {
  if (!path.isAbsolute(testProfile)) throw new Error('NEMA_DESKTOP_TEST_USER_DATA must be an absolute test profile path');
  mkdirSync(testProfile, { recursive: true });
  app.setPath('userData', path.resolve(testProfile));
}

const home = process.env.NEMA_DESKTOP_TEST_HOME || path.join(os.homedir(), '.nema', 'desktop');
const assetsDir = path.join(process.resourcesPath, 'payload');
const lifecycle = createDesktopLifecycle({
  electron: { app, BrowserWindow, Menu, Tray, nativeImage, dialog, shell, session, ipcMain, screen },
  home,
  assetsDir,
  loadRuntimeApi: () => import(pathToFileURL(path.join(assetsDir, 'app', 'node_modules', '@nema', 'local', 'dist', 'src', 'index.js')).href),
  bench,
});

void lifecycle.install().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Nema desktop startup failed', message);
  dialog.showErrorBox('Nema Room could not open', message);
});

module.exports = lifecycle;
