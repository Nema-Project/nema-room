import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync } from 'node:fs';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function listJs(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name === 'chunks') continue;
      out.push(...listJs(abs));
    } else if (name.endsWith('.js')) out.push(abs);
  }
  return out;
}

function bundlePlugin(distDir) {
  const root = path.resolve(distDir);
  const insideDist = (importer) => {
    if (!importer) return false;
    const abs = path.resolve(importer);
    return abs === root || abs.startsWith(root + path.sep);
  };
  return {
    name: 'cli-relative-external',
    setup(build) {
      // CLI files stay at their original paths. Only @nema/shared is bundled;
      // splitting would otherwise pull shared CLI modules into chunks and break import.meta.url.
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return null;
        if (args.path === '@nema/shared' || args.path.startsWith('@nema/shared/')) return null;
        if (args.path.startsWith('./') || args.path.startsWith('../')) {
          if (insideDist(args.importer)) return { path: args.path, external: true };
          return null;
        }
        return { path: args.path, external: true };
      });
    },
  };
}

export async function bundleCli({ distDir = path.join(repoRoot, 'apps/cli/dist'), nodePaths = [path.join(repoRoot, 'node_modules')] } = {}) {
  const abs = path.resolve(distDir);
  await rm(path.join(abs, 'chunks'), { recursive: true, force: true });
  const entryPoints = listJs(abs);
  if (entryPoints.length === 0) throw new Error(`No CLI entry points in ${abs}`);
  await esbuild.build({
    entryPoints,
    absWorkingDir: abs,
    outdir: abs,
    outbase: abs,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    chunkNames: 'chunks/[name]-[hash]',
    nodePaths,
    plugins: [bundlePlugin(abs)],
    allowOverwrite: true,
    logLevel: 'warning',
  });
  return { distDir: abs, entryPoints };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bundleCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
