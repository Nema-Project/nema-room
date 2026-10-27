import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KIND_DIR } from "@nema/shared";
import { afterEach, describe, expect, it } from "vitest";
import { claimNextTask, finishTask, getTask, recordTaskChange } from "../src/tasks.js";
import { postUserMessage } from "../src/messages.js";
import { createWorkspace, deleteWorkspace, getWorkspace, listWorkspaces, repoPath, updateWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterEach(cleanupHubDeps);

describe("workspaces", () => {
  it("delete removes source evidence rows", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "A");
    await db.query("insert into evidence_events (id, workspace_id, kind, entry_id, content_hash, refs_hash, payload_hash, actor) values ('ev1', $1, 'confirm_entry', 'S-1', $2, $2, $2, 'user')", [ws.id, "a".repeat(64)]);
    await db.query("insert into source_import_receipts (workspace_id, provider, resource_id, revision_key, content_hash, phase) values ($1, 'test', 'r1', 'v1', $2, 'reserved')", [ws.id, "a".repeat(64)]);
    await db.query("insert into source_freshness (workspace_id, entry_id, freshness, reason, checked_at) values ($1, 'S-1', 'unknown', 'timeout', now())", [ws.id]);
    await deleteWorkspace(db, dataDir, ws.id);
    for (const table of ["evidence_events", "source_import_receipts", "source_freshness"]) expect(await db.query(`select 1 from ${table} where workspace_id = $1`, [ws.id])).toEqual([]);
    expect(await getWorkspace(db, ws.id)).toBeNull();
  });

  it("creates a workspace with defaults and an initialised repo", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "Acme");
    expect(ws.id).toMatch(/^ws_[A-Za-z0-9_-]{12}$/);
    expect(ws.confidential).toBe(true);
    expect(ws.knowledgeLanguage).toBe("follow");
    const repo = repoPath(dataDir, ws.id);
    expect(repo).toBe(path.join(dataDir, "repos", ws.id));
    expect(existsSync(path.join(repo, ".git"))).toBe(true);
    const dirs = Object.values(KIND_DIR);
    const present = dirs.filter((d) => existsSync(path.join(repo, d)));
    expect(present.length).toBe(dirs.length);
    expect(await getWorkspace(db, ws.id)).toEqual(ws);
  });

  it("updates workspace fields", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "A");
    const up = await updateWorkspace(db, ws.id, { confidential: false, knowledgeLanguage: "ja", name: "B" });
    expect(up).toMatchObject({ confidential: false, knowledgeLanguage: "ja", name: "B" });
    expect((await getWorkspace(db, ws.id))?.knowledgeLanguage).toBe("ja");
  });

  it("rejects invalid language and empty name", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "A");
    await expect(updateWorkspace(db, ws.id, { knowledgeLanguage: "fr" as never })).rejects.toThrow();
    await expect(updateWorkspace(db, ws.id, { name: "  " })).rejects.toThrow();
    await expect(createWorkspace(db, dataDir, "")).rejects.toThrow();
  });

  it("archive then unarchive", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "A");
    const archived = await updateWorkspace(db, ws.id, { archived: true });
    expect(archived.archivedAt).toBeTruthy();
    expect((await listWorkspaces(db)).map((w) => w.id)).toContain(ws.id);
    const back = await updateWorkspace(db, ws.id, { archived: false });
    expect(back.archivedAt).toBeNull();
  });

  it("delete removes rows, repo, isolation dir, and does not follow symlinks", async () => {
    const { db, dataDir } = await makeHubDeps();
    const nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
    const ws = await createWorkspace(db, dataDir, "A");
    const outsideRepo = path.join(dataDir, "outside-repo");
    const outsideAuth = path.join(dataDir, "outside-auth");
    // Windows cannot create file symlinks without privilege, so there the link targets are directories
    // (junctions); either way deletion must unlink the entry and leave the target alone.
    const link = (target: string, at: string) => (process.platform === "win32" ? symlinkSync(target, at, "junction") : symlinkSync(target, at));
    const targetFile = (target: string, text: string) => {
      if (process.platform === "win32") { mkdirSync(target); writeFileSync(path.join(target, "f"), text); } else writeFileSync(target, text);
    };
    const readTarget = (target: string) => readFileSync(process.platform === "win32" ? path.join(target, "f") : target, "utf8");
    targetFile(outsideRepo, "repo-target");
    targetFile(outsideAuth, "auth-target");
    const repo = repoPath(dataDir, ws.id);
    link(outsideRepo, path.join(repo, "link"));
    const codex = path.join(nemaHome, "ws", ws.id, "codex-home");
    mkdirSync(codex, { recursive: true });
    link(outsideAuth, path.join(codex, "auth.json"));
    await postUserMessage(db, ws.id, "memo");
    const task = (await claimNextTask(db, "d1"))!;
    await recordTaskChange(db, task.id, { entryId: "R-1", kind: "requirement", title: "t", op: "add" });
    expect(await finishTask(db, task.id, { ok: true })).toBe(true);

    await deleteWorkspace(db, dataDir, ws.id, nemaHome);

    expect(await getWorkspace(db, ws.id)).toBeNull();
    expect(existsSync(repo)).toBe(false);
    expect(existsSync(path.join(nemaHome, "ws", ws.id))).toBe(false);
    expect(readTarget(outsideRepo)).toBe("repo-target");
    expect(readTarget(outsideAuth)).toBe("auth-target");
  });

  it("delete without nemaHome (hub in a container) leaves the daemon's isolation dir to the daemon", async () => {
    const { db, dataDir } = await makeHubDeps();
    const nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
    const ws = await createWorkspace(db, dataDir, "A");
    const isolation = path.join(nemaHome, "ws", ws.id, "codex-home");
    mkdirSync(isolation, { recursive: true });
    await deleteWorkspace(db, dataDir, ws.id);
    expect(await getWorkspace(db, ws.id)).toBeNull();
    expect(existsSync(repoPath(dataDir, ws.id))).toBe(false);
    expect(existsSync(isolation)).toBe(true);
  });

  it("delete rejects a bad id without touching the filesystem", async () => {
    const { db, dataDir } = await makeHubDeps();
    const nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
    const sentinel = path.join(dataDir, "x");
    writeFileSync(sentinel, "keep");
    await expect(deleteWorkspace(db, dataDir, "ws_../x", nemaHome)).rejects.toThrow("invalid workspace id");
    expect(readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("delete and archive refuse only a running task", async () => {
    const { db, dataDir } = await makeHubDeps();
    const nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
    const ws = await createWorkspace(db, dataDir, "A");
    await postUserMessage(db, ws.id, "memo");
    const task = (await claimNextTask(db, "d1"))!;
    await expect(deleteWorkspace(db, dataDir, ws.id, nemaHome)).rejects.toThrow("workspace is busy");
    await expect(updateWorkspace(db, ws.id, { archived: true })).rejects.toThrow("workspace is busy");
    expect(await getWorkspace(db, ws.id)).not.toBeNull();
    expect(existsSync(repoPath(dataDir, ws.id))).toBe(true);
    expect(await finishTask(db, task.id, { ok: true })).toBe(true);
    expect((await updateWorkspace(db, ws.id, { archived: true })).archivedAt).toBeTruthy();
  });

  it("archive keeps queued tasks parked (not claimable) until unarchived", async () => {
    const { db, dataDir } = await makeHubDeps();
    const ws = await createWorkspace(db, dataDir, "A");
    const { task } = await postUserMessage(db, ws.id, "memo");
    expect((await updateWorkspace(db, ws.id, { archived: true })).archivedAt).toBeTruthy();
    expect(await getTask(db, task.id)).toMatchObject({ status: "queued" });
    expect(await claimNextTask(db, "d1")).toBeNull();
    await updateWorkspace(db, ws.id, { archived: false });
    expect((await claimNextTask(db, "d1"))?.id).toBe(task.id);
  });

  it("delete removes queued tasks and their changes in the same transaction", async () => {
    const { db, dataDir } = await makeHubDeps();
    const nemaHome = await mkdtemp(path.join(tmpdir(), "nema-home-"));
    const ws = await createWorkspace(db, dataDir, "A");
    const { task } = await postUserMessage(db, ws.id, "memo");
    await recordTaskChange(db, task.id, { entryId: "R-1", kind: "requirement", title: "t", op: "add" });
    await deleteWorkspace(db, dataDir, ws.id, nemaHome);
    expect(await getWorkspace(db, ws.id)).toBeNull();
    expect(await getTask(db, task.id)).toBeNull();
    expect(await db.query("select 1 from task_changes where task_id = $1", [task.id])).toHaveLength(0);
  });

  it("lists by creation time", async () => {
    const { db, dataDir } = await makeHubDeps();
    const a = await createWorkspace(db, dataDir, "first");
    const b = await createWorkspace(db, dataDir, "second");
    expect((await listWorkspaces(db)).map((w) => w.id)).toEqual([a.id, b.id]);
  });
});

describe("Db.tx nesting", () => {
  const count = async (db: import("../src/db/db.js").Db) =>
    Number((await db.query<{ n: string }>("select count(*)::int as n from workspaces"))[0]!.n);
  const ins = (db: import("../src/db/db.js").Db, id: string) =>
    db.query("insert into workspaces(id, name) values ($1, 'x')", [id]);

  it("rolls back inner and outer when the outer fn throws", async () => {
    const { db } = await makeHubDeps();
    await expect(
      db.tx(async (t) => {
        await ins(t, "a");
        await t.tx((t2) => ins(t2, "b"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await count(db)).toBe(0);
  });

  it("commits a successful nested tx", async () => {
    const { db } = await makeHubDeps();
    await db.tx(async (t) => {
      await ins(t, "a");
      await t.tx((t2) => ins(t2, "b"));
    });
    expect(await count(db)).toBe(2);
  });
});
