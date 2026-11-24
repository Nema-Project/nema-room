import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import {
  BOOTSTRAP_TOKEN_FILE,
  SESSION_COOKIE,
  isBootstrapped,
  issueSession,
  prepareBootstrapToken,
  resolveSession,
  revokeSession,
} from "../src/auth.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { LOCAL_USER_ID, localIdentity } from "../src/identity.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

afterEach(cleanupHubDeps);
const HUB = "http://127.0.0.1:4400";
const JSON_HEADERS = { "content-type": "application/json" };

type Hub = { app: ReturnType<typeof createApp>; db: Db; dataDir: string };

async function hubFor(extra: Partial<AppDeps> = {}, base?: { db: Db; dataDir: string }): Promise<Hub> {
  const deps = base ?? (await makeHubDeps());
  const app = createApp({ ...deps, events: new EventBus(), daemonStatus: () => false,
    daemon: { call: async () => { throw new Error("offline"); } }, releaseVersion: "test", ...extra });
  app.get("/api/identity-probe", c => c.json(c.get("identity")));
  return { app, db: deps.db, dataDir: deps.dataDir };
}

/** A remote hub as main.ts would start it: token generated and written before serving. */
async function remoteHub(base?: { db: Db; dataDir: string }): Promise<Hub & { token: string }> {
  const deps = base ?? (await makeHubDeps());
  const token = await prepareBootstrapToken(deps.db, deps.dataDir);
  const hub = await hubFor({ remoteAuth: true, bootstrapToken: token ?? undefined }, deps);
  return { ...hub, token: token ?? "" };
}

function bootstrap(app: Hub["app"], body: unknown) {
  return app.request(`${HUB}/api/auth/bootstrap`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(header);
  if (!match) throw new Error(`no session cookie in ${header}`);
  return match[1]!;
}

function withSession(token: string) {
  return { headers: { cookie: `${SESSION_COOKIE}=${token}` } };
}

test("bootstrap token creates the first account, signs a session, and closes the channel", async () => {
  const { app, db, dataDir, token } = await remoteHub();
  const file = path.join(dataDir, BOOTSTRAP_TOKEN_FILE);
  expect((await readFile(file, "utf8")).trim()).toBe(token);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await isBootstrapped(db)).toBe(false);

  const res = await bootstrap(app, { token, displayName: "  Ada  ", password: "correct horse battery staple" });
  expect(res.status).toBe(201);
  const body = await res.json() as { userId: string; displayName: string };
  expect(body.displayName).toBe("Ada");
  expect(body.userId).toMatch(/^usr_[A-Za-z0-9_-]{16}$/);
  expect(body.userId).not.toBe(LOCAL_USER_ID);
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Lax/i);
  expect(setCookie).toMatch(/Secure/i);
  expect(setCookie).toMatch(/Path=\//i);

  // Rows: user, argon2id credential, audit event. The token file is gone.
  const [cred] = await db.query<{ password_hash: string }>("select password_hash from user_credentials where user_id=$1", [body.userId]);
  expect(cred!.password_hash).toMatch(/^\$argon2id\$/);
  const events = await db.query<{ kind: string; user_id: string; actor_user_id: string }>("select kind,user_id,actor_user_id from auth_events");
  expect(events).toEqual([{ kind: "bootstrap_completed", user_id: body.userId, actor_user_id: body.userId }]);
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await isBootstrapped(db)).toBe(true);

  // The signed session resolves to the new account, never usr_local.
  const probe = await app.request(`${HUB}/api/identity-probe`, withSession(sessionCookie(res)));
  expect(probe.status).toBe(200);
  expect(await probe.json()).toEqual({ userId: body.userId });

  // The channel refuses everything afterwards, including the old token and garbage.
  for (const attempt of [{ token, displayName: "Eve", password: "x" }, {}, { token: "nope" }]) {
    expect((await bootstrap(app, attempt)).status).toBe(410);
  }
  expect((await db.query("select id from users where id <> $1", [LOCAL_USER_ID])).length).toBe(1);
});

test("a restart with a fresh token file does not reopen the channel", async () => {
  const first = await remoteHub();
  expect((await bootstrap(first.app, { token: first.token, displayName: "Ada", password: "pw-1" })).status).toBe(201);

  // main.ts on restart: credentials exist, so no token is generated and a stale file is removed.
  const file = path.join(first.dataDir, BOOTSTRAP_TOKEN_FILE);
  await writeFile(file, "stale", { mode: 0o600 });
  expect(await prepareBootstrapToken(first.db, first.dataDir)).toBeNull();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });

  // Even a hub handed a new token (e.g. an operator wrote one by hand) refuses: credentials decide.
  const forged = "A".repeat(43);
  const restarted = await hubFor({ remoteAuth: true, bootstrapToken: forged }, first);
  expect((await bootstrap(restarted.app, { token: forged, displayName: "Eve", password: "pw-2" })).status).toBe(410);
  expect((await first.db.query("select user_id from user_credentials")).length).toBe(1);
});

test("bootstrap rejects wrong tokens, bad input, and non-JSON without creating anything", async () => {
  const { app, db, token } = await remoteHub();
  expect((await bootstrap(app, { token: "B".repeat(43), displayName: "Eve", password: "pw" })).status).toBe(403);
  expect((await bootstrap(app, { displayName: "Eve", password: "pw" })).status).toBe(400);
  expect((await bootstrap(app, { token, displayName: "   ", password: "pw" })).status).toBe(400);
  expect((await bootstrap(app, { token, displayName: "Eve", password: "" })).status).toBe(400);
  expect((await bootstrap(app, { token, displayName: "x".repeat(65), password: "pw" })).status).toBe(400);
  expect((await bootstrap(app, { token, displayName: "Eve", password: "p".repeat(1025) })).status).toBe(400);
  const form = await app.request(`${HUB}/api/auth/bootstrap`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ token, displayName: "Eve", password: "pw" }) });
  expect(form.status).toBe(415);
  expect(await isBootstrapped(db)).toBe(false);
  expect(await db.query("select id from auth_events")).toEqual([]);

  // A remote hub started without a token (none generated) cannot be bootstrapped over HTTP.
  const tokenless = await hubFor({ remoteAuth: true });
  expect((await bootstrap(tokenless.app, { token, displayName: "Eve", password: "pw" })).status).toBe(403);
});

test("concurrent bootstrap attempts create exactly one account", async () => {
  const { app, db, token } = await remoteHub();
  const results = await Promise.all([1, 2, 3].map(i => bootstrap(app, { token, displayName: `U${i}`, password: `pw-${i}` })));
  expect(results.map(r => r.status).sort()).toEqual([201, 410, 410]);
  expect((await db.query("select user_id from user_credentials")).length).toBe(1);
});

test("missing, forged, expired and revoked sessions get 401 on /api/*", async () => {
  const { app, db, token } = await remoteHub();
  const created = await bootstrap(app, { token, displayName: "Ada", password: "pw" });
  const { userId } = await created.json() as { userId: string };

  const expired = await issueSession(db, userId, { now: new Date(Date.now() - 365 * 24 * 3600 * 1000) });
  const revoked = await issueSession(db, userId);
  expect(await revokeSession(db, revoked.token)).toBe(true);
  expect(await revokeSession(db, revoked.token)).toBe(false);

  const cases: [string, RequestInit][] = [
    ["none", {}],
    ["forged", withSession("C".repeat(43))],
    ["malformed", withSession("not a token")],
    ["expired", withSession(expired.token)],
    ["revoked", withSession(revoked.token)],
  ];
  for (const [label, init] of cases) {
    for (const p of ["/api/workspaces", "/api/identity-probe"]) {
      const res = await app.request(`${HUB}${p}`, init);
      expect(res.status, `${label} ${p}`).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  }
  // Version stays public, as in the local form.
  expect((await app.request(`${HUB}/api/version`)).status).toBe(200);
});

test("a valid session resolves the real userId", async () => {
  const { app, db, token } = await remoteHub();
  const { userId } = await (await bootstrap(app, { token, displayName: "Ada", password: "pw" })).json() as { userId: string };
  const session = await issueSession(db, userId);
  expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  // Only the hash is stored.
  const rows = await db.query<{ token_hash: string }>("select token_hash from sessions where id=$1", [session.id]);
  expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(rows[0]!.token_hash).not.toContain(session.token);
  expect(await resolveSession(db, session.token)).toBe(userId);

  const res = await app.request(`${HUB}/api/identity-probe`, withSession(session.token));
  expect(await res.json()).toEqual({ userId });
  expect((await app.request(`${HUB}/api/workspaces`, withSession(session.token))).status).toBe(200);
});

test("the remote provider never yields usr_local", async () => {
  const { app, db } = await remoteHub();
  // A session row pointing at usr_local (no credential row exists for it) must not authenticate,
  // and identity headers are ignored as in the local form.
  const planted = await issueSession(db, LOCAL_USER_ID);
  expect(await resolveSession(db, planted.token)).toBeNull();
  for (const init of [{}, withSession(planted.token), { headers: { "x-nema-user-id": LOCAL_USER_ID, "x-nema-user": LOCAL_USER_ID } }]) {
    for (const p of ["/api/identity-probe", "/api/workspaces", "/api/auth/unknown"]) {
      const res = await app.request(`${HUB}${p}`, init);
      expect(res.status).toBe(401);
    }
  }
  // Even with a credential row planted for usr_local, the provider refuses it.
  await db.query("insert into user_credentials(user_id,password_hash) values ($1,'x')", [LOCAL_USER_ID]);
  expect((await app.request(`${HUB}/api/identity-probe`, withSession(planted.token))).status).toBe(401);
});

test("remoteAuth off: auth routes are 404 and localIdentity is unchanged", async () => {
  const { app, db, dataDir } = await hubFor();
  const res = await bootstrap(app, { token: "A".repeat(43), displayName: "Eve", password: "pw" });
  expect(res.status).toBe(404);
  expect(res.headers.get("set-cookie")).toBeNull();
  expect((await app.request(`${HUB}/api/auth/bootstrap`)).status).toBe(404);
  const probe = await app.request(`${HUB}/api/identity-probe`, withSession("C".repeat(43)));
  expect(await probe.json()).toEqual({ userId: LOCAL_USER_ID });
  expect((await app.request(`${HUB}/api/workspaces`)).status).toBe(200);
  expect(await localIdentity({} as never)).toEqual({ userId: LOCAL_USER_ID });
  expect(await isBootstrapped(db)).toBe(false);
  await expect(stat(path.join(dataDir, BOOTSTRAP_TOKEN_FILE))).rejects.toMatchObject({ code: "ENOENT" });
});

test("remoteAuth refuses an injected identity provider", async () => {
  await expect(hubFor({ remoteAuth: true, identity: localIdentity })).rejects.toThrow(/remoteAuth/);
});
