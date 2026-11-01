import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, describe, expect, test } from "vitest";
import { migrate, type Db } from "../src/db/db.js";
import { createTestDb } from "../src/db/pglite.js";

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db/migrations");
/**
 * The migrations this release adds. Both belong to the same batch: S2 (#175) creates `account_id` in 017 and
 * this branch adds `routing` in 018, and they ship together, so "a database from before this release" is one
 * that has neither.
 */
const ACCOUNT_MIGRATION = "017_task_account.sql";
const ROUTING_MIGRATION = "018_task_routing.sql";
const NEW_MIGRATIONS = [ACCOUNT_MIGRATION, ROUTING_MIGRATION];

const dirs: string[] = [];

function wrap(c: PGlite | Transaction): Db {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      if (!params || params.length === 0) {
        const res = await (c as PGlite).exec(sql);
        return (res[res.length - 1]?.rows ?? []) as T[];
      }
      return (await c.query(sql, params)).rows as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if ("transaction" in c) return c.transaction((t) => fn(wrap(t)));
      return fn(wrap(c));
    },
  };
}

const scratch = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const columnNames = async (db: Db, table: string): Promise<string[]> =>
  (await db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = $1 order by column_name",
    [table],
  )).map((r) => r.column_name);

describe("tasks gains the account choice and the routing allowance", () => {
  test("both columns exist and are nullable, so every existing row stays valid", async () => {
    const db = await createTestDb();
    expect(await columnNames(db, "tasks")).toEqual(expect.arrayContaining(["account_id", "routing"]));
    for (const column of ["account_id", "routing"]) {
      const [row] = await db.query<{ is_nullable: string }>(
        "select is_nullable from information_schema.columns where table_name = 'tasks' and column_name = $1",
        [column],
      );
      expect(row?.is_nullable, column).toBe("YES");
    }
  });

  test("routing holds only \"auto\" and null", async () => {
    const db = await createTestDb();
    const [ws] = await db.query<{ id: string }>(
      "insert into workspaces(id, name) values ('w1','W') returning id",
    );
    await db.query("insert into tasks(id, workspace_id, status, routing) values ('t_auto', $1, 'queued', 'auto')", [ws!.id]);
    await db.query("insert into tasks(id, workspace_id, status) values ('t_null', $1, 'queued')", [ws!.id]);
    await expect(
      db.query("insert into tasks(id, workspace_id, status, routing) values ('t_bad', $1, 'queued', 'manual')", [ws!.id]),
    ).rejects.toThrow();
  });

  test("running it twice changes nothing", async () => {
    const db = await createTestDb();
    await migrate(db);
    await migrate(db);
    expect(await columnNames(db, "tasks")).toEqual(expect.arrayContaining(["account_id", "routing"]));
  });

  test("a data directory from before this release upgrades and keeps its tasks", async () => {
    // The upgrade path users actually take: apply every migration this release adds but these, add a row,
    // then migrate.
    const earlier = await scratch("nema-migrations-before-");
    for (const name of (await readdir(MIGRATIONS)).filter((n) => n.endsWith(".sql") && !NEW_MIGRATIONS.includes(n)).sort()) {
      await copyFile(path.join(MIGRATIONS, name), path.join(earlier, name));
    }
    const dataDir = await scratch("nema-migrations-data-");
    const db = wrap(new PGlite(dataDir));
    await migrate(db, earlier);
    const [ws] = await db.query<{ id: string }>(
      "insert into workspaces(id, name) values ('w_keep','W') returning id",
    );
    await db.query("insert into tasks(id, workspace_id, status) values ('t_keep', $1, 'queued')", [ws!.id]);
    expect(await columnNames(db, "tasks")).not.toContain("account_id");

    await migrate(db);

    expect(await columnNames(db, "tasks")).toEqual(expect.arrayContaining(["account_id", "routing"]));
    const [row] = await db.query<{ id: string; account_id: string | null; routing: string | null }>(
      "select id, account_id, routing from tasks where id = 't_keep'",
    );
    expect(row).toEqual({ id: "t_keep", account_id: null, routing: null });
  });
});

describe("landing after S2's task account column", () => {
  test("applying the routing migration on a database that already has account_id does not fail", async () => {
    // The plan expected S2 and S3 to touch different files; both need an account on the task row. Whichever
    // lands second must not throw, because a failing migration leaves the hub unable to start at all.
    // 017 is S2's own file and it is on `main` now, so this order is the real one: a database that has
    // everything except this branch's migration. No hand-written stand-in for S2's file any more — the test
    // reads the file that actually ships.
    const earlier = await scratch("nema-migrations-s2-first-");
    for (const name of (await readdir(MIGRATIONS)).filter((n) => n.endsWith(".sql") && n !== ROUTING_MIGRATION).sort()) {
      await copyFile(path.join(MIGRATIONS, name), path.join(earlier, name));
    }
    const dataDir = await scratch("nema-migrations-s2-data-");
    const db = wrap(new PGlite(dataDir));
    await migrate(db, earlier);
    expect(await columnNames(db, "tasks")).toContain("account_id");
    expect(await columnNames(db, "tasks")).not.toContain("routing");

    await migrate(db);

    const [column] = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      "select data_type, is_nullable, column_default from information_schema.columns where table_name = 'tasks' and column_name = 'account_id'",
    );
    // `add column if not exists` matches on the name only: a type that disagreed with S2's would be kept
    // without a word. The type is therefore asserted rather than assumed, so a drift in either migration
    // fails here instead of reaching a user's database unremarked.
    expect(column, "account_id after both migrations").toEqual({
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
    });
    expect(await columnNames(db, "tasks")).toEqual(expect.arrayContaining(["account_id", "routing"]));
  });
});
