// Access decisions for browser API routes (#167 task 8 and deviation 2). Every content route decides
// through `authorizeWorkspace` and every host-level route through `authorizeHostAdmin`; the local form's
// short-circuit (`isLocalForm`) lives here and nowhere else.
import type { MiddlewareHandler } from "hono";
import { AuthError, isHubAdmin } from "./auth.js";
import type { Db } from "./db/db.js";
import { LOCAL_USER_ID, type Identity } from "./identity.js";
import { MemberError, requireMember } from "./members.js";

export type WorkspaceAccess = "member" | "owner";

/**
 * The one local-form short-circuit. `usr_local` is the synthetic user of the local form (desktop, npm,
 * Compose on one machine). The remote form's session provider never yields it, so passing it here does
 * not open the remote form.
 */
function isLocalForm(identity: Identity): boolean {
  return identity.userId === LOCAL_USER_ID;
}

/**
 * Throws MemberError(403) unless `identity` is an active member of the workspace (an active owner when
 * `access` is "owner"). A missing workspace is refused the same way, so a refusal does not reveal whether
 * the workspace exists.
 *
 * `usr_local` always passes: it is the synthetic user of the local form (desktop, npm, Compose on one
 * machine), where it owns every workspace and the hub behaved this way before rosters were enforced (D-10).
 * The remote form's session provider never yields `usr_local`, so this does not open the remote form.
 */
export async function authorizeWorkspace(db: Db, identity: Identity, workspaceId: string, access: WorkspaceAccess = "member"): Promise<void> {
  if (isLocalForm(identity)) return;
  await requireMember(db, workspaceId, identity.userId, access === "owner");
}

/** For lists: whether the caller may see the workspace at all. */
export async function canSeeWorkspace(db: Db, identity: Identity, workspaceId: string): Promise<boolean> {
  try {
    await authorizeWorkspace(db, identity, workspaceId);
    return true;
  } catch (e) {
    if (e instanceof MemberError && e.status === 403) return false;
    throw e;
  }
}

/** Route middleware for paths whose `:id` parameter is the workspace id. Runs before any read or write. */
export function workspaceAccess(db: Db, access: WorkspaceAccess = "member"): MiddlewareHandler {
  return async (c, next) => {
    try {
      await authorizeWorkspace(db, c.get("identity"), c.req.param("id")!, access);
    } catch (e) {
      if (e instanceof MemberError) return c.json({ error: e.message }, e.status);
      throw e;
    }
    await next();
  };
}

/**
 * Host-level routes (#167 deviation 2) act on the machine the daemon runs on rather than on one
 * workspace: components, extensions and MCP servers and their secrets, the host plugin catalog, the
 * folder picker and daemon status. In the remote form only the hub administrator (the account that
 * completed the bootstrap) may use them; any other signed-in account gets AuthError(403). The local
 * form's `usr_local` passes unchanged.
 */
export async function authorizeHostAdmin(db: Db, identity: Identity): Promise<void> {
  if (isLocalForm(identity)) return;
  if (!(await isHubAdmin(db, identity.userId))) throw new AuthError(403, "only the hub administrator may do this");
}

/** Route middleware for host-level routes. Runs after the identity middleware and before any read or write. */
export function hostAdminAccess(db: Db): MiddlewareHandler {
  return async (c, next) => {
    try {
      await authorizeHostAdmin(db, c.get("identity"));
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: e.message }, e.status);
      throw e;
    }
    await next();
  };
}
