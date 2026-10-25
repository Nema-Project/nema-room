'use strict';

const path = require('node:path');
const ticketPattern = /^[0-9a-f]{64}$/;

function parseLoopbackOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[1-9]\d{0,4}$/.test(url.port) || Number(url.port) > 65535 ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== value) return null;
    return url.origin;
  } catch { return null; }
}

function validateRuntimeLaunchUrl(value, expectedOrigin) {
  const origin = parseLoopbackOrigin(expectedOrigin);
  if (!origin) throw new Error('Expected runtime origin is not a canonical loopback origin');
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/_nema/launch' || url.hash || [...url.searchParams.keys()].join(',') !== 'ticket' || !ticketPattern.test(url.searchParams.get('ticket') || '')) {
      throw new Error('invalid launch URL');
    }
    return true;
  } catch { throw new Error('Local core did not return a verified launch ticket'); }
}

function createSecureWindowOptions(runtimeOrigin) {
  if (!parseLoopbackOrigin(runtimeOrigin)) throw new Error('Expected runtime origin is not a canonical loopback origin');
  return {
    width: 1180,
    height: 820,
    minWidth: 840,
    minHeight: 600,
    show: false,
    title: 'Nema Room',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

function isExternalHttps(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

const DIAGRAM_WINDOW_PATH = /^\/api\/workspaces\/ws_[A-Za-z0-9_-]{1,32}\/diagrams\/G-[1-9]\d*\.html$/;

/** A diagram popup is the one same-origin page the shell may open. No query, hash, or other route. */
function isDiagramWindowUrl(value, runtimeOrigin) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || !parseLoopbackOrigin(runtimeOrigin)) return false;
  try {
    const url = new URL(value, runtimeOrigin);
    if (url.origin !== runtimeOrigin || url.username || url.password || url.search || url.hash) return false;
    return DIAGRAM_WINDOW_PATH.test(url.pathname);
  } catch { return false; }
}

/** A diagram window has a native frame and no preload. The main window's frameless shell must not be copied onto rendered HTML. */
function createDiagramWindowOptions() {
  return {
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'Nema Room',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

function navigationDecision(value, runtimeOrigin) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return 'block';
    if (url.origin === runtimeOrigin) return 'runtime';
    return isExternalHttps(value) ? 'external' : 'block';
  } catch { return 'block'; }
}

module.exports = { createDiagramWindowOptions, createSecureWindowOptions, isDiagramWindowUrl, isExternalHttps, navigationDecision, validateRuntimeLaunchUrl };
