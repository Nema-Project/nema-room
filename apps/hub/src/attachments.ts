import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { Readable } from "node:stream";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  ATTACHMENT_LIMITS,
  AttachmentRefSchema,
  sanitizeAttachmentName,
  sniffAttachment,
  type AttachmentKind,
  type AttachmentRef,
  type AttachmentStatus,
  type AttachmentView,
} from "@nema/shared";
import type { Db } from "./db/db.js";

// Chat attachments (#104, spec docs/superpowers/specs/2026-10-30-chat-attachments-design.md, D-1 A / D-4 B).
// Bytes: <dataDir>/attachments/<workspaceId>/<id>, written through <dataDir>/attachments/.staging.
// Metadata: message_attachments. The user's file name never takes part in a path.

/**
 * The delete was recorded (the tombstone is committed) but the file could not be removed. The hourly
 * sweep removes files whose rows say they are gone, so the bytes are retried; callers still publish
 * the tombstone, which is the attachment's state from now on.
 */
export class AttachmentCleanupError extends Error {
  constructor(
    readonly view: AttachmentView,
    cause: unknown,
  ) {
    super("the attachment was deleted but its file could not be removed yet; it will be retried", { cause });
    this.name = "AttachmentCleanupError";
  }
}

export class AttachmentError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410 | 411 | 413 | 415 | 507,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

export type UploadInput = {
  /** The decoded X-Nema-Filename value; cleaned here before it is stored. */
  name: string;
  /** X-Nema-Upload-Key: one UUID per selected file, reused when the client retries. */
  uploadKey: string;
  contentLength: number;
  body: AsyncIterable<Uint8Array>;
};
export type UploadResult = { view: AttachmentView; created: boolean };

export type AttachmentStoreOptions = {
  /** NEMA_ATTACHMENTS_MAX_BYTES; defaults to 2 GB. */
  maxGlobalBytes?: number;
  /** Free bytes on the data disk; defaults to statfs on the data directory. Tests inject a fake. */
  freeBytes?: () => Promise<number>;
  /** Removes a gone attachment's path in the sweep; defaults to fs.rm. Tests inject a failure. */
  removePath?: (p: string) => Promise<void>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^att_[A-Za-z0-9_-]{16}$/;
const KIND_LIMIT: Record<AttachmentKind, number> = {
  image: ATTACHMENT_LIMITS.imageBytes,
  pdf: ATTACHMENT_LIMITS.pdfBytes,
  text: ATTACHMENT_LIMITS.textBytes,
};
const LARGEST_LIMIT = Math.max(...Object.values(KIND_LIMIT));
// Enough to tell every binary format apart by its magic bytes (WebP needs 12).
const MAGIC_BYTES = 12;
const FILE_STATUSES: AttachmentStatus[] = ["staged", "attached"];
const POSIX = process.platform !== "win32";

type Row = {
  id: string;
  workspace_id: string;
  message_id: string | null;
  kind: AttachmentKind;
  mime: string;
  name: string;
  size: number | string;
  sha256: string;
  status: AttachmentStatus;
  deleted_at: Date | string | null;
};
const COLS = "id, workspace_id, message_id, kind, mime, name, size, sha256, status, deleted_at";

function toView(r: Row): AttachmentView {
  const size = Number(r.size);
  if (!Number.isSafeInteger(size)) throw new Error(`attachment ${r.id} has an invalid size`);
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    name: r.name,
    size,
    sha256: r.sha256,
    messageId: r.message_id,
    status: r.status,
    deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null,
  };
}

/** The ref sent in task.assign. Throws unless the view is bound to a message and passes AttachmentRefSchema. */
export function toAttachmentRef(view: AttachmentView): AttachmentRef {
  if (view.messageId === null) throw new Error(`attachment ${view.id} is not bound to a message`);
  return AttachmentRefSchema.parse({
    id: view.id,
    kind: view.kind,
    mime: view.mime,
    name: view.name,
    size: view.size,
    sha256: view.sha256,
    messageId: view.messageId,
  });
}

/** Marks staged uploads of this workspace as attached to `messageId`; anything else is a 409 and the caller rolls back. */
export async function bindAttachments(t: Db, workspaceId: string, messageId: string, ids: string[]): Promise<AttachmentView[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const owner = await t.query("select 1 from messages where id = $1 and workspace_id = $2", [messageId, workspaceId]);
  if (owner.length === 0) throw new AttachmentError(409, "the message is not in this workspace");
  const rows = await t.query<Row>(
    `update message_attachments set status = 'attached', message_id = $3, attached_at = now()
     where id = any($1) and workspace_id = $2 and status = 'staged' returning ${COLS}`,
    [unique, workspaceId, messageId],
  );
  if (rows.length !== unique.length) throw new AttachmentError(409, "attachments must be unsent uploads of this workspace");
  const byId = new Map(rows.map((r) => [r.id, toView(r)]));
  const views = unique.map((id) => byId.get(id)!);
  for (const v of views) toAttachmentRef(v);
  return views;
}

/** The given attachments of this workspace, whatever their status, oldest upload first. */
export async function listAttachmentsByIds(db: Db, workspaceId: string, ids: readonly string[]): Promise<AttachmentView[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<Row>(`select ${COLS} from message_attachments where workspace_id = $1 and id = any($2) order by created_at, id`, [workspaceId, [...ids]]);
  return rows.map(toView);
}

/** Attachments bound to the given messages, whatever their status, oldest upload first. */
export async function listAttachmentsForMessages(db: Db, messageIds: string[]): Promise<Map<string, AttachmentView[]>> {
  const out = new Map<string, AttachmentView[]>();
  if (messageIds.length === 0) return out;
  const rows = await db.query<Row>(`select ${COLS} from message_attachments where message_id = any($1) order by created_at, id`, [messageIds]);
  for (const r of rows) {
    const list = out.get(r.message_id!) ?? [];
    list.push(toView(r));
    out.set(r.message_id!, list);
  }
  return out;
}

/** NEMA_ATTACHMENTS_MAX_BYTES, or the 2 GB default. A value that is not a positive integer stops startup. */
export function attachmentsMaxBytesFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.NEMA_ATTACHMENTS_MAX_BYTES?.trim();
  if (!raw) return ATTACHMENT_LIMITS.defaultGlobalBytes;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) throw new Error("NEMA_ATTACHMENTS_MAX_BYTES must be a positive whole number of bytes");
  return n;
}

function sniffError(reason: "unsupported_type" | "extension_mismatch" | "not_utf8" | "empty" | "too_large"): AttachmentError {
  switch (reason) {
    case "empty":
      return new AttachmentError(400, "the file is empty");
    case "too_large":
      return new AttachmentError(413, "the file is larger than its type allows");
    case "extension_mismatch":
      return new AttachmentError(415, "the file name's extension does not match its content");
    case "not_utf8":
      return new AttachmentError(415, "text files must be UTF-8 without NUL bytes");
    default:
      return new AttachmentError(415, "unsupported file type; images (PNG, JPEG, GIF, WebP), PDF and UTF-8 text are accepted");
  }
}

/** FileHandle.write may write fewer bytes than asked; keep going until the whole chunk is on disk. */
export async function writeFully(
  fh: { write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }> },
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new Error("the attachment file could not be written");
    offset += bytesWritten;
  }
}

const isCode = (e: unknown, code: string) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === code;

async function fsyncDir(dir: string): Promise<void> {
  if (!POSIX) return; // Windows has no directory fsync; the startup scan covers lost entries.
  const fh = await fs.open(dir, "r");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Creates a 0700 directory regardless of umask. Returns whether it was new. */
async function privateDir(dir: string): Promise<boolean> {
  const created = (await fs.mkdir(dir, { recursive: true, mode: 0o700 })) !== undefined;
  if (POSIX) await fs.chmod(dir, 0o700);
  return created;
}

export class AttachmentStore {
  private readonly root: string;
  private readonly staging: string;
  private readonly maxGlobalBytes: number;
  private readonly freeBytes: () => Promise<number>;
  private reserved = 0;
  private admission: Promise<void> = Promise.resolve();
  /** Uploads in progress per workspace and upload key; a concurrent retry waits and then matches. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly removePath: (p: string) => Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    opts: AttachmentStoreOptions = {},
  ) {
    this.root = path.join(dataDir, "attachments");
    this.staging = path.join(this.root, ".staging");
    this.maxGlobalBytes = opts.maxGlobalBytes ?? ATTACHMENT_LIMITS.defaultGlobalBytes;
    this.removePath = opts.removePath ?? ((p) => fs.rm(p, { recursive: true, force: true }));
    this.freeBytes =
      opts.freeBytes ??
      (async () => {
        const s = await fs.statfs(this.dataDir);
        return Number(s.bavail) * Number(s.bsize);
      });
  }

  private file(workspaceId: string, id: string): string {
    return path.join(this.root, workspaceId, id);
  }

  /** Bytes held by files that should exist (staged and attached uploads). */
  async usedBytes(): Promise<number> {
    const rows = await this.db.query<{ n: string | number | null }>(
      "select coalesce(sum(size), 0) as n from message_attachments where status = any($1)",
      [FILE_STATUSES],
    );
    return Number(rows[0]?.n ?? 0);
  }

  private async workspaceGate(t: Db, workspaceId: string, lock: boolean): Promise<void> {
    const rows = await t.query<{ archived_at: unknown }>(`select archived_at from workspaces where id = $1${lock ? " for share" : ""}`, [workspaceId]);
    if (!rows[0]) throw new AttachmentError(404, "workspace not found");
    if (rows[0].archived_at) throw new AttachmentError(409, "workspace is archived; unarchive it to add attachments");
  }

  private async byKey(workspaceId: string, uploadKey: string): Promise<Row | undefined> {
    const rows = await this.db.query<Row>(`select ${COLS} from message_attachments where workspace_id = $1 and upload_key = $2`, [workspaceId, uploadKey]);
    return rows[0];
  }

  /**
   * Reserves `bytes` against the global quota and the free-space floor. Checks run one at a time,
   * so concurrent uploads never share the same headroom.
   */
  private async reserve(bytes: number): Promise<void> {
    const run = this.admission.then(async () => {
      const used = await this.usedBytes();
      if (used + this.reserved + bytes > this.maxGlobalBytes) {
        throw new AttachmentError(507, "attachment storage is full; delete attachments or raise NEMA_ATTACHMENTS_MAX_BYTES");
      }
      if ((await this.freeBytes()) - this.reserved - bytes < ATTACHMENT_LIMITS.minFreeBytes) {
        throw new AttachmentError(507, "the data disk is almost full; free some space first");
      }
      this.reserved += bytes;
    });
    this.admission = run.catch(() => {});
    await run;
  }

  async upload(workspaceId: string, input: UploadInput): Promise<UploadResult> {
    const name = sanitizeAttachmentName(input.name);
    if (!name) throw new AttachmentError(400, "invalid file name");
    if (!UUID_RE.test(input.uploadKey)) throw new AttachmentError(400, "the upload key must be a UUID");
    const length = input.contentLength;
    if (!Number.isSafeInteger(length) || length < 0) throw new AttachmentError(411, "Content-Length is required");
    if (length === 0) throw new AttachmentError(400, "the file is empty");
    if (length > LARGEST_LIMIT) throw new AttachmentError(413, "the file is larger than any attachment type allows");
    await this.workspaceGate(this.db, workspaceId, false);

    const uploadKey = input.uploadKey.toLowerCase();
    // One upload per key at a time: a duplicate waits, then takes the retry path below without
    // reserving quota for a second copy.
    const slot = `${workspaceId}\u0000${uploadKey}`;
    for (let busy = this.inflight.get(slot); busy; busy = this.inflight.get(slot)) await busy.catch(() => {});
    const attempt = this.uploadOnce(workspaceId, name, uploadKey, length, input.body);
    this.inflight.set(slot, attempt);
    try {
      return await attempt;
    } finally {
      if (this.inflight.get(slot) === attempt) this.inflight.delete(slot);
    }
  }

  private async uploadOnce(workspaceId: string, name: string, uploadKey: string, length: number, body: AsyncIterable<Uint8Array>): Promise<UploadResult> {
    const existing = await this.byKey(workspaceId, uploadKey);
    // A retry stores nothing and reserves nothing; it only proves it carries the same bytes.
    if (existing) return { view: await this.matchRetry(existing, length, body), created: false };

    await this.reserve(length);
    try {
      return await this.store(workspaceId, name, uploadKey, length, body);
    } finally {
      this.reserved -= length;
    }
  }

  private async matchRetry(existing: Row, length: number, body: AsyncIterable<Uint8Array>): Promise<AttachmentView> {
    const view = toView(existing);
    if (view.status !== "staged" && view.status !== "attached") {
      throw new AttachmentError(409, "this upload is no longer available; upload the file again");
    }
    if (length !== view.size) throw new AttachmentError(409, "this upload key was already used for a different file");
    const hash = createHash("sha256");
    let count = 0;
    for await (const chunk of body) {
      count += chunk.length;
      if (count > length) throw new AttachmentError(400, "the body is longer than Content-Length");
      hash.update(chunk);
    }
    if (count !== length) throw new AttachmentError(400, "the body is shorter than Content-Length");
    if (hash.digest("hex") !== view.sha256) throw new AttachmentError(409, "this upload key was already used for a different file");
    return view;
  }

  private async store(workspaceId: string, name: string, uploadKey: string, length: number, body: AsyncIterable<Uint8Array>): Promise<UploadResult> {
    if (await privateDir(this.root)) await fsyncDir(this.dataDir);
    await privateDir(this.staging);
    const tmp = path.join(this.staging, nanoid());
    let current = tmp;
    let written: { sha256: string; size: number } | undefined;
    try {
      const { sha256, kind, mime } = await this.writeStaging(tmp, name, length, body);
      written = { sha256, size: length };
      const id = `att_${nanoid(16)}`;
      const final = this.file(workspaceId, id);
      const row = await this.db.tx(async (t) => {
        // Shares the lock deleteWorkspace takes for update: no file lands in a deleted workspace.
        await this.workspaceGate(t, workspaceId, true);
        const dir = path.join(this.root, workspaceId);
        if (await privateDir(dir)) await fsyncDir(this.root);
        await fs.rename(tmp, final);
        current = final;
        await fsyncDir(dir);
        const rows = await t.query<Row>(
          `insert into message_attachments(id, workspace_id, kind, mime, name, size, sha256, upload_key, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, 'staged') returning ${COLS}`,
          [id, workspaceId, kind, mime, name, length, sha256, uploadKey],
        );
        return rows[0]!;
      });
      return { view: toView(row), created: true };
    } catch (error) {
      await fs.rm(current, { force: true });
      // A concurrent request with the same key won the insert: answer like a retry.
      if (written && isCode(error, "23505")) {
        const winner = await this.byKey(workspaceId, uploadKey);
        if (winner) {
          const view = toView(winner);
          if (view.sha256 !== written.sha256 || view.size !== written.size) {
            throw new AttachmentError(409, "this upload key was already used for a different file");
          }
          return { view, created: false };
        }
      }
      throw error;
    }
  }

  private async writeStaging(tmp: string, name: string, length: number, body: AsyncIterable<Uint8Array>): Promise<{ sha256: string; kind: AttachmentKind; mime: string }> {
    const fh = await fs.open(tmp, "wx", 0o600);
    try {
      if (POSIX) await fh.chmod(0o600);
      const hash = createHash("sha256");
      const head: Uint8Array[] = [];
      const headCap = ATTACHMENT_LIMITS.textBytes + 1;
      let headLength = 0;
      let count = 0;
      let limit: number | undefined;
      const decideLimit = () => {
        const first = Buffer.concat(head).subarray(0, MAGIC_BYTES);
        const early = sniffAttachment(first, name);
        if (!early.ok && (early.reason === "unsupported_type" || early.reason === "extension_mismatch")) throw sniffError(early.reason);
        // Anything that is not an image or a PDF by its magic bytes can only be text.
        limit = early.ok && early.kind !== "text" ? KIND_LIMIT[early.kind] : KIND_LIMIT.text;
        // The real size is known up front, so an oversized file stops after its first chunk.
        if (length > limit) throw new AttachmentError(413, "the file is larger than its type allows");
      };
      for await (const chunk of body) {
        count += chunk.length;
        if (count > length) throw new AttachmentError(400, "the body is longer than Content-Length");
        if (headLength < headCap) {
          const part = chunk.subarray(0, headCap - headLength);
          head.push(part);
          headLength += part.length;
        }
        if (limit === undefined && headLength >= MAGIC_BYTES) decideLimit();
        await writeFully(fh, chunk);
        hash.update(chunk);
      }
      if (count !== length) throw new AttachmentError(400, "the body is shorter than Content-Length");
      if (limit === undefined) decideLimit();
      // sniffAttachment judges size by the bytes it is given; the head is at most textBytes + 1, so
      // the per-kind limit is checked again here against the real byte count.
      const verdict = sniffAttachment(Buffer.concat(head), name);
      if (!verdict.ok) throw sniffError(verdict.reason);
      if (count > KIND_LIMIT[verdict.kind]) throw new AttachmentError(413, "the file is larger than its type allows");
      await fh.sync();
      return { sha256: hash.digest("hex"), kind: verdict.kind, mime: verdict.mime };
    } finally {
      await fh.close();
    }
  }

  private async row(t: Db, workspaceId: string, id: string, lock = false): Promise<Row | undefined> {
    if (!ID_RE.test(id)) return undefined;
    const rows = await t.query<Row>(`select ${COLS} from message_attachments where id = $1 and workspace_id = $2${lock ? " for update" : ""}`, [id, workspaceId]);
    return rows[0];
  }

  private async readable(workspaceId: string, id: string): Promise<{ view: AttachmentView; file: string }> {
    const r = await this.row(this.db, workspaceId, id);
    if (!r) throw new AttachmentError(404, "attachment not found");
    const view = toView(r);
    if (view.status === "deleted") throw new AttachmentError(410, "the attachment was deleted");
    if (view.status !== "staged" && view.status !== "attached") throw new AttachmentError(410, "the attachment file is missing");
    return { view, file: this.file(workspaceId, id) };
  }

  private async markMissing(id: string): Promise<never> {
    await this.db.query("update message_attachments set status = 'missing' where id = $1 and status = 'attached'", [id]);
    throw new AttachmentError(410, "the attachment file is missing");
  }

  /**
   * Opens the stored file without following a symlink, and only when it is a regular file. A file
   * whose mode lets other users read it is made private first; if that fails, nothing is served.
   */
  private async openFile(id: string, file: string): Promise<fs.FileHandle> {
    let fh: fs.FileHandle;
    try {
      fh = await fs.open(file, fs.constants.O_RDONLY | (POSIX ? fs.constants.O_NOFOLLOW : 0));
    } catch (e) {
      if (isCode(e, "ENOENT") || isCode(e, "ELOOP")) return this.markMissing(id);
      throw e;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return await this.markMissing(id);
      if (POSIX && (st.mode & 0o077) !== 0) await fh.chmod(0o600);
      return fh;
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  /**
   * Which of these files still exist on disk right now. A file that vanished is marked `missing` (the same way a
   * failed read marks it) and left out, so the mention menu never offers something the agent could not receive.
   */
  async available(workspaceId: string, ids: readonly string[]): Promise<Set<string>> {
    const ok = new Set<string>();
    for (const id of ids) {
      let st: Awaited<ReturnType<typeof fs.stat>>;
      try {
        st = await fs.stat(this.file(workspaceId, id));
      } catch {
        // Gone or unreadable: mark it the way a failed read does, and never offer it.
        await this.db.query("update message_attachments set status = 'missing' where id = $1 and status = 'attached'", [id]);
        continue;
      }
      if (!st.isFile()) {
        await this.db.query("update message_attachments set status = 'missing' where id = $1 and status = 'attached'", [id]);
        continue;
      }
      ok.add(id);
    }
    return ok;
  }

  async open(workspaceId: string, id: string): Promise<{ view: AttachmentView; stream: Readable }> {
    const { view, file } = await this.readable(workspaceId, id);
    const fh = await this.openFile(id, file);
    return { view, stream: fh.createReadStream() };
  }

  async readBytes(workspaceId: string, id: string): Promise<Buffer> {
    const { file } = await this.readable(workspaceId, id);
    const fh = await this.openFile(id, file);
    try {
      return await fh.readFile();
    } finally {
      await fh.close();
    }
  }

  /** Binds staged uploads to a message inside the caller's transaction. Any id that is not this workspace's staged upload fails the whole call. */
  bind(t: Db, workspaceId: string, messageId: string, ids: string[]): Promise<AttachmentView[]> {
    return bindAttachments(t, workspaceId, messageId, ids);
  }

  listForMessages(db: Db, messageIds: string[]): Promise<Map<string, AttachmentView[]>> {
    return listAttachmentsForMessages(db, messageIds);
  }

  /** D-4: bytes go now; a bound attachment keeps a tombstone, an unsent upload is dropped. Idempotent. */
  async remove(workspaceId: string, id: string): Promise<AttachmentView> {
    const view = await this.db.tx(async (t) => {
      const r = await this.row(t, workspaceId, id, true);
      if (!r || r.status === "expired") throw new AttachmentError(404, "attachment not found");
      if (r.status === "deleted") return toView(r);
      if (r.status === "staged") {
        // Expired until the file is gone, so a failed removal is retried by the next sweep.
        await t.query("update message_attachments set status = 'expired' where id = $1", [id]);
        return { ...toView(r), status: "deleted" as const, deletedAt: new Date().toISOString() };
      }
      const rows = await t.query<Row>(`update message_attachments set status = 'deleted', deleted_at = now() where id = $1 returning ${COLS}`, [id]);
      return toView(rows[0]!);
    });
    try {
      await fs.rm(this.file(workspaceId, id), { force: true });
    } catch (e) {
      throw new AttachmentCleanupError(view, e);
    }
    if (view.messageId === null) await this.db.query("delete from message_attachments where id = $1 and status = 'expired'", [id]);
    return view;
  }

  /**
   * Expires old staged uploads and removes files whose rows say they should be gone. Only the
   * startup pass (before the hub accepts requests) removes files without a row, the staging area,
   * and marks lost files `missing`: an upload in flight has a file but no row yet.
   */
  async sweep(opts: { startup: boolean; now?: Date }): Promise<void> {
    // Repair modes first, so a directory the hub cannot read is fixed rather than taken as empty.
    const permissionErrors = await this.tightenPermissions();
    const cutoff = new Date((opts.now ?? new Date()).getTime() - ATTACHMENT_LIMITS.stagedTtlMs);
    await this.db.query("update message_attachments set status = 'expired' where status = 'staged' and created_at < $1", [cutoff]);
    const gone = await this.db.query<{ id: string; workspace_id: string; status: AttachmentStatus }>(
      "select id, workspace_id, status from message_attachments where status in ('expired', 'deleted')",
    );
    // One path that cannot be removed must not stop the rest; its row stays, so the next sweep retries it.
    // Recursive because only ids make up the path: whatever sits there belongs to a gone attachment.
    const cleanupErrors: unknown[] = [];
    const removed = new Set<string>();
    for (const g of gone) {
      try {
        await this.removePath(this.file(g.workspace_id, g.id));
        removed.add(g.id);
      } catch (e) {
        cleanupErrors.push(e);
      }
    }
    const expired = gone.filter((g) => g.status === "expired" && removed.has(g.id)).map((g) => g.id);
    if (expired.length > 0) await this.db.query("delete from message_attachments where id = any($1) and status = 'expired'", [expired]);
    await this.removeDeletedWorkspaceDirs();
    if (opts.startup) await this.startupScan();
    if (permissionErrors.length > 0) throw new AggregateError(permissionErrors, "could not make the attachment files private");
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "could not remove some deleted attachment files; the next sweep retries them");
  }

  /** No upload can create a directory for a workspace that does not exist (it locks the row first). */
  private async removeDeletedWorkspaceDirs(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (e) {
      if (isCode(e, "ENOENT")) return;
      throw e;
    }
    const workspaces = new Set((await this.db.query<{ id: string }>("select id from workspaces")).map((r) => r.id));
    for (const entry of entries) if (entry !== ".staging" && !workspaces.has(entry)) await fs.rm(path.join(this.root, entry), { recursive: true, force: true });
  }

  private async startupScan(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root);
    } catch (e) {
      if (isCode(e, "ENOENT")) return;
      throw e;
    }
    await fs.rm(this.staging, { recursive: true, force: true });
    const live = await this.db.query<{ id: string; workspace_id: string; status: AttachmentStatus }>(
      "select id, workspace_id, status from message_attachments where status = any($1)",
      [FILE_STATUSES],
    );
    const expected = new Set(live.map((r) => `${r.workspace_id}/${r.id}`));
    for (const entry of entries) {
      if (entry === ".staging") continue;
      const dir = path.join(this.root, entry);
      const st = await fs.lstat(dir).catch(() => undefined);
      if (!st) continue;
      if (!st.isDirectory()) {
        await fs.rm(dir, { force: true });
        continue;
      }
      for (const f of await fs.readdir(dir)) {
        const p = path.join(dir, f);
        const fst = await fs.lstat(p);
        // Only regular files the database knows stay; symlinks and anything else go.
        if (!fst.isFile() || !expected.has(`${entry}/${f}`)) await fs.rm(p, { recursive: true, force: true });
      }
    }
    for (const r of live) {
      try {
        await fs.lstat(this.file(r.workspace_id, r.id));
      } catch (e) {
        if (!isCode(e, "ENOENT")) {
          console.error(`attachment ${r.id}: could not check its file`, e);
          continue;
        }
        if (r.status === "attached") await this.db.query("update message_attachments set status = 'missing' where id = $1 and status = 'attached'", [r.id]);
        else await this.db.query("delete from message_attachments where id = $1 and status = 'staged'", [r.id]);
      }
    }
  }

  private async tightenPermissions(): Promise<Error[]> {
    const errors: Error[] = [];
    if (!POSIX) return errors;
    const walk = async (p: string): Promise<void> => {
      let st;
      try {
        st = await fs.lstat(p);
      } catch (e) {
        if (!isCode(e, "ENOENT")) errors.push(e as Error);
        return;
      }
      if (st.isSymbolicLink()) return;
      const want = st.isDirectory() ? 0o700 : 0o600;
      if ((st.mode & 0o777) !== want) {
        try {
          await fs.chmod(p, want);
          if (st.mode & 0o077) console.warn(`tightened permissions on ${p}`);
        } catch (e) {
          errors.push(e as Error);
          return;
        }
      }
      if (st.isDirectory()) {
        try {
          for (const e of await fs.readdir(p)) await walk(path.join(p, e));
        } catch (e) {
          errors.push(e as Error);
        }
      }
    };
    await walk(this.root);
    return errors;
  }
}
