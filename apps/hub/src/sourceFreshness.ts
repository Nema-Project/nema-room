import { KnowledgeStore, summarizeEntry } from "@nema/knowledge";
import { compareFreshness, type Entry, type SourceFreshness, type SourceObservation, type SourceFreshnessReason } from "@nema/shared";
import type { Db } from "./db/db.js";
import { repoPath } from "./workspaces.js";

type FreshnessRow = { entry_id: string; freshness: SourceFreshness; checked_revision: string | null; reason: SourceFreshnessReason };
type ConfirmationRow = { entry_id: string; revision: string | null; snapshot_hash: string | null };

export async function recordSourceCheck(db: Db, dataDir: string, workspaceId: string, entryId: string, observed: SourceObservation): Promise<void> {
  const entry = await new KnowledgeStore(repoPath(dataDir, workspaceId)).get(entryId);
  if (entry?.kind !== "source" || !entry.sourceSnapshot) throw Object.assign(new Error(`entry not found: ${entryId}`), { status: 404 });
  const result = compareFreshness(entry.sourceSnapshot.revision, observed);
  await db.query(`insert into source_freshness (workspace_id, entry_id, freshness, checked_revision, reason, checked_at)
    values ($1,$2,$3,$4,$5,clock_timestamp()) on conflict (workspace_id, entry_id) do update
    set freshness=excluded.freshness, checked_revision=excluded.checked_revision, reason=excluded.reason, checked_at=clock_timestamp()`,
  [workspaceId, entryId, result.freshness, observed.outcome === "ok" ? observed.revision : null, result.reason]);
}

/** Confirmation rows must contain only consumed confirm_revision events. */
export function attachSourceEvidence<T extends Entry>(entries: T[], freshnessRows: FreshnessRow[], confirmations: ConfirmationRow[] = []) {
  const sources = new Map(entries.map(entry => [entry.id, entry]));
  const rows = new Map(freshnessRows.map(row => [row.entry_id, row]));
  const freshnessOf = (entry: Entry): SourceFreshness => {
    const row = rows.get(entry.id);
    if (!row || !entry.sourceSnapshot) return "unknown";
    // The stored comparison predates any reimport. Recompare the observation
    // with the snapshot being read, including after Git commits but indexing fails.
    const observed: SourceObservation = row.reason === "match" || row.reason === "mismatch" || row.reason === "incomparable"
      ? { outcome: "ok", revision: row.checked_revision }
      : { outcome: row.reason };
    return compareFreshness(entry.sourceSnapshot.revision, observed).freshness;
  };
  return entries.map(entry => {
    const snapshot = entry.kind === "source" ? entry.sourceSnapshot : undefined;
    return { ...entry, freshness: freshnessOf(entry),
      reviewNeeded: (entry.sourceRefs ?? []).some(ref => {
        const source = sources.get(ref.sourceEntryId), current = source?.sourceSnapshot;
        return !source || !current || ref.revision !== current.revision || ref.snapshotHash !== current.contentHash ||
          ["changed", "unavailable"].includes(freshnessOf(source));
      }),
      unconfirmedSnapshot: !!snapshot && ((entry.confirmedRevision ?? null) !== snapshot.revision ||
        !confirmations.some(event => event.entry_id === entry.id && event.revision === snapshot.revision && event.snapshot_hash === snapshot.contentHash)),
    };
  });
}

export async function sourceEvidenceEntries<T extends Entry>(db: Db, workspaceId: string, entries: T[]) {
  const [freshness, confirmations] = await Promise.all([
    db.query<FreshnessRow>("select entry_id, freshness, checked_revision, reason from source_freshness where workspace_id=$1", [workspaceId]),
    db.query<ConfirmationRow>(`select entry_id, revision, snapshot_hash from evidence_events
      where workspace_id=$1 and kind='confirm_revision' and consumed_commit is not null and consumed_at is not null`, [workspaceId]),
  ]);
  return attachSourceEvidence(entries, freshness, confirmations);
}

export function sourceEvidenceSummary(entry: ReturnType<typeof attachSourceEvidence>[number]) {
  return { ...summarizeEntry(entry), freshness: entry.freshness, reviewNeeded: entry.reviewNeeded, unconfirmedSnapshot: entry.unconfirmedSnapshot };
}
