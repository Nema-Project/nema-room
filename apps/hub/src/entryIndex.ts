import type { Entry, EntrySummary } from "@nema/shared";
import { KnowledgeStore } from "@nema/knowledge";
import type { Db } from "./db/db.js";
import { repoPath } from "./workspaces.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export async function indexEntry(db: Db, workspaceId: string, entry: Entry, ownedHelpers?: OwnedHelperScope): Promise<void> {
  await db.query(
    `insert into entry_index(workspace_id, entry_id, kind, title, status, priority, business_date, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
     on conflict (workspace_id, entry_id) do update set
       kind = excluded.kind, title = excluded.title, status = excluded.status,
       priority = excluded.priority, business_date = excluded.business_date, updated_at = clock_timestamp()`,
    [workspaceId, entry.id, entry.kind, entry.title, entry.status, entry.priority ?? null, entry.businessDate],
  );
}

/** Order comes from the index; full summaries (url, related) are hydrated from the store. Entries missing from the store are skipped. */
export async function timeline(db: Db, dataDir: string, workspaceId: string, ownedHelpers?: OwnedHelperScope): Promise<EntrySummary[]> {
  const rows = await db.query<{ entry_id: string }>(
    `select entry_id from entry_index where workspace_id = $1
     order by business_date asc nulls last, updated_at asc, entry_id asc`,
    [workspaceId],
  );
  const byId = new Map((await new KnowledgeStore(repoPath(dataDir, workspaceId), ownedHelpers).list()).map((e) => [e.id, e]));
  return withDiagramStatus(
    db,
    workspaceId,
    rows.flatMap((r) => {
      const s = byId.get(r.entry_id);
      return s ? [s] : [];
    }),
  );
}

/** Gives each diagram summary its `stale` flag from `diagram_status`; a diagram with no row is not stale. */
export async function withDiagramStatus<T extends EntrySummary>(db: Db, workspaceId: string, entries: T[]): Promise<T[]> {
  if (!entries.some((e) => e.kind === "diagram")) return entries;
  const rows = await db.query<{ entry_id: string; stale: boolean }>(
    `select entry_id, stale from diagram_status where workspace_id = $1`,
    [workspaceId],
  );
  const stale = new Map(rows.map((r) => [r.entry_id, r.stale]));
  return entries.map((e) => (e.kind === "diagram" ? { ...e, stale: stale.get(e.id) ?? false } : e));
}
export async function openQuestionCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db.query<{ workspace_id: string; n: number | string }>(
    `select workspace_id, count(*) as n from entry_index where kind = 'question' and status = 'open' group by workspace_id`,
  );
  return Object.fromEntries(rows.map((r) => [r.workspace_id, Number(r.n)]));
}

const questionNumber = (id: string) => Number(id.slice(id.indexOf("-") + 1)) || 0;

/** A question this task opened beats an older, higher-priority one that the task did not touch. */
export function chooseAskedQuestion(touched: readonly Entry[], fallback: Entry | null): Entry | null {
  const seen = new Set<string>();
  const open = touched.filter((entry) => {
    if (entry.kind !== "question" || entry.status !== "open" || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
  open.sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9) || questionNumber(a.id) - questionNumber(b.id));
  return open[0] ?? fallback;
}

export async function topOpenQuestion(db: Db, dataDir: string, workspaceId: string, ownedHelpers?: OwnedHelperScope): Promise<Entry | null> {
  const rows = await db.query<{ entry_id: string }>(
    `select entry_id from entry_index where workspace_id = $1 and kind = 'question' and status = 'open'
     order by priority asc nulls last, split_part(entry_id, '-', 2)::int asc`,
    [workspaceId],
  );
  const store = new KnowledgeStore(repoPath(dataDir, workspaceId), ownedHelpers);
  for (const r of rows) {
    const e = await store.get(r.entry_id); // skip stale index rows with no file in the store
    if (e) return e;
  }
  return null;
}
