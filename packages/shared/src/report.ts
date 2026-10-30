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

export const REPORT_PROGRESS = ["completed", "in_progress"] as const;
export type ReportProgress = (typeof REPORT_PROGRESS)[number];

const claimText = (max: number) => z.string().min(1).max(max);

/**
 * What `nema report` sends: the coding agent's own account of its work. Everything here is a claim;
 * the hub keeps it as sent and records its own observations next to it in `ReportMessageMeta`.
 * `progress` defaults to "completed", which needs at least one commit; an "in_progress" report may
 * have none.
 */
export const ReportInput = z
  .object({
    agent: z.string().min(1).max(40),
    gitCommonDir: z.string(),
    summary: z.string().min(1).max(2000),
    progress: z.enum(REPORT_PROGRESS).default("completed"),
    entries: z.array(z.string().regex(/^[RDTQSGW]-[1-9]\d*$/)).max(50).default([]),
    commits: z.array(z.string().regex(/^[0-9a-f]{7,40}$/)).max(50).default([]),
    files: z.array(z.string().min(1).max(500)).max(500).default([]),
    task: z.number().int().min(1).max(15).optional(),
    branch: z.string().min(1).max(200).regex(/^[^\r\n]*$/).optional(),
    pr: z.number().int().positive().optional(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
    ci: z
      .array(z.object({ name: claimText(200), conclusion: claimText(40).optional(), url: claimText(500).optional() }))
      .max(30)
      .optional(),
    verified: z.array(claimText(200)).max(30).optional(),
    notVerified: z.array(claimText(200)).max(30).optional(),
    blockers: z.array(claimText(500)).max(20).optional(),
  })
  .superRefine((report, ctx) => {
    if (report.progress === "completed" && report.commits.length === 0) {
      ctx.addIssue({ code: "custom", path: ["commits"], message: "a completed report needs at least one commit" });
    }
  });
export type ReportInput = z.infer<typeof ReportInput>;

/** A report as stored on its message. Messages stored before `progress` existed lack it; read them as "completed". */
export type StoredReport = Omit<ReportInput, "progress"> & { progress?: ReportProgress };

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

/** One replaced git check of a report, kept so the message shows when its check changed. */
export type ReportCheckSnapshot = Pick<ReportCheck, "onMain" | "commitsExist" | "filesOk" | "checkedAt" | "mainSha">;

/** Commit metadata the hub read from local git. Evidence only: it never allows or denies anything. */
export type ReportAuthors = {
  checkedAt: string;
  source: "git";
  commits: { sha: string; authorName: string; authorEmail: string; committerName: string; committerEmail: string }[];
  missing: string[];
};

export const GITHUB_OBSERVATION_REASONS = [
  "plugin_disabled",
  "gh_logged_out",
  "gh_unavailable",
  "remote_missing",
  "remote_not_unique",
  "out_of_scope",
  "timeout",
  "http_error",
  "invalid_response",
] as const;
export type GithubObservationReason = (typeof GITHUB_OBSERVATION_REASONS)[number];

export type GithubCheckRun = { name: string; status: string; conclusion: string | null; url: string | null };

/** One read of a claimed pull request, bound to the head the hub saw. Never a test-pass verdict. */
export type GithubObservation = {
  state: "not_requested" | "unavailable" | "read";
  reasonCode?: GithubObservationReason;
  reason?: string;
  observedAt: string;
  source: "github-plugin-read";
  binding: {
    repoId: string;
    owner: string;
    repo: string;
    pr: number;
    observedHeadSha: string | null;
    claimedHeadSha: string | null;
  } | null;
  headMatch: "match" | "mismatch" | "not_comparable" | null;
  checkRuns: GithubCheckRun[];
  truncated: boolean;
};

/**
 * `messages.meta` of a `report` message. `report` is the agent's claim and is never rewritten. The
 * other keys are the hub's own observations, each replaced on its own. `checkError` is set when the
 * daemon could not run the check; `checkSkipped` when an in-progress report had no commits to check.
 * Messages stored before these keys existed simply lack them.
 */
export type ReportMessageMeta = {
  report: StoredReport;
  check: ReportCheck | null;
  checkError?: string;
  checkSkipped?: "in_progress_no_commits" | null;
  checkHistory?: ReportCheckSnapshot[];
  authors?: ReportAuthors;
  github?: { current: GithubObservation; history: GithubObservation[] };
};

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
    /** Set when a cited report's check changed after the user accepted; only the user clears it. */
    acceptanceReview: z
      .object({ needed: z.literal(true), at: z.string(), reason: z.literal("linked_check_changed") })
      .nullable()
      .default(null),
    /** One group per contributing report when several reports roll up into one requirement. */
    reportEvidence: z
      .array(z.object({ reportMessageId: z.string(), commits: z.array(z.string()) }))
      .nullable()
      .default(null)
      .transform((groups) => (groups && groups.length > 0 ? groups : null)),
  }),
});
export type Implementation = z.infer<typeof Implementation>;

/**
 * Whether the user can confirm this implementation: `reported`, `mismatch`, commits checked but not yet
 * accepted (`verified` with no `confirmedBy`), or accepted with a review still needed ("still accept").
 */
export function confirmableImplementation(impl: Implementation): boolean {
  if (impl.status === "reported" || impl.status === "mismatch") return true;
  if (impl.evidence.confirmedBy === null) return true;
  return impl.evidence.acceptanceReview?.needed === true;
}
