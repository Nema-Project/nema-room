import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, KnowledgeStore } from "@nema/knowledge";
import { migrate } from "../src/db/db.js";
import { createLocalDb } from "../src/db/pglite.js";
import { addMessage, postUserMessage } from "../src/messages.js";
import { ensureThread } from "../src/threads.js";
import { createWorkspace, repoPath } from "../src/workspaces.js";

export type HomeSnapshot = {
  messages: { id: string; role: string; content: string; threadId: string | null }[];
  threads: { id: string; title: string; openedBy: string }[];
  entries: { id: string; kind: string; title: string; status: string; basis: string | null; body: string; requirements: string[] | null; sourceMessages: string[] }[];
  commits: string[];
  migrations: string[];
  probeColumn: boolean;
};

type Db = Awaited<ReturnType<typeof createLocalDb>>;

async function rmRetry(target: string): Promise<void> {
  let last: unknown;
  // ponytail: Windows can return EPERM until a closed PGlite handle drops. Five tries, then surface the error.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw last;
}

async function readSnapshot(db: Db, dataDir: string, workspaceId: string): Promise<HomeSnapshot> {
  const messages = await db.query<{ id: string; role: string; content: string; thread_id: string | null }>(
    "select id, role, content, thread_id from messages where workspace_id = $1 order by seq",
    [workspaceId],
  );
  const threads = await db.query<{ id: string; title: string; opened_by: string }>(
    "select id, title, opened_by from threads where workspace_id = $1 order by id",
    [workspaceId],
  );
  const migrations = await db.query<{ name: string }>("select name from schema_migrations order by name");
  const probe = await db.query<{ column_name: string }>(
    "select column_name from information_schema.columns where table_name = 'workspaces' and column_name = 'upgrade_probe'",
  );
  const store = new KnowledgeStore(repoPath(dataDir, workspaceId));
  const entries = [];
  for (const summary of await store.list()) {
    const entry = await store.get(summary.id);
    if (!entry) continue;
    entries.push({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      status: entry.status,
      basis: entry.basis,
      body: entry.body,
      requirements: entry.workpackage ? [...entry.workpackage.requirements] : null,
      sourceMessages: [...entry.sourceMessages].sort(),
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const commits = (await git(repoPath(dataDir, workspaceId), ["rev-list", "--reverse", "HEAD"])).trim().split("\n").filter(Boolean);
  return {
    messages: messages.map((row) => ({ id: row.id, role: row.role, content: row.content, threadId: row.thread_id })),
    threads: threads.map((row) => ({ id: row.id, title: row.title, openedBy: row.opened_by })),
    entries,
    commits,
    migrations: migrations.map((row) => row.name),
    probeColumn: probe.length > 0,
  };
}

/** Current-schema desktop home: chat, thread, work package, and knowledge history. */
export async function seedPriorHome(home: string): Promise<void> {
  const db = await createLocalDb(path.join(home, "db"));
  try {
    const dataDir = path.join(home, "data");
    const workspace = await createWorkspace(db, dataDir, "prior");
    const main = await postUserMessage(db, workspace.id, "old main chat");
    await addMessage(db, workspace.id, "agent", "old reply", { taskId: main.task.id, meta: { changes: [], askedQuestion: null } });
    const anchor = await postUserMessage(db, workspace.id, "old thread anchor");
    await ensureThread(db, anchor.message.id, "old thread", "user");
    await addMessage(db, workspace.id, "agent", "old thread reply", { threadId: anchor.message.id, meta: { changes: [], askedQuestion: null } });
    const store = new KnowledgeStore(repoPath(dataDir, workspace.id));
    const requirement = await store.upsert({
      kind: "requirement",
      title: "Keep the old note",
      body: "notes from the previous install",
      reason: "seed requirement",
      sourceMessages: [main.message.id],
      basis: "stated",
    }, { author: "user" });
    await store.createWorkPackage({
      title: "Old package",
      requirements: [requirement.entry.id],
      repos: [],
      reason: "seed work package",
      sourceMessages: [main.message.id],
    }, { author: "user" });
    await store.upsert({
      kind: "decision",
      title: "Use Redis",
      body: "cache decision from the previous install",
      reason: "seed decision",
      sourceMessages: [anchor.message.id],
      basis: "decided",
      status: "active",
    }, { author: "user" });
  } finally {
    await db.close();
  }
}

export async function captureHome(home: string): Promise<HomeSnapshot> {
  const db = await createLocalDb(path.join(home, "db"));
  try {
    const workspace = await db.query<{ id: string }>("select id from workspaces order by created_at, id limit 1");
    const id = workspace[0]?.id;
    if (!id) throw new Error("prior home has no workspace");
    return await readSnapshot(db, path.join(home, "data"), id);
  } finally {
    await db.close();
  }
}

export async function backupHome(home: string, dest: string): Promise<void> {
  await cp(home, dest, { recursive: true });
}

export async function restoreHome(backup: string, home: string): Promise<void> {
  await rmRetry(home);
  await cp(backup, home, { recursive: true });
}

/** Applies extra SQL files after the product migrations. A failing file leaves its name unrecorded. */
export async function migrateExtra(home: string, files: { name: string; sql: string }[]): Promise<void> {
  const source = fileURLToPath(new URL("../src/db/migrations/", import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), "nema-mig-"));
  try {
    for (const name of (await readdir(source)).filter((item) => item.endsWith(".sql") && !item.startsWith("._"))) {
      await writeFile(path.join(dir, name), await readFile(path.join(source, name)));
    }
    for (const file of files) {
      if (!/^[\w.-]+\.sql$/.test(file.name)) throw new Error("invalid migration name");
      await writeFile(path.join(dir, file.name), file.sql);
    }
    const db = await createLocalDb(path.join(home, "db"));
    try {
      await migrate(db, dir);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function dataView(snapshot: HomeSnapshot): Omit<HomeSnapshot, "migrations" | "probeColumn"> {
  return { messages: snapshot.messages, threads: snapshot.threads, entries: snapshot.entries, commits: snapshot.commits };
}
