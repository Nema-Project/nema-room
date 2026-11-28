/**
 * First-run agent readiness (#302): whether the machine running the daemon can run each model runtime,
 * judged from local files and a `--version` only (D-1, D-3). "configured" is never "verified": no request is
 * sent, so a token revoked on the server still reads as configured.
 *
 * The daemon answers `agents.readiness` with a `ReadinessReply`; the hub adds the connection that answered and
 * the caller's access level, trimming the reply for anyone who is not the daemon's owner (spec "数据契约").
 * Nothing here carries a credential, a path's content or stderr.
 */

export const READINESS_RUNTIMES = ["codex-direct", "claude-code"] as const;
export type ReadinessRuntime = (typeof READINESS_RUNTIMES)[number];

export const READINESS_STATES = ["not_installed", "not_signed_in", "credential_unusable", "needs_model", "configured", "unknown"] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** Why a runtime is unknown or not configured, as a code the web translates; never stderr. */
export const READINESS_REASONS = ["no_enabled_account", "cli_timeout", "cli_error", "cli_broken", "inspect_failed"] as const;
export type ReadinessReason = (typeof READINESS_REASONS)[number];

export type RuntimeReadiness = {
  runtime: ReadinessRuntime;
  state: ReadinessState;
  reason?: ReadinessReason;
  cli?: { command: string; version: string | null; installUrl: string };
  /** Which account was judged and what kind it is, so the web can pick the next step (D-5); never its credential. */
  account?: { id: string; implicit: boolean; authMode?: "siwc" | "compat" | "byok" };
};

export type ReadinessReply = {
  current: ReadinessRuntime;
  runtimes: RuntimeReadiness[];
  /** ISO time the daemon computed this reply. */
  checkedAt: string;
  /** Filled by the hub from the connection that handled the RPC (D-4, D-9); the daemon never sends it. */
  daemon?: { id: string; label: string | null };
};

/**
 * The daemon that answered, as the hub saw it. `connectionId` is minted by the hub for every accepted
 * connection, so a daemon that reconnects under the same id still gets a new one (plan task 4).
 */
export type ReadinessDaemon = { id: string; connectionId: string; label: string | null };

export type ReadinessAccess = "full" | "owner_unknown" | "non_owner";

/** The whole reply, for the daemon's owner (or the single-user local form). */
export type FullAgentReadinessResponse = ReadinessReply & { daemon: ReadinessDaemon; access: "full" };

/** What anyone else sees: per runtime only its state, and no account, CLI or reason. */
export type TrimmedAgentReadinessResponse = Pick<ReadinessReply, "current" | "checkedAt"> & {
  runtimes: Array<Pick<RuntimeReadiness, "runtime" | "state">>;
  daemon: ReadinessDaemon;
  access: "owner_unknown" | "non_owner";
};

/** The hub's `GET /api/agent-readiness` answer. */
export type AgentReadinessResponse = FullAgentReadinessResponse | TrimmedAgentReadinessResponse;

/**
 * Error code of `GET /api/agent-readiness` (HTTP 501) when the daemon that answered predates `agents.readiness`.
 * The web reads it, like an offline daemon (503), as readiness `unknown`.
 */
export const READINESS_UNSUPPORTED = "readiness_unsupported";

/**
 * Error code of `GET /api/agent-readiness` (HTTP 503) when the connection that answered was closed or is no longer
 * the current one by the time the reply was built (spec D-4): the reply would describe a daemon the web no longer sees.
 */
export const READINESS_STALE = "readiness_stale";

/**
 * Which daemon connection is current, as `GET /api/daemon/status` and the `daemon.status` event report it (plan
 * task 4). The current connection is the one a call without a target lands on: the newest open connection. Both
 * ids are null exactly when `connected` is false. A snapshot and an event confirm a readiness reply equally.
 */
export type DaemonStatusSnapshot = { connected: boolean; daemonId: string | null; connectionId: string | null };
