import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve sharp from Next's dependencies; this script uses the existing npm ci installation.
const require = createRequire(import.meta.url);
const sharp = createRequire(require.resolve('next/package.json'))('sharp');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const brand = path.join(repo, 'docs/design/brand');
const assets = path.join(repo, 'apps/desktop/assets');
const master = await readFile(path.join(brand, 'nema-room-mark.svg'), 'utf8');
const mark = master.replace(/<title>.*?<\/title>/, '');
const tile = mark.replace('<path', '<rect x="8" y="8" width="344" height="344" rx="52" fill="#f3f2ee"/><path');
const preview = mark.replace('<path', '<rect width="360" height="360" fill="#f3f2ee"/><path');
const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();

await mkdir(assets, { recursive: true });
await mkdir(path.join(repo, 'apps/web/public'), { recursive: true });
await writeFile(path.join(repo, 'apps/web/public/nema-room-mark.svg'), master);
await writeFile(path.join(brand, 'nema-room-preview.svg'), preview);
await writeFile(path.join(brand, 'nema-room-preview.png'), await png(preview, 512));
await writeFile(path.join(assets, 'icon.png'), await png(tile, 1024));
await writeFile(path.join(assets, 'tray.png'), await png(preview, 32));
await writeFile(path.join(assets, 'trayTemplate.png'), await png(mark, 16));
await writeFile(path.join(assets, 'trayTemplate@2x.png'), await png(mark, 32));
await writeFile(path.join(repo, 'apps/web/app/icon.png'), await png(preview, 192));

// ICO directory entries point to actual PNG payloads, one per resolution.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const frames = await Promise.all(sizes.map((size) => png(tile, size)));
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
sizes.forEach((size, index) => {
  const entry = 6 + index * 16;
  directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frames[index].length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frames[index].length;
});
await writeFile(path.join(assets, 'icon.ico'), Buffer.concat([directory, ...frames]));

// Modern ICNS chunks carry PNG representations with a big-endian chunk length.
const chunks = [];
for (const [type, size] of [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
  const frame = await png(tile, size);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(frame.length + 8, 4);
  chunks.push(header, frame);
}
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
await writeFile(path.join(assets, 'icon.icns'), Buffer.concat([header, ...chunks]));
console.log('Generated Nema Room desktop, tray, browser and README assets from the original-01 SVG master.');
