// The hub side of the daemon contract (B3/B4), over a real socket: the hello the daemon sends, the
// task.assign it parses with parseHubToDaemon, and the request RoomClient.fetchAttachment makes
// (`GET ${hubUrl}/room/attachments/${encodeURIComponent(id)}` with `authorization: Bearer <runToken>`),
// checked the way fetchAttachments checks it (size and sha256 against the ref).
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { afterAll, afterEach, beforeEach, expect, test } from "vitest";
import WebSocket from "ws";
import { AttachmentRefSchema, parseHubToDaemon } from "@nema/shared";
import { createApp } from "../src/app.js";
import { attachDaemonSocket } from "../src/daemonSocket.js";
import type { Db } from "../src/db/db.js";
import { EventBus } from "../src/events.js";
import { postUserMessage } from "../src/messages.js";
import { createWorkspace } from "../src/workspaces.js";
import { png, uploadPng } from "./attachmentFixtures.js";
import { cleanupHubDeps, makeHubDeps } from "./helpers.js";

const TOKEN = "daemon-token";
let db: Db;
let dataDir: string;
let server: http.Server;
let hubUrl: string;
let socket: { close(): Promise<void> };
const clients: WebSocket[] = [];

beforeEach(async () => {
  ({ db, dataDir } = await makeHubDeps());
  server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  hubUrl = `http://127.0.0.1:${port}`;
  const events = new EventBus();
  const handle = attachDaemonSocket(server, { db, dataDir, events, daemonToken: TOKEN, hubUrl });
  socket = handle;
  const app = createApp({ db, dataDir, events, port, daemonStatus: () => handle.isConnected(), daemon: handle.rpc });
  server.on("request", getRequestListener(app.fetch));
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  await socket.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
afterAll(cleanupHubDeps);

/** Connects like the daemon does and returns the first task.assign, parsed with the daemon's own parser. */
function daemonAssign(features: string[]) {
  return new Promise<ReturnType<typeof parseHubToDaemon> & { type: "task.assign" }>((resolve, reject) => {
    const ws = new WebSocket(`${hubUrl.replace("http", "ws")}/daemon`);
    clients.push(ws);
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: TOKEN, version: "0", adapters: ["codex-direct"], features })));
    ws.on("message", (d) => {
      const m = parseHubToDaemon(JSON.parse(String(d)));
      if (m.type === "task.assign") resolve(m);
    });
  });
}

/** Byte for byte the request RoomClient.fetchAttachment sends. */
const roomFetch = (base: string, runToken: string, id: string) =>
  fetch(`${base}/room/attachments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${runToken}` } });

test("a daemon advertising attachments gets refs it can fetch and verify with its run token", async () => {
  const ws = (await createWorkspace(db, dataDir, "A")).id;
  const bytes = png(3000, 9);
  const file = await uploadPng(db, dataDir, ws, bytes, "截图 1.png");
  await postUserMessage(db, ws, "", { attachmentIds: [file.id] });

  const assign = await daemonAssign(["attachments"]);
  expect(assign.hubUrl).toBe(hubUrl);
  expect(assign.attachments).toHaveLength(1);
  const ref = AttachmentRefSchema.parse(assign.attachments![0]);
  expect(ref).toEqual({ id: file.id, kind: "image", mime: "image/png", name: "截图 1.png", size: bytes.length, sha256: file.sha256, messageId: expect.any(String) });

  const res = await roomFetch(assign.hubUrl, assign.runToken, ref.id);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(ref.mime);
  const body = Buffer.from(await res.arrayBuffer());
  expect(body.length).toBe(ref.size);
  expect(createHash("sha256").update(body).digest("hex")).toBe(ref.sha256);

  // What fetchAttachments maps to its own messages: outside the set 404, bad token 401.
  expect((await roomFetch(assign.hubUrl, assign.runToken, "att_0000000000000000")).status).toBe(404);
  expect((await roomFetch(assign.hubUrl, "wrong", ref.id)).status).toBe(401);
});

test("without the feature the hub never assigns a task with attachments", async () => {
  const ws = (await createWorkspace(db, dataDir, "A")).id;
  const file = await uploadPng(db, dataDir, ws);
  await postUserMessage(db, ws, "with file", { attachmentIds: [file.id] });
  const textOnly = await postUserMessage(db, ws, "plain");
  const assign = await daemonAssign([]);
  expect(assign.taskId).toBe(textOnly.task.id);
  expect(assign.attachments).toBeUndefined();
});
