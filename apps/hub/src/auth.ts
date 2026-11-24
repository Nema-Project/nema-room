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

async function insertSession(db: Db, userId: string, now: Date): Promise<IssuedSession> {
  const token = newToken();
  const id = `ses_${nanoid(16)}`;
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await db.query("insert into sessions(id,user_id,token_hash,created_at,expires_at) values ($1,$2,$3,$4,$5)",
    [id, userId, sha256(token), now.toISOString(), expiresAt]);
  return { id, token, userId, expiresAt };
}

/** Creates a session row and returns the plaintext token. The token is never stored or logged. */
export async function issueSession(db: Db, userId: string, opts: { now?: Date } = {}): Promise<IssuedSession> {
  return insertSession(db, userId, opts.now ?? new Date());
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
 * `<dataDir>/bootstrap-token` (0600) and returns it for the app deps; the caller reports only the file
 * path, never the token itself (secrets stay out of logs). Bootstrapped: removes any
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
 * Creates the first account (users + user_credentials + auth_events.bootstrap_completed) and its first
 * session in one transaction, so a failure anywhere — including the session insert — commits nothing and
 * the bootstrap stays retryable. The credentials table is locked first, so concurrent attempts serialize
 * and only the first one succeeds.
 */
export async function completeBootstrap(db: Db, displayName: string, passwordHash: string): Promise<{ userId: string; session: IssuedSession }> {
  return db.tx(async (t) => {
    await t.query("lock table user_credentials in share row exclusive mode");
    if (await isBootstrapped(t)) throw new BootstrapClosedError();
    const userId = `usr_${nanoid(16)}`;
    await t.query("insert into users(id,display_name) values ($1,$2)", [userId, displayName]);
    await t.query("insert into user_credentials(user_id,password_hash) values ($1,$2)", [userId, passwordHash]);
    await t.query("insert into auth_events(id,user_id,kind,actor_user_id) values ($1,$2,'bootstrap_completed',$2)",
      [`aev_${nanoid(16)}`, userId]);
    const session = await insertSession(t, userId, new Date());
    return { userId, session };
  });
}

// ---------------------------------------------------------------------------------------------------------
// Task 5: invites, login, session management and credential reset.
// ---------------------------------------------------------------------------------------------------------

/** An invite is valid for 7 days from issue. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A credential reset code is valid for 24 hours from issue. */
export const CREDENTIAL_RESET_TTL_MS = 24 * 60 * 60 * 1000;

/** A policy refusal with the HTTP status the route returns. Messages never say whether an account exists. */
export class AuthError extends Error {
  constructor(public status: 403 | 404, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

async function authEvent(db: Db, kind: string, userId: string | null, actorUserId: string | null, detail: unknown = null): Promise<void> {
  await db.query("insert into auth_events(id,user_id,kind,actor_user_id,detail) values ($1,$2,$3,$4,$5::jsonb)",
    [`aev_${nanoid(16)}`, userId, kind, actorUserId, JSON.stringify(detail)]);
}

/**
 * The hub administrator is the account that completed the bootstrap (spec: the bootstrap creates "the
 * first administrator account"). auth_events travels in snapshots, so the role survives export/import.
 * Phase one has no transfer and no second administrator.
 */
export async function isHubAdmin(db: Db, userId: string): Promise<boolean> {
  const rows = await db.query("select 1 from auth_events where kind='bootstrap_completed' and user_id=$1 limit 1", [userId]);
  return rows.length > 0;
}

export type CreatedInvite = { id: string; code: string; intendedWorkspaceId: string | null; expiresAt: string };

/**
 * Who may invite: an invite that names a workspace needs the actor to be an active owner of it (the same
 * check addMember applies when the owner later confirms the account); an invite without a workspace needs
 * the hub administrator. The plaintext code is returned here once; only its sha256 is stored.
 */
export async function createInvite(db: Db, actorUserId: string, opts: { workspaceId?: string | null; now?: Date } = {}): Promise<CreatedInvite> {
  const workspaceId = opts.workspaceId ?? null;
  if (workspaceId !== null) {
    const [row] = await db.query<{ role: string }>(
      "select role from workspace_members where workspace_id=$1 and user_id=$2 and removed_at is null", [workspaceId, actorUserId]);
    if (row?.role !== "owner") throw new AuthError(403, "only an owner of the workspace may invite into it");
  } else if (!(await isHubAdmin(db, actorUserId))) {
    throw new AuthError(403, "only the hub administrator may issue an invite without a workspace");
  }
  const now = opts.now ?? new Date();
  const code = newToken();
  const id = `inv_${nanoid(16)}`;
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  return db.tx(async (t) => {
    await t.query("insert into invites(id,code_hash,created_by,intended_workspace_id,expires_at,created_at) values ($1,$2,$3,$4,$5,$6)",
      [id, sha256(code), actorUserId, workspaceId, expiresAt, now.toISOString()]);
    await authEvent(t, "invite_created", null, actorUserId, { inviteId: id, intendedWorkspaceId: workspaceId });
    return { id, code, intendedWorkspaceId: workspaceId, expiresAt };
  });
}

export type InviteStatus = {
  id: string;
  createdBy: string;
  intendedWorkspaceId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByUserId: string | null;
  usedByDisplayName: string | null;
  status: "pending" | "used" | "expired";
};

const iso = (v: Date | string) => new Date(v).toISOString();

/**
 * Invites the actor issued, plus invites into workspaces the actor actively owns, so an owner can confirm
 * the new account with addMember. Codes and hashes are never returned.
 */
export async function listInvites(db: Db, actorUserId: string, now: Date = new Date()): Promise<InviteStatus[]> {
  const rows = await db.query<{
    id: string; created_by: string; intended_workspace_id: string | null; created_at: Date | string; expires_at: Date | string;
    used_at: Date | string | null; used_by_user_id: string | null; display_name: string | null;
  }>(
    `select i.id,i.created_by,i.intended_workspace_id,i.created_at,i.expires_at,i.used_at,i.used_by_user_id,u.display_name
     from invites i left join users u on u.id=i.used_by_user_id
     where i.created_by=$1 or i.intended_workspace_id in (
       select workspace_id from workspace_members where user_id=$1 and role='owner' and removed_at is null)
     order by i.created_at desc, i.id desc`, [actorUserId]);
  return rows.map((r) => ({
    id: r.id,
    createdBy: r.created_by,
    intendedWorkspaceId: r.intended_workspace_id,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    usedAt: r.used_at ? iso(r.used_at) : null,
    usedByUserId: r.used_by_user_id,
    usedByDisplayName: r.used_by_user_id ? r.display_name : null,
    status: r.used_at ? "used" : new Date(r.expires_at).getTime() <= now.getTime() ? "expired" : "pending",
  }));
}

/** An unknown, expired or already used invite: one message for all three, so codes cannot be probed. */
export const INVALID_INVITE = "invalid invite";

/**
 * Creates an account from an invite: users + user_credentials, the invite marked used, invite_used and
 * account_created recorded, and a first session — in one transaction. The conditional update on the
 * invite is the single test of "unused and unexpired", so concurrent uses of one code create exactly one
 * account. No membership is granted here; an owner adds the account with addMember (member_events).
 */
export async function acceptInvite(db: Db, code: string, displayName: string, passwordHash: string, now: Date = new Date()): Promise<{ userId: string; session: IssuedSession; intendedWorkspaceId: string | null }> {
  if (!TOKEN_RE.test(code)) throw new AuthError(403, INVALID_INVITE);
  return db.tx(async (t) => {
    const userId = `usr_${nanoid(16)}`;
    // The user row comes first because invites.used_by_user_id references it; a refused invite rolls it back.
    await t.query("insert into users(id,display_name) values ($1,$2)", [userId, displayName]);
    const [invite] = await t.query<{ id: string; created_by: string; intended_workspace_id: string | null }>(
      `update invites set used_at=$3, used_by_user_id=$2
       where code_hash=$1 and used_at is null and expires_at > $3
       returning id, created_by, intended_workspace_id`, [sha256(code), userId, now.toISOString()]);
    if (!invite) throw new AuthError(403, INVALID_INVITE);
    await t.query("insert into user_credentials(user_id,password_hash) values ($1,$2)", [userId, passwordHash]);
    await authEvent(t, "invite_used", userId, invite.created_by, { inviteId: invite.id });
    await authEvent(t, "account_created", userId, invite.created_by, { inviteId: invite.id, intendedWorkspaceId: invite.intended_workspace_id });
    const session = await insertSession(t, userId, now);
    return { userId, session, intendedWorkspaceId: invite.intended_workspace_id };
  });
}

/** Task 6: a login lock was just triggered. `userId` is null unless the locked account exists. */
export async function recordLoginLocked(db: Db, userId: string | null, detail: { scope: "account" | "source"; source?: string }): Promise<void> {
  await authEvent(db, "login_locked", userId, null, detail);
}

/**
 * Locks one account's credential row for the rest of the transaction. Login issuance, reset issuance and
 * reset redemption all take this lock first, so they serialize per account in one order.
 */
async function lockCredential(db: Db, userId: string): Promise<string | null> {
  const [row] = await db.query<{ password_hash: string }>("select password_hash from user_credentials where user_id=$1 for update", [userId]);
  return row?.password_hash ?? null;
}

/**
 * Login's last step: signs a session only if the credential still holds the hash the password was verified
 * against. The check and the insert share one transaction under the credential row lock, which reset
 * redemption also takes, so a reset that commits between verification and issue makes this return null
 * instead of signing a session with the replaced password.
 */
export async function issueSessionIfCredentialUnchanged(db: Db, userId: string, verifiedHash: string, now: Date = new Date()): Promise<IssuedSession | null> {
  return db.tx(async (t) => {
    if ((await lockCredential(t, userId)) !== verifiedHash) return null;
    return insertSession(t, userId, now);
  });
}

/** The stored password hash of a login account, or null. `usr_local` has no credential row, so it is null. */
export async function passwordHashFor(db: Db, account: string): Promise<string | null> {
  const [row] = await db.query<{ password_hash: string }>("select password_hash from user_credentials where user_id=$1", [account]);
  return row?.password_hash ?? null;
}

async function revokeAll(db: Db, userId: string): Promise<number> {
  const rows = await db.query("update sessions set revoked_at=now() where user_id=$1 and revoked_at is null returning id", [userId]);
  return rows.length;
}

async function requireAdminOver(db: Db, actorUserId: string, targetUserId: string): Promise<void> {
  if (!(await isHubAdmin(db, actorUserId))) throw new AuthError(403, "only the hub administrator may do this");
  if (!(await passwordHashFor(db, targetUserId))) throw new AuthError(404, "account not found");
}

/** Administrator action: revokes every live session of one account and records sessions_revoked. */
export async function revokeUserSessions(db: Db, actorUserId: string, targetUserId: string): Promise<number> {
  await requireAdminOver(db, actorUserId, targetUserId);
  return db.tx(async (t) => {
    const count = await revokeAll(t, targetUserId);
    await authEvent(t, "sessions_revoked", targetUserId, actorUserId, { reason: "admin", count });
    return count;
  });
}

export type CreatedCredentialReset = { id: string; code: string; userId: string; expiresAt: string };

/**
 * Administrator action (there is no self-service recovery): revokes all of the account's sessions and
 * issues a one-time reset code, hashed and expiring like an invite code. Earlier unused codes for the
 * account are expired so only the newest works. The old password keeps working until a code is redeemed.
 */
export async function createCredentialReset(db: Db, actorUserId: string, targetUserId: string, now: Date = new Date()): Promise<CreatedCredentialReset> {
  await requireAdminOver(db, actorUserId, targetUserId);
  const code = newToken();
  const id = `crs_${nanoid(16)}`;
  const expiresAt = new Date(now.getTime() + CREDENTIAL_RESET_TTL_MS).toISOString();
  return db.tx(async (t) => {
    // Serializes issuance per account (and with redemption and login), so of two concurrent issues the later
    // one expires the earlier code instead of both committing a usable code.
    await lockCredential(t, targetUserId);
    await t.query("update credential_resets set expires_at=$2 where user_id=$1 and used_at is null and expires_at > $2", [targetUserId, now.toISOString()]);
    await t.query("insert into credential_resets(id,user_id,code_hash,created_by,expires_at,created_at) values ($1,$2,$3,$4,$5,$6)",
      [id, targetUserId, sha256(code), actorUserId, expiresAt, now.toISOString()]);
    const count = await revokeAll(t, targetUserId);
    await authEvent(t, "sessions_revoked", targetUserId, actorUserId, { reason: "credential_reset", resetId: id, count });
    return { id, code, userId: targetUserId, expiresAt };
  });
}

/** An unknown, expired or already used reset code: one message for all three. */
export const INVALID_RESET = "invalid reset code";

/**
 * Redeems a reset code: stores the new password hash and revokes every session again (including any signed
 * with the old password after the reset was issued). Creates no account and signs no session; the person
 * then signs in with the new password. A login that commits first has its session revoked here; a login
 * that commits after this sees the new hash and is refused.
 */
export async function acceptCredentialReset(db: Db, code: string, passwordHash: string, now: Date = new Date()): Promise<{ userId: string }> {
  if (!TOKEN_RE.test(code)) throw new AuthError(403, INVALID_RESET);
  return db.tx(async (t) => {
    // The credential row is locked before the reset row is written, the same order issuance and login use,
    // so redemption cannot interleave with a login that already checked the old password (see
    // issueSessionIfCredentialUnchanged) and cannot deadlock against a concurrent issuance.
    const [target] = await t.query<{ user_id: string }>("select user_id from credential_resets where code_hash=$1", [sha256(code)]);
    if (!target) throw new AuthError(403, INVALID_RESET);
    await lockCredential(t, target.user_id);
    const [reset] = await t.query<{ id: string; user_id: string }>(
      "update credential_resets set used_at=$2 where code_hash=$1 and used_at is null and expires_at > $2 returning id, user_id",
      [sha256(code), now.toISOString()]);
    if (!reset) throw new AuthError(403, INVALID_RESET);
    await t.query("update user_credentials set password_hash=$2, updated_at=$3 where user_id=$1", [reset.user_id, passwordHash, now.toISOString()]);
    const count = await revokeAll(t, reset.user_id);
    await authEvent(t, "sessions_revoked", reset.user_id, reset.user_id, { reason: "credential_reset_completed", resetId: reset.id, count });
    return { userId: reset.user_id };
  });
}
