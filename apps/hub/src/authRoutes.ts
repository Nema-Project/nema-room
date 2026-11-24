// #167 remote form account endpoints, only mounted when the hub runs with remoteAuth.
// - authRoutes: unauthenticated (bootstrap, login, invite acceptance, reset redemption). Mounted at /api/auth
//   ahead of the /api/* identity middleware, after hostGuard and CORS, like /share.
// - authSessionRoutes: need a session (logout, invites, administrator actions). Mounted at /api/auth after
//   the identity middleware, so a request without a valid session gets the usual 401.
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  AuthError,
  BootstrapClosedError,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  acceptCredentialReset,
  acceptInvite,
  bootstrapTokenMatches,
  completeBootstrap,
  createCredentialReset,
  createInvite,
  isBootstrapped,
  issueSession,
  listInvites,
  passwordHashFor,
  recordLoginLocked,
  removeBootstrapToken,
  revokeSession,
  revokeUserSessions,
} from "./auth.js";
import type { Db } from "./db/db.js";
import { LoginThrottle } from "./loginThrottle.js";
import { MAX_PASSWORD_BYTES, hashPassword, verifyPassword } from "./passwords.js";

export type AuthRouteDeps = {
  db: Db;
  dataDir: string;
  /** The one-time token main.ts wrote to `<dataDir>/bootstrap-token`; absent once bootstrapped. */
  bootstrapToken?: string;
  /** Login rate limiting; tests inject one with a fake clock. */
  loginThrottle?: LoginThrottle;
};

const Password = z.string().refine((p) => {
  const bytes = Buffer.byteLength(p, "utf8");
  return bytes > 0 && bytes <= MAX_PASSWORD_BYTES;
}, `password must be 1-${MAX_PASSWORD_BYTES} bytes`);
const DisplayName = z.string().trim().min(1).max(64);
const Code = z.string().min(1).max(256);

const BootstrapBody = z.object({ token: Code, displayName: DisplayName, password: Password }).strict();
/** `account` is the login identifier; today it is the userId returned when the account was created. */
const LoginBody = z.object({ account: z.string().min(1).max(64), password: Password }).strict();
const AcceptInviteBody = z.object({ code: Code, displayName: DisplayName, password: Password }).strict();
const AcceptResetBody = z.object({ code: Code, password: Password }).strict();
const CreateInviteBody = z.object({ workspaceId: z.string().min(1).max(64).nullable().optional() }).strict();

/** One message for an unknown account and a wrong password, so login does not reveal which accounts exist. */
export const INVALID_CREDENTIALS = "invalid credentials";
/** A locked account or source (429). Locks apply to unknown accounts too, so this reveals no account either. */
export const LOGIN_LOCKED = "too many failed attempts; try again later";

/**
 * Cookie attributes for every session the hub signs (bootstrap, invite, login) and for clearing it.
 * `secure` is a parameter so the deployment form decides it; these routes only exist in the remote form,
 * which always requires https or an encrypted overlay (spec D-8), so every caller passes true. Browsers
 * still accept Secure cookies from http://localhost. Task 13 re-checks this when the Host allowlist opens.
 */
export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: "Lax" as const, path: "/" };
}

function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { ...sessionCookieOptions(true), maxAge: Math.floor(SESSION_TTL_MS / 1000) });
}

async function readBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : null;
}

function authFailure(c: Context, error: unknown) {
  if (error instanceof AuthError) return c.json({ error: error.message }, error.status);
  throw error;
}

/** A hash to verify against when the account has no credential row, so both paths cost one argon2id run. */
let decoyHash: Promise<string> | undefined;
const decoy = () => (decoyHash ??= hashPassword("decoy password for accounts without credentials"));

/**
 * The peer address of the TCP connection. Forwarding headers are not trusted: the hub does not know
 * whether a proxy sits in front of it. Behind a reverse proxy every login shares the proxy's address,
 * so the source limit then applies to all logins together (the account limit is unaffected).
 */
function sourceAddress(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

export function authRoutes(deps: AuthRouteDeps): Hono {
  const app = new Hono();
  let bootstrapToken = deps.bootstrapToken;
  // One process, one throttle (spec topology for phase one).
  const throttle = deps.loginThrottle ?? new LoginThrottle();

  app.post("/bootstrap", async (c) => {
    // Closed for good once any credential row exists, whatever token or body is presented.
    if (await isBootstrapped(deps.db)) return c.json({ error: "bootstrap closed" }, 410);
    const parsed = await readBody(c, BootstrapBody);
    if (!parsed) return c.json({ error: "invalid bootstrap request" }, 400);
    const { token, displayName, password } = parsed;
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
    setSessionCookie(c, session.token);
    return c.json({ userId, displayName }, 201);
  });

  app.post("/login", async (c) => {
    const parsed = await readBody(c, LoginBody);
    if (!parsed) return c.json({ error: "invalid login request" }, 400);
    const { account, password } = parsed;
    const source = sourceAddress(c);
    return throttle.serialize(account, async () => {
      // A locked account or source is refused before the password is checked, even a correct one.
      const lock = throttle.check(account, source);
      if (lock) {
        c.header("Retry-After", String(Math.ceil(lock.retryAfterMs / 1000)));
        return c.json({ error: LOGIN_LOCKED }, 429);
      }
      const stored = await passwordHashFor(deps.db, account);
      const ok = await verifyPassword(password, stored ?? (await decoy()));
      if (!stored || !ok) {
        for (const scope of throttle.recordFailure(account, source)) {
          // Only a real account is named; a guessed one is not stored. The source is an address, not a secret.
          await recordLoginLocked(deps.db, scope === "account" && stored ? account : null,
            scope === "account" ? { scope } : { scope, source });
        }
        return c.json({ error: INVALID_CREDENTIALS }, 401);
      }
      throttle.recordSuccess(account);
      const session = await issueSession(deps.db, account);
      setSessionCookie(c, session.token);
      return c.json({ userId: account });
    });
  });

  app.post("/invites/accept", async (c) => {
    const parsed = await readBody(c, AcceptInviteBody);
    if (!parsed) return c.json({ error: "invalid invite request" }, 400);
    // Hash first: an unknown code costs the same argon2id run as a valid one.
    const passwordHash = await hashPassword(parsed.password);
    try {
      const { userId, session, intendedWorkspaceId } = await acceptInvite(deps.db, parsed.code, parsed.displayName, passwordHash);
      setSessionCookie(c, session.token);
      return c.json({ userId, displayName: parsed.displayName, intendedWorkspaceId }, 201);
    } catch (error) {
      return authFailure(c, error);
    }
  });

  app.post("/credential-reset/accept", async (c) => {
    const parsed = await readBody(c, AcceptResetBody);
    if (!parsed) return c.json({ error: "invalid reset request" }, 400);
    const passwordHash = await hashPassword(parsed.password);
    try {
      return c.json(await acceptCredentialReset(deps.db, parsed.code, passwordHash));
    } catch (error) {
      return authFailure(c, error);
    }
  });

  return app;
}

export function authSessionRoutes(deps: { db: Db }): Hono {
  const app = new Hono();

  app.post("/logout", async (c) => {
    // The identity middleware already proved the cookie names a live session.
    await revokeSession(deps.db, getCookie(c, SESSION_COOKIE) ?? "");
    deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(true));
    return c.json({ ok: true });
  });

  app.post("/invites", async (c) => {
    const parsed = await readBody(c, CreateInviteBody);
    if (!parsed) return c.json({ error: "invalid invite request" }, 400);
    try {
      return c.json(await createInvite(deps.db, c.get("identity").userId, { workspaceId: parsed.workspaceId ?? null }), 201);
    } catch (error) {
      return authFailure(c, error);
    }
  });

  app.get("/invites", async (c) => c.json({ invites: await listInvites(deps.db, c.get("identity").userId) }));

  app.post("/users/:userId/revoke-sessions", async (c) => {
    try {
      return c.json({ revoked: await revokeUserSessions(deps.db, c.get("identity").userId, c.req.param("userId")) });
    } catch (error) {
      return authFailure(c, error);
    }
  });

  app.post("/users/:userId/credential-reset", async (c) => {
    try {
      return c.json(await createCredentialReset(deps.db, c.get("identity").userId, c.req.param("userId")), 201);
    } catch (error) {
      return authFailure(c, error);
    }
  });

  return app;
}
