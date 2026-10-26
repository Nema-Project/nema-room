import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const manifestPath = fileURLToPath(new URL('./tools-manifest.json', import.meta.url));
export const toolsManifest = JSON.parse(await readFile(manifestPath, 'utf8').then((s) => s.replace(/^\uFEFF/, '')));
const manifest = toolsManifest;
const supported = new Set(['win32-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']);
const keyFor = (platform, arch) => `${platform}-${arch}`;

export function assetsFor(platform, arch) {
  const key = keyFor(platform, arch);
  if (!supported.has(key) || !manifest.node.archive[key]) {
    throw new Error(`Unsupported bundled tools target: ${key}`);
  }
  const n = manifest.node.archive[key];
  // Git is not bundled: Nema runs the user's own git (apps/cli/src/systemGit.ts).
  return { target: key, node: { ...n, version: manifest.node.version, url: `${manifest.node.source}${n.file}` } };
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.includes(':') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe archive path: ${String(name)}`);
  }
  const parts = name.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) throw new Error(`Unsafe archive traversal path: ${name}`);
  return parts.join(path.sep);
}
function within(root, relative) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe archive path: ${relative}`);
  return target;
}

function extractZip(data, dest) {
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP: end-of-central-directory not found');
  const count = data.readUInt16LE(eocd + 10);
  let cursor = data.readUInt32LE(eocd + 16);
  const writes = [];
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory');
    const flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10);
    const compSize = data.readUInt32LE(cursor + 20), nameLen = data.readUInt16LE(cursor + 28);
    const extraLen = data.readUInt16LE(cursor + 30), commentLen = data.readUInt16LE(cursor + 32);
    const external = data.readUInt32LE(cursor + 38), localOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'utf8');
    cursor += 46 + nameLen + extraLen + commentLen;
    const isDir = name.endsWith('/');
    const rel = safeRelative(isDir ? name.slice(0, -1) : name);
    const unixMode = external >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error(`ZIP symlink entries are not supported: ${name}`);
    if (flags & 1) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const localNameLen = data.readUInt16LE(localOffset + 26), localExtraLen = data.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = data.subarray(start, start + compSize);
    const body = isDir ? Buffer.alloc(0) : method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (body === null) throw new Error(`Unsupported ZIP compression method ${method}`);
    writes.push({ rel, isDir, body, mode: unixMode & 0o777 });
  }
  return Promise.all(writes.map(async ({ rel, isDir, body, mode }) => {
    const target = within(dest, rel);
    if (isDir) return mkdir(target, { recursive: true });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, { flag: 'wx', mode: mode || 0o644 });
    if (mode & 0o111) await chmod(target, mode & 0o777);
  }));
}

function parseOctal(buf) {
  const text = buf.toString('ascii').replace(/\0.*$/, '').trim();
  return text ? Number.parseInt(text, 8) : 0;
}
function tarName(header) {
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  return prefix ? `${prefix}/${name}` : name;
}
async function extractTarGz(compressed, dest) {
  const data = gunzipSync(compressed);
  let offset = 0;
  const entries = [];
  const links = [];
  while (offset + 512 <= data.length) {
    const h = data.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    const name = tarName(h), size = parseOctal(h.subarray(124, 136));
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i];
    if (checksum !== parseOctal(h.subarray(148, 156))) throw new Error(`Invalid TAR header checksum: ${name}`);
    const type = String.fromCharCode(h[156] || 48), dataOffset = offset + 512;
    const body = data.subarray(dataOffset, dataOffset + size);
    if (body.length !== size) throw new Error(`Truncated TAR entry: ${name}`);
    offset = dataOffset + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') throw new Error(`Unsupported extended TAR metadata entry: ${name}`);
    const normalizedName = name.replace(/\/$/, '');
    if ((normalizedName === '.' || normalizedName === './') && type === '5') continue;
    const rel = safeRelative(normalizedName);
    if (type === '5') entries.push({ rel, dir: true });
    else if (type === '0' || type === '\0' || type === '7') entries.push({ rel, body: Buffer.from(body), mode: parseOctal(h.subarray(100, 108)) });
    else if (type === '2') links.push({ rel, link: h.subarray(157, 257).toString('utf8').replace(/\0.*$/, '') });
    else if (type === '1') throw new Error(`TAR hard links are not supported: ${name}`);
    else throw new Error(`Unsupported TAR entry type ${type}: ${name}`);
  }
  const linkPaths = new Set(links.map(({ rel }) => path.resolve(dest, rel).toLowerCase()));
  const allPaths = [...entries.map(({ rel }) => rel), ...links.map(({ rel }) => rel)];
  for (const rel of allPaths) {
    let parent = path.dirname(rel);
    while (parent !== '.') {
      if (linkPaths.has(path.resolve(dest, parent).toLowerCase())) {
        throw new Error(`TAR symlink parent is not supported: ${rel}`);
      }
      parent = path.dirname(parent);
    }
  }
  // Validate the full archive link topology before any write, then materialize
  // regular files first so archive symlinks cannot redirect extraction writes.
  for (const entry of entries) {
    const target = within(dest, entry.rel);
    if (entry.dir) await mkdir(target, { recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.body, { flag: 'wx', mode: entry.mode || 0o644 });
      if (entry.mode & 0o111) await chmod(target, entry.mode & 0o777);
    }
  }
  for (const { rel, link } of links) {
    if (!link || path.isAbsolute(link) || /^[A-Za-z]:/.test(link) || link.includes('\\')) throw new Error(`Unsafe TAR symlink: ${rel}`);
    const target = path.resolve(dest, path.dirname(rel), link);
    if (target !== dest && !target.startsWith(`${dest}${path.sep}`)) throw new Error(`Unsafe TAR symlink traversal: ${rel}`);
    for (let parent = target; parent !== dest; parent = path.dirname(parent)) {
      if (linkPaths.has(parent.toLowerCase())) throw new Error(`TAR symlink chain is not supported: ${rel}`);
    }
    await mkdir(path.dirname(within(dest, rel)), { recursive: true });
    await symlink(link, within(dest, rel));
  }
}

export async function extractArchive(bytes, format, destination) {
  const dest = path.resolve(destination);
  await mkdir(dest, { recursive: true });
  if (format === 'zip') return extractZip(Buffer.from(bytes), dest);
  if (format === 'tar.gz') return extractTarGz(Buffer.from(bytes), dest);
  throw new Error(`Unsupported archive format: ${format}`);
}

async function ensureInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root), resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Path escapes configured directory: ${candidate}`);
  return resolved;
}
export async function rejectSymlinkPath(directory) {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  const segments = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]);
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) { if (error.code !== 'ENOENT') throw error; break; }
    if (!info.isSymbolicLink() && info.isDirectory()) continue;
    // macOS temp lives under /var -> /private/var. Follow that ancestor, still refuse a symlink at the configured directory itself.
    if (info.isSymbolicLink() && i < segments.length - 1) return rejectSymlinkPath(path.join(await realpath(cursor), ...segments.slice(i + 1)));
    throw new Error(`Configured directory path contains a symlink or non-directory: ${cursor}`);
  }
}
export async function downloadVerified(asset, cacheDir, fetchImpl = fetch) {
  await mkdir(cacheDir, { recursive: true });
  const finalPath = await ensureInsideRoot(cacheDir, path.join(cacheDir, asset.file));
  try {
    const info = await lstat(finalPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Cache artifact is not a regular file: ${asset.file}`);
    if (await sha256File(finalPath) !== asset.sha256) throw new Error(`Cached artifact checksum mismatch: ${asset.file}`);
    return finalPath;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(asset.url);
  if (!response.ok) throw new Error(`Tool download failed (${response.status}): ${asset.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error(`Downloaded artifact checksum mismatch: ${asset.file}`);
  const temporary = `${finalPath}.${process.pid}.${Date.now()}.partial`;
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, finalPath); }
  finally { await rm(temporary, { force: true }); }
  return finalPath;
}

export async function findRequiredFile(root, candidates, label) {
  for (const candidate of candidates) {
    const file = path.join(root, candidate);
    try { const info = await lstat(file); if (info.isFile() && !info.isSymbolicLink()) return candidate; } catch {}
  }
  throw new Error(`Bundled ${label} is missing required license/source notices (${candidates.join(', ')})`);
}
export async function publishStagedDirectory(staged, target) {
  // Claim the final path with exclusive mkdir: POSIX rename may replace an empty
  // directory. The private marker lets failure cleanup prove this run still owns it.
  const token = randomUUID();
  let reservation;
  try {
    await mkdir(target);
    const identity = await lstat(target);
    const marker = path.join(target, '.nema-tools-owner');
    await writeFile(marker, token, { flag: 'wx' });
    reservation = { identity, marker, token };
    for (const item of await readdir(staged)) await rename(path.join(staged, item), path.join(target, item));
    await rm(marker);
  } catch (error) {
    if (reservation) {
      try {
        const current = await lstat(target);
        const markerValue = await readFile(reservation.marker, 'utf8');
        if (current.dev === reservation.identity.dev && current.ino === reservation.identity.ino && markerValue === reservation.token) {
          await rm(target, { recursive: true, force: false });
        }
      } catch { /* Ownership could not be proved; leave the path untouched. */ }
    }
    throw error;
  }
}
async function copyTree(source, destination, sourceRoot = source) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const link = await readlink(source);
    if (path.isAbsolute(link) || link.includes('\\') || link.includes(':')) throw new Error(`Unsafe distribution symlink: ${source}`);
    const target = path.resolve(path.dirname(source), link), root = path.resolve(sourceRoot);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`Distribution symlink escapes archive: ${source}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(link, destination);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const item of await readdir(source)) await copyTree(path.join(source, item), path.join(destination, item), sourceRoot);
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    if (process.platform !== 'win32') await chmod(destination, info.mode & 0o777);
  }
}

export async function fetchTools({ platform, arch, cacheDir, outDir }) {
  if (!cacheDir || !outDir) throw new Error('cacheDir and outDir are required');
  const selected = assetsFor(platform, arch);
  const cacheRoot = path.resolve(cacheDir), outputRoot = path.resolve(outDir);
  if (cacheRoot === outputRoot || cacheRoot.startsWith(`${outputRoot}${path.sep}`) || outputRoot.startsWith(`${cacheRoot}${path.sep}`)) {
    throw new Error('cacheDir and outDir must be separate, non-nested directories');
  }
  await rejectSymlinkPath(cacheRoot);
  await rejectSymlinkPath(outputRoot);
  await mkdir(cacheRoot, { recursive: true });
  await mkdir(outputRoot, { recursive: true });
  await rejectSymlinkPath(cacheRoot);
  await rejectSymlinkPath(outputRoot);
  const targetRoot = await ensureInsideRoot(outputRoot, path.join(outputRoot, selected.target));
  // Refuse replacing an existing staged target; caller owns cleanup of its explicit output directory.
  try { await lstat(targetRoot); throw new Error(`Output target already exists: ${targetRoot}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const nodeArchive = await downloadVerified(selected.node, cacheRoot);
  // Keep staging on the output filesystem so its entries can move into the
  // exclusively-created target without copying or crossing volumes.
  // mkdtemp reserves a unique path owned by this invocation.
  const work = await mkdtemp(path.join(outputRoot, `.nema-tools-${selected.target}-`));
  const staged = await ensureInsideRoot(work, path.join(work, selected.target));
  await mkdir(staged, { recursive: true });
  try {
    const nodeTmp = path.join(work, 'node-unpack');
    await extractArchive(await readFile(nodeArchive), selected.node.format, nodeTmp);
    const nodeLicense = await findRequiredFile(nodeTmp, [
      `${selected.node.binary.split('/')[0]}/LICENSE`, `${selected.node.binary.split('/')[0]}/LICENSE.txt`,
      'LICENSE', 'LICENSE.txt',
    ], 'Node');
    const nodeHomeRel = selected.node.binary.includes('/') ? selected.node.binary.split('/')[0] : '.';
    const nodeHome = path.join(nodeTmp, nodeHomeRel);
    const nodeDest = path.join(staged, 'node');
    await copyTree(nodeHome, nodeDest, nodeHome);
    const nodeBinary = path.join(nodeDest, selected.node.binary.slice(nodeHomeRel === '.' ? 0 : nodeHomeRel.length + 1));
    for (const binary of [nodeBinary]) {
      const info = await lstat(binary).catch(() => null);
      if (!info?.isFile()) throw new Error(`Bundled executable is missing for ${selected.target}: ${binary}`);
      if (platform !== 'win32') await chmod(binary, (info.mode & 0o777) | 0o111);
    }
    const nodeNoticeRel = await findRequiredFile(nodeDest, ['LICENSE', 'LICENSE.txt'], 'Node');
    const publishedRelative = (file) => path.relative(outputRoot, path.join(targetRoot, path.relative(staged, file))).split(path.sep).join('/');
    const record = {
      schemaVersion: 1, target: selected.target,
      node: { version: manifest.node.version, npmVersion: manifest.node.npmVersion, corepackVersion: manifest.node.corepackVersion, source: manifest.node.source, checksumSource: manifest.node.checksumSource, archive: selected.node.file, sha256: selected.node.sha256, executable: publishedRelative(nodeBinary), license: publishedRelative(path.join(nodeDest, nodeNoticeRel)) },
      sourceCorrespondence: { status: 'pending-task-7c', evidence: 'Upstream sources, licenses, notices, and hashes are recorded. Corresponding source collection and redistribution obligations remain under Task 7c review.' },
    };
    const recordPath = path.join(staged, 'tools-source.json');
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    await publishStagedDirectory(staged, targetRoot);
    return {
      node: record.node.executable,
      licenses: { node: record.node.license, sourceRecord: publishedRelative(recordPath) },
    };
  } finally { await rm(work, { recursive: true, force: true }); }
}
