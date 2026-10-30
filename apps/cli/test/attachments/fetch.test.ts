import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AttachmentRef } from "@nema/shared";
import { fetchAttachments, loadTaskAttachments } from "../../src/attachments/fetch.js";
import { RoomClient } from "../../src/room/client.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const log = Buffer.from("hello\n", "utf8");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ref = (id: string, bytes: Buffer, over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id, kind: "image", mime: "image/png", name: `${id}.png`, size: bytes.length, sha256: sha(bytes), messageId: "m1", ...over,
});

let hub: Server;
let hubUrl: string;
let files: Map<string, { status: number; type: string; body: Buffer }>;
let seen: { url?: string; auth?: string; accept?: string }[];

beforeEach(async () => {
  files = new Map();
  seen = [];
  hub = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const id = decodeURIComponent((req.url ?? "").replace(/^\/room\/attachments\//, ""));
    const file = files.get(id);
    if (!file) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "attachment not in this task" }));
      return;
    }
    res.writeHead(file.status, { "content-type": file.type });
    res.end(file.body);
  });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => hub.close(() => r())));

describe("RoomClient.fetchAttachment", () => {
  test("returns raw bytes and the content type with the run token", async () => {
    files.set("a/1", { status: 200, type: "image/png", body: png });
    const r = await new RoomClient(hubUrl, "tok").fetchAttachment("a/1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bytes.equals(png)).toBe(true);
    expect(r.mime).toBe("image/png");
    expect(seen[0]).toEqual({ url: "/room/attachments/a%2F1", auth: "Bearer tok" });
  });

  test("a hub error keeps its status and message", async () => {
    files.set("gone", { status: 410, type: "application/json", body: Buffer.from('{"error":"attachment deleted"}') });
    expect(await new RoomClient(hubUrl, "tok").fetchAttachment("gone")).toEqual({ ok: false, status: 410, error: "attachment deleted" });
    expect(await new RoomClient(hubUrl, "tok").fetchAttachment("nope")).toEqual({ ok: false, status: 404, error: "attachment not in this task" });
  });

  test("stops reading once the body exceeds maxBytes", async () => {
    files.set("big", { status: 200, type: "text/plain", body: Buffer.alloc(4096, 0x61) });
    const r = await new RoomClient(hubUrl, "tok").fetchAttachment("big", 1024);
    expect(r).toMatchObject({ ok: false, status: 200 });
  });

  test("an unreachable hub is ok:false with status 0", async () => {
    const r = await new RoomClient("http://127.0.0.1:1", "tok").fetchAttachment("a");
    expect(r).toMatchObject({ ok: false, status: 0 });
  });
});

describe("fetchAttachments", () => {
  test("loads every ref in order and checks size and sha256", async () => {
    files.set("img", { status: 200, type: "image/png", body: png });
    files.set("txt", { status: 200, type: "text/plain; charset=utf-8", body: log });
    const refs = [ref("img", png), ref("txt", log, { kind: "text", mime: "text/plain", name: "a.log" })];
    const loaded = await fetchAttachments(new RoomClient(hubUrl, "tok"), refs);
    expect(loaded.map((a) => a.id)).toEqual(["img", "txt"]);
    expect(loaded[0]!.bytes.equals(png)).toBe(true);
    expect(loaded[1]).toMatchObject({ name: "a.log", kind: "text", mime: "text/plain", messageId: "m1" });
  });

  test("a sha256 mismatch fails with the file name and never the content", async () => {
    files.set("img", { status: 200, type: "image/png", body: Buffer.from("SECRET-CONTENT-123") });
    const bad = ref("img", png, { sha256: sha(Buffer.from("other")), size: Buffer.byteLength("SECRET-CONTENT-123") });
    const err = await fetchAttachments(new RoomClient(hubUrl, "tok"), [bad]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("img.png");
    expect((err as Error).message).toContain("sha256");
    expect((err as Error).message).not.toContain("SECRET-CONTENT");
  });

  test("a size mismatch fails with the file name", async () => {
    files.set("img", { status: 200, type: "image/png", body: png });
    await expect(fetchAttachments(new RoomClient(hubUrl, "tok"), [ref("img", png, { size: png.length + 1 })])).rejects.toThrow(/img\.png/);
  });

  test("404 says the attachment is not part of this task", async () => {
    await expect(fetchAttachments(new RoomClient(hubUrl, "tok"), [ref("missing", png)])).rejects.toThrow(/missing\.png.*不在本次任务/);
  });

  test("410 says the attachment was deleted or lost", async () => {
    files.set("gone", { status: 410, type: "application/json", body: Buffer.from('{"error":"attachment deleted"}') });
    await expect(fetchAttachments(new RoomClient(hubUrl, "tok"), [ref("gone", png)])).rejects.toThrow(/gone\.png.*已被删除/);
  });

  test("stops at the first failure without fetching the rest", async () => {
    files.set("b", { status: 200, type: "image/png", body: png });
    await expect(fetchAttachments(new RoomClient(hubUrl, "tok"), [ref("a", png), ref("b", png)])).rejects.toThrow(/a\.png/);
    expect(seen.map((s) => s.url)).toEqual(["/room/attachments/a"]);
  });
});

describe("loadTaskAttachments", () => {
  const native = { adapter: "a", image: "native", pdf: "native", text: "text" } as const;
  const task = (attachments?: AttachmentRef[]) => ({ hubUrl, runToken: "tok", ...(attachments ? { attachments } : {}) });

  test("no attachments: nothing fetched", async () => {
    expect(await loadTaskAttachments(task(), native)).toEqual({ ok: true, attachments: [] });
    expect(await loadTaskAttachments(task([]), native)).toEqual({ ok: true, attachments: [] });
    expect(seen).toEqual([]);
  });

  test("a refused kind fails before any hub call", async () => {
    files.set("img", { status: 200, type: "image/png", body: png });
    const r = await loadTaskAttachments(task([ref("img", png)]), { ...native, image: "unknown" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("img.png");
    expect(seen).toEqual([]);
  });

  test("loads and verifies deliverable attachments", async () => {
    files.set("img", { status: 200, type: "image/png", body: png });
    const r = await loadTaskAttachments(task([ref("img", png)]), native);
    expect(r.ok && r.attachments[0]!.bytes.equals(png)).toBe(true);
  });

  test("a fetch failure becomes ok:false with the file name", async () => {
    const r = await loadTaskAttachments(task([ref("nope", png)]), native);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("nope.png");
  });
});
