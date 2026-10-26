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
const THREAD_WINDOW_PATH = /^\/w\/ws_[A-Za-z0-9_-]{1,32}\/t\/m_[A-Za-z0-9_-]{1,32}$/;
const WORKSPACE_PATH = /^\/w\/(ws_[A-Za-z0-9_-]{1,32})$/;
const WORKSPACE_ID = /^ws_[A-Za-z0-9_-]{1,32}$/;
const MESSAGE_ID = /^m_[A-Za-z0-9_-]{1,32}$/;

/** A diagram popup is the one same-origin page the shell may open. No query, hash, or other route. */
function isDiagramWindowUrl(value, runtimeOrigin) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || !parseLoopbackOrigin(runtimeOrigin)) return false;
  try {
    const url = new URL(value, runtimeOrigin);
    if (url.origin !== runtimeOrigin || url.username || url.password || url.search || url.hash) return false;
    return DIAGRAM_WINDOW_PATH.test(url.pathname);
  } catch { return false; }
}

/** A thread window may carry one validated message focus target, but no other query or hash. */
function isThreadWindowUrl(value, runtimeOrigin) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || !parseLoopbackOrigin(runtimeOrigin)) return false;
  try {
    const url = new URL(value, runtimeOrigin);
    if (url.origin !== runtimeOrigin || url.username || url.password || url.hash || !THREAD_WINDOW_PATH.test(url.pathname)) return false;
    const keys = [...url.searchParams.keys()];
    return keys.length === 0 || (keys.length === 1 && keys[0] === 'messageId' && /^m_[A-Za-z0-9_-]{1,32}$/.test(url.searchParams.get('messageId') || ''));
  } catch { return false; }
}

function threadWindowIdentity(value, runtimeOrigin) {
  if (!isThreadWindowUrl(value, runtimeOrigin)) return null;
  const url = new URL(value, runtimeOrigin);
  return `${url.origin}${url.pathname}`;
}

/** Parses the single main-page URL shape emitted by the renderer for a message source jump. */
function isMainMessageUrl(value, runtimeOrigin) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value) || !parseLoopbackOrigin(runtimeOrigin)) return null;
  try {
    const url = new URL(value, runtimeOrigin);
    if (url.origin !== runtimeOrigin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.search) return null;
    const pathMatch = WORKSPACE_PATH.exec(url.pathname);
    if (!pathMatch || url.hash.length < 2) return null;
    const raw = url.hash.slice(1);
    const params = new URLSearchParams(raw);
    const pairs = [...params.entries()];
    if (pairs.length !== 2 || pairs.filter(([key]) => key === 'workspace').length !== 1 || pairs.filter(([key]) => key === 'message').length !== 1) return null;
    const workspaceId = params.get('workspace');
    const messageId = params.get('message');
    if (!workspaceId || !WORKSPACE_ID.test(workspaceId) || workspaceId !== pathMatch[1] || !messageId || !MESSAGE_ID.test(messageId)) return null;
    return { workspaceId, messageId };
  } catch { return null; }
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

module.exports = { createDiagramWindowOptions, createSecureWindowOptions, isDiagramWindowUrl, isExternalHttps, isMainMessageUrl, isThreadWindowUrl, threadWindowIdentity, navigationDecision, validateRuntimeLaunchUrl };
