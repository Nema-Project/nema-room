import { z } from "zod";

export type SourceFreshness = "current" | "changed" | "unavailable" | "unknown";

const NoControls = /^[^\x00-\x1f\x7f]*$/;
export const SourceRevision = z.string().min(1).max(256).regex(NoControls).nullable();
const SnapshotHash = z.string().regex(/^[0-9a-f]{64}$/);

export const SourceExcerpt = z.object({
  locator: z.string().min(1).max(200),
  text: z.string().min(1).max(2000),
});
export type SourceExcerpt = z.infer<typeof SourceExcerpt>;

export const SourceSnapshot = z.object({
  schemaVersion: z.literal(1),
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  resourceId: z.string().min(1).max(512).regex(NoControls).refine((value) => value.trim() === value, "resourceId must not have surrounding whitespace"),
  revision: SourceRevision,
  fetchedAt: z.iso.datetime({ offset: true }),
  title: z.string().min(1).max(200),
  canonicalUrl: z.string().refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
    } catch { return false; }
  }, "canonicalUrl must be http or https without user information").nullable(),
  contentHash: SnapshotHash,
  excerpts: z.array(SourceExcerpt).min(1).max(20).refine((excerpts) => excerpts.reduce((total, excerpt) => total + excerpt.text.length, 0) <= 8000, "excerpt text must total at most 8000 characters"),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshot>;

export const SourceRef = z.object({
  sourceEntryId: z.string().regex(/^S-[1-9]\d*$/),
  revision: SourceRevision,
  snapshotHash: SnapshotHash,
  locator: z.string().min(1).max(200).optional(),
  quote: z.string().min(1).max(500).optional(),
}).refine((ref) => ref.quote === undefined || ref.locator !== undefined, { path: ["locator"], message: "locator is required with quote" });
export type SourceRef = z.infer<typeof SourceRef>;

/** Serialize JSON data deterministically without changing array order. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function serialize(item: unknown): string {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) throw new TypeError("canonicalJson requires JSON data");
    if (ancestors.has(item)) throw new TypeError("canonicalJson cannot serialize cycles");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from(item, serialize).join(",")}]`;
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonicalJson requires plain objects");
      if (Object.getOwnPropertySymbols(item).length) throw new TypeError("canonicalJson does not support symbol keys");
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`).join(",")}}`;
    } finally { ancestors.delete(item); }
  }
  return serialize(value);
}

export type SourceObservation =
  | { outcome: "ok"; revision: string | null }
  | { outcome: "not_found" | "forbidden" | "offline" | "timeout" | "incomparable" };
export type SourceFreshnessReason = "match" | "mismatch" | "not_found" | "forbidden" | "offline" | "timeout" | "incomparable";

export function compareFreshness(importedRevision: string | null, observed: SourceObservation): { freshness: SourceFreshness; reason: SourceFreshnessReason } {
  if (observed.outcome === "not_found" || observed.outcome === "forbidden") return { freshness: "unavailable", reason: observed.outcome };
  if (observed.outcome !== "ok") return { freshness: "unknown", reason: observed.outcome };
  if (!importedRevision || !observed.revision) return { freshness: "unknown", reason: "incomparable" };
  return importedRevision === observed.revision ? { freshness: "current", reason: "match" } : { freshness: "changed", reason: "mismatch" };
}
