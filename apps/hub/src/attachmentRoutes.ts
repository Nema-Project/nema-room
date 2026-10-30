import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { AttachmentCapabilitiesSchema, type AttachmentView } from "@nema/shared";
import { AttachmentCleanupError, AttachmentError, type AttachmentStore } from "./attachments.js";
import { DaemonRpcError, type DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { getMessage } from "./messages.js";
import { daemonHttpStatus } from "./plugins.js";

export type AttachmentRouteDeps = {
  store: AttachmentStore;
  daemon: DaemonRpc;
  daemonStatus: () => boolean;
  /** With both, deleting a sent file emits message.updated so open chats show the tombstone. */
  db?: Db;
  events?: EventBus;
};

/** The one /api write that is not JSON. app.ts lets it past requireJson; the route checks the type itself. */
export const ATTACHMENT_UPLOAD_PATH = /^\/api\/workspaces\/[^/]+\/attachments$/;

const empty: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {} };

function fail(c: Context, e: unknown) {
  if (e instanceof AttachmentError) return c.json({ error: e.message }, e.status);
  throw e;
}

function contentHeaders(view: AttachmentView): Record<string, string> {
  return {
    // Text is never served under its own type, so an HTML or SVG-like file cannot render.
    "content-type": view.kind === "text" ? "text/plain; charset=utf-8" : view.mime,
    "content-length": String(view.size),
    "x-content-type-options": "nosniff",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(view.name)}`,
    "content-security-policy": "sandbox; default-src 'none'",
    "cross-origin-resource-policy": "same-origin",
    "cache-control": "private, no-cache",
  };
}

export function attachmentRoutes(deps: AttachmentRouteDeps): Hono {
  const app = new Hono();

  app.post("/workspaces/:id/attachments", async (c) => {
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/octet-stream") return c.json({ error: "content-type must be application/octet-stream" }, 415);
    const rawLength = c.req.header("content-length");
    if (rawLength === undefined) return c.json({ error: "Content-Length is required" }, 411);
    if (!/^\d+$/.test(rawLength.trim())) return c.json({ error: "invalid Content-Length" }, 400);
    const rawName = c.req.header("x-nema-filename");
    if (rawName === undefined) return c.json({ error: "X-Nema-Filename is required" }, 400);
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return c.json({ error: "X-Nema-Filename must be percent-encoded UTF-8" }, 400);
    }
    const uploadKey = c.req.header("x-nema-upload-key");
    if (uploadKey === undefined) return c.json({ error: "X-Nema-Upload-Key is required" }, 400);
    try {
      const { view, created } = await deps.store.upload(c.req.param("id"), {
        name,
        uploadKey,
        contentLength: Number(rawLength.trim()),
        body: c.req.raw.body ?? empty,
      });
      return c.json(view, created ? 201 : 200);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get("/workspaces/:id/attachments/:aid/content", async (c) => {
    try {
      const { view, stream } = await deps.store.open(c.req.param("id"), c.req.param("aid"));
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: 200, headers: contentHeaders(view) });
    } catch (e) {
      return fail(c, e);
    }
  });

  // Each snapshot is read and emitted in turn per message, after this request's own commit, so a read that
  // started earlier can never be emitted after a newer one and put a deleted file back on screen.
  const emitting = new Map<string, Promise<void>>();
  const emitCurrent = (workspaceId: string, messageId: string): Promise<void> => {
    const { db, events } = deps;
    if (!db || !events) return Promise.resolve();
    const next = (emitting.get(messageId) ?? Promise.resolve()).then(async () => {
      const message = await getMessage(db, messageId);
      if (message) events.emit(workspaceId, { type: "message.updated", message });
    }).catch((e) => console.error("[attachments] message.updated failed", e));
    emitting.set(messageId, next);
    void next.then(() => { if (emitting.get(messageId) === next) emitting.delete(messageId); });
    return next;
  };

  app.delete("/workspaces/:id/attachments/:aid", async (c) => {
    try {
      const workspaceId = c.req.param("id");
      const view = await deps.store.remove(workspaceId, c.req.param("aid"));
      if (view.messageId) await emitCurrent(workspaceId, view.messageId);
      return c.json(view);
    } catch (e) {
      if (e instanceof AttachmentCleanupError) {
        // The tombstone is committed; open chats must stop offering the file even though its bytes
        // are still on disk until the sweep retries the removal.
        console.error("[attachments] removing a deleted attachment's file failed", e.cause);
        if (e.view.messageId) await emitCurrent(c.req.param("id"), e.view.messageId);
        return c.json({ error: e.message }, 500);
      }
      return fail(c, e);
    }
  });

  app.get("/daemon/attachment-capabilities", async (c) => {
    if (!deps.daemonStatus()) return c.json({ error: "daemon 未连接" }, 503);
    let result: unknown;
    try {
      result = await deps.daemon.call("attachments.capabilities", {});
    } catch (e) {
      if (!(e instanceof DaemonRpcError)) throw e;
      // A daemon from before attachments: the composer treats this like "no attachment support".
      if (e.message.startsWith("未知方法 ")) return c.json({ error: "the connected daemon does not support attachments" }, 501);
      return c.json({ error: e.message }, daemonHttpStatus(e.message));
    }
    const parsed = AttachmentCapabilitiesSchema.safeParse(result);
    if (!parsed.success) return c.json({ error: "the daemon returned malformed attachment capabilities" }, 502);
    return c.json(parsed.data);
  });

  return app;
}
