import { open } from 'node:fs/promises';
import path from 'node:path';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
// PGlite ships PostgreSQL extension tarballs inside the app. Those are runtime files, not a second download.
const NESTED_ARCHIVE = /(^|\/)[^/]+\.(?:zip|7z|rar)$/i;
const NSIS_INSTALLER = /^Nema-.+-win32-x64\.exe$/i;

function normalizeEntry(raw) {
  let name = raw.replaceAll('\\', '/');
  if (name.startsWith('./')) name = name.slice(2);
  const isDirectory = name.endsWith('/');
  if (isDirectory) name = name.slice(0, -1);
  if (!name || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Portable ZIP has an unsafe entry name: ${raw}`);
  }
  return { name, isDirectory };
}

async function readExact(file, buffer, position) {
  const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
  if (bytesRead !== buffer.length) throw new Error('Unexpected end of ZIP while reading the central directory');
}

function findEocd(tail) {
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === tail.length) return offset;
  }
  throw new Error('Invalid ZIP: end-of-central-directory not found');
}

async function locateCentralDirectory(file, fileSize) {
  const tailSize = Math.min(fileSize, 22 + 65535 + 20);
  const tail = Buffer.alloc(tailSize);
  await readExact(file, tail, fileSize - tailSize);
  const eocd = findEocd(tail);
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  const needsZip64 = count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  if (!needsZip64) return { count, cdSize, cdOffset };
  const eocdOffset = fileSize - tailSize + eocd;
  const locator = Buffer.alloc(20);
  await readExact(file, locator, eocdOffset - 20);
  if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) throw new Error('Invalid ZIP64 locator');
  const zip64Offset = Number(locator.readBigUInt64LE(8));
  const header = Buffer.alloc(56);
  await readExact(file, header, zip64Offset);
  if (header.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) throw new Error('Invalid ZIP64 end-of-central-directory');
  count = Number(header.readBigUInt64LE(32));
  cdSize = Number(header.readBigUInt64LE(40));
  cdOffset = Number(header.readBigUInt64LE(48));
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(cdSize) || !Number.isSafeInteger(cdOffset)) {
    throw new Error('ZIP64 central directory is too large to index');
  }
  return { count, cdSize, cdOffset };
}

export async function listZipEntries(zipPath) {
  const file = await open(zipPath, 'r');
  try {
    const { size } = await file.stat();
    if (size < 22) throw new Error('Invalid ZIP: file is too small');
    const { count, cdSize, cdOffset } = await locateCentralDirectory(file, size);
    if (cdSize > MAX_CENTRAL_DIRECTORY_BYTES) throw new Error('ZIP central directory is unexpectedly large');
    const central = Buffer.alloc(cdSize);
    await readExact(file, central, cdOffset);
    const entries = [];
    let cursor = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        throw new Error('Invalid ZIP central directory');
      }
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const nameStart = cursor + 46;
      const name = central.subarray(nameStart, nameStart + nameLength).toString('utf8');
      entries.push(normalizeEntry(name));
      cursor = nameStart + nameLength + extraLength + commentLength;
    }
    if (cursor !== central.length) throw new Error('ZIP central directory has trailing bytes');
    return entries;
  } finally {
    await file.close();
  }
}

/** The portable ZIP is the unpacked app only. A bundle of the installer plus another ZIP is not a portable channel. */
export async function assertPortableAppZip(zipPath) {
  const entries = await listZipEntries(zipPath);
  const files = entries.filter((entry) => !entry.isDirectory);
  if (!files.some((entry) => entry.name === 'Nema.exe')) {
    throw new Error('Portable ZIP must have Nema.exe at the top level');
  }
  if (!entries.some((entry) => entry.name === 'resources' || entry.name.startsWith('resources/'))) {
    throw new Error('Portable ZIP must be the unpacked app (missing resources/)');
  }
  for (const entry of entries) {
    if (NESTED_ARCHIVE.test(entry.name)) throw new Error(`Portable ZIP contains a nested archive: ${entry.name}`);
    const base = entry.name.split('/').at(-1);
    if (NSIS_INSTALLER.test(base)) throw new Error(`Portable ZIP contains an NSIS installer: ${entry.name}`);
  }
}

export async function fileContains(file, needle, chunkSize = 1024 * 1024) {
  const bytes = Buffer.isBuffer(needle) ? needle : Buffer.from(needle);
  if (bytes.length === 0) throw new Error('Refusing to search for an empty byte string');
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    let overlap = Buffer.alloc(0);
    for (let position = 0; position < size; position += chunkSize) {
      const length = Math.min(chunkSize, size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const window = overlap.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([overlap, chunk.subarray(0, bytesRead)]);
      if (window.includes(bytes)) return true;
      overlap = window.subarray(Math.max(0, window.length - (bytes.length - 1)));
    }
    return false;
  } finally {
    await handle.close();
  }
}

export async function assertInstallerOmitsPortableZip(exePath, portableZipName) {
  if (typeof portableZipName !== 'string' || portableZipName !== path.basename(portableZipName) || !portableZipName.endsWith('.zip')) {
    throw new Error(`Invalid portable ZIP name: ${String(portableZipName)}`);
  }
  const handle = await open(exePath, 'r');
  let magic;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 4) throw new Error(`NSIS installer is missing or too small: ${exePath}`);
    const head = Buffer.alloc(4);
    await readExact(handle, head, 0);
    magic = head.readUInt32LE(0);
  } finally {
    await handle.close();
  }
  if (magic === LOCAL_SIGNATURE || magic === EOCD_SIGNATURE) throw new Error('NSIS installer is itself a ZIP archive');
  if (await fileContains(exePath, portableZipName)) throw new Error(`NSIS installer contains the portable ZIP name ${portableZipName}`);
}
