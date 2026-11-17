import type { Context } from "hono";

export type Identity = { userId: string };
export type IdentityProvider = (c: Context) => Promise<Identity | null>;
export const LOCAL_USER_ID = "usr_local";
export const localIdentity: IdentityProvider = async () => ({ userId: LOCAL_USER_ID });

declare module "hono" {
  interface ContextVariableMap {
    identity: Identity;
  }
}
