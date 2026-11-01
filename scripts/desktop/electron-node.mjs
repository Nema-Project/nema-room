import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** `engines.node` in this repo is a major floor (`>=22`). Other ranges are refused rather than guessed. */
export function assertElectronNodeEngines(nodeVersion, range) {
  const match = /^>=(\d+)$/.exec(String(range ?? '').trim());
  if (!match) throw new Error(`Unsupported engines.node range: ${range}`);
  const [majorText] = String(nodeVersion ?? '').split('.');
  const major = Number(majorText);
  if (!/^\d+$/.test(majorText) || major < Number(match[1])) {
    throw new Error(`Electron Node ${nodeVersion} does not satisfy engines.node ${range}`);
  }
}

/** The payload record that says the running Node is Electron's, not the build-time archive. */
export function runtimeNodeRecord({ electronVersion, nodeVersion, engines }) {
  if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
    throw new Error('apps/desktop/package.json has no exact Electron version');
  }
  assertElectronNodeEngines(nodeVersion, engines);
  return {
    source: 'electron',
    electronVersion,
    version: String(nodeVersion),
    engines,
    license: 'runtime/licenses/node',
    invocation: 'ELECTRON_RUN_AS_NODE=1',
  };
}

export function assertRuntimeNodeRecord(runtimeNode) {
  if (!runtimeNode || typeof runtimeNode !== 'object') throw new Error('Tool source record does not name Electron as the shipped Node');
  const expected = runtimeNodeRecord({
    electronVersion: runtimeNode.electronVersion,
    nodeVersion: runtimeNode.version,
    engines: runtimeNode.engines,
  });
  for (const [key, value] of Object.entries(expected)) {
    if (runtimeNode[key] !== value) throw new Error('Tool source record does not name Electron as the shipped Node');
  }
}

/**
 * Run the installed Electron binary as Node and require its version to satisfy the root `engines.node`.
 * Staging calls this. Fixture tests pass a record instead of downloading Electron.
 */
export async function readElectronNodeVersion(sourceRoot, spawnImpl = spawnSync) {
  const rootPackage = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const engines = rootPackage.engines?.node;
  if (typeof engines !== 'string') throw new Error('Root package.json has no engines.node');
  const desktop = JSON.parse(await readFile(path.join(sourceRoot, 'apps/desktop/package.json'), 'utf8'));
  const electronVersion = desktop.devDependencies?.electron;
  const pathFile = path.join(sourceRoot, 'node_modules', 'electron', 'path.txt');
  let relative = '';
  try { relative = (await readFile(pathFile, 'utf8')).replace(/^\uFEFF/, '').trim(); } catch { relative = ''; }
  if (!relative || relative.includes('\0') || path.isAbsolute(relative)) throw new Error('Electron binary path is missing; install Electron before staging');
  const distRoot = path.resolve(sourceRoot, 'node_modules', 'electron', 'dist');
  const binary = path.resolve(distRoot, relative);
  const escaped = path.relative(distRoot, binary);
  if (escaped.startsWith(`..${path.sep}`) || escaped === '..' || path.isAbsolute(escaped)) throw new Error('Electron binary path escapes the Electron dist directory');
  const result = spawnImpl(binary, ['-p', 'process.versions.node'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw new Error(`Electron did not report its Node version: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Electron did not report its Node version (${result.status}): ${String(result.stderr ?? '').trim()}`);
  const nodeVersion = String(result.stdout ?? '').trim();
  return runtimeNodeRecord({ electronVersion, nodeVersion, engines });
}
