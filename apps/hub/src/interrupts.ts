import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { addMessage } from "./messages.js";
import { getTask, INTERRUPTED_ERROR, toUiTask } from "./tasks.js";

/** Posts the final failure message and emits task.updated for every interrupted id. */
export async function announceInterrupted(
  db: Db,
  events: EventBus,
  result: { requeued: string[]; failed: string[] },
): Promise<void> {
  for (const id of result.failed) {
    const task = await getTask(db, id);
    if (!task) continue;
    const message = await addMessage(db, task.workspaceId, "system", "处理失败：" + INTERRUPTED_ERROR, { taskId: id });
    events.emit(task.workspaceId, { type: "message.created", message });
  }
  for (const id of [...result.requeued, ...result.failed]) {
    const task = await getTask(db, id);
    if (task) events.emit(task.workspaceId, { type: "task.updated", task: toUiTask(task) });
  }
}
