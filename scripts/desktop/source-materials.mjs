import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const defaultPolicyPath = new URL('./source-materials-policy.json', import.meta.url);

const isInside = (root, value) => { const rel = path.relative(root, value); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
const hashFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
async function readBoundedResponse(response, limit, name) {
  if (!response.body) throw new Error(`Source response has no body: ${name}`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Source download exceeds bounded size: ${name}`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}
function safeParts(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.includes(':') || path.posix.isAbsolute(value)) throw new Error(`Unsafe material path: ${value}`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe material path: ${value}`);
  return parts;
}
async function safeFile(root, relative) {
  const parts = safeParts(relative);
  const absolute = path.resolve(root, ...parts);
  if (!isInside(root, absolute)) throw new Error(`Unsafe material path escapes root: ${relative}`);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(() => null);
    if (!info) throw new Error(`Missing material file: ${relative}`);
    if (info.isSymbolicLink()) throw new Error(`Unsafe symlink in material path: ${relative}`);
    if (cursor !== absolute && !info.isDirectory()) throw new Error(`Unsafe material parent path: ${relative}`);
  }
  const info = await lstat(absolute);
  if (!info.isFile()) throw new Error(`Material reference is not a file: ${relative}`);
  return absolute;
}
async function trustedInputRoot(root) {
  if (!root) throw new Error('An explicit allowed inputRoot is required for local sourcePath inputs');
  const absolute = path.resolve(root);
  const rootName = path.parse(absolute).root;
  let cursor = rootName;
  for (const part of absolute.slice(rootName.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe allowed inputRoot ancestor: ${cursor}`);
  }
  return absolute;
}
async function safeInputFile(root, relative) {
  return safeFile(root, relative);
}
async function ensureOutputDirectory(root, relative = '') {
  const parts = relative ? safeParts(relative) : [];
  const absoluteRoot = path.resolve(root);
  const rootParts = absoluteRoot.slice(path.parse(absoluteRoot).root.length).split(path.sep).filter(Boolean);
  let cursor = path.parse(absoluteRoot).root;
  for (const part of rootParts) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error(`Unsafe symlink in source-material output path: ${cursor}`);
    if (info && !info.isDirectory()) throw new Error(`Unsafe non-directory source-material output path: ${cursor}`);
    if (!info) {
      try { await mkdir(cursor); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const current = await lstat(cursor);
      if (current.isSymbolicLink() || !current.isDirectory()) throw new Error(`Unsafe raced source-material output path: ${cursor}`);
    }
  }
  cursor = absoluteRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(() => null);
    if (info?.isSymbolicLink()) throw new Error(`Unsafe symlink in source-material output path: ${cursor}`);
    if (info && !info.isDirectory()) throw new Error(`Unsafe non-directory source-material output path: ${cursor}`);
    if (!info) {
      try { await mkdir(cursor); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const current = await lstat(cursor);
      if (current.isSymbolicLink() || !current.isDirectory()) throw new Error(`Unsafe raced source-material output path: ${cursor}`);
    }
  }
  return cursor;
}
async function writeOutputFile(root, relative, bytes, { exclusive = true } = {}) {
  const parts = safeParts(relative);
  const parent = parts.slice(0, -1).join('/');
  await ensureOutputDirectory(root, parent);
  const destination = path.resolve(root, ...parts);
  const existing = await lstat(destination).catch(() => null);
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error(`Unsafe existing source-material output file: ${destination}`);
  if (existing && exclusive) throw new Error(`Source-material output already exists: ${destination}`);
  await writeFile(destination, bytes, { flag: existing ? 'w' : 'wx' });
  return destination;
}

const NOTICE_NAME = /^(?:license|licence|notice|copying|copyright|ofl)(?:[._ -].*)?$|(?:^|_)notices?(?:[._ -]|$)/i;
const FONT_LICENSE = /(?:^|\/)(?:fonts?|static\/media)\//i;
async function inventoryTreeFiles(root, treeRoot) {
  await requireRealDirectory(root, treeRoot);
  const result = [];
  const base = path.join(root, ...safeParts(treeRoot));
  const visit = async (dir, relative = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Unsafe symlink in shipped tree: ${treeRoot}/${rel}`);
      if (info.isDirectory()) await visit(absolute, rel);
      else if (info.isFile()) result.push({ path: `${treeRoot}/${rel}`, sha256: await hashFile(absolute) });
    }
  };
  await visit(base);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function requireRealDirectory(root, relative) {
  const parts = safeParts(relative);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Missing or unsafe shipped tree: ${relative}`);
  }
}
async function inventoryNotices(root) {
  const results = [];
  const visit = async (dir, rel = '') => {
    const realDir = await realpath(dir);
    if (!isInside(root, realDir)) throw new Error(`Notice scan escaped payload: ${dir}`);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (childRel === 'source-materials' || childRel.startsWith('source-materials/')) continue;
      const absolute = path.join(dir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Payload contains unsafe symlink during notice scan: ${childRel}`);
      if (info.isDirectory()) await visit(absolute, childRel);
      else if (info.isFile() && (NOTICE_NAME.test(entry.name) || childRel.startsWith('runtime/licenses/') || (FONT_LICENSE.test(childRel) && /\.txt$/i.test(entry.name)))) {
        results.push({ sourcePath: childRel, sha256: await hashFile(absolute), size: info.size });
      }
    }
  };
  await visit(root);
  return results.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}
async function inventoryFontAssets(root) {
  const assets = [];
  const base = path.join(root, 'web/apps/web/.next/static/media');
  const visit = async (dir, relative = '') => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Unsafe symlink in font asset inventory: ${rel}`);
      if (info.isDirectory()) await visit(absolute, rel);
      else if (info.isFile() && /\.woff2?$/i.test(entry.name)) assets.push({ path: `web/apps/web/.next/static/media/${rel}`, sha256: await hashFile(absolute) });
    }
  };
  await visit(base);
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}
async function mitGrantReadme(packageDir, packageRel) {
  for (const name of ['README.md', 'README', 'README.markdown']) {
    const absolute = path.join(packageDir, name);
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) continue;
    const text = await readFile(absolute, 'utf8');
    if (/permission is hereby granted/i.test(text) && /the software is provided "as is"/i.test(text)) return [`${packageRel}/${name}`];
  }
  return [];
}
async function inventoryProductionDependencies(root) {
  const packages = [];
  const missing = [];
  const nodeModules = path.join(root, 'app/node_modules');
  const nodeModulesInfo = await lstat(nodeModules).catch(() => null);
  if (!nodeModulesInfo?.isDirectory() || nodeModulesInfo.isSymbolicLink()) return { packageCount: 0, packages, missing: [{ packageRoot: 'app/node_modules', reason: 'production dependency tree is missing or unsafe' }] };
  const noticeFiles = async (packageDir, packageRel) => {
    const found = [];
    const visit = async (dir, rel = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = rel ? `${rel}/${entry.name}` : entry.name;
        const absolute = path.join(dir, entry.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error(`Unsafe symlink in dependency notice inventory: ${packageRel}/${relative}`);
        if (info.isDirectory() && entry.name !== 'node_modules') await visit(absolute, relative);
        else if (info.isFile() && NOTICE_NAME.test(entry.name)) found.push(`${packageRel}/${relative}`);
      }
    };
    await visit(packageDir);
    return found.sort();
  };
  const findNestedModules = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules') { await visitModules(path.join(dir, entry.name), `${rel}/node_modules`); continue; }
      if (entry.name === '.bin') continue;
      await findNestedModules(path.join(dir, entry.name), `${rel}/${entry.name}`);
    }
  };
  const visitPackage = async (packageDir, packageRel) => {
    const info = await lstat(packageDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe production dependency package path: ${packageRel}`);
    const packageJsonRel = `${packageRel}/package.json`;
    const packageJsonPath = await safeFile(root, packageJsonRel).catch(() => null);
    if (!packageJsonPath) { missing.push({ packageRoot: packageRel, reason: 'package.json metadata is missing' }); return; }
    const metadata = JSON.parse(await readFile(packageJsonPath, 'utf8'));
    const notices = await noticeFiles(packageDir, packageRel);
    const isFirstParty = metadata.name?.startsWith('@nema/');
    const license = metadata.license ?? (isFirstParty ? 'MIT (root application license)' : null);
    // Some MIT packages (pg-types, pgpass) ship the grant in README.md and no LICENSE file.
    const readmeNotice = notices.length || license !== 'MIT' ? [] : await mitGrantReadme(packageDir, packageRel);
    const associatedNoticePaths = isFirstParty ? ['runtime/licenses/application'] : (notices.length ? notices : readmeNotice);
    const record = { name: metadata.name ?? null, version: metadata.version ?? null, license, packageRoot: packageRel, noticePaths: associatedNoticePaths };
    packages.push(record);
    if (!record.name || !record.version) missing.push({ packageRoot: packageRel, reason: 'package name or version metadata is missing' });
    if (!license) missing.push({ packageRoot: packageRel, package: record.name, reason: 'package license metadata is missing' });
    let hasMissingAssociatedNotice = associatedNoticePaths.length === 0;
    for (const notice of associatedNoticePaths) {
      const noticePath = await safeFile(root, notice).catch(() => null);
      if (!noticePath) hasMissingAssociatedNotice = true;
    }
    if (hasMissingAssociatedNotice) missing.push({ packageRoot: packageRel, package: record.name, reason: 'associated license or notice file is missing' });
    await findNestedModules(packageDir, packageRel);
  };
  const visitModules = async (modulesDir, modulesRel) => {
    for (const entry of await readdir(modulesDir, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
      const absolute = path.join(modulesDir, entry.name);
      const info = await lstat(absolute);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe production dependency entry: ${modulesRel}/${entry.name}`);
      if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(absolute, { withFileTypes: true })) {
          if (!scoped.isDirectory() || scoped.isSymbolicLink()) throw new Error(`Unsafe scoped dependency entry: ${modulesRel}/${entry.name}/${scoped.name}`);
          await visitPackage(path.join(absolute, scoped.name), `${modulesRel}/${entry.name}/${scoped.name}`);
        }
      } else await visitPackage(absolute, `${modulesRel}/${entry.name}`);
    }
  };
  await visitModules(nodeModules, 'app/node_modules');
  packages.sort((a, b) => a.packageRoot.localeCompare(b.packageRoot));
  missing.sort((a, b) => `${a.packageRoot}:${a.reason}`.localeCompare(`${b.packageRoot}:${b.reason}`));
  return { packageCount: packages.length, packages, missing };
}

async function readTrustedPolicy(policyPath, target) {
  const policyBytes = await readFile(policyPath ?? defaultPolicyPath);
  const policy = JSON.parse(policyBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (policy.schemaVersion !== 1 || !policy.targets?.[target] || !Array.isArray(policy.targets[target].components)) throw new Error(`Trusted source policy is missing or invalid for ${target}`);
  return { sha256: createHash('sha256').update(policyBytes).digest('hex'), target: policy.targets[target], policy };
}

async function validatePolicyCoverage({ trustedPolicy, payloadRoot, archiveRoot = payloadRoot, target, materials, notices }) {
  const { target: policyTarget } = trustedPolicy;
  // Git is not bundled (Nema uses the user's own git), so no Git source component is required.
  const requiredIds = ['node-source', 'font-sources', 'electron-ffmpeg'];
  const byId = new Map(policyTarget.components.map((component) => [component.id, component]));
  if (byId.size !== requiredIds.length || requiredIds.some((id) => !byId.has(id))) throw new Error('Trusted source policy component set does not match target requirements');
  const pending = [];
  if (policyTarget.status !== 'resolved') pending.push(`target source policy remains ${policyTarget.status ?? 'pending'}`);
  for (const id of requiredIds) {
    const component = byId.get(id);
    if (component.status !== 'resolved') {
      pending.push(component.reason ?? `${id} remains pending in trusted source policy`);
      continue;
    }
    if (component.obligation === 'notice') {
      if (!Array.isArray(component.notices) || component.notices.length === 0) throw new Error(`Notice obligation has no notices: ${id}`);
      for (const required of component.notices) {
        if (!required?.sourcePath) throw new Error(`Notice obligation is missing a path: ${id}`);
        const notice = notices.find((item) => item.sourcePath === required.sourcePath);
        if (!notice) {
          pending.push(`${id} notice is missing: ${required.sourcePath}`);
          continue;
        }
        if (!Array.isArray(required.mustMatch) || required.mustMatch.length === 0) continue;
        const relative = notice.sourcePath.startsWith('upstream:') ? notice.bundlePath : notice.sourcePath;
        const text = await readFile(await safeFile(payloadRoot, relative), 'utf8');
        for (const needle of required.mustMatch) {
          if (!text.includes(needle)) pending.push(`${id} notice ${required.sourcePath} is missing ${JSON.stringify(needle)}`);
        }
      }
      continue;
    }
    const kind = component.coverage?.kind;
    let expectedFiles;
    if (kind === 'files') {
      const root = component.coverage.root;
      expectedFiles = await inventoryTreeFiles(payloadRoot, root);
    } else if (kind === 'font-assets') {
      expectedFiles = await inventoryFontAssets(payloadRoot);
    } else {
      throw new Error(`Unsupported trusted source coverage policy for ${id}: ${kind}`);
    }
    const mappings = component.mappings;
    if (!Array.isArray(mappings) || !mappings.length) throw new Error(`Resolved source policy has no structured mappings: ${id}`);
    const keys = mappings.map((mapping) => mapping.key);
    if (keys.some((key) => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) throw new Error(`Resolved source policy has invalid or duplicate mapping keys: ${id}`);
    const requiredMappingKeys = id === 'node-source' ? ['node-runtime', 'npm-package', 'corepack-package'] : null;
    const expectedKeys = requiredMappingKeys ?? component.coverage.requiredMappingKeys;
    if (expectedKeys && JSON.stringify([...keys].sort()) !== JSON.stringify([...expectedKeys].sort())) throw new Error(`Trusted source mapping keys do not cover required artifacts: ${id}`);
    if (id === 'font-sources') {
      const families = mappings.map((mapping) => mapping.family);
      if (families.length !== 2 || new Set(families).size !== 2 || !['inter', 'jetbrains-mono'].every((family) => families.includes(family))) throw new Error('Trusted font policy must map both Inter and JetBrains Mono families explicitly');
    }
    const files = [];
    for (const mapping of mappings) {
      if (!Array.isArray(mapping.files) || !Array.isArray(mapping.materialRefs)) throw new Error(`Trusted source mapping is incomplete: ${id}/${mapping.key}`);
      files.push(...mapping.files);
      const roles = new Set();
      const referenceIds = new Set();
      for (const reference of mapping.materialRefs) {
        if (roles.has(reference.role)) throw new Error(`Duplicate source material role in mapping: ${id}/${mapping.key}/${reference.role}`);
        roles.add(reference.role);
        const referenceId = `${reference.kind ?? 'archive'}:${reference.materialId ?? reference.noticeId}`;
        if (referenceIds.has(referenceId)) throw new Error(`One material cannot self-certify multiple mapping roles: ${id}/${mapping.key}`);
        referenceIds.add(referenceId);
        if (reference.kind === 'notice') {
          const notice = notices.find((item) => item.sourcePath === `upstream:${reference.noticeId}`);
          if (!notice || notice.sha256 !== reference.sha256 || notice.provenance?.immutableRef !== reference.immutableRef) throw new Error(`Trusted mapping notice reference mismatch: ${id}/${mapping.key}`);
        } else {
          const material = materials.find((item) => item.id === reference.materialId);
          if (!material?.archive || material.archive.sha256 !== reference.sha256 || material.archive.immutableRef !== reference.immutableRef || material.archive.target !== target || reference.target !== target || material.archive.tool !== reference.tool || material.archive.version !== reference.version || !reference.tool || !reference.version || !reference.immutableRef) throw new Error(`Trusted material reference mismatch: ${id}/${mapping.key}`);
          const archive = await safeFile(archiveRoot, material.archive.path);
          if (await hashFile(archive) !== reference.sha256) throw new Error(`Trusted source archive hash mismatch: ${id}/${mapping.key}`);
        }
      }
      for (const role of component.requiredRoles ?? []) if (!roles.has(role)) throw new Error(`Trusted source mapping omits required ${role} material: ${id}/${mapping.key}`);
    }
    const actualFiles = new Map(expectedFiles.map((file) => [file.path, file.sha256]));
    const mappedFiles = new Map();
    for (const file of files) {
      if (mappedFiles.has(file.path)) throw new Error(`Shipped file appears in multiple source mappings: ${file.path}`);
      mappedFiles.set(file.path, file.sha256);
      if (actualFiles.get(file.path) !== file.sha256) throw new Error(`Trusted source mapping does not match shipped file bytes: ${file.path}`);
    }
    if (mappedFiles.size !== actualFiles.size || [...actualFiles.keys()].some((file) => !mappedFiles.has(file))) throw new Error(`Trusted source mappings do not cover the complete shipped ${id} inventory`);
  }
  return { eligible: pending.length === 0, pending };
}

export async function collectSourceMaterials({ payloadRoot, outputRoot = payloadRoot, target, appVersion, toolsManifestPath, policyPath, inputRoot, sourceMaterials, upstreamNotices = [], fetchImpl = fetch, maxArchiveBytes = 256 * 1024 * 1024 } = {}) {
  const payload = await realpath(payloadRoot);
  const output = path.resolve(outputRoot);
  await ensureOutputDirectory(output);
  const trustedManifest = JSON.parse((await readFile(toolsManifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  const trustedPolicy = await readTrustedPolicy(policyPath, target);
  const toolsRecordPath = await safeFile(payload, `runtime/${target}/tools-source.json`);
  const record = JSON.parse(await readFile(toolsRecordPath, 'utf8'));
  const expectedNode = trustedManifest.node.archive?.[target];
  if (!expectedNode || record.target !== target) throw new Error(`Unsupported or mismatched source target ${target}`);
  const notices = await inventoryNotices(payload);
  await ensureOutputDirectory(output, 'source-materials/notices');
  for (const notice of notices) {
    const source = await safeFile(payload, notice.sourcePath);
    const sourceId = createHash('sha256').update(notice.sourcePath).digest('hex').slice(0, 12);
    const bundlePath = `source-materials/notices/${notice.sha256}-${sourceId}-${path.basename(notice.sourcePath)}`;
    await writeOutputFile(output, bundlePath, await readFile(source));
    notice.bundlePath = bundlePath;
  }
  for (const notice of upstreamNotices) {
    if (!notice.id || !notice.component || !notice.immutableRef || !notice.url) throw new Error('Upstream notice requires component, immutable URL/ref');
    let bytes;
    if (notice.sourcePath) {
      const sourceRoot = await trustedInputRoot(inputRoot);
      const source = await safeInputFile(sourceRoot, notice.sourcePath);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > maxArchiveBytes) throw new Error(`Upstream notice source is not a bounded regular file: ${notice.id}`);
      bytes = await readFile(source);
    } else if (notice.payloadPath) {
      bytes = await readFile(await safeFile(payload, notice.payloadPath));
    } else {
      const url = new URL(notice.url);
      const allowedHosts = new Set(['github.com', 'raw.githubusercontent.com', 'codeload.github.com']);
      if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname)) throw new Error(`Unapproved upstream notice URL: ${notice.id}`);
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), redirect: 'follow' });
      const finalUrl = new URL(response.url);
      if (!response.ok || finalUrl.protocol !== 'https:' || !allowedHosts.has(finalUrl.hostname)) throw new Error(`Upstream notice fetch failed or redirected unexpectedly: ${notice.id}`);
      bytes = await readBoundedResponse(response, maxArchiveBytes, notice.id);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const bundlePath = `source-materials/notices/${sha256}-${notice.id}.txt`;
    await writeOutputFile(output, bundlePath, bytes);
    notices.push({ sourcePath: `upstream:${notice.id}`, component: notice.component, provenance: { url: notice.url, immutableRef: notice.immutableRef }, sha256, size: bytes.length, bundlePath });
  }
  notices.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  const tools = {
    node: { version: record.node?.version, archive: record.node?.archive, sha256: record.node?.sha256, expectedArchive: expectedNode.file, expectedSha256: expectedNode.sha256, pinMatches: record.node?.version === trustedManifest.node.version && record.node?.archive === expectedNode.file && record.node?.sha256 === expectedNode.sha256 },
  };
  const productionDependencies = await inventoryProductionDependencies(payload);
  let materials = sourceMaterials;
  if (!materials) materials = [
    { id: 'node-source', component: `Node.js ${trustedManifest.node.version}`, status: 'notice', correspondence: 'notice', reason: 'MIT. The staged Node LICENSE is the required notice.' },
    { id: 'font-sources', component: 'Inter and JetBrains Mono WOFF2 assets', status: 'notice', correspondence: 'notice', reason: 'SIL Open Font License. The OFL notices ship with the WOFF2 files.' },
  ];
  materials = await Promise.all(materials.map(async (item) => {
    if (!item.sourcePath && !item.url) return item;
    let bytes;
    if (item.url) {
      const url = new URL(item.url);
      if (url.protocol !== 'https:' || !item.immutableRef) throw new Error(`Source URL must be HTTPS and carry an immutable ref: ${item.id}`);
      const allowedHosts = new Set(['nodejs.org', 'github.com', 'raw.githubusercontent.com', 'codeload.github.com']);
      if (!allowedHosts.has(url.hostname)) throw new Error(`Unapproved primary source host: ${url.hostname}`);
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000), redirect: 'follow' });
      if (!response.ok) throw new Error(`Source archive fetch failed (${response.status}): ${item.id}`);
      const finalUrl = new URL(response.url);
      if (finalUrl.protocol !== 'https:' || !allowedHosts.has(finalUrl.hostname)) throw new Error(`Source archive redirected to an unapproved host or non-HTTPS URL: ${item.id}`);
      const declaredSize = Number(response.headers.get('content-length') ?? 0);
      if (declaredSize > maxArchiveBytes) throw new Error(`Source archive exceeds bounded download size: ${item.id}`);
      bytes = await readBoundedResponse(response, maxArchiveBytes, item.id);
    } else {
      const sourceRoot = await trustedInputRoot(inputRoot);
      const source = await safeInputFile(sourceRoot, item.sourcePath);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source archive is not a regular file: ${item.id}`);
      if (info.size > maxArchiveBytes) throw new Error(`Source archive exceeds bounded download size: ${item.id}`);
      bytes = await readFile(source);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (item.sha256 && item.sha256 !== sha256) throw new Error(`Source archive hash mismatch: ${item.id}`);
    if (!item.immutableRef || !item.version || !item.archiveTarget || !item.tool) throw new Error(`Source archive metadata is incomplete: ${item.id}`);
    const filename = path.basename(item.filename ?? (item.sourcePath ? item.sourcePath : new URL(item.url).pathname));
    const bundlePath = `source-materials/archives/${item.id}/${filename}`;
    await writeOutputFile(output, bundlePath, bytes);
    const { sourcePath, ...publicItem } = item;
    return { ...publicItem, url: item.url, archive: { path: bundlePath, sha256, version: item.version, target: item.archiveTarget, tool: item.tool, immutableRef: item.immutableRef } };
  }));
  const fontMaterial = materials.find((item) => item.id === 'font-sources');
  if (fontMaterial && !fontMaterial.stagedAssets) {
    fontMaterial.stagedAssets = await inventoryFontAssets(payload);
    fontMaterial.licenseNoticeIds = ['inter-ofl', 'jetbrains-mono-ofl'].filter((id) => notices.some((notice) => notice.sourcePath === `upstream:${id}`));
  }
  const correspondence = await validatePolicyCoverage({ trustedPolicy, payloadRoot: payload, archiveRoot: output, target, materials, notices });
  const noticeOnlyIds = new Set(trustedPolicy.target.components.filter((component) => component.obligation === 'notice').map((component) => component.id));
  const unresolved = [
    ...correspondence.pending.map((reason) => ({ id: 'trusted-source-policy', reason })),
    ...materials.filter((item) => !item.archive && !noticeOnlyIds.has(item.id)).map(({ id, reason }) => ({ id, reason: reason ?? 'expected archive bytes have not been collected' })),
    ...productionDependencies.missing.map((item) => ({ id: `production-dependency:${item.packageRoot}`, package: item.package ?? null, reason: item.reason })),
  ];
  const result = { schemaVersion: 1, target, appVersion, createdAt: new Date().toISOString(), eligibility: 'local-validation-only', publicationEligibility: correspondence.eligible && !unresolved.length ? 'eligible' : 'pending', sourcePolicy: { schemaVersion: trustedPolicy.policy.schemaVersion, policyVersion: trustedPolicy.policy.policyVersion, sha256: trustedPolicy.sha256 }, tools, productionDependencies, notices, noticeCount: notices.length, materials, unresolved };
  const manifestPath = path.join(output, 'source-materials.json');
  await writeOutputFile(output, 'source-materials.json', `${JSON.stringify(result, null, 2)}\n`);
  if (path.resolve(output) === payload) {
    record.sourceCorrespondence = {
      status: result.publicationEligibility === 'eligible' ? 'source-materials-collected' : 'pending-task-7c',
      manifest: 'source-materials.json',
      manifestSha256: await hashFile(manifestPath),
      evidence: result.publicationEligibility === 'eligible' ? 'The trusted source policy is satisfied. Notice obligations are the shipped license texts; any source-archive obligation is hash-bound.' : 'Local materials are inventoried; trusted correspondence policy or required evidence remains pending.',
    };
    await writeOutputFile(payload, `runtime/${target}/tools-source.json`, `${JSON.stringify(record, null, 2)}\n`, { exclusive: false });
  }
  return result;
}

export async function validatePublicationEligibility(payloadRoot, { toolsManifestPath, policyPath, expectedTarget, expectedAppVersion } = {}) {
  const root = await realpath(payloadRoot);
  const manifestPath = await safeFile(root, 'source-materials.json');
  const materials = JSON.parse(await readFile(manifestPath, 'utf8'));
  const target = expectedTarget ?? materials.target;
  if (materials.schemaVersion !== 1 || materials.target !== target || (expectedAppVersion && materials.appVersion !== expectedAppVersion)) throw new Error('Source-material manifest schema, target, or application version mismatch');
  const runtimeManifest = JSON.parse(await readFile(await safeFile(root, 'runtime-manifest.json'), 'utf8'));
  if (`${runtimeManifest.platform}-${runtimeManifest.arch}` !== target || runtimeManifest.version !== materials.appVersion) throw new Error('Source-material target or application version does not match runtime manifest');
  for (const notice of ['runtime/licenses/electron/LICENSE', 'runtime/licenses/electron/LICENSES.chromium.html']) await safeFile(root, notice);
  const trusted = JSON.parse((await readFile(toolsManifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  const trustedPolicy = await readTrustedPolicy(policyPath, target);
  if (materials.sourcePolicy?.sha256 !== trustedPolicy.sha256) throw new Error('Source-material manifest trusted policy hash mismatch');
  const recordPath = await safeFile(root, `runtime/${target}/tools-source.json`);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  const actualDependencies = await inventoryProductionDependencies(root);
  if (JSON.stringify(actualDependencies) !== JSON.stringify(materials.productionDependencies)) throw new Error('Production dependency names, versions, license metadata, or notice paths do not match staged package closure');
  if (actualDependencies.missing.length) throw new Error(`Production dependency notice inventory has unresolved packages: ${actualDependencies.missing.length}`);
  const nodePin = trusted.node.archive?.[target];
  if (!nodePin) throw new Error(`Trusted tools manifest has no target pins for ${target}`);
  if (record.target !== target || record.node?.version !== trusted.node.version || record.node?.archive !== nodePin.file || record.node?.sha256 !== nodePin.sha256) throw new Error('Payload tool target/version/archive/hash does not match trusted tools manifest pins');
  if (!materials.tools?.node?.pinMatches) throw new Error('Source-material inventory has an untrusted node tool pin');
  for (const notice of materials.notices ?? []) {
    const file = await safeFile(root, notice.bundlePath);
    if (await hashFile(file) !== notice.sha256) throw new Error(`Notice hash mismatch: ${notice.sourcePath}`);
  }
  if (!Array.isArray(materials.materials) || materials.materials.length === 0) throw new Error('Source-material manifest has no source entries');
  const noticePaths = new Set((materials.notices ?? []).map((notice) => notice.sourcePath));
  const stagedNotices = await inventoryNotices(root);
  for (const notice of stagedNotices) if (!noticePaths.has(notice.sourcePath) || materials.notices.find((item) => item.sourcePath === notice.sourcePath)?.sha256 !== notice.sha256) throw new Error(`Staged notice inventory is incomplete or changed: ${notice.sourcePath}`);
  const requiredNoticePaths = [
    (p) => /^runtime\/[^/]+\/node\//.test(p),
    (p) => p === 'runtime/licenses/application',
    (p) => p.startsWith('vendor/archify/'),
    (p) => p.startsWith('vendor/superpowers-rules/'),
    (p) => p.startsWith('app/node_modules/'),
  ];
  for (const matches of requiredNoticePaths) if (!stagedNotices.some((notice) => matches(notice.sourcePath))) throw new Error('Required staged notice category is missing');
  for (const font of ['inter-ofl', 'jetbrains-mono-ofl']) if (!materials.notices.some((notice) => notice.sourcePath === `upstream:${font}` && notice.provenance?.url && notice.provenance?.immutableRef)) throw new Error(`Required font license provenance is missing: ${font}`);
  const noticeOnlyIds = new Set(trustedPolicy.target.components.filter((component) => component.obligation === 'notice').map((component) => component.id));
  for (const item of materials.materials) {
    if (!item.archive?.path && noticeOnlyIds.has(item.id)) continue;
    if (item.archive?.path) {
      const archive = await safeFile(root, item.archive.path);
      if (await hashFile(archive) !== item.archive.sha256) throw new Error(`Source archive hash mismatch: ${item.id}`);
      if (item.archive.target !== target || item.archive.version !== item.version || !item.archive.tool || !item.archive.immutableRef) throw new Error(`Source archive target/tool/version mismatch: ${item.id}`);
    }
    if (!item.archive?.path) throw new Error(`Source material archive is pending or incomplete: ${item.id}`);
  }
  const coverage = await validatePolicyCoverage({ trustedPolicy, payloadRoot: root, target, materials: materials.materials, notices: materials.notices ?? [] });
  if (!coverage.eligible) throw new Error(`Trusted source policy remains pending: ${coverage.pending.join('; ')}`);
  if (record.sourceCorrespondence?.status !== 'source-materials-collected' || record.sourceCorrespondence?.manifest !== 'source-materials.json' || record.sourceCorrespondence?.manifestSha256 !== await hashFile(manifestPath)) throw new Error('Tool provenance is pending or its source-material manifest hash is not bound');
  if (materials.publicationEligibility !== 'eligible' || materials.unresolved?.length) throw new Error('Publication blocked: unresolved source correspondence remains');
  return { eligible: true, manifest: 'source-materials.json', target, appVersion: materials.appVersion, noticeCount: materials.noticeCount, materialCount: materials.materials.length };
}
