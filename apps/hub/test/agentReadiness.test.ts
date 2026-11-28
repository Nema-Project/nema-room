// #302 task 5: GET /api/agent-readiness passes `agents.readiness` through, names the connection that answered,
// and trims the reply for anyone who is not that daemon's owner. The daemon is a fake that reports a chosen
// responder, except in the block at the end, which runs the real connection table.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import type { Hono } from "hono";
import { READINESS_STALE, READINESS_UNSUPPORTED, unknownRpcMethodError, type AgentReadinessResponse, type DaemonStatusSnapshot, type ReadinessReply, type TrimmedAgentReadinessResponse } from "@nema/shared";
import { createApp } from "../src/app.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { createDaemonRegistrationCode, registerDaemon } from "../src/daemons.js";
import { COMPONENT_RPC_TIMEOUT_MS, DAEMON_DISCONNECTED, DAEMON_NOT_CONNECTED, DAEMON_TIMED_OUT, DaemonRpcError, type DaemonResponder, type DaemonRpc } from "../src/daemonRpc.js";
import { EventBus } from "../src/events.js";
import { readinessAccess } from "../src/readiness.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import { hostAdminHubs } from "./hostAdminFixture.js";

const HUB = "http://127.0.0.1:4400";

/** A whole daemon reply, with every field the trimmed form must drop. */
const REPLY: ReadinessReply = {
  current: "codex-direct",
  checkedAt: "2026-11-28T00:00:00.000Z",
  runtimes: [
    { runtime: "codex-direct", state: "configured", account: { id: "acc_default", implicit: true, authMode: "siwc" } },
    {
      runtime: "claude-code",
      state: "not_signed_in",
      reason: "no_enabled_account",
      cli: { command: "claude", version: "2.1.0", installUrl: "https://docs.anthropic.com/claude-code" },
    },
  ],
};

const LOCAL_RESPONDER: DaemonResponder = { daemonId: "d_local", connectionId: "c_local", registered: false, ownerUserId: null };

type Fake = {
  calls: Array<{ method: string; params: unknown; timeoutMs?: number }>;
  responder: DaemonResponder;
  answer: () => Promise<unknown>;
  /** The current connection the hub reports; follows `responder` unless a test moves it. */
  snapshot: DaemonStatusSnapshot | null;
  daemon: DaemonRpc;
  daemonSnapshot: () => DaemonStatusSnapshot;
};

function fakeDaemon(): Fake {
  const fake: Fake = {
    calls: [],
    responder: LOCAL_RESPONDER,
    answer: async () => REPLY,
    snapshot: null,
    daemon: {
      async call(method, params, timeoutMs, target) {
        fake.calls.push({ method, params, timeoutMs });
        target?.onResponder?.(fake.responder);
        return fake.answer();
      },
    },
    daemonSnapshot: () =>
      fake.snapshot ?? { connected: true, daemonId: fake.responder.daemonId, connectionId: fake.responder.connectionId },
  };
  return fake;
}

let fake: Fake;
let local: Hono;
beforeEach(async () => {
  fake = fakeDaemon();
  const deps = await makeHubDeps();
  local = createApp({ ...deps, events: new EventBus(), daemonStatus: () => true, daemon: fake.daemon, daemonSnapshot: fake.daemonSnapshot });
});
afterAll(cleanupHubDeps);

const get = (app: Hono, path = "/api/agent-readiness") => app.request(`${HUB}${path}`);

describe("GET /api/agent-readiness pass-through", () => {
  test("passes agents.readiness through with the component timeout; force=1 becomes { force: true }", async () => {
    const plain = await get(local);
    expect(plain.status).toBe(200);
    const forced = await get(local, "/api/agent-readiness?force=1");
    expect(forced.status).toBe(200);
    // Anything but exactly 1 is not a force.
    await get(local, "/api/agent-readiness?force=true");
    expect(fake.calls).toEqual([
      { method: "agents.readiness", params: {}, timeoutMs: COMPONENT_RPC_TIMEOUT_MS },
      { method: "agents.readiness", params: { force: true }, timeoutMs: COMPONENT_RPC_TIMEOUT_MS },
      { method: "agents.readiness", params: {}, timeoutMs: COMPONENT_RPC_TIMEOUT_MS },
    ]);
  });

  test("the local form gets the whole reply, with daemon filled by the hub from the responding connection", async () => {
    fake.answer = async () => ({ ...REPLY, daemon: { id: "spoofed", label: "spoofed" }, extra: "dropped" });
    const response = await get(local);
    expect(await response.json()).toEqual({ ...REPLY, access: "full", daemon: { id: "d_local", connectionId: "c_local", label: null } });
  });

  test("an offline daemon is 503, as every other daemon route answers it", async () => {
    for (const message of [DAEMON_NOT_CONNECTED, DAEMON_DISCONNECTED, DAEMON_TIMED_OUT]) {
      fake.answer = async () => { throw new DaemonRpcError(message); };
      const response = await get(local);
      expect(response.status, message).toBe(503);
      expect(await response.json()).toEqual({ error: message });
    }
  });

  test("an old daemon without agents.readiness gets the recognizable readiness_unsupported code", async () => {
    fake.answer = async () => { throw new DaemonRpcError(unknownRpcMethodError("agents.readiness")); };
    const response = await get(local);
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: READINESS_UNSUPPORTED });
  });

  test("another daemon failure is a 502, and so is a reply that does not fit the contract", async () => {
    fake.answer = async () => { throw new DaemonRpcError("boom"); };
    expect((await get(local)).status).toBe(502);
    fake.answer = async () => ({ current: "codex-direct", runtimes: [{ runtime: "codex-direct", state: "great" }], checkedAt: "x" });
    expect((await get(local)).status).toBe(502);
    fake.answer = async () => null;
    expect((await get(local)).status).toBe(502);
  });

  test("a connection replaced after answering and before the reply is built is a 503", async () => {
    fake.answer = async () => {
      // The answer arrives, but by now a newer connection is current.
      fake.snapshot = { connected: true, daemonId: "d_newer", connectionId: "c_newer" };
      return REPLY;
    };
    const response = await get(local);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: READINESS_STALE });
  });

  test("the same daemon reconnecting (same id, new connection id) also makes the old reply stale", async () => {
    fake.answer = async () => {
      fake.snapshot = { connected: true, daemonId: "d_local", connectionId: "c_local_2" };
      return REPLY;
    };
    expect((await get(local)).status).toBe(503);
  });

  test("a connection that closed with nothing left is a 503", async () => {
    fake.answer = async () => {
      fake.snapshot = { connected: false, daemonId: null, connectionId: null };
      return REPLY;
    };
    expect((await get(local)).status).toBe(503);
  });

  test("without a snapshot source no reply can be confirmed current", async () => {
    const deps = await makeHubDeps();
    const blind = createApp({ ...deps, events: new EventBus(), daemonStatus: () => true, daemon: fake.daemon });
    expect((await get(blind)).status).toBe(503);
  });
});

describe("access and trimming", () => {
  const TRIMMED_KEYS = ["access", "checkedAt", "current", "daemon", "runtimes"];

  test("readinessAccess: local full; remote owner full; registered non-owner non_owner; unregistered owner_unknown", () => {
    expect(readinessAccess({ userId: "usr_local" }, LOCAL_RESPONDER)).toBe("full");
    expect(readinessAccess({ userId: "usr_local" }, { registered: true, ownerUserId: "usr_a" })).toBe("full");
    expect(readinessAccess({ userId: "usr_a" }, { registered: true, ownerUserId: "usr_a" })).toBe("full");
    expect(readinessAccess({ userId: "usr_b" }, { registered: true, ownerUserId: "usr_a" })).toBe("non_owner");
    expect(readinessAccess({ userId: "usr_b" }, { registered: true, ownerUserId: null })).toBe("non_owner");
    expect(readinessAccess({ userId: "usr_a" }, { registered: false, ownerUserId: null })).toBe("owner_unknown");
  });

  test("remote: the registered daemon's owner gets full with its label; a non-owner gets non_owner, trimmed; neither is refused", async () => {
    const hubs = await hostAdminHubs(fake.daemon, { daemonSnapshot: fake.daemonSnapshot });
    const { db, memberId } = hubs.remote;
    const { code } = await createDaemonRegistrationCode(db, memberId);
    const { id } = (await registerDaemon(db, code, "Member's Mac mini"))!;
    fake.responder = { daemonId: id, connectionId: "c_reg", registered: true, ownerUserId: memberId };
    const daemon = { id, connectionId: "c_reg", label: "Member's Mac mini" };

    // The owner here is a signed-in non-administrator: the route is not host-level.
    const owner = await hubs.send("member", "GET", "/api/agent-readiness");
    expect(owner.status).toBe(200);
    expect(await owner.json()).toEqual({ ...REPLY, access: "full", daemon });

    // The hub administrator does not own this daemon, so is trimmed like any other non-owner.
    const other = await hubs.send("admin", "GET", "/api/agent-readiness");
    expect(other.status).toBe(200);
    const trimmed = (await other.json()) as TrimmedAgentReadinessResponse;
    expect(trimmed).toEqual({
      access: "non_owner",
      current: REPLY.current,
      checkedAt: REPLY.checkedAt,
      daemon,
      runtimes: [{ runtime: "codex-direct", state: "configured" }, { runtime: "claude-code", state: "not_signed_in" }],
    });
    expect(Object.keys(trimmed).sort()).toEqual(TRIMMED_KEYS);
    for (const row of trimmed.runtimes) expect(Object.keys(row).sort()).toEqual(["runtime", "state"]);
    expect(JSON.stringify(trimmed)).not.toMatch(/"account"|"cli"|"reason"|acc_default/);
  });

  test("remote: an unregistered (shared-token) daemon is owner_unknown, trimmed, for a non-administrator", async () => {
    const hubs = await hostAdminHubs(fake.daemon, { daemonSnapshot: fake.daemonSnapshot });
    const response = await hubs.send("member", "GET", "/api/agent-readiness");
    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentReadinessResponse;
    expect(body).toEqual({
      access: "owner_unknown",
      current: REPLY.current,
      checkedAt: REPLY.checkedAt,
      daemon: { id: "d_local", connectionId: "c_local", label: null },
      runtimes: [{ runtime: "codex-direct", state: "configured" }, { runtime: "claude-code", state: "not_signed_in" }],
    });
    expect(Object.keys(body).sort()).toEqual(TRIMMED_KEYS);
    expect(JSON.stringify(body)).not.toMatch(/"account"|"cli"|"reason"/);
    expect((await hubs.send("anonymous", "GET", "/api/agent-readiness")).status).toBe(401);
  });

  test("the local form through the shared fixture is full", async () => {
    const hubs = await hostAdminHubs(fake.daemon, { daemonSnapshot: fake.daemonSnapshot });
    const response = await hubs.send("local", "GET", "/api/agent-readiness");
    expect(response.status).toBe(200);
    expect(((await response.json()) as AgentReadinessResponse).access).toBe("full");
  });
});

// The real connection table: the reply names the connection that actually answered, and is refused if that
// connection stops being current before the hub answers.
describe("with the real daemon socket", () => {
  const TOKEN = "tok";
  let server: http.Server;
  let handle: ReturnType<typeof attachDaemonSocket>;
  let app: Hono;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const deps = await makeHubDeps();
    const events = new EventBus();
    server = http.createServer();
    handle = attachDaemonSocket(server, { ...deps, events, daemonToken: TOKEN, hubUrl: "http://hub.test" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/daemon`;
    app = createApp({ ...deps, events, daemonStatus: () => handle.isConnected(), daemonSnapshot: () => handle.statusSnapshot(), daemon: handle.rpc });
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await handle.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A daemon that answers agents.readiness with REPLY once the returned `release` is called. */
  async function daemon(): Promise<{ ws: WebSocket; readiness: Promise<() => void> }> {
    const ws = new WebSocket(url);
    sockets.push(ws);
    let resolveReadiness!: (release: () => void) => void;
    const readiness = new Promise<() => void>((resolve) => { resolveReadiness = resolve; });
    const welcomed = new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "welcome") resolve();
        if (m.type === "rpc.request" && m.method === "agents.readiness") {
          resolveReadiness(() => ws.send(JSON.stringify({ type: "rpc.response", id: m.id, ok: true, result: REPLY })));
        }
      });
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKEN, version: "0", adapters: ["codex-direct"], features: ["accounts"] })));
    await welcomed;
    return { ws, readiness };
  }

  test("with two connections online the newest answers, and daemon names exactly that connection", async () => {
    await daemon();
    const newer = await daemon();
    const pending = get(app);
    (await newer.readiness)();
    const response = await pending;
    expect(response.status).toBe(200);
    const body = (await response.json()) as AgentReadinessResponse;
    const snapshot = handle.statusSnapshot();
    expect(snapshot.daemonId).toBe(handle.connectedDaemonIds()[1]);
    expect(body.daemon).toEqual({ id: snapshot.daemonId, connectionId: snapshot.connectionId, label: null });
    expect(body.access).toBe("full");
  });

  test("a newer connection accepted while the call is in flight makes the answer stale: 503", async () => {
    const first = await daemon();
    const pending = get(app);
    const release = await first.readiness;
    await daemon();
    await vi.waitFor(() => expect(handle.connectedDaemonIds()).toHaveLength(2));
    release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: READINESS_STALE });
  });

  test("no daemon connected: 503", async () => {
    const response = await get(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: DAEMON_NOT_CONNECTED });
  });
});
