import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { assertInstallerOmitsPortableZip, assertPortableAppZip, fileContains } from './portable-zip.mjs';

function storeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? '');
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.data ? 0 : 0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function zip64(entries) {
  const stored = storeZip(entries);
  const eocdOffset = stored.length - 22;
  const centralOffset = stored.readUInt32LE(eocdOffset + 16);
  const centralSize = stored.readUInt32LE(eocdOffset + 12);
  const body = stored.subarray(0, eocdOffset);
  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(0x06064b50, 0);
  zip64Eocd.writeBigUInt64LE(44n, 4);
  zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 24);
  zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 32);
  zip64Eocd.writeBigUInt64LE(BigInt(centralSize), 40);
  zip64Eocd.writeBigUInt64LE(BigInt(centralOffset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(body.length), 8);
  locator.writeUInt32LE(1, 16);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([body, zip64Eocd, locator, eocd]);
}

const appEntries = [
  { name: 'Nema.exe', data: 'app' },
  { name: 'resources/app.asar', data: 'asar' },
];

async function fixture(t, bytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nema-portable-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'artifact.bin');
  await writeFile(file, bytes);
  return file;
}

test('a portable ZIP is the unpacked app and nothing bundled beside it', async (t) => {
  await assertPortableAppZip(await fixture(t, storeZip(appEntries)));
  await assertPortableAppZip(await fixture(t, zip64(appEntries)));
  await assert.rejects(assertPortableAppZip(await fixture(t, storeZip([{ name: 'resources/app.asar', data: 'asar' }]))), /Nema\.exe at the top level/);
  await assert.rejects(assertPortableAppZip(await fixture(t, storeZip([
    { name: 'win-unpacked/Nema.exe', data: 'app' },
    { name: 'win-unpacked/resources/app.asar', data: 'asar' },
  ]))), /Nema\.exe at the top level/);
  await assert.rejects(assertPortableAppZip(await fixture(t, storeZip([
    ...appEntries,
    { name: 'Nema-1.2.3-win32-x64.exe', data: 'installer' },
  ]))), /NSIS installer/);
  await assert.rejects(assertPortableAppZip(await fixture(t, storeZip([
    ...appEntries,
    { name: 'Nema-1.2.3-win32-x64.zip', data: 'nested' },
  ]))), /nested archive/);
  await assert.rejects(assertPortableAppZip(await fixture(t, storeZip([
    ...appEntries,
    { name: 'resources/payload/extra.7z', data: 'nested' },
  ]))), /nested archive: resources\/payload\/extra\.7z/);
  await assertPortableAppZip(await fixture(t, storeZip([
    ...appEntries,
    { name: 'resources/payload/app/node_modules/@electric-sql/pglite/dist/pg_trgm.tar.gz', data: 'extension' },
  ])));
});

test('the NSIS installer does not contain the portable ZIP', async (t) => {
  const zipName = 'Nema-1.2.3-win32-x64.zip';
  await assertInstallerOmitsPortableZip(await fixture(t, Buffer.from('NSIS installer bytes without the portable name')), zipName);
  const name = Buffer.from(zipName);
  const across = Buffer.alloc(name.length + 16, 0x61);
  name.copy(across, 10);
  const file = await fixture(t, across);
  assert.equal(await fileContains(file, zipName, 8), true);
  await assert.rejects(assertInstallerOmitsPortableZip(file, zipName), /contains the portable ZIP name/);
  await assert.rejects(assertInstallerOmitsPortableZip(await fixture(t, storeZip(appEntries)), zipName), /itself a ZIP archive/);
});
