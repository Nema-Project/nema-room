// First-run agent readiness (#302 task 5): the hub passes `agents.readiness` through to the daemon, names the
// connection that answered, and trims the reply for anyone who is not that daemon's owner (spec "数据契约",
// "谁能看到多少"; D-4, D-7, D-9). It keeps nothing. Every failure is quiet for the web: offline, a replaced
// connection (503) and an old daemon (501) all read as `unknown`.
import { Hono } from "hono";
import { z } from "zod";
import {
  READINESS_REASONS,
  READINESS_RUNTIMES,
  READINESS_STALE,
  READINESS_STATES,
  READINESS_UNSUPPORTED,
  isUnknownRpcMethodError,
  type AgentReadinessResponse,
  type DaemonStatusSnapshot,
  type ReadinessAccess,
  type ReadinessDaemon,
} from "@nema/shared";
import { COMPONENT_RPC_TIMEOUT_MS, DaemonRpcError, type DaemonResponder, type DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import { LOCAL_USER_ID, type Identity } from "./identity.js";
import { daemonHttpStatus } from "./plugins.js";

/**
 * What the daemon may send. Unknown keys are stripped (a `daemon` field from the daemon included: the hub fills
 * that one itself); a reply that does not fit is a gateway error, not something to guess at.
 */
const RuntimeReadinessSchema = z.object({
  runtime: z.enum(READINESS_RUNTIMES),
  state: z.enum(READINESS_STATES),
  reason: z.enum(READINESS_REASONS).optional(),
  cli: z.object({ command: z.string(), version: z.string().nullable(), installUrl: z.string() }).optional(),
  account: z.object({ id: z.string(), implicit: z.boolean(), authMode: z.enum(["siwc", "compat", "byok"]).optional() }).optional(),
});
const ReadinessReplySchema = z.object({
  current: z.enum(READINESS_RUNTIMES),
  runtimes: z.array(RuntimeReadinessSchema),
  checkedAt: z.string(),
});

/**
 * Who sees the whole reply. The local form's only identity sees everything. In the remote form the owner of the
 * registered daemon that answered does; anyone else gets the trimmed form. A daemon on the shared token is not
 * registered, so nobody can be named its owner (`owner_unknown`).
 */
export function readinessAccess(identity: Identity, responder: Pick<DaemonResponder, "registered" | "ownerUserId">): ReadinessAccess {
  if (identity.userId === LOCAL_USER_ID) return "full";
  if (!responder.registered) return "owner_unknown";
  return responder.ownerUserId !== null && responder.ownerUserId === identity.userId ? "full" : "non_owner";
}

async function daemonLabel(db: Db, daemonId: string): Promise<string | null> {
  const [row] = await db.query<{ label: string }>("select label from daemons where id = $1", [daemonId]);
  return row?.label ?? null;
}

export function readinessRoutes(deps: {
  db: Db;
  daemon: DaemonRpc;
  /** The current daemon connection. Without it no reply can be confirmed current, so every reply is a 503. */
  daemonSnapshot?: () => DaemonStatusSnapshot;
}): Hono {
  const app = new Hono();

  app.get("/agent-readiness", async (c) => {
    const params = c.req.query("force") === "1" ? { force: true } : {};
    let responder: DaemonResponder | undefined;
    let raw: unknown;
    try {
      // No other target: the call lands on the current connection, the same one `daemon.status` names.
      raw = await deps.daemon.call("agents.readiness", params, COMPONENT_RPC_TIMEOUT_MS, { onResponder: (r) => { responder = r; } });
    } catch (error) {
      if (!(error instanceof DaemonRpcError)) throw error;
      if (isUnknownRpcMethodError(error.message)) return c.json({ error: READINESS_UNSUPPORTED }, 501);
      return c.json({ error: error.message }, daemonHttpStatus(error.message));
    }
    const answered = responder as DaemonResponder | undefined;
    if (!answered) return c.json({ error: READINESS_STALE }, 503);
    const parsed = ReadinessReplySchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "agents.readiness returned an invalid result" }, 502);
    const reply = parsed.data;
    const daemon: ReadinessDaemon = {
      id: answered.daemonId,
      connectionId: answered.connectionId,
      label: answered.registered ? await daemonLabel(deps.db, answered.daemonId) : null,
    };
    const access = readinessAccess(c.get("identity"), answered);
    // Last, after every await: the connection that answered must still be the current one, or the reply would
    // describe a daemon the web no longer sees (spec D-4). A closed connection is never current.
    if (deps.daemonSnapshot?.().connectionId !== answered.connectionId) return c.json({ error: READINESS_STALE }, 503);

    let body: AgentReadinessResponse;
    if (access === "full") {
      body = { access, current: reply.current, runtimes: reply.runtimes, checkedAt: reply.checkedAt, daemon };
    } else {
      // Built from an allowlist, never by deleting fields: reason, cli and account cannot slip through.
      body = {
        access,
        current: reply.current,
        checkedAt: reply.checkedAt,
        daemon,
        runtimes: reply.runtimes.map((r) => ({ runtime: r.runtime, state: r.state })),
      };
    }
    return c.json(body);
  });

  return app;
}
