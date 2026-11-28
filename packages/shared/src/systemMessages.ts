import { readCodeParams, type CodeParams } from "./errorCode.js";
import type { RouteDecision } from "./route.js";

/**
 * Phrase in the instruction the hub sends the model to draw a newly bound repo's architecture diagram. The
 * instruction is for the model and keeps its wording. The web labels its progress bar from the message's
 * `meta.notice` code (`NOTICE.systemTaskDiagram`), not from this phrase (#299 batch 2).
 */
export const ARCHITECTURE_DIAGRAM_MARKER = "画架构图";

/*
 * Structured notices on stored system messages (#299 batch 2, decision D1). A system message keeps `content`
 * as its fallback text (English for new messages, D2) and adds `meta.notice = { code, params }`. The web
 * renders `notice.<code>` from its catalog in the page's language, and shows `content` when the message has
 * no notice, the notice is unreadable, or the catalog has no entry for the code. Messages stored before this
 * field existed carry no notice and are neither backfilled nor migrated (D3).
 */

/** Codes of the notices the hub writes. The web catalog has `notice.<code>` for each. */
export const NOTICE = {
  repoIndexReady: "repo.index.ready",
  repoIndexFailed: "repo.index.failed",
  taskInterrupted: "task.interrupted",
  /** `params.reason` is an error code when the failure has one (`error.<reason>` in the web catalog). */
  taskFailed: "task.failed",
  questionFollowUp: "question.followUp",
  /** System-started tasks: `content` stays the model's instruction, the notice is what the chat shows. */
  systemTaskDiagram: "system.task.diagram",
  systemTaskDiagramUpdate: "system.task.diagramUpdate",
  systemTaskCommitsChecked: "system.task.commitsChecked",
  systemTaskUncoveredCommits: "system.task.uncoveredCommits",
} as const;

export type SystemNotice = { code: string; params?: CodeParams };
export type SystemNoticeMeta = { notice: SystemNotice };
/** A failed task's system message: the notice, plus the account and model that were running when known. */
export type TaskFailureMeta = SystemNoticeMeta & { route?: RouteDecision };

/** Fallback prefix of a failed task's `content` (D2). Messages stored before #299 batch 2 start with `LEGACY_TASK_FAILED_PREFIX`. */
export const TASK_FAILED_PREFIX = "Processing failed: ";
export const LEGACY_TASK_FAILED_PREFIX = "处理失败：";

/** Dotted segments; a segment may be camelCase (`question.followUp`). Appended to `notice.`, so no other characters. */
const NOTICE_CODE = /^[a-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)*$/;

/**
 * The notice in a stored message's meta, or undefined when there is none or it is malformed. Stored meta was
 * written by some hub version and is data, not a contract, so an unreadable notice counts as no notice and
 * the caller shows `content`.
 */
export function readSystemNotice(meta: unknown): SystemNotice | undefined {
  if (!meta || typeof meta !== "object" || !("notice" in meta)) return undefined;
  const notice = (meta as { notice?: unknown }).notice;
  if (!notice || typeof notice !== "object" || Array.isArray(notice)) return undefined;
  const { code, params } = notice as { code?: unknown; params?: unknown };
  if (typeof code !== "string" || code.length > 80 || !NOTICE_CODE.test(code)) return undefined;
  const parsed = readCodeParams(params);
  return parsed ? { code, params: parsed } : { code };
}
