import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createLocalDb } from "@nema/hub/db/local";
import { seedPresetDb } from "../src/presetDb.js";
import { tarGz, writeSeedArchive, type TarEntry } from "./presetFixture.js";

const dirs: string[] = [];
let seedDir: string;
let seed: string;

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "nema-preset-home-"));
  dirs.push(dir);
  return dir;
}

function archive(name: string, data: Buffer): string {
  const file = join(seedDir, name);
  writeFileSync(file, data);
  return file;
}

/** Nothing but the named entries may be left in the home: no db, no `db.preset-*` sibling. */
function expectOnly(dir: string, names: string[]): void {
  expect(readdirSync(dir).sort()).toEqual(names.sort());
}

beforeAll(async () => {
  seedDir = mkdtempSync(join(tmpdir(), "nema-preset-seed-"));
  seed = join(seedDir, "preset-db.tar.gz");
  await writeSeedArchive(seed);
}, 60_000);

afterAll(() => rmSync(seedDir, { recursive: true, force: true }));
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("first-run database seed", () => {
  it("lands a seed that createLocalDb opens with no migration pending", async () => {
    const root = home();
    const target = join(root, "db");
    await expect(seedPresetDb(seed, target)).resolves.toEqual({ seeded: true });
    expectOnly(root, ["db"]);
    expect(existsSync(join(target, "PG_VERSION"))).toBe(true);
    const openedAt = new Date();
    const db = await createLocalDb(target);
    try {
      const rows = await db.query<{ name: string; applied_at: string | Date }>("select name, applied_at from schema_migrations");
      const shipped = readdirSync("apps/hub/src/db/migrations").filter((name) => name.endsWith(".sql") && !name.startsWith("._"));
      expect(rows.map((row) => row.name).sort()).toEqual(shipped.sort());
      // migrate stamps applied_at with now(); nothing may have been applied by this open.
      for (const row of rows) expect(new Date(row.applied_at).getTime()).toBeLessThan(openedAt.getTime());
    } finally {
      await db.close();
    }
  }, 60_000);

  it("falls back on a corrupt archive, leaves nothing behind, and a full initialization still succeeds", async () => {
    const root = home();
    const target = join(root, "db");
    const result = await seedPresetDb(archive("corrupt.tar.gz", Buffer.from("not a gzip stream")), target);
    expect(result.seeded).toBe(false);
    expectOnly(root, []);
    const db = await createLocalDb(target);
    await db.close();
    expect(existsSync(join(target, "PG_VERSION"))).toBe(true);
  }, 60_000);

  const unsafe: Array<[string, TarEntry[], RegExp]> = [
    ["a parent traversal", [{ name: "PG_VERSION", body: "17" }, { name: "../escaped", body: "x" }], /traversal/],
    ["an absolute name", [{ name: "PG_VERSION", body: "17" }, { name: "/escaped", body: "x" }], /Unsafe archive path/],
    ["a symlink escape", [{ name: "PG_VERSION", body: "17" }, { name: "out", type: "2", link: "../../escaped" }], /symlink traversal/],
    ["a write through a symlink parent", [{ name: "PG_VERSION", body: "17" }, { name: "out", type: "2", link: "." }, { name: "out/file", body: "x" }], /symlink parent/],
  ];
  it.each(unsafe)("refuses %s and removes the partial seed", async (_label, entries, reason) => {
    const root = home();
    const result = await seedPresetDb(archive("unsafe.tar.gz", tarGz(entries)), join(root, "db"));
    expect(result).toEqual({ seeded: false, reason: expect.stringMatching(reason) });
    expectOnly(root, []);
    expect(existsSync(join(root, "..", "escaped"))).toBe(false);
  });

  it("refuses an archive that is not a database directory", async () => {
    const root = home();
    const result = await seedPresetDb(archive("other.tar.gz", tarGz([{ name: "base/", type: "5" }])), join(root, "db"));
    expect(result.seeded).toBe(false);
    expectOnly(root, []);
  });

  it("falls back when the archive file is missing", async () => {
    const root = home();
    const result = await seedPresetDb(join(seedDir, "missing.tar.gz"), join(root, "db"));
    expect(result.seeded).toBe(false);
    expectOnly(root, []);
  });

  it("never touches an existing database directory", async () => {
    const root = home();
    const target = join(root, "db");
    mkdirSync(target);
    writeFileSync(join(target, "PG_VERSION"), "existing");
    const result = await seedPresetDb(seed, target);
    expect(result).toEqual({ seeded: false, reason: "the database directory already exists" });
    expectOnly(root, ["db"]);
    expect(readdirSync(target)).toEqual(["PG_VERSION"]);
    expect(readFileSync(join(target, "PG_VERSION"), "utf8")).toBe("existing");
  });
});
