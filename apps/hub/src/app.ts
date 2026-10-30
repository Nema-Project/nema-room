import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { DaemonRpc } from "./daemonRpc.js";
import type { Db } from "./db/db.js";
import type { Archify } from "./diagrams.js";
import type { EventBus } from "./events.js";
import { ATTACHMENT_UPLOAD_PATH, attachmentRoutes } from "./attachmentRoutes.js";
import { AttachmentStore } from "./attachments.js";
import { reportRoutes } from "./reports.js";
import { roomRoutes } from "./roomApi.js";
import { uiRoutes } from "./uiApi.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export const DEFAULT_HUB_PORT = 4400;

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
  /** Late-bound in main.ts, the same way `daemonStatus` is. */
  daemon: DaemonRpc;
  webOrigin?: string;
  /** Optional gate for browser UI/API traffic; room and report authentication stay separate. */
  uiAuth?: MiddlewareHandler;
  /** Diagram validation and rendering; defaults to the vendored archify. Tests inject a fake. */
  archify?: Archify;
  /** Port the hub listens on; only `127.0.0.1:<port>` and `localhost:<port>` are accepted as Host. */
  port?: number;
  ownedHelpers?: OwnedHelperScope;
  /** User-facing release version. Present on Compose and desktop hubs; absent in tests that do not pair a daemon. */
  releaseVersion?: string;
  /** Chat attachment storage. startHub passes the one it swept at startup; tests may omit it. */
  attachments?: AttachmentStore;
};

/**
 * Rejects requests whose Host is not the hub's own loopback name (DNS rebinding: a page on
 * evil.example that rebinds to 127.0.0.1 still sends `Host: evil.example:<port>`).
 */
function hostGuard(port: number): MiddlewareHandler {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return async (c, next) => {
    const host = (c.req.header("host") ?? new URL(c.req.url).host).toLowerCase();
    if (!allowed.has(host)) return c.json({ error: "forbidden host" }, 403);
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
  const app = new Hono();
  const guard = hostGuard(deps.port ?? DEFAULT_HUB_PORT);
  app.use("/api/*", guard);
  app.use("/room/*", guard);
  app.use("/report", guard);
  app.use("/report/*", guard);
  // NEMA_WEB_ORIGIN may be a comma-separated list; the default covers both names of the loopback web server.
  const webOrigins = (deps.webOrigin ?? "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use("/api/*", cors({ origin: (o) => (webOrigins.includes(o) ? o : null), allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
  app.get("/api/version", (c) => {
    if (!deps.releaseVersion) return c.json({ error: "version unavailable" }, 404);
    return c.json({ version: deps.releaseVersion });
  });
  if (deps.uiAuth) app.use("/api/*", deps.uiAuth);
  app.use("/api/*", requireJson);
  const attachments = deps.attachments ?? new AttachmentStore(deps.db, deps.dataDir);
  app.route("/api", attachmentRoutes({ store: attachments, daemon: deps.daemon, daemonStatus: deps.daemonStatus }));
  app.route("/api", uiRoutes(deps));
  app.route(
    "/room",
    roomRoutes({
      db: deps.db,
      dataDir: deps.dataDir,
      events: deps.events,
      daemon: deps.daemon,
      ownedHelpers: deps.ownedHelpers,
      ...(deps.archify !== undefined ? { archify: deps.archify } : {}),
    }),
  );
  // Coding agents' hooks and reports (`nema report`), authorized by the report token.
  app.route("/report", reportRoutes({ db: deps.db, events: deps.events, daemon: deps.daemon, dataDir: deps.dataDir, ownedHelpers: deps.ownedHelpers }));
  return app;
}
