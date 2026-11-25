import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { nanoid } from "nanoid";
import { DAEMON_CREDENTIAL_REVOKED_MESSAGE } from "@nema/shared";
import { isHubAdmin } from "./auth.js";
import type { Db } from "./db/db.js";

const CODE_TTL_MS = 10 * 60_000;
const MAX_ACTIVE_CODES = 5;
const MAX_REGISTRATION_BODY_BYTES = 4096;
const REJECTION_WINDOW_MS = 60_000;
const MAX_UNKNOWN_REJECTIONS = 5_000;
const REVOKED_REJECTION_WINDOW_SECONDS = 60 * 60;
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

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly maxKeys = MAX_UNKNOWN_REJECTIONS,
  ) {}

  get trackedKeys(): number {
    return this.loggedAt.size;
  }

  shouldLog(credentialHash: string): boolean {
    const now = this.now();
    // Entries are in time order. Drop expired hashes as new rejections arrive.
    for (const [key, loggedAt] of this.loggedAt) {
      if (now - loggedAt < REJECTION_WINDOW_MS) break;
      this.loggedAt.delete(key);
    }
    if (this.loggedAt.has(credentialHash)) return false;
    // At capacity a new hash is not audited: evicting the oldest would let every fresh guess write a row,
    // so the window caps total writes at maxKeys per minute, not only repeats of one hash.
    if (this.loggedAt.size >= this.maxKeys) return false;
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
  if (daemon) {
    // Serialize audit writes per daemon and use its audit history so unknown hashes cannot evict this window.
    await db.tx(async (t) => {
      await t.query("select id from daemons where id=$1 for no key update", [daemon.id]);
      const [recent] = await t.query(
        "select 1 from daemon_events where daemon_id=$1 and kind='rejected' and created_at > now() - make_interval(secs => $2) limit 1",
        [daemon.id, REVOKED_REJECTION_WINDOW_SECONDS],
      );
      if (!recent) await daemonEvent(t, daemon, "rejected", null, "revoked_credential");
    });
  } else if (throttle.shouldLog(credentialHash)) {
    await daemonEvent(db, undefined, "rejected", null, "invalid_credential");
  }
  return { ok: false, error: daemon ? DAEMON_CREDENTIAL_REVOKED_MESSAGE : "Invalid daemon credential. Register this daemon first." } as const;
}

export async function markDaemonSeen(db: Db, id: string): Promise<void> {
  await db.query("update daemons set last_seen_at=now() where id=$1", [id]);
}

export function daemonRegistrationRoutes(db: Db): Hono {
  return new Hono().post("/register", async (c) => {
    const tooLarge = () => c.json({ error: "Daemon registration request body is too large." }, 413);
    const length = c.req.header("content-length");
    if (length !== undefined) {
      if (!/^\d+$/.test(length.trim())) return c.json({ error: "Invalid Content-Length." }, 400);
      if (Number(length) > MAX_REGISTRATION_BODY_BYTES) return tooLarge();
    }
    const reader = c.req.raw.body?.getReader();
    let body: { code?: unknown; label?: unknown } | null = null;
    if (reader) {
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_REGISTRATION_BODY_BYTES) {
            void reader.cancel().catch(() => {});
            return tooLarge();
          }
          chunks.push(value);
        }
        body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      } catch {
        return c.json({ error: "Invalid daemon registration request body." }, 400);
      } finally {
        reader.releaseLock();
      }
    }
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
