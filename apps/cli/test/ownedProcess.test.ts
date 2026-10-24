import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnOwned } from '../src/ownedProcess.js';
import { commandSpec } from '../src/platform.js';

const root = mkdtempSync(path.join(tmpdir(), 'nema-owned-process-test-'));
const guardian = path.join(root, 'owned-helper.exe');
const testGuardian = path.join(root, 'owned-helper-test.exe');
const buildScript = path.resolve(process.cwd(), 'scripts/desktop/build-owned-helper.mjs');
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const managedEnv = { ...process.env, PATH: system32 };

beforeAll(() => {
  if (process.platform !== 'win32') return;
  execFileSync(process.execPath, [buildScript, '--output', guardian], { stdio: 'inherit' });
  execFileSync(process.execPath, [buildScript, '--output', testGuardian, '--test-only'], { stdio: 'inherit' });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const windowsOnly = process.platform !== 'win32' ? test.skip : test;

windowsOnly('reports actual target readiness, preserves argv/stdout and retains immediate full exit state', async () => {
  const values = ['two words', 'quote"inside', 'trailing\\', '東京'];
  const cwd = path.join(root, 'cwd with spaces 東京');
  mkdirSync(cwd);
  const script = 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd()}));process.exit(301)';
  const owned = await spawnOwned(guardian, process.execPath, ['-e', script, '--', ...values], { cwd, env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  owned.stdout!.setEncoding('utf8').on('data', (chunk) => output += chunk);
  const closed = await owned.closed;
  expect(JSON.parse(output)).toEqual({ args: values, cwd });
  expect(closed.code).toBe(301);
  expect((await owned.exited).code).toBe(301);
});

windowsOnly('matches Node windowsVerbatimArguments for cmd.exe', async () => {
  const command = process.env.ComSpec ?? path.join(system32, 'cmd.exe');
  const args = ['/d', '/s', '/c', '"echo two words"'];
  const direct = spawn(command, args, { windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let directOutput = '';
  direct.stdout!.setEncoding('utf8').on('data', (chunk) => directOutput += chunk);
  const directClose = await once(direct, 'close');
  const owned = await spawnOwned(guardian, command, args, { env: managedEnv, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let ownedOutput = '';
  owned.stdout!.setEncoding('utf8').on('data', (chunk) => ownedOutput += chunk);
  const ownedClose = await owned.closed;
  expect(ownedClose.code).toBe(directClose[0]);
  expect(ownedOutput.trim()).toBe(directOutput.trim());
});

windowsOnly('resolves a bare Windows system executable through System32', async () => {
  const owned = await spawnOwned(guardian, 'cmd.exe', ['/d', '/s', '/c', 'echo bare-app-name'], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  owned.stdout!.setEncoding('utf8').on('data', (chunk) => output += chunk);
  expect((await owned.closed).code).toBe(0);
  expect(output.trim()).toBe('bare-app-name');
});

windowsOnly('resolves a standard npm.cmd shim to its JavaScript entry without changing argv', async () => {
  const shim = path.join(root, 'npm.cmd');
  const entry = path.join(root, 'npm-entry.js');
  writeFileSync(shim, '@echo off\r\n"%~dp0\\npm-entry.js" %*\r\n');
  writeFileSync(entry, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const values = ['two words', 'quote"inside', 'trailing\\', '東京 npm'];
  const command = commandSpec(shim, values, process.env);
  expect(command.bin).toBe(process.execPath);
  expect(command.args[0]).toBe(entry);
  const owned = await spawnOwned(guardian, command.bin, command.args, { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  owned.stdout!.setEncoding('utf8').on('data', (chunk) => output += chunk);
  expect((await owned.closed).code).toBe(0);
  expect(JSON.parse(output)).toEqual(values);
});

windowsOnly('keeps ownership after stdin EOF and closes it on explicit guardian cancellation', async () => {
  const owned = await spawnOwned(guardian, process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write("STDIN_END\\n");setInterval(()=>{},1000)})'], { env: managedEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  owned.stdout!.setEncoding('utf8').on('data', (chunk) => output += chunk);
  owned.stdin!.end();
  await waitUntil(() => output.includes('STDIN_END'));
  await expect(Promise.race([owned.closed.then(() => 'closed'), sleep(150).then(() => 'alive')])).resolves.toBe('alive');
  expect(owned.kill('SIGKILL')).toBe(true);
  expect((await owned.closed).code).not.toBe(0);
});

windowsOnly('uses the post-start AbortSignal to terminate the complete owned job', async () => {
  const controller = new AbortController();
  const owned = await spawnOwned(guardian, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: managedEnv, stdio: ['ignore', 'ignore', 'ignore'], signal: controller.signal });
  controller.abort();
  const closed = await owned.closed;
  expect(closed.code).toBeNull();
  expect(closed.signal).not.toBeNull();
});

windowsOnly('direct target exit kills a grandchild that inherited stdout before guardian close', async () => {
  const grandchild = 'setInterval(()=>{},1000)';
  const target = `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:["ignore","inherit","inherit"]});process.stdout.write("TARGET_EXIT\\n");process.exit(37)`;
  const owned = await spawnOwned(guardian, process.execPath, ['-e', target], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  owned.stdout!.setEncoding('utf8').on('data', (chunk) => output += chunk);
  const closed = await Promise.race([owned.closed, sleep(5000).then(() => { throw new Error('grandchild held stdout after target exit'); })]);
  expect(closed.code).toBe(37);
  expect(output).toContain('TARGET_EXIT');
});

windowsOnly('maps a missing target to typed ENOENT without logging argv', async () => {
  const command = path.join(root, 'does-not-exist.exe');
  try {
    await spawnOwned(guardian, command, ['private argument'], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    throw new Error('missing target unexpectedly started');
  } catch (error) {
    expect(error).toMatchObject({ name: 'OwnedSpawnError', code: 'ENOENT', path: command, spawnargs: ['private argument'] });
    expect((error as Error).message).not.toContain('private argument');
  }
});

windowsOnly('maps a non-executable target path to typed EACCES', async () => {
  await expect(spawnOwned(guardian, root, [], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] }))
    .rejects.toMatchObject({ name: 'OwnedSpawnError', code: 'EACCES', win32ErrorCode: 5, path: root });
});

windowsOnly('abort before lease connection awaits guardian cleanup and prevents late target startup', async () => {
  const marker = path.join(root, 'must-not-start.txt');
  const controller = new AbortController();
  const pending = spawnOwned(testGuardian, process.execPath, ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`], {
    env: { ...managedEnv, NEMA_TEST_DELAY_CREATE_PIPE_MS: '500' }, stdio: ['ignore', 'ignore', 'ignore'], signal: controller.signal,
  });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await sleep(700);
  expect(existsSync(marker)).toBe(false);
});

windowsOnly('abort after lease connection but before READY awaits cleanup and prevents target startup', async () => {
  const marker = path.join(root, 'must-not-start-before-ready.txt');
  const controller = new AbortController();
  const pending = spawnOwned(testGuardian, process.execPath, ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`], {
    env: { ...managedEnv, NEMA_TEST_DELAY_BEFORE_RESUME_MS: '500' }, stdio: ['ignore', 'ignore', 'ignore'], signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await sleep(700);
  expect(existsSync(marker)).toBe(false);
});

windowsOnly('real AssignProcessToJobObject failure terminates the suspended target before reporting error', async () => {
  const marker = path.join(root, 'must-not-start-after-assignment-failure.txt');
  await expect(spawnOwned(testGuardian, process.execPath, ['-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`], {
    env: { ...managedEnv, NEMA_TEST_ASSIGN_FAIL: '1' }, stdio: ['ignore', 'ignore', 'ignore'],
  })).rejects.toMatchObject({ name: 'OwnedSpawnError', win32ErrorCode: 6, path: process.execPath });
  expect(existsSync(marker)).toBe(false);
});

windowsOnly('guardian death kills target and grandchild while unrelated control stays alive', async () => {
  const grandchild = 'setInterval(()=>process.stdout.write("GRANDCHILD_TICK\\n"),40)';
  const target = `const {spawn}=require("node:child_process");spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:["ignore","inherit","inherit"]});setInterval(()=>process.stdout.write("PARENT_TICK\\n"),40)`;
  const owned = await spawnOwned(guardian, process.execPath, ['-e', target], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const control = spawn(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("CONTROL_TICK\\n"),40)'], { env: managedEnv, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let output = '', controlOutput = '';
  owned.stdout!.setEncoding('utf8').on('data', (chunk) => output += chunk);
  control.stdout!.setEncoding('utf8').on('data', (chunk) => controlOutput += chunk);
  try {
    await waitUntil(() => output.includes('PARENT_TICK') && output.includes('GRANDCHILD_TICK') && controlOutput.includes('CONTROL_TICK'));
    expect(owned.kill('SIGKILL')).toBe(true);
    await owned.closed;
    const ownedCount = (output.match(/(?:PARENT|GRANDCHILD)_TICK/g) ?? []).length;
    const controlCount = (controlOutput.match(/CONTROL_TICK/g) ?? []).length;
    await sleep(250);
    expect((output.match(/(?:PARENT|GRANDCHILD)_TICK/g) ?? []).length).toBe(ownedCount);
    expect((controlOutput.match(/CONTROL_TICK/g) ?? []).length).toBeGreaterThan(controlCount);
  } finally {
    if (control.exitCode === null && control.signalCode === null) control.kill();
    await once(control, 'close');
  }
});

windowsOnly('simultaneous owned starts keep separate leases and return the correct target results', async () => {
  const [first, second] = await Promise.all([
    spawnOwned(guardian, process.execPath, ['-e', 'process.stdout.write("first 東京")'], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] }),
    spawnOwned(guardian, process.execPath, ['-e', 'process.stdout.write("second 日本")'], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'] }),
  ]);
  let firstOutput = '', secondOutput = '';
  first.stdout!.setEncoding('utf8').on('data', (chunk) => firstOutput += chunk);
  second.stdout!.setEncoding('utf8').on('data', (chunk) => secondOutput += chunk);
  const [firstClose, secondClose] = await Promise.all([first.closed, second.closed]);
  expect(firstClose.code).toBe(0);
  expect(secondClose.code).toBe(0);
  expect(firstOutput).toBe('first 東京');
  expect(secondOutput).toBe('second 日本');
});

windowsOnly('actual core process death closes the dedicated lease and kills target descendants', async () => {
  const driver = path.resolve(process.cwd(), 'apps/cli/test/fixtures/owned-core-driver.mjs');
  const core = spawn(process.execPath, ['--import', 'tsx', driver, guardian], { env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  core.stdout!.setEncoding('utf8').on('data', (chunk) => output += chunk);
  try {
    await waitUntil(() => output.includes('CORE_READY') && output.includes('PARENT_TICK') && output.includes('GRANDCHILD_TICK'));
    core.kill('SIGKILL');
    await once(core, 'close');
    const ownedCount = (output.match(/(?:PARENT|GRANDCHILD)_TICK/g) ?? []).length;
    await sleep(250);
    expect((output.match(/(?:PARENT|GRANDCHILD)_TICK/g) ?? []).length).toBe(ownedCount);
  } finally {
    if (core.exitCode === null && core.signalCode === null) core.kill('SIGKILL');
  }
});

windowsOnly('guardian times out without a connected core and never starts the target', async () => {
  const marker = path.join(root, 'must-not-start-without-core.txt');
  const name = `\\\\.\\pipe\\nema-owned-${randomBytes(24).toString('hex')}`;
  const guardianChild = spawn(guardian, [name, 'quoted', process.execPath, '-e', `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`], {
    env: managedEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const [code] = await once(guardianChild, 'close');
  expect(code).toBe(122);
  expect(existsSync(marker)).toBe(false);
});

async function waitUntil(predicate: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(15);
  }
  throw new Error('Timed out waiting for process output');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
