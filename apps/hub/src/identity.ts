import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, resolveSession } from "./auth.js";
import type { Db } from "./db/db.js";

export type Identity = { userId: string };
export type IdentityProvider = (c: Context) => Promise<Identity | null>;
export const LOCAL_USER_ID = "usr_local";
export const localIdentity: IdentityProvider = async () => ({ userId: LOCAL_USER_ID });

/**
 * Remote form (#167): the identity is the user behind the session cookie. A missing, unknown, expired or
 * revoked session yields null (401). It never yields `usr_local`, the local form's synthetic user (D-10).
 */
export function sessionIdentity(db: Db): IdentityProvider {
  return async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const userId = await resolveSession(db, token);
    if (!userId || userId === LOCAL_USER_ID) return null;
    return { userId };
  };
}

declare module "hono" {
  interface ContextVariableMap {
    identity: Identity;
  }
}
