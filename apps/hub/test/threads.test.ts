import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace } from "../src/workspaces.js";
import { addMessage, listMessages, listPromptMessages, listThreadMessages, postUserMessage } from "../src/messages.js";
import { recordTaskChange } from "../src/tasks.js";
import { associateQuestion, conversationOf, ensureThread, getLastAskedQuestion, getLastAgentMessage, getQuestionThread, listThreads, markThreadRead } from "../src/threads.js";
import { announceInterrupted } from "../src/interrupts.js";
import { EventBus } from "../src/events.js";

let db: Db;
let ws: string;
let otherWs: string;
beforeEach(async () => {
  const deps = await makeHubDeps(); db = deps.db;
  ws = (await createWorkspace(db, deps.dataDir, "A")).id;
  otherWs = (await createWorkspace(db, deps.dataDir, "B")).id;
});
afterAll(cleanupHubDeps);

async function openThread(title = "Topic") {
  const anchor = (await postUserMessage(db, ws, "anchor")).message;
  return { anchor, thread: await ensureThread(db, anchor.id, title, "user") };
}

describe("thread store and conversation context", () => {
  test("ensureThread is idempotent and retains the first title", async () => {
    const anchor = (await postUserMessage(db, ws, "anchor")).message;
    const first = await ensureThread(db, anchor.id, "First", "user");
    const second = await ensureThread(db, anchor.id, "Second", "agent");
    expect(second).toMatchObject({ id: first.id, title: "First", openedBy: "user" });
  });

  test("ensureThread refuses an anchor inside a thread", async () => {
    const { thread } = await openThread();
    const reply = await addMessage(db, ws, "agent", "reply");
    await db.query("update messages set thread_id = $2 where id = $1", [reply.id, thread.id]);
    await expect(ensureThread(db, reply.id, "Nested", "user")).rejects.toMatchObject({ status: 400 });
  });

  test("unread counts replies after last read and markThreadRead clears them", async () => {
    const { thread } = await openThread();
    const reply = await addMessage(db, ws, "agent", "reply");
    await db.query("update messages set thread_id = $2 where id = $1", [reply.id, thread.id]);
    expect(await listThreads(db, ws)).toMatchObject([{ id: thread.id, replyCount: 1, unread: 1 }]);
    await markThreadRead(db, thread.id, Number((await db.query<{seq:number}>("select seq from messages where id=$1", [reply.id]))[0]!.seq));
    expect((await listThreads(db, ws))[0]!.unread).toBe(0);
  });

  test("reopening a long thread loads the latest 200 replies and can acknowledge the latest", async () => {
    const { thread } = await openThread();
    for (let i = 1; i <= 201; i++) {
      const reply = await addMessage(db, ws, "agent", `reply ${i}`);
      await db.query("update messages set thread_id=$2 where id=$1", [reply.id, thread.id]);
    }
    const replies = await listThreadMessages(db, thread.id);
    expect(replies).toHaveLength(200);
    expect(replies[0]!.content).toBe("reply 2");
    expect(replies.at(-1)!.content).toBe("reply 201");
    await markThreadRead(db, thread.id, replies.at(-1)!.seq);
    expect((await listThreads(db, ws))[0]!.unread).toBe(0);
  });

  test("markRead never lowers last_read_seq and does not acknowledge a concurrent arrival", async () => {
    const { thread } = await openThread();
    const one = await addMessage(db, ws, "agent", "one");
    await db.query("update messages set thread_id=$2 where id=$1", [one.id, thread.id]);
    const seq1 = Number((await db.query<{seq:number}>("select seq from messages where id=$1", [one.id]))[0]!.seq);
    await db.query("update threads set last_read_seq=$2 where id=$1", [thread.id, seq1 + 100]);
    await markThreadRead(db, thread.id, seq1);
    expect(Number((await db.query<{last_read_seq:string}>("select last_read_seq from threads where id=$1", [thread.id]))[0]!.last_read_seq)).toBe(seq1 + 100);
    await db.query("update threads set last_read_seq=0 where id=$1", [thread.id]);
    const two = await addMessage(db, ws, "agent", "two");
    await db.query("update messages set thread_id=$2 where id=$1", [two.id, thread.id]);
    await markThreadRead(db, thread.id, seq1);
    expect((await listThreads(db, ws))[0]!.unread).toBe(1);
  });

  test("read rejects foreign, nonexistent, and invalid sequence values", async () => {
    const { thread } = await openThread();
    const { thread: foreign } = await openThread();
    await expect(markThreadRead(db, thread.id, 999999)).rejects.toMatchObject({ status: 400 });
    await expect(markThreadRead(db, thread.id, 0)).rejects.toMatchObject({ status: 400 });
    await expect(markThreadRead(db, thread.id, Number.NaN)).rejects.toMatchObject({ status: 400 });
    const msg = await addMessage(db, ws, "agent", "foreign");
    await db.query("update messages set thread_id=$2 where id=$1", [msg.id, foreign.id]);
    const seq = Number((await db.query<{seq:number}>("select seq from messages where id=$1", [msg.id]))[0]!.seq);
    await expect(markThreadRead(db, thread.id, seq)).rejects.toMatchObject({ status: 400 });
  });

  test("question association is durable, idempotent, and workspace scoped", async () => {
    const { thread } = await openThread();
    const { thread: second } = await openThread("Other");
    expect(await associateQuestion(db, ws, "Q-1", thread.id)).toEqual({ threadId: thread.id, inserted: true });
    expect(await associateQuestion(db, ws, "Q-1", second.id)).toEqual({ threadId: thread.id, inserted: false });
    expect(await getQuestionThread(db, ws, "Q-1")).toBe(thread.id);
    await expect(associateQuestion(db, otherWs, "Q-2", thread.id)).rejects.toMatchObject({ status: 400 });
  });

  test("question lookup infers every question created by the original thread task", async () => {
    const { thread } = await openThread();
    const { task, message } = await postUserMessage(db, ws, "question task", { threadId: thread.id });
    await recordTaskChange(db, task.id, { entryId: "Q-1", kind: "question", title: "Unselected", op: "add" });
    await recordTaskChange(db, task.id, { entryId: "Q-2", kind: "question", title: "Selected", op: "add" });
    await addMessage(db, ws, "agent", "ask", { taskId: task.id, meta: { changes: [], askedQuestion: { id: "Q-2", title: "Q", body: "?" } } });
    expect(await getQuestionThread(db, ws, "Q-1")).toBe(thread.id);
    expect(message.threadId).toBe(thread.id);
    expect(await getQuestionThread(db, ws, "legacy-question")).toBeNull();
  });

  test("a main-chat-created question stays legacy when selected by a thread task", async () => {
    const original = await postUserMessage(db, ws, "create question in main chat");
    await recordTaskChange(db, original.task.id, { entryId: "Q-MAIN", kind: "question", title: "Original", op: "add" });
    const { thread } = await openThread();
    const later = await postUserMessage(db, ws, "select prior question", { threadId: thread.id });
    await addMessage(db, ws, "agent", "selected", { taskId: later.task.id, meta: { changes: [], askedQuestion: { id: "Q-MAIN", title: "Original", body: "?" } } });
    expect(await getQuestionThread(db, ws, "Q-MAIN")).toBeNull();
  });

  test("posting a thread reply validates workspace and main chat excludes replies", async () => {
    const { thread } = await openThread();
    const posted = await postUserMessage(db, ws, "reply", { threadId: thread.id });
    expect(posted.message.threadId).toBe(thread.id);
    expect((await listThreads(db, ws))[0]!.replyCount).toBe(1);
    await expect(postUserMessage(db, otherWs, "wrong workspace", { threadId: thread.id })).rejects.toMatchObject({ status: 400 });
    const main = await postUserMessage(db, ws, "main");
    expect((await listPromptMessages(db, ws, main.message.id)).map((m) => m.id)).not.toContain(posted.message.id);
  });

  test("last asked question recognizes legacy system cards and prefers newer cards", async () => {
    const { thread } = await openThread();
    const anchor = await db.query<{seq:number}>("select seq from messages where id=$1", [thread.id]);
    const legacy = await addMessage(db, ws, "system", "legacy question card", { meta: { changes: [], askedQuestion: { id: "Q-OLD", title: "Old", body: "old body" } } });
    await db.query("update messages set thread_id=$2 where id=$1", [legacy.id, thread.id]);
    expect(await getLastAskedQuestion(db, ws, thread.id)).toMatchObject({ id: "Q-OLD" });
    const newer = await addMessage(db, ws, "agent", "new card", { meta: { changes: [], askedQuestion: { id: "Q-NEW", title: "New", body: "new body" } } });
    await db.query("update messages set thread_id=$2 where id=$1", [newer.id, thread.id]);
    expect(await getLastAskedQuestion(db, ws, thread.id)).toMatchObject({ id: "Q-NEW" });
    expect(anchor.length).toBe(1);
  });

  test("main prompt excludes thread messages and thread prompt is anchor plus latest 50", async () => {
    const main = (await postUserMessage(db, ws, "main anchor")).message;
    const { anchor, thread } = await openThread();
    for (let i=0;i<52;i++) {
      const reply = await addMessage(db, ws, "agent", `reply ${i}`);
      await db.query("update messages set thread_id=$2 where id=$1", [reply.id, thread.id]);
    }
    const future = await postUserMessage(db, ws, "future queued reply", { threadId: thread.id });
    expect((await listPromptMessages(db, ws, main.id)).map((m) => m.content)).not.toContain("reply 51");
    const context = await listPromptMessages(db, ws, anchor.id, 100);
    expect(context).toHaveLength(51);
    expect(context[0]!.id).toBe(anchor.id);
    expect(context.at(-1)!.content).toBe("reply 51");
    expect(context.map((m) => m.id)).not.toContain(future.message.id);
    expect(await conversationOf(db, anchor)).toBe(thread.id);
  });

  test("last agent message is scoped to the thread", async () => {
    const { thread } = await openThread();
    const inside = await addMessage(db, ws, "agent", "inside");
    await db.query("update messages set thread_id=$2 where id=$1", [inside.id, thread.id]);
    await addMessage(db, ws, "agent", "outside");
    expect(await getLastAgentMessage(db, ws, thread.id)).toMatchObject({ id: inside.id });
    expect(await getLastAgentMessage(db, ws, null)).toMatchObject({ content: "outside" });
  });

  test("terminal interruption failures go to each task's current thread and update its aggregate", async () => {
    const anchor = await postUserMessage(db, ws, "main anchor");
    const thread = await ensureThread(db, anchor.message.id, "Follow-up", "user");
    const member = await postUserMessage(db, ws, "thread member", { threadId: thread.id });
    const events = new EventBus();
    const observed: string[] = [];
    events.subscribe(ws, (event) => { observed.push(event.type); });

    await announceInterrupted(db, events, { requeued: [], failed: [anchor.task.id, member.task.id] });

    const failures = await listThreadMessages(db, thread.id);
    expect(failures.filter((m) => m.role === "system")).toHaveLength(2);
    expect(failures.filter((m) => m.role === "system").every((m) => m.threadId === thread.id)).toBe(true);
    expect((await listMessages(db, ws)).filter((m) => m.role === "system")).toHaveLength(0);
    expect(observed.filter((type) => type === "thread.updated")).toHaveLength(2);
    expect(observed).toEqual(["message.created", "thread.updated", "message.created", "thread.updated", "task.updated", "task.updated"]);
    expect((await listThreads(db, ws))[0]!.unread).toBe(3);
  });
});
