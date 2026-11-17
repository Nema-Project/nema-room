import { z } from "zod";

export const TAG_LIMITS = { tagChars: 32, perEntry: 8, perWorkspace: 200 } as const;

const fold = (raw: string): string => raw.normalize("NFKC").trim().replace(/\s+/gu, "-").toLowerCase();

export function tagError(raw: string): string | null {
  const tag = fold(raw);
  if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$/u.test(tag)) return `Invalid tag ${JSON.stringify(raw)}: must start with a letter or number and contain only letters, marks, numbers, _, . or -`;
  if (/^(r|d|t|q|s|g|w)-[1-9]\d*$/.test(tag)) return `Invalid tag ${JSON.stringify(raw)}: entry IDs are reserved`;
  if ([...tag].length > TAG_LIMITS.tagChars) return `Invalid tag ${JSON.stringify(raw)}: exceeds ${TAG_LIMITS.tagChars} code points`;
  return null;
}

export function normalizeTag(raw: string): string | null {
  return tagError(raw) === null ? fold(raw) : null;
}

export const TagSchema = z.string().transform((raw, ctx) => {
  const error = tagError(raw);
  if (error) {
    ctx.addIssue({ code: "custom", message: error });
    return z.NEVER;
  }
  return fold(raw);
});

export function normalizeTagList(raw: unknown): { tags: string[]; dropped: unknown[] } {
  if (raw === undefined) return { tags: [], dropped: [] };
  if (!Array.isArray(raw)) return { tags: [], dropped: [raw] };
  const tags: string[] = [];
  const dropped: unknown[] = [];
  for (const value of raw) {
    const tag = typeof value === "string" ? normalizeTag(value) : null;
    if (tag === null) dropped.push(value);
    else if (!tags.includes(tag)) tags.push(tag);
  }
  return { tags, dropped };
}
