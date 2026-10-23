import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export function createPgDb(url: string): Db & { close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: url });
  const wrap = (c: pg.Pool | pg.PoolClient, inTx: boolean): Db => ({
    async query<T>(sql: string, params?: unknown[]) {
      return (await c.query(sql, params as unknown[])).rows as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (inTx) return fn(wrap(c, true)); // nested: join the outer transaction
      const client = await (c as pg.Pool).connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client, true));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  });
  return { ...wrap(pool, false), close: () => pool.end() };
}

/** Applies pending .sql migrations in filename order, tracked in schema_migrations. */
export async function migrate(db: Db): Promise<void> {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())");
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  for (const f of (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort()) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), "utf8");
    await db.tx(async (t) => {
      await t.query(sql);
      await t.query("insert into schema_migrations(name) values ($1)", [f]);
    });
  }
}
