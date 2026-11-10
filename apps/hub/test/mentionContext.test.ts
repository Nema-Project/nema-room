import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
let closeDb: () => Promise<void> = async () => {};

beforeEach(async () => {
  const deps = await makeHubDeps();
  ({ db, dataDir } = deps);
  closeDb = deps.close;
  ws = (await createWorkspace(db, dataDir, "A")).id;
  daemon = { call: () => Promise.reject(new DaemonRpcError("daemon 未连接")) };
  attachments = new AttachmentStore(db, dataDir, { freeBytes: async () => 1e15 });
  app = createApp({ db, dataDir, events: new EventBus(), daemonStatus: () => true, daemon, attachments });
  // A 500-row case can leave PGlite slow enough that the next migration passes the 10s hook limit.
}, 30_000);
afterEach(async () => {
  await closeDb();
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

async function json(q: string, workspace = ws): Promise<Body> {
  const res = await search(q, workspace);
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
}

async function insertEntryAt(id: string, title: string, seconds: number, workspace = ws) {
  await db.query(
    `insert into entry_index(workspace_id, entry_id, kind, title, status, updated_at)
     values ($1,$2,'decision',$3,'active', timestamp '2020-01-01' + $4 * interval '1 second')`,
    [workspace, id, title, seconds],
  );
}

async function insertThreads(rows: { title: string; seconds: number; workspace?: string }[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const ids = rows.map(() => `thr_${++n}`);
  const msg = rows.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},'user',$${i * 4 + 3}, timestamp '2020-01-01' + $${i * 4 + 4} * interval '1 second')`).join(",");
  await db.query(
    `insert into messages(id, workspace_id, role, content, created_at) values ${msg}`,
    rows.flatMap((row, i) => [ids[i], row.workspace ?? ws, row.title, row.seconds]),
  );
  const thr = rows.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},'user', timestamp '2020-01-01' + $${i * 4 + 4} * interval '1 second')`).join(",");
  await db.query(
    `insert into threads(id, workspace_id, title, opened_by, created_at) values ${thr}`,
    rows.flatMap((row, i) => [ids[i], row.workspace ?? ws, row.title, row.seconds]),
  );
  return ids;
}

async function insertThreadAt(title: string, seconds: number, workspace = ws): Promise<string> {
  const [id] = await insertThreads([{ title, seconds, workspace }]);
  return id!;
}

/** A sent file with an explicit clock, so tests can put the interesting row outside the old 50. */
async function plantedAttachment(name: string, seconds: number, present: boolean, opts: { status?: "attached" | "staged" | "deleted"; workspace?: string } = {}): Promise<string> {
  const id = `att_${++n}`;
  const status = opts.status ?? "attached";
  const workspace = opts.workspace ?? ws;
  const messageId = status === "staged" ? null : `msg_${id}`;
  if (messageId) {
    await db.query(`insert into messages(id, workspace_id, role, content) values ($1,$2,'user',$3)`, [messageId, workspace, name]);
  }
  await db.query(
    `insert into message_attachments(id, workspace_id, message_id, kind, mime, name, size, sha256, upload_key, status, created_at, attached_at)
     values ($1,$2,$3,'image','image/png',$4,100,$5,$6,$7, timestamp '2020-01-01' + $8 * interval '1 second', timestamp '2020-01-01')`,
    [id, workspace, messageId, name, "ab".repeat(32), randomUUID(), status, seconds],
  );
  if (present) {
    const dir = path.join(dataDir, "attachments", workspace);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, id), png());
  }
  return id;
}

type Body = {
  status: string;
  entries: Array<Record<string, string>>;
  attachments: Array<Record<string, string | number>>;
  threads: Array<Record<string, string | null>>;
  truncated: boolean;
  attachmentBudgetExhausted: boolean;
};

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
    expect((await listMentionAttachments(db, ws, 50)).items).toHaveLength(3);
    expect(await listMentionAttachments(db, ws, 50)).toMatchObject({ more: false });
    expect((await listMentionAttachments(db, ws, 2)).items).toHaveLength(2);
    expect((await listMentionAttachments(db, ws, 2)).more).toBe(true);
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

  test("an attachment whose file vanished from disk is left out and marked missing", async () => {
    const alive = await sentAttachment("在的.png");
    const gone = await sentAttachment("没了.png");
    const { rm } = await import("node:fs/promises");
    const path = await import("node:path");
    await rm(path.join(dataDir, "attachments", ws, gone.id), { force: true });

    const body = (await (await search("")).json()) as Body;
    expect(body.attachments.map((a) => a.id)).toEqual([alive.id]);
    const rows = await db.query<{ status: string }>(`select status from message_attachments where id = $1`, [gone.id]);
    expect(rows[0]!.status).toBe("missing");
    // And it is not offered on the next request either, now that it is marked.
    expect(((await (await search("没了")).json()) as Body).attachments).toEqual([]);
  });

  test("truncated means more matches than the menu shows, including an empty query past 8", async () => {
    for (let i = 1; i <= 9; i++) await insertEntryAt(`D-${i}`, `九条命中 ${i}`, i);
    const nine = await json("九条命中");
    expect(nine.entries).toHaveLength(8);
    expect(nine.truncated).toBe(true);
    expect(nine.attachmentBudgetExhausted).toBe(false);
    const empty = await json("");
    expect(empty.entries).toHaveLength(8);
    expect(empty.truncated).toBe(true);
    await db.query(`delete from entry_index where workspace_id = $1 and entry_id = 'D-9'`, [ws]);
    const eight = await json("九条命中");
    expect(eight.entries).toHaveLength(8);
    expect(eight.truncated).toBe(false);
    expect(eight.attachmentBudgetExhausted).toBe(false);
  });

  test("a query of spaces longer than the limit is still refused", async () => {
    expect((await search(" ".repeat(201))).status).toBe(400);
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

  test("finds an entry and a thread outside the old pool, and not another workspace's row", async () => {
    const other = (await createWorkspace(db, dataDir, "B")).id;
    await insertEntryAt("D-1", "池外独特标题", 0);
    await insertEntryAt("D-1", "池外独特标题", 0, other);
    await insertEntryAt("D-2", "只在别处的标题", 1, other);
    for (let i = 2; i <= 501; i++) await insertEntryAt(`D-${i}`, `普通条目${i}`, i);
    await insertThreadAt("池外话题", 0);
    await insertThreadAt("池外话题", 0, other);
    await insertThreads(Array.from({ length: 500 }, (_, i) => ({ title: `普通话题${i + 1}`, seconds: i + 1 })));

    const entries = await json("池外独特标题");
    expect(entries.entries.map((e) => e.id)).toEqual(["D-1"]);
    expect(await json("只在别处的标题")).toMatchObject({ entries: [] });
    const threads = await json("池外话题");
    expect(threads.threads).toHaveLength(1);
    expect(threads.threads[0]!.title).toBe("池外话题");
  });

  test("finds the oldest sent file past 50 names and skips staged, deleted, and other workspaces", async () => {
    const other = (await createWorkspace(db, dataDir, "B")).id;
    const oldest = await plantedAttachment("最旧独特.png", 1, true);
    for (let i = 2; i <= 51; i++) await plantedAttachment(`普通文件${i}.png`, i, true);
    await plantedAttachment("最旧独特.png", 100, true, { status: "staged" });
    await plantedAttachment("最旧独特.png", 101, true, { status: "deleted" });
    await plantedAttachment("最旧独特.png", 102, true, { workspace: other });

    expect((await json("最旧独特")).attachments.map((a) => a.id)).toEqual([oldest]);
  });

  test("keeps subsequence matching, literal wildcards, and SQL case folding", async () => {
    await insertEntryAt("D-1", "甲发中流乙", 0);
    for (let i = 2; i <= 501; i++) await insertEntryAt(`E-${i}`, `普通条目${i}`, i);
    await insertEntryAt("D-600", "发布流程", 600);
    await insertEntryAt("D-601", "版本发布", 601);
    await insertEntryAt("D-602", "a.b*c", 602);
    await insertEntryAt("D-603", "含.*连续", 603);
    await insertEntryAt("D-604", "无关标题", 604);
    await insertEntryAt("D-605", "i", 605);
    await insertEntryAt("D-606", "İstanbul", 606);
    await insertEntryAt("D-607", "straße", 607);
    await insertEntryAt("D-12", "别的标题", 608);
    await insertEntryAt("D-99", "d-12 开头", 609);

    const fa = await json("发流");
    expect(fa.entries.map((e) => e.id).sort()).toEqual(["D-1", "D-600"]);
    expect((await json("发布")).entries.map((e) => e.id).sort()).toEqual(["D-600", "D-601"]);
    expect((await json("甲流乙")).entries.map((e) => e.id)).toEqual(["D-1"]);
    expect((await json("abc")).entries.map((e) => e.id)).toEqual(["D-602"]);
    expect((await json(".*")).entries.map((e) => e.id).sort()).toEqual(["D-602", "D-603"]);
    expect((await json("%")).entries).toEqual([]);
    expect((await json("_")).entries).toEqual([]);
    expect((await json("İ")).entries.map((e) => e.id).sort()).toEqual(["D-605", "D-606"]);
    expect((await json("ß")).entries.map((e) => e.id)).toEqual(["D-607"]);
    expect((await json("ss")).entries).toEqual([]);
    expect((await json("d-12")).entries[0]!.id).toBe("D-12");
  });

  test("ranks a shorter UTF-16 title ahead of a newer non-BMP title and matches JavaScript length", async () => {
    const lengths = await db.query<{ n: number }>(
      `select (
         select coalesce(sum(case when ascii(substring($1 from i for 1)) > 65535 then 2 else 1 end), 0)
         from generate_series(1, char_length($1)) as i
       )::int as n`,
      ["abcd"],
    );
    const emojiLen = await db.query<{ n: number }>(
      `select (
         select coalesce(sum(case when ascii(substring($1 from i for 1)) > 65535 then 2 else 1 end), 0)
         from generate_series(1, char_length($1)) as i
       )::int as n`,
      ["a😀😀"],
    );
    expect(Number(lengths[0]!.n)).toBe("abcd".length);
    expect(Number(emojiLen[0]!.n)).toBe("a😀😀".length);

    const [older, newer] = await insertThreads([
      { title: "abcd", seconds: 0 },
      { title: "a😀😀", seconds: 1000 },
      ...Array.from({ length: 500 }, (_, i) => ({ title: `普通话题${i + 1}`, seconds: i + 1 })),
    ]);
    expect((await json("a")).threads.map((t) => t.id)).toEqual([older, newer]);
  });

  test("skips the newest missing files and still returns the next eight without stating more than 50", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 40; i++) ids.push(await plantedAttachment("同名.png", i, i <= 24));
    const spy = vi.spyOn(attachments, "available");
    const found = await json("同名");
    expect(found.attachments.map((a) => a.id)).toEqual(ids.slice(16, 24).reverse());
    expect(found.attachmentBudgetExhausted).toBe(false);
    expect(spy).toHaveBeenCalledTimes(24);
    expect(spy.mock.calls.every((call) => (call[1] as readonly string[]).length === 1)).toBe(true);
  });

  test("an exhausted stat budget with a later file still on disk is not an empty finished result", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 51; i++) ids.push(await plantedAttachment("同名.png", i, i === 1));
    const spy = vi.spyOn(attachments, "available");
    const found = await json("同名");
    expect(found.attachments).toEqual([]);
    expect(found.attachmentBudgetExhausted).toBe(true);
    expect(found.truncated).toBe(true);
    expect(JSON.stringify(found)).not.toContain(ids[0]!);
    expect(spy).toHaveBeenCalledTimes(50);
  });

  test("exactly 50 missing files and no further row is a finished empty attachment group", async () => {
    for (let i = 1; i <= 50; i++) await plantedAttachment("同名.png", i, false);
    const found = await json("同名");
    expect(found.attachments).toEqual([]);
    expect(found.attachmentBudgetExhausted).toBe(false);
    expect(found.truncated).toBe(false);
  });

  test("a query containing NUL is refused before it reaches SQL", async () => {
    const res = await search("a\0b");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "q contains a NUL character" });
    const encoded = await app.request(`${HUB}/api/workspaces/${ws}/mention-context?q=%00`);
    expect(encoded.status).toBe(400);
    expect(await encoded.json()).toEqual({ error: "q contains a NUL character" });
  });
});
