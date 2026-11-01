import { describe, expect, test } from "vitest";
import { createTestDb } from "../src/db/pglite.js";

/**
 * `tasks.account_id` is a column two branches touch: this one creates it, and the routing batch (S3) adds it
 * with `add column if not exists`. That form does **not** verify the type — when a column already exists,
 * Postgres ignores the whole clause and keeps whatever is there. So if the two migrations disagreed about
 * the type, nothing would fail; the column would just stay as this one made it, and the other side would be
 * reading and writing a type it did not expect.
 *
 * This pins the facts the other side has to match: plain `text`, nullable, no default, no length limit.
 */

describe("tasks.account_id", () => {
  test("is a nullable text column with no default and no length limit", async () => {
    const db = await createTestDb();
    const rows = await db.query<{
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      character_maximum_length: number | null;
    }>(
      `select data_type, udt_name, is_nullable, column_default, character_maximum_length
         from information_schema.columns
        where table_name = 'tasks' and column_name = 'account_id'`,
    );
    expect(rows).toHaveLength(1);
    const column = rows[0]!;
    // `text`, not `varchar(n)` and not `citext`: an account id is an opaque ten-character token with a
    // fixed prefix, and a length limit chosen here would silently truncate or reject the other side's value.
    expect(column.data_type).toBe("text");
    expect(column.udt_name).toBe("text");
    expect(column.character_maximum_length).toBeNull();
    // Existing rows predate the column, so it must accept null and must not invent a value for them.
    expect(column.is_nullable).toBe("YES");
    expect(column.column_default).toBeNull();
  });

  test("accepts null and an account id, and nothing enforces a shape at the database level", async () => {
    const db = await createTestDb();
    // The hub checks the shape in `PostMessageBody`; the column is deliberately not a constraint, so a value
    // that reached the database another way is not rejected here but is also not trusted anywhere.
    await db.query(
      `insert into workspaces(id, name) values ('ws_col','W') on conflict do nothing`,
    );
    await db.query(
      `insert into tasks(id, workspace_id, status, kind, account_id) values ('t_col_null','ws_col','queued','organize', null)`,
    );
    await db.query(
      `insert into tasks(id, workspace_id, status, kind, account_id) values ('t_col_id','ws_col','queued','organize', 'acct_abc1234567')`,
    );
    const rows = await db.query<{ id: string; account_id: string | null }>(
      "select id, account_id from tasks where id in ('t_col_null','t_col_id') order by id",
    );
    expect(rows).toEqual([
      { id: "t_col_id", account_id: "acct_abc1234567" },
      { id: "t_col_null", account_id: null },
    ]);
  });
});
