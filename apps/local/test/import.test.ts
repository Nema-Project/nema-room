import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDb, createTestDb } from "@nema/hub/db/local";
import { exportSnapshot } from "@nema/hub/db/export";
import { importLegacySnapshot, recoverInterruptedImport } from "../src/import.js";
import { acquireInstance } from "../src/instance.js";

const gitPath = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).split("\n")[0]!.trim();
let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "nema-import-test-"))); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();

/** A source database with one workspace, two tasks (one still running), a real knowledge repo and no credentials. */
async function makeSource(): Promise<{ outputDir: string; shas: string[]; knowledgeHead: string }> {
  const db = await createTestDb();
  await db.query(`insert into workspaces (id, name, confidential, knowledge_language) values ('ws_a', 'Alpha', true, 'ja')`);
  await db.query(`insert into messages (id, workspace_id, role, content, meta, task_id) values ('m1', 'ws_a', 'user', '日本語の要件', '{"k":[1,2]}', null)`);
  await db.query(`insert into tasks (id, workspace_id, message_id, status, run_token, daemon_id) values ('t1', 'ws_a', 'm1', 'running', 'old-secret-run-token', 'd1')`);
  await db.query(`insert into tasks (id, workspace_id, message_id, status) values ('t2', 'ws_a', 'm1', 'done')`);
  await db.query(`insert into task_changes (task_id, entry_id, kind, title, op) values ('t2', 'e1', 'requirement', 'T', 'add')`);
  await db.query(`insert into entry_index (workspace_id, entry_id, kind, title, status, priority, business_date) values ('ws_a', 'e1', 'requirement', 'T', 'open', 2, '2026-10-24')`);
  await db.query(`insert into workspace_plugins (workspace_id, plugin_id, enabled, disabled_functions, settings) values ('ws_a', 'github', true, '{github__list_issues}', '{"allowWrites":true}')`);

  const dataDir = join(root, "legacy-data");
  const repo = join(dataDir, "repos", "ws_a");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "e1.md"), "first\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "one");
  const first = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "e1.md"), "second\n");
  git(repo, "commit", "-q", "-am", "two");
  git(repo, "tag", "v1", first);

  const pool = {
    async connect() {
      return {
        async query(sql: string, params?: unknown[]) { return { rows: await db.query(sql, params) }; },
        release() {},
      };
    },
  } as unknown as Pool;
  const outputDir = join(root, "snapshot");
  await exportSnapshot({
    pool, dataDir, outputDir, appVersion: "0.1.0", gitPath,
    withQuiescedKnowledge: (_ids, copy) => copy(),
    settings: { adapter: "codex-direct", authMode: "siwc", reasoningEffort: "medium" },
  });
  return { outputDir, shas: [first, git(repo, "rev-parse", "HEAD")], knowledgeHead: git(repo, "rev-parse", "HEAD") };
}

const homeOf = () => join(root, "home");

describe("importLegacySnapshot", () => {
  it("restores rows, Git history and settings, and drops old run tokens and credentials", async () => {
    const { outputDir, shas } = await makeSource();
    const summary = await importLegacySnapshot(outputDir, homeOf(), { gitPath });
    expect(summary).toMatchObject({ appVersion: "0.1.0", workspaces: 1, messages: 1, tasks: 2, knowledgeRepos: 1, settings: { adapter: "codex-direct", authMode: "siwc" } });

    const db = await createLocalDb(join(homeOf(), "db"));
    try {
      expect(await db.query("select id, content, meta from messages")).toEqual([{ id: "m1", content: "日本語の要件", meta: { k: [1, 2] } }]);
      expect(await db.query("select id, status, run_token, daemon_id from tasks order by id")).toEqual([
        { id: "t1", status: "running", run_token: null, daemon_id: null },
        { id: "t2", status: "done", run_token: null, daemon_id: null },
      ]);
      expect(await db.query<{ d: string }>("select to_char(business_date, 'YYYY-MM-DD') as d from entry_index")).toEqual([{ d: "2026-10-24" }]);
      expect(await db.query("select disabled_functions, settings from workspace_plugins")).toEqual([{ disabled_functions: ["github__list_issues"], settings: { allowWrites: true } }]);
      // New rows continue after the imported sequence values instead of colliding.
      await db.query(`insert into messages (id, workspace_id, role, content) values ('m2', 'ws_a', 'user', 'next')`);
      const seqs = await db.query<{ seq: string }>("select seq::text from messages order by seq");
      expect(Number(seqs[1]!.seq)).toBeGreaterThan(Number(seqs[0]!.seq));
    } finally { await db.close(); }

    const repo = join(homeOf(), "data", "repos", "ws_a");
    expect(git(repo, "rev-parse", "HEAD")).toBe(shas[1]);
    expect(git(repo, "rev-parse", "v1")).toBe(shas[0]);
    expect(git(repo, "remote")).toBe("");
    expect(readFileSync(join(repo, "e1.md"), "utf8")).toBe("second\n");
    expect(readdirSync(homeOf()).filter((name) => name !== "instance.json").sort()).toEqual(["data", "db"]);
  });

  it("refuses a partial or tampered snapshot and leaves the destination untouched", async () => {
    const { outputDir } = await makeSource();
    const bundle = join(outputDir, "knowledge", "ws_a.bundle");
    writeFileSync(bundle, `${readFileSync(bundle, "utf8")}x`);
    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(/hash/i);
    expect(existsSync(join(homeOf(), "db"))).toBe(false);
    expect(existsSync(join(homeOf(), "data"))).toBe(false);
    expect(readdirSync(homeOf()).some((name) => name.startsWith(".import-"))).toBe(false);

    rmSync(join(outputDir, "snapshot.json"));
    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow();
    expect(existsSync(join(homeOf(), "db"))).toBe(false);
  });

  it("refuses unexpected snapshot entries and a symlinked bundle", async () => {
    const { outputDir } = await makeSource();
    writeFileSync(join(outputDir, "auth.json"), "{}");
    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(/unexpected/i);
    rmSync(join(outputDir, "auth.json"));

    const bundle = join(outputDir, "knowledge", "ws_a.bundle");
    const real = join(root, "elsewhere.bundle");
    writeFileSync(real, readFileSync(bundle));
    rmSync(bundle);
    try { symlinkSync(real, bundle, "file"); } catch { return; /* symlinks need privilege on Windows; the unexpected-entry check above still ran */ }
    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(/unsafe/i);
    expect(existsSync(join(homeOf(), "db"))).toBe(false);
  });

  it("refuses a non-empty destination and a running instance without changing either", async () => {
    const { outputDir } = await makeSource();
    mkdirSync(join(homeOf(), "db"), { recursive: true });
    writeFileSync(join(homeOf(), "db", "PG_VERSION"), "existing");
    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(/not empty/i);
    expect(readFileSync(join(homeOf(), "db", "PG_VERSION"), "utf8")).toBe("existing");
    rmSync(join(homeOf(), "db"), { recursive: true });

    const lease = await acquireInstance(homeOf());
    try { await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(); }
    finally { await lease.close(); }
    expect(existsSync(join(homeOf(), "db"))).toBe(false);
  });

  it("marks an interrupted activation, refuses to import over it, and recovers it explicitly", async () => {
    const { outputDir } = await makeSource();
    await expect(importLegacySnapshot(outputDir, homeOf(), {
      gitPath,
      hooks: { afterDatabaseActivated: async () => { throw new Error("simulated crash"); } },
    })).rejects.toThrow(/simulated crash/);
    expect(existsSync(join(homeOf(), "db"))).toBe(true);
    expect(existsSync(join(homeOf(), "data"))).toBe(false);

    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(/interrupted/i);
    expect(await recoverInterruptedImport(homeOf())).toBe("recovered");
    expect(existsSync(join(homeOf(), "data", "repos", "ws_a"))).toBe(true);
    expect(await recoverInterruptedImport(homeOf())).toBe("none");
    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(/not empty/i);
  });
});

describe("exportSnapshot refusals", () => {
  async function exportWith(prepare: (repo: string) => void) {
    const db = await createTestDb();
    await db.query(`insert into workspaces (id, name) values ('ws_a', 'Alpha')`);
    const dataDir = join(root, "legacy-data");
    const repo = join(dataDir, "repos", "ws_a");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "e1.md"), "x\n");
    git(repo, "add", "."); git(repo, "commit", "-q", "-m", "one");
    prepare(repo);
    const pool = { async connect() { return { async query(sql: string, params?: unknown[]) { return { rows: await db.query(sql, params) }; }, release() {} }; } } as unknown as Pool;
    return exportSnapshot({ pool, dataDir, outputDir: join(root, "out"), appVersion: "0.1.0", gitPath, withQuiescedKnowledge: (_ids, copy) => copy() });
  }

  it("refuses a repository with uncommitted changes", async () => {
    await expect(exportWith((repo) => writeFileSync(join(repo, "dirty.md"), "d"))).rejects.toThrow(/quiesced/i);
  });

  it("refuses executable or credential-bearing Git configuration", async () => {
    await expect(exportWith((repo) => git(repo, "config", "credential.helper", "store"))).rejects.toThrow(/executable or credential/i);
  });

  it("refuses a remote that embeds credentials", async () => {
    await expect(exportWith((repo) => git(repo, "remote", "add", "origin", "https://user:secret@example.test/r.git"))).rejects.toThrow(/credentials/i);
  });
});

describe("snapshot path safety", () => {
  it("refuses a knowledge directory that is a junction or symlink to somewhere else", async () => {
    const { outputDir } = await makeSource();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "ws_a.bundle"), readFileSync(join(outputDir, "knowledge", "ws_a.bundle")));
    rmSync(join(outputDir, "knowledge"), { recursive: true });
    symlinkSync(elsewhere, join(outputDir, "knowledge"), "junction");
    await expect(importLegacySnapshot(outputDir, homeOf(), { gitPath })).rejects.toThrow(/unsafe/i);
    expect(existsSync(join(homeOf(), "db"))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual(["ws_a.bundle"]);
  });
});
