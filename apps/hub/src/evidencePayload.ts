import { canonicalJson, type Entry } from "@nema/shared";
import { sha256 } from "./db/snapshot.js";

export function entryContentHash(entry: Pick<Entry, "title" | "body" | "status">): string {
  return sha256(canonicalJson({ title: entry.title, body: entry.body, status: entry.status }));
}

export function refsHash(entry: Pick<Entry, "sourceRefs">): string {
  return sha256(canonicalJson(entry.sourceRefs.map((ref) => ({
    sourceEntryId: ref.sourceEntryId, revision: ref.revision, snapshotHash: ref.snapshotHash,
    locator: ref.locator ?? null, quote: ref.quote ?? null,
  }))));
}

export async function relatedSnapshotHash(entry: Entry, get: (id: string) => Promise<Entry | null>): Promise<string | null> {
  if (entry.sourceSnapshot) return entry.sourceSnapshot.contentHash;
  const ids = [...new Set(entry.sourceRefs.map((ref) => ref.sourceEntryId))].sort();
  const hashes = await Promise.all(ids.map(async (id) => (await get(id))?.sourceSnapshot?.contentHash ?? null));
  if (!hashes.length) return null;
  return hashes.length === 1 ? hashes[0]! : sha256(canonicalJson(hashes));
}
