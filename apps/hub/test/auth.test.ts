import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createApp, type AppDeps } from "../src/app.js";
import {
  BOOTSTRAP_TOKEN_FILE,
  CREDENTIAL_RESET_TTL_MS,
  INVALID_RESET,
  SESSION_COOKIE,
  acceptCredentialReset,
  completeBootstrap,
  createCredentialReset,
  isBootstrapped,
  issueSession,
  prepareBootstrapToken,
  resolveSession,
  revokeSession,
} from "../src/auth.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { authRoutes } from "../src/authRoutes.js";
import { LOCAL_USER_ID, localIdentity } from "../src/identity.js";
import { LOGIN_THROTTLE, LoginThrottle } from "../src/loginThrottle.js";
import { hashPassword, verifyPassword } from "../src/passwords.js";
import { createWorkspace } from "../src/workspaces.js";
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
async function remoteHub(base?: { db: Db; dataDir: string }, extra: Partial<AppDeps> = {}): Promise<Hub & { token: string }> {
  const deps = base ?? (await makeHubDeps());
  const token = await prepareBootstrapToken(deps.db, deps.dataDir);
  const hub = await hubFor({ remoteAuth: true, bootstrapToken: token ?? undefined, ...extra }, deps);
  return { ...hub, token: token ?? "" };
}

function bootstrap(app: Hub["app"], body: unknown) {
  return app.request(`${HUB}/api/auth/bootstrap`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
}

test("a failed first-session insert rolls the bootstrap back, and a retry succeeds", async () => {
  // Regression: account creation and the first session share one transaction. If the session
  // insert fails after the credential rows were written, nothing may commit — otherwise the
  // spent bootstrap would leave the hub with an account nobody can sign in to and a channel
  // that answers 410 forever.
  const { db } = await makeHubDeps();
  let failOnce = true;
  const flaky = {
    ...db,
    tx: <T,>(fn: (t: Db) => Promise<T>): Promise<T> => db.tx(async (t) => {
      const wrapped: Db = {
        ...t,
        query: (async (sql: string, params?: unknown[]) => {
          if (failOnce && /insert into sessions/.test(sql)) {
            failOnce = false;
            throw new Error("injected session insert failure");
          }
          return t.query(sql, params);
        }) as Db["query"],
      };
      return fn(wrapped);
    }),
  } as Db;
  await expect(completeBootstrap(flaky, "Admin", "hash")).rejects.toThrow(/injected session insert failure/);
  expect(await isBootstrapped(db)).toBe(false);
  const { userId, session } = await completeBootstrap(db, "Admin", "hash");
  expect(await isBootstrapped(db)).toBe(true);
  expect(await resolveSession(db, session.token)).toBe(userId);
});

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

// ---------------------------------------------------------------------------------------------------------
// Task 5: invites, login/logout, session management, credential reset (spec acceptance ④⑤).
// ---------------------------------------------------------------------------------------------------------

function post(app: Hub["app"], p: string, body: unknown, token?: string) {
  return app.request(`${HUB}${p}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function get(app: Hub["app"], p: string, token?: string) {
  return app.request(`${HUB}${p}`, token ? withSession(token) : {});
}

/** A bootstrapped remote hub: the administrator's id and session token. */
async function adminHub(extra: Partial<AppDeps> = {}): Promise<Hub & { token: string; adminId: string; adminToken: string }> {
  const hub = await remoteHub(undefined, extra);
  const res = await bootstrap(hub.app, { token: hub.token, displayName: "Admin", password: "admin-pw" });
  const { userId } = await res.json() as { userId: string };
  return { ...hub, adminId: userId, adminToken: sessionCookie(res) };
}

type Invite = { id: string; code: string; intendedWorkspaceId: string | null; expiresAt: string };

async function invite(app: Hub["app"], token: string, workspaceId?: string): Promise<Invite> {
  const res = await post(app, "/api/auth/invites", workspaceId ? { workspaceId } : {}, token);
  expect(res.status).toBe(201);
  return await res.json() as Invite;
}

async function signUp(app: Hub["app"], code: string, displayName: string, password: string): Promise<{ userId: string; token: string }> {
  const res = await post(app, "/api/auth/invites/accept", { code, displayName, password });
  expect(res.status).toBe(201);
  const { userId } = await res.json() as { userId: string };
  return { userId, token: sessionCookie(res) };
}

function login(app: Hub["app"], account: string, password: string) {
  return post(app, "/api/auth/login", { account, password });
}

test("invite flow: owner invites into a workspace, the invitee signs up, the owner adds them with addMember", async () => {
  const { app, db, dataDir, adminId, adminToken } = await adminHub();
  const ws = (await createWorkspace(db, dataDir, "Team", undefined, adminId)).id;

  const issued = await invite(app, adminToken, ws);
  expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(issued.intendedWorkspaceId).toBe(ws);
  // Only the hash is stored.
  const [row] = await db.query<{ code_hash: string }>("select code_hash from invites where id=$1", [issued.id]);
  expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row!.code_hash).not.toContain(issued.code);

  const created = await post(app, "/api/auth/invites/accept", { code: issued.code, displayName: " Bob ", password: "bob-pw" });
  expect(created.status).toBe(201);
  const bob = await created.json() as { userId: string; displayName: string; intendedWorkspaceId: string };
  expect(bob).toMatchObject({ displayName: "Bob", intendedWorkspaceId: ws });
  const setCookie = created.headers.get("set-cookie") ?? "";
  for (const attr of [/HttpOnly/i, /SameSite=Lax/i, /Secure/i, /Path=\//i]) expect(setCookie).toMatch(attr);
  const bobToken = sessionCookie(created);
  expect(await (await get(app, "/api/identity-probe", bobToken)).json()).toEqual({ userId: bob.userId });

  // Signing up grants no membership; the invite status shows who used it and for which workspace.
  expect((await db.query("select 1 from workspace_members where user_id=$1", [bob.userId])).length).toBe(0);
  const listed = await (await get(app, "/api/auth/invites", adminToken)).json() as { invites: Record<string, unknown>[] };
  expect(listed.invites).toEqual([expect.objectContaining({
    id: issued.id, createdBy: adminId, intendedWorkspaceId: ws, status: "used", usedByUserId: bob.userId, usedByDisplayName: "Bob",
  })]);
  expect(JSON.stringify(listed)).not.toContain(issued.code);
  expect(JSON.stringify(listed)).not.toContain(row!.code_hash);

  // The owner confirms with the existing roster endpoint (addMember + member_events), no back door.
  const added = await post(app, `/api/workspaces/${ws}/members`, { userId: bob.userId, role: "member" }, adminToken);
  expect(added.status).toBe(200);
  expect(await db.query("select kind,user_id,actor_user_id from member_events where workspace_id=$1 and user_id=$2", [ws, bob.userId]))
    .toEqual([{ kind: "added", user_id: bob.userId, actor_user_id: adminId }]);

  const events = await db.query<{ kind: string; user_id: string | null; actor_user_id: string }>(
    "select kind,user_id,actor_user_id from auth_events where kind in ('invite_created','invite_used','account_created') order by kind");
  expect(events).toEqual([
    { kind: "account_created", user_id: bob.userId, actor_user_id: adminId },
    { kind: "invite_created", user_id: null, actor_user_id: adminId },
    { kind: "invite_used", user_id: bob.userId, actor_user_id: adminId },
  ]);
  expect(JSON.stringify(await db.query("select detail from auth_events"))).not.toContain(issued.code);
});

test("expired, reused and unknown invites are refused the same way and create nothing", async () => {
  const { app, db, adminToken } = await adminHub();
  const used = await invite(app, adminToken);
  await signUp(app, used.code, "Bob", "bob-pw");
  const expired = await invite(app, adminToken);
  await db.query("update invites set expires_at=now() - interval '1 second' where id=$1", [expired.id]);
  const users = (await db.query("select id from users")).length;

  const bodies: string[] = [];
  for (const code of [used.code, expired.code, "D".repeat(43), "short"]) {
    const res = await post(app, "/api/auth/invites/accept", { code, displayName: "Eve", password: "eve-pw" });
    expect(res.status, code).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    bodies.push(JSON.stringify(await res.json()));
  }
  expect(new Set(bodies)).toEqual(new Set([JSON.stringify({ error: "invalid invite" })]));
  expect((await db.query("select id from users")).length).toBe(users);
  expect((await post(app, "/api/auth/invites/accept", { code: used.code, displayName: "", password: "x" })).status).toBe(400);
});

test("concurrent uses of one invite create exactly one account", async () => {
  const { app, db, adminToken } = await adminHub();
  const { code } = await invite(app, adminToken);
  const results = await Promise.all([1, 2, 3].map((i) => post(app, "/api/auth/invites/accept", { code, displayName: `U${i}`, password: `pw-${i}` })));
  expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
  expect((await db.query("select user_id from user_credentials")).length).toBe(2);
});

test("invite permissions: workspace invites need its owner, workspace-less invites need the administrator", async () => {
  const { app, db, dataDir, adminId, adminToken } = await adminHub();
  const adminWs = (await createWorkspace(db, dataDir, "Admin's", undefined, adminId)).id;
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "bob-pw");
  const bobWs = (await createWorkspace(db, dataDir, "Bob's", undefined, bob.userId)).id;

  // Bob owns bobWs: he may invite into it, but not into adminWs, not into a missing workspace, and not without one.
  const bobInvite = await invite(app, bob.token, bobWs);
  for (const body of [{ workspaceId: adminWs }, { workspaceId: "ws_missing" }, {}, { workspaceId: null }]) {
    const res = await post(app, "/api/auth/invites", body, bob.token);
    expect(res.status, JSON.stringify(body)).toBe(403);
  }
  // A plain member of adminWs is not an owner either.
  expect((await post(app, `/api/workspaces/${adminWs}/members`, { userId: bob.userId, role: "member" }, adminToken)).status).toBe(200);
  expect((await post(app, "/api/auth/invites", { workspaceId: adminWs }, bob.token)).status).toBe(403);
  // The administrator is not an owner of bobWs, so cannot invite into it either.
  expect((await post(app, "/api/auth/invites", { workspaceId: bobWs }, adminToken)).status).toBe(403);
  expect((await post(app, "/api/auth/invites", { extra: 1 }, adminToken)).status).toBe(400);

  // Status: creators see their own; the target workspace's owners see invites into it; nobody else does.
  const carol = await signUp(app, (await invite(app, adminToken)).code, "Carol", "carol-pw");
  const ids = async (token: string) => ((await (await get(app, "/api/auth/invites", token)).json()) as { invites: { id: string }[] }).invites.map((i) => i.id);
  expect(await ids(bob.token)).toEqual([bobInvite.id]);
  expect(await ids(carol.token)).toEqual([]);
  expect((await post(app, `/api/workspaces/${bobWs}/members`, { userId: carol.userId, role: "owner" }, bob.token)).status).toBe(200);
  expect(await ids(carol.token)).toEqual([bobInvite.id]);
  expect(await ids(adminToken)).not.toContain(bobInvite.id);

  // All of it needs a session.
  expect((await post(app, "/api/auth/invites", {})).status).toBe(401);
  expect((await get(app, "/api/auth/invites")).status).toBe(401);
});

test("login signs a session with the bootstrap cookie attributes; a wrong password gets 401 and no session", async () => {
  const { app, db, adminId } = await adminHub();
  const before = (await db.query("select id from sessions")).length;

  const wrong = await login(app, adminId, "not-the-password");
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toEqual({ error: "invalid credentials" });
  expect(wrong.headers.get("set-cookie")).toBeNull();
  // An unknown account looks exactly like a wrong password.
  const unknown = await login(app, "usr_nobodyhere", "admin-pw");
  expect(unknown.status).toBe(401);
  expect(await unknown.json()).toEqual({ error: "invalid credentials" });
  expect((await db.query("select id from sessions")).length).toBe(before);

  const ok = await login(app, adminId, "admin-pw");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ userId: adminId });
  const cookie = ok.headers.get("set-cookie") ?? "";
  for (const attr of [/HttpOnly/i, /SameSite=Lax/i, /Secure/i, /Path=\//i, /Max-Age=1209600/i]) expect(cookie).toMatch(attr);
  expect(await (await get(app, "/api/identity-probe", sessionCookie(ok))).json()).toEqual({ userId: adminId });

  expect((await post(app, "/api/auth/login", { account: adminId })).status).toBe(400);
  expect((await post(app, "/api/auth/login", { account: adminId, password: "p".repeat(1025) })).status).toBe(400);
});

test("usr_local has no credential row and cannot log in", async () => {
  const { app, db } = await adminHub();
  expect(await db.query("select 1 from user_credentials where user_id=$1", [LOCAL_USER_ID])).toEqual([]);
  for (const password of ["x", "admin-pw", "usr_local"]) {
    const res = await login(app, LOCAL_USER_ID, password);
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  }
  expect(await db.query("select 1 from sessions where user_id=$1", [LOCAL_USER_ID])).toEqual([]);
});

test("logout revokes only the current session; the old cookie then gets 401", async () => {
  const { app, adminId, adminToken } = await adminHub();
  const other = sessionCookie(await login(app, adminId, "admin-pw"));
  const out = await post(app, "/api/auth/logout", {}, adminToken);
  expect(out.status).toBe(200);
  expect(out.headers.get("set-cookie")).toMatch(new RegExp(`${SESSION_COOKIE}=;.*Max-Age=0`, "i"));
  expect((await get(app, "/api/identity-probe", adminToken)).status).toBe(401);
  expect((await post(app, "/api/auth/logout", {}, adminToken)).status).toBe(401);
  expect((await get(app, "/api/identity-probe", other)).status).toBe(200);
});

test("the administrator revokes all of one account's sessions; others are untouched", async () => {
  const { app, db, adminId, adminToken } = await adminHub();
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "bob-pw");
  const carol = await signUp(app, (await invite(app, adminToken)).code, "Carol", "carol-pw");
  const bob2 = sessionCookie(await login(app, bob.userId, "bob-pw"));

  // Only the administrator may do it, and only to an account with credentials.
  expect((await post(app, `/api/auth/users/${carol.userId}/revoke-sessions`, {}, bob.token)).status).toBe(403);
  expect((await get(app, "/api/identity-probe", carol.token)).status).toBe(200);
  expect((await post(app, "/api/auth/users/usr_missing/revoke-sessions", {}, adminToken)).status).toBe(404);
  expect((await post(app, `/api/auth/users/${LOCAL_USER_ID}/revoke-sessions`, {}, adminToken)).status).toBe(404);

  const res = await post(app, `/api/auth/users/${bob.userId}/revoke-sessions`, {}, adminToken);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ revoked: 2 });
  for (const t of [bob.token, bob2]) expect((await get(app, "/api/identity-probe", t)).status).toBe(401);
  expect((await get(app, "/api/identity-probe", carol.token)).status).toBe(200);
  expect((await get(app, "/api/identity-probe", adminToken)).status).toBe(200);
  // Revoking sessions does not remove the account: Bob signs in again.
  expect((await login(app, bob.userId, "bob-pw")).status).toBe(200);
  expect(await db.query("select user_id,actor_user_id,detail from auth_events where kind='sessions_revoked'"))
    .toEqual([{ user_id: bob.userId, actor_user_id: adminId, detail: { reason: "admin", count: 2 } }]);
});

test("credential reset: sessions die, the code sets a new password once, the old password stops working", async () => {
  const { app, db, adminId, adminToken } = await adminHub();
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "old-pw");
  const carol = await signUp(app, (await invite(app, adminToken)).code, "Carol", "carol-pw");

  expect((await post(app, `/api/auth/users/${carol.userId}/credential-reset`, {}, bob.token)).status).toBe(403);
  expect((await post(app, `/api/auth/users/${LOCAL_USER_ID}/credential-reset`, {}, adminToken)).status).toBe(404);

  const first = await post(app, `/api/auth/users/${bob.userId}/credential-reset`, {}, adminToken);
  expect(first.status).toBe(201);
  const stale = await first.json() as { code: string };
  // A newer code supersedes the older one.
  const issued = await (await post(app, `/api/auth/users/${bob.userId}/credential-reset`, {}, adminToken)).json() as { id: string; code: string; userId: string };
  expect(issued.userId).toBe(bob.userId);
  expect(issued.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const [row] = await db.query<{ code_hash: string }>("select code_hash from credential_resets where id=$1", [issued.id]);
  expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row!.code_hash).not.toContain(issued.code);

  // Issuing the reset already killed Bob's sessions; Carol's are untouched.
  expect((await get(app, "/api/identity-probe", bob.token)).status).toBe(401);
  expect((await get(app, "/api/identity-probe", carol.token)).status).toBe(200);
  // Until redeemed the old password still signs in; redemption kills that session too.
  const interim = sessionCookie(await login(app, bob.userId, "old-pw"));

  expect((await post(app, "/api/auth/credential-reset/accept", { code: stale.code, password: "new-pw" })).status).toBe(403);
  const accepted = await post(app, "/api/auth/credential-reset/accept", { code: issued.code, password: "new-pw" });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ userId: bob.userId });
  expect(accepted.headers.get("set-cookie")).toBeNull();
  expect((await db.query("select id from users")).length).toBe(4); // usr_local, admin, Bob, Carol: no account created

  expect((await get(app, "/api/identity-probe", interim)).status).toBe(401);
  expect((await login(app, bob.userId, "old-pw")).status).toBe(401);
  expect((await login(app, bob.userId, "new-pw")).status).toBe(200);
  expect((await get(app, "/api/identity-probe", carol.token)).status).toBe(200);

  // One-time: the used code, an unknown code and an expired code get the same refusal.
  const again = await (await post(app, `/api/auth/users/${carol.userId}/credential-reset`, {}, adminToken)).json() as { id: string; code: string };
  await db.query("update credential_resets set expires_at=now() - interval '1 second' where id=$1", [again.id]);
  for (const code of [issued.code, "E".repeat(43), again.code]) {
    const res = await post(app, "/api/auth/credential-reset/accept", { code, password: "x" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invalid reset code" });
  }
  expect((await login(app, carol.userId, "carol-pw")).status).toBe(200);

  const revoked = await db.query<{ actor_user_id: string; detail: { reason: string } }>(
    "select actor_user_id,detail from auth_events where kind='sessions_revoked' and user_id=$1", [bob.userId]);
  expect(revoked.map((r) => `${r.actor_user_id}:${r.detail.reason}`).sort()).toEqual([
    `${adminId}:credential_reset`, `${adminId}:credential_reset`, `${bob.userId}:credential_reset_completed`,
  ].sort());
});

test("login lockout (task 6): a locked account refuses even the right password; others and unknown names behave alike", async () => {
  // A frozen clock keeps Retry-After exact: no time passes between the locking failure and the refusal.
  const frozen = Date.now();
  const { app, db, adminId, adminToken } = await adminHub({ loginThrottle: new LoginThrottle(() => frozen) });
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "bob-pw");

  for (let i = 1; i <= 5; i++) {
    const res = await login(app, adminId, `wrong-${i}`);
    expect(res.status, `attempt ${i}`).toBe(401);
  }
  const locked = await login(app, adminId, "admin-pw");
  expect(locked.status).toBe(429);
  expect(await locked.json()).toEqual({ error: "too many failed attempts; try again later" });
  expect(locked.headers.get("retry-after")).toBe("900");
  expect(locked.headers.get("set-cookie")).toBeNull();
  // Existing sessions are not touched by a lock, and Bob's account is unaffected.
  expect((await get(app, "/api/identity-probe", adminToken)).status).toBe(200);
  expect((await login(app, bob.userId, "bob-pw")).status).toBe(200);

  // An unknown account locks the same way, so the 429 reveals nothing about existence.
  for (let i = 0; i < 5; i++) await login(app, "usr_doesnotexist", "x");
  const ghost = await login(app, "usr_doesnotexist", "x");
  expect(ghost.status).toBe(429);
  expect(await ghost.json()).toEqual({ error: "too many failed attempts; try again later" });

  // Events: the real account is named; the guessed one is not stored.
  expect(await db.query("select user_id,actor_user_id,detail from auth_events where kind='login_locked' order by created_at,id"))
    .toEqual([
      { user_id: adminId, actor_user_id: null, detail: { scope: "account" } },
      { user_id: null, actor_user_id: null, detail: { scope: "account" } },
    ]);

  // A source that sprays 20 failures is locked for every account, including a correct password; another source is not.
  const from = (addr: string) => ({ incoming: { socket: { remoteAddress: addr } } });
  const attempt = (account: string, password: string, addr: string) =>
    app.request(`${HUB}/api/auth/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ account, password }) }, from(addr));
  for (let i = 0; i < 20; i++) expect((await attempt(`usr_spray${i}`, "x", "10.9.9.9")).status).toBe(401);
  expect((await attempt(bob.userId, "bob-pw", "10.9.9.9")).status).toBe(429);
  expect((await attempt(bob.userId, "bob-pw", "10.1.1.1")).status).toBe(200);
  expect(await db.query("select detail from auth_events where kind='login_locked' and detail->>'scope'='source'"))
    .toEqual([{ detail: { scope: "source", source: "10.9.9.9" } }]);
});

test("a concurrent burst against one account gets exactly five password checks before the lock", async () => {
  const { app, adminId } = await adminHub();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => login(app, adminId, `burst-${i}`)));
  expect(results.map((r) => r.status).sort()).toEqual([...Array(5).fill(401), ...Array(5).fill(429)]);
  expect((await login(app, adminId, "admin-pw")).status).toBe(429);
});

test("the bootstrap channel stays closed after invited accounts exist; only the bootstrap account administers", async () => {
  const { app, db, adminToken, token } = await adminHub();
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "bob-pw");
  expect((await bootstrap(app, { token, displayName: "Eve", password: "eve-pw" })).status).toBe(410);
  expect((await post(app, "/api/auth/invites", {}, bob.token)).status).toBe(403);
  expect((await db.query("select user_id from auth_events where kind='bootstrap_completed'")).length).toBe(1);
});

// ---------------------------------------------------------------------------------------------------------
// PR #292 review fixes: reset/login serialization, decoy retry, audit isolation, source reservations.
// ---------------------------------------------------------------------------------------------------------

/** The statements each transaction runs, in order. PGlite runs transactions one at a time, so row-lock
 * races cannot be produced here; these logs pin that every path takes the credential lock first. */
function recordingTx(db: Db, log: string[]): Db {
  return {
    ...db,
    tx: <T,>(fn: (t: Db) => Promise<T>): Promise<T> => db.tx((t) => fn({
      ...t,
      query: ((sql: string, params?: unknown[]) => {
        log.push(sql);
        return t.query(sql, params);
      }) as Db["query"],
    })),
  };
}

const LOCK_CREDENTIAL = /^select password_hash from user_credentials where user_id=\$1 for update$/;

function loginRequest(routes: ReturnType<typeof authRoutes>, account: string, password: string) {
  return routes.request("/login", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ account, password }) });
}

test("concurrent reset issues for one account leave exactly one redeemable code, the later one", async () => {
  const { app, db, adminId, adminToken } = await adminHub();
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "old-pw");
  const [a, b] = await Promise.all([createCredentialReset(db, adminId, bob.userId), createCredentialReset(db, adminId, bob.userId)]);
  const live = await db.query<{ id: string }>(
    "select id from credential_resets where user_id=$1 and used_at is null and expires_at > now()", [bob.userId]);
  expect(live).toHaveLength(1);
  const [winner, loser] = live[0]!.id === a.id ? [a, b] : [b, a];
  const [w, l] = await Promise.all([winner, loser].map(async (r) =>
    (await db.query<{ created_at: Date }>("select created_at from credential_resets where id=$1", [r.id]))[0]!.created_at));
  expect(new Date(w!).getTime()).toBeGreaterThanOrEqual(new Date(l!).getTime());
  expect((await post(app, "/api/auth/credential-reset/accept", { code: loser.code, password: "x" })).status).toBe(403);
  expect((await post(app, "/api/auth/credential-reset/accept", { code: winner.code, password: "new-pw" })).status).toBe(200);

  // Issuance, redemption and login issuance all lock the credential row before writing anything.
  const issueLog: string[] = [];
  const again = await createCredentialReset(recordingTx(db, issueLog), adminId, bob.userId);
  expect(issueLog[0]).toMatch(LOCK_CREDENTIAL);
  const acceptLog: string[] = [];
  await acceptCredentialReset(recordingTx(db, acceptLog), again.code, await hashPassword("newer-pw"));
  const lockAt = acceptLog.findIndex((sql) => LOCK_CREDENTIAL.test(sql));
  expect(lockAt).toBeGreaterThanOrEqual(0);
  expect(lockAt).toBeLessThan(acceptLog.findIndex((sql) => sql.startsWith("update credential_resets")));
  const loginLog: string[] = [];
  const routes = authRoutes({ db: recordingTx(db, loginLog), dataDir: "/nonexistent" });
  expect((await loginRequest(routes, bob.userId, "newer-pw")).status).toBe(200);
  expect(loginLog[0]).toMatch(LOCK_CREDENTIAL);
  expect(loginLog[1]).toMatch(/^insert into sessions/);
});

test("a reset redeemed between password verification and session issue refuses the old-password login", async () => {
  const { app, db, dataDir, adminId, adminToken } = await adminHub();
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "old-pw");
  const reset = await createCredentialReset(db, adminId, bob.userId);
  const newHash = await hashPassword("new-pw");
  // The reset commits right after login read the old hash, before it verifies and issues.
  let raced = false;
  const racing: Db = {
    ...db,
    query: (async (sql: string, params?: unknown[]) => {
      const rows = await db.query(sql, params);
      if (!raced && sql === "select password_hash from user_credentials where user_id=$1") {
        raced = true;
        await acceptCredentialReset(db, reset.code, newHash);
      }
      return rows;
    }) as Db["query"],
  };
  const res = await loginRequest(authRoutes({ db: racing, dataDir }), bob.userId, "old-pw");
  expect(raced).toBe(true);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "invalid credentials" });
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(await db.query("select id from sessions where user_id=$1 and revoked_at is null", [bob.userId])).toEqual([]);
  // The new password is unaffected.
  expect((await login(app, bob.userId, "new-pw")).status).toBe(200);
});

test("a failed decoy hash is not cached: the next unknown-account login retries it and is counted", async () => {
  const { db, dataDir } = await makeHubDeps();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    let calls = 0;
    const hashDecoy = async () => {
      calls += 1;
      if (calls === 1) throw new Error("injected decoy failure");
      return hashPassword("decoy");
    };
    const throttle = new LoginThrottle(Date.now, { ...LOGIN_THROTTLE, accountMaxFailures: 2 });
    const routes = authRoutes({ db, dataDir, loginThrottle: throttle, hashDecoy });

    expect((await loginRequest(routes, "usr_ghost", "x")).status).toBe(500);
    // Retried, verified and recorded: the aborted first attempt did not count, so the lock comes on the third.
    expect((await loginRequest(routes, "usr_ghost", "x")).status).toBe(401);
    expect(calls).toBe(2);
    expect((await loginRequest(routes, "usr_ghost", "x")).status).toBe(401);
    expect(await db.query("select user_id,detail from auth_events where kind='login_locked'"))
      .toEqual([{ user_id: null, detail: { scope: "account" } }]);
    expect((await loginRequest(routes, "usr_ghost", "x")).status).toBe(429);
    expect(calls).toBe(2);

    // Concurrent first logins share one pending decoy hash.
    let shared = 0;
    const fresh = authRoutes({ db, dataDir, hashDecoy: async () => { shared += 1; return hashPassword("decoy"); } });
    const statuses = await Promise.all(["usr_g1", "usr_g2", "usr_g3"].map((a) => loginRequest(fresh, a, "x")));
    expect(statuses.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(shared).toBe(1);
  } finally {
    quiet.mockRestore();
  }
});

test("a failed audit write changes neither the response nor the lock, and does not suppress the other event", async () => {
  const { db, dataDir } = await makeHubDeps();
  let failNext = true;
  const flaky: Db = {
    ...db,
    query: (async (sql: string, params?: unknown[]) => {
      if (failNext && sql.startsWith("insert into auth_events")) {
        failNext = false;
        throw new Error("injected audit failure");
      }
      return db.query(sql, params);
    }) as Db["query"],
  };
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // One failure locks both scopes, so two events are written; the first (account) write fails.
    const throttle = new LoginThrottle(() => 1_000_000, { ...LOGIN_THROTTLE, accountMaxFailures: 1, sourceMaxFailures: 1 });
    const routes = authRoutes({ db: flaky, dataDir, loginThrottle: throttle });
    const res = await loginRequest(routes, "usr_ghost", "secret-guess");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid credentials" });
    expect(failNext).toBe(false);
    expect(await db.query("select detail from auth_events where kind='login_locked'"))
      .toEqual([{ detail: { scope: "source", source: "unknown" } }]);
    const locked = await loginRequest(routes, "usr_ghost", "secret-guess");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    // Logged without the account string or the password.
    expect(logged).toHaveBeenCalled();
    const text = JSON.stringify(logged.mock.calls);
    expect(text).toContain("login_locked");
    expect(text).not.toContain("secret-guess");
    expect(text).not.toContain("usr_ghost");
  } finally {
    logged.mockRestore();
  }
});

test("with 19 source failures recorded, two concurrent logins on different accounts get one password check", async () => {
  const { app } = await adminHub();
  const from = { incoming: { socket: { remoteAddress: "10.7.7.7" } } };
  const attempt = (account: string) =>
    app.request(`${HUB}/api/auth/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ account, password: "x" }) }, from);
  for (let i = 0; i < 19; i++) expect((await attempt(`usr_spray${i}`)).status).toBe(401);
  // Without the reservation both would pass the gate before either failure was recorded (21 checks).
  const both = await Promise.all([attempt("usr_left"), attempt("usr_right")]);
  expect(both.map((r) => r.status).sort()).toEqual([401, 429]);
  expect((await attempt("usr_after")).status).toBe(429);
});

// ---------------------------------------------------------------------------------------------------------
// PR #292 review fixes, round 2: audit log redaction, reset clock under the lock, verifier faults.
// ---------------------------------------------------------------------------------------------------------

test("a failed audit write whose error quotes the account logs neither the account nor the message", async () => {
  const { db, dataDir } = await makeHubDeps();
  const account = "usr_quoted_identifier";
  let failNext = true;
  const flaky: Db = {
    ...db,
    query: (async (sql: string, params?: unknown[]) => {
      if (failNext && sql.startsWith("insert into auth_events")) {
        failNext = false;
        // Drivers quote the offending parameters in their messages.
        throw Object.assign(new Error(`insert into auth_events failed: Key (user_id)=(${account}) secret-guess`), { code: "23503" });
      }
      return db.query(sql, params);
    }) as Db["query"],
  };
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const throttle = new LoginThrottle(() => 1_000_000, { ...LOGIN_THROTTLE, accountMaxFailures: 1, sourceMaxFailures: 1 });
    const routes = authRoutes({ db: flaky, dataDir, loginThrottle: throttle });
    const res = await loginRequest(routes, account, "secret-guess");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid credentials" });
    expect(failNext).toBe(false);
    const locked = await loginRequest(routes, account, "secret-guess");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
    const text = JSON.stringify(logged.mock.calls);
    expect(text).toContain("failed to record login_locked (account, code 23503)");
    expect(text).not.toContain(account);
    expect(text).not.toContain("secret-guess");
    expect(text).not.toContain("Key (user_id)");
  } finally {
    logged.mockRestore();
  }
});

/** Runs `onLock` right after a transaction takes the credential row lock, i.e. when a waiting redemption resumes. */
function afterCredentialLock(db: Db, onLock: () => void): Db {
  return {
    ...db,
    tx: <T,>(fn: (t: Db) => Promise<T>): Promise<T> => db.tx((t) => fn({
      ...t,
      query: (async (sql: string, params?: unknown[]) => {
        const rows = await t.query(sql, params);
        if (LOCK_CREDENTIAL.test(sql)) onLock();
        return rows;
      }) as Db["query"],
    })),
  };
}

test("reset redemption reads the clock after the credential lock: a code superseded or expired while it waited is refused", async () => {
  const { app, db, adminId, adminToken } = await adminHub();
  const bob = await signUp(app, (await invite(app, adminToken)).code, "Bob", "old-pw");
  const newHash = await hashPassword("new-pw");
  const t0 = Date.now();
  let t = t0;
  const clock = () => new Date(t);
  // Each redemption is called at t, then waits one second for the lock (an issuance holding it, say).
  const waited = afterCredentialLock(db, () => { t += 1000; });

  // Superseded: the administrator issued a replacement during the wait; issuance expired the old code at its own time.
  const old = await createCredentialReset(db, adminId, bob.userId, new Date(t0 - 60_000));
  const replacement = await createCredentialReset(db, adminId, bob.userId, new Date(t0 + 1000));
  await expect(acceptCredentialReset(waited, old.code, newHash, clock)).rejects.toThrow(INVALID_RESET);

  // Expired: the code's own expiry passed during the wait.
  t = t0;
  const expiring = await createCredentialReset(db, adminId, bob.userId, new Date(t0 - CREDENTIAL_RESET_TTL_MS + 500));
  await expect(acceptCredentialReset(waited, expiring.code, newHash, clock)).rejects.toThrow(INVALID_RESET);
  t = t0;
  await expect(acceptCredentialReset(waited, replacement.code, newHash, clock)).rejects.toThrow(INVALID_RESET); // expired by that issue
  expect((await login(app, bob.userId, "old-pw")).status).toBe(200);

  // A live code is redeemed, and the redemption is stamped with the time after the lock, not the call time.
  t = t0;
  const live = await createCredentialReset(db, adminId, bob.userId, new Date(t0));
  await acceptCredentialReset(waited, live.code, newHash, clock);
  const stamped = t0 + 1000;
  const [reset] = await db.query<{ used_at: Date }>("select used_at from credential_resets where id=$1", [live.id]);
  const [credential] = await db.query<{ updated_at: Date }>("select updated_at from user_credentials where user_id=$1", [bob.userId]);
  expect(new Date(reset!.used_at).getTime()).toBe(stamped);
  expect(new Date(credential!.updated_at).getTime()).toBe(stamped);
  expect((await login(app, bob.userId, "new-pw")).status).toBe(200);
});

test("a verifier fault answers 500 and counts no failure; a wrong password is still a counted 401", async () => {
  const { db, dataDir } = await makeHubDeps();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    // 19 source failures recorded: one counted failure more would lock the source for 15 minutes.
    const throttle = new LoginThrottle(() => 1_000_000);
    for (let i = 0; i < 19; i++) throttle.recordFailure(`usr_spray${i}`, "unknown");
    let faults = 1;
    const verify = async (password: string, stored: string) => {
      if (faults > 0) {
        faults -= 1;
        throw new Error("injected argon2 fault");
      }
      return verifyPassword(password, stored);
    };
    const routes = authRoutes({ db, dataDir, loginThrottle: throttle, verifyPassword: verify });

    const faulted = await loginRequest(routes, "usr_ghost", "x");
    expect(faulted.status).toBe(500);
    expect(faulted.headers.get("set-cookie")).toBeNull();
    expect(throttle.check("usr_ghost", "unknown")).toBeNull(); // not counted, reservation released, source not locked
    expect(await db.query("select id from auth_events where kind='login_locked'")).toEqual([]);

    // A wrong password behaves as before: 401, counted (the twentieth failure), and the source locks.
    const wrong = await loginRequest(routes, "usr_ghost", "x");
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "invalid credentials" });
    const locked = await loginRequest(routes, "usr_other", "x");
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("900");
  } finally {
    quiet.mockRestore();
  }
});
