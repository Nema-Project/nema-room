// First-run database seed for the desktop payload (#265). It runs the shipped hub's `createLocalDb` against an
// empty directory, checks that the applied migrations are exactly the shipped migration files, and packs the
// cleanly closed PGlite directory into one ustar + gzip archive. The archive holds schema only: migrations write
// no user data. The runtime lands it at `<home>/db` only when that directory does not exist yet.
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { constants as zlib, gzipSync } from 'node:zlib';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '../..');

/** Spec D-6: at most 10 MiB per target. The generator refuses a larger archive; payload-size checks it again. */
export const PRESET_DB_MAX_BYTES = 10 * 1048576;
/** Payload-relative location of the seed archive, written to the runtime manifest as `presetDb`. */
export const PRESET_DB_PAYLOAD_PATH = 'preset/preset-db.tar.gz';

/** The migration names `migrate` (apps/hub/src/db/db.ts) would apply from `dir`, with the same filter. */
export async function migrationFileSet(dir) {
  return new Set((await readdir(dir)).filter((name) => name.endsWith('.sql') && !name.startsWith('._')));
}

/** Throws unless the seed's schema_migrations names equal the shipped migration file names. */
export function assertMigrationSet(applied, shipped) {
  const appliedSet = new Set(applied);
  const shippedSet = new Set(shipped);
  const missing = [...shippedSet].filter((name) => !appliedSet.has(name)).sort();
  const extra = [...appliedSet].filter((name) => !shippedSet.has(name)).sort();
  if (missing.length || extra.length) {
    throw new Error(`Preset database schema_migrations does not equal the shipped migrations (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
}

function writeOctal(header, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, '0');
  if (text.length > length - 1) throw new Error(`TAR field overflow at offset ${offset}`);
  header.write(`${text}\0`, offset, length, 'ascii');
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  // ustar keeps up to 155 bytes of leading directories in `prefix`; no pax headers, which the extractor refuses.
  for (let cut = name.indexOf('/'); cut !== -1; cut = name.indexOf('/', cut + 1)) {
    const prefix = name.slice(0, cut);
    const rest = name.slice(cut + 1);
    if (rest && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw new Error(`Preset database path is too long for a ustar header: ${name}`);
}

function tarHeader(name, { type, mode, size }) {
  const header = Buffer.alloc(512);
  const parts = splitName(name);
  header.write(parts.name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  // A fixed mtime keeps the archive reproducible for one set of database files; PGlite does not read it.
  writeOctal(header, 136, 12, 0);
  header.write(type, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(parts.prefix, 345, 155, 'utf8');
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/**
 * Packs a directory of regular files and directories into a gzip-compressed ustar archive with sorted, relative
 * names. Symbolic links and other file types are refused: a seed contains neither.
 */
export async function tarGzDirectory(root) {
  const chunks = [];
  async function walk(dir, relative) {
    for (const name of (await readdir(dir)).sort()) {
      const absolute = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Preset database contains a symbolic link: ${rel}`);
      if (info.isDirectory()) {
        chunks.push(tarHeader(`${rel}/`, { type: '5', mode: 0o700, size: 0 }));
        await walk(absolute, rel);
      } else if (info.isFile()) {
        const body = await readFile(absolute);
        chunks.push(tarHeader(rel, { type: '0', mode: 0o600, size: body.length }), body);
        const pad = (512 - (body.length % 512)) % 512;
        if (pad) chunks.push(Buffer.alloc(pad));
      } else {
        throw new Error(`Preset database contains an unsupported file type: ${rel}`);
      }
    }
  }
  await walk(root, '');
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: zlib.Z_BEST_COMPRESSION });
}

/**
 * Builds the seed with the hub at `hubRoot` (its compiled `dist/src/db/pglite.js` and the migrations beside it)
 * and writes the archive to `output`. `migrationsDir` is the shipped migration set the seed must equal; it
 * defaults to the hub's own. `workDir`, when given, is where the database is built and is left for the caller.
 */
export async function makePresetDb({
  hubRoot = path.join(defaultRoot, 'apps/hub'),
  output,
  pgliteModule = path.join(hubRoot, 'dist/src/db/pglite.js'),
  migrationsDir = path.join(hubRoot, 'dist/src/db/migrations'),
  maxBytes = PRESET_DB_MAX_BYTES,
  workDir,
  stdout = process.stdout,
} = {}) {
  if (!output) throw new Error('makePresetDb requires an output path');
  const shipped = await migrationFileSet(migrationsDir);
  if (shipped.size === 0) throw new Error(`No shipped migrations in ${migrationsDir}`);
  const ownTemp = workDir ? undefined : await mkdtemp(path.join(os.tmpdir(), 'nema-preset-db-'));
  try {
    const dataDir = workDir ?? path.join(ownTemp, 'db');
    if (await lstat(dataDir).catch(() => null)) throw new Error(`Preset database work directory already exists: ${dataDir}`);
    const { createLocalDb } = await import(pathToFileURL(pgliteModule).href);
    const db = await createLocalDb(dataDir);
    let applied;
    try {
      applied = (await db.query('select name from schema_migrations')).map((row) => row.name);
    } finally {
      await db.close();
    }
    assertMigrationSet(applied, shipped);
    const archive = await tarGzDirectory(dataDir);
    if (archive.length > maxBytes) {
      throw new Error(`Preset database archive is ${archive.length} bytes (${(archive.length / 1048576).toFixed(1)} MiB); the limit is ${(maxBytes / 1048576).toFixed(1)} MiB`);
    }
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, archive, { flag: 'wx' });
    stdout.write(`preset-db: ${archive.length} bytes, ${applied.length} migrations\n`);
    return { bytes: archive.length, migrations: applied.length, dataDir };
  } finally {
    if (ownTemp) await rm(ownTemp, { recursive: true, force: true });
  }
}

export function parsePresetArgs(args) {
  const options = new Map([['--out', 'output'], ['--hub-root', 'hubRoot']]);
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = options.get(args[index]);
    const value = args[index + 1];
    if (!key) throw new Error(`Unknown option: ${args[index]}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`Option ${args[index]} requires a value`);
    result[key] = path.resolve(value);
  }
  if (!result.output) throw new Error('Usage: make-preset-db.mjs --out <archive> [--hub-root <apps/hub>]');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await makePresetDb(parsePresetArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
