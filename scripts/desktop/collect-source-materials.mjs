import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { collectSourceMaterials } from './source-materials.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export function parseSourceCollectionArgs(args) {
  if (args.length !== 5) throw new Error('Usage: collect-source-materials.mjs <payload-root> <bundle-output> <platform-arch> <app-version> <source-plan.json>');
  if (!/^(?:win32|darwin|linux)-(?:x64|arm64)$/.test(args[2])) throw new Error(`Unsupported source target: ${args[2]}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args[3])) throw new Error(`Invalid application version: ${args[3]}`);
  return { payloadRoot: path.resolve(args[0]), outputRoot: path.resolve(args[1]), target: args[2], appVersion: args[3], sourcePlanPath: path.resolve(args[4]) };
}
function resolvePlanInputRoot(sourcePlanPath, inputRoot) {
  if (inputRoot === undefined) return undefined;
  if (typeof inputRoot !== 'string' || !inputRoot.trim() || inputRoot.includes('\0') || path.isAbsolute(inputRoot)) throw new Error('Source plan inputRoot must be a non-empty relative path');
  const planDirectory = path.dirname(path.resolve(sourcePlanPath));
  const resolved = path.resolve(planDirectory, inputRoot);
  const relative = path.relative(planDirectory, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Source plan inputRoot must remain within the directory containing the source plan');
  return resolved;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseSourceCollectionArgs(process.argv.slice(2));
    const plan = JSON.parse((await readFile(args.sourcePlanPath, 'utf8')).replace(/^\uFEFF/, ''));
    const result = await collectSourceMaterials({
      ...args,
      toolsManifestPath: path.join(scriptDir, 'tools-manifest.json'),
      sourceMaterials: plan.sourceMaterials,
      upstreamNotices: plan.upstreamNotices,
      inputRoot: resolvePlanInputRoot(args.sourcePlanPath, plan.inputRoot),
      maxArchiveBytes: plan.maxArchiveBytes,
    });
    process.stdout.write(`Collected ${result.noticeCount} notices and ${result.materials.length} source entries; publication ${result.publicationEligibility}\n`);
  } catch (error) {
    process.stderr.write(`Source collection failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
