import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildReport, launch, median, parseBenchArgs, parseDesktopMarks, parseStartupPhases, parseWindowsAcl,
  payloadBesideApp, readPayloadCommit, stopApp, summarizeSamples,
} from './bench-startup.mjs';

const require = createRequire(import.meta.url);
const { desktopBenchLine } = require('../../apps/desktop/lifecycle.cjs');

test('bench arguments require an app and bound the run count', () => {
  assert.deepEqual(parseBenchArgs(['--app', 'Nema.exe']), { app: 'Nema.exe', runs: 3, timeoutMs: 180_000 });
  assert.equal(parseBenchArgs(['--app', 'Nema', '--runs', '1', '--timeout-ms', '50']).runs, 1);
  assert.throws(() => parseBenchArgs(['--app', 'Nema', '--payload', 'elsewhere']), /Usage/);
  assert.throws(() => parseBenchArgs([]), /Usage/);
  assert.throws(() => parseBenchArgs(['--app']), /Usage/);
  assert.throws(() => parseBenchArgs(['--app', 'Nema', '--runs', '21']), /Usage/);
  assert.throws(() => parseBenchArgs(['--app', 'Nema', '--runs', '0']), /Usage/);
});

test('desktop marks, core phases, and Windows ACL lines parse independently', () => {
  const marks = parseDesktopMarks(`${desktopBenchLine('process-start', 0)}${desktopBenchLine('did-finish-load', 40)}noise\n${desktopBenchLine('did-finish-load', 99)}`);
  assert.deepEqual(marks, { 'process-start': 0, 'did-finish-load': 40 });
  assert.deepEqual(parseStartupPhases('{"state":"startup-phase","phase":"lease","ms":12}\n{"state":"ready"}\n'), { lease: 12 });
  assert.deepEqual(parseWindowsAcl('{"state":"windows-acl","action":"protect","ms":10}\n{"state":"windows-acl","action":"check","ms":5}\n'), { count: 2, totalMs: 15 });
  assert.deepEqual(parseWindowsAcl(''), { count: 0, totalMs: 0 });
});

test('cold and warm summaries keep a phase only when every sample has it', () => {
  const sample = (elapsedMs, phaseMs, aclMs) => ({
    elapsedMs,
    desktopMarks: { 'did-finish-load': elapsedMs - 1 },
    startupPhases: { begin: 0, db: phaseMs },
    windowsAcl: { count: aclMs ? 1 : 0, totalMs: aclMs },
  });
  const report = buildReport({
    platform: 'win32',
    arch: 'x64',
    commit: 'abc1234',
    windowsAclMeasured: true,
    cold: [sample(100, 40, 20), sample(300, 60, 40)],
    warm: [sample(80, 10, 0), { ...sample(90, 12, 0), startupPhases: { begin: 0 } }],
  });
  assert.equal(median([100, 300]), 200);
  assert.equal(report.cold.elapsedMs.median, 200);
  assert.equal(report.cold.elapsedMs.max, 300);
  assert.equal(report.cold.startupPhases.db.median, 50);
  assert.equal(report.warm.startupPhases.db, undefined);
  assert.equal(report.warm.startupPhases.begin.median, 0);
  assert.equal(report.cold.windowsAcl.totalMs.max, 40);
  assert.equal(report.commit, 'abc1234');
});

test('summarize rejects an empty run', () => {
  assert.throws(() => summarizeSamples([]), /no samples/);
});

test('a failed spawn is recorded on the child instead of escaping the process', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-bench-spawn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = launch(path.join(root, 'missing-app'), process.env, path.join(root, 'electron.log'));
  const deadline = Date.now() + 2_000;
  while (!child.benchSpawnError && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child.benchSpawnError?.code, 'ENOENT');
  await stopApp(child);
});

test('stopping the app keeps stdout that is still flushing after exit', async (t) => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-bench-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const line = desktopBenchLine('did-finish-load', 7);
  const body = `${'x'.repeat(256 * 1024)}${line}`;
  const script = path.join(root, 'write-and-exit.mjs');
  await writeFile(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(body)});\n`);
  await chmod(script, 0o755);
  const logPath = path.join(root, 'electron.log');
  const child = launch(script, process.env, logPath);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('writer did not exit')), 5_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  } finally {
    await stopApp(child);
  }
  const logged = await readFile(logPath, 'utf8');
  assert.equal(logged.length, body.length);
  assert.equal(logged.endsWith(line), true);
});

test('payload lookup reads the manifest beside the app and its commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-bench-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'resources', 'payload');
  await mkdir(payload, { recursive: true });
  await writeFile(path.join(payload, 'runtime-manifest.json'), JSON.stringify({ commit: 'deadbeef', build: { commit: 'ignored' } }));
  const executable = path.join(root, 'Nema');
  assert.equal(payloadBesideApp(executable), payload);
  assert.equal(readPayloadCommit(payload), 'deadbeef');
  const macPayload = path.join(root, 'Nema.app', 'Contents', 'Resources', 'payload');
  await mkdir(macPayload, { recursive: true });
  await writeFile(path.join(macPayload, 'runtime-manifest.json'), JSON.stringify({ build: { commit: ' cafebabe ' } }));
  assert.equal(readPayloadCommit(macPayload), 'cafebabe');
  assert.equal(payloadBesideApp(path.join(root, 'Nema.app', 'Contents', 'MacOS', 'Nema')), macPayload);
  await rm(path.join(payload, 'runtime-manifest.json'));
  assert.throws(() => payloadBesideApp(path.join(root, 'missing', 'Nema')), /No runtime payload beside/);
});
