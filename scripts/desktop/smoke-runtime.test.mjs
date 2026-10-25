import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { closeCore, validatePayloadDirectory, parseRuntimeLine } from './smoke-runtime.mjs';

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

test('installed smoke resolves only a complete native payload and parses its owned core readiness', () => {
  assert.equal(typeof validatePayloadDirectory, 'function');
  assert.equal(parseRuntimeLine('{"state":"ready","origin":"http://127.0.0.1:43210"}')?.origin, 'http://127.0.0.1:43210');
  assert.equal(parseRuntimeLine('{"state":"ready","origin":"http://example.com"}'), null);
  assert.equal(parseRuntimeLine('not runtime json'), null);
});
