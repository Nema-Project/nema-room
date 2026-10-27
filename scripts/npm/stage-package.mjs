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
    engines: { node: '>=22' },
    repository: { type: 'git', url: `git+${REPOSITORY}.git` },
    dependencies,
  };
}

export async function stagePackage({
  root = repoRoot,
  cliDir = path.join(root, 'apps/cli'),
  licensePath = path.join(root, 'LICENSE'),
  outDir = path.join(root, 'dist-npm'),
} = {}) {
  const pkg = JSON.parse(await readFile(path.join(cliDir, 'package.json'), 'utf8'));
  const manifest = derivePublishManifest(pkg);
  const dir = path.join(outDir, 'nema');
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'src/report'), { recursive: true });
  await cp(path.join(cliDir, 'dist'), path.join(dir, 'dist'), { recursive: true });
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
  return { dir, manifest, tarball, size, sizeLine };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stagePackage().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
