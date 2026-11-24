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
let events: EventBus;

beforeEach(async () => {
  deps = await makeHubDeps();
  await deps.db.query("insert into users(id) values ('usr_owner'),('usr_mem'),('usr_gone'),('usr_out')");
  // Owned by a real user, so usr_local is not on this roster: only the short-circuit lets it in.
  ws = (await createWorkspace(deps.db, deps.dataDir, "Authz", undefined, "usr_owner")).id;
  await addMember(deps.db, ws, "usr_mem", "member", "usr_owner");
  await addMember(deps.db, ws, "usr_gone", "member", "usr_owner");
  await removeMember(deps.db, ws, "usr_gone", "usr_owner");
  actor = "usr_owner";
  events = new EventBus();
  app = createApp({ ...deps, events, daemonStatus: () => false, daemon: { call: async () => null }, identity: async () => ({ userId: actor }) });
});
afterEach(async () => { await deps.close(); await cleanupHubDeps(); });

const req = (as: string, method: string, path: string, body?: unknown) => {
  actor = as;
  return app.request(`${HUB}${path}`, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

type Probe = { name: string; method: string; path: () => string; body?: unknown; owner: boolean; status: number };
const probes: Probe[] = [
  { name: "thread list (read)", method: "GET", path: () => `/api/workspaces/${ws}/threads`, owner: false, status: 200 },
  { name: "entries (read)", method: "GET", path: () => `/api/workspaces/${ws}/entries`, owner: false, status: 200 },
  { name: "mention context (read)", method: "GET", path: () => `/api/workspaces/${ws}/mention-context?q=x`, owner: false, status: 200 },
  { name: "send message (write)", method: "POST", path: () => `/api/workspaces/${ws}/messages`, body: { content: "hello" }, owner: false, status: 200 },
  { name: "rename workspace (owner)", method: "PATCH", path: () => `/api/workspaces/${ws}`, body: { name: "Renamed" }, owner: true, status: 200 },
  // componentRoutes has no workspace-scoped route; repository binding is the workspace-level settings operation.
  // The repository is deliberately missing, so the handler answers 404 once the owner gate passes.
  { name: "unbind repository (owner)", method: "DELETE", path: () => `/api/workspaces/${ws}/repos/repo_missing`, owner: true, status: 404 },
  { name: "list shares (owner)", method: "GET", path: () => `/api/workspaces/${ws}/shares`, owner: true, status: 200 },
  // The fixture workspace is confidential by default (001_init.sql), so createShare answers 409 once the
  // owner gate passes; the 201 path is covered by shares.test.ts. Asserting 409 still fails a 500 or a
  // handler that never ran, which is what this probe is for.
  { name: "create share (owner)", method: "POST", path: () => `/api/workspaces/${ws}/shares`, body: {}, owner: true, status: 409 },
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
    else expect(asMember.status, "member").toBe(p.status);
    const asOwner = await req("usr_owner", p.method, p.path(), p.body);
    expect(asOwner.status, "owner").toBe(p.status);
  });
  test("usr_local passes without being on the roster (local-form short-circuit)", async () => {
    const res = await req("usr_local", p.method, p.path(), p.body);
    expect(res.status, "usr_local").toBe(p.status);
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

/** Opens the workspace event stream as `who` and reads it into a buffer. */
async function openStream(who: string) {
  const ac = new AbortController();
  actor = who;
  const res = await app.request(`${HUB}/api/workspaces/${ws}/events`, { signal: ac.signal });
  expect(res.status, who).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const s = { buf: "", ended: false };
  // A read that loses the timeout race stays pending and is awaited next time, so no chunk is dropped.
  let pending: ReturnType<typeof reader.read> | null = null;
  const read = async (ms: number) => {
    pending ??= reader.read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const r = await Promise.race([pending, new Promise<null>((ok) => (timer = setTimeout(() => ok(null), ms)))]);
    clearTimeout(timer);
    if (r === null) return;
    pending = null;
    if (r.done) s.ended = true;
    else s.buf += dec.decode(r.value);
  };
  return {
    s,
    /** Reads until `needle` arrives; fails after 3 s. */
    async until(needle: string) {
      const deadline = Date.now() + 3000;
      while (!s.buf.includes(needle)) {
        if (s.ended || Date.now() > deadline) throw new Error(`${who}: no ${needle}; got ${s.buf}`);
        await read(200);
      }
    },
    /** Reads until the hub ends the stream; fails after 3 s. */
    async untilEnded() {
      const deadline = Date.now() + 3000;
      while (!s.ended) {
        if (Date.now() > deadline) throw new Error(`${who}: stream still open; got ${s.buf}`);
        await read(200);
      }
    },
    async close() {
      ac.abort();
      await reader.cancel().catch(() => {});
    },
  };
}
const changed = (entryId: string) => events.emit(ws, { type: "knowledge.changed", entryId });

test("removing a member closes their open event stream; other members keep receiving", async () => {
  const removed = await openStream("usr_mem");
  const kept = await openStream("usr_owner");
  changed("E-before");
  await removed.until("E-before");
  await kept.until("E-before");

  // The real roster route, which runs removeMember.
  expect((await req("usr_owner", "POST", `/api/workspaces/${ws}/members/usr_mem/remove`)).status).toBe(200);
  await removed.untilEnded();
  changed("E-after");
  await kept.until("E-after");
  expect(removed.s.buf).not.toContain("E-after");
  // The closed stream left the bus; the remaining member's subscription is still there.
  expect((events as any).revokers.has(`${ws}\0usr_mem`)).toBe(false);
  expect((events as any).byWs.get(ws).size).toBe(1);
  await kept.close();

  // A new stream goes through the open-time gate: refused while removed, admitted again once re-added.
  expect((await req("usr_mem", "GET", `/api/workspaces/${ws}/events`)).status).toBe(403);
  await addMember(deps.db, ws, "usr_mem", "member", "usr_owner");
  const readded = await openStream("usr_mem");
  changed("E-readded");
  await readded.until("E-readded");
  await readded.close();
});

test("usr_local's event stream is never revoked (local form has no roster to leave)", async () => {
  const local = await openStream("usr_local");
  events.revoke(ws, "usr_local");
  changed("E-local");
  await local.until("E-local");
  expect(local.s.ended).toBe(false);
  await local.close();
});

test("deleting a workspace is owner-only", async () => {
  expect((await req("usr_mem", "DELETE", `/api/workspaces/${ws}`)).status).toBe(403);
  expect((await req("usr_out", "DELETE", `/api/workspaces/${ws}`)).status).toBe(403);
  expect(await deps.db.query("select id from workspaces where id=$1", [ws])).toHaveLength(1);
  expect((await req("usr_owner", "DELETE", `/api/workspaces/${ws}`)).status).toBe(204);
});
