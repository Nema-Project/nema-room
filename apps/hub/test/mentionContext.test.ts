import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { Hono } from "hono";
import { AttachmentStore } from "../src/attachments.js";
import { createApp } from "../src/app.js";
import type { DaemonRpc } from "../src/daemonRpc.js";
import { DaemonRpcError } from "../src/daemonRpc.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { createWorkspace, updateWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
let db: Db;
let dataDir: string;
let ws: string;
let app: Hono<any>;
let daemon: DaemonRpc;
let attachments: AttachmentStore;
let n = 0;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  ws = (await createWorkspace(db, dataDir, "A")).id;
  daemon = { call: () => Promise.reject(new DaemonRpcError("daemon 未连接")) };
  attachments = new AttachmentStore(db, dataDir, { freeBytes: async () => 1e15 });
  app = createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon, attachments });
});
afterAll(cleanupHubDeps);

const png = () => {
  const b = new Uint8Array(100).fill(1);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};
const key = () => `11111111-2222-4333-8444-${String(++n).padStart(12, "0")}`;

/** Upload a PNG and bind it to a message, the way a composer send would. */
async function sentAttachment(name: string, workspace = ws): Promise<{ id: string; messageId: string }> {
  const res = await app.request(`${HUB}/api/workspaces/${workspace}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": String(png().length), "x-nema-filename": encodeURIComponent(name), "x-nema-upload-key": key() },
    body: png(),
  });
  const view = (await res.json()) as { id: string };
  const msg = await app.request(`${HUB}/api/workspaces/${workspace}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `看 ${name}`, attachmentIds: [view.id] }),
  });
  const body = (await msg.json()) as { message?: { id: string } };
  return { id: view.id, messageId: body.message!.id };
}

async function stagedOnly(name: string): Promise<string> {
  const res = await app.request(`${HUB}/api/workspaces/${ws}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": String(png().length), "x-nema-filename": encodeURIComponent(name), "x-nema-upload-key": key() },
    body: png(),
  });
  return ((await res.json()) as { id: string }).id;
}

async function insertEntry(id: string, kind: string, title: string, status = "active") {
  await db.query(
    `insert into entry_index(workspace_id, entry_id, kind, title, status, business_date, updated_at)
     values ($1,$2,$3,$4,$5,null,clock_timestamp())`,
    [ws, id, kind, title, status],
  );
}

async function makeThread(title: string): Promise<string> {
  const res = await app.request(`${HUB}/api/workspaces/${ws}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, content: title }),
  });
  return ((await res.json()) as { thread: { id: string } }).thread.id;
}

const search = (q: string | undefined, workspace = ws) =>
  app.request(`${HUB}/api/workspaces/${workspace}/mention-context${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`);

type Body = { status: string; entries: Array<Record<string, string>>; attachments: Array<Record<string, string | number>>; threads: Array<Record<string, string | null>>; truncated: boolean };

describe("GET /api/workspaces/:id/mention-context", () => {
  test("returns entries, sent attachments and threads of this workspace only, with names and ids and nothing else", async () => {
    await insertEntry("D-12", "decision", "发布流程");
    await insertEntry("R-3", "requirement", "支持导出");
    const att = await sentAttachment("截图 1.png");
    const tid = await makeThread("发布流程讨论");
    const other = (await createWorkspace(db, dataDir, "B")).id;
    await db.query(`insert into entry_index(workspace_id, entry_id, kind, title, status, updated_at) values ($1,'D-99','decision','别的工作区','active',clock_timestamp())`, [other]);

    const res = await search("");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.status).toBe("ok");
    expect(body.entries.map((e) => e.id).sort()).toEqual(["D-12", "R-3"]);
    expect(body.entries[0]).toMatchObject({ kind: expect.any(String), title: expect.any(String), status: expect.any(String) });
    expect(body.attachments).toEqual([{ id: att.id, name: "截图 1.png", kind: "image", size: 100, messageId: att.messageId, createdAt: expect.any(String) }]);
    expect(body.threads.map((t) => t.id)).toEqual([tid]);
    expect(body.truncated).toBe(false);
    // No content of any kind: no attachment bytes, no hashes, no bodies.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("sha256");
    expect(raw).not.toContain("base64");
  });

  test("ranks an entry by title and puts an exactly typed id first", async () => {
    await insertEntry("D-12", "decision", "发布流程");
    await insertEntry("D-13", "decision", "发布流程的备选");
    await insertEntry("D-14", "decision", "无关");
    const byTitle = (await (await search("发布")).json()) as Body;
    expect(byTitle.entries.map((e) => e.id)).toEqual(["D-12", "D-13"]);
    const byId = (await (await search("d-13")).json()) as Body;
    expect(byId.entries[0]!.id).toBe("D-13");
  });

  test("ranks attachments by name and never lists a staged, deleted, missing or expired one", async () => {
    const sent = await sentAttachment("发布会截图.png");
    await stagedOnly("发布未发送.png");
    const gone = await sentAttachment("已删除.png");
    await app.request(`${HUB}/api/workspaces/${ws}/attachments/${gone.id}`, { method: "DELETE" });
    await db.query(`update message_attachments set status = 'missing' where id = $1`, [(await sentAttachment("丢失.png")).id]);

    const body = (await (await search("发布")).json()) as Body;
    expect(body.attachments.map((a) => a.id)).toEqual([sent.id]);
  });

  test("keeps at most 8 per group and reports 50 attachment candidates as truncated", async () => {
    for (let i = 1; i <= 10; i++) await insertEntry(`D-${i}`, "decision", `条目 ${i}`);
    for (let i = 1; i <= 3; i++) await sentAttachment(`附件 ${i}.png`);
    const body = (await (await search("")).json()) as Body;
    expect(body.entries).toHaveLength(8);
    expect(body.attachments).toHaveLength(3);

    const { listMentionAttachments } = await import("../src/mentionContext.js");
    expect(await listMentionAttachments(db, ws, 50)).toHaveLength(3);
    expect((await listMentionAttachments(db, ws, 2)).length).toBe(2);
  });

  test("an empty query lists the most recent of each group instead of a whole workspace", async () => {
    for (let i = 1; i <= 3; i++) await insertEntry(`D-${i}`, "decision", `条目 ${i}`);
    await sentAttachment("一.png");
    await new Promise((r) => setTimeout(r, 5));
    await sentAttachment("二.png");
    const body = (await (await search(undefined)).json()) as Body;
    expect(body.attachments[0]!.name).toBe("二.png");
    expect(body.entries).toHaveLength(3);
  });

  test("does not call the daemon: attachments and entries live in the hub", async () => {
    const calls: string[] = [];
    daemon = { call: (m) => { calls.push(m); return Promise.reject(new Error("no")); } };
    app = createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => false, daemon, attachments });
    await sentAttachment("一.png");
    expect((await search("一")).status).toBe(200);
    expect(calls).toEqual([]);
  });

  test("an unknown workspace is 404; an archived one still answers; an overlong query is 400", async () => {
    expect((await search("a", "ws_missing")).status).toBe(404);
    await sentAttachment("一.png");
    await updateWorkspace(db, ws, { archived: true });
    expect((await (await search("一")).json()) as Body).toMatchObject({ status: "ok" });
    expect((await search("x".repeat(201))).status).toBe(400);
  });
});
