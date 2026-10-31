import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import type { DaemonRpc } from "../src/daemonRpc.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { AttachmentStore } from "../src/attachments.js";
import { deliverySet } from "../src/messages.js";
import { mentionSection, resolveMentions, validateMentions } from "../src/mentions.js";
import { createWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
let db: Db;
let dataDir: string;
let ws: string;
let app: ReturnType<typeof createApp>;
let attachments: AttachmentStore;
let n = 0;

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  ws = (await createWorkspace(db, dataDir, "A")).id;
  const daemon: DaemonRpc = { call: () => Promise.reject(new Error("unexpected daemon call")) };
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

async function uploaded(name: string, workspace = ws): Promise<string> {
  const res = await app.request(`${HUB}/api/workspaces/${workspace}/attachments`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "content-length": String(png().length), "x-nema-filename": encodeURIComponent(name), "x-nema-upload-key": key() },
    body: png(),
  });
  return ((await res.json()) as { id: string }).id;
}

/** Upload and send one, the way the composer does, so it becomes `attached`. */
async function sent(name: string, workspace = ws): Promise<{ id: string; messageId: string }> {
  const id = await uploaded(name, workspace);
  const res = await app.request(`${HUB}/api/workspaces/${workspace}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `看 ${name}`, attachmentIds: [id] }),
  });
  const body = (await res.json()) as { message: { id: string } };
  return { id, messageId: body.message.id };
}

async function insertEntry(id: string, kind = "decision", title = "发布流程", workspace = ws) {
  await db.query(
    `insert into entry_index(workspace_id, entry_id, kind, title, status, business_date, updated_at)
     values ($1,$2,$3,$4,'active',null,clock_timestamp())`,
    [workspace, id, kind, title],
  );
}

async function makeThread(title: string, workspace = ws): Promise<string> {
  const res = await app.request(`${HUB}/api/workspaces/${workspace}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: title }),
  });
  return ((await res.json()) as { thread: { id: string } }).thread.id;
}

/** A real knowledge entry in the store (and its index row), which is what resolveMentions reads. */
async function writeEntry(id: string, title: string) {
  const { KnowledgeStore } = await import("@nema/knowledge");
  const { repoPath } = await import("../src/workspaces.js");
  const { indexEntry } = await import("../src/entryIndex.js");
  const store = new KnowledgeStore(repoPath(dataDir, ws));
  // No id: the store assigns the next one for the kind, so a test entry is created rather than updated.
  const { entry } = await store.upsert(
    { kind: "decision", title, body: "先灰度再全量。", reason: "test", sourceMessages: [] },
    { author: "user" },
  );
  await indexEntry(db, ws, entry);
  return entry.id;
}

const send = (body: unknown, workspace = ws) =>
  app.request(`${HUB}/api/workspaces/${workspace}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST a message with mentions", () => {
  test("stores mentions on the main chat, a thread reply and a new thread", async () => {
    await insertEntry("D-12");
    const att = await sent("截图 1.png");
    const thread = await makeThread("发布流程");
    const mention = { type: "entry", id: "D-12", text: "[D-12]" };
    const attach = { type: "attachment", id: att.id, text: "`附件：截图 1.png`" };
    const topic = { type: "thread", id: thread, text: "[话题：发布流程]" };

    const main = await send({ content: "按 [D-12] 来", mentions: [mention] });
    expect(main.status).toBe(200);
    const mainBody = (await main.json()) as { message: { id: string; meta: { mentions: unknown[] } } };
    expect(mainBody.message.meta.mentions).toEqual([mention]);

    const reply = await app.request(`${HUB}/api/workspaces/${ws}/threads/${thread}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "看 `附件：截图 1.png`", mentions: [attach] }),
    });
    expect(reply.status).toBe(200);
    expect(((await reply.json()) as { message: { meta: { mentions: unknown[] } } }).message.meta.mentions).toEqual([attach]);

    const created = await app.request(`${HUB}/api/workspaces/${ws}/threads`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "[话题：发布流程] 继续", mentions: [topic] }),
    });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { message: { meta: { mentions: unknown[] } } }).message.meta.mentions).toEqual([topic]);
  });

  test("a request without mentions stores none and behaves as before", async () => {
    const res = await send({ content: "普通消息" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: { meta: unknown } }).message.meta).toBeNull();
  });

  test("refuses an entry, attachment or thread of another workspace, and a missing entry, without writing", async () => {
    const other = (await createWorkspace(db, dataDir, "B")).id;
    const foreignAtt = await sent("别处.png", other);
    await insertEntry("D-77", "decision", "别的工作区", other);
    const foreignThread = await makeThread("别处的话题", other);
    await insertEntry("D-12");

    const cases: Array<[string, unknown]> = [
      ["foreign entry", { type: "entry", id: "D-77", text: "[D-77]" }],
      ["missing entry", { type: "entry", id: "D-88", text: "[D-88]" }],
      ["foreign attachment", { type: "attachment", id: foreignAtt.id, text: "`附件：别处.png`" }],
      ["foreign thread", { type: "thread", id: foreignThread, text: "[话题：别处的话题]" }],
    ];
    for (const [label, mention] of cases) {
      const res = await send({ content: `看 ${(mention as { text: string }).text}`, mentions: [mention] });
      expect(res.status, label).toBe(400);
    }
    const left = await db.query<{ n: number }>(`select count(*)::int as n from messages where workspace_id = $1`, [ws]);
    expect(left[0]!.n).toBe(0); // nothing was written for any refused send
  });

  test("refuses an attachment that was uploaded but never sent, and one that was deleted", async () => {
    const staged = await uploaded("未发送.png");
    expect((await send({ content: "看 `附件：未发送.png`", mentions: [{ type: "attachment", id: staged, text: "`附件：未发送.png`" }] })).status).toBe(400);

    const gone = await sent("已删除.png");
    await app.request(`${HUB}/api/workspaces/${ws}/attachments/${gone.id}`, { method: "DELETE" });
    expect((await send({ content: "看 `附件：已删除.png`", mentions: [{ type: "attachment", id: gone.id, text: "`附件：已删除.png`" }] })).status).toBe(400);
  });

  test("refuses a mention whose text does not appear in the body often enough", async () => {
    await insertEntry("D-12");
    const m = { type: "entry", id: "D-12", text: "[D-12]" };
    expect((await send({ content: "没有提到", mentions: [m] })).status).toBe(400);
    expect((await send({ content: "[D-12]", mentions: [m, { ...m }] })).status).toBe(400);
    expect((await send({ content: "[D-12] 和 [D-12]", mentions: [m, { ...m }] })).status).toBe(200);
  });

  test("a mentioned attachment joins the delivery set once, and coexists with the message's own files", async () => {
    await insertEntry("D-12");
    const mentioned = await sent("被提及.png");
    const own = { id: await uploaded("自己的.png") };

    const res = await send({
      content: "看 `附件：被提及.png` 和 `附件：被提及.png`",
      attachmentIds: [own.id],
      mentions: [
        { type: "attachment", id: mentioned.id, text: "`附件：被提及.png`" },
        { type: "attachment", id: mentioned.id, text: "`附件：被提及.png`" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { id: string }; task: { id: string } };
    const delivered = await deliverySet(db, body.task.id);
    expect(delivered.map((a) => a.id)).toEqual([own.id, mentioned.id]);
  });

  test("refuses to send when the mentions push the delivery over 8 files", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 9; i++) ids.push((await sent(`文件 ${i}.png`)).id);
    const res = await send({
      content: ids.map((_, i) => `\`附件：文件 ${i + 1}.png\``).join(" "),
      mentions: ids.map((id, i) => ({ type: "attachment", id, text: `\`附件：文件 ${i + 1}.png\`` })),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: string };
    expect(err.error).toContain("附件");
  });

  test("a replay with the same mentions is not written twice; a different mention is a 409", async () => {
    await insertEntry("D-12");
    await insertEntry("D-13");
    const att = await uploaded("同一批.png");
    const base = { content: "按 [D-12] 来", attachmentIds: [att], mentions: [{ type: "entry", id: "D-12", text: "[D-12]" }] };

    const first = await send(base);
    expect(first.status).toBe(200);
    const again = (await (await send(base)).json()) as { replayed: boolean };
    expect(again.replayed).toBe(true);

    const other = await send({ ...base, mentions: [{ type: "entry", id: "D-13", text: "[D-13]" }] });
    expect(other.status).toBe(409);
  });

  test("editing the body drops a mention whose text is gone and keeps the other", async () => {
    await insertEntry("D-12");
    await insertEntry("D-13");
    const sentMsg = (await (await send({ content: "[D-12] 和 [D-13]", mentions: [
      { type: "entry", id: "D-12", text: "[D-12]" },
      { type: "entry", id: "D-13", text: "[D-13]" },
    ] })).json()) as { message: { id: string } };

    await db.query(`update tasks set status = 'done' where message_id = $1`, [sentMsg.message.id]);
    const edited = await app.request(`${HUB}/api/workspaces/${ws}/messages/${sentMsg.message.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "只留 [D-13]" }),
    });
    expect(edited.status).toBe(200);
    const meta = ((await edited.json()) as { message: { meta: { mentions: Array<{ id: string }> } } }).message.meta;
    expect(meta.mentions.map((m) => m.id)).toEqual(["D-13"]);
  });

  test("editing keeps a mention whose stored text survives even if the attachment was renamed", async () => {
    const att = await sent("旧名字.png");
    const text = "`附件：旧名字.png`";
    const sentMsg = (await (await send({ content: `看 ${text}`, mentions: [{ type: "attachment", id: att.id, text }] })).json()) as { message: { id: string } };
    await db.query(`update message_attachments set name = '新名字.png' where id = $1`, [att.id]);
    await db.query(`update tasks set status = 'done' where message_id = $1`, [sentMsg.message.id]);
    const edited = await app.request(`${HUB}/api/workspaces/${ws}/messages/${sentMsg.message.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `看 ${text} 再说` }),
    });
    const meta = ((await edited.json()) as { message: { meta: { mentions: Array<{ id: string }> } } }).message.meta;
    expect(meta.mentions.map((m) => m.id)).toEqual([att.id]);
  });
});

describe("validateMentions", () => {
  test("counts the stored text in the body", async () => {
    await insertEntry("D-12");
    const m = { type: "entry", id: "D-12", text: "[D-12]" } as const;
    await expect(validateMentions(db, ws, "[D-12]", [m])).resolves.toBeUndefined();
    await expect(validateMentions(db, ws, "[D-12] [D-12]", [m, { ...m }])).resolves.toBeUndefined();
    await expect(validateMentions(db, ws, "x", [m])).rejects.toThrow(/出现/);
    await expect(validateMentions(db, ws, "[D-12]", [m, { ...m }])).rejects.toThrow(/出现/);
  });
});

describe("mentionSection", () => {
  const entryMention = { type: "entry", id: "D-12", text: "[D-12]" } as const;

  test("is empty without mentions, so the prompt is unchanged", () => {
    expect(mentionSection({ entries: [], attachments: [], threads: [], delivered: new Set() })).toBe("");
  });

  test("inlines an entry with its kind and status", () => {
    const section = mentionSection({
      entries: [{ id: "D-12", kind: "decision", title: "发布流程", status: "active", body: "先灰度再全量。" }],
      attachments: [], threads: [], delivered: new Set(),
    });
    expect(section).toContain("# 本次提及的上下文");
    expect(section).toContain("## 条目 [D-12] 发布流程（decision，active）");
    expect(section).toContain("先灰度再全量。");
    expect(section).toContain("不是用户的决定");
    void entryMention;
  });

  test("cuts an entry body at 4 KiB of UTF-8 bytes without splitting a character, and points at read_entry", () => {
    const body = "あ".repeat(2000); // 6000 bytes
    const section = mentionSection({ entries: [{ id: "D-12", kind: "decision", title: "t", status: "active", body }], attachments: [], threads: [], delivered: new Set() });
    const line = section.split("\n").find((l) => l.startsWith("あ"))!;
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(4096 + Buffer.byteLength("（已截断，完整内容用 read_entry D-12 读取）"));
    expect(line).not.toContain("\uFFFD");
    expect(section).toContain("read_entry D-12");
  });

  test("four full 4 KiB entries use up the 16 KiB budget and the fifth gets only its id and title", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({ id: `D-${i + 1}`, kind: "decision", title: `条目${i + 1}`, status: "active", body: "x".repeat(4096) }));
    const section = mentionSection({ entries, attachments: [], threads: [], delivered: new Set() });
    for (const n of [1, 2, 3, 4]) expect(section).toContain(`## 条目 [D-${n}] 条目${n}（decision，active）`);
    expect(section).toContain("## 条目 [D-5] 条目5：超出本次预算，用 read_entry 读取");
    // The inlined bodies alone stay within the 16 KiB total.
    const inlined = section.split("\n").filter((l) => l.startsWith("x"));
    expect(inlined.reduce((sum, l) => sum + Buffer.byteLength(l, "utf8"), 0)).toBeLessThanOrEqual(16384);
  });

  test("says a deleted entry no longer exists", () => {
    const section = mentionSection({ entries: [{ id: "R-9", title: "", missing: true }], attachments: [], threads: [], delivered: new Set() });
    expect(section).toContain("## 条目 [R-9]：已不存在");
  });

  test("names an attachment and whether this task delivers it", () => {
    const section = mentionSection({
      entries: [],
      attachments: [
        { id: "att_a", name: "截图 1.png", kind: "image", status: "attached", messageId: "m_1" },
        { id: "att_b", name: "旧.pdf", kind: "pdf", status: "deleted", messageId: "m_2" },
      ],
      threads: [], delivered: new Set(["att_a"]),
    });
    expect(section).toContain("## 附件「截图 1.png」（image，message m_1）");
    expect(section).toContain("已随本次任务投递");
    expect(section).toContain("## 附件「旧.pdf」");
    expect(section).toContain("已删除，内容不可用");
  });

  test("gives a thread its title and a truncated anchor, and nothing else", () => {
    const section = mentionSection({
      entries: [], attachments: [], delivered: new Set(),
      threads: [{ id: "m_t", title: "发布流程", anchor: { role: "user", content: "長".repeat(1000) } }],
    });
    expect(section).toContain("## 话题「发布流程」");
    expect(section).toContain("[m_t] user:");
    const anchorLine = section.split("\n").find((l) => l.startsWith("[m_t]"))!;
    expect(Buffer.byteLength(anchorLine, "utf8")).toBeLessThan(1024 + 200);
    expect(section).toContain("需要更多上下文");
  });

  test("expands the same object once even when it was mentioned twice", () => {
    const section = mentionSection({
      entries: [{ id: "D-12", kind: "decision", title: "发布流程", status: "active", body: "一次" }],
      attachments: [], threads: [], delivered: new Set(),
    });
    expect(section.match(/# 本次提及的上下文/g)).toHaveLength(1);
    expect(section.match(/## 条目 \[D-12\]/g)).toHaveLength(1);
  });
});

describe("resolveMentions", () => {
  test("reads entries from the store, attachments from the table and a thread's anchor", async () => {
    const entryId = await writeEntry("D-12", "发布流程");
    const att = await sent("截图 1.png");
    const thread = await makeThread("发布流程");
    const resolved = await resolveMentions(db, dataDir, ws, [
      { type: "entry", id: entryId, text: `[${entryId}]` },
      { type: "attachment", id: att.id, text: "`附件：截图 1.png`" },
      { type: "thread", id: thread, text: "[话题：发布流程]" },
    ], { delivered: new Set([att.id]) });
    expect(resolved.entries[0]).toMatchObject({ id: entryId, kind: "decision", title: "发布流程", body: expect.stringContaining("先灰度") });
    expect(resolved.attachments[0]).toMatchObject({ id: att.id, name: "截图 1.png", status: "attached" });
    expect(resolved.threads[0]).toMatchObject({ id: thread, title: "发布流程" });
  });

  test("marks an entry that is gone as missing instead of failing", async () => {
    const resolved = await resolveMentions(db, dataDir, ws, [{ type: "entry", id: "D-99", text: "[D-99]" }], { delivered: new Set() });
    expect(resolved.entries[0]).toMatchObject({ id: "D-99", missing: true });
  });
});

