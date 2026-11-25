import { EventEmitter } from "node:events";
import http from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { completeBootstrap, issueSession, SESSION_COOKIE } from "../src/auth.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { createDaemonRegistrationCode, DaemonRejectionThrottle, registerDaemon, revokeDaemon, verifyDaemonCredential } from "../src/daemons.js";
import { EventBus } from "../src/events.js";
import { postUserMessage } from "../src/messages.js";
import { getTask } from "../src/tasks.js";
import { createWorkspace } from "../src/workspaces.js";
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
      return message as { type: string; message?: string; taskId?: string; runToken?: string };
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

    const largeBody = JSON.stringify({ code, label: "Laptop", padding: "文".repeat(2000) });
    for (const length of [String(Buffer.byteLength(largeBody)), undefined, "128"]) {
      const response = await app.request("http://127.0.0.1:4400/api/daemons/register", {
        method: "POST",
        headers: { "content-type": "application/json", ...(length ? { "content-length": length } : {}) },
        body: largeBody,
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: expect.stringMatching(/too large/i) });
    }
    expect(await db.query("select used_at from daemon_registration_codes")).toEqual([{ used_at: null }]);

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
    const revokedAgain = new TestDaemonSocket();
    revokedAgain.hello(credential);
    expect((await revokedAgain.received("error")).message).toMatch(/revoked/i);
    const shared = new TestDaemonSocket();
    shared.hello("shared-fixture-token");
    expect((await shared.received("error")).message).toMatch(/invalid/i);
    expect(await db.query("select daemon_id, owner_user_id from daemon_events where kind='rejected' order by created_at")).toEqual([
      { daemon_id: id, owner_user_id: "usr_owner" },
      { daemon_id: null, owner_user_id: null },
    ]);

    const secondCode = ((await (await request("/registration-codes", owner, {})).json()) as { code: string }).code;
    const expired = ((await (await request("/registration-codes", owner, {})).json()) as { code: string }).code;
    const second = await (await request("/register", undefined, { code: secondCode, label: "Desktop" })).json() as { id: string };
    expect((await request(`/${second.id}/revoke`, owner, {})).status).toBe(200);

    await db.query("update daemon_registration_codes set expires_at=now() - interval '1 second' where used_at is null");
    expect((await request("/register", undefined, { code: expired, label: "Expired" })).status).toBe(400);
    expect(await db.query("select id from daemon_registration_codes")).toHaveLength(2);

    const batch = await Promise.all(Array.from({ length: 6 }, () => request("/registration-codes", owner, {})));
    expect(batch.map((r) => r.status).sort()).toEqual([201, 201, 201, 201, 201, 429]);
    const limit = await batch.find((r) => r.status === 429)!.json();
    expect(limit).toEqual({ error: expect.stringMatching(/use .* or wait .* expire/i) });
    const activeCodes = await db.query("select owner_user_id, used_at from daemon_registration_codes");
    expect(activeCodes).toEqual(Array.from({ length: 5 }, () => ({ owner_user_id: "usr_owner", used_at: null })));
    expect((await request("/registration-codes", other, {})).status).toBe(201);

    const { code: activeCode } = await batch.find((r) => r.status === 201)!.json() as { code: string };
    expect((await request("/register", undefined, { code: activeCode, label: "New daemon" })).status).toBe(201);
    expect((await request("/registration-codes", owner, {})).status).toBe(201);
  } finally {
    await socket.close();
    await close();
  }
});

test("unknown credential throttle evicts the oldest key at capacity", () => {
  const throttle = new DaemonRejectionThrottle(() => 0, 2);
  expect(throttle.shouldLog("first")).toBe(true);
  expect(throttle.shouldLog("second")).toBe(true);
  expect(throttle.shouldLog("third")).toBe(true);
  expect(throttle.trackedKeys).toBe(2);
  expect(throttle.shouldLog("second")).toBe(false);
  expect(throttle.shouldLog("first")).toBe(true);
  expect(throttle.trackedKeys).toBe(2);
});

test("a revoked daemon's first denial is audited, then at most once per hour", async () => {
  const { db, close } = await makeHubDeps();
  try {
    await db.query("insert into users(id, display_name) values ('usr_owner','Owner')");
    const { code } = await createDaemonRegistrationCode(db, "usr_owner");
    const { id, credential } = (await registerDaemon(db, code, "Laptop"))!;
    expect(await verifyDaemonCredential(db, credential)).toEqual({ ok: true, id });
    await revokeDaemon(db, id, "usr_owner");

    const reject = () => verifyDaemonCredential(db, credential);
    const rejected = () => db.query("select detail from daemon_events where daemon_id=$1 and kind='rejected'", [id]);
    expect(await rejected()).toHaveLength(0);
    for (const result of await Promise.all([reject(), reject()])) {
      expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/revoked/i) });
    }
    expect(await rejected()).toEqual([{ detail: { reason: "revoked_credential" } }]);
    await db.query("update daemon_events set created_at=now() - interval '59 minutes' where daemon_id=$1 and kind='rejected'", [id]);
    await reject();
    expect(await rejected()).toHaveLength(1);
    await db.query("update daemon_events set created_at=now() - interval '61 minutes' where daemon_id=$1 and kind='rejected'", [id]);
    await reject();
    await reject();
    expect(await rejected()).toHaveLength(2);
  } finally {
    await close();
  }
});

test("a reconnect reclaims a running task left behind by failed cleanup of the same stable daemon", async () => {
  const { db, dataDir, close } = await makeHubDeps();
  const socket = attachDaemonSocket(http.createServer(), {
    db, dataDir, events: new EventBus(), daemonToken: "shared-fixture-token", hubUrl: "http://127.0.0.1:4400", remoteAuth: true,
  });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const transaction = vi.spyOn(db, "tx");
  try {
    const { userId } = await completeBootstrap(db, "Owner", "fixture");
    const { code } = await createDaemonRegistrationCode(db, userId);
    const { id, credential } = (await registerDaemon(db, code, "Laptop"))!;
    const workspace = await createWorkspace(db, dataDir, "Workspace", undefined, userId);
    const { task } = await postUserMessage(db, workspace.id, "Queued work", { authorUserId: userId });
    const first = new TestDaemonSocket();
    first.hello(credential);
    const previous = await first.received("task.assign");
    expect(previous).toMatchObject({ taskId: task.id, runToken: expect.any(String) });
    expect(await getTask(db, task.id)).toMatchObject({ status: "running", daemonId: id });

    transaction.mockRejectedValueOnce(new Error("fixture cleanup failure"));
    first.close();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("[daemon] close failed", expect.any(Error)));
    expect(await getTask(db, task.id)).toMatchObject({ status: "running", daemonId: id, runToken: previous.runToken });

    const replacement = new TestDaemonSocket();
    replacement.hello(credential);
    const assigned = await replacement.received("task.assign");
    expect(assigned.taskId).toBe(task.id);
    expect(assigned.runToken).toEqual(expect.any(String));
    expect(assigned.runToken).not.toBe(previous.runToken);
    expect(await db.query("select interruptions from tasks where id=$1", [task.id])).toEqual([{ interruptions: 1 }]);
  } finally {
    transaction.mockRestore();
    log.mockRestore();
    await socket.close();
    await close();
  }
});

test("unknown daemon credentials are rejected each time and audited once per hash per minute", async () => {
  const { db, close } = await makeHubDeps();
  let now = 0;
  const throttle = new DaemonRejectionThrottle(() => now);
  const reject = async (credential: string) => {
    expect(await verifyDaemonCredential(db, credential, throttle)).toMatchObject({ ok: false, error: expect.stringMatching(/invalid/i) });
  };
  const rejected = () => db.query("select daemon_id, owner_user_id, detail from daemon_events where kind='rejected'");

  try {
    await Promise.all(["unknown-one", "unknown-two", "unknown-one", "unknown-two", "unknown-three"].map(reject));
    expect(await rejected()).toEqual(Array.from({ length: 3 }, () => ({
      daemon_id: null, owner_user_id: null, detail: { reason: "invalid_credential" },
    })));
    now = 59_999;
    await reject("unknown-one");
    expect(await rejected()).toHaveLength(3);
    now = 60_000;
    await reject("unknown-one");
    await reject("unknown-one");
    expect(await rejected()).toHaveLength(4);
  } finally {
    await close();
  }
});
