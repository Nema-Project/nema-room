import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace } from "../src/workspaces.js";
import { addMessage, listMessages, postUserMessage } from "../src/messages.js";
import {
  claimNextTask,
  getTask,
  finishTask,
  interruptRunning,
  listTaskChanges,
  recordTaskChange,
  requeueDaemonTasks,
  resolveRunToken,
} from "../src/tasks.js";

let db: Db;
let wsA: string;
let wsB: string;

function interruptionsOf(database: Db, taskId: string): Promise<number> {
  return database
    .query<{ interruptions: number }>("select interruptions from tasks where id = $1", [taskId])
    .then((rows) => rows[0]!.interruptions);
}

beforeEach(async () => {
  const deps = await makeHubDeps();
  db = deps.db;
  wsA = (await createWorkspace(db, deps.dataDir, "A")).id;
  wsB = (await createWorkspace(db, deps.dataDir, "B")).id;
});
afterAll(cleanupHubDeps);

describe("tasks", () => {
  test("per-workspace serial, cross-workspace parallel", async () => {
    const a1 = await postUserMessage(db, wsA, "memo 1");
    const a2 = await postUserMessage(db, wsA, "memo 2");
    const b1 = await postUserMessage(db, wsB, "memo b");
    const t1 = await claimNextTask(db, "d1");
    expect(t1?.id).toBe(a1.task.id);
    const t2 = await claimNextTask(db, "d1");
    expect(t2?.id).toBe(b1.task.id);
    expect(await claimNextTask(db, "d1")).toBeNull();
    await finishTask(db, t1!.id, { ok: true });
    expect((await claimNextTask(db, "d1"))?.id).toBe(a2.task.id);
  });

  test("run token valid only while running", async () => {
    const a = await postUserMessage(db, wsA, "m");
    const t = await claimNextTask(db, "d1");
    expect(t?.runToken).toMatch(/^[0-9a-f]{64}$/);
    expect(t?.daemonId).toBe("d1");
    expect(await resolveRunToken(db, t!.runToken!)).toEqual({ taskId: a.task.id, workspaceId: wsA });
    await finishTask(db, t!.id, { ok: false, error: "boom" });
    expect(await resolveRunToken(db, t!.runToken!)).toBeNull();
  });

  test("requeueDaemonTasks returns running tasks to queue with a new token on reclaim", async () => {
    await postUserMessage(db, wsA, "m");
    const t = await claimNextTask(db, "d1");
    expect(await requeueDaemonTasks(db, "d1")).toBe(1);
    const again = await claimNextTask(db, "d2");
    expect(again?.id).toBe(t!.id);
    expect(again?.runToken).not.toBe(t!.runToken);
  });

  test("requeueAllRunning (hub startup) requeues every running task and kills its run token", async () => {
    const a = await postUserMessage(db, wsA, "a");
    const b = await postUserMessage(db, wsB, "b");
    await postUserMessage(db, wsA, "a2");
    const ta = (await claimNextTask(db, "d_old1"))!;
    const tb = (await claimNextTask(db, "d_old2"))!;
    expect((await interruptRunning(db, "all")).requeued.sort()).toEqual([a.task.id, b.task.id].sort());
    for (const t of [ta, tb]) {
      expect(await getTask(db, t.id)).toMatchObject({ status: "queued", runToken: null, daemonId: null });
      expect(await resolveRunToken(db, t.runToken!)).toBeNull();
    }
    expect(await interruptRunning(db, "all")).toEqual({ requeued: [], failed: [] });
    const again = (await claimNextTask(db, "d_new"))!;
    expect(again.id).toBe(a.task.id);
    expect(again.runToken).not.toBe(ta.runToken);
  });

  test("requeueRunningExcept keeps the given daemon's running task", async () => {
    await postUserMessage(db, wsA, "a");
    await postUserMessage(db, wsB, "b");
    const ta = (await claimNextTask(db, "d_old"))!;
    const tb = (await claimNextTask(db, "d_cur"))!;
    expect((await interruptRunning(db, { exceptDaemonId: "d_cur" })).requeued).toEqual([ta.id]);
    expect((await getTask(db, ta.id))?.status).toBe("queued");
    expect((await getTask(db, tb.id))?.status).toBe("running");
  });

  test("the fourth interruption fails the task with INTERRUPTED_ERROR", async () => {
    await postUserMessage(db, wsA, "m");
    const t = (await claimNextTask(db, "d1"))!;
    for (let i = 0; i < 3; i++) {
      expect(await interruptRunning(db, "all")).toEqual({ requeued: [t.id], failed: [] });
      expect((await claimNextTask(db, "d1"))?.id).toBe(t.id);
    }
    expect(await interruptRunning(db, "all")).toEqual({ requeued: [], failed: [t.id] });
    const [row] = await db.query<{ status: string; error: string | null; interruptions: number }>(
      "select status, error, interruptions from tasks where id = $1",
      [t.id],
    );
    expect(row).toMatchObject({
      status: "failed",
      error: "任务被中断，自动重试 3 次后仍未完成。请重新发送这条消息。",
      interruptions: 4,
    });
  });

  test("interruptions are counted per task and scoped by daemon", async () => {
    await postUserMessage(db, wsA, "a");
    await postUserMessage(db, wsB, "b");
    const ta = (await claimNextTask(db, "dA"))!;
    const tb = (await claimNextTask(db, "dB"))!;
    expect(await interruptRunning(db, { daemonId: "dA" })).toEqual({ requeued: [ta.id], failed: [] });
    expect((await getTask(db, ta.id))?.status).toBe("queued");
    expect((await getTask(db, tb.id))?.status).toBe("running");
    expect(await interruptionsOf(db, ta.id)).toBe(1);
    expect(await interruptionsOf(db, tb.id)).toBe(0);
    expect((await claimNextTask(db, "dA"))?.id).toBe(ta.id);
    expect(await interruptRunning(db, { exceptDaemonId: "dB" })).toEqual({ requeued: [ta.id], failed: [] });
    expect((await getTask(db, ta.id))?.status).toBe("queued");
    expect((await getTask(db, tb.id))?.status).toBe("running");
    expect(await interruptionsOf(db, ta.id)).toBe(2);
    expect(await interruptionsOf(db, tb.id)).toBe(0);
  });

  test("a normal failure is not retried", async () => {
    await postUserMessage(db, wsA, "m");
    const t = (await claimNextTask(db, "d1"))!;
    expect(await finishTask(db, t.id, { ok: false, error: "boom" })).toBe(true);
    const [row] = await db.query<{ status: string; interruptions: number }>(
      "select status, interruptions from tasks where id = $1",
      [t.id],
    );
    expect(row).toEqual({ status: "failed", interruptions: 0 });
  });

  test("claimNextTask skips archived workspaces", async () => {
    const a = await postUserMessage(db, wsA, "a");
    await db.query("update workspaces set archived_at = now() where id = $1", [wsA]);
    expect(await claimNextTask(db, "d1")).toBeNull();
    await db.query("update workspaces set archived_at = null where id = $1", [wsA]);
    expect((await claimNextTask(db, "d1"))?.id).toBe(a.task.id);
  });

  test("task changes are merged per entry", async () => {
    const a = await postUserMessage(db, wsA, "m");
    await recordTaskChange(db, a.task.id, { entryId: "R-1", kind: "requirement", title: "x", op: "add" });
    await recordTaskChange(db, a.task.id, { entryId: "R-1", kind: "requirement", title: "x2", op: "update" });
    await recordTaskChange(db, a.task.id, { entryId: "R-2", kind: "requirement", title: "y", op: "update" });
    const ch = await listTaskChanges(db, a.task.id);
    expect(ch).toHaveLength(2);
    expect(ch.find((c) => c.entryId === "R-1")).toMatchObject({ op: "add", title: "x2" });
    expect(ch.find((c) => c.entryId === "R-2")?.op).toBe("update");
  });

  test("empty message rejected; content kept verbatim", async () => {
    await expect(postUserMessage(db, wsA, "   ")).rejects.toThrow();
    const raw = "  a\n\n**b**  ";
    const { message } = await postUserMessage(db, wsA, raw);
    expect(message.content).toBe(raw);
    const list = await listMessages(db, wsA);
    expect(list[0]!.content).toBe(raw);
  });

  test("listMessages oldest first, agent messages carry meta", async () => {
    const { message, task } = await postUserMessage(db, wsA, "q");
    await addMessage(db, wsA, "agent", "done", { taskId: task.id, meta: { changes: [] } as never });
    const list = await listMessages(db, wsA);
    expect(list.map((m) => m.role)).toEqual(["user", "agent"]);
    expect(list[0]!.id).toBe(message.id);
    expect(list[1]!.taskId).toBe(task.id);
  });

  test("finishTask only affects running tasks and honours the run token", async () => {
    await postUserMessage(db, wsA, "m");
    const t = await claimNextTask(db, "d1");
    await requeueDaemonTasks(db, "d1");
    expect(await finishTask(db, t!.id, { ok: true }, t!.runToken!)).toBe(false);
    expect((await getTask(db, t!.id))?.status).toBe("queued");
    const again = await claimNextTask(db, "d2");
    expect(await finishTask(db, t!.id, { ok: true }, t!.runToken!)).toBe(false);
    const cur = await getTask(db, t!.id);
    expect(cur).toMatchObject({ status: "running", runToken: again!.runToken });
    expect(await finishTask(db, t!.id, { ok: true }, again!.runToken!)).toBe(true);
    expect((await getTask(db, t!.id))?.status).toBe("done");
    expect(await finishTask(db, t!.id, { ok: true })).toBe(false);
  });

  // NOTE: PGlite serializes these calls, so FOR UPDATE SKIP LOCKED itself is only exercised on real Postgres.
  test("concurrent claims: one workspace yields exactly one claim", async () => {
    await postUserMessage(db, wsA, "1");
    await postUserMessage(db, wsA, "2");
    const r = await Promise.all([claimNextTask(db, "d1"), claimNextTask(db, "d2")]);
    expect(r.filter((x) => x !== null)).toHaveLength(1);
  });

  test("concurrent claims: two workspaces yield two claims", async () => {
    await postUserMessage(db, wsA, "1");
    await postUserMessage(db, wsB, "2");
    const r = await Promise.all([claimNextTask(db, "d1"), claimNextTask(db, "d2")]);
    expect(r.filter((x) => x !== null)).toHaveLength(2);
    expect(new Set(r.map((x) => x!.id)).size).toBe(2);
  });
});
