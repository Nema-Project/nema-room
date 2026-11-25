import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { createWorkspace } from "../src/workspaces.js";
import { postUserMessage } from "../src/messages.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import { claimNextTask, computeWaitingReason, getTask, toUiTask, type OnlineDaemon } from "../src/tasks.js";
import { createApp } from "../src/app.js";
import { createDaemonRegistrationCode, registerDaemon } from "../src/daemons.js";

const TOKEN = "tok";
const WIDGET_SCP = "git@github.com:acme/widget.git";
const WIDGET_HTTPS = "https://github.com/acme/widget";
const WIDGET_NORMALIZED = "github.com/acme/widget";

let db: Db;
let dataDir: string;
let events: EventBus;
let wsAlice: string;
let wsUnbound: string;
let remoteServer: http.Server;
let remoteUrl: string;
let remote: ReturnType<typeof attachDaemonSocket>;
let aliceId: string;
let aliceCredential: string;
let bobId: string;
let bobCredential: string;
const sockets: WebSocket[] = [];

type Msg = Record<string, any>;
type Client = {
  ws: WebSocket;
  name: string;
  next(type?: string): Promise<Msg>;
  /** True if a message of `type` has arrived and not been taken. Never consumes it. */
  has(type: string): boolean;
  send(m: Msg): void;
  closed: Promise<void>;
};

function connect(token: string, name: string, hello: Msg = {}, targetUrl = remoteUrl): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(targetUrl);
    sockets.push(ws);
    const queue: Msg[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as Msg;
      queue.push(m);
      // Answer every RPC at once with this client's name, so the test can tell which daemon a call reached.
      if (m.type === "rpc.request") ws.send(JSON.stringify({ type: "rpc.response", id: m.id, ok: true, result: name }));
      waiters.shift()?.();
    });
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    ws.on("error", reject);
    const client: Client = {
      ws,
      name,
      closed,
      send: (m) => ws.send(JSON.stringify(m)),
      has: (type) => queue.some((m) => m.type === type),
      async next(type) {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const i = queue.findIndex((m) => !type || m.type === type);
          if (i >= 0) return queue.splice(i, 1)[0]!;
          if (Date.now() > deadline) throw new Error(`timeout waiting for ${type ?? "message"}`);
          await new Promise<void>((r) => {
            waiters.push(r);
            setTimeout(r, 50);
          });
        }
      },
    };
    ws.on("open", () => {
      client.send({ type: "hello", token, version: "0", adapters: ["codex-direct"], features: ["accounts"], ...hello });
      resolve(client);
    });
  });
}

async function expectNoAssign(c: Client, ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  expect(c.has("task.assign")).toBe(false);
}

async function register(userId: string, label: string): Promise<{ id: string; credential: string }> {
  return (await registerDaemon(db, (await createDaemonRegistrationCode(db, userId)).code, label))!;
}

async function bindRepo(workspaceId: string, remoteUrl: string, label: string): Promise<void> {
  await db.query(
    `insert into workspace_repos (id, workspace_id, path, git_common_dir, label, main_branch, has_origin, remote_url)
     values ($1, $2, '/tmp/not-a-real-repo', '/tmp/not-a-real-repo/.git', $3, 'main', true, $4)`,
    [`repo_${label}`, workspaceId, label, remoteUrl],
  );
}

async function queue(workspaceId: string, authorUserId: string, content: string) {
  const { task } = await postUserMessage(db, workspaceId, content, { authorUserId });
  events.emit(workspaceId, { type: "task.updated", task: toUiTask(task!) });
  return task!;
}

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  events = new EventBus();
  await db.query("insert into users(id, display_name) values ('usr_alice','Alice'), ('usr_bob','Bob')");
  wsAlice = (await createWorkspace(db, dataDir, "Alice's", undefined, "usr_alice")).id;
  wsUnbound = (await createWorkspace(db, dataDir, "Alice unbound", undefined, "usr_alice")).id;
  await bindRepo(wsAlice, WIDGET_SCP, "Widget");
  ({ id: aliceId, credential: aliceCredential } = await register("usr_alice", "Alice laptop"));
  ({ id: bobId, credential: bobCredential } = await register("usr_bob", "Bob laptop"));
  remoteServer = http.createServer();
  remote = attachDaemonSocket(remoteServer, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://hub.test", remoteAuth: true });
  await new Promise<void>((r) => remoteServer.listen(0, "127.0.0.1", r));
  remoteUrl = `ws://127.0.0.1:${(remoteServer.address() as AddressInfo).port}/daemon`;
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await remote?.close();
  remoteServer.closeAllConnections();
  await new Promise<void>((r) => remoteServer.close(() => r()));
});
afterAll(cleanupHubDeps);

describe("routing eligibility (D-6, acceptance A)", () => {
  test("a non-member daemon claims nothing; the member daemon claims it", async () => {
    const bob = await connect(bobCredential, "bob", {}, remoteUrl);
    await bob.next("welcome");
    const alice = await connect(aliceCredential, "alice", {}, remoteUrl);
    await alice.next("welcome");
    const task = await queue(wsUnbound, "usr_alice", "unbound work");
    await expectNoAssign(bob);
    expect((await alice.next("task.assign")).taskId).toBe(task.id);
    expect((await getTask(db, task.id))?.daemonId).toBe(aliceId);
  });

  test("a member daemon without the repo cannot claim a bound workspace, but can claim an unbound one", async () => {
    const alice = await connect(aliceCredential, "alice", { heldRepos: [] }, remoteUrl);
    await alice.next("welcome");
    const bound = await queue(wsAlice, "usr_alice", "bound work");
    await expectNoAssign(alice);
    expect((await getTask(db, bound.id))?.status).toBe("queued");
    const free = await queue(wsUnbound, "usr_alice", "free work");
    // The older bound task is skipped, never claimed, and the unbound one is taken.
    expect((await alice.next("task.assign")).taskId).toBe(free.id);
    expect((await getTask(db, bound.id))?.status).toBe("queued");
  });

  test("a holdings refresh unblocks a bound task, across remote URL forms", async () => {
    const alice = await connect(aliceCredential, "alice", { heldRepos: [] }, remoteUrl);
    await alice.next("welcome");
    const task = await queue(wsAlice, "usr_alice", "bound work");
    await expectNoAssign(alice);
    // The bound remote is the scp form; the daemon reports the https form. Normalization must unify them.
    alice.send({ type: "holdings", heldRepos: [WIDGET_HTTPS] });
    expect((await alice.next("task.assign")).taskId).toBe(task.id);
    expect((await getTask(db, task.id))?.daemonId).toBe(aliceId);
  });

  test("two daemons: only the qualified one is assigned; one workspace never runs two tasks", async () => {
    const secondAlice = await register("usr_alice", "Alice desktop");
    const holder = await connect(aliceCredential, "holder", { heldRepos: [WIDGET_NORMALIZED] }, remoteUrl);
    await holder.next("welcome");
    const empty = await connect(secondAlice.credential, "empty", { heldRepos: [] }, remoteUrl);
    await empty.next("welcome");
    const first = await queue(wsAlice, "usr_alice", "first");
    const second = await queue(wsAlice, "usr_alice", "second");
    expect((await holder.next("task.assign")).taskId).toBe(first.id);
    await expectNoAssign(empty);
    expect((await getTask(db, second.id))?.status).toBe("queued");
    holder.send({ type: "task.finished", taskId: first.id, ok: true, reply: "done" });
    await vi.waitFor(async () => expect((await getTask(db, first.id))?.status).toBe("done"));
    expect((await holder.next("task.assign")).taskId).toBe(second.id);
    await expectNoAssign(empty);
    expect((await getTask(db, second.id))?.daemonId).toBe(aliceId);
  });
});

describe("chooseConnection prefers the holder (acceptance B)", () => {
  test("a repo call reaches the holder, and falls back to the newest owner when no holder is online", async () => {
    const secondAlice = await register("usr_alice", "Alice desktop");
    const holder = await connect(aliceCredential, "holder", { heldRepos: [WIDGET_NORMALIZED] }, remoteUrl);
    await holder.next("welcome");
    const empty = await connect(secondAlice.credential, "empty", { heldRepos: [] }, remoteUrl);
    await empty.next("welcome");
    // The empty daemon connected later, so plain newest-first would pick it; the holder must win.
    await expect(remote.rpc.call("repo.inspect", { path: "/x" }, undefined, { workspaceId: wsAlice })).resolves.toBe("holder");
    holder.ws.close();
    await holder.closed;
    await vi.waitFor(() => expect(remote.isConnected(aliceId)).toBe(false));
    // No holder online: the call still succeeds on the newest owner daemon.
    await expect(remote.rpc.call("repo.inspect", { path: "/y" }, undefined, { workspaceId: wsAlice })).resolves.toBe("empty");
  });
});

describe("waitingReason", () => {
  async function reasonFor(taskId: string, online: OnlineDaemon[]) {
    const task = (await getTask(db, taskId))!;
    return computeWaitingReason(db, task, online);
  }

  test("no daemon online", async () => {
    const { task } = await postUserMessage(db, wsAlice, "w", { authorUserId: "usr_alice" });
    expect(await reasonFor(task!.id, [])).toEqual({ kind: "no-daemon-online" });
  });

  test("online daemons, none a member", async () => {
    const { task } = await postUserMessage(db, wsAlice, "w", { authorUserId: "usr_alice" });
    expect(await reasonFor(task!.id, [{ ownerUserId: "usr_bob", heldRepos: new Set([WIDGET_NORMALIZED]) }])).toEqual({
      kind: "no-member-daemon",
      onlineDaemons: 1,
    });
  });

  test("member online without the repo, then with it", async () => {
    const { task } = await postUserMessage(db, wsAlice, "w", { authorUserId: "usr_alice" });
    expect(await reasonFor(task!.id, [{ ownerUserId: "usr_alice", heldRepos: new Set() }])).toEqual({
      kind: "repo-not-held",
      missingRepos: ["Widget"],
    });
    expect(await reasonFor(task!.id, [{ ownerUserId: "usr_alice", heldRepos: new Set([WIDGET_NORMALIZED]) }])).toBeNull();
  });

  test("member online, unbound workspace: no reason", async () => {
    const { task } = await postUserMessage(db, wsUnbound, "w", { authorUserId: "usr_alice" });
    expect(await reasonFor(task!.id, [{ ownerUserId: "usr_alice", heldRepos: new Set() }])).toBeNull();
  });

  test("a queued task behind a running one waits for the task, not a daemon", async () => {
    const first = await postUserMessage(db, wsUnbound, "one", { authorUserId: "usr_alice" });
    const second = await postUserMessage(db, wsUnbound, "two", { authorUserId: "usr_alice" });
    expect((await claimNextTask(db, "d1"))?.id).toBe(first.task!.id);
    expect(await reasonFor(second.task!.id, [])).toBeNull();
  });

  test("a non-queued task has no reason", async () => {
    const { task } = await postUserMessage(db, wsUnbound, "w", { authorUserId: "usr_alice" });
    expect((await claimNextTask(db, "d1"))?.id).toBe(task!.id);
    expect(await reasonFor(task!.id, [])).toBeNull();
  });

  test("POST /messages carries the reason when no daemon is online, and omits it when one can run it", async () => {
    // A local socket hub: its daemon is the local one, a member of every workspace.
    const localServer = http.createServer();
    const local = attachDaemonSocket(localServer, { db, dataDir, events, daemonToken: TOKEN, hubUrl: "http://hub.test" });
    await new Promise<void>((r) => localServer.listen(0, "127.0.0.1", r));
    const localUrl = `ws://127.0.0.1:${(localServer.address() as AddressInfo).port}/daemon`;
    const wsLocal = (await createWorkspace(db, dataDir, "Local")).id;
    const app = createApp({ db, dataDir, events, daemonStatus: () => local.isConnected(), daemon: local.rpc, webOrigin: "http://localhost:3000", waitingReasonFor: local.waitingReasonFor });
    try {
      const post = async () =>
        (await (
          await app.request(`http://127.0.0.1:4400/api/workspaces/${wsLocal}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "hello" }),
          })
        ).json()) as any;
      const noDaemon = await post();
      expect(noDaemon.task.waitingReason).toEqual({ kind: "no-daemon-online" });
      const daemon = await connect(TOKEN, "local", {}, localUrl);
      await daemon.next("welcome");
      // The local daemon counts as a member of every workspace and this one is unbound: no reason.
      const withDaemon = await post();
      expect(withDaemon.task.waitingReason).toBeUndefined();
      expect(withDaemon.task.status).toBe("queued");
    } finally {
      await local.close();
      localServer.closeAllConnections();
      await new Promise<void>((r) => localServer.close(() => r()));
    }
  });
});
