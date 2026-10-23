import { z } from "zod";

/**
 * What a coding agent's hook sends after a turn or session ends. Only these seven fields are ever
 * kept; anything else in the agent's hook payload is stripped and never stored or forwarded.
 */
export const HookSignal = z.object({
  agent: z.string().min(1).max(40),
  cwd: z.string(),
  gitCommonDir: z.string(),
  branch: z.string().nullable(),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  at: z.iso.datetime({ offset: true }),
  sessionId: z.string().max(200).nullable(),
});
export type HookSignal = z.infer<typeof HookSignal>;

/** What `nema report` sends: the coding agent's own account of finished work. */
export const ReportInput = z.object({
  agent: z.string().min(1).max(40),
  gitCommonDir: z.string(),
  summary: z.string().min(1).max(2000),
  entries: z.array(z.string().regex(/^[RDTQSGW]-[1-9]\d*$/)).max(50).default([]),
  commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).min(1).max(50),
  files: z.array(z.string().min(1).max(500)).max(500).default([]),
  task: z.number().int().min(1).max(15).optional(),
});
export type ReportInput = z.infer<typeof ReportInput>;

/** The daemon's git check of a report against the repo's main branch. */
export type ReportCheck = {
  commitsExist: boolean;
  missingCommits: string[];
  /** "yes": every reported commit is an ancestor of main, or main has a commit with the same patch-id. */
  onMain: "yes" | "not-yet";
  /** False only when a claimed file was not touched by the reported commits. */
  filesOk: boolean;
  untouchedFiles: string[];
  /** Every file the reported commits touched (merge commits ignored). */
  touchedFiles: string[];
  checkedAt: string;
  mainSha: string;
};

export function reportPassed(check: ReportCheck): boolean {
  return check.commitsExist && check.onMain === "yes" && check.filesOk;
}

/** `messages.meta` of a `report` message. `checkError` is set when the daemon could not run the check. */
export type ReportMessageMeta = { report: ReportInput; check: ReportCheck | null; checkError?: string };

export const IMPLEMENTATION_STATUSES = ["reported", "verified", "mismatch"] as const;
export type ImplementationStatusValue = (typeof IMPLEMENTATION_STATUSES)[number];

/** A requirement's implementation state and the evidence behind it. */
export const Implementation = z.object({
  status: z.enum(IMPLEMENTATION_STATUSES),
  evidence: z.object({
    reportMessageId: z.string().nullable(),
    commits: z.array(z.string()),
    /** True when the work was inferred from code on main with no report. */
    inferred: z.boolean(),
    note: z.string().nullable(),
    confirmedBy: z.literal("user").nullable(),
  }),
});
export type Implementation = z.infer<typeof Implementation>;
