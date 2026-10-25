import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { TABLE_COLUMNS, TABLE_ORDER, type KnowledgeManifestEntry, type Snapshot, sha256, validateSnapshot } from "./snapshot.js";

const execFileAsync = promisify(execFile);
type Quiesced = <T>(workspaceIds: string[], copyWhileQuiesced: () => Promise<T>) => Promise<T>;
export type SnapshotExportOptions = {
  pool: Pool;
  dataDir: string;
  outputDir: string;
  appVersion: string;
  gitPath: string;
  withQuiescedKnowledge: Quiesced;
  settings?: Snapshot["settings"];
};

const gitEnv = (emptyConfig: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: emptyConfig,
  USERPROFILE: emptyConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
});

function git(gitPath: string, cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  return execFileAsync(gitPath, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout);
}

/** Only the keys Git itself writes for a plain clone are accepted; hooks, helpers, filters, includes and aliases are not. */
const SAFE_CONFIG: Record<string, ReadonlySet<string>> = {
  core: new Set(["repositoryformatversion", "filemode", "bare", "logallrefupdates", "ignorecase", "symlinks", "precomposeunicode", "autocrlf", "safecrlf", "eol"]),
  remote: new Set(["url", "fetch", "tagopt"]),
  branch: new Set(["remote", "merge"]),
  user: new Set(["name", "email"]),
};

function onlySafeGitConfig(config: string): boolean {
  let section: string | undefined;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[\s*([A-Za-z0-9-]+)(?:\s+"[^"\\]*")?\s*\]$/.exec(line);
    if (header) { section = header[1]!.toLowerCase(); if (!SAFE_CONFIG[section]) return false; continue; }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=/.exec(line);
    if (!section || !entry || !SAFE_CONFIG[section]!.has(entry[1]!.toLowerCase())) return false;
  }
  return true;
}

async function safeKnowledge(workspaceId: string, repoDir: string, outBundle: string, gitPath: string, env: NodeJS.ProcessEnv): Promise<KnowledgeManifestEntry> {
  const st = await lstat(repoDir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Knowledge repository is not a real directory: ${workspaceId}`);
  const canonical = await realpath(repoDir);
  const status = await git(gitPath, canonical, env, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) throw new Error(`Knowledge repository is not quiesced and clean: ${workspaceId}`);
  const cfgPath = path.join(canonical, ".git", "config");
  const cfgStat = await lstat(cfgPath);
  if (!cfgStat.isFile() || cfgStat.isSymbolicLink()) throw new Error(`Unsafe Git config for ${workspaceId}`);
  const cfg = await readFile(cfgPath, "utf8");
  if (!onlySafeGitConfig(cfg)) throw new Error(`Git config contains executable or credential settings: ${workspaceId}`);
  for (const remote of cfg.matchAll(/^\s*url\s*=\s*(\S+)/gim)) {
    try { const url = new URL(remote[1]!); if (url.username || url.password) throw new Error("credential-bearing remote"); } catch (error) {
      if (String(error).includes("credential-bearing")) throw new Error(`Git remote contains credentials: ${workspaceId}`);
    }
  }
  const refsRaw = await git(gitPath, canonical, env, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  const refs = Object.fromEntries(refsRaw.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, sha] = line.split(" ");
    if (!ref || !sha || !/^refs\/(heads|tags)\//.test(ref) || !/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`Unsafe Git ref: ${workspaceId}`);
    return [ref, sha.toLowerCase()];
  }));
  const head = (await git(gitPath, canonical, env, ["rev-parse", "HEAD"])).trim().toLowerCase();
  const tree = await git(gitPath, canonical, env, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  for (const record of tree.split("\0").filter(Boolean)) {
    const mode = record.slice(0, record.indexOf(" "));
    const name = record.slice(record.indexOf("\t") + 1);
    if (mode === "120000" || name.split("/").some((part) => part === ".." || part === ".git")) throw new Error(`Unsafe knowledge tree entry in ${workspaceId}`);
  }
  await git(gitPath, canonical, env, ["bundle", "create", outBundle, "--all"]);
  const bundleHash = sha256(await readFile(outBundle));
  return { workspaceId, path: `repos/${workspaceId}`, bundle: `knowledge/${workspaceId}.bundle`, sha256: bundleHash, refs, head };
}

/** Export from a caller-selected Pool and directory. Caller must stop all legacy writers for the whole callback. */
export async function exportSnapshot(options: SnapshotExportOptions): Promise<Snapshot> {
  const { pool, dataDir, outputDir, appVersion, gitPath } = options;
  if (!pool || !path.isAbsolute(dataDir) || !path.isAbsolute(outputDir) || !path.isAbsolute(gitPath)) throw new Error("Export requires explicit absolute database, data, output, and bundled Git paths");
  const parent = path.dirname(outputDir);
  await mkdir(parent, { recursive: true });
  await mkdir(outputDir, { recursive: false, mode: 0o700 });
  const knowledgeDir = path.join(outputDir, "knowledge");
  await mkdir(knowledgeDir, { mode: 0o700 });
  const client: PoolClient = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const isolation = await client.query<{ transaction_isolation: string }>("show transaction_isolation");
    if (isolation.rows[0]?.transaction_isolation !== "repeatable read") throw new Error("Source database did not enter repeatable-read isolation");
    const rows: Snapshot["tableData"] = {};
    for (const table of TABLE_ORDER) {
      // A date column would be read as a local-midnight Date and shift by the machine time zone; ship it as text.
      const columns = TABLE_COLUMNS[table].map((c) => (c === "business_date" ? `to_char("${c}", 'YYYY-MM-DD') as "${c}"` : `"${c}"`)).join(", ");
      const result = await client.query(`select ${columns} from "${table}"`);
      rows[table] = result.rows as Record<string, unknown>[];
    }
    const workspaceIds = rows.workspaces!.map((r) => String(r.id));
    const snapshot = await options.withQuiescedKnowledge(workspaceIds, async () => {
      const manifest: KnowledgeManifestEntry[] = [];
      for (const id of workspaceIds) manifest.push(await safeKnowledge(id, path.join(dataDir, "repos", id), path.join(knowledgeDir, `${id}.bundle`), gitPath, gitEnv(outputDir)));
      const value: Snapshot = { schemaVersion: 1, appVersion, tableData: rows, knowledgeManifest: manifest, ...(options.settings ? { settings: options.settings } : {}) };
      const validated = validateSnapshot(value);
      await writeFile(path.join(outputDir, "snapshot.json"), `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return validated;
    });
    await client.query("commit");
    return snapshot;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally { client.release(); }
}
