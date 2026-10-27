import { nanoid } from "nanoid";
import { canonicalJson } from "@nema/shared";
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
