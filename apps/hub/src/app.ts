import { localIdentity, sessionIdentity, type IdentityProvider } from "./identity.js";
import { authRoutes, authSessionRoutes } from "./authRoutes.js";
import type { LoginThrottle } from "./loginThrottle.js";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { daemonRegistrationRoutes, daemonSessionRoutes, type RevokeRegisteredDaemon } from "./daemons.js";
import type { DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { Task, WaitingReason } from "./tasks.js";
import type { Archify } from "./diagrams.js";
import type { EventBus } from "./events.js";
import { ATTACHMENT_UPLOAD_PATH, attachmentRoutes } from "./attachmentRoutes.js";
import { AttachmentStore } from "./attachments.js";
import { reportRoutes } from "./reports.js";
import { roomRoutes } from "./roomApi.js";
import { shareAdminRoutes } from "./shareAdmin.js";
import { shareRoutes } from "./shareRoutes.js";
import { memberRoutes } from "./memberRoutes.js";
import { mentionContextRoutes } from "./mentionContext.js";
import { uiRoutes } from "./uiApi.js";
import { componentRoutes } from "./components.js";
import { readinessRoutes } from "./readiness.js";
import type { DaemonStatusSnapshot } from "@nema/shared";
import { hostAdminAccess, workspaceAccess } from "./authz.js";
import { createHostAllowed } from "./hostAllowlist.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export const DEFAULT_HUB_PORT = 4400;

/** memberRoutes' paths; they check membership themselves through members.ts. */
const ROSTER_PATH = /^\/api\/workspaces\/[^/]+\/members(?:\/|$)/;

/**
 * Host-level routes (#167 deviation 2): componentRoutes' /components and /agent-clis, every
 * /extensions route including MCP and its secrets, the host plugin catalog /plugins, /pick-directory and
 * /daemon/*. Workspace-level /workspaces/:id/plugins does not match; it keeps the roster and owner checks.
 * The read-only attachment capability lookup is exempt: the composer needs it to refuse unsupported kinds
 * before sending, and it neither reads nor writes host state.
 */
const HOST_ADMIN_PATH = /^\/api\/(?:components|agent-clis|extensions|plugins|pick-directory|daemon)(?:\/|$)/;
const HOST_ADMIN_EXEMPT_PATH = /^\/api\/daemon\/attachment-capabilities$/;
/**
 * #302 (maintainer ruling, issue comment 7232605390): reading the daemon status is open to every signed-in user.
 * It carries only `{ connected, daemonId, connectionId }` (the same payload as the `daemon.status` event), no
 * secret or configuration. The web needs it to confirm a readiness reply: the permanent "first-run ready" mark is
 * written only against a snapshot fetched fresh after the `ready` reply whose daemon and connection ids both match
 * it; an event alone never suffices (see `DaemonStatusSnapshot`). Only GET; every other method and every other
 * /daemon/* path stays with the hub administrator.
 */
const isOpenDaemonStatusRead = (method: string, path: string): boolean => method === "GET" && path === "/api/daemon/status";

export type AppDeps = {
  db: Db;
  dataDir: string;
  /**
   * Root of the CLI's per-workspace isolation dirs (`<nemaHome>/ws/<id>`), removed on workspace delete.
   * Leave unset when the hub cannot see the daemon's filesystem (Docker); the daemon then cleans up itself.
   */
  nemaHome?: string;
  events: EventBus;
  daemonStatus: () => boolean;
  /**
   * The current daemon connection (#302 task 4), late-bound like `daemonStatus`. Omitted (tests without a
   * socket): the status names no connection and no readiness reply can be confirmed current (503).
   */
  daemonSnapshot?: () => DaemonStatusSnapshot;
  /** Late-bound in main.ts, the same way `daemonStatus` is. */
  daemon: DaemonRpc;
  webOrigin?: string;
  /** Identity provider for browser UI/API traffic; room and report authentication stay separate. */
  identity?: IdentityProvider;
  /** Diagram validation and rendering; defaults to the vendored archify. Tests inject a fake. */
  archify?: Archify;
  /** Port the hub listens on; only `127.0.0.1:<port>` and `localhost:<port>` are accepted as Host. */
  port?: number;
  /**
   * #167 remote form: extra Host values the hub answers to, from NEMA_HUB_ALLOWED_HOSTS.
   * Each entry is a hostname or a host:port; an entry without a port matches the Host's hostname
   * part whatever port it carries. Only consulted while `remoteAuth` is on; without remoteAuth
   * the list is ignored and the guard behaves exactly as before.
   */
  allowedHosts?: string[];
  /** `false` hides public share reads. Omitted stays on. */
  sharesEnabled?: boolean;
  ownedHelpers?: OwnedHelperScope;
  /** User-facing release version. Present on Compose and desktop hubs; absent in tests that do not pair a daemon. */
  releaseVersion?: string;
  /** Chat attachment storage. startHub passes the one it swept at startup; tests may omit it. */
  attachments?: AttachmentStore;
  /**
   * #167 remote form (NEMA_HUB_REMOTE=1, standalone hub only). On: browser identity comes from the session
   * cookie and /api/auth/* exists. Off or omitted: neither exists and identity behaves as before.
   */
  remoteAuth?: boolean;
  revokeRegisteredDaemon?: RevokeRegisteredDaemon;
  /**
   * Why a queued task is still waiting, derived live from the online daemons (D-6). The daemon socket
   * provides it; tests and callers without a socket omit it and queued tasks carry no reason.
   */
  waitingReasonFor?: (task: Task) => Promise<WaitingReason | null>;
  /** One-time bootstrap token from main.ts; only read when remoteAuth is on and no account exists yet. */
  bootstrapToken?: string;
  /** Login rate limiting for /api/auth/login; omitted creates one per app. Tests inject a fixed clock. */
  loginThrottle?: LoginThrottle;
};

/**
 * Rejects requests whose Host is not the hub's own loopback name (DNS rebinding: a page on
 * evil.example that rebinds to 127.0.0.1 still sends `Host: evil.example:<port>`).
 *
 * #167 remote form: loopback (`127.0.0.1:<port>` / `localhost:<port>`) is always allowed, and
 * while `remoteAuth` is on the allowlist adds hosts the deployer explicitly named. An entry is
 * a hostname or a host:port; without a port it matches the Host's hostname part whatever port
 * the request carries. Without `remoteAuth` the list is ignored, so a mis-filled list can never
 * widen the local form. Anything else is refused with 403; the rebinding protection this guard
 * exists for is unchanged, only the set of legitimate names grew.
 */
function hostGuard(port: number, opts: { allowedHosts?: string[]; remoteAuth?: boolean } = {}): MiddlewareHandler {
  // Same predicate as the /daemon WebSocket upgrade (daemonSocket.ts), so both entry points agree.
  const hostAllowed = createHostAllowed(port, opts);
  return async (c, next) => {
    if (!hostAllowed(c.req.header("host") ?? new URL(c.req.url).host)) return c.json({ error: "forbidden host" }, 403);
    await next();
  };
}

/** State-changing UI requests must be JSON, which a cross-site "simple" request cannot send without a preflight. */
const requireJson: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "POST" && ATTACHMENT_UPLOAD_PATH.test(c.req.path)) return next(); // raw bytes; the route checks its own type
  if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
    const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return c.json({ error: "content-type must be application/json" }, 415);
  }
  await next();
};

export function createApp(deps: AppDeps): Hono {
  if (deps.remoteAuth && deps.identity) throw new Error("remoteAuth uses the session provider; do not also inject an identity provider");
  const identity = deps.remoteAuth ? sessionIdentity(deps.db) : (deps.identity ?? localIdentity);
  const app = new Hono();
  const guard = hostGuard(deps.port ?? DEFAULT_HUB_PORT, { allowedHosts: deps.allowedHosts, remoteAuth: deps.remoteAuth });
  app.use("/share", guard);
  app.use("/share/*", guard);
  app.route("/share", shareRoutes({
    db: deps.db,
    dataDir: deps.dataDir,
    sharesEnabled: deps.sharesEnabled !== false,
    ownedHelpers: deps.ownedHelpers,
  }));
  app.use("/api/*", guard);
  app.use("/room/*", guard);
  app.use("/report", guard);
  app.use("/report/*", guard);
  // NEMA_WEB_ORIGIN may be a comma-separated list; the default covers both names of the loopback web server.
  const webOrigins = (deps.webOrigin ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  // credentials: the web calls the hub with credentials "include" so a remote-form session cookie reaches a
  // hub on another origin. Only the listed origins are echoed, so no other page can read a credentialed
  // response. The local form ignores cookies (its identity never reads one), so this changes nothing there.
  app.use("/api/*", cors({
    origin: (o) => (webOrigins.includes(o) ? o : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }));
  app.get("/api/version", (c) => {
    if (!deps.releaseVersion) return c.json({ error: "version unavailable" }, 404);
    return c.json({ version: deps.releaseVersion });
  });
  if (deps.remoteAuth) {
    // Like /share: unauthenticated by design, but still behind hostGuard and CORS. Mounted before the
    // identity middleware so a request that matches here never needs a session.
    app.use("/api/auth/*", requireJson);
    app.use("/api/daemons/register", requireJson);
    app.route("/api/daemons", daemonRegistrationRoutes(deps.db));
    app.route("/api/auth", authRoutes({ db: deps.db, dataDir: deps.dataDir, bootstrapToken: deps.bootstrapToken, loginThrottle: deps.loginThrottle }));
  }
  app.use("/api/*", async (c, next) => {
    const resolved = await identity(c);
    if (!resolved) return c.json({ error: "unauthorized" }, 401);
    c.set("identity", resolved);
    await next();
  });
  // Host-level routes act on the daemon's machine, not on one workspace: in the remote form only the hub
  // administrator may use them, every method included (#167 deviation 2). Registered right after identity
  // resolution so a refused caller is answered before body checks and before any route reads or writes.
  const hostAdminGate = hostAdminAccess(deps.db);
  app.use("/api/*", (c, next) =>
    HOST_ADMIN_PATH.test(c.req.path) && !HOST_ADMIN_EXEMPT_PATH.test(c.req.path) && !isOpenDaemonStatusRead(c.req.method, c.req.path)
      ? hostAdminGate(c, next)
      : next());
  app.use("/api/*", requireJson);
  // Every workspace-scoped route needs the caller on that workspace's roster, before any route reads or
  // writes (#167 task 8). Registered ahead of all routers so no route under the prefix can be missed; routes
  // that administer a workspace add the owner check themselves. The roster routes keep their own checks in
  // members.ts unchanged, so they are left out here.
  const memberGate = workspaceAccess(deps.db);
  app.use("/api/workspaces/:id/*", (c, next) => (ROSTER_PATH.test(c.req.path) ? next() : memberGate(c, next)));
  // Logout, invites and administrator actions need the session the middleware above resolved.
  if (deps.remoteAuth) {
    app.route("/api/auth", authSessionRoutes({ db: deps.db }));
    app.route("/api/daemons", daemonSessionRoutes(deps.db, deps.revokeRegisteredDaemon));
  }
  const attachments = deps.attachments ?? new AttachmentStore(deps.db, deps.dataDir);
  app.route("/api", attachmentRoutes({ store: attachments, daemon: deps.daemon, daemonStatus: deps.daemonStatus, db: deps.db, events: deps.events }));
  app.route("/api", mentionContextRoutes({ db: deps.db, attachments }));
  app.route("/api", memberRoutes({ db: deps.db, events: deps.events }));
  app.route("/api", componentRoutes({ daemon: deps.daemon }));
  // GET /api/agent-readiness is deliberately not in HOST_ADMIN_PATH (#302 task 5, spec "谁能看到多少"): every
  // signed-in user may ask whether the machine running the daemon can run agents. The route itself trims the
  // reply to runtime and state for anyone who is not that daemon's owner, so no account, CLI or reason leaks.
  app.route("/api", readinessRoutes({ db: deps.db, daemon: deps.daemon, daemonSnapshot: deps.daemonSnapshot }));
  app.route("/api", uiRoutes(deps));
  app.route("/api", shareAdminRoutes({ db: deps.db, sharesEnabled: deps.sharesEnabled !== false }));
  app.route(
    "/room",
    roomRoutes({
      db: deps.db,
      dataDir: deps.dataDir,
      events: deps.events,
      daemon: deps.daemon,
      ownedHelpers: deps.ownedHelpers,
      attachments,
      ...(deps.archify !== undefined ? { archify: deps.archify } : {}),
    }),
  );
  // Coding agents' hooks and reports (`nema report`), authorized by the report token.
  app.route("/report", reportRoutes({ db: deps.db, events: deps.events, daemon: deps.daemon, dataDir: deps.dataDir, ownedHelpers: deps.ownedHelpers }));
  return app;
}
