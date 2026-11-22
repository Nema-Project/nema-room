// Needs the compiled hub (`npm run build -w apps/hub`, which also copies the migrations) and the compiled CLI
// archive module (`npm run typecheck` or `npm run build -w apps/cli`).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertMigrationSet, makePresetDb, migrationFileSet, PRESET_DB_MAX_BYTES, tarGzDirectory } from './make-preset-db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hubRoot = path.join(root, 'apps/hub');
const shippedMigrations = path.join(hubRoot, 'dist/src/db/migrations');
const script = fileURLToPath(new URL('./make-preset-db.mjs', import.meta.url));

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nema-preset-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const quiet = { write() {} };

test('the migration set assertion passes only for equal sets and names both differences', () => {
  assertMigrationSet(['001_a.sql', '002_b.sql'], new Set(['002_b.sql', '001_a.sql']));
  assert.throws(() => assertMigrationSet(['001_a.sql'], ['001_a.sql', '002_b.sql']), /missing: 002_b\.sql; extra: none/);
  assert.throws(() => assertMigrationSet(['001_a.sql', '003_c.sql'], ['001_a.sql']), /missing: none; extra: 003_c\.sql/);
});

test('the shipped migration set uses the same filter as migrate', async (t) => {
  const dir = await temp(t);
  for (const name of ['001_a.sql', '._001_a.sql', 'README.md']) await writeFile(path.join(dir, name), '');
  assert.deepEqual([...await migrationFileSet(dir)], ['001_a.sql']);
});

test('a generated seed lands, opens with createLocalDb, and leaves no migration pending', async (t) => {
  const dir = await temp(t);
  const output = path.join(dir, 'out', 'preset-db.tar.gz');
  const result = await makePresetDb({ hubRoot, output, stdout: quiet });
  const shipped = await migrationFileSet(shippedMigrations);
  assert.equal(result.migrations, shipped.size);
  assert.equal((await lstat(output)).size, result.bytes);
  assert.ok(result.bytes > 0 && result.bytes <= PRESET_DB_MAX_BYTES);

  const { extractTarGz } = await import(pathToFileURL(path.join(root, 'apps/cli/dist/components/archive.js')).href);
  const landed = path.join(dir, 'home', 'db');
  await extractTarGz(await readFile(output), landed);
  assert.ok((await lstat(path.join(landed, 'PG_VERSION'))).isFile());

  const { createLocalDb } = await import(pathToFileURL(path.join(hubRoot, 'dist/src/db/pglite.js')).href);
  // migrate stamps applied_at with now(); a row at or after this instant would mean a migration ran on open.
  const openedAt = new Date();
  const db = await createLocalDb(landed);
  try {
    const rows = await db.query('select name, applied_at from schema_migrations');
    assert.deepEqual(rows.map((row) => row.name).sort(), [...shipped].sort());
    for (const row of rows) assert.ok(new Date(row.applied_at) < openedAt, `${row.name} was applied when the seed was opened`);
  } finally {
    await db.close();
  }
});

test('the generator fails and writes nothing when the seed and the shipped migrations differ', async (t) => {
  const dir = await temp(t);
  const migrationsDir = path.join(dir, 'migrations');
  await cp(shippedMigrations, migrationsDir, { recursive: true });
  await writeFile(path.join(migrationsDir, '999_not_in_seed.sql'), 'select 1;');
  const output = path.join(dir, 'preset-db.tar.gz');
  await assert.rejects(makePresetDb({ hubRoot, output, migrationsDir, stdout: quiet }), /does not equal the shipped migrations \(missing: 999_not_in_seed\.sql; extra: none\)/);
  assert.equal(await lstat(output).catch(() => null), null);
});

test('the generator refuses an archive over the size limit and writes nothing', async (t) => {
  const dir = await temp(t);
  const output = path.join(dir, 'preset-db.tar.gz');
  await assert.rejects(makePresetDb({ hubRoot, output, maxBytes: 1024, stdout: quiet }), /the limit is 0\.0 MiB/);
  assert.equal(await lstat(output).catch(() => null), null);
});

test('the command exits non-zero when the generator fails', async (t) => {
  const dir = await temp(t);
  const fakeHub = path.join(dir, 'hub');
  await mkdir(path.join(fakeHub, 'dist/src/db/migrations'), { recursive: true });
  const run = spawnSync(process.execPath, [script, '--out', path.join(dir, 'x.tar.gz'), '--hub-root', fakeHub], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /No shipped migrations/);
  assert.notEqual(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 0);
});

test('the packer refuses a symbolic link', { skip: process.platform === 'win32' && 'symlinks need privileges on Windows' }, async (t) => {
  const dir = await temp(t);
  await writeFile(path.join(dir, 'file'), 'x');
  await symlink('file', path.join(dir, 'link'));
  await assert.rejects(tarGzDirectory(dir), /symbolic link: link/);
});
