import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { ATTACHMENT_LIMITS } from "@nema/shared";
import { AttachmentError, AttachmentStore, toAttachmentRef, writeFully, type UploadInput } from "../src/attachments.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace, deleteWorkspace, updateWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

let db: Db;
let dataDir: string;
let ws: string;
const GB = 1024 * 1024 * 1024;
const plenty = async () => 100 * GB;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  ws = (await createWorkspace(db, dataDir, "A")).id;
});
afterAll(cleanupHubDeps);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function png(size: number): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from(PNG_MAGIC).copy(b);
  return b;
}
function pdf(size: number): Buffer {
  const b = Buffer.alloc(size, 0x20);
  b.write("%PDF-1.7\n");
  return b;
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
let keySeq = 0;
const newKey = () => `00000000-0000-4000-8000-${String(++keySeq).padStart(12, "0")}`;

/** An upload body that yields 64 KB chunks and records how many it handed out. */
function body(bytes: Buffer, gate?: Promise<void>) {
  const state = { chunks: 0, total: Math.ceil(bytes.length / 65536) };
  const iterable: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (gate) await gate;
      for (let i = 0; i < bytes.length; i += 65536) {
        state.chunks++;
        yield bytes.subarray(i, i + 65536);
      }
    },
  };
  return { iterable, state };
}
function input(bytes: Buffer, name = "a.png", extra: Partial<UploadInput> = {}): UploadInput {
  return { name, uploadKey: newKey(), contentLength: bytes.length, body: body(bytes).iterable, ...extra };
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    if (e instanceof AttachmentError) return e.status;
    throw e;
  }
}
const store = (opts: ConstructorParameters<typeof AttachmentStore>[2] = {}) => new AttachmentStore(db, dataDir, { freeBytes: plenty, ...opts });
const root = () => path.join(dataDir, "attachments");
const staging = async () => (existsSync(path.join(root(), ".staging")) ? readdir(path.join(root(), ".staging")) : []);
async function message(id: string): Promise<string> {
  await db.query("insert into messages(id, workspace_id, role, content) values ($1, $2, 'user', 'hi')", [id, ws]);
  return id;
}

describe("upload", () => {
  test("stores a PNG as staged under a hub-chosen path", async () => {
    const bytes = png(1000);
    const { view, created } = await store().upload(ws, input(bytes, "../../x/shot.png"));
    expect(created).toBe(true);
    expect(view).toMatchObject({ kind: "image", mime: "image/png", name: "shot.png", size: 1000, sha256: sha(bytes), status: "staged", messageId: null, deletedAt: null });
    expect(view.id).toMatch(/^att_[A-Za-z0-9_-]+$/);
    expect(await readFile(path.join(root(), ws, view.id))).toEqual(bytes);
    expect(await staging()).toEqual([]);
  });

  test("rejects a name that sanitizes to nothing", async () => {
    expect(await status(store().upload(ws, input(png(10), " / ")))).toBe(400);
  });

  test("an unknown or archived workspace is refused and leaves nothing behind", async () => {
    expect(await status(store().upload("ws_missing", input(png(10))))).toBe(404);
    await updateWorkspace(db, ws, { archived: true });
    expect(await status(store().upload(ws, input(png(10))))).toBe(409);
    expect(await staging()).toEqual([]);
  });

  test("type errors map to 415 and empty bodies to 400", async () => {
    expect(await status(store().upload(ws, input(pdf(100), "a.png")))).toBe(415);
    expect(await status(store().upload(ws, input(Buffer.from("<svg/>"), "a.txt")))).toBe(415);
    expect(await status(store().upload(ws, input(Buffer.from([0xc3, 0x28]), "a.txt")))).toBe(415);
    expect(await status(store().upload(ws, input(Buffer.alloc(0), "a.txt")))).toBe(400);
    expect(await staging()).toEqual([]);
  });

  test("a Content-Length over the largest kind limit is refused before reading", async () => {
    const b = body(pdf(10));
    expect(await status(store().upload(ws, { name: "a.pdf", uploadKey: newKey(), contentLength: ATTACHMENT_LIMITS.pdfBytes + 1, body: b.iterable }))).toBe(413);
    expect(b.state.chunks).toBe(0);
  });

  // The per-kind limit is checked against the real byte count, not a sniffed prefix.
  test("an image over 10 MB is refused even though PDFs may be 20 MB", async () => {
    const bytes = png(ATTACHMENT_LIMITS.imageBytes + 1);
    const b = body(bytes);
    expect(await status(store().upload(ws, { name: "a.png", uploadKey: newKey(), contentLength: bytes.length, body: b.iterable }))).toBe(413);
    // Aborted as soon as the count passed the image limit, before the last chunk.
    expect(b.state.chunks).toBeLessThan(b.state.total);
    expect(await staging()).toEqual([]);
  });

  test("an image at exactly 10 MB and a PDF over 10 MB are accepted", async () => {
    expect((await store().upload(ws, input(png(ATTACHMENT_LIMITS.imageBytes)))).view.size).toBe(ATTACHMENT_LIMITS.imageBytes);
    expect((await store().upload(ws, input(pdf(ATTACHMENT_LIMITS.imageBytes + 1), "a.pdf"))).view.kind).toBe("pdf");
  });

  test("text over 512 KB is refused by its real size", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_LIMITS.textBytes + 1, 0x61);
    const b = body(bytes);
    expect(await status(store().upload(ws, { name: "a.txt", uploadKey: newKey(), contentLength: bytes.length, body: b.iterable }))).toBe(413);
  });

  test("a body longer than Content-Length is refused; a missing length is 411", async () => {
    expect(await status(store().upload(ws, input(png(1000), "a.png", { contentLength: 500 })))).toBe(400);
    expect(await status(store().upload(ws, input(png(1000), "a.png", { contentLength: Number.NaN })))).toBe(411);
    expect(await status(store().upload(ws, input(png(1000), "a.png", { contentLength: 2000 })))).toBe(400);
    expect(await staging()).toEqual([]);
  });

  test("global quota and free space give 507", async () => {
    expect(await status(store({ maxGlobalBytes: 500 }).upload(ws, input(png(1000))))).toBe(507);
    expect(await status(store({ freeBytes: async () => ATTACHMENT_LIMITS.minFreeBytes - 1 }).upload(ws, input(png(1000))))).toBe(507);
    // Earlier uploads count toward the quota.
    const s = store({ maxGlobalBytes: 1500 });
    await s.upload(ws, input(png(1000)));
    expect(await status(s.upload(ws, input(png(1000))))).toBe(507);
  });

  test("two concurrent uploads that together exceed the quota: only one succeeds", async () => {
    const s = store({ maxGlobalBytes: 1000 });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const a = png(600);
    const b = png(600);
    const pa = status(s.upload(ws, { name: "a.png", uploadKey: newKey(), contentLength: 600, body: body(a, gate).iterable }));
    const pb = status(s.upload(ws, { name: "b.png", uploadKey: newKey(), contentLength: 600, body: body(b, gate).iterable }));
    await new Promise((r) => setTimeout(r, 20));
    open();
    expect([await pa, await pb].sort()).toEqual([0, 507]);
  });

  test("a retry with the same key returns the original record without storing a copy", async () => {
    const s = store();
    const bytes = png(1000);
    const key = newKey();
    const first = await s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(bytes).iterable });
    const again = await s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(bytes).iterable });
    expect(again).toEqual({ view: first.view, created: false });
    expect(await readdir(path.join(root(), ws))).toEqual([first.view.id]);
    expect(await s.usedBytes()).toBe(1000);
    expect(await status(s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(png(999).subarray(0, 999)).iterable }))).toBe(400);
    const other = png(1000);
    other[500] = 9;
    expect(await status(s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(other).iterable }))).toBe(409);
    expect(await staging()).toEqual([]);
  });

  test("a retry still succeeds when the quota and the disk are full", async () => {
    const bytes = png(1000);
    const key = newKey();
    const first = await store().upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(bytes).iterable });
    const full = store({ maxGlobalBytes: 1000, freeBytes: async () => 0 });
    expect((await full.upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(bytes).iterable })).view).toEqual(first.view);
  });

  test("two concurrent uploads with the same key both return one record and leave one file", async () => {
    const s = store();
    const bytes = png(1000);
    const key = newKey();
    const [a, b] = await Promise.all([
      s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(bytes).iterable }),
      s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 1000, body: body(bytes).iterable }),
    ]);
    expect(a.view).toEqual(b.view);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await readdir(path.join(root(), ws))).toEqual([a.view.id]);
    expect(await staging()).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("directories are 0700 and files 0600 whatever the umask", async () => {
    const old = process.umask(0);
    try {
      const { view } = await store().upload(ws, input(png(10)));
      expect((await stat(root())).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root(), ws))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root(), ".staging"))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(root(), ws, view.id))).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });

  test("the store refuses to insert a row that breaks AttachmentRefSchema", async () => {
    await expect(
      db.query("insert into message_attachments(id, workspace_id, kind, mime, name, size, sha256, upload_key, status) values ('att_x', $1, 'image', 'application/pdf', 'a', 1, $2, $3, 'staged')", [ws, "a".repeat(64), newKey()]),
    ).rejects.toThrow();
    await expect(
      db.query("insert into message_attachments(id, workspace_id, kind, mime, name, size, sha256, upload_key, status) values ('att_y', $1, 'text', 'text/plain', 'a', $2, $3, $4, 'staged')", [ws, ATTACHMENT_LIMITS.textBytes + 1, "a".repeat(64), newKey()]),
    ).rejects.toThrow();
  });
});

describe("open, bind, remove", () => {
  test("open streams the bytes; a file that vanished becomes missing and 410", async () => {
    const s = store();
    const bytes = png(1000);
    const { view } = await s.upload(ws, input(bytes));
    expect(await s.readBytes(ws, view.id)).toEqual(bytes);
    expect(await status(s.open("ws_other", view.id))).toBe(404);
    const id = await message("m1");
    await db.tx((t) => s.bind(t, ws, id, [view.id]));
    await import("node:fs/promises").then((f) => f.rm(path.join(root(), ws, view.id)));
    expect(await status(s.open(ws, view.id))).toBe(410);
    expect((await s.listForMessages(db, [id])).get(id)![0]!.status).toBe("missing");
  });

  test("bind attaches only this workspace's staged uploads", async () => {
    const s = store();
    const other = (await createWorkspace(db, dataDir, "B")).id;
    const mine = (await s.upload(ws, input(png(10)))).view;
    const theirs = (await s.upload(other, input(png(10)))).view;
    const id = await message("m1");
    expect(await status(db.tx((t) => s.bind(t, ws, id, [mine.id, theirs.id])))).toBe(409);
    expect((await s.open(ws, mine.id)).view.status).toBe("staged");
    const bound = await db.tx((t) => s.bind(t, ws, id, [mine.id]));
    expect(bound).toEqual([{ ...mine, status: "attached", messageId: id }]);
    expect(toAttachmentRef(bound[0]!)).toEqual({ id: mine.id, kind: "image", mime: "image/png", name: "a.png", size: 10, sha256: mine.sha256, messageId: id });
    // Already attached: a second bind fails.
    expect(await status(db.tx((t) => s.bind(t, ws, "m1", [mine.id])))).toBe(409);
    expect((await s.listForMessages(db, [id, "nope"])).get(id)!.map((v) => v.id)).toEqual([mine.id]);
  });

  test("toAttachmentRef refuses a staged view and an inconsistent one", () => {
    const view = { id: "att_1", kind: "image" as const, mime: "image/png", name: "a.png", size: 1, sha256: "a".repeat(64), messageId: null, status: "staged" as const, deletedAt: null };
    expect(() => toAttachmentRef(view)).toThrow();
    expect(() => toAttachmentRef({ ...view, messageId: "m1", status: "attached", mime: "application/pdf" })).toThrow();
  });

  test("bind racing the expiry sweep: exactly one wins", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    await db.query("update message_attachments set created_at = now() - interval '25 hours' where id = $1", [view.id]);
    const id = await message("m1");
    const [bound] = await Promise.all([status(db.tx((t) => s.bind(t, ws, id, [view.id]))), s.sweep({ startup: false })]);
    const rows = await db.query<{ status: string }>("select status from message_attachments where id = $1", [view.id]);
    if (bound === 0) expect(rows).toEqual([{ status: "attached" }]);
    else {
      expect(bound).toBe(409);
      expect(rows).toEqual([]);
      expect(existsSync(path.join(root(), ws, view.id))).toBe(false);
    }
  });

  test("remove leaves a tombstone and deletes the bytes", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    const id = await message("m1");
    await db.tx((t) => s.bind(t, ws, id, [view.id]));
    const gone = await s.remove(ws, view.id);
    expect(gone).toMatchObject({ id: view.id, name: "a.png", sha256: view.sha256, size: 10, status: "deleted", messageId: id });
    expect(gone.deletedAt).not.toBeNull();
    expect(existsSync(path.join(root(), ws, view.id))).toBe(false);
    expect(await status(s.open(ws, view.id))).toBe(410);
    expect(await s.remove(ws, view.id)).toEqual(gone);
    expect(await status(s.remove("ws_other", view.id))).toBe(404);
    expect(await s.usedBytes()).toBe(0);
  });

  test("removing a staged upload drops it entirely", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    expect(await s.remove(ws, view.id)).toMatchObject({ id: view.id, status: "deleted", messageId: null });
    expect(await db.query("select 1 from message_attachments where id = $1", [view.id])).toEqual([]);
    expect(existsSync(path.join(root(), ws, view.id))).toBe(false);
  });
});

describe("sweep", () => {
  test("startup sweep clears expired, deleted residue, staging, orphans and marks missing files", async () => {
    const s = store();
    const expired = (await s.upload(ws, input(png(10)))).view;
    const attached = (await s.upload(ws, input(png(11)))).view;
    const deleted = (await s.upload(ws, input(png(12)))).view;
    const lost = (await s.upload(ws, input(png(13)))).view;
    const id = await message("m1");
    await db.tx((t) => s.bind(t, ws, id, [attached.id, deleted.id, lost.id]));
    await db.query("update message_attachments set created_at = now() - interval '25 hours' where id = $1", [expired.id]);
    // A delete interrupted between its commit and the file removal.
    await db.query("update message_attachments set status = 'deleted', deleted_at = now() where id = $1", [deleted.id]);
    await import("node:fs/promises").then((f) => f.rm(path.join(root(), ws, lost.id)));
    await writeFile(path.join(root(), ".staging", "left"), "x");
    await writeFile(path.join(root(), ws, "att_orphan"), "x");
    await mkdir(path.join(root(), "ws_gone"), { recursive: true });
    await writeFile(path.join(root(), "ws_gone", "att_z"), "x");

    await s.sweep({ startup: true });

    const rows = await db.query<{ id: string; status: string }>("select id, status from message_attachments order by id");
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [attached.id]: "attached", [deleted.id]: "deleted", [lost.id]: "missing" });
    expect((await readdir(path.join(root(), ws))).sort()).toEqual([attached.id]);
    expect(await staging()).toEqual([]);
    expect(existsSync(path.join(root(), "ws_gone"))).toBe(false);
  });

  test("the hourly sweep never deletes a file that has no row yet", async () => {
    const s = store();
    await mkdir(path.join(root(), ws), { recursive: true });
    await writeFile(path.join(root(), ws, "att_inflight"), "x");
    await writeFile(path.join(root(), ".staging", "inflight"), "x").catch(async () => {
      await mkdir(path.join(root(), ".staging"), { recursive: true });
      await writeFile(path.join(root(), ".staging", "inflight"), "x");
    });
    await s.sweep({ startup: false });
    expect(existsSync(path.join(root(), ws, "att_inflight"))).toBe(true);
    expect(existsSync(path.join(root(), ".staging", "inflight"))).toBe(true);
  });

  test.skipIf(process.platform === "win32")("sweep tightens loosened permissions", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    await chmod(path.join(root(), ws), 0o755);
    await chmod(path.join(root(), ws, view.id), 0o644);
    await s.sweep({ startup: false });
    expect((await stat(path.join(root(), ws))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root(), ws, view.id))).mode & 0o777).toBe(0o600);
  });
});

describe("workspace deletion", () => {
  test("deleting a workspace removes its attachment rows and directory", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    await message("m1");
    await db.tx((t) => s.bind(t, ws, "m1", [view.id]));
    await deleteWorkspace(db, dataDir, ws);
    expect(await db.query("select 1 from message_attachments")).toEqual([]);
    expect(existsSync(path.join(root(), ws))).toBe(false);
  });

  test("an upload that loses the race to workspace deletion leaves no file", async () => {
    const s = store();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const bytes = png(10);
    const pending = status(s.upload(ws, { name: "a.png", uploadKey: newKey(), contentLength: 10, body: body(bytes, gate).iterable }));
    await new Promise((r) => setTimeout(r, 20));
    await deleteWorkspace(db, dataDir, ws);
    open();
    expect(await pending).toBe(404);
    expect(existsSync(path.join(root(), ws))).toBe(false);
    expect(await staging()).toEqual([]);
  });
});

describe("attachmentsMaxBytesFromEnv", async () => {
  const { attachmentsMaxBytesFromEnv } = await import("../src/attachments.js");
  test("defaults to 2 GB and accepts a whole number", () => {
    expect(attachmentsMaxBytesFromEnv({})).toBe(ATTACHMENT_LIMITS.defaultGlobalBytes);
    expect(attachmentsMaxBytesFromEnv({ NEMA_ATTACHMENTS_MAX_BYTES: " 1048576 " })).toBe(1048576);
  });
  test.each(["0", "-1", "1.5", "1e9", "abc"])("refuses %s", (v) => {
    expect(() => attachmentsMaxBytesFromEnv({ NEMA_ATTACHMENTS_MAX_BYTES: v })).toThrow(/NEMA_ATTACHMENTS_MAX_BYTES/);
  });
});

describe("review hardening", () => {
  test("bind refuses a message from another workspace", async () => {
    const s = store();
    const other = (await createWorkspace(db, dataDir, "B")).id;
    const { view } = await s.upload(ws, input(png(10)));
    await db.query("insert into messages(id, workspace_id, role, content) values ('m_other', $1, 'user', 'x')", [other]);
    expect(await status(db.tx((t) => s.bind(t, ws, "m_other", [view.id])))).toBe(409);
    expect((await s.open(ws, view.id)).view.status).toBe("staged");
  });

  test("writeFully keeps writing after a short write", async () => {
    const written: number[] = [];
    const fake = {
      async write(buf: Uint8Array, offset: number, length: number) {
        const n = Math.min(3, length);
        written.push(...buf.subarray(offset, offset + n));
        return { bytesWritten: n, buffer: buf };
      },
    };
    await writeFully(fake, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(written).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(writeFully({ write: async (b: Uint8Array) => ({ bytesWritten: 0, buffer: b }) }, Uint8Array.from([1]))).rejects.toThrow();
  });

  test.skipIf(process.platform === "win32")("a symlink planted at an attachment path is never followed", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    await message("m1");
    await db.tx((t) => s.bind(t, ws, "m1", [view.id]));
    const secret = path.join(dataDir, "secret.txt");
    await writeFile(secret, "do not serve");
    const file = path.join(root(), ws, view.id);
    await rm(file);
    await symlink(secret, file);
    expect(await status(s.open(ws, view.id))).toBe(410);
    expect(await status(s.readBytes(ws, view.id))).toBe(410);
    await rm(file);
    await symlink(secret, file);
    await s.sweep({ startup: true });
    expect(existsSync(file)).toBe(false);
    expect(await readFile(secret, "utf8")).toBe("do not serve");
    expect((await s.listForMessages(db, ["m1"])).get("m1")![0]!.status).toBe("missing");
  });

  test.skipIf(process.platform === "win32")("open makes a loosened file private before serving it", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    await chmod(path.join(root(), ws, view.id), 0o644);
    const { stream } = await s.open(ws, view.id);
    stream.destroy();
    expect((await stat(path.join(root(), ws, view.id))).mode & 0o777).toBe(0o600);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable directory is repaired, not treated as missing", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    await message("m1");
    await db.tx((t) => s.bind(t, ws, "m1", [view.id]));
    await chmod(path.join(root(), ws), 0o000);
    await s.sweep({ startup: true });
    expect((await s.open(ws, view.id)).view.status).toBe("attached");
  });

  test("removing an unsent upload stays recoverable until its file is gone", async () => {
    const s = store();
    const { view } = await s.upload(ws, input(png(10)));
    await s.remove(ws, view.id);
    expect(await db.query("select 1 from message_attachments where id = $1", [view.id])).toEqual([]);
    expect(await s.usedBytes()).toBe(0);
  });

  test("the hourly sweep removes the directory of a workspace that no longer exists", async () => {
    const s = store();
    await mkdir(path.join(root(), "ws_gone"), { recursive: true });
    await writeFile(path.join(root(), "ws_gone", "att_z"), "x");
    await s.sweep({ startup: false });
    expect(existsSync(path.join(root(), "ws_gone"))).toBe(false);
  });

  test("concurrent uploads with one new key share one reservation", async () => {
    const s = store({ maxGlobalBytes: 1000 });
    const bytes = png(600);
    const key = newKey();
    const [a, b] = await Promise.all([
      s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 600, body: body(bytes).iterable }),
      s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 600, body: body(bytes).iterable }),
    ]);
    expect(a.view).toEqual(b.view);
  });

  test("a retry of an upload that expired is refused", async () => {
    const s = store();
    const bytes = png(10);
    const key = newKey();
    await s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 10, body: body(bytes).iterable });
    await db.query("update message_attachments set status = 'expired' where upload_key = $1", [key]);
    expect(await status(s.upload(ws, { name: "a.png", uploadKey: key, contentLength: 10, body: body(bytes).iterable }))).toBe(409);
  });
});
