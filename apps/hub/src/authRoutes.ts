// #167 remote form: unauthenticated account endpoints, mounted at /api/auth ahead of the /api/* identity
// middleware (after hostGuard and CORS), only when the hub runs with remoteAuth. Login lands in task 5.
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import {
  BootstrapClosedError,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  bootstrapTokenMatches,
  completeBootstrap,
  isBootstrapped,
  removeBootstrapToken,
} from "./auth.js";
import type { Db } from "./db/db.js";
import { MAX_PASSWORD_BYTES, hashPassword } from "./passwords.js";

export type AuthRouteDeps = {
  db: Db;
  dataDir: string;
  /** The one-time token main.ts wrote to `<dataDir>/bootstrap-token`; absent once bootstrapped. */
  bootstrapToken?: string;
};

const BootstrapBody = z.object({
  token: z.string().min(1).max(256),
  displayName: z.string().trim().min(1).max(64),
  password: z.string().refine((p) => {
    const bytes = Buffer.byteLength(p, "utf8");
    return bytes > 0 && bytes <= MAX_PASSWORD_BYTES;
  }, `password must be 1-${MAX_PASSWORD_BYTES} bytes`),
}).strict();

export function authRoutes(deps: AuthRouteDeps): Hono {
  const app = new Hono();
  let bootstrapToken = deps.bootstrapToken;

  app.post("/bootstrap", async (c) => {
    // Closed for good once any credential row exists, whatever token or body is presented.
    if (await isBootstrapped(deps.db)) return c.json({ error: "bootstrap closed" }, 410);
    const parsed = BootstrapBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ error: "invalid bootstrap request" }, 400);
    const { token, displayName, password } = parsed.data;
    if (!bootstrapTokenMatches(bootstrapToken, token)) return c.json({ error: "invalid bootstrap token" }, 403);

    const passwordHash = await hashPassword(password);
    let completed: Awaited<ReturnType<typeof completeBootstrap>>;
    try {
      completed = await completeBootstrap(deps.db, displayName, passwordHash);
    } catch (error) {
      if (error instanceof BootstrapClosedError) return c.json({ error: "bootstrap closed" }, 410);
      throw error;
    }
    // The account and its first session committed together; only now is the token spent.
    bootstrapToken = undefined;
    await removeBootstrapToken(deps.dataDir);

    const { userId, session } = completed;
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      // The remote form always requires https or an encrypted overlay (spec D-8); browsers still accept
      // Secure cookies from http://localhost.
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return c.json({ userId, displayName }, 201);
  });

  return app;
}
