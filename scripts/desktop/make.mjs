import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageRuntime } from './stage-runtime.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktopDir = path.join(repo, 'apps/desktop');

export function parseMakeArgs(args, host = { platform: process.platform, arch: process.arch }) {
  const parsed = { platform: host.platform, arch: host.arch, out: undefined, stageOut: undefined, staged: undefined };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!['--platform', '--arch', '--out', '--stage-out', '--staged'].includes(option) || seen.has(option) || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('Usage: desktop:make [--platform win32 --arch x64 | --platform darwin --arch arm64] [--out <directory>] [--stage-out <directory>] [--staged <payload-directory>]');
    }
    seen.add(option);
    const value = args[++index];
    if (option === '--platform') parsed.platform = value;
    else if (option === '--arch') parsed.arch = value;
    else if (option === '--out') parsed.out = path.resolve(value);
    else if (option === '--stage-out') parsed.stageOut = path.resolve(value);
    else parsed.staged = path.resolve(value);
  }
  if (!((parsed.platform === 'win32' && parsed.arch === 'x64') || (parsed.platform === 'darwin' && parsed.arch === 'arm64'))) {
    throw new Error(`Unsupported desktop target ${parsed.platform}-${parsed.arch}`);
  }
  if (parsed.platform !== host.platform || parsed.arch !== host.arch) {
    throw new Error(`Desktop packaging requires a native ${parsed.platform}-${parsed.arch} host; current host is ${host.platform}-${host.arch}`);
  }
  return parsed;
}

export function builderConfig(payloadDir, outputDir, target) {
  const common = {
    appId: 'org.nema-project.nema-room',
    productName: 'Nema Room',
    executableName: 'Nema',
    artifactName: 'Nema-${version}-${platform}-${arch}.${ext}',
    asar: true,
    compression: 'normal',
    directories: { output: outputDir },
    files: ['main.cjs', 'lifecycle.cjs', 'security.cjs', 'window-controls.cjs', 'preload.cjs', 'package.json', 'assets/**/*'],
    extraResources: [
      { from: payloadDir, to: 'payload', filter: ['**/*'] },
    ],
  };
  if (target.platform === 'win32') {
    return {
      ...common,
      win: { target: ['nsis'], icon: path.join(desktopDir, 'assets/icon.ico'), signAndEditExecutable: true, signExecutable: false },
      nsis: {
        oneClick: false,
        perMachine: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        runAfterFinish: false,
        deleteAppDataOnUninstall: false,
        differentialPackage: false,
      },
    };
  }
  return {
    ...common,
    mac: {
      icon: path.join(desktopDir, 'assets/icon.icns'),
      target: ['dmg'],
      identity: '-',
      hardenedRuntime: false,
      category: 'public.app-category.productivity',
    },
  };
}

export async function validateElectronNotices(payloadDir) {
  const root = await realpath(payloadDir);
  for (const relative of ['runtime/licenses/electron/LICENSE', 'runtime/licenses/electron/LICENSES.chromium.html']) {
    const resolved = path.resolve(root, ...relative.split('/'));
    const info = await lstat(resolved).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Staged Electron distribution notice is missing or unsafe: ${relative}`);
    const actual = await realpath(resolved);
    const rel = path.relative(root, actual);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Staged Electron distribution notice escapes its payload: ${relative}`);
  }
}

async function make(args) {
  const target = parseMakeArgs(args);
  const appPackage = JSON.parse(await readFile(path.join(desktopDir, 'package.json'), 'utf8'));
  const localPackage = JSON.parse(await readFile(path.join(repo, 'apps/local/package.json'), 'utf8'));
  if (appPackage.version !== localPackage.version) throw new Error(`Desktop package ${appPackage.version} must match local runtime ${localPackage.version}`);
  let payloadDir;
  if (target.staged) {
    payloadDir = target.staged;
    const manifest = JSON.parse(await readFile(path.join(payloadDir, 'runtime-manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.version !== appPackage.version || manifest.platform !== target.platform || manifest.arch !== target.arch) throw new Error('Staged runtime manifest does not match the desktop package target/version');
    for (const key of ['node', 'git', 'coreEntry', 'cliEntry', 'webEntry', 'licenses', ...(target.platform === 'win32' ? ['ownedHelperGuardian'] : [])]) {
      const relative = manifest[key];
      if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`Staged runtime manifest has an invalid ${key} path`);
      const resolved = path.resolve(payloadDir, ...relative.split('/'));
      const rel = path.relative(payloadDir, resolved);
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`Staged runtime ${key} path escapes its payload`);
      const info = await lstat(resolved);
      const actual = await realpath(resolved);
      const actualRel = path.relative(await realpath(payloadDir), actual);
      if (info.isSymbolicLink() || (key === 'licenses' ? !info.isDirectory() : !info.isFile()) || actualRel === '..' || actualRel.startsWith(`..${path.sep}`) || path.isAbsolute(actualRel)) throw new Error(`Staged runtime ${key} asset is missing or escapes its payload`);
    }
  } else {
    const stageRoot = target.stageOut ?? path.join(repo, 'dist/desktop');
    const staged = await stageRuntime({ sourceRoot: repo, outputDir: stageRoot, platform: target.platform, arch: target.arch, version: appPackage.version });
    payloadDir = staged.directory;
  }
  await validateElectronNotices(payloadDir);
  const outputDir = target.out ?? path.join(repo, 'dist/desktop-artifacts', `${target.platform}-${target.arch}`);
  await mkdir(outputDir, { recursive: true });
  const configPath = path.join(outputDir, '.electron-builder-config.json');
  await writeFile(configPath, JSON.stringify(builderConfig(payloadDir, outputDir, target), null, 2));
  const cliPath = path.join(repo, 'node_modules/electron-builder/cli.js');
  const argsForBuilder = [cliPath, `--${target.platform === 'win32' ? 'win' : 'mac'}`, `--${target.arch}`, '--publish', 'never', '--config', configPath];
  if (target.platform === 'win32') argsForBuilder.splice(2, 0, 'nsis');
  else argsForBuilder.splice(2, 0, 'dmg');
  const env = {
    ...process.env,
    ELECTRON_BUILDER_CACHE: path.join(repo, '.superpowers/sdd/2026-10-24-desktop-implementation/tool-cache/electron-builder'),
    CSC_IDENTITY_AUTO_DISCOVERY: '0',
  };
  const result = spawnSync(process.execPath, argsForBuilder, { cwd: desktopDir, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`electron-builder exited with status ${result.status ?? 'unknown'}`);
  process.stdout.write(`Packaged ${target.platform}-${target.arch} from ${payloadDir} into ${outputDir}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  make(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
