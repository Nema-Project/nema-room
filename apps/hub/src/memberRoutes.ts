import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Db } from "./db/db.js";
import { MemberError, addMember, changeRole, getUser, listMemberEvents, listMembers, removeMember, renameUser, requireMember } from "./members.js";

const Role = z.enum(["owner", "member"]);
const UserId = z.string().regex(/^usr_[A-Za-z0-9_-]{1,32}$/);
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new MemberError(400, "invalid member request");
  return parsed.data;
}
export function memberRoutes({ db }: { db: Db }): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof MemberError) return c.json({ error: err.message }, err.status);
    // Database errors may include names and ids. Do not expose or log their detail.
    return c.json({ error: "member operation failed" }, 500);
  });
  app.get("/me", async c => c.json(await getUser(db, c.get("identity").userId)));
  app.patch("/me", async c => {
    const { displayName } = await body(c, z.object({ displayName: z.string().nullable() }).strict());
    return c.json(await renameUser(db, c.get("identity").userId, displayName));
  });
  app.get("/workspaces/:id/members", async c => {
    await requireMember(db, c.req.param("id"), c.get("identity").userId);
    return c.json(await listMembers(db, c.req.param("id")));
  });
  app.get("/workspaces/:id/members/events", async c => {
    await requireMember(db, c.req.param("id"), c.get("identity").userId);
    return c.json(await listMemberEvents(db, c.req.param("id")));
  });
  app.post("/workspaces/:id/members", async c => {
    const { userId, role } = await body(c, z.object({ userId: UserId, role: Role }).strict());
    return c.json(await addMember(db, c.req.param("id"), userId, role, c.get("identity").userId));
  });
  app.post("/workspaces/:id/members/:userId/role", async c => {
    const { role } = await body(c, z.object({ role: Role }).strict());
    return c.json(await changeRole(db, c.req.param("id"), c.req.param("userId"), role, c.get("identity").userId));
  });
  app.post("/workspaces/:id/members/:userId/remove", async c => c.json(await removeMember(db, c.req.param("id"), c.req.param("userId"), c.get("identity").userId)));
  return app;
}
