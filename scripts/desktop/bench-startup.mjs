import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: desktop:bench --app <executable> [--runs <1-20>] [--timeout-ms <ms>]';

export function parseBenchArgs(args) {
  let app;
  let runs = 3;
  let timeoutMs = 180_000;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    if (flag === '--app') app = value;
    else if (flag === '--runs' && /^[1-9]\d*$/.test(value) && Number(value) <= 20) runs = Number(value);
    else if (flag === '--timeout-ms' && /^[1-9]\d*$/.test(value)) timeoutMs = Number(value);
    else throw new Error(USAGE);
    index += 1;
  }
  if (!app) throw new Error(USAGE);
  return { app, runs, timeoutMs };
}

export function median(values) {
  if (!values.length) throw new Error('median requires at least one sample');
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function parseJson(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); }
  catch { return null; }
}

export function parseDesktopMarks(text) {
  const marks = {};
  for (const line of text.split(/\r?\n/)) {
    const value = parseJson(line);
    if (!value || value.state !== 'desktop-mark' || typeof value.mark !== 'string' || !Number.isFinite(value.ms)) continue;
    if (marks[value.mark] === undefined) marks[value.mark] = value.ms;
  }
  return marks;
}

export function parseStartupPhases(text) {
  const phases = {};
  for (const line of text.split(/\r?\n/)) {
    const value = parseJson(line);
    if (!value || value.state !== 'startup-phase' || typeof value.phase !== 'string' || !Number.isFinite(value.ms)) continue;
    if (phases[value.phase] === undefined) phases[value.phase] = value.ms;
  }
  return phases;
}

export function parseWindowsAcl(text) {
  const calls = [];
  for (const line of text.split(/\r?\n/)) {
    const value = parseJson(line);
    if (!value || value.state !== 'windows-acl' || !Number.isFinite(value.ms)) continue;
    calls.push(value.ms);
  }
  return { count: calls.length, totalMs: calls.reduce((sum, ms) => sum + ms, 0) };
}

function series(values) {
  return { median: median(values), max: Math.max(...values) };
}

function summarizeNamed(samples, read) {
  const names = new Set(samples.flatMap((sample) => Object.keys(read(sample))));
  const summary = {};
  for (const name of [...names].sort()) {
    const values = samples.map((sample) => read(sample)[name]).filter((value) => value !== undefined);
    if (values.length !== samples.length) continue;
    summary[name] = series(values);
  }
  return summary;
}

export function summarizeSamples(samples) {
  if (!samples.length) throw new Error('startup bench has no samples');
  return {
    samples: samples.length,
    elapsedMs: series(samples.map((sample) => sample.elapsedMs)),
    desktopMarks: summarizeNamed(samples, (sample) => sample.desktopMarks),
    startupPhases: summarizeNamed(samples, (sample) => sample.startupPhases),
    windowsAcl: {
      calls: series(samples.map((sample) => sample.windowsAcl.count)),
      totalMs: series(samples.map((sample) => sample.windowsAcl.totalMs)),
    },
  };
}

export function buildReport({ platform, arch, commit, windowsAclMeasured, cold, warm }) {
  return {
    platform,
    arch,
    commit,
    windowsAclMeasured,
    cold: summarizeSamples(cold),
    warm: summarizeSamples(warm),
  };
}

export function payloadBesideApp(executable) {
  const dir = path.dirname(path.resolve(executable));
  const candidates = [
    path.join(dir, 'resources', 'payload'),
    path.join(dir, '..', 'Resources', 'payload'),
  ];
  const found = candidates.find((candidate) => existsSync(path.join(candidate, 'runtime-manifest.json')));
  if (!found) throw new Error(`No runtime payload beside ${executable} (resources/payload, or Contents/Resources/payload on macOS).`);
  return found;
}

export function readPayloadCommit(payloadDir) {
  const manifest = JSON.parse(readFileSync(path.join(payloadDir, 'runtime-manifest.json'), 'utf8'));
  if (typeof manifest.commit === 'string' && manifest.commit.trim()) return manifest.commit.trim();
  if (typeof manifest.build?.commit === 'string' && manifest.build.commit.trim()) return manifest.build.commit.trim();
  return 'unknown';
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`Desktop process ${child.pid ?? ''} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolve(); };
    child.once('exit', onExit);
  });
}

function onceOrTimeout(child, event, timeoutMs) {
  if (event === 'close' && child.benchClosed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off(event, onEvent); resolve(); }, timeoutMs);
    const onEvent = () => { clearTimeout(timer); resolve(); };
    child.once(event, onEvent);
  });
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    promise.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
  });
}

/** stdio can still be flushing after exit. Wait for close, then for the log finish, before dropping the pipes. */
async function drainBenchChild(child) {
  if (!child.benchClosed) await onceOrTimeout(child, 'close', 5_000);
  if (child.benchClosed && child.benchLogDone) await withTimeout(child.benchLogDone, 1_000);
}

export async function stopApp(child) {
  if (child.exitCode === null && child.signalCode === null && child.pid) {
    if (process.platform === 'win32') {
      spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
    await waitForChildExit(child, 50_000).catch(async () => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      await waitForChildExit(child, 5_000).catch(() => {});
    });
  }
  await drainBenchChild(child);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

export function launch(executable, env, logPath) {
  const log = createWriteStream(logPath, { flags: 'a' });
  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: false,
  });
  child.benchClosed = false;
  child.benchLogDone = new Promise((resolve) => {
    log.once('finish', resolve);
  });
  log.on('error', (error) => {
    if (error?.code !== 'ERR_STREAM_WRITE_AFTER_END') throw error;
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once('close', () => {
    child.benchClosed = true;
    if (!log.writableEnded) log.end();
  });
  child.unref();
  return child;
}

async function waitForMark(logPath, mark, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await drainBenchChild(child);
      const tail = await readFile(logPath, 'utf8').catch(() => '');
      throw new Error(`Desktop app exited before ${mark} (${child.exitCode ?? child.signalCode})\n${tail.slice(-2000)}`);
    }
    const text = await readFile(logPath, 'utf8').catch(() => '');
    if (parseDesktopMarks(text)[mark] !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const tail = await readFile(logPath, 'utf8').catch(() => '');
  throw new Error(`Timed out waiting for desktop mark ${mark}\n${tail.slice(-2000)}`);
}

async function shutdownHome(runtimeApi, home, payload) {
  const instance = await runtimeApi.discoverInstance(home);
  if (!instance?.instanceId) return;
  await runtimeApi.shutdownLocalRuntime({
    home,
    assetsDir: payload,
    expectedInstanceId: instance.instanceId,
    timeoutMs: 45_000,
  });
}

async function measureOnce({ executable, payload, runtimeApi, homeRoot, timeoutMs }) {
  const profile = path.join(homeRoot, 'user-data');
  const home = path.join(homeRoot, 'home');
  const id = randomUUID();
  const coreLog = path.join(homeRoot, `core-${id}.log`);
  const electronLog = path.join(homeRoot, `electron-${id}.log`);
  await mkdir(profile, { recursive: true });
  await mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    NEMA_DESKTOP_TEST_HOME: home,
    NEMA_DESKTOP_TEST_USER_DATA: profile,
    NEMA_DESKTOP_DISABLE_GPU: '1',
    NEMA_LOCAL_CORE_LOG: coreLog,
    NEMA_DESKTOP_BENCH: '1',
  };
  const started = Date.now();
  const child = launch(executable, env, electronLog);
  let sample;
  let failure;
  try {
    await waitForMark(electronLog, 'did-finish-load', timeoutMs, child);
    const elapsedMs = Date.now() - started;
    const electronText = await readFile(electronLog, 'utf8').catch(() => '');
    const coreText = await readFile(coreLog, 'utf8').catch(() => '');
    const startupPhases = parseStartupPhases(coreText);
    if (!Object.keys(startupPhases).length) throw new Error(`Core log has no startup-phase lines\n${coreText.slice(-2000)}`);
    sample = {
      elapsedMs,
      desktopMarks: parseDesktopMarks(electronText),
      startupPhases,
      windowsAcl: parseWindowsAcl(`${electronText}\n${coreText}`),
    };
  } catch (error) {
    failure = error;
  }
  await stopApp(child).catch((error) => { failure ??= error; });
  await shutdownHome(runtimeApi, home, payload).catch((error) => { failure ??= error; });
  if (failure) throw failure;
  return sample;
}

export async function bench(args) {
  const parsed = parseBenchArgs(args);
  const executable = path.resolve(parsed.app);
  if (!existsSync(executable)) throw new Error(`Desktop executable not found: ${executable}`);
  // The packaged app always loads process.resourcesPath/payload. The report commit has to be that payload.
  const payload = payloadBesideApp(executable);
  if (!existsSync(path.join(payload, 'runtime-manifest.json'))) throw new Error(`Not a runtime payload: ${payload}`);
  const runtimeApi = await import(pathToFileURL(path.join(payload, 'app', 'node_modules', '@nema', 'local', 'dist', 'src', 'index.js')).href);
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nema-bench-'));
  const cold = [];
  const warm = [];
  let failure;
  try {
    for (let index = 0; index < parsed.runs; index += 1) {
      const homeRoot = path.join(tempRoot, `run-${index}`);
      cold.push(await measureOnce({ executable, payload, runtimeApi, homeRoot, timeoutMs: parsed.timeoutMs }));
      warm.push(await measureOnce({ executable, payload, runtimeApi, homeRoot, timeoutMs: parsed.timeoutMs }));
    }
  } catch (error) {
    failure = error;
  }
  await rm(tempRoot, { recursive: true, force: true }).catch((error) => { failure ??= error; });
  if (failure) throw failure;
  const report = buildReport({
    platform: process.platform,
    arch: process.arch,
    commit: readPayloadCommit(payload),
    windowsAclMeasured: process.platform === 'win32',
    cold,
    warm,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  bench(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
