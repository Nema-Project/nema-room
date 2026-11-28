/*
 * Error and progress codes (#299 batch 1). A daemon or hub error keeps its `message` as the fallback text and
 * may add a `code` plus flat `params`; the web looks the code up in its message catalog (`error.<code>`,
 * `progress.<code>`) and shows the fallback when it has no entry. Every field is optional on the wire, so an
 * older daemon or hub that sends only text keeps working and is shown as before (decision D6: no protocol
 * version bump).
 */
import { z } from "zod";

/** Values a code's message may interpolate. Flat on purpose: anything richer belongs in its own field. */
export type CodeParams = Record<string, string | number>;

/** Lowercase dotted segments, e.g. `repo.not-git-root`. The web appends it to a catalog prefix, so no other characters. */
const CODE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/;
const MAX_CODE_LENGTH = 80;
const MAX_PARAMS = 16;
const MAX_PARAM_LENGTH = 4096;

export function isErrorCode(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_CODE_LENGTH && CODE.test(value);
}

/**
 * The params worth keeping from an untrusted value: string and finite number entries under plain keys.
 * Anything else is dropped rather than failing the error that carries it.
 */
export function readCodeParams(value: unknown): CodeParams | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: CodeParams = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_PARAMS) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof item === "string") out[key] = item.slice(0, MAX_PARAM_LENGTH);
    else if (typeof item === "number" && Number.isFinite(item)) out[key] = item;
    else continue;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/** `{ code, params }` from untrusted fields, or `{}` when the code is missing or malformed (then params mean nothing). */
export function readCoded(code: unknown, params: unknown): { code?: string; params?: CodeParams } {
  if (!isErrorCode(code)) return {};
  const parsed = readCodeParams(params);
  return parsed ? { code, params: parsed } : { code };
}

/** An error whose message is the fallback text and whose code the UI can localise. */
export class CodedError extends Error {
  constructor(readonly code: string, message: string, readonly params?: CodeParams) {
    super(message);
    this.name = "CodedError";
  }
}

/** The code and params of a `CodedError`, or `{}` for any other value (a Node `code` such as ENOENT is not ours). */
export function codedFields(error: unknown): { code?: string; params?: CodeParams } {
  if (!(error instanceof CodedError)) return {};
  return readCoded(error.code, error.params);
}

/** The JSON body of a hub error response. `error` is always present; `code` and `params` are optional. */
export type ErrorBody = { error: string; code?: string; params?: CodeParams };

/**
 * One line of text that may be localised: the fallback `text`, plus an optional code and params. Lists in a
 * progress line (Skill warnings, skipped Skills) are made of these so each item can be shown in the UI language.
 */
export const CodedTextSchema = z.object({
  text: z.string(),
  code: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type CodedText = z.infer<typeof CodedTextSchema>;

/** Keeps the well-formed items of an untrusted list; a malformed item becomes its text alone, or is dropped. The bound stays generous enough for any realistic list (a Skill catalog with hundreds of failed loads) while still capping untrusted input. */
export function readCodedTexts(value: unknown): CodedText[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CodedText[] = [];
  for (const item of value.slice(0, 512)) {
    if (!item || typeof item !== "object" || typeof (item as { text?: unknown }).text !== "string") continue;
    const row = item as { text: string; code?: unknown; params?: unknown };
    out.push({ text: row.text, ...readCoded(row.code, row.params) });
  }
  return out;
}

/*
 * Codes the hub produces itself. Daemon codes are declared below; both end up in the web catalog under
 * `error.<code>`.
 */
export const HUB_ERROR = {
  daemonNotConnected: "daemon.not-connected",
  daemonDisconnected: "daemon.disconnected",
  daemonTimedOut: "daemon.timed-out",
  /** A task has attachments the connected (older) daemon cannot receive. */
  daemonNoAttachments: "daemon.no-attachments",
  /** A task names an account the connected (older) daemon cannot honour. */
  daemonNoAccounts: "daemon.no-accounts",
  workspaceNotFound: "workspace.not-found",
  workspaceArchivedRepoBind: "workspace.archived-repo-bind",
  repoNotFound: "repo.not-found",
  repoLabelTaken: "repo.label-taken",
  repoLabelInvalid: "repo.label-invalid",
  repoBranchInvalid: "repo.branch-invalid",
  repoBoundElsewhere: "repo.bound-elsewhere",
  pluginNotFound: "plugin.not-found",
  pluginUnknownFunction: "plugin.unknown-function",
  pluginGithubSettingsInvalid: "plugin.github-settings-invalid",
  pluginNoSettings: "plugin.no-settings",
  pluginGrillRulesTooLong: "plugin.grill-rules-too-long",
  pluginGrillSettingsInvalid: "plugin.grill-settings-invalid",
  attachmentsDeliveryLimit: "attachments.delivery-limit",
  workpackageNotFound: "workpackage.not-found",
  workpackageTaskNumberInvalid: "workpackage.task-number-invalid",
  implementationNotConfirmable: "implementation.not-confirmable",
} as const;

/** Codes the daemon produces in RPC errors. */
export const DAEMON_ERROR = {
  rpcUnknownMethod: "rpc.unknown-method",
  repoUnderNemaHome: "repo.under-nema-home",
  repoContainsNemaHome: "repo.contains-nema-home",
  repoNotGitRoot: "repo.not-git-root",
  pickerUnavailable: "dialog.picker-unavailable",
  mirrorUrlInvalid: "components.mirror-url-invalid",
  // Rendered with #297's `components.reason.offerChanged`, not an `error.` key of its own (see web errorText).
  componentOfferChanged: "components.offer-changed",
} as const;

/** Codes of progress and tool-call lines a running task shows (`progress.<code>` in the web catalog). */
export const PROGRESS = {
  routeSwitch: "route.switch",
  toolCall: "tool.call",
  skillsPrepareFailed: "skills.prepare-failed",
  skillsReadFailed: "skills.read-failed",
  skillsNotLoaded: "skills.not-loaded",
  skillsNotPreloaded: "skills.not-preloaded",
  skillsClaudeTooOld: "skills.claude-too-old",
  skillsClaudeOld: "skills.claude-old",
  skillsNotListed: "skills.not-listed",
  skillsCallUnrecognized: "skills.call-unrecognized",
  skillsToolClash: "skills.tool-clash",
  skillsActivationTimedOut: "skills.activation-timed-out",
  skillsActivationFailed: "skills.activation-failed",
  skillsRead: "skills.read",
} as const;

/** Codes of the items inside `skills.not-loaded` (`progress.<code>` in the web catalog). */
export const SKILL_WARNING = {
  skippedBudget: "skill.skipped-budget",
  skippedChanged: "skill.skipped-changed",
  skippedUnreadable: "skill.skipped-unreadable",
  repoOverridden: "skill.repo-overridden",
  repoBadName: "skill.repo-bad-name",
  // A Skill directory the daemon would not copy, one code per reason.
  refusedTooManyFiles: "skill.refused-too-many-files",
  refusedSymlink: "skill.refused-symlink",
  refusedSubmodule: "skill.refused-submodule",
  refusedUnreadable: "skill.refused-unreadable",
  refusedFileTooLarge: "skill.refused-file-too-large",
  refusedTotalTooLarge: "skill.refused-total-too-large",
  repoMoved: "skill.repo-moved",
  repoFetchFailed: "skill.repo-fetch-failed",
  repoNoMainBranch: "skill.repo-no-main-branch",
  repoNoSkillMd: "skill.repo-no-skill-md",
  repoBadSkillMd: "skill.repo-bad-skill-md",
  repoReadFailed: "skill.repo-read-failed",
} as const;
