// #167 task 8 (spec acceptance ③ and ⑥): workspace content routes require roster membership, workspace
// administration requires an owner, and the local form's synthetic user passes everything as it did before.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { EventBus } from "../src/events.js";
import { addMember, removeMember } from "../src/members.js";
import { createWorkspace } from "../src/workspaces.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const HUB = "http://127.0.0.1:4400";
let deps: Awaited<ReturnType<typeof makeHubDeps>>;
let app: ReturnType<typeof createApp>;
let ws: string;
let actor: string;

beforeEach(async () => {
  deps = await makeHubDeps();
  await deps.db.query("insert into users(id) values ('usr_owner'),('usr_mem'),('usr_gone'),('usr_out')");
  // Owned by a real user, so usr_local is not on this roster: only the short-circuit lets it in.
  ws = (await createWorkspace(deps.db, deps.dataDir, "Authz", undefined, "usr_owner")).id;
  await addMember(deps.db, ws, "usr_mem", "member", "usr_owner");
  await addMember(deps.db, ws, "usr_gone", "member", "usr_owner");
  await removeMember(deps.db, ws, "usr_gone", "usr_owner");
  actor = "usr_owner";
  app = createApp({ ...deps, events: new EventBus(), daemonStatus: () => false, daemon: { call: async () => null }, identity: async () => ({ userId: actor }) });
});
afterEach(async () => { await deps.close(); await cleanupHubDeps(); });

const req = (as: string, method: string, path: string, body?: unknown) => {
  actor = as;
  return app.request(`${HUB}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

type Probe = { name: string; method: string; path: () => string; body?: unknown; owner: boolean };
const probes: Probe[] = [
  { name: "thread list (read)", method: "GET", path: () => `/api/workspaces/${ws}/threads`, owner: false },
  { name: "entries (read)", method: "GET", path: () => `/api/workspaces/${ws}/entries`, owner: false },
  { name: "mention context (read)", method: "GET", path: () => `/api/workspaces/${ws}/mention-context?q=x`, owner: false },
  { name: "send message (write)", method: "POST", path: () => `/api/workspaces/${ws}/messages`, body: { content: "hello" }, owner: false },
  { name: "rename workspace (owner)", method: "PATCH", path: () => `/api/workspaces/${ws}`, body: { name: "Renamed" }, owner: true },
  // componentRoutes has no workspace-scoped route; repository binding is the workspace-level settings operation.
  { name: "unbind repository (owner)", method: "DELETE", path: () => `/api/workspaces/${ws}/repos/repo_missing`, owner: true },
  { name: "list shares (owner)", method: "GET", path: () => `/api/workspaces/${ws}/shares`, owner: true },
  { name: "create share (owner)", method: "POST", path: () => `/api/workspaces/${ws}/shares`, body: {}, owner: true },
];

describe.each(probes)("$name", (p) => {
  test("non-members and removed members get 403", async () => {
    for (const who of ["usr_out", "usr_gone"]) {
      const res = await req(who, p.method, p.path(), p.body);
      expect(res.status, who).toBe(403);
    }
  });
  test(p.owner ? "a plain member gets 403; the owner passes" : "members and the owner pass", async () => {
    const asMember = await req("usr_mem", p.method, p.path(), p.body);
    if (p.owner) expect(asMember.status).toBe(403);
    else expect(asMember.status).toBeLessThan(400);
    const asOwner = await req("usr_owner", p.method, p.path(), p.body);
    expect([401, 403]).not.toContain(asOwner.status);
  });
  test("usr_local passes without being on the roster (local-form short-circuit)", async () => {
    const res = await req("usr_local", p.method, p.path(), p.body);
    expect([401, 403]).not.toContain(res.status);
  });
});

test("a refused write changes nothing", async () => {
  expect((await req("usr_out", "POST", `/api/workspaces/${ws}/messages`, { content: "intruder" })).status).toBe(403);
  expect((await req("usr_mem", "PATCH", `/api/workspaces/${ws}`, { name: "Hijacked" })).status).toBe(403);
  expect((await req("usr_mem", "POST", `/api/workspaces/${ws}/shares`, {})).status).toBe(403);
  expect(await deps.db.query("select id from messages where workspace_id=$1", [ws])).toEqual([]);
  expect(await deps.db.query("select name from workspaces where id=$1", [ws])).toEqual([{ name: "Authz" }]);
  expect(await deps.db.query("select id from knowledge_shares where workspace_id=$1", [ws])).toEqual([]);
});

test("an outsider cannot tell a missing workspace from someone else's", async () => {
  expect((await req("usr_out", "GET", "/api/workspaces/ws_doesnotexist/threads")).status).toBe(403);
  expect((await req("usr_out", "GET", `/api/workspaces/${ws}/threads`)).status).toBe(403);
  // The local form keeps today's answer for a missing workspace.
  expect((await req("usr_local", "GET", "/api/workspaces/ws_doesnotexist/threads")).status).toBe(404);
});

test("the workspace list shows only the caller's active workspaces; usr_local sees all", async () => {
  const ids = async (who: string) => ((await (await req(who, "GET", "/api/workspaces")).json()) as { id: string }[]).map((w) => w.id);
  expect(await ids("usr_mem")).toEqual([ws]);
  expect(await ids("usr_owner")).toEqual([ws]);
  expect(await ids("usr_out")).toEqual([]);
  expect(await ids("usr_gone")).toEqual([]);
  expect(await ids("usr_local")).toEqual([ws]);
});

test("the workspace event stream needs membership", async () => {
  expect((await req("usr_out", "GET", `/api/workspaces/${ws}/events`)).status).toBe(403);
  expect((await req("usr_gone", "GET", `/api/workspaces/${ws}/events`)).status).toBe(403);
});

test("deleting a workspace is owner-only", async () => {
  expect((await req("usr_mem", "DELETE", `/api/workspaces/${ws}`)).status).toBe(403);
  expect((await req("usr_out", "DELETE", `/api/workspaces/${ws}`)).status).toBe(403);
  expect(await deps.db.query("select id from workspaces where id=$1", [ws])).toHaveLength(1);
  expect((await req("usr_owner", "DELETE", `/api/workspaces/${ws}`)).status).toBe(204);
});
