// Optional components (Graphify) live with the host daemon: the hub only passes the page's questions and its
// confirmed install through. The daemon owns the store, the lock and the download; the hub keeps nothing.
import { Hono, type Context } from "hono";
import { z } from "zod";
import { COMPONENT_RPC_TIMEOUT_MS, DaemonRpcError, type DaemonRpc } from "./daemonRpc.js";
import { daemonHttpStatus } from "./plugins.js";

const COMPONENT = z.enum(["graphify"]);
const LOCK_HASH = z.string().regex(/^[a-f0-9]{64}$/);

/** `confirmed` must be the literal true: the page sends it only after the person accepted the shown size. */
const InstallBody = z.object({ confirmed: z.literal(true), lockHash: LOCK_HASH }).strict();
const SettingsBody = z
  .object({
    pythonMirror: z.string().max(2048).nullable().optional(),
    pypiBase: z.string().max(2048).nullable().optional(),
    offline: z.boolean().optional(),
  })
  .strict();

/**
 * The daemon refuses a request that is the caller's fault (no confirmation, a changed offer, a bad mirror
 * address, an unknown component) with a message; those are 4xx. Everything else is a gateway problem.
 */
export function componentHttpStatus(message: string): 400 | 409 | 502 | 503 {
  if (/confirm again/.test(message)) return 409;
  if (/needs the user's confirmation|Unknown component|镜像地址|invalid (pythonMirror|pypiBase|offline)/.test(message)) return 400;
  return daemonHttpStatus(message);
}

async function json<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: c.json({ error: "request body must be valid JSON" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`).join("; ");
  return { ok: false, response: c.json({ error: `invalid request: ${detail}` }, 400) };
}

export function componentRoutes(deps: { daemon: DaemonRpc }): Hono {
  const app = new Hono();

  async function pass(c: Context, method: string, params: unknown) {
    try {
      const result = await deps.daemon.call(method, params, COMPONENT_RPC_TIMEOUT_MS);
      if (!result || typeof result !== "object" || Array.isArray(result)) return c.json({ error: `${method} returned an invalid result` }, 502);
      return c.json(result as Record<string, unknown>);
    } catch (error) {
      if (error instanceof DaemonRpcError) return c.json({ error: error.message }, componentHttpStatus(error.message));
      throw error;
    }
  }

  app.get("/components", (c) => pass(c, "components.status", {}));

  app.post("/components/:name/install", async (c) => {
    const name = COMPONENT.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "unknown component" }, 404);
    const body = await json(c, InstallBody);
    if (!body.ok) return body.response;
    return pass(c, "components.install", { name: name.data, confirmed: true, lockHash: body.data.lockHash });
  });

  app.post("/components/:name/cancel", async (c) => {
    const name = COMPONENT.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "unknown component" }, 404);
    return pass(c, "components.cancel", { name: name.data });
  });

  app.patch("/components/:name/settings", async (c) => {
    const name = COMPONENT.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "unknown component" }, 404);
    const body = await json(c, SettingsBody);
    if (!body.ok) return body.response;
    return pass(c, "components.configure", { name: name.data, ...body.data });
  });

  app.get("/agent-clis", (c) => pass(c, "agents.detect", {}));

  return app;
}
