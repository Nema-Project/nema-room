import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { isHubAdmin } from "./auth.js";
import type { Db } from "./db/db.js";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_CODES = 5;
const REJECTION_WINDOW_MS = 60_000;
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

type DaemonOwner = { id: string; owner_user_id: string };
type DaemonRow = DaemonOwner & { revoked_at: Date | string | null };
type RevokeResult = "missing" | "forbidden" | { revokedAt: string };
export type RevokeRegisteredDaemon = (id: string, actor: string) => Promise<RevokeResult>;

class RegistrationCodeLimitError extends Error {
  constructor() {
    super("You already have five active daemon registration codes. Use one or wait for it to expire.");
  }
}

export class DaemonRejectionThrottle {
  private readonly loggedAt = new Map<string, number>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  shouldLog(credentialHash: string): boolean {
    const now = this.now();
    // Entries are in time order. Drop expired hashes as new rejections arrive.
    for (const [key, loggedAt] of this.loggedAt) {
      if (now - loggedAt < REJECTION_WINDOW_MS) break;
      this.loggedAt.delete(key);
    }
    if (this.loggedAt.has(credentialHash)) return false;
    this.loggedAt.set(credentialHash, now);
    return true;
  }
}

const daemonRejectionThrottle = new DaemonRejectionThrottle();

async function daemonEvent(
  db: Db, daemon: DaemonOwner | undefined, kind: "registered" | "revoked" | "rejected",
  actor: string | null, reason: "invalid_credential" | "revoked_credential" | null = null,
) {
  await db.query(
    "insert into daemon_events(id,daemon_id,owner_user_id,kind,actor_user_id,detail) values ($1,$2,$3,$4,$5,$6::jsonb)",
    [`dev_${nanoid(16)}`, daemon?.id ?? null, daemon?.owner_user_id ?? null, kind, actor, reason ? JSON.stringify({ reason }) : null],
  );
}

export async function createDaemonRegistrationCode(db: Db, owner: string) {
  const issued = await db.tx(async (t) => {
    // Serialize issuance for this owner without blocking foreign key checks during redemption.
    await t.query("select id from users where id=$1 for no key update", [owner]);
    const now = Date.now();
    const cutoff = new Date(now).toISOString();
    await t.query("delete from daemon_registration_codes where used_at is not null or expires_at <= $1", [cutoff]);
    const active = await t.query(
      "select id from daemon_registration_codes where owner_user_id=$1 and used_at is null and expires_at > $2 limit $3",
      [owner, cutoff, MAX_ACTIVE_CODES],
    );
    if (active.length >= MAX_ACTIVE_CODES) return null;

    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
    await t.query("insert into daemon_registration_codes(id,code_hash,owner_user_id,expires_at) values ($1,$2,$3,$4)",
      [`drc_${nanoid(16)}`, hash(code), owner, expiresAt]);
    return { code, expiresAt };
  });
  if (!issued) throw new RegistrationCodeLimitError();
  return issued;
}

export async function registerDaemon(db: Db, code: string, label: string) {
  return db.tx(async (t) => {
    const [registration] = await t.query<{ id: string; owner_user_id: string; expires_at: Date | string; used_at: Date | string | null }>(
      "select id,owner_user_id,expires_at,used_at from daemon_registration_codes where code_hash=$1 for update",
      [hash(code)],
    );
    // Read the clock after the row lock. A concurrent redemption can have consumed the code while we waited.
    const now = new Date();
    if (!registration || registration.used_at || new Date(registration.expires_at) <= now) return null;
    const id = `dmn_${nanoid(16)}`;
    const credential = `ndc_${randomBytes(32).toString("base64url")}`;
    await t.query("insert into daemons(id,owner_user_id,label,credential_hash) values ($1,$2,$3,$4)",
      [id, registration.owner_user_id, label, hash(credential)]);
    await t.query("update daemon_registration_codes set used_at=$2, used_by_daemon_id=$3 where id=$1",
      [registration.id, now.toISOString(), id]);
    await daemonEvent(t, { id, owner_user_id: registration.owner_user_id }, "registered", registration.owner_user_id);
    return { id, credential };
  });
}

export function listDaemons(db: Db, owner: string) {
  return db.query<{ id: string; label: string; lastSeenAt: Date | string | null; revokedAt: Date | string | null }>(
    'select id,label,last_seen_at as "lastSeenAt",revoked_at as "revokedAt" from daemons where owner_user_id=$1 order by created_at desc,id',
    [owner],
  );
}

export async function revokeDaemon(db: Db, id: string, actor: string): Promise<RevokeResult> {
  return db.tx(async (t) => {
    const [daemon] = await t.query<DaemonRow>("select id,owner_user_id,revoked_at from daemons where id=$1 for update", [id]);
    if (!daemon) return "missing";
    if (daemon.owner_user_id !== actor && !(await isHubAdmin(t, actor))) return "forbidden";
    if (daemon.revoked_at) return { revokedAt: new Date(daemon.revoked_at).toISOString() };
    const revokedAt = new Date().toISOString();
    await t.query("update daemons set revoked_at=$2 where id=$1", [id, revokedAt]);
    await daemonEvent(t, daemon, "revoked", actor);
    return { revokedAt };
  });
}

export async function verifyDaemonCredential(db: Db, credential: string, throttle = daemonRejectionThrottle) {
  const credentialHash = hash(credential);
  const [daemon] = await db.query<DaemonRow>(
    "select id,owner_user_id,revoked_at from daemons where credential_hash=$1", [credentialHash],
  );
  if (daemon && !daemon.revoked_at) return { ok: true, id: daemon.id } as const;
  if (daemon || throttle.shouldLog(credentialHash)) {
    await daemonEvent(db, daemon, "rejected", null, daemon ? "revoked_credential" : "invalid_credential");
  }
  return { ok: false, error: daemon ? "Daemon credential has been revoked. Register this daemon again." : "Invalid daemon credential. Register this daemon first." } as const;
}

export async function markDaemonSeen(db: Db, id: string): Promise<void> {
  await db.query("update daemons set last_seen_at=now() where id=$1", [id]);
}

export function daemonRegistrationRoutes(db: Db): Hono {
  return new Hono().post("/register", async (c) => {
    const body = await c.req.json<{ code?: unknown; label?: unknown } | null>().catch(() => null);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!code || code.length > 128 || !label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) {
      return c.json({ error: "A registration code and a label of up to 120 characters are required." }, 400);
    }
    const registered = await registerDaemon(db, code, label);
    if (!registered) return c.json({ error: "Registration code is invalid, expired, or already used." }, 400);
    c.header("Cache-Control", "no-store");
    return c.json(registered, 201);
  });
}

export function daemonSessionRoutes(db: Db, revoke: RevokeRegisteredDaemon = (id, actor) => revokeDaemon(db, id, actor)): Hono {
  return new Hono()
    .post("/registration-codes", async (c) => {
      c.header("Cache-Control", "no-store");
      try {
        return c.json(await createDaemonRegistrationCode(db, c.get("identity").userId), 201);
      } catch (error) {
        if (error instanceof RegistrationCodeLimitError) return c.json({ error: error.message }, 429);
        throw error;
      }
    })
    .get("/", async (c) => c.json(await listDaemons(db, c.get("identity").userId)))
    .post("/:id/revoke", async (c) => {
      const result = await revoke(c.req.param("id"), c.get("identity").userId);
      if (result === "missing") return c.json({ error: "Daemon not found." }, 404);
      if (result === "forbidden") return c.json({ error: "Only the daemon owner or hub administrator can revoke it." }, 403);
      return c.json(result);
    });
}
