import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readElectronNodeVersion, runtimeNodeRecord } from './electron-node.mjs';
import { fetchTools, nodePayloadExcluded, toolsManifest } from './fetch-tools.mjs';
import { reportPayload } from './payload-size.mjs';
import { buildOwnedHelper } from './build-owned-helper.mjs';
import { fetchGraphify as fetchGraphifyRuntime } from './fetch-graphify.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '../..');
const cacheDefault = path.join(defaultRoot, '.superpowers/sdd/2026-10-24-desktop-implementation/tool-cache');
const REQUIRED_VENDOR = ['vendor/archify/LICENSE', 'vendor/archify/THIRD_PARTY_NOTICES.md', 'vendor/archify/bin/archify.mjs', 'vendor/superpowers-rules/LICENSE', 'vendor/superpowers-rules/spec-rules.md', 'vendor/superpowers-rules/plan-rules.md'];

const isInside = (root, value) => {
  const rel = path.relative(root, value);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const canonicalRoot = (root) => realpath(root).catch(() => path.resolve(root));

function safeRelative(value, name) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.includes(':') || path.posix.isAbsolute(value)) throw new Error(`Unsafe ${name} path`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Unsafe ${name} path: ${value}`);
  return parts;
}

async function requiredFile(root, relative, name, allowedRoot = root) {
  const rootReal = await realpath(root).catch(() => path.resolve(root));
  const policyRoot = await realpath(allowedRoot).catch(() => path.resolve(allowedRoot));
  if (!isInside(policyRoot, rootReal)) throw new Error(`Unsafe ${name} root escapes allowed resources: ${root}`);
  const file = path.resolve(rootReal, ...safeRelative(relative, name));
  if (!isInside(rootReal, file)) throw new Error(`Unsafe ${name} path: ${relative}`);
  let parent = path.dirname(file);
  while (isInside(policyRoot, parent)) {
    const parentInfo = await lstat(parent).catch(() => null);
    if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`Unsafe ${name} parent path: ${parent}`);
    if (parent === policyRoot) break;
    parent = path.dirname(parent);
  }
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Missing required ${name}: ${file}`);
  return file;
}

const SOURCE_MAP_NAME = /\.(?:js|mjs|cjs|css|ts|tsx|jsx)\.map$/;

async function copyTree(source, destination, allowedRoot, seen = new Set(), options = {}) {
  const skipRoot = options.skipRoot ?? source;
  const relative = path.relative(skipRoot, source).split(path.sep).join('/');
  if (relative && options.skip?.(relative)) return;
  const info = await lstat(source).catch(() => null);
  if (!info) throw new Error(`Required staged resource is missing: ${source}`);
  const nextOptions = { ...options, skipRoot };
  if (info.isSymbolicLink()) {
    const resolved = await realpath(source);
    const policyRoot = await canonicalRoot(allowedRoot);
    if (!isInside(policyRoot, resolved)) throw new Error(`Dependency or resource escapes payload source: ${source}`);
    if (seen.has(resolved)) throw new Error(`Cyclic resource link: ${source}`);
    return copyTree(resolved, destination, policyRoot, new Set([...seen, resolved]), nextOptions);
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      if (entry.startsWith('._') || entry === '.DS_Store') continue;
      await copyTree(path.join(source, entry), path.join(destination, entry), allowedRoot, seen, nextOptions);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported resource type: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false, preserveTimestamps: false });
  if (process.platform !== 'win32') await chmod(destination, info.mode & 0o777);
}

async function pruneStagedPayload(staging) {
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (path.basename(dir) === 'node_modules' && (entry.name === 'sharp' || entry.name === '@img')) {
          await rm(absolute, { recursive: true, force: true });
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (entry.isFile() && SOURCE_MAP_NAME.test(entry.name)) await rm(absolute);
    }
  }
  await walk(staging);
}

async function copyCompiledDist(source, destination, allowedRoot) {
  const policyRoot = await canonicalRoot(allowedRoot);
  async function visit(from, to, relative = '', seen = new Set()) {
    const info = await lstat(from);
    let resolved = from;
    let actual = info;
    if (info.isSymbolicLink()) {
      resolved = await realpath(from);
      if (!isInside(policyRoot, resolved)) throw new Error(`Dependency or resource escapes payload source: ${from}`);
      if (seen.has(resolved)) throw new Error(`Cyclic resource link: ${from}`);
      actual = await stat(resolved);
    }
    if (actual.isDirectory()) {
      await mkdir(to, { recursive: true });
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      for (const name of await readdir(resolved)) {
        const rel = relative ? `${relative}/${name}` : name;
        if (name.startsWith('._') || name === '.DS_Store' || /(^|\/)(?:test|tests|__tests__|fixtures?)(?:\/|$)/i.test(rel) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name)) continue;
        await visit(path.join(resolved, name), path.join(to, name), rel, nextSeen);
      }
    } else if (actual.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(resolved, to, { errorOnExist: true, force: false });
      if (process.platform !== 'win32') await chmod(to, actual.mode & 0o777);
    } else {
      throw new Error(`Unsupported compiled resource type: ${from}`);
    }
  }
  await visit(source, destination);
}

async function requireDirectory(dir, name, allowedRoot = dir) {
  const info = await lstat(dir).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`Missing required ${name}: ${dir}`);
  const dirReal = await realpath(dir);
  const policyRoot = await realpath(allowedRoot).catch(() => path.resolve(allowedRoot));
  if (!isInside(policyRoot, dirReal)) throw new Error(`Unsafe ${name} path escapes allowed resources: ${dir}`);
  let parent = dirReal;
  while (isInside(policyRoot, parent)) {
    const parentInfo = await lstat(parent).catch(() => null);
    if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) throw new Error(`Unsafe ${name} parent path: ${parent}`);
    if (parent === policyRoot) break;
    parent = path.dirname(parent);
  }
}

// Electron 45 ships no postinstall. The binary appears only after install.js runs.
async function ensureElectronBinary(sourceRoot) {
  const electronRoot = path.join(sourceRoot, 'node_modules', 'electron');
  const distRoot = path.join(electronRoot, 'dist');
  const relative = (await readFile(path.join(electronRoot, 'path.txt'), 'utf8').catch(() => '')).replace(/^\uFEFF/, '').trim();
  let binaryReady = false;
  if (relative && !relative.includes('\0') && !path.isAbsolute(relative)) {
    const binary = path.resolve(distRoot, relative);
    const escaped = path.relative(distRoot, binary);
    if (escaped !== '..' && !escaped.startsWith(`..${path.sep}`) && !path.isAbsolute(escaped)) {
      const binaryInfo = await lstat(binary).catch(() => null);
      binaryReady = Boolean(binaryInfo?.isFile() && !binaryInfo.isSymbolicLink());
    }
  }
  if (binaryReady) return;
  const installer = path.join(electronRoot, 'install.js');
  const info = await lstat(installer).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return;
  await run(process.execPath, [installer], sourceRoot, process.env);
}

async function run(executable, args, cwd, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} ${args[0] ?? ''} failed (${signal ?? code})`)));
  });
}

/** Resolve npm's CLI inside the pinned Node distribution (Windows zip vs POSIX tarball). */
export function npmCliPathFor(nodePath, platform = process.platform) {
  const nodeRoot = platform === 'win32' ? path.dirname(nodePath) : path.dirname(path.dirname(nodePath));
  const npmRelative = platform === 'win32'
    ? path.join('node_modules', 'npm', 'bin', 'npm-cli.js')
    : path.join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return path.join(nodeRoot, npmRelative);
}

export function parseStageArgs(args) {
  if (args.length === 0) return {};
  if (!args[0].startsWith('--')) {
    if (args.length > 2) throw new Error('Usage: stage-runtime.mjs [sourceRoot] [outputDir]');
    return { ...(args[0] ? { sourceRoot: args[0] } : {}), ...(args[1] ? { outputDir: args[1] } : {}) };
  }
  const options = new Map([
    ['--platform', 'platform'], ['--arch', 'arch'], ['--out', 'outputDir'], ['--source-root', 'sourceRoot'],
  ]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = options.get(args[index]);
    const value = args[index + 1];
    if (!key) throw new Error(`Unknown staging option: ${args[index]}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`Staging option ${args[index]} requires a value`);
    if (Object.hasOwn(result, key)) throw new Error(`Staging option ${args[index]} was provided more than once`);
    result[key] = value;
  }
  return result;
}

/** Payload-relative path of the packaged Electron executable. `..` is intentional: the binary is outside the payload. */
export function electronExecutableRelative(platform) {
  if (platform === 'win32') return '..\\..\\Nema.exe';
  if (platform === 'darwin') return '../../MacOS/Nema';
  return '../../Nema';
}

export async function writePlatformLaunchers(payloadRoot, manifest) {
  const nativePath = (relative) => relative.replaceAll('/', path.sep);
  const nodeRelative = manifest.node ?? electronExecutableRelative(manifest.platform);
  const names = manifest.platform === 'win32' ? ['Nema Browser.cmd', 'Nema CLI.cmd'] : manifest.platform === 'darwin' ? ['Nema Browser.command', 'Nema CLI.command'] : ['nema-browser', 'nema-cli'];
  const launcherPaths = [];
  for (const launcherName of names) {
    const launcherTemplate = path.join(scriptDir, 'templates', launcherName);
    const launcher = (await readFile(launcherTemplate, 'utf8')).replaceAll('{{NODE_PATH}}', nativePath(nodeRelative)).replaceAll('{{CLI_PATH}}', nativePath(manifest.cliEntry ?? ''));
    const launcherPath = path.join(payloadRoot, launcherName);
    await writeFile(launcherPath, launcher, { mode: manifest.platform === 'win32' ? 0o644 : 0o755 });
    if (manifest.platform !== 'win32') await chmod(launcherPath, 0o755);
    launcherPaths.push(launcherPath);
  }
  const webParentPath = path.join(payloadRoot, 'web', 'apps', 'web', 'managed-parent.mjs');
  await cp(path.join(scriptDir, 'templates/web-parent.mjs'), webParentPath);
  return { launcherPath: launcherPaths[0], cliLauncherPath: launcherPaths[1], webParentPath };
}

function nodeRootFor(nodePath, platform) {
  return platform === 'win32' ? path.dirname(nodePath) : path.dirname(path.dirname(nodePath));
}

export async function createSanitizedSourceSnapshot(sourceRoot, snapshot) {
  const excluded = new Set(['.git', '.next', 'node_modules', 'dist', '.superpowers', 'coverage', '.worktrees']);
  const rootReal = await realpath(sourceRoot);
  async function visit(from, to, relative = '', ancestors = new Set()) {
    const info = await lstat(from);
    let resolved = from;
    if (info.isSymbolicLink()) {
      resolved = await realpath(from);
      if (!isInside(rootReal, resolved)) throw new Error(`Source snapshot link escapes checkout: ${relative}`);
      if (ancestors.has(resolved.toLowerCase())) throw new Error(`Cyclic source snapshot link: ${relative}`);
    }
    const realInfo = info.isSymbolicLink() ? await stat(resolved) : info;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(resolved.toLowerCase());
    if (realInfo.isDirectory()) {
      await mkdir(to, { recursive: true });
      for (const name of await readdir(resolved)) {
        const rel = relative ? `${relative}/${name}` : name;
        if (excluded.has(name) || /^\.env(?:\..*)?$/.test(name) || name.startsWith('._') || name === '.DS_Store' || name.endsWith('.tsbuildinfo')) continue;
        await visit(path.join(resolved, name), path.join(to, name), rel, nextAncestors);
      }
    } else if (realInfo.isFile()) {
      await mkdir(path.dirname(to), { recursive: true });
      await cp(resolved, to, { errorOnExist: true, force: false });
    } else {
      throw new Error(`Unsupported source snapshot file type: ${relative}`);
    }
  }
  await mkdir(snapshot, { recursive: true });
  await visit(sourceRoot, snapshot);
  await mkdir(path.join(snapshot, 'apps/web/public'), { recursive: true });
}

async function makeBuildSnapshot(sourceRoot, nodePath, tempRoot) {
  const snapshot = path.join(tempRoot, 'source snapshot');
  await createSanitizedSourceSnapshot(sourceRoot, snapshot);
  const npmCli = npmCliPathFor(nodePath);
  const nodeRoot = nodeRootFor(nodePath, process.platform);
  await requiredFile(nodeRoot, path.relative(nodeRoot, npmCli).split(path.sep).join('/'), 'bundled npm CLI', nodeRoot);
  const pathEnv = `${path.join(snapshot, 'node_modules', '.bin')}${path.delimiter}${path.join(path.dirname(nodePath))}${path.delimiter}${process.env.PATH ?? ''}`;
  const baseEnv = { ...process.env, PATH: pathEnv, CI: '1', npm_config_fund: 'false', npm_config_audit: 'false' };
  await run(nodePath, [npmCli, 'ci', '--no-audit', '--no-fund'], snapshot, baseEnv);
  await run(nodePath, [npmCli, 'run', 'typecheck'], snapshot, baseEnv);
  for (const workspace of ['apps/hub', 'apps/cli', 'apps/local']) await run(nodePath, [npmCli, 'run', 'build', '--workspace', workspace], snapshot, baseEnv);
  const webEnv = { ...baseEnv, NEMA_MANAGED_LOCAL_BUILD: '1', NEXT_PUBLIC_NEMA_LOCAL: '1' };
  await run(nodePath, [npmCli, 'run', 'build', '--workspace', 'apps/web'], snapshot, webEnv);
  // Replace development dependencies with the lockfile's production closure before payload copying.
  await run(nodePath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], snapshot, baseEnv);
  return snapshot;
}

function targetMatches(platform, arch) {
  return process.platform === platform && process.arch === arch;
}

/**
 * Build and stage the self-contained managed runtime payload.
 * Fixture tests may pass build:false; production calls must use build:true and a tool cache.
 */
/**
 * Top-level names under `<root>/node_modules` that the runtime packages reach through their declared
 * dependencies. Web dependencies (Next and its SWC binaries) ship in Next's standalone trace instead.
 * A missing required dependency fails closed; a missing optional or peer dependency is skipped.
 */
export async function runtimeDependencyClosure(root, packageDirs) {
  const rootModules = path.join(root, 'node_modules');
  const readPackage = async (dir) => JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const resolveFrom = async (dir, name) => {
    for (let current = dir; isInside(root, current); current = path.dirname(current)) {
      const candidate = path.join(current, 'node_modules', ...name.split('/'));
      if ((await stat(candidate).catch(() => null))?.isDirectory()) return candidate;
      if (current === root) break;
    }
    return null;
  };
  const included = new Set();
  const visited = new Set();
  const queue = [...packageDirs];
  while (queue.length) {
    const dir = queue.shift();
    if (visited.has(dir)) continue;
    visited.add(dir);
    const manifest = await readPackage(dir);
    const wanted = [
      ...Object.keys(manifest.dependencies ?? {}).map((name) => [name, true]),
      ...Object.keys(manifest.optionalDependencies ?? {}).map((name) => [name, false]),
      ...Object.keys(manifest.peerDependencies ?? {}).map((name) => [name, false]),
    ];
    for (const [name, required] of wanted) {
      if (name.startsWith('@nema/')) continue;
      const resolved = await resolveFrom(dir, name);
      if (!resolved) {
        if (required) throw new Error(`Runtime dependency ${name} of ${manifest.name ?? dir} is missing from the production install`);
        continue;
      }
      const parts = path.relative(rootModules, resolved).split(path.sep);
      // Nested installs ship inside their top-level package; only top-level names are copied.
      included.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
      queue.push(resolved);
    }
  }
  return included;
}

export function recordedCommit(sourceRoot, explicit) {
  if (explicit !== undefined) return /^[0-9a-f]{40}$/i.test(explicit) ? explicit.toLowerCase() : undefined;
  const top = spawnSync('git', ['-C', sourceRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (top.status !== 0) return undefined;
  let topLevel = path.resolve(top.stdout.trim());
  let root = path.resolve(sourceRoot);
  try { topLevel = realpathSync(topLevel); root = realpathSync(root); } catch { /* compare the resolved paths */ }
  if (topLevel !== root) return undefined;
  const head = spawnSync('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (head.status !== 0) return undefined;
  const commit = head.stdout.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
}

export async function stageRuntime({
  sourceRoot = defaultRoot,
  outputDir = path.join(defaultRoot, 'dist/desktop'),
  toolsRoot,
  toolCache = cacheDefault,
  platform = process.platform,
  arch = process.arch,
  version,
  commit,
  tools,
  build = true,
  electronNode,
  ownedHelperBuilder = buildOwnedHelper,
  fetchGraphify = fetchGraphifyRuntime,
} = {}) {
  sourceRoot = path.resolve(sourceRoot);
  outputDir = path.resolve(outputDir);
  if (!targetMatches(platform, arch)) throw new Error(`Refusing non-native runtime target ${platform}-${arch}; current platform is ${process.platform}-${process.arch}`);
  const localPackage = JSON.parse(await readFile(path.join(sourceRoot, 'apps/local/package.json'), 'utf8'));
  version ??= localPackage.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('A valid explicit application version is required');
  const localVersion = localPackage.version;
  if (version !== localVersion) throw new Error(`Requested version ${version} does not match apps/local/package.json ${localVersion}`);
  await ensureElectronBinary(sourceRoot);
  const runtimeNode = electronNode
    ? runtimeNodeRecord({ electronVersion: electronNode.electronVersion, nodeVersion: electronNode.nodeVersion, engines: electronNode.engines })
    : await readElectronNodeVersion(sourceRoot);
  const electronMitLicense = await requiredFile(sourceRoot, 'node_modules/electron/dist/LICENSE', 'Electron MIT license', sourceRoot);
  const electronThirdPartyNotices = await requiredFile(sourceRoot, 'node_modules/electron/dist/LICENSES.chromium.html', 'Electron Chromium notices', sourceRoot);
  const final = path.join(outputDir, `${platform}-${arch}`);
  if (await lstat(final).catch(() => null)) throw new Error(`Output target already exists; refusing to replace it: ${final}`);
  let tempRoot;
  let builtRoot = sourceRoot;
  try {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nema-desktop-stage-'));
    if (!toolsRoot) {
      const fetchedDir = path.join(tempRoot, 'tools');
      tools = await fetchTools({ platform, arch, cacheDir: toolCache, outDir: fetchedDir });
      toolsRoot = fetchedDir;
    }
    toolsRoot = path.resolve(toolsRoot);
    const target = `${platform}-${arch}`;
    const selectedToolsRoot = path.join(toolsRoot, target);
    if (!tools || !tools.node || !tools.licenses) throw new Error('fetchTools result must include Node and license paths');
    const checkedTargetFile = async (value, name) => {
      if (value === null || value === undefined) throw new Error(`Missing required ${name} path`);
      const parts = safeRelative(value, name);
      if (parts[0] !== target || parts.length < 2) throw new Error(`${name} path must be inside selected target ${target}`);
      return requiredFile(selectedToolsRoot, parts.slice(1).join('/'), name, selectedToolsRoot);
    };
    const nodePath = await checkedTargetFile(tools.node, 'bundled Node executable');
    await checkedTargetFile(tools.licenses.node, 'Node license');
    await checkedTargetFile(tools.licenses.sourceRecord, 'tool source record');
    const toolsRecord = JSON.parse(await readFile(await checkedTargetFile(tools.licenses.sourceRecord, 'tool source record'), 'utf8'));
    const expectedNodePin = toolsManifest.node.archive?.[target];
    if (!expectedNodePin || toolsRecord.target !== target ||
      toolsRecord.node?.version !== toolsManifest.node.version || toolsRecord.node?.archive !== expectedNodePin.file || toolsRecord.node?.sha256 !== expectedNodePin.sha256 ||
      !['pending-task-7c', 'source-materials-collected'].includes(toolsRecord.sourceCorrespondence?.status)) throw new Error('Bundled tools target, pinned archive hashes, versions, or Task 7c provenance status are invalid');
    if (build) builtRoot = await makeBuildSnapshot(sourceRoot, nodePath, tempRoot);
    let ownedHelperPath;
    if (platform === 'win32') {
      ownedHelperPath = build
        ? await ownedHelperBuilder({ output: path.join(tempRoot, 'owned-helper.exe'), sourceRoot: builtRoot })
        : await checkedTargetFile(tools.ownedHelperGuardian, 'Windows helper guardian executable');
    }

    const webRoot = path.join(builtRoot, 'apps/web');
    const standalone = path.join(webRoot, '.next/standalone');
    const staticDir = path.join(webRoot, '.next/static');
    const publicDir = path.join(webRoot, 'public');
    await requireDirectory(standalone, 'Next standalone output', builtRoot);
    await requireDirectory(staticDir, 'Next static assets', builtRoot);
    await requireDirectory(publicDir, 'Next public assets/fonts', builtRoot);
    await requiredFile(standalone, 'apps/web/server.js', 'standalone Next server', builtRoot);
    await requireDirectory(path.join(builtRoot, 'apps/local/dist/src'), 'compiled local core', builtRoot);
    await requireDirectory(path.join(builtRoot, 'apps/hub/dist/src'), 'compiled hub', builtRoot);
    await requireDirectory(path.join(builtRoot, 'apps/cli/dist'), 'compiled CLI', builtRoot);
    await requireDirectory(path.join(builtRoot, 'packages/shared/dist'), 'compiled shared package', builtRoot);
    await requireDirectory(path.join(builtRoot, 'packages/knowledge/dist'), 'compiled knowledge package', builtRoot);
    await requireDirectory(path.join(builtRoot, 'apps/hub/dist/src/db/migrations'), 'compiled hub migrations', builtRoot);
    await requiredFile(builtRoot, 'apps/local/dist/src/index.js', 'compiled core entry');
    await requiredFile(builtRoot, 'apps/cli/dist/index.js', 'compiled CLI entry');
    await requiredFile(builtRoot, 'apps/cli/src/report/SKILL.md', 'report SKILL.md');
    await requiredFile(builtRoot, 'LICENSE', 'application license');
    for (const file of REQUIRED_VENDOR) await requiredFile(builtRoot, file, file.includes('LICENSE') || file.includes('NOTICE') ? 'vendor license or notice' : 'vendor runtime resource');
    const pgliteRoot = path.join(builtRoot, 'node_modules/@electric-sql/pglite');
    await requiredFile(pgliteRoot, 'dist/pglite.wasm', 'PGlite WASM', builtRoot);
    await requiredFile(pgliteRoot, 'dist/initdb.wasm', 'PGlite initdb WASM', builtRoot);
    await requiredFile(pgliteRoot, 'dist/pglite.data', 'PGlite data', builtRoot);

    await mkdir(outputDir, { recursive: true });
    if (await lstat(final).catch(() => null)) throw new Error(`Output target already exists; refusing to replace it: ${final}`);
    const staging = path.join(tempRoot, 'payload');
    const put = (relative) => path.join(staging, ...safeRelative(relative, 'payload').slice(0));
    await mkdir(staging, { recursive: true });
    const graphifyDir = await fetchGraphify({ platform, arch, destination: put('tools/graphify'), cacheDir: path.join(toolCache, 'graphify'), sourceRoot });
    if (graphifyDir) {
      await requiredFile(staging, platform === 'win32' ? 'tools/graphify/graphify.exe' : 'tools/graphify/graphify', 'packaged Graphify launcher', staging);
      await copyTree(path.join(graphifyDir, 'licenses'), put('runtime/licenses/graphify-runtime'), staging);
    }
    await copyTree(selectedToolsRoot, put(`runtime/${target}`), selectedToolsRoot, new Set(), {
      // The Node binary is Electron's. Keep the license and the tools-source pin; do not ship a second node/.
      skip: (relative) => nodePayloadExcluded(relative) || relative === 'node' || relative.startsWith('node/'),
      skipRoot: selectedToolsRoot,
    });
    const stagedToolsRecord = put(`runtime/${target}/tools-source.json`);
    const toolsSource = JSON.parse(await readFile(stagedToolsRecord, 'utf8'));
    toolsSource.node = { ...toolsSource.node, shipped: false, role: 'build-time npm ci; not copied into the payload' };
    toolsSource.runtimeNode = runtimeNode;
    await writeFile(stagedToolsRecord, `${JSON.stringify(toolsSource, null, 2)}\n`);
    if (ownedHelperPath) await copyTree(ownedHelperPath, put('runtime/owned-helper.exe'), path.dirname(ownedHelperPath));
    await copyTree(standalone, put('web'), builtRoot);
    await copyTree(staticDir, put('web/apps/web/.next/static'), builtRoot);
    await copyTree(publicDir, put('web/apps/web/public'), builtRoot);
    for (const [packagePath, distPath] of [
      ['apps/local', 'apps/local/dist'], ['apps/hub', 'apps/hub/dist'], ['apps/cli', 'apps/cli/dist'],
      ['packages/shared', 'packages/shared/dist'], ['packages/knowledge', 'packages/knowledge/dist'],
    ]) {
      const destination = `app/node_modules/@nema/${path.basename(packagePath)}`;
      await copyTree(path.join(builtRoot, packagePath, 'package.json'), put(`${destination}/package.json`), builtRoot);
      await copyCompiledDist(path.join(builtRoot, distPath), put(`${destination}/dist`), builtRoot);
    }
    await copyTree(path.join(builtRoot, 'apps/cli/src/report/SKILL.md'), put('app/node_modules/@nema/cli/src/report/SKILL.md'), builtRoot);
    await copyTree(path.join(builtRoot, 'vendor/archify'), put('vendor/archify'), builtRoot);
    await copyTree(path.join(builtRoot, 'vendor/superpowers-rules'), put('vendor/superpowers-rules'), builtRoot);
    // Next's standalone trace supplies Web dependencies under web/. The core gets only what the runtime
    // packages declare; the whole production install also carried Next and its SWC binary (~310MB).
    const rootModules = path.join(builtRoot, 'node_modules');
    await requireDirectory(rootModules, 'production node_modules', builtRoot);
    const runtimeDirs = ['apps/local', 'apps/hub', 'apps/cli', 'packages/shared', 'packages/knowledge'].map((dir) => path.join(builtRoot, dir));
    for (const name of [...await runtimeDependencyClosure(builtRoot, runtimeDirs)].sort()) {
      await copyTree(path.join(rootModules, ...name.split('/')), put(`app/node_modules/${name}`), builtRoot);
    }
    const commitId = recordedCommit(sourceRoot, commit);
    const manifest = {
      schemaVersion: 1, version, platform, arch,
      ...(commitId ? { commit: commitId } : {}),
      ...(ownedHelperPath ? { ownedHelperGuardian: 'runtime/owned-helper.exe' } : {}),
      coreEntry: 'app/node_modules/@nema/local/dist/src/index.js',
      cliEntry: 'app/node_modules/@nema/cli/dist/index.js',
      webEntry: 'web/apps/web/managed-parent.mjs',
      licenses: 'runtime/licenses',
    };
    // Provide a single manifest license directory while retaining the complete distributions and notices.
    await mkdir(put('runtime/licenses'), { recursive: true });
    await copyTree(path.join(builtRoot, 'LICENSE'), put('runtime/licenses/application'), builtRoot);
    await copyTree(path.join(selectedToolsRoot, ...safeRelative(tools.licenses.node, 'Node license').slice(1)), put('runtime/licenses/node'), selectedToolsRoot);
    await copyTree(electronMitLicense, put('runtime/licenses/electron/LICENSE'), sourceRoot);
    await copyTree(electronThirdPartyNotices, put('runtime/licenses/electron/LICENSES.chromium.html'), sourceRoot);
    await writeFile(put('runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await writePlatformLaunchers(staging, manifest);
    for (const [entry, name, directory] of [
      [manifest.coreEntry, 'core entry', false], [manifest.cliEntry, 'CLI entry', false],
      [manifest.webEntry, 'Web entry', false], [manifest.licenses, 'license directory', true],
      ...(manifest.ownedHelperGuardian ? [[manifest.ownedHelperGuardian, 'Windows helper guardian executable', false]] : []),
    ]) {
      if (directory) await requireDirectory(path.join(staging, ...safeRelative(entry, name)), name, staging);
      else await requiredFile(staging, entry, name, staging);
    }
    const copyCheck = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.name.startsWith('._') || entry.name === '.DS_Store' || /^\.env(?:\..*)?$/.test(entry.name) || entry.name === '.git') throw new Error(`Payload contains excluded source metadata: ${absolute}`);
        if (entry.isSymbolicLink()) throw new Error(`Payload contains a symbolic link: ${absolute}`);
        if (entry.isDirectory()) await copyCheck(absolute);
      }
    };
    await pruneStagedPayload(staging);
    await copyCheck(staging);
    const owner = randomUUID();
    let claimed = false;
    let identity;
    try {
      await mkdir(final);
      claimed = true;
      identity = await lstat(final);
      if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error(`Output reservation is not a real directory: ${final}`);
      const marker = path.join(final, '.stage-owner');
      await writeFile(marker, owner, { flag: 'wx' });
      const ownsReservation = async () => {
        const current = await lstat(final).catch(() => null);
        const mark = await lstat(marker).catch(() => null);
        if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino || !mark?.isFile() || mark.isSymbolicLink()) return false;
        return (await readFile(marker, 'utf8').catch(() => '')) === owner;
      };
      for (const entry of await readdir(staging)) {
        if (!await ownsReservation()) throw new Error(`Output ownership changed during staging: ${final}`);
        await cp(path.join(staging, entry), path.join(final, entry), { recursive: true, errorOnExist: true, force: false });
      }
      if (!await ownsReservation()) throw new Error(`Output ownership changed during staging: ${final}`);
      await rm(marker);
    } catch (error) {
      if (claimed) {
        const marker = path.join(final, '.stage-owner');
        const current = await lstat(final).catch(() => null);
        const mark = await lstat(marker).catch(() => null);
        const contents = await readFile(marker, 'utf8').catch(() => '');
        if (identity && current?.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino && mark?.isFile() && !mark.isSymbolicLink() && contents === owner) {
          await rm(final, { recursive: true, force: true });
        }
      }
      throw error;
    }
    await reportPayload(final);
    return { directory: final, manifest: path.join(final, 'runtime-manifest.json') };
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed;
  try { parsed = parseStageArgs(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
  if (process.exitCode !== 2) {
    const root = path.resolve(parsed.sourceRoot ?? defaultRoot);
    const out = path.resolve(parsed.outputDir ?? path.join(root, 'dist/desktop'));
    const local = JSON.parse(await readFile(path.join(root, 'apps/local/package.json'), 'utf8'));
    stageRuntime({ ...parsed, sourceRoot: root, outputDir: out, version: local.version }).then((result) => {
    process.stdout.write(`Staged ${result.directory}\n`);
    }).catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
  }
}
