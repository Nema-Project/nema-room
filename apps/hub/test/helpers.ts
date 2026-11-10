import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb } from "../src/db/pglite.js";
import type { Db } from "../src/db/db.js";

const dirs: string[] = [];

export async function makeHubDeps(): Promise<{ db: Db; dataDir: string; close: () => Promise<void> }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "nema-hub-"));
  dirs.push(dataDir);
  const db = await createTestDb();
  return { db, dataDir, close: () => db.close() };
}

export async function cleanupHubDeps(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}
