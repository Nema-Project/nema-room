import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Warn-only ceilings in MiB. A warning must not fail the build; the release gate is `checkSlimPayload`.
 * Graphify is an on-demand component (#132), so any graphify bytes at all are worth a warning.
 */
export const PAYLOAD_BUDGETS_MIB = {
  node: 135,
  graphify: 0,
  web: 30,
  total: 80,
};

/** The release gate's ceiling for a whole payload (spec acceptance: every target at most 80 MiB). */
export const SLIM_PAYLOAD_TOTAL_MIB = 80;

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

/**
 * Fails when the payload is not the slim one: Graphify is downloaded on first use, so `tools/graphify` must be
 * absent (as a directory, file or link), the graphify section must measure 0, and, unless `maxTotalMiB` is
 * null, the whole payload must fit the slim budget. Returns the measured sections.
 */
export async function checkSlimPayload(root, { maxTotalMiB = SLIM_PAYLOAD_TOTAL_MIB } = {}) {
  const bundled = path.join(root, 'tools', 'graphify');
  const found = await lstat(bundled).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (found) throw new Error(`Payload contains tools/graphify (${bundled}); Graphify is an on-demand component and must not ship in the payload`);
  const sections = await measurePayload(root);
  if (sections.graphify !== 0) throw new Error(`Payload graphify section is ${(sections.graphify / 1048576).toFixed(1)} MiB; it must be 0`);
  if (maxTotalMiB !== null && sections.total > maxTotalMiB * 1048576) {
    throw new Error(`Payload total ${(sections.total / 1048576).toFixed(1)} MiB exceeds the ${maxTotalMiB} MiB slim-payload limit`);
  }
  return sections;
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
