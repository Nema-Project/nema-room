import type { Db } from "./db/db.js";
import { getMessage } from "./messages.js";
import { getTask } from "./tasks.js";
import { conversationOf } from "./threads.js";

// Which Skills a thread activated (spec §8, D-6). The hub keeps ids, versions and times only; the
// daemon reads the Skill itself again for the next task, so a Skill switched off since is left out there.

/** An external Skill id: a name, optionally after one `<repo slug>:` prefix. */
export const ACTIVATED_SKILL_ID = /^[a-z0-9-]+(?::[a-z0-9-]+)?$/;
export const MAX_ACTIVATED_SKILL_ID = 130;
const MAX_REVISION = 100;

export type ActivationInput = { skillId: string; revision: string };

/** The request body, or a reason it is not one. */
export function parseActivation(raw: unknown): ActivationInput | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "request body must be an object";
  const { skillId, revision } = raw as Record<string, unknown>;
  if (typeof skillId !== "string" || skillId.length < 1 || skillId.length > MAX_ACTIVATED_SKILL_ID || !ACTIVATED_SKILL_ID.test(skillId)) {
    return "skillId must be 1 to 130 characters of [a-z0-9:-]";
  }
  if (typeof revision !== "string" || revision.length < 1 || revision.length > MAX_REVISION || /[\u0000-\u001f\u007f]/.test(revision)) {
    return "revision must be 1 to 100 printable characters";
  }
  return { skillId, revision };
}

/**
 * Records that the task loaded the Skill. Only a task whose message is in a thread (or anchors one)
 * counts; a main-chat task records nothing.
 */
export async function recordActivation(db: Db, o: { taskId: string; skillId: string; revision: string }): Promise<"recorded" | "not-thread"> {
  const task = await getTask(db, o.taskId);
  if (!task) return "not-thread";
  const message = await getMessage(db, task.messageId);
  const threadId = message ? await conversationOf(db, message) : null;
  if (!threadId) return "not-thread";
  await db.query(
    `insert into thread_skill_activations(thread_id, skill_id, last_activated_at, last_task_id, revision)
     values ($1, $2, clock_timestamp(), $3, $4)
     on conflict (thread_id, skill_id) do update
       set last_activated_at = excluded.last_activated_at, last_task_id = excluded.last_task_id, revision = excluded.revision`,
    [threadId, o.skillId, o.taskId, o.revision],
  );
  return "recorded";
}

/** The thread's activated Skills, most recent first. */
export async function retainedSkills(db: Db, threadId: string): Promise<string[]> {
  const rows = await db.query<{ skill_id: string }>(
    "select skill_id from thread_skill_activations where thread_id=$1 order by last_activated_at desc, skill_id",
    [threadId],
  );
  return rows.map((row) => row.skill_id);
}
