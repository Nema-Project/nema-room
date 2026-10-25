import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, test } from "vitest";
import { createLocalDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/db.js";
import { createWorkspace } from "../src/workspaces.js";
import { addMessage, listMessages, postUserMessage } from "../src/messages.js";
import { claimNextTask, finishTask } from "../src/tasks.js";

const dirs: string[] = [];
const openDbs: Array<{ close(): Promise<void> }> = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "nema-pglite-"));
  dirs.push(dir);
  return dir;
}

async function makeDb(dataDir: string) {
  const db = await createLocalDb(dataDir);
  openDbs.push(db);
  return db;
}

afterEach(async () => {
  await Promise.allSettled(openDbs.splice(0).map((db) => db.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("persistent PGlite database", () => {
  test("reopen preserves messages, plugin settings, and migration versions", async () => {
    const dataDir = await makeDir();
    const db = await makeDb(dataDir);
    const workspace = await createWorkspace(db, dataDir, "persisted");
    const { message, task } = await postUserMessage(db, workspace.id, "remember this");
    await addMessage(db, workspace.id, "agent", "saved response", { taskId: task.id, meta: { changes: [], askedQuestion: null } });
    await db.query(
      "insert into workspace_plugins(workspace_id, plugin_id, enabled, disabled_functions, settings) values ($1, 'grill', true, '{}', $2::jsonb)",
      [workspace.id, JSON.stringify({ strictness: "lenient", extraRules: "keep this" })],
    );
    const migrationsBefore = await db.query<{ name: string }>("select name from schema_migrations order by name");
    expect(migrationsBefore.every(({ name }) => !name.startsWith("._"))).toBe(true);
    await Promise.all([db.close(), db.close()]);

    const reopened = await makeDb(dataDir);
    expect((await listMessages(reopened, workspace.id)).map((row) => row.content)).toEqual(["remember this", "saved response"]);
    expect(await reopened.query("select settings from workspace_plugins where workspace_id = $1", [workspace.id])).toEqual([
      { settings: { strictness: "lenient", extraRules: "keep this" } },
    ]);
    expect(await reopened.query<{ name: string }>("select name from schema_migrations order by name")).toEqual(migrationsBefore);
    expect((await listMessages(reopened, workspace.id))[0]?.id).toBe(message.id);
    await reopened.close();
  });

  test("transaction rolls back all writes when its callback fails", async () => {
    const dataDir = await makeDir();
    const db = await makeDb(dataDir);
    const workspace = await createWorkspace(db, dataDir, "rollback");

    await expect(
      db.tx(async (tx) => {
        await tx.query("insert into messages(id, workspace_id, role, content) values ('m_rollback', $1, 'user', 'temporary')", [workspace.id]);
        await tx.query("insert into workspace_plugins(workspace_id, plugin_id, enabled) values ($1, 'rollback', true)", [workspace.id]);
        throw new Error("abort transaction");
      }),
    ).rejects.toThrow("abort transaction");

    expect(await db.query("select id from messages where id = 'm_rollback'")).toEqual([]);
    expect(await db.query("select plugin_id from workspace_plugins where workspace_id = $1 and plugin_id = 'rollback'", [workspace.id])).toEqual([]);
    await db.close();
  });

  test("parallel claims never share a task or workspace", async () => {
    const dataDir = await makeDir();
    const db = await makeDb(dataDir);
    const workspaceA = await createWorkspace(db, dataDir, "A");
    const workspaceB = await createWorkspace(db, dataDir, "B");
    const first = await postUserMessage(db, workspaceA.id, "A first");
    await postUserMessage(db, workspaceA.id, "A second");
    const second = await postUserMessage(db, workspaceB.id, "B first");

    const claims = await Promise.all([claimNextTask(db, "daemon-a"), claimNextTask(db, "daemon-b")]);
    const claimed = claims.filter((task) => task !== null);
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((task) => task!.id)).size).toBe(2);
    expect(new Set(claimed.map((task) => task!.workspaceId)).size).toBe(2);
    expect(new Set(claimed.map((task) => task!.id))).toEqual(new Set([first.task.id, second.task.id]));
    expect(await db.query("select id, status from tasks where id = $1", [first.task.id])).toEqual([{ id: first.task.id, status: "running" }]);
    expect(await db.query("select id, status from tasks where id = $1", [second.task.id])).toEqual([{ id: second.task.id, status: "running" }]);
    const completed = await claimNextTask(db, "daemon-c");
    expect(completed).toBeNull();
    await finishTask(db, claimed[0]!.id, { ok: true });
    expect(await db.query("select status from tasks where id = $1", [claimed[0]!.id])).toEqual([{ status: "done" }]);
    await db.close();
  });

  test("process crash reopens committed application data", async () => {
    const dataDir = await makeDir();
    const worker = fileURLToPath(new URL("./fixtures/persistentDbCrashWorker.ts", import.meta.url));
    const node = process.execPath;
    const child = spawn(node, ["--import", "tsx", worker, dataDir], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const exit = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect({ exit, stdout, stderr }).toEqual({ exit: 73, stdout: "committed\n", stderr: "" });

    const reopened = await makeDb(dataDir);
    const messages = await reopened.query<{ content: string }>("select content from messages where content = 'committed before crash'");
    expect(messages).toEqual([{ content: "committed before crash" }]);
    await reopened.close();
  });

  test("failed migration rolls back its DDL and closes the failed instance", async () => {
    const dataDir = await makeDir();
    const seeded = await makeDb(dataDir);
    await seeded.query("alter table tasks drop column kind");
    await seeded.query("alter table workspace_plugins drop column settings");
    await seeded.query("alter table workspace_plugins add column settings text");
    await seeded.query("delete from schema_migrations where name = '009_workpackages.sql'");
    await seeded.close();

    await expect(createLocalDb(dataDir)).rejects.toThrow();

    const check = new PGlite(dataDir);
    try {
      const taskKind = await check.query("select column_name from information_schema.columns where table_name = 'tasks' and column_name = 'kind'");
      const migration = await check.query("select name from schema_migrations where name = '009_workpackages.sql'");
      expect(taskKind.rows).toEqual([]);
      expect(migration.rows).toEqual([]);
    } finally {
      await check.close();
    }
  });

  test("migration discovery skips AppleDouble SQL sidecars", async () => {
    const dataDir = await makeDir();
    const migrationDir = await makeDir();
    await writeFile(path.join(migrationDir, "001_probe.sql"), "create table migration_probe (id integer primary key);");
    await writeFile(path.join(migrationDir, "._000_probe.sql"), Buffer.from([0, 5, 22, 7, 0, 2, 0, 0, 77, 97, 99]));
    const db = await makeDb(dataDir);

    await migrate(db, migrationDir);

    expect(
      await db.query("select table_name from information_schema.tables where table_schema = current_schema() and table_name = 'migration_probe'"),
    ).toEqual([{ table_name: "migration_probe" }]);
    expect(await db.query("select name from schema_migrations where name like '._%' or name = '001_probe.sql'")).toEqual([
      { name: "001_probe.sql" },
    ]);
  });
});
