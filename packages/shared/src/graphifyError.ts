import { z } from "zod";

export const ComponentFailureReasonSchema = z.enum([
  "network", "proxy", "hash-mismatch", "self-check", "unsupported-platform",
  "offline", "disk-space", "lock-unreadable", "offer-changed",
]);
export type ComponentFailureReason = z.infer<typeof ComponentFailureReasonSchema>;

/** The component facts needed to explain an unavailable graph in the UI. */
export const GraphifyUnavailableStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-installed") }),
  z.object({ state: z.literal("lock-mismatch"), installedLockHash: z.string() }),
  z.object({
    state: z.literal("installing"),
    progress: z.object({ downloadedBytes: z.number(), totalBytes: z.number() }),
  }),
  z.object({
    state: z.literal("failed"),
    reason: ComponentFailureReasonSchema,
    detail: z.string(),
    installedLockHash: z.string().optional(),
  }),
]);
export type GraphifyUnavailableStatus = z.infer<typeof GraphifyUnavailableStatusSchema>;

export const GraphifyErrorSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("graphify-unavailable"),
    state: z.enum(["not-installed", "lock-mismatch", "installing", "failed"]),
    status: GraphifyUnavailableStatusSchema,
  }).refine(({ state, status }) => state === status.state),
  z.object({ code: z.literal("graphify-interrupted") }),
]);
export type GraphifyError = z.infer<typeof GraphifyErrorSchema>;

export type RepoIndexFailureMeta = { repoIndexFailure: { label: string; error: GraphifyError } };
