import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Warn-only ceilings in MiB. A warning must not fail the build. */
export const PAYLOAD_BUDGETS_MIB = {
  node: 135,
  graphify: 175,
  web: 30,
  total: 620,
};

const SECTION_KEYS = ['node', 'graphify', 'web', 'total'];

export async function directoryBytes(root) {
  let total = 0;
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        total += (await lstat(absolute)).size;
        continue;
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) total += (await lstat(absolute)).size;
    }
  }
  const info = await lstat(root).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return 0;
  if (info.isSymbolicLink() || info.isFile()) return info.size;
  await walk(root);
  return total;
}

export function payloadSizeLines(sections, budgets = PAYLOAD_BUDGETS_MIB) {
  const lines = [];
  const warnings = [];
  for (const key of SECTION_KEYS) {
    const mib = (sections[key] ?? 0) / 1048576;
    lines.push(`payload size: ${key} ${mib.toFixed(1)} MiB`);
    if (mib > budgets[key]) warnings.push(`payload size warning: ${key} ${mib.toFixed(1)} MiB exceeds ${budgets[key]} MiB`);
  }
  return { lines, warnings };
}

export function writePayloadSizeLines(sections, stdout = process.stdout, stderr = process.stderr) {
  const report = payloadSizeLines(sections);
  stdout.write(`${report.lines.join('\n')}\n`);
  if (report.warnings.length) stderr.write(`${report.warnings.join('\n')}\n`);
  return report.warnings;
}

export async function measurePayload(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
  const target = `${manifest.platform}-${manifest.arch}`;
  const [node, graphify, web, total] = await Promise.all([
    directoryBytes(path.join(root, 'runtime', target, 'node')),
    directoryBytes(path.join(root, 'tools', 'graphify')),
    directoryBytes(path.join(root, 'web')),
    directoryBytes(root),
  ]);
  return { node, graphify, web, total };
}

export async function reportPayload(root, stdout = process.stdout, stderr = process.stderr) {
  return writePayloadSizeLines(await measurePayload(root), stdout, stderr);
}

export async function reportPackagedArtifacts(directory, stdout = process.stdout) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.app')) found.push(absolute);
        else await walk(absolute);
        continue;
      }
      if (entry.isFile() && /\.(dmg|exe|zip)$/i.test(entry.name)) found.push(absolute);
    }
  }
  await walk(directory);
  for (const file of found.sort()) {
    const bytes = await directoryBytes(file);
    stdout.write(`payload size: ${path.basename(file)} ${(bytes / 1048576).toFixed(1)} MiB\n`);
  }
  return found;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('Usage: payload-size.mjs <payload-directory>\n');
    process.exitCode = 2;
  } else {
    reportPayload(path.resolve(target)).catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
  }
}
