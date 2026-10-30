import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { Hono } from "hono";
import { bundledExtensions } from "@nema/shared";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { createWorkspace, deleteWorkspace } from "../src/workspaces.js";
import { postUserMessage } from "../src/messages.js";
import { claimNextTask, finishTask } from "../src/tasks.js";
import { ensureThread } from "../src/threads.js";
import { EventBus } from "../src/events.js";
import { roomRoutes } from "../src/roomApi.js";
import type { DaemonRpc } from "../src/daemonRpc.js";
import { parseActivation, recordActivation, retainedSkills } from "../src/skillActivations.js";

let db: Db;
let dataDir: string;
let ws: string;
let app: Hono<any>;
const daemon: DaemonRpc = { async call(method) { if (method === "extensions.list") return bundledExtensions(); throw new Error(method); } };

beforeEach(async () => {
  const deps = await makeHubDeps();
  db = deps.db;
  dataDir = deps.dataDir;
  ws = (await createWorkspace(db, dataDir, "A")).id;
  app = new Hono().route("/room", roomRoutes({ db, dataDir, events: new EventBus(), daemon }));
});
afterAll(cleanupHubDeps);

async function threadTask() {
  const anchor = (await postUserMessage(db, ws, "anchor")).message;
  const first = await claimNextTask(db, "d1");
  await finishTask(db, first!.id, { ok: true });
  const thread = await ensureThread(db, anchor.id, "Topic", "user");
  await postUserMessage(db, ws, "in the thread", { threadId: thread.id });
  const task = await claimNextTask(db, "d1");
  return { threadId: thread.id, anchorTaskId: first!.id, taskId: task!.id, token: task!.runToken! };
}

const report = (token: string, body: unknown) =>
  app.request("/room/skills/activated", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("thread Skill activations", () => {
  test("a thread task is recorded; again only moves its time, task and revision", async () => {
    const { threadId, taskId } = await threadTask();
    expect(await recordActivation(db, { taskId, skillId: "tdd", revision: "r1" })).toBe("recorded");
    expect(await recordActivation(db, { taskId, skillId: "web-abc123:deploy", revision: "r1" })).toBe("recorded");
    expect(await retainedSkills(db, threadId)).toEqual(["web-abc123:deploy", "tdd"]);
    expect(await recordActivation(db, { taskId, skillId: "tdd", revision: "r2" })).toBe("recorded");
    expect(await retainedSkills(db, threadId)).toEqual(["tdd", "web-abc123:deploy"]);
    const rows = await db.query<{ revision: string; last_task_id: string }>("select revision, last_task_id from thread_skill_activations where skill_id='tdd'");
    expect(rows).toEqual([{ revision: "r2", last_task_id: taskId }]);
  });

  test("the anchor's task counts once the thread exists; a plain main-chat task does not", async () => {
    const { threadId, anchorTaskId, taskId } = await threadTask();
    await finishTask(db, taskId, { ok: true });
    expect(await recordActivation(db, { taskId: anchorTaskId, skillId: "tdd", revision: "r" })).toBe("recorded");
    expect(await retainedSkills(db, threadId)).toEqual(["tdd"]);
    await postUserMessage(db, ws, "main chat");
    const main = await claimNextTask(db, "d1");
    expect(await recordActivation(db, { taskId: main!.id, skillId: "pdf", revision: "r" })).toBe("not-thread");
    expect(await db.query("select 1 from thread_skill_activations where skill_id='pdf'")).toEqual([]);
  });

  test("deleting the workspace removes its threads' records", async () => {
    const { taskId } = await threadTask();
    await recordActivation(db, { taskId, skillId: "tdd", revision: "r" });
    await finishTask(db, taskId, { ok: true });
    await deleteWorkspace(db, dataDir, ws);
    expect(await db.query("select 1 from thread_skill_activations")).toEqual([]);
  });

  test("POST /room/skills/activated: 204, 400 for a bad id, 401 without the run token", async () => {
    const { threadId, token } = await threadTask();
    expect((await report(token, { skillId: "tdd", revision: "abc1234" })).status).toBe(204);
    expect(await retainedSkills(db, threadId)).toEqual(["tdd"]);
    expect((await report(token, { skillId: "../etc", revision: "r" })).status).toBe(400);
    expect((await report(token, { skillId: "a".repeat(131), revision: "r" })).status).toBe(400);
    expect((await report(token, { skillId: "tdd" })).status).toBe(400);
    expect((await report("wrong", { skillId: "tdd", revision: "r" })).status).toBe(401);
  });

  test("parseActivation", () => {
    expect(parseActivation({ skillId: "a:b", revision: "local@abc1234" })).toEqual({ skillId: "a:b", revision: "local@abc1234" });
    expect(typeof parseActivation({ skillId: "A", revision: "r" })).toBe("string");
    expect(typeof parseActivation({ skillId: "a", revision: "r\n" })).toBe("string");
    expect(typeof parseActivation([])).toBe("string");
  });
});
