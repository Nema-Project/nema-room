// #167 deviation 2: the three callers every host-level route family is pinned against — the remote form's
// hub administrator, a signed-in remote account that is not the administrator, and the local form's
// usr_local — plus an anonymous remote caller.
import { expect } from "vitest";
import type { Hono } from "hono";
import { createApp, type AppDeps } from "../src/app.js";
import { SESSION_COOKIE, completeBootstrap, issueSession } from "../src/auth.js";
import type { DaemonRpc } from "../src/daemonRpc.js";
import { EventBus } from "../src/events.js";
import { makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
export const HOST_ADMIN_ONLY = "only the hub administrator may do this";

export type Caller = "admin" | "member" | "anonymous" | "local";

export type HostAdminHubs = {
  /** Sends one request as `who`: remote hub with the admin's, the member's or no cookie; local hub for "local". */
  send: (who: Caller, method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  /** Daemon calls made so far, across both hubs. */
  calls: string[];
  /** The remote hub's database and data dir, and the two remote accounts. */
  remote: { db: AppDeps["db"]; dataDir: string; adminId: string; memberId: string };
};

/**
 * One remote hub (remoteAuth on, bootstrap completed, a second signed-in account) and one local hub
 * (localIdentity), sharing `daemon`. The non-administrator account is a real user with a live session,
 * exactly what an accepted invite produces, but it is not the bootstrap account.
 */
export async function hostAdminHubs(daemon: DaemonRpc, extra: Partial<AppDeps> = {}): Promise<HostAdminHubs> {
  const calls: string[] = [];
  const recording: DaemonRpc = { call: (method, params, timeoutMs) => (calls.push(method), daemon.call(method, params, timeoutMs)) };
  const base = (deps: { db: AppDeps["db"]; dataDir: string }) =>
    ({ ...deps, events: new EventBus(), daemonStatus: () => true, daemon: recording, ...extra }) satisfies AppDeps;

  const remoteDeps = await makeHubDeps();
  const remote = createApp({ ...base(remoteDeps), remoteAuth: true });
  const admin = await completeBootstrap(remoteDeps.db, "Admin", "hash-admin");
  const memberId = "usr_member_host_admin";
  await remoteDeps.db.query("insert into users(id,display_name) values ($1,$2)", [memberId, "Member"]);
  await remoteDeps.db.query("insert into user_credentials(user_id,password_hash) values ($1,$2)", [memberId, "hash-member"]);
  const member = await issueSession(remoteDeps.db, memberId);

  const local = createApp(base(await makeHubDeps()));

  const cookies: Record<Caller, string | null> = { admin: admin.session.token, member: member.token, anonymous: null, local: null };
  const send = (who: Caller, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
    const token = cookies[who];
    if (token) headers.cookie = `${SESSION_COOKIE}=${token}`;
    const target: Hono = who === "local" ? local : remote;
    return Promise.resolve(target.request(`${HUB}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
  };
  return { send, calls, remote: { db: remoteDeps.db, dataDir: remoteDeps.dataDir, adminId: admin.userId, memberId } };
}

export type HostRoute = { method: string; path: string; body?: unknown };

/**
 * The refusal half of the contract: on every listed route a signed-in non-administrator gets 403 with the
 * administrator message and the daemon is never contacted; an anonymous remote caller still gets 401.
 */
export async function expectNonAdminRefused(hubs: HostAdminHubs, routes: HostRoute[]): Promise<void> {
  for (const { method, path, body } of routes) {
    const before = hubs.calls.length;
    const refused = await hubs.send("member", method, path, body);
    expect(refused.status, `${method} ${path} as non-admin`).toBe(403);
    expect(await refused.json()).toEqual({ error: HOST_ADMIN_ONLY });
    const anonymous = await hubs.send("anonymous", method, path, body);
    expect(anonymous.status, `${method} ${path} anonymous`).toBe(401);
    expect(hubs.calls.length, `${method} ${path} reached the daemon`).toBe(before);
  }
}
