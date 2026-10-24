import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTools, toolsManifest } from './fetch-tools.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '../..');
const cacheDefault = path.join(defaultRoot, '.superpowers/sdd/2026-10-24-desktop-implementation/tool-cache');
const REQUIRED_VENDOR = ['vendor/archify/LICENSE', 'vendor/archify/THIRD_PARTY_NOTICES.md', 'vendor/archify/bin/archify.mjs', 'vendor/superpowers-rules/LICENSE', 'vendor/superpowers-rules/spec-rules.md', 'vendor/superpowers-rules/plan-rules.md'];

const isInside = (root, value) => {
  const rel = path.relative(root, value);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

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

async function copyTree(source, destination, allowedRoot, seen = new Set()) {
  const info = await lstat(source).catch(() => null);
  if (!info) throw new Error(`Required staged resource is missing: ${source}`);
  if (info.isSymbolicLink()) {
    const resolved = await realpath(source);
    if (!isInside(allowedRoot, resolved)) throw new Error(`Dependency or resource escapes payload source: ${source}`);
    if (seen.has(resolved)) throw new Error(`Cyclic resource link: ${source}`);
    return copyTree(resolved, destination, allowedRoot, new Set([...seen, resolved]));
  }
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      if (entry.startsWith('._') || entry === '.DS_Store') continue;
      await copyTree(path.join(source, entry), path.join(destination, entry), allowedRoot, seen);
    }
    return;
  }
  if (!info.isFile()) throw new Error(`Unsupported resource type: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { errorOnExist: true, force: false, preserveTimestamps: false });
  if (process.platform !== 'win32') await chmod(destination, info.mode & 0o777);
}

async function copyCompiledDist(source, destination, allowedRoot) {
  async function visit(from, to, relative = '', seen = new Set()) {
    const info = await lstat(from);
    let resolved = from;
    let actual = info;
    if (info.isSymbolicLink()) {
      resolved = await realpath(from);
      if (!isInside(allowedRoot, resolved)) throw new Error(`Dependency or resource escapes payload source: ${from}`);
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

export async function writePlatformLaunchers(payloadRoot, manifest) {
  const launcherName = manifest.platform === 'win32' ? 'Nema Browser.cmd' : manifest.platform === 'darwin' ? 'Nema Browser.command' : 'nema-browser';
  const launcherTemplate = path.join(scriptDir, 'templates', launcherName);
  const launcher = (await readFile(launcherTemplate, 'utf8')).replaceAll('{{NODE_PATH}}', manifest.node.replaceAll('/', path.sep));
  const launcherPath = path.join(payloadRoot, launcherName);
  await writeFile(launcherPath, launcher, { mode: manifest.platform === 'win32' ? 0o644 : 0o755 });
  if (manifest.platform !== 'win32') await chmod(launcherPath, 0o755);
  const webParentPath = path.join(payloadRoot, 'web', 'apps', 'web', 'managed-parent.mjs');
  await cp(path.join(scriptDir, 'templates/web-parent.mjs'), webParentPath);
  return { launcherPath, webParentPath };
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
export async function stageRuntime({
  sourceRoot = defaultRoot,
  outputDir = path.join(defaultRoot, 'dist/desktop'),
  toolsRoot,
  toolCache = cacheDefault,
  platform = process.platform,
  arch = process.arch,
  version,
  tools,
  build = true,
} = {}) {
  sourceRoot = path.resolve(sourceRoot);
  outputDir = path.resolve(outputDir);
  if (!targetMatches(platform, arch)) throw new Error(`Refusing non-native runtime target ${platform}-${arch}; current platform is ${process.platform}-${process.arch}`);
  const localPackage = JSON.parse(await readFile(path.join(sourceRoot, 'apps/local/package.json'), 'utf8'));
  version ??= localPackage.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('A valid explicit application version is required');
  const localVersion = localPackage.version;
  if (version !== localVersion) throw new Error(`Requested version ${version} does not match apps/local/package.json ${localVersion}`);
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
    if (!tools || !tools.node || !tools.git || !tools.licenses) throw new Error('fetchTools result must include Node, Git, and license paths');
    const checkedTargetFile = async (value, name) => {
      if (value === null || value === undefined) throw new Error(`Missing required ${name} path`);
      const parts = safeRelative(value, name);
      if (parts[0] !== target || parts.length < 2) throw new Error(`${name} path must be inside selected target ${target}`);
      return requiredFile(selectedToolsRoot, parts.slice(1).join('/'), name, selectedToolsRoot);
    };
    const checkedTargetDirectory = async (value, name) => {
      if (value === null || value === undefined) return null;
      const parts = safeRelative(value, name);
      if (parts[0] !== target || parts.length < 2) throw new Error(`${name} path must be inside selected target ${target}`);
      const relative = parts.slice(1).join('/');
      await requireDirectory(path.join(selectedToolsRoot, ...safeRelative(relative, name)), name, selectedToolsRoot);
      return true;
    };
    const nodePath = await checkedTargetFile(tools.node, 'bundled Node executable');
    await checkedTargetFile(tools.git, 'bundled Git executable');
    await checkedTargetFile(tools.licenses.node, 'Node license');
    await checkedTargetFile(tools.licenses.git, 'Git license');
    await checkedTargetFile(tools.licenses.gitNotice, 'Git notice');
    await checkedTargetFile(tools.licenses.sourceRecord, 'tool source record');
    await checkedTargetDirectory(tools.licenses.gitTree, 'Git distribution');
    await checkedTargetDirectory(tools.licenses.gitNotices, 'Git notices');
    const toolsRecord = JSON.parse(await readFile(await checkedTargetFile(tools.licenses.sourceRecord, 'tool source record'), 'utf8'));
    const expectedNodePin = toolsManifest.node.archive?.[target];
    const expectedGitPin = toolsManifest.git.archives?.[target];
    if (!expectedNodePin || !expectedGitPin || toolsRecord.target !== target ||
      toolsRecord.node?.version !== toolsManifest.node.version || toolsRecord.node?.archive !== expectedNodePin.file || toolsRecord.node?.sha256 !== expectedNodePin.sha256 ||
      toolsRecord.git?.version !== toolsManifest.git.version || toolsRecord.git?.gitForWindowsVersion !== toolsManifest.git.gitForWindowsVersion || toolsRecord.git?.dugiteNativeVersion !== toolsManifest.git.dugiteNativeVersion || toolsRecord.git?.archive !== expectedGitPin.file || toolsRecord.git?.sha256 !== expectedGitPin.sha256 ||
      !['pending-task-7c', 'source-materials-collected'].includes(toolsRecord.sourceCorrespondence?.status)) throw new Error('Bundled tools target, pinned archive hashes, versions, or Task 7c provenance status are invalid');
    if (build) builtRoot = await makeBuildSnapshot(sourceRoot, nodePath, tempRoot);

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
    await copyTree(selectedToolsRoot, put(`runtime/${target}`), selectedToolsRoot);
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
    // Next's standalone trace supplies Web dependencies. The build snapshot has been
    // reinstalled with --omit=dev, so this copy contains the lockfile's full production closure.
    const rootModules = path.join(builtRoot, 'node_modules');
    await requireDirectory(rootModules, 'production node_modules', builtRoot);
    for (const name of await readdir(rootModules)) {
      if (name === '.bin' || name === '@nema') continue;
      await copyTree(path.join(rootModules, name), put(`app/node_modules/${name}`), builtRoot);
    }
    const manifest = {
      schemaVersion: 1, version, platform, arch,
      node: `runtime/${tools.node}`, git: `runtime/${tools.git}`,
      coreEntry: 'app/node_modules/@nema/local/dist/src/index.js',
      cliEntry: 'app/node_modules/@nema/cli/dist/index.js',
      webEntry: 'web/apps/web/managed-parent.mjs',
      licenses: 'runtime/licenses',
    };
    // Provide a single manifest license directory while retaining the complete distributions and notices.
    await mkdir(put('runtime/licenses'), { recursive: true });
    await copyTree(path.join(builtRoot, 'LICENSE'), put('runtime/licenses/application'), builtRoot);
    await copyTree(path.join(selectedToolsRoot, ...safeRelative(tools.licenses.node, 'Node license').slice(1)), put('runtime/licenses/node'), selectedToolsRoot);
    await copyTree(path.join(selectedToolsRoot, ...safeRelative(tools.licenses.git, 'Git license').slice(1)), put('runtime/licenses/git'), selectedToolsRoot);
    await writeFile(put('runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await writePlatformLaunchers(staging, manifest);
    for (const [entry, name, directory] of [
      [manifest.node, 'Node executable', false], [manifest.git, 'Git executable', false],
      [manifest.coreEntry, 'core entry', false], [manifest.cliEntry, 'CLI entry', false],
      [manifest.webEntry, 'Web entry', false], [manifest.licenses, 'license directory', true],
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
