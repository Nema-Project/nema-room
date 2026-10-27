import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { KnowledgeStore, git, withRepoLock } from "@nema/knowledge";
import { canonicalJson, EntryFrontmatter, SourceSnapshot, type Entry } from "@nema/shared";
import type { Db } from "./db/db.js";
import { sha256 } from "./db/snapshot.js";
import { indexEntry } from "./entryIndex.js";
import { repoPath } from "./workspaces.js";

export class SourceImportError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
type Receipt = {
  workspace_id: string; provider: string; resource_id: string; revision_key: string;
  content_hash: string; entry_id: string | null; phase: "reserved" | "committed" | "indexed"; knowledge_commit: string | null;
};
type Index = typeof indexEntry;
const where = "workspace_id=$1 and provider=$2 and resource_id=$3 and revision_key=$4 and content_hash=$5";
const keys = (r: Receipt) => [r.workspace_id, r.provider, r.resource_id, r.revision_key, r.content_hash];
const conflict = (id: string) => new SourceImportError(409, `导入记录与知识库不一致：${id}`);
function checkResource(entry: Entry | null, r: Receipt): void {
  if (entry && (entry.kind !== "source" || entry.sourceSnapshot?.provider !== r.provider || entry.sourceSnapshot.resourceId !== r.resource_id)) throw conflict(r.entry_id!);
  if (entry?.status === "dropped") throw new SourceImportError(409, "来源已撤回，不能重新导入");
}
async function markCommitted(db: Db, r: Receipt, commit: string): Promise<void> {
  await db.tx(async t => { await t.query(`update source_import_receipts set phase='committed',knowledge_commit=$6 where ${where}`, [...keys(r), commit]); });
  r.phase = "committed"; r.knowledge_commit = commit;
}
async function finish(db: Db, r: Receipt, entry: Entry, index: Index): Promise<void> {
  try { await index(db, r.workspace_id, entry); }
  catch { throw new SourceImportError(500, `导入已写入知识库但索引未完成：${entry.id}`); }
  await db.query(`update source_import_receipts set phase='indexed' where ${where}`, keys(r));
}
/** Recover only the receipt's recorded blob, never infer an import from unrelated history. */
async function recover(db: Db, repo: string, store: KnowledgeStore, r: Receipt): Promise<Entry | null> {
  if (!r.entry_id) return null;
  let entry = await store.get(r.entry_id);
  checkResource(entry, r);
  const relative = `sources/${r.entry_id}.md`;
  let restored = false;
  if (!entry && r.phase === "committed" && r.knowledge_commit) {
    let blob: string | null = null;
    try {
      await git(repo, ["cat-file", "-e", `${r.knowledge_commit}:${relative}`]);
      blob = await git(repo, ["show", `${r.knowledge_commit}:${relative}`]);
    } catch { /* A missing blob is rewritten by the next import using the reserved id. */ }
    if (blob !== null) {
      const file = path.join(repo, relative), temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, blob); await rename(temporary, file);
      entry = await store.get(r.entry_id); checkResource(entry, r);
      restored = true;
    }
  }
  if (!entry || entry.sourceSnapshot?.contentHash !== r.content_hash) return null;
  // A parseable working file alone is insufficient evidence of a successful Git commit.
  let commit: string;
  try {
    commit = restored ? r.knowledge_commit! : (await git(repo, ["log", "-1", "--format=%H", "--", relative])).trim();
    const committed = await git(repo, ["show", `${commit}:${relative}`]);
    const current = await readFile(path.join(repo, relative), "utf8");
    if (committed !== current) return null;
  } catch { return null; }
  await markCommitted(db, r, commit);
  return entry;
}

export async function importSourceSnapshot(db: Db, dataDir: string, workspaceId: string, input: unknown, index: Index = indexEntry): Promise<{ entry: Entry; commit: string; alreadyImported: boolean }> {
  const parsed = SourceSnapshot.safeParse(typeof input === "object" && input !== null ? { ...input, fetchedAt: new Date().toISOString() } : input);
  if (!parsed.success) throw new SourceImportError(400, parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const snapshot = parsed.data;
  const { fetchedAt: _fetchedAt, contentHash: _contentHash, ...payload } = snapshot;
  if (sha256(canonicalJson(payload)) !== snapshot.contentHash) throw new SourceImportError(400, "contentHash: hash mismatch");
  const repo = repoPath(dataDir, workspaceId), store = new KnowledgeStore(repo);
  return withRepoLock(repo, async () => {
    const args = [workspaceId, snapshot.provider, snapshot.resourceId, snapshot.revision ?? "", snapshot.contentHash];
    const r = await db.tx(async t => {
      await t.query("insert into source_import_receipts(workspace_id,provider,resource_id,revision_key,content_hash,phase) values ($1,$2,$3,$4,$5,'reserved') on conflict do nothing", args);
      return (await t.query<Receipt>(`select * from source_import_receipts where ${where} for update`, args))[0]!;
    });
    if (!r.entry_id) {
      const names = await readdir(path.join(repo, "sources"));
      const reserved = await db.query<{ entry_id: string | null }>("select entry_id from source_import_receipts where workspace_id=$1", [workspaceId]);
      let max = 0, found: string | undefined;
      for (const name of names) {
        const match = /^S-([1-9]\d*)\.md$/.exec(name); if (!match) continue;
        max = Math.max(max, Number(match[1]));
        const e = await store.get(name.slice(0, -3));
        if (e?.sourceSnapshot?.provider === snapshot.provider && e.sourceSnapshot.resourceId === snapshot.resourceId) found = e.id;
      }
      // Failed writes still reserve ids, even for a different resource.
      for (const row of reserved) if (row.entry_id) max = Math.max(max, Number(row.entry_id.slice(2)) || 0);
      // A prior failed hash of this resource must also reuse its reservation.
      const prior = await db.query<{ entry_id: string }>("select entry_id from source_import_receipts where workspace_id=$1 and provider=$2 and resource_id=$3 and entry_id is not null order by created_at limit 1", args.slice(0, 3));
      r.entry_id = found ?? prior[0]?.entry_id ?? `S-${max + 1}`;
      await db.query(`update source_import_receipts set entry_id=$6 where ${where}`, [...keys(r), r.entry_id]);
    }
    const previousPhase = r.phase;
    const recovered = await recover(db, repo, store, r);
    if (recovered) {
      await finish(db, r, recovered, index);
      return { entry: recovered, commit: r.knowledge_commit!, alreadyImported: previousPhase === "indexed" };
    }
    const existing = await store.get(r.entry_id); checkResource(existing, r);
    const now = new Date().toISOString();
    const entry: Entry = {
      ...EntryFrontmatter.parse(existing ?? { id: r.entry_id, kind: "source", sourceSnapshot: snapshot, title: snapshot.title, status: "active", basis: "inferred", businessDate: null, related: [], ingestedAt: now, confirmedAt: now, sourceMessages: [], quotes: [], confirmedRevision: null }),
      title: snapshot.title,
      url: snapshot.canonicalUrl ?? undefined,
      sourceSnapshot: snapshot,
      body: `Imported source. provider=${snapshot.provider} resource=${snapshot.resourceId}`,
    };
    await db.query(`update source_import_receipts set phase='reserved',knowledge_commit=null where ${where}`, keys(r));
    const commit = await store.writeImportedSource(entry);
    await markCommitted(db, r, commit);
    await finish(db, r, entry, index);
    return { entry, commit, alreadyImported: false };
  });
}

export async function reconcileSourceImports(db: Db, dataDir: string, workspaceId: string): Promise<void> {
  const repo = repoPath(dataDir, workspaceId), store = new KnowledgeStore(repo);
  await withRepoLock(repo, async () => {
    const receipts = await db.query<Receipt>("select * from source_import_receipts where workspace_id=$1 and phase <> 'indexed' order by created_at", [workspaceId]);
    for (const r of receipts) {
      const entry = await recover(db, repo, store, r);
      if (entry) await finish(db, r, entry, indexEntry);
    }
  });
}
