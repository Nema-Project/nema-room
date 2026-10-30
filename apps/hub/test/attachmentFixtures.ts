import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import type { AttachmentView } from "@nema/shared";
import { AttachmentStore } from "../src/attachments.js";
import type { Db } from "../src/db/db.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function png(size: number, fill = 7): Buffer {
  const b = Buffer.alloc(size, fill);
  Buffer.from(PNG_MAGIC).copy(b);
  return b;
}

/** A real upload through AttachmentStore: the row is staged and the file exists. */
export async function uploadPng(db: Db, dataDir: string, workspaceId: string, bytes = png(64), name = "shot.png"): Promise<AttachmentView> {
  const store = new AttachmentStore(db, dataDir, { freeBytes: async () => 100 * 1024 ** 3 });
  const { view } = await store.upload(workspaceId, {
    name,
    uploadKey: randomUUID(),
    contentLength: bytes.length,
    body: (async function* () { yield bytes; })(),
  });
  return view;
}

/** A staged row with no file, for limit checks that never read bytes. */
export async function stagedRow(db: Db, workspaceId: string, kind: "image" | "pdf" | "text" = "pdf", size = 1024): Promise<string> {
  const mime = { image: "image/png", pdf: "application/pdf", text: "text/plain" }[kind];
  const id = `att_${nanoid(16)}`;
  await db.query(
    `insert into message_attachments (id, workspace_id, message_id, kind, mime, name, size, sha256, upload_key, status)
     values ($1, $2, null, $3, $4, $5, $6, $7, $8, 'staged')`,
    [id, workspaceId, kind, mime, `${id}.${kind === "image" ? "png" : kind === "pdf" ? "pdf" : "txt"}`, size, "a".repeat(64), randomUUID()],
  );
  return id;
}
