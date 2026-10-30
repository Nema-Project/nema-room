import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { Hono } from "hono";
import type { AttachmentView } from "@nema/shared";
import { AttachmentStore } from "../src/attachments.js";
import { createApp } from "../src/app.js";
import type { DaemonRpc } from "../src/daemonRpc.js";
import { DaemonRpcError } from "../src/daemonRpc.js";
import type { Db } from "../src/db/db.js";
import { EventBus, type HubEvent } from "../src/events.js";
import { postUserMessage } from "../src/messages.js";
import { createWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
let db: Db;
let dataDir: string;
let ws: string;
let app: Hono<any>;
let daemon: DaemonRpc;
let connected: boolean;
let attachments: AttachmentStore;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  ws = (await createWorkspace(db, dataDir, "A")).id;
  daemon = { call: () => Promise.reject(new DaemonRpcError("daemon 未连接")) };
  connected = true;
  attachments = new AttachmentStore(db, dataDir, { freeBytes: async () => 1e15 });
  app = createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => connected, daemon: { call: (m, p, t) => daemon.call(m, p, t) }, attachments });
});
afterAll(cleanupHubDeps);

const png = () => {
  const b = new Uint8Array(100).fill(1);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};
let n = 0;
const key = () => `11111111-2222-4333-8444-${String(++n).padStart(12, "0")}`;
function upload(bytes: Uint8Array, headers: Record<string, string | undefined> = {}, workspace = ws) {
  const h: Record<string, string> = {};
  const all = { "content-type": "application/octet-stream", "content-length": String(bytes.length), "x-nema-filename": encodeURIComponent("截图 1.png"), "x-nema-upload-key": key(), ...headers };
  for (const [k, v] of Object.entries(all)) if (v !== undefined) h[k] = v;
  return app.request(`${HUB}/api/workspaces/${workspace}/attachments`, { method: "POST", headers: h, body: bytes });
}

describe("upload route", () => {
  test("stores an octet-stream upload with the decoded, cleaned name", async () => {
    const res = await upload(png());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "截图 1.png", kind: "image", status: "staged", messageId: null });
  });

  test("a retry with the same key answers 200 with the same record", async () => {
    const k = key();
    const first = await (await upload(png(), { "x-nema-upload-key": k })).json();
    const again = await upload(png(), { "x-nema-upload-key": k });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
  });

  test.each([
    ["JSON content type", { "content-type": "application/json" }, 415],
    ["no content type", { "content-type": undefined }, 415],
    ["no file name", { "x-nema-filename": undefined }, 400],
    ["undecodable file name", { "x-nema-filename": "%E0%A4%A" }, 400],
    ["no upload key", { "x-nema-upload-key": undefined }, 400],
    ["upload key not a UUID", { "x-nema-upload-key": "abc" }, 400],
    ["no content length", { "content-length": undefined }, 411],
    ["bad content length", { "content-length": "12x" }, 400],
  ])("%s is refused", async (_label, headers, code) => {
    expect((await upload(png(), headers)).status).toBe(code);
  });

  test("a foreign Host is refused", async () => {
    const res = await app.request(`http://evil.example:4400/api/workspaces/${ws}/attachments`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: png() });
    expect(res.status).toBe(403);
  });

  test("uiAuth still guards the upload", async () => {
    const guarded = createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon, attachments, uiAuth: async (c, next) => (c.req.header("x-ok") ? next() : c.json({ error: "unauthorized" }, 401)) });
    const res = await guarded.request(`${HUB}/api/workspaces/${ws}/attachments`, { method: "POST", headers: { "content-type": "application/octet-stream", "content-length": "100", "x-nema-filename": "a.png", "x-nema-upload-key": key() }, body: png() });
    expect(res.status).toBe(401);
  });

  test("other /api writes still require JSON", async () => {
    const res = await app.request(`${HUB}/api/workspaces`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "{}" });
    expect(res.status).toBe(415);
    const nested = await app.request(`${HUB}/api/workspaces/${ws}/attachments/x`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" });
    expect(nested.status).toBe(415);
  });
});

describe("content and delete routes", () => {
  test("content is served with the hardening headers", async () => {
    const view = (await (await upload(png())).json()) as AttachmentView;
    const res = await app.request(`${HUB}/api/workspaces/${ws}/attachments/${view.id}/content`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png());
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("截图 1.png")}`);
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
  });

  test("text is always served as text/plain; charset=utf-8", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const view = (await (await upload(html, { "content-length": String(html.length), "x-nema-filename": "a.html" })).json()) as AttachmentView;
    const res = await app.request(`${HUB}/api/workspaces/${ws}/attachments/${view.id}/content`);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("another workspace cannot read or delete it", async () => {
    const other = (await createWorkspace(db, dataDir, "B")).id;
    const view = (await (await upload(png())).json()) as AttachmentView;
    expect((await app.request(`${HUB}/api/workspaces/${other}/attachments/${view.id}/content`)).status).toBe(404);
    expect((await app.request(`${HUB}/api/workspaces/${other}/attachments/${view.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("delete answers with the tombstone and content then gives 410", async () => {
    const view = (await (await upload(png())).json()) as AttachmentView;
    await db.query("insert into messages(id, workspace_id, role, content) values ('m1', $1, 'user', '')", [ws]);
    await db.tx((t) => attachments.bind(t, ws, "m1", [view.id]));
    const res = await app.request(`${HUB}/api/workspaces/${ws}/attachments/${view.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: view.id, status: "deleted", messageId: "m1", sha256: view.sha256 });
    expect((await app.request(`${HUB}/api/workspaces/${ws}/attachments/${view.id}/content`)).status).toBe(410);
  });
});

describe("capabilities route", () => {
  const caps = { adapter: "codex-direct", image: "native", pdf: "native", text: "text" };
  const get = () => app.request(`${HUB}/api/daemon/attachment-capabilities`);

  test("passes a well-formed answer through", async () => {
    const calls: string[] = [];
    daemon = { call: async (m) => (calls.push(m), caps) };
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(caps);
    expect(calls).toEqual(["attachments.capabilities"]);
  });

  test("a malformed answer is 502", async () => {
    daemon = { call: async () => ({ image: "native" }) };
    expect((await get()).status).toBe(502);
  });

  test("an offline daemon is 503", async () => {
    connected = false;
    expect((await get()).status).toBe(503);
    connected = true;
    daemon = { call: () => Promise.reject(new DaemonRpcError("daemon 已断开")) };
    expect((await get()).status).toBe(503);
  });

  test("a daemon without the RPC is 501", async () => {
    daemon = { call: () => Promise.reject(new DaemonRpcError("未知方法 attachments.capabilities")) };
    const res = await get();
    expect(res.status).toBe(501);
  });
});

describe("deleting a sent attachment", () => {
  test("emits message.updated with the tombstone so open chats update", async () => {
    const events = new EventBus();
    const local = createApp({ db, dataDir, events, daemonStatus: () => true, daemon: { call: (m, p, t) => daemon.call(m, p, t) }, attachments });
    const view = (await (await upload(png())).json()) as AttachmentView;
    const { message } = await postUserMessage(db, ws, "pic", { attachmentIds: [view.id] });
    const seen: HubEvent[] = [];
    events.subscribe(ws, (e) => seen.push(e));
    const res = await local.request(`${HUB}/api/workspaces/${ws}/attachments/${view.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const updated = seen.find((e): e is Extract<HubEvent, { type: "message.updated" }> => e.type === "message.updated");
    expect(updated?.message.id).toBe(message.id);
    expect(updated?.message.attachments).toEqual([expect.objectContaining({ id: view.id, status: "deleted" })]);
  });

  test("two deletes on one message: a slow first read cannot emit after the newer snapshot", async () => {
    const events = new EventBus();
    let held = false;
    let otherEmitted: () => void = () => {};
    const emitted = new Promise<void>((r) => { otherEmitted = r; });
    // The first route read of the message's files runs at once (its snapshot predates the second delete) but
    // its result is handed back only after the second delete has emitted, or after 300 ms.
    const gated: Db = {
      async query(sql, params) {
        const rows = await db.query(sql, params);
        if (!held && /from message_attachments where message_id = any/.test(sql)) {
          held = true;
          await Promise.race([emitted, new Promise((r) => setTimeout(r, 300))]);
        }
        return rows as never;
      },
      tx: (fn) => db.tx(fn),
    };
    const local = createApp({ db: gated, dataDir, events, daemonStatus: () => true, daemon: { call: (m, p, t) => daemon.call(m, p, t) }, attachments });
    const a = (await (await upload(png())).json()) as AttachmentView;
    const b = (await (await upload(png())).json()) as AttachmentView;
    const { message } = await postUserMessage(db, ws, "pair", { attachmentIds: [a.id, b.id] });
    const updates: AttachmentView[][] = [];
    events.subscribe(ws, (e) => {
      if (e.type !== "message.updated" || e.message.id !== message.id) return;
      updates.push(e.message.attachments);
      if (updates.length === 1 && held) otherEmitted();
    });
    const del = (id: string) => local.request(`${HUB}/api/workspaces/${ws}/attachments/${id}`, { method: "DELETE" });
    const first = del(a.id);
    await vi.waitFor(() => expect(held).toBe(true));
    await Promise.all([first, del(b.id)]);
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)!.map((v) => v.status)).toEqual(["deleted", "deleted"]);
  });

  test("deleting an unsent upload emits nothing", async () => {
    const events = new EventBus();
    const local = createApp({ db, dataDir, events, daemonStatus: () => true, daemon: { call: (m, p, t) => daemon.call(m, p, t) }, attachments });
    const view = (await (await upload(png())).json()) as AttachmentView;
    const seen: HubEvent[] = [];
    events.subscribe(ws, (e) => seen.push(e));
    expect((await local.request(`${HUB}/api/workspaces/${ws}/attachments/${view.id}`, { method: "DELETE" })).status).toBe(200);
    expect(seen).toEqual([]);
  });
});
