import { nanoid } from "nanoid";
import { git, versionAt, parseCommitMessage, withRepoLock } from "@nema/knowledge";
import { repoPath } from "./workspaces.js";
import { entryContentHash, refsHash, relatedSnapshotHash } from "./evidencePayload.js";
import { KIND_DIR, kindFromId, canonicalJson } from "@nema/shared";
import type { Db } from "./db/db.js";
import { sha256 } from "./db/snapshot.js";

export type EvidenceEventInput = {
  workspaceId: string;
  entryId: string;
  contentHash: string;
  refsHash: string;
  revision?: string | null;
  snapshotHash?: string | null;
} & (
  | { kind: "promote_basis"; targetBasis: "stated" | "decided" }
  | { kind: "confirm_revision"; targetBasis?: "stated" | "decided" | null; snapshotHash: string }
  | { kind: "confirm_entry"; targetBasis?: null }
);

export function payloadHashFor(input: EvidenceEventInput): string {
  return sha256(canonicalJson({
    kind: input.kind, workspaceId: input.workspaceId, entryId: input.entryId,
    targetBasis: input.targetBasis ?? null, revision: input.revision ?? null,
    contentHash: input.contentHash, refsHash: input.refsHash, snapshotHash: input.snapshotHash ?? null,
  }));
}

export async function insertEvidenceEvent(db: Db, input: EvidenceEventInput): Promise<{ id: string; payloadHash: string; reused: boolean }> {
  const payloadHash = payloadHashFor(input);
  for (;;) {
    const rows = await db.query<{ id: string }>(`
      insert into evidence_events
        (id, workspace_id, kind, entry_id, target_basis, revision, content_hash, refs_hash, snapshot_hash, payload_hash, actor)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'user')
      on conflict (workspace_id, payload_hash) where consumed_commit is null and consumable
      do nothing returning id`,
    [`ev_${nanoid(12)}`, input.workspaceId, input.kind, input.entryId, input.targetBasis ?? null,
      input.revision ?? null, input.contentHash, input.refsHash, input.snapshotHash ?? null, payloadHash]);
    if (rows[0]) return { id: rows[0].id, payloadHash, reused: false };
    const existing = await db.query<{ id: string }>(`
      select id from evidence_events
      where workspace_id = $1 and payload_hash = $2 and consumed_commit is null and consumable`,
    [input.workspaceId, payloadHash]);
    if (existing[0]) return { id: existing[0].id, payloadHash, reused: true };
    // A concurrent consumer may have consumed the conflicting row before the SELECT.
  }
}

export async function consumeEvidenceEvent(db: Db, workspaceId: string, id: string, payloadHash: string, commit: string): Promise<boolean> {
  const rows = await db.query<{ id: string }>(`
    update evidence_events
    set consumed_commit = $1, consumed_at = clock_timestamp()
    where id = $2 and workspace_id = $3
      and consumed_commit is null and consumed_at is null
      and consumable = true and payload_hash = $4
    returning id`, [commit, id, workspaceId, payloadHash]);
  return rows.length > 0;
}

/** Recover consumption from committed evidence without changing knowledge files. */
export async function reconcileUnconsumedEvents(db: Db, dataDir: string, workspaceId: string): Promise<void> {
  const repo = repoPath(dataDir, workspaceId);
  await withRepoLock(repo, () => reconcileUnconsumedEventsLocked(db, dataDir, workspaceId));
}

/** Caller must hold this workspace repository lock; never acquires it again.
 * An entry filter lets a UI retry recover its committed events before writing.
 */
export async function reconcileUnconsumedEventsLocked(db: Db, dataDir: string, workspaceId: string, entryId?: string): Promise<void> {
  const repo = repoPath(dataDir, workspaceId);
  const events = await db.query<{ id: string; entry_id: string; kind: EvidenceEventInput["kind"]; target_basis: "stated" | "decided" | null; payload_hash: string }>(
    "select id, entry_id, kind, target_basis, payload_hash from evidence_events where workspace_id=$1 and consumed_commit is null and consumed_at is null and consumable=true and ($2::text is null or entry_id=$2)", [workspaceId, entryId ?? null]);
  for (const event of events) {
    const kind = kindFromId(event.entry_id);
    if (!kind) continue;
    // Missing history or an unreadable historical source cannot authorize consumption.
    let commit: string, hash: string;
    try {
      commit = (await git(repo, ["log", "-1", "--format=%H", "--", `${KIND_DIR[kind]}/${event.entry_id}.md`])).trim();
      if (!commit) continue;
      const meta = parseCommitMessage(await git(repo, ["show", "-s", "--format=%B", commit]));
      if (!meta.evidenceEventIds?.includes(event.id)) continue;
      const entry = await versionAt(repo, event.entry_id, commit);
      if (entry.id !== event.entry_id) continue;
      if (event.kind === "promote_basis" && (event.target_basis === null || entry.basis !== event.target_basis)) continue;
      if (event.kind === "confirm_revision" && (!entry.sourceSnapshot || entry.confirmedRevision !== entry.sourceSnapshot.revision)) continue;
      const common = { workspaceId, entryId: entry.id, contentHash: entryContentHash(entry), refsHash: refsHash(entry),
        revision: entry.sourceSnapshot?.revision ?? null,
        snapshotHash: await relatedSnapshotHash(entry, (id) => versionAt(repo, id, commit)) };
      const input: EvidenceEventInput = event.kind === "promote_basis"
        ? { ...common, kind: event.kind, targetBasis: event.target_basis! }
        : event.kind === "confirm_revision"
          ? { ...common, kind: event.kind, snapshotHash: entry.sourceSnapshot!.contentHash }
          : { ...common, kind: event.kind };
      hash = payloadHashFor(input);
    } catch { continue; }
    if (hash === event.payload_hash) await consumeEvidenceEvent(db, workspaceId, event.id, hash, commit);
  }
}
