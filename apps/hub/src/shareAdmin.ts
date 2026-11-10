import { Hono } from "hono";
import { z, ZodError } from "zod";
import type { Db } from "./db/db.js";
import { createShare, listShares, revokeShare, ShareInputError } from "./shares.js";

const createBody = z.object({
  note: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
}).strict();

/** Owner routes. The token is returned only by create. */
export function shareAdminRoutes(deps: { db: Db; sharesEnabled: boolean }): Hono {
  const app = new Hono();

  app.get("/workspaces/:id/shares", async (c) => {
    const shares = (await listShares(deps.db, c.req.param("id"))).map((row) => ({
      id: row.id,
      note: row.note,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    }));
    return c.json({ shares });
  });

  app.post("/workspaces/:id/shares", async (c) => {
    if (!deps.sharesEnabled) return c.json({ error: "sharing disabled" }, 403);
    try {
      const body = createBody.parse(await c.req.json());
      const created = await createShare(deps.db, c.req.param("id"), body);
      return c.json({
        id: created.id,
        token: created.token,
        note: created.note,
        expiresAt: created.expiresAt,
        createdAt: created.createdAt,
      }, 201);
    } catch (error) {
      if (error instanceof ShareInputError) return c.json({ error: error.message }, error.status);
      if (error instanceof ZodError) return c.json({ error: "invalid request" }, 400);
      throw error;
    }
  });

  app.post("/workspaces/:id/shares/:shareId/revoke", async (c) => {
    const row = await revokeShare(deps.db, c.req.param("id"), c.req.param("shareId"));
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({
      id: row.id,
      note: row.note,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    });
  });

  return app;
}
