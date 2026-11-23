import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupCommand } from '../setup.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPOSITORY = 'https://github.com/Nema-Project/nema-room';

export function derivePublishManifest(pkg) {
  const dependencies = { ...(pkg.dependencies ?? {}) };
  for (const name of Object.keys(dependencies)) {
    if (!name.startsWith('@nema/')) continue;
    if (name === '@nema/shared') {
      delete dependencies[name];
      continue;
    }
    throw new Error(`internal dependency ${name} cannot be published`);
  }
  return {
    name: '@nema-project/nema',
    version: pkg.version,
    license: pkg.license ?? 'MIT',
    type: 'module',
    bin: { nema: 'dist/index.js' },
    files: ['dist', 'src/report/SKILL.md', 'LICENSE'],
    engines: { node: '>=24' },
    repository: { type: 'git', url: `git+${REPOSITORY}.git` },
    dependencies,
  };
}

/** Where apps/cli/src/components/lock.ts `shippedWindowsLauncherPath` looks, inside the package. */
export const WINDOWS_LAUNCHER = 'dist/resources/graphify-launcher.exe';
/** The launcher is a small Nema binary; anything larger is not it. */
export const WINDOWS_LAUNCHER_MAX_BYTES = 1024 * 1024;

/**
 * The prebuilt Windows Graphify launcher for the package. `source` is a built file, or `build` to compile
 * scripts/desktop/graphify-launcher.c here (NEMA_WINDOWS_NATIVE_CC picks the compiler, e.g. a MinGW cross
 * compiler on Linux). Returns the bytes, or null when no launcher was given.
 */
export async function windowsLauncherBytes({ source, root = repoRoot, scratch, build } = {}) {
  if (!source) return null;
  let file = source;
  if (source === 'build') {
    file = path.join(scratch, 'graphify-launcher.exe');
    const builder = build ?? (await import('../desktop/fetch-graphify.mjs')).buildGraphifyLauncher;
    await builder({ sourceRoot: root, output: file });
  }
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Windows Graphify launcher is not a file: ${file}`);
  if (info.size > WINDOWS_LAUNCHER_MAX_BYTES) throw new Error(`Windows Graphify launcher is ${info.size} bytes; expected a KB-scale binary`);
  const bytes = await readFile(file);
  if (bytes.length < 2 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error(`Windows Graphify launcher is not a Windows executable: ${file}`);
  return bytes;
}

export async function stagePackage({
  root = repoRoot,
  cliDir = path.join(root, 'apps/cli'),
  licensePath = path.join(root, 'LICENSE'),
  outDir = path.join(root, 'dist-npm'),
  // A built launcher file or 'build'; unset leaves it out (win32 installs then fail with a named reason).
  windowsLauncher = undefined,
  // Release packs set this, so a package without the launcher is never published.
  requireWindowsLauncher = false,
  // Tests only: stands in for the compiler when windowsLauncher is 'build'.
  buildWindowsLauncher = undefined,
} = {}) {
  const pkg = JSON.parse(await readFile(path.join(cliDir, 'package.json'), 'utf8'));
  const manifest = derivePublishManifest(pkg);
  const dir = path.join(outDir, 'nema');
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'src/report'), { recursive: true });
  await cp(path.join(cliDir, 'dist'), path.join(dir, 'dist'), { recursive: true });
  // The component installer's only trust root: always the repository lock, never a stale build copy.
  await mkdir(path.join(dir, 'dist/resources'), { recursive: true });
  await cp(path.join(root, 'scripts/desktop/graphify-lock.json'), path.join(dir, 'dist/resources/graphify-lock.json'));
  // The launcher, too, is only what this stage was given, never a leftover in the build output.
  await rm(path.join(dir, WINDOWS_LAUNCHER), { force: true });
  await mkdir(outDir, { recursive: true });
  let launcher;
  try {
    launcher = await windowsLauncherBytes({ source: windowsLauncher, root, scratch: outDir, build: buildWindowsLauncher });
  } finally {
    if (windowsLauncher === 'build') await rm(path.join(outDir, 'graphify-launcher.exe'), { force: true });
  }
  if (launcher) await writeFile(path.join(dir, WINDOWS_LAUNCHER), launcher);
  else if (requireWindowsLauncher) throw new Error('This pack needs the Windows Graphify launcher: set NEMA_NPM_WINDOWS_LAUNCHER to a built file or to build');
  await cp(path.join(cliDir, 'src/report/SKILL.md'), path.join(dir, 'src/report/SKILL.md'));
  await cp(licensePath, path.join(dir, 'LICENSE'));
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(outDir, { recursive: true });
  const npm = setupCommand('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', outDir]);
  const packed = spawnSync(npm.bin, npm.args, { cwd: dir, encoding: 'utf8' });
  if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout || packed.error?.message || 'npm pack failed');
  const filename = JSON.parse(packed.stdout).at(-1)?.filename;
  if (!filename) throw new Error('npm pack did not report a tarball');
  const tarball = path.join(outDir, filename);
  const size = (await stat(tarball)).size;
  const sizeLine = `npm package size: ${size}`;
  process.stdout.write(`${sizeLine}\n`);
  process.stdout.write(`npm package Windows Graphify launcher: ${launcher ? `${launcher.length} bytes` : 'not included'}\n`);
  return { dir, manifest, tarball, size, sizeLine, windowsLauncherBytes: launcher?.length ?? 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stagePackage({
    windowsLauncher: process.env.NEMA_NPM_WINDOWS_LAUNCHER || undefined,
    requireWindowsLauncher: process.env.NEMA_NPM_REQUIRE_WINDOWS_LAUNCHER === '1',
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
