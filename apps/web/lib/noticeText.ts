import { isErrorCode, LEGACY_TASK_FAILED_PREFIX, NOTICE, TASK_FAILED_PREFIX, type CodeParams, type SystemNotice } from "@nema/shared";
import { ERROR_KEY, lookup } from "./errorText";
import type { useT } from "./i18n";

type T = ReturnType<typeof useT>;

/** Notices shown with the failure styling and label. */
const FAILURE_NOTICES: ReadonlySet<string> = new Set([NOTICE.taskFailed, NOTICE.taskInterrupted, NOTICE.repoIndexFailed]);

export function isFailureNotice(notice: SystemNotice): boolean {
  return FAILURE_NOTICES.has(notice.code);
}

/**
 * Task failures whose text can carry a recovery command (`nema auth login`, …) to split out and copy. An index
 * failure is styled as a failure too, but its text names a user-chosen repository label, never a command.
 */
const COMMAND_NOTICES: ReadonlySet<string> = new Set([NOTICE.taskFailed, NOTICE.taskInterrupted]);

export function hasRecoveryCommands(notice: SystemNotice): boolean {
  return COMMAND_NOTICES.has(notice.code);
}

/**
 * `lookup` that also refuses an entry whose placeholders the params do not all fill. Stored params are data:
 * a missing or non-scalar value (dropped by `readCodeParams`) would otherwise leave a raw `{label}` on the page.
 * The template is checked before substitution, so a filled value that itself contains braces is not mistaken
 * for a placeholder.
 */
function lookupFilled(t: T, key: string, params?: CodeParams): string | null {
  const template = lookup(t, key);
  if (template === null) return null;
  for (const [, name] of template.matchAll(/\{(\w+)\}/g)) {
    if (!params || !(name in params)) return null;
  }
  return lookup(t, key, params);
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
 * catalog has no `notice.<code>` entry or the params do not fill it: never an empty line, a raw key, or a raw
 * `{placeholder}`.
 *
 * `task.failed` names its reason from `error.<reason>` when the failure carried a code the catalog knows and
 * params that fill it. A known reason whose params do not fill it shows the whole stored `content`: the hub
 * wrote that text from the same code, so it is not a raw daemon error to re-wrap in the localised sentence.
 * A failure without a code the catalog knows (every daemon failure until the daemon sends codes) shows the
 * error text as the hub stored it, inside the localised sentence.
 */
export function noticeText(notice: SystemNotice, content: string, t: T): string {
  if (notice.code === NOTICE.taskFailed) {
    const { reason, ...reasonParams } = notice.params ?? {};
    const reasonKey = isErrorCode(reason) ? ERROR_KEY[reason] ?? `error.${reason}` : null;
    if (reasonKey !== null && lookup(t, reasonKey) !== null) {
      const known = lookupFilled(t, reasonKey, reasonParams as CodeParams);
      if (known === null) return content;
      return lookupFilled(t, `notice.${notice.code}`, { reason: known }) ?? content;
    }
    return lookupFilled(t, `notice.${notice.code}`, { reason: failureDetail(content) }) ?? content;
  }
  return lookupFilled(t, `notice.${notice.code}`, notice.params) ?? content;
}
