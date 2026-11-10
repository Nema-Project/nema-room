import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Entry } from "@nema/shared";
import type { Db } from "./db/db.js";

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const NOTE_MAX = 200;
const ExpiresAt = z.iso.datetime({ offset: true });

export class ShareInputError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "ShareInputError";
  }
}

export type ShareRow = {
  id: string;
  workspaceId: string;
  note: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

export type CreatedShare = ShareRow & { token: string };

export type PublicSummary = {
  id: string;
  kind: Entry["kind"];
  title: string;
  status: Entry["status"];
  businessDate: string | null;
  basis: Entry["basis"];
  confirmedAt: string | null;
  related: string[];
  priority?: 1 | 2 | 3;
  url?: string;
  implementationStatus?: "reported" | "verified" | "mismatch";
  diagramType?: NonNullable<Entry["diagram"]>["type"];
  workpackage?: { blockedOn: string | null; taskCount: number };
};

export type PublicSourceRef = { sourceEntryId: string; locator?: string; quote?: string };

export type PublicEntry = Omit<PublicSummary, "workpackage"> & {
  body: string;
  quotes: { text: string }[];
  sourceRefs: PublicSourceRef[];
  workpackage?: { blockedOn: string | null; taskCount: number; tasks: { n: number; title: string; status: "pending" | "reported" | "verified" | "mismatch" }[] };
};

export type ShareResolution =
  | { found: false }
  | { found: true; available: false }
  | { found: true; available: true; workspaceId: string; workspaceName: string };

type ShareSqlRow = {
  id: string;
  workspace_id: string;
  note: string | null;
  expires_at: Date | string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
};

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function toShareRow(row: ShareSqlRow): ShareRow {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    note: row.note,
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    createdAt: iso(row.created_at),
  };
}

function cleanNote(note: string | undefined): string | null {
  if (note === undefined) return null;
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) throw new ShareInputError("note must be at most 200 characters");
  return trimmed.length === 0 ? null : trimmed;
}

function cleanExpiresAt(expiresAt: string | null | undefined): string | null {
  if (expiresAt == null) return null;
  const parsed = ExpiresAt.safeParse(expiresAt);
  if (!parsed.success) throw new ShareInputError("expiresAt must be an ISO time with a timezone");
  return parsed.data;
}

/** Inserts one share. Expiry is compared with the database clock, not a caller-supplied date. */
export async function createShare(
  db: Db,
  workspaceId: string,
  input: { note?: string; expiresAt?: string | null },
): Promise<CreatedShare> {
  const note = cleanNote(input.note);
  const expiresAt = cleanExpiresAt(input.expiresAt);
  const token = randomBytes(32).toString("base64url");
  const rows = await db.query<ShareSqlRow>(
    `insert into knowledge_shares (id, workspace_id, token_hash, note, expires_at)
     select $1, $2, $3, $4, $5::timestamptz
     where $5::timestamptz is null or $5::timestamptz > now()
     returning id, workspace_id, note, expires_at, revoked_at, created_at`,
    [`ks_${nanoid(16)}`, workspaceId, sha256(token), note, expiresAt],
  );
  const row = rows[0];
  if (!row) throw new ShareInputError("expiresAt must be later than now");
  return { ...toShareRow(row), token };
}

export async function listShares(db: Db, workspaceId: string): Promise<ShareRow[]> {
  const rows = await db.query<ShareSqlRow>(
    `select id, workspace_id, note, expires_at, revoked_at, created_at
     from knowledge_shares where workspace_id = $1
     order by created_at desc, id desc`,
    [workspaceId],
  );
  return rows.map(toShareRow);
}

export async function revokeShare(db: Db, workspaceId: string, shareId: string): Promise<ShareRow | null> {
  const rows = await db.query<ShareSqlRow>(
    `update knowledge_shares set revoked_at = coalesce(revoked_at, now())
     where id = $1 and workspace_id = $2
     returning id, workspace_id, note, expires_at, revoked_at, created_at`,
    [shareId, workspaceId],
  );
  return rows[0] ? toShareRow(rows[0]) : null;
}

export async function revokeActiveShares(db: Db, workspaceId: string, tx?: Db): Promise<void> {
  await (tx ?? db).query(
    "update knowledge_shares set revoked_at = now() where workspace_id = $1 and revoked_at is null",
    [workspaceId],
  );
}

export async function resolveShare(db: Db, token: string): Promise<ShareResolution> {
  const rows = await db.query<{ id: string; name: string; available: boolean }>(
    `select w.id, w.name,
            (s.revoked_at is null
             and (s.expires_at is null or s.expires_at > now())
             and w.archived_at is null
             and w.confidential = false) as available
     from knowledge_shares s
     join workspaces w on w.id = s.workspace_id
     where s.token_hash = $1`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return { found: false };
  if (row.available !== true) return { found: true, available: false };
  return { found: true, available: true, workspaceId: row.id, workspaceName: row.name };
}

export function toPublicSummary(entry: Entry): PublicSummary {
  const summary: PublicSummary = {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    status: entry.status,
    businessDate: entry.businessDate,
    basis: entry.basis,
    confirmedAt: entry.confirmedAt,
    related: entry.related,
  };
  if (entry.priority !== undefined) summary.priority = entry.priority;
  if (entry.url !== undefined) summary.url = entry.url;
  if (entry.implementation) summary.implementationStatus = entry.implementation.status;
  if (entry.diagram) summary.diagramType = entry.diagram.type;
  if (entry.workpackage) {
    summary.workpackage = { blockedOn: entry.workpackage.blockedOn, taskCount: entry.workpackage.tasks.length };
  }
  return summary;
}

export function toPublicEntry(entry: Entry): PublicEntry {
  const { workpackage: _summaryPackage, ...rest } = toPublicSummary(entry);
  const projected: PublicEntry = {
    ...rest,
    body: entry.body,
    quotes: entry.quotes.map((quote) => ({ text: quote.text })),
    sourceRefs: entry.sourceRefs.map((ref) => {
      const out: PublicSourceRef = { sourceEntryId: ref.sourceEntryId };
      if (ref.locator !== undefined) out.locator = ref.locator;
      if (ref.quote !== undefined) out.quote = ref.quote;
      return out;
    }),
  };
  if (entry.workpackage) {
    projected.workpackage = {
      blockedOn: entry.workpackage.blockedOn,
      taskCount: entry.workpackage.tasks.length,
      tasks: entry.workpackage.tasks.map((task) => ({ n: task.n, title: task.title, status: task.status })),
    };
  }
  return projected;
}
