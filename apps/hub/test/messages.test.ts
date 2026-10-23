import { afterEach, expect, test } from "vitest";
import { listMessages, postSystemTask } from "../src/messages.js";
import { listQueuedTasks } from "../src/tasks.js";
import { createWorkspace, updateWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterEach(cleanupHubDeps);

test("postSystemTask creates a system message and a queued task", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  const { message, task } = await postSystemTask(db, ws.id, "为仓库画架构图");
  expect(message).toMatchObject({ workspaceId: ws.id, role: "system", content: "为仓库画架构图", taskId: null });
  expect(task).toMatchObject({ workspaceId: ws.id, messageId: message.id, status: "queued" });
  expect((await listMessages(db, ws.id)).map((m) => m.id)).toEqual([message.id]);
  expect((await listQueuedTasks(db, ws.id)).map((t) => t.id)).toEqual([task.id]);
});

test("postSystemTask refuses an archived workspace like a user message", async () => {
  const { db, dataDir } = await makeHubDeps();
  const ws = await createWorkspace(db, dataDir, "Alpha");
  await updateWorkspace(db, ws.id, { archived: true });
  await expect(postSystemTask(db, ws.id, "x")).rejects.toThrow("workspace is archived; unarchive it to send messages");
  expect(await listMessages(db, ws.id)).toEqual([]);
  expect(await listQueuedTasks(db, ws.id)).toEqual([]);
});
