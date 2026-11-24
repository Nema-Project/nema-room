// #167 remote form: session primitives and the bootstrap state. Session tokens and the bootstrap token are
// high-entropy random values, so the hub stores only their sha256 (the knowledge_shares precedent in
// shares.ts); only human passwords go through argon2id (passwords.ts).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Db } from "./db/db.js";

/** Name of the httpOnly cookie that carries the session token in the remote form. */
export const SESSION_COOKIE = "nema_session";
/** A session lives 14 days from issue; there is no sliding renewal yet. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** File under the hub data directory, next to `daemon-token`, holding the one-time bootstrap token. */
export const BOOTSTRAP_TOKEN_FILE = "bootstrap-token";

/** 32 random bytes as base64url: 43 characters, the same shape as share tokens. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export type IssuedSession = { id: string; token: string; userId: string; expiresAt: string };

/** Creates a session row and returns the plaintext token. The token is never stored or logged. */
export async function issueSession(db: Db, userId: string, opts: { now?: Date } = {}): Promise<IssuedSession> {
  const now = opts.now ?? new Date();
  const token = newToken();
  const id = `ses_${nanoid(16)}`;
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db.query("insert into sessions(id,user_id,token_hash,created_at,expires_at) values ($1,$2,$3,$4,$5)",
    [id, userId, sha256(token), now.toISOString(), expiresAt]);
  return { id, token, userId, expiresAt };
}

/**
 * Returns the session's userId, or null when the token is malformed, unknown, expired, revoked, or names a
 * user without a credential row. The credential join keeps the credential-less `usr_local` out by construction.
 */
export async function resolveSession(db: Db, token: string, now: Date = new Date()): Promise<string | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db.query<{ user_id: string }>(
    `select s.user_id from sessions s join user_credentials c on c.user_id=s.user_id
     where s.token_hash=$1 and s.revoked_at is null and s.expires_at > $2`,
    [sha256(token), now.toISOString()]);
  return row?.user_id ?? null;
}

/** Revokes one session by its token. Returns false when no live session matched. */
export async function revokeSession(db: Db, token: string): Promise<boolean> {
  if (!TOKEN_RE.test(token)) return false;
  const rows = await db.query("update sessions set revoked_at=now() where token_hash=$1 and revoked_at is null returning id", [sha256(token)]);
  return rows.length > 0;
}

/** The hub is bootstrapped once any credential row exists. That row, not a file or a flag, decides. */
export async function isBootstrapped(db: Db): Promise<boolean> {
  const rows = await db.query("select 1 from user_credentials limit 1");
  return rows.length > 0;
}

/**
 * Startup step for a remote hub. Not bootstrapped: writes a fresh one-time token to
 * `<dataDir>/bootstrap-token` (0600) and returns it so the caller can print it. Bootstrapped: removes any
 * leftover file and returns null, so the channel never reopens on restart.
 */
export async function prepareBootstrapToken(db: Db, dataDir: string): Promise<string | null> {
  const file = path.join(dataDir, BOOTSTRAP_TOKEN_FILE);
  await rm(file, { force: true });
  if (await isBootstrapped(db)) return null;
  const token = newToken();
  // `wx` after the removal: the file is created fresh, so the 0600 mode applies.
  await writeFile(file, token, { mode: 0o600, flag: "wx" });
  return token;
}

/** Removes the bootstrap token file. A failure is logged; the credential row already closed the channel. */
export async function removeBootstrapToken(dataDir: string): Promise<void> {
  try {
    await rm(path.join(dataDir, BOOTSTRAP_TOKEN_FILE), { force: true });
  } catch (error) {
    console.error("failed to remove the bootstrap token file", error);
  }
}

/** Constant-time comparison of a presented bootstrap token with the expected one. */
export function bootstrapTokenMatches(expected: string | undefined, presented: string): boolean {
  if (!expected) return false;
  return timingSafeEqual(Buffer.from(sha256(expected), "hex"), Buffer.from(sha256(presented), "hex"));
}

export class BootstrapClosedError extends Error {
  constructor() {
    super("bootstrap already completed");
    this.name = "BootstrapClosedError";
  }
}

/**
 * Creates the first account (users + user_credentials + auth_events.bootstrap_completed) in one transaction.
 * The credentials table is locked first, so concurrent attempts serialize and only the first one succeeds.
 */
export async function completeBootstrap(db: Db, displayName: string, passwordHash: string): Promise<string> {
  return db.tx(async (t) => {
    await t.query("lock table user_credentials in share row exclusive mode");
    if (await isBootstrapped(t)) throw new BootstrapClosedError();
    const userId = `usr_${nanoid(16)}`;
    await t.query("insert into users(id,display_name) values ($1,$2)", [userId, displayName]);
    await t.query("insert into user_credentials(user_id,password_hash) values ($1,$2)", [userId, passwordHash]);
    await t.query("insert into auth_events(id,user_id,kind,actor_user_id) values ($1,$2,'bootstrap_completed',$2)",
      [`aev_${nanoid(16)}`, userId]);
    return userId;
  });
}
