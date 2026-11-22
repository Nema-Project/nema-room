import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createLocalDb } from "@nema/hub/db/local";

type Packer = { tarGzDirectory(root: string): Promise<Buffer> };
const packerUrl = new URL("../../../scripts/desktop/make-preset-db.mjs", import.meta.url).href;

/** A real seed: the source hub's createLocalDb on an empty directory, packed by the desktop generator's packer. */
export async function writeSeedArchive(file: string): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "nema-seed-fixture-"));
  try {
    const db = await createLocalDb(join(work, "db"));
    await db.close();
    const { tarGzDirectory } = (await import(packerUrl)) as Packer;
    writeFileSync(file, await tarGzDirectory(join(work, "db")));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export type TarEntry = { name: string; type?: "0" | "2" | "5"; body?: string; link?: string };

/** A hand-built ustar archive, for entries the generator would never write (traversal, absolute, symlinks). */
export function tarGz(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000600\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}
