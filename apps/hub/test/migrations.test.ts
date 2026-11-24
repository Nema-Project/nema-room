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

test("021 tags migration upgrades old rows with nulls and can be applied twice", async () => {
  const earlier = await scratch("nema-before-tags-");
  for (const name of (await readdir(MIGRATIONS)).filter(n => n.endsWith(".sql") && n !== "021_entry_index_tags.sql").sort()) {
    await copyFile(path.join(MIGRATIONS, name), path.join(earlier, name));
  }
  const client = new PGlite();
  const db = wrap(client);
  try {
    await migrate(db, earlier);
    await db.query("insert into workspaces(id,name) values ('ws_tags','Tags')");
    await db.query("insert into entry_index(workspace_id,entry_id,kind,title,status) values ('ws_tags','R-1','requirement','Old','active')");
    expect(await columnNames(db, "entry_index")).not.toContain("tags");
    await migrate(db);
    const { readFile } = await import("node:fs/promises");
    await db.query(await readFile(path.join(MIGRATIONS, "021_entry_index_tags.sql"), "utf8"));
    expect(await db.query("select tags,tags_indexed_at from entry_index")).toEqual([{ tags: null, tags_indexed_at: null }]);
  } finally { await client.close(); }
});

/** #167 phase two: credentials/sessions, invites/auth events, daemon registry, credential resets. */
const REMOTE_MIGRATIONS = ["023_user_credentials_sessions.sql", "024_invites_auth_events.sql", "025_daemons.sql", "026_credential_resets.sql"];

describe("023–026 remote-form tables (#167)", () => {
  const H = (c: string) => c.repeat(64);

  test("a 022 database upgrades, keeps usr_local and its data, and gains the empty tables", async () => {
    const earlier = await scratch("nema-before-remote-");
    for (const name of (await readdir(MIGRATIONS)).filter((n) => n.endsWith(".sql") && !REMOTE_MIGRATIONS.includes(n)).sort()) {
      await copyFile(path.join(MIGRATIONS, name), path.join(earlier, name));
    }
    const client = new PGlite();
    const db = wrap(client);
    try {
      await migrate(db, earlier);
      await db.query("insert into workspaces(id,name) values ('ws_keep','Keep')");
      await db.query("insert into messages(id,workspace_id,role,content,author_user_id) values ('m_keep','ws_keep','user','hi','usr_local')");
      const before = {
        users: await db.query("select * from users order by id"),
        members: await db.query("select workspace_id,user_id,role from workspace_members order by workspace_id"),
        events: await db.query("select id,kind from member_events order by id"),
      };
      await migrate(db);
      expect(await db.query("select * from users order by id")).toEqual(before.users);
      expect(await db.query("select workspace_id,user_id,role from workspace_members order by workspace_id")).toEqual(before.members);
      expect(await db.query("select id,kind from member_events order by id")).toEqual(before.events);
      expect(await db.query("select id,author_user_id from messages")).toEqual([{ id: "m_keep", author_user_id: "usr_local" }]);
      for (const table of ["user_credentials", "sessions", "invites", "auth_events", "daemons", "daemon_registration_codes", "daemon_events", "credential_resets"]) {
        expect(await db.query(`select count(*)::int as n from ${table}`), table).toEqual([{ n: 0 }]);
      }
      expect((await db.query<{ name: string }>("select name from schema_migrations order by name")).map((r) => r.name).slice(-REMOTE_MIGRATIONS.length)).toEqual(REMOTE_MIGRATIONS);
      await migrate(db);
    } finally { await client.close(); }
  });

  test("columns match the plan and only hashes are stored", async () => {
    const db = await createTestDb();
    expect(await columnNames(db, "user_credentials")).toEqual(["created_at", "password_hash", "updated_at", "user_id"]);
    expect(await columnNames(db, "sessions")).toEqual(["created_at", "expires_at", "id", "revoked_at", "token_hash", "user_id"]);
    expect(await columnNames(db, "invites")).toEqual(["code_hash", "created_at", "created_by", "expires_at", "id", "intended_workspace_id", "used_at", "used_by_user_id"]);
    expect(await columnNames(db, "auth_events")).toEqual(["actor_user_id", "created_at", "detail", "id", "kind", "user_id"]);
    expect(await columnNames(db, "daemons")).toEqual(["created_at", "credential_hash", "id", "label", "last_seen_at", "owner_user_id", "revoked_at"]);
    expect(await columnNames(db, "daemon_registration_codes")).toEqual(["code_hash", "created_at", "expires_at", "id", "owner_user_id", "used_at", "used_by_daemon_id"]);
    expect(await columnNames(db, "daemon_events")).toEqual(["actor_user_id", "created_at", "daemon_id", "detail", "id", "kind", "owner_user_id"]);
    expect(await columnNames(db, "credential_resets")).toEqual(["code_hash", "created_at", "created_by", "expires_at", "id", "used_at", "user_id"]);
  });

  test("foreign keys, uniqueness and kind checks hold", async () => {
    const db = await createTestDb();
    await db.query("insert into workspaces(id,name) values ('ws_r','R')");
    await expect(db.query("insert into user_credentials(user_id,password_hash) values ('usr_ghost','$argon2id$x')")).rejects.toThrow();
    await db.query("insert into user_credentials(user_id,password_hash) values ('usr_local','$argon2id$x')");
    await db.query("insert into sessions(id,user_id,token_hash,expires_at) values ('s1','usr_local',$1,now())", [H("a")]);
    await expect(db.query("insert into sessions(id,user_id,token_hash,expires_at) values ('s2','usr_local',$1,now())", [H("a")])).rejects.toThrow();
    await expect(db.query("insert into sessions(id,user_id,token_hash,expires_at) values ('s3','usr_ghost',$1,now())", [H("b")])).rejects.toThrow();

    await db.query("insert into invites(id,code_hash,created_by,intended_workspace_id,expires_at) values ('i1',$1,'usr_local','ws_r',now())", [H("c")]);
    await db.query("insert into invites(id,code_hash,created_by,expires_at) values ('i2',$1,'usr_local',now())", [H("d")]);
    await expect(db.query("insert into invites(id,code_hash,created_by,expires_at) values ('i3',$1,'usr_local',now())", [H("c")])).rejects.toThrow();
    await expect(db.query("insert into invites(id,code_hash,created_by,intended_workspace_id,expires_at) values ('i4',$1,'usr_local','ws_ghost',now())", [H("e")])).rejects.toThrow();

    for (const kind of ["account_created", "invite_created", "invite_used", "login_locked", "sessions_revoked", "bootstrap_completed"]) {
      await db.query("insert into auth_events(id,user_id,kind) values ($1,null,$2)", [`aev_${kind}`, kind]);
    }
    await expect(db.query("insert into auth_events(id,kind) values ('aev_bad','added')")).rejects.toThrow();

    await db.query("insert into daemons(id,owner_user_id,label,credential_hash) values ('dmn_1','usr_local','laptop',$1)", [H("f")]);
    await expect(db.query("insert into daemons(id,owner_user_id,label,credential_hash) values ('dmn_2','usr_local','dup',$1)", [H("f")])).rejects.toThrow();
    await expect(db.query("insert into daemons(id,owner_user_id,label,credential_hash) values ('dmn_3','usr_ghost','x',$1)", [H("1")])).rejects.toThrow();
    await db.query("insert into daemon_registration_codes(id,code_hash,owner_user_id,expires_at,used_at,used_by_daemon_id) values ('drc_1',$1,'usr_local',now(),now(),'dmn_1')", [H("2")]);
    await expect(db.query("insert into daemon_registration_codes(id,code_hash,owner_user_id,expires_at) values ('drc_2',$1,'usr_local',now())", [H("2")])).rejects.toThrow();
    await expect(db.query("insert into daemon_registration_codes(id,code_hash,owner_user_id,expires_at,used_at,used_by_daemon_id) values ('drc_3',$1,'usr_local',now(),now(),'dmn_ghost')", [H("3")])).rejects.toThrow();
    for (const kind of ["registered", "revoked", "rejected"]) {
      await db.query("insert into daemon_events(id,daemon_id,owner_user_id,kind) values ($1,'dmn_1','usr_local',$2)", [`dev_${kind}`, kind]);
    }
    await db.query("insert into daemon_events(id,daemon_id,owner_user_id,kind) values ('dev_unknown',null,'usr_local','rejected')");
    await expect(db.query("insert into daemon_events(id,owner_user_id,kind) values ('dev_bad','usr_local','connected')")).rejects.toThrow();
    await expect(db.query("insert into daemon_events(id,daemon_id,owner_user_id,kind) values ('dev_ghost','dmn_ghost','usr_local','revoked')")).rejects.toThrow();

    await db.query("insert into credential_resets(id,user_id,code_hash,created_by,expires_at) values ('crs_1','usr_local',$1,'usr_local',now())", [H("4")]);
    await expect(db.query("insert into credential_resets(id,user_id,code_hash,created_by,expires_at) values ('crs_2','usr_local',$1,'usr_local',now())", [H("4")])).rejects.toThrow();
    await expect(db.query("insert into credential_resets(id,user_id,code_hash,created_by,expires_at) values ('crs_3','usr_ghost',$1,'usr_local',now())", [H("5")])).rejects.toThrow();

    // member_events keeps its own four kinds: the new audit kinds are not smuggled into it (#163 semantics).
    await expect(db.query("insert into member_events(id,user_id,kind) values ('mev_bad','usr_local','account_created')")).rejects.toThrow();
  });
});

test("022 identity upgrades without guessing historical authors and seeds idempotently", async () => {
  const earlier = await scratch("nema-before-identity-");
  for (const name of (await readdir(MIGRATIONS)).filter(n => n.endsWith(".sql") && n < "022").sort()) {
    await copyFile(path.join(MIGRATIONS, name), path.join(earlier, name));
  }
  const client = new PGlite();
  const db = wrap(client);
  try {
    await migrate(db, earlier);
    await db.query("insert into workspaces(id,name) values ('ws_a','A'),('ws_b','B')");
    await db.query("insert into messages(id,workspace_id,role,content) values ('m1','ws_a','user','old'),('m2','ws_b','agent','old'),('m3','ws_b','report','old')");
    await migrate(db);
    expect(await db.query("select id,display_name from users")).toEqual([{ id: "usr_local", display_name: null }]);
    expect(await db.query("select workspace_id,user_id,role from workspace_members order by workspace_id")).toEqual([
      { workspace_id: "ws_a", user_id: "usr_local", role: "owner" }, { workspace_id: "ws_b", user_id: "usr_local", role: "owner" },
    ]);
    expect(await db.query("select id,kind,actor_user_id from member_events order by id")).toEqual([
      { id: "mev_seed_ws_a", kind: "added", actor_user_id: null }, { id: "mev_seed_ws_b", kind: "added", actor_user_id: null },
    ]);
    expect(await db.query("select author_user_id from messages")).toEqual(Array(3).fill({ author_user_id: null }));
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(path.join(MIGRATIONS, "022_identity.sql"), "utf8");
    await db.query(sql.slice(sql.indexOf("insert into users")));
    await migrate(db);
    expect(await db.query("select count(*)::int as n from member_events")).toEqual([{ n: 2 }]);
    expect(await db.query("select count(*)::int as n from workspace_members")).toEqual([{ n: 2 }]);
    for (const role of ["agent", "system", "report"]) {
      await expect(db.query("insert into messages(id,workspace_id,role,content,author_user_id) values ($1,'ws_a',$2,'bad','usr_local')", [`bad_${role}`, role])).rejects.toThrow("messages_author_role_check");
    }
    for (const name of ["", "x".repeat(65)]) {
      await expect(db.query("insert into users(id,display_name) values ('usr_bad',$1)", [name])).rejects.toThrow();
    }
    await expect(db.query("insert into users(id) values ('bob')")).rejects.toThrow();
  } finally { await client.close(); }
});
