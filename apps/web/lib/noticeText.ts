import { isErrorCode, LEGACY_TASK_FAILED_PREFIX, NOTICE, TASK_FAILED_PREFIX, type CodeParams, type SystemNotice } from "@nema/shared";
import { ERROR_KEY, lookup } from "./errorText";
import type { useT } from "./i18n";

type T = ReturnType<typeof useT>;

/** Notices shown with the failure styling and label. */
const FAILURE_NOTICES: ReadonlySet<string> = new Set([NOTICE.taskFailed, NOTICE.taskInterrupted, NOTICE.repoIndexFailed]);

export function isFailureNotice(notice: SystemNotice): boolean {
  return FAILURE_NOTICES.has(notice.code);
}

/** A system-started task's notice: the chat labels it as an instruction. */
export function isInstructionNotice(notice: SystemNotice): boolean {
  return notice.code.startsWith("system.task.");
}

/** The error as the hub stored it in `content`, without the fallback's own "failed" prefix. */
function failureDetail(content: string): string {
  if (content.startsWith(TASK_FAILED_PREFIX)) return content.slice(TASK_FAILED_PREFIX.length);
  if (content.startsWith(LEGACY_TASK_FAILED_PREFIX)) return content.slice(LEGACY_TASK_FAILED_PREFIX.length);
  return content;
}

/**
 * A stored system message's notice in the page's language (#299 batch 2), or the message's `content` when the
 * catalog has no `notice.<code>` entry: never an empty line and never a raw key.
 *
 * `task.failed` names its reason from `error.<reason>` when the failure carried a code the catalog knows.
 * A failure without one (every daemon failure until the daemon sends codes) shows the error text as the hub
 * stored it, inside the localised sentence.
 */
export function noticeText(notice: SystemNotice, content: string, t: T): string {
  if (notice.code === NOTICE.taskFailed) {
    const { reason, ...reasonParams } = notice.params ?? {};
    const known = isErrorCode(reason) ? lookup(t, ERROR_KEY[reason] ?? `error.${reason}`, reasonParams as CodeParams) : null;
    return lookup(t, `notice.${notice.code}`, { reason: known ?? failureDetail(content) }) ?? content;
  }
  return lookup(t, `notice.${notice.code}`, notice.params) ?? content;
}
