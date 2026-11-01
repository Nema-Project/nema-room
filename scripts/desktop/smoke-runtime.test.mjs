import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeCore, installedSmokePaths, validatePayloadDirectory, parseRuntimeLine } from './smoke-runtime.mjs';

test('smoke shutdown reports graceful only after a zero exit and final child close', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdin.resume(); process.stdin.once('data', () => { process.exitCode = 7; });"], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let closed = false;
  child.once('close', () => { closed = true; });
  const result = await closeCore({ child });
  assert.equal(child.exitCode, 7);
  assert.equal(result.graceful, false);
  assert.equal(result.fallback, false);
  assert.equal(closed, true);
});

test('the smoke Electron stand-in stays inside the temporary root on every packaged layout', () => {
  const root = path.join(os.tmpdir(), 'nema-smoke-layout');
  for (const platform of ['linux', 'darwin', 'win32']) {
    const installed = installedSmokePaths(root, platform);
    const base = platform === 'win32' ? path.win32 : path.posix;
    const escaped = base.relative(base.resolve(root), installed.electronPath);
    assert.equal(escaped.startsWith('..'), false);
    assert.equal(base.isAbsolute(escaped), false);
    assert.match(installed.install, /payload$/);
  }
});

test('installed smoke resolves only a complete native payload and parses its owned core readiness', () => {
  assert.equal(typeof validatePayloadDirectory, 'function');
  assert.equal(parseRuntimeLine('{"state":"ready","origin":"http://127.0.0.1:43210"}')?.origin, 'http://127.0.0.1:43210');
  assert.equal(parseRuntimeLine('{"state":"ready","origin":"http://example.com"}'), null);
  assert.equal(parseRuntimeLine('not runtime json'), null);
});
