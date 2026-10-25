import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { createLocalDb } from "@nema/hub/db/local";
import { acquireInstance } from "./instance.js";
import { readSnapshot, TABLE_COLUMNS, TABLE_ORDER, type Snapshot } from "./migration.js";
import { resolveHome, type HomePaths } from "./paths.js";

const execFileAsync = promisify(execFile);
const MARKER = "import.json";

export type ImportSummary = {
  appVersion: string;
  workspaces: number;
  messages: number;
  tasks: number;
  knowledgeRepos: number;
  /** Validated optional settings from the snapshot. Returned for the caller to apply; never applied or merged with credentials here. */
  settings?: Snapshot["settings"];
};

export type ImportOptions = {
  /** The bundled Git. Defaults to `git` from PATH. */
  gitPath?: string;
  installationId?: string;
  /** Test seams only. */
  hooks?: { beforeActivate?: () => Promise<void>; afterDatabaseActivated?: () => Promise<void> };
};

function gitEnv(emptyHome: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: emptyHome,
    USERPROFILE: emptyHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

async function git(gitPath: string, cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const result = await execFileAsync(gitPath, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return result.stdout;
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Rebuild one knowledge repository from its verified bundle. Imported hooks, config and remotes are never taken. */
async function restoreKnowledge(gitPath: string, bundle: string, destination: string, emptyHome: string, expected: Snapshot["knowledgeManifest"][number]): Promise<void> {
  const env = gitEnv(emptyHome);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await git(gitPath, destination, env, ["init", "-q", "--template="]);
  await git(gitPath, destination, env, ["bundle", "verify", bundle]);
  await git(gitPath, destination, env, ["fetch", "-q", "--no-tags", bundle, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"]);
  const head = Object.entries(expected.refs).find(([ref, sha]) => ref.startsWith("refs/heads/") && sha.toLowerCase() === expected.head.toLowerCase());
  if (head) await git(gitPath, destination, env, ["symbolic-ref", "HEAD", head[0]]);
  else await git(gitPath, destination, env, ["update-ref", "--no-deref", "HEAD", expected.head]);
  await git(gitPath, destination, env, ["reset", "-q", "--hard", "HEAD"]);
  const refsRaw = await git(gitPath, destination, env, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  const actual = Object.fromEntries(refsRaw.trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(" ") as [string, string]));
  const wanted = Object.fromEntries(Object.entries(expected.refs).map(([ref, sha]) => [ref, sha.toLowerCase()]));
  if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(wanted).sort())) throw new Error(`Knowledge Git refs do not match the manifest: ${expected.workspaceId}`);
  if ((await git(gitPath, destination, env, ["rev-parse", "HEAD"])).trim().toLowerCase() !== expected.head.toLowerCase()) throw new Error(`Knowledge Git HEAD does not match the manifest: ${expected.workspaceId}`);
  await git(gitPath, destination, env, ["fsck", "--strict", "--no-dangling"]);
}

type Column = { table_name: string; column_name: string; data_type: string; udt_name: string };

async function loadDatabase(dbDir: string, snapshot: Snapshot): Promise<void> {
  const db = await createLocalDb(dbDir);
  try {
    const columns = await db.query<Column>("select table_name, column_name, data_type, udt_name from information_schema.columns where table_schema = 'public'");
    const typeOf = (table: string, column: string): Column => {
      const found = columns.find((c) => c.table_name === table && c.column_name === column);
      if (!found) throw new Error(`Snapshot column is not in the current schema: ${table}.${column}`);
      return found;
    };
    await db.tx(async (tx) => {
      for (const table of TABLE_ORDER) {
        for (const row of snapshot.tableData[table]!) {
          const names = (TABLE_COLUMNS[table] as readonly string[]).filter((name) => row[name] !== undefined);
          if (names.length === 0) continue;
          const placeholders: string[] = [];
          const values: unknown[] = [];
          for (const name of names) {
            const meta = typeOf(table, name);
            let value = row[name] ?? null;
            // Credentials and process ownership never migrate: old run tokens stay dead and the runtime requeues running tasks on reopen.
            if (table === "tasks" && (name === "run_token" || name === "daemon_id")) value = null;
            const index = values.length + 1;
            if (value !== null && (meta.data_type === "jsonb" || meta.data_type === "json")) {
              values.push(JSON.stringify(value));
              placeholders.push(`$${index}::${meta.udt_name}`);
            } else if (meta.data_type === "ARRAY") {
              values.push(value);
              placeholders.push(`$${index}::${meta.udt_name.replace(/^_/, "")}[]`);
            } else {
              values.push(value);
              placeholders.push(`$${index}`);
            }
          }
          await tx.query(`insert into "${table}" (${names.map((n) => `"${n}"`).join(", ")}) values (${placeholders.join(", ")})`, values);
        }
      }
      const serials = await tx.query<{ table_name: string; column_name: string }>(
        `select c.table_name, c.column_name from information_schema.columns c
           where c.table_schema = 'public' and pg_get_serial_sequence('"' || c.table_name || '"', c.column_name) is not null`,
      );
      for (const { table_name, column_name } of serials) {
        await tx.query(
          `select setval(pg_get_serial_sequence('"${table_name}"', '${column_name}'), coalesce(max("${column_name}"), 1), max("${column_name}") is not null) from "${table_name}"`,
        );
      }
    });
    for (const table of TABLE_ORDER) {
      const [count] = await db.query<{ n: string }>(`select count(*)::text as n from "${table}"`);
      if (Number(count?.n) !== snapshot.tableData[table]!.length) throw new Error(`Imported row count differs from the snapshot: ${table}`);
    }
  } finally {
    await db.close();
  }
}

type Marker = { state: "activating"; staging: string };

async function readMarker(paths: HomePaths): Promise<Marker | null> {
  try {
    const value = JSON.parse(await readFile(join(paths.home, MARKER), "utf8")) as Marker;
    if (value.state !== "activating" || typeof value.staging !== "string" || basename(value.staging) !== value.staging || !value.staging.startsWith(".import-")) throw new Error("bad marker");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Interrupted import marker is unreadable; the destination was left untouched");
  }
}

/** Finish or report an import that stopped between its two directory moves. Never guesses at a partial destination. */
export async function recoverInterruptedImport(home: string, options: Pick<ImportOptions, "installationId"> = {}): Promise<"none" | "recovered"> {
  const paths = resolveHome(home);
  const lease = await acquireInstance(paths.home, options.installationId);
  try {
    const marker = await readMarker(paths);
    if (!marker) return "none";
    const staging = join(paths.home, marker.staging);
    for (const [name, destination] of [["db", paths.db], ["data", paths.data]] as const) {
      const source = join(staging, name);
      if (existsSync(source) && !existsSync(destination)) await rename(source, destination);
      else if (!existsSync(destination)) throw new Error(`Interrupted import cannot be recovered: ${name} is missing from both staging and destination`);
    }
    await rm(join(paths.home, MARKER), { force: true });
    await rm(staging, { recursive: true, force: true });
    return "recovered";
  } finally {
    await lease.close();
  }
}

/**
 * Copy an exported snapshot into an empty, stopped desktop home. Everything is built and verified in a staging
 * directory under the single-owner lease; only then are the two directories moved into place. A failure before that
 * leaves the destination exactly as it was.
 */
export async function importLegacySnapshot(sourceDir: string, destinationHome: string, options: ImportOptions = {}): Promise<ImportSummary> {
  if (!isAbsolute(sourceDir) || !isAbsolute(destinationHome)) throw new Error("Import requires explicit absolute source and destination paths");
  const paths = resolveHome(destinationHome);
  const lease = await acquireInstance(paths.home, options.installationId);
  let staging: string | undefined;
  try {
    if (await readMarker(paths)) throw new Error("An interrupted import was found; run recoverInterruptedImport before importing again");
    if (!(await isEmptyOrMissing(paths.db)) || !(await isEmptyOrMissing(paths.data))) throw new Error("Import destination is not empty");
    for (const name of await readdir(paths.home)) if (name.startsWith(".import-")) await rm(join(paths.home, name), { recursive: true, force: true });

    const snapshot = await readSnapshot(sourceDir);
    const gitPath = options.gitPath ?? "git";
    staging = join(paths.home, `.import-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    const emptyHome = join(staging, "git-home");
    await mkdir(emptyHome);
    const knowledgeDir = join(staging, "data", "repos");
    await mkdir(knowledgeDir, { recursive: true, mode: 0o700 });
    for (const item of snapshot.knowledgeManifest) {
      await restoreKnowledge(gitPath, join(sourceDir, "knowledge", basename(item.bundle)), join(knowledgeDir, item.workspaceId), emptyHome, item);
    }
    await rm(emptyHome, { recursive: true, force: true });
    await loadDatabase(join(staging, "db"), snapshot);

    await options.hooks?.beforeActivate?.();
    await writeFile(join(paths.home, MARKER), JSON.stringify({ state: "activating", staging: basename(staging) } satisfies Marker), { mode: 0o600 });
    for (const [name, destination] of [["db", paths.db], ["data", paths.data]] as const) {
      if (existsSync(destination)) await rmdir(destination);
      await rename(join(staging, name), destination);
      if (name === "db") await options.hooks?.afterDatabaseActivated?.();
    }
    await rm(join(paths.home, MARKER), { force: true });
    await rm(staging, { recursive: true, force: true });
    staging = undefined;
    return {
      appVersion: snapshot.appVersion,
      workspaces: snapshot.tableData.workspaces!.length,
      messages: snapshot.tableData.messages!.length,
      tasks: snapshot.tableData.tasks!.length,
      knowledgeRepos: snapshot.knowledgeManifest.length,
      ...(snapshot.settings ? { settings: snapshot.settings } : {}),
    };
  } catch (error) {
    // Once the marker exists the staging directory is the recovery source; before that it is just scratch.
    if (staging && !existsSync(join(paths.home, MARKER))) await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await lease.close();
  }
}
