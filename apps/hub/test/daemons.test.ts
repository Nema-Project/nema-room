import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { completeBootstrap, issueSession, SESSION_COOKIE } from "../src/auth.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { EventBus } from "../src/events.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const transport = vi.hoisted(() => ({ accept: (_socket: unknown) => {} }));
vi.mock("ws", () => ({
  WebSocketServer: class extends EventEmitter {
    readonly clients = new Set<{ close(): void }>();
    constructor() {
      super();
      transport.accept = (socket) => {
        const client = socket as TestDaemonSocket;
        this.clients.add(client);
        client.once("close", () => this.clients.delete(client));
        this.emit("connection", client);
      };
    }
    close(done: () => void) { done(); }
  },
}));

class TestDaemonSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly send = vi.fn<(raw: string) => void>();
  close() {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close"));
  }
  terminate() { this.close(); }
  hello(token: string) {
    transport.accept(this);
    this.emit("message", JSON.stringify({ type: "hello", token, version: "test", adapters: ["codex-direct"] }));
  }
  async received(type: string) {
    return vi.waitFor(() => {
      const message = this.send.mock.calls.map(([raw]) => JSON.parse(raw)).find((m) => m.type === type);
      expect(message).toBeDefined();
      return message as { type: string; message?: string };
    });
  }
}

afterEach(cleanupHubDeps);

test("registration consumes a private code once; listing is owner-scoped and revocation permits owner or hub admin", async () => {
  const { db, dataDir, close } = await makeHubDeps();
  const events = new EventBus();
  const socket = attachDaemonSocket(http.createServer(), {
    db, dataDir, events, daemonToken: "shared-fixture-token", hubUrl: "http://127.0.0.1:4400", remoteAuth: true,
  });
  const app = createApp({
    db, dataDir, events, daemonStatus: socket.isConnected, remoteAuth: true,
    daemon: socket.rpc, revokeRegisteredDaemon: socket.revokeRegisteredDaemon,
  });
  const { userId: admin, session } = await completeBootstrap(db, "Admin", "fixture");
  await db.query("insert into users(id, display_name) values ('usr_owner','Owner'), ('usr_other','Other')");
  await db.query("insert into user_credentials(user_id,password_hash) values ('usr_owner','fixture'), ('usr_other','fixture')");
  const owner = (await issueSession(db, "usr_owner")).token;
  const other = (await issueSession(db, "usr_other")).token;
  const request = (path: string, token?: string, body?: unknown, host = "127.0.0.1:4400") =>
    app.request(`http://${host}/api/daemons${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    expect((await request("/registration-codes", undefined, {})).status).toBe(401);
    expect((await request("")).status).toBe(401);
    const issued = await request("/registration-codes", owner, { ownerUserId: admin });
    expect(issued.status).toBe(201);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const { code, expiresAt } = await issued.json() as { code: string; expiresAt: string };
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    const [stored] = await db.query("select code_hash, owner_user_id from daemon_registration_codes");
    expect(stored).toMatchObject({ owner_user_id: "usr_owner", code_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(stored)).not.toContain(code);
    expect((await request("/register", undefined, { code, label: "Laptop" }, "untrusted.test")).status).toBe(403);

    const results = await Promise.all([
      request("/register", undefined, { code, label: "Laptop" }),
      request("/register", undefined, { code, label: "Laptop" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    const registered = results.find((r) => r.status === 201)!;
    expect(registered.headers.get("cache-control")).toBe("no-store");
    const { id, credential } = await registered.json() as { id: string; credential: string };
    const [daemon] = await db.query("select credential_hash from daemons where id=$1", [id]);
    expect(daemon).toMatchObject({ credential_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(daemon)).not.toContain(credential);
    expect(await (await request("", other)).json()).toEqual([]);
    expect(await (await request("", session.token)).json()).toEqual([]);
    expect(await (await request("", owner)).json()).toEqual([
      expect.objectContaining({ id, label: "Laptop", lastSeenAt: null, revokedAt: null }),
    ]);
    const connected = new TestDaemonSocket();
    connected.hello(credential);
    await connected.received("welcome");
    expect(socket.isConnected()).toBe(true);
    expect(await (await request("", owner)).json()).toEqual([
      expect.objectContaining({ id, lastSeenAt: expect.any(String) }),
    ]);
    expect((await request(`/${id}/revoke`, other, {})).status).toBe(403);
    expect((await request(`/${id}/revoke`, undefined, {})).status).toBe(401);
    expect((await request(`/${id}/revoke`, session.token, {})).status).toBe(200);
    expect((await request(`/${id}/revoke`, owner, {})).status).toBe(200);
    expect((await connected.received("error")).message).toMatch(/revoked/i);
    expect(socket.isConnected()).toBe(false);
    expect(await db.query("select kind, owner_user_id, actor_user_id from daemon_events where daemon_id=$1 order by created_at", [id])).toEqual([
      { kind: "registered", owner_user_id: "usr_owner", actor_user_id: "usr_owner" },
      { kind: "revoked", owner_user_id: "usr_owner", actor_user_id: admin },
    ]);

    const revoked = new TestDaemonSocket();
    revoked.hello(credential);
    expect((await revoked.received("error")).message).toMatch(/revoked/i);
    const shared = new TestDaemonSocket();
    shared.hello("shared-fixture-token");
    expect((await shared.received("error")).message).toMatch(/invalid/i);
    expect(await db.query("select daemon_id, owner_user_id from daemon_events where kind='rejected' order by created_at")).toEqual([
      { daemon_id: id, owner_user_id: "usr_owner" },
      { daemon_id: null, owner_user_id: null },
    ]);

    const secondCode = ((await (await request("/registration-codes", owner, {})).json()) as { code: string }).code;
    const second = await (await request("/register", undefined, { code: secondCode, label: "Desktop" })).json() as { id: string };
    expect((await request(`/${second.id}/revoke`, owner, {})).status).toBe(200);

    const expired = ((await (await request("/registration-codes", owner, {})).json()) as { code: string }).code;
    await db.query("update daemon_registration_codes set expires_at=now() - interval '1 second' where used_at is null");
    expect((await request("/register", undefined, { code: expired, label: "Expired" })).status).toBe(400);
  } finally {
    await socket.close();
    await close();
  }
});
