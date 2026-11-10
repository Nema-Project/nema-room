import { Hono, type Context } from "hono";
import { KnowledgeStore } from "@nema/knowledge";
import { kindFromId } from "@nema/shared";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import type { Db } from "./db/db.js";
import { SHARE_TOKEN_RE, resolveShare, toPublicEntry, toPublicSummary } from "./shares.js";
import { repoPath } from "./workspaces.js";

const NOT_FOUND = { error: "not found" };

export function shareRoutes(deps: { db: Db; dataDir: string; sharesEnabled: boolean; ownedHelpers?: OwnedHelperScope }): Hono {
  const app = new Hono();

  const read = async (c: Context, token: string, entryId?: string) => {
    c.header("cache-control", "no-store");
    // Shape and the master switch are not secrets. Both answer before any share lookup.
    if (!SHARE_TOKEN_RE.test(token) || !deps.sharesEnabled) return c.json(NOT_FOUND, 404);
    const resolution = await resolveShare(deps.db, token);
    if (!resolution.found || !resolution.available) return c.json(NOT_FOUND, 404);
    const store = new KnowledgeStore(repoPath(deps.dataDir, resolution.workspaceId), deps.ownedHelpers);
    if (entryId === undefined) {
      const entries = await store.listEntries();
      return c.json({ workspaceName: resolution.workspaceName, entries: entries.map(toPublicSummary) });
    }
    if (!kindFromId(entryId)) return c.json(NOT_FOUND, 404);
    const entry = await store.get(entryId);
    if (!entry) return c.json(NOT_FOUND, 404);
    return c.json(toPublicEntry(entry));
  };

  const methodNotAllowed = (c: Context) => {
    c.header("allow", "GET, HEAD");
    c.header("cache-control", "no-store");
    return c.body(null, 405);
  };

  app.on(["GET", "HEAD"], "/:token/entries/:eid", (c) => read(c, c.req.param("token"), c.req.param("eid")));
  app.on(["GET", "HEAD"], "/:token", (c) => read(c, c.req.param("token")));
  app.all("/:token/entries/:eid", methodNotAllowed);
  app.all("/:token", methodNotAllowed);
  return app;
}
