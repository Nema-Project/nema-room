import { z } from "zod";

/**
 * The record of one routing decision: which account and model produced this reply, and why that one
 * (spec 2026-10-31 §4.6, D-5). It lives in `AgentMessageMeta.route` and travels in `task.finished`, so an
 * older message without it and an older daemon that never sends one both stay valid.
 *
 * What is deliberately absent: the base URL (users may not want the endpoint in an exported conversation),
 * any credential, and the account's `order` / `costTier` — the metadata records what happened, not the
 * settings it happened under.
 */
export const ROUTE_REASONS = [
  /** The user chose this account in this workspace. */
  "user_workspace",
  /** The user chose it for this thread. */
  "user_thread",
  /** The user chose it for this one message. */
  "user_message",
  /** Nobody chose; this is the machine's default account. */
  "default",
  /** Automatic routing picked it first. */
  "auto_primary",
  /** Automatic routing moved here after another account failed. */
  "auto_failover",
  /** Automatic routing moved here because another account hit its limit. */
  "auto_after_limit",
] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

/** One account that was tried and did not answer, with the machine-readable reason it failed. */
export const RouteAttemptSchema = z
  .object({
    accountId: z.string(),
    accountName: z.string(),
    model: z.string().optional(),
    failure: z.string(),
  })
  .strict();

/** Token counts the provider itself reported. Absent when it reported none; never estimated. */
export const RouteUsageSchema = z
  .object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() })
  .strict();

export const RouteDecisionSchema = z
  .object({
    accountId: z.string(),
    accountName: z.string(),
    model: z.string(),
    mode: z.enum(["manual", "auto"]),
    reason: z.enum(ROUTE_REASONS),
    /** Accounts tried before this one, in order. Empty or absent in manual mode. */
    attempts: z.array(RouteAttemptSchema).optional(),
    usage: RouteUsageSchema.optional(),
  })
  .strict();

export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
export type RouteAttempt = z.infer<typeof RouteAttemptSchema>;
