import { PGlite, type Transaction } from "@electric-sql/pglite";
import { migrate, type Db } from "./db.js";

type Runner = PGlite | Transaction;

function wrap(c: Runner, inTx: boolean): Db {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      // query() is single-statement (extended protocol); exec() allows multi-statement SQL such as migrations.
      if (!params || params.length === 0) {
        const res = await c.exec(sql);
        return (res[res.length - 1]?.rows ?? []) as T[];
      }
      return (await c.query(sql, params)).rows as T[];
    },
    async tx<T>(fn: (db: Db) => Promise<T>) {
      if (inTx) return fn(wrap(c, true)); // nested: join the outer transaction
      return (c as PGlite).transaction((t) => fn(wrap(t, true)));
    },
  };
}

export async function createTestDb(): Promise<Db> {
  const db = wrap(new PGlite(), false);
  await migrate(db);
  return db;
}
