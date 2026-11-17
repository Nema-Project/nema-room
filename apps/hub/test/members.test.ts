import { afterEach, beforeEach, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { EventBus } from "../src/events.js";
import { createWorkspace } from "../src/workspaces.js";
import { postUserMessage } from "../src/messages.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import { activeMembers, activeMemberCount, listMembers, listMemberEvents } from "../src/members.js";

let deps: Awaited<ReturnType<typeof makeHubDeps>>;
let ws: string;
let actor = "usr_local";
let app: ReturnType<typeof createApp>;
const HUB = "http://127.0.0.1:4400";
beforeEach(async () => {
  deps = await makeHubDeps();
  ws = (await createWorkspace(deps.db, deps.dataDir, "Members")).id;
  await deps.db.query("insert into users(id,display_name) values ('usr_test2','PrivateName')");
  actor = "usr_local";
  app = createApp({ ...deps, events: new EventBus(), daemonStatus: () => false, daemon: { call: async () => null }, identity: async () => ({ userId: actor }) });
});
afterEach(async () => { await deps.close(); await cleanupHubDeps(); });
const req = (method: string, path: string, body?: unknown) => app.request(`${HUB}${path}`, {
  method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const base = () => `/api/workspaces/${ws}/members`;
async function add(role = "member") {
  const res = await req("POST", base(), { userId: "usr_test2", role });
  expect(res.status).toBe(200);
}

test("only active owners can manage existing users; errors disclose no identity", async () => {
  await add();
  actor = "usr_test2";
  for (const [path, body] of [[base(), { userId: "usr_local", role: "member" }], [`${base()}/usr_local/role`, { role: "member" }], [`${base()}/usr_local/remove`, {}]] as const) {
    const res = await req("POST", path, body);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toMatch(/PrivateName|usr_/);
  }
  actor = "usr_local";
  expect((await req("POST", base(), { userId: "usr_missing", role: "member" })).status).toBe(404);
  expect(await deps.db.query("select id from users where id='usr_missing'")).toEqual([]);
});

test("soft removal preserves authors, audits once, and re-adds the same roster row", async () => {
  await add();
  const sent = await postUserMessage(deps.db, ws, "Authored", { authorUserId: "usr_test2" });
  expect((await req("POST", `${base()}/usr_test2/remove`, {})).status).toBe(200);
  expect((await req("POST", `${base()}/usr_test2/remove`, {})).status).toBe(409);
  expect(await deps.db.query("select author_user_id from messages where id=$1", [sent.message.id])).toEqual([{ author_user_id: "usr_test2" }]);
  expect(await deps.db.query("select id from users where id='usr_test2'")).toHaveLength(1);
  expect(await activeMemberCount(deps.db, ws)).toBe(1);
  expect(await activeMembers(deps.db, ws)).toHaveLength(1);
  expect((await listMembers(deps.db, ws)).find(m => m.userId === "usr_test2")?.removedAt).toBeTruthy();
  actor = "usr_test2";
  expect((await req("GET", `${base()}/events`)).status).toBe(403);
  expect((await req("GET", base())).status).toBe(403);
  actor = "usr_local";
  await add();
  expect(await activeMemberCount(deps.db, ws)).toBe(2);
  expect(await listMembers(deps.db, ws)).toHaveLength(2);
  const events = (await listMemberEvents(deps.db, ws)).filter(e => e.userId === "usr_test2");
  expect(events.map(e => e.kind)).toEqual(["added", "removed", "added"]);
  const roster = await (await req("GET", base())).json();
  expect(roster).toEqual(expect.arrayContaining([{ userId: "usr_test2", displayName: "PrivateName", role: "member", removedAt: null }]));
});

test("last owner cannot leave or be demoted; role changes retain from/to audit", async () => {
  expect((await req("POST", `${base()}/usr_local/remove`, {})).status).toBe(409);
  expect((await req("POST", `${base()}/usr_local/role`, { role: "member" })).status).toBe(409);
  await add("owner");
  expect((await req("POST", `${base()}/usr_local/role`, { role: "member" })).status).toBe(200);
  expect((await listMemberEvents(deps.db, ws))[0]).toMatchObject({ kind: "role_changed", detail: { from: "owner", to: "member" }, actorUserId: "usr_local" });
  actor = "usr_test2";
  expect((await req("POST", `${base()}/usr_local/remove`, {})).status).toBe(200);
});

test("a nonmember cannot read roster or audit, and audit has no mutation handlers", async () => {
  actor = "usr_test2";
  expect((await req("GET", `${base()}/events`)).status).toBe(403);
  expect((await req("GET", base())).status).toBe(403);
  expect(app.routes.filter(r => /members\/events/.test(r.path) && r.method !== "GET")).toEqual([]);
  for (const method of ["PATCH", "PUT", "DELETE"]) expect((await req(method, `${base()}/events`, {})).status).toBe(404);
});

test("me supports trimmed names and null reset with global rename audits", async () => {
  expect(await (await req("GET", "/api/me")).json()).toEqual({ userId: "usr_local", displayName: null });
  expect(await (await req("PATCH", "/api/me", { displayName: "  Name  " })).json()).toEqual({ userId: "usr_local", displayName: "Name" });
  for (const displayName of ["x".repeat(65), "   ", 7]) {
    const res = await req("PATCH", "/api/me", { displayName });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("Name");
  }
  expect(await (await req("PATCH", "/api/me", { displayName: null })).json()).toEqual({ userId: "usr_local", displayName: null });
  expect(await deps.db.query("select workspace_id,kind,actor_user_id,detail from member_events where kind='renamed' order by created_at,id")).toHaveLength(2);
});
