import { NOTICE, TASK_FAILED_PREFIX } from "@nema/shared";
import type { Db } from "./db/db.js";
import type { EventBus } from "./events.js";
import { addMessage, getMessage } from "./messages.js";
import { getTask, MAX_INTERRUPT_RETRIES, resolveUiTask } from "./tasks.js";
import { conversationOf, getThread } from "./threads.js";

/**
 * Fallback text of the `task.interrupted` notice (#299 batch 2, D2: English). `tasks.error` keeps
 * `INTERRUPTED_ERROR`; this is only the chat message.
 */
export function interruptedText(): string {
  return `${TASK_FAILED_PREFIX}The task was interrupted and did not finish after ${MAX_INTERRUPT_RETRIES} automatic retries. Send the message again.`;
}

/** Posts the final failure message and emits task.updated for every interrupted id. */
export async function announceInterrupted(
  db: Db,
  events: EventBus,
  result: { requeued: string[]; failed: string[] },
): Promise<void> {
  for (const id of result.failed) {
    const task = await getTask(db, id);
    if (!task) continue;
    const taskMessage = await getMessage(db, task.messageId);
    const threadId = taskMessage ? await conversationOf(db, taskMessage) : null;
    const message = await addMessage(db, task.workspaceId, "system", interruptedText(), {
      taskId: id,
      threadId,
      meta: { notice: { code: NOTICE.taskInterrupted, params: { retries: MAX_INTERRUPT_RETRIES } } },
    });
    events.emit(task.workspaceId, { type: "message.created", message });
    if (threadId) {
      const thread = await getThread(db, threadId);
      if (thread) events.emit(task.workspaceId, { type: "thread.updated", thread });
    }
  }
  for (const id of [...result.requeued, ...result.failed]) {
    const task = await getTask(db, id);
    if (task) events.emit(task.workspaceId, { type: "task.updated", task: await resolveUiTask(db, task) });
  }
}
