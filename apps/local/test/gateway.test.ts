import http from "node:http";
import net from "node:net";
import { ATTACHMENT_LIMITS } from "@nema/shared";
import { once } from "node:events";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { startGateway, ATTACHMENT_UPLOAD_MAX_BYTES, uploadByteCounter, createGatewayCredential, createGatewayUiAuth, GATEWAY_CREDENTIAL_HEADER, sessionCookieName } from "../src/gateway.js";
import { SessionManager } from "../src/session.js";

const servers: http.Server[] = [];
const gateways: Array<{ close(): Promise<void> }> = [];

function rawRequest(origin: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: address.hostname, port: Number(address.port), path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("SessionManager", () => {
  test("tickets are random, one use, expire after sixty seconds, and sessions validate", () => {
    let now = 1000;
    const session = new SessionManager({ now: () => now });
    const ticket = session.issueTicket();
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    const token = session.consumeTicket(ticket);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.consumeTicket(ticket)).toBeNull();
    expect(session.isValidSession(token!)).toBe(true);
    session.revokeSession(token!);
    expect(session.isValidSession(token!)).toBe(false);

    const expiring = session.issueTicket();
    now += 60_001;
    expect(session.consumeTicket(expiring)).toBeNull();
    session.close();
  });
});

describe("protected same-origin gateway", () => {
  test("serves only the two fixed brand resources to authenticated UI sessions", async () => {
    const webTarget = await listen((req, res) => res.end(`web:${req.url}`));
    const hubTarget = await listen((_req, res) => res.end("hub"));
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget, hubTarget, session, port: 0, privateGatewayCredential: createGatewayCredential() });
    gateways.push(gateway);
    const launch = await fetch(`${gateway.origin}/_nema/launch?ticket=${session.issueTicket()}`, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;
    for (const resource of ["/icon.png", "/nema-room-mark.svg"]) {
      expect((await fetch(`${gateway.origin}${resource}`)).status).toBe(401);
      const response = await fetch(`${gateway.origin}${resource}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`web:${resource}`);
      expect((await fetch(`${gateway.origin}${resource}`, { method: "POST", headers: { cookie } })).status).toBe(405);
    }
    for (const resource of ["/arbitrary.svg", "/assets/icon.png", "/nema-room-mark.svg/extra"]) {
      expect((await fetch(`${gateway.origin}${resource}`, { headers: { cookie } })).status).toBe(404);
    }
    session.close();
  });
  test("exchanges a ticket once for a private cookie and redirects without leaking the ticket", async () => {
    const webTarget = await listen((_req, res) => res.end("web"));
    const hubTarget = await listen((_req, res) => res.end("hub"));
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget, hubTarget, session, port: 0, privateGatewayCredential: createGatewayCredential() });
    gateways.push(gateway);
    const ticket = session.issueTicket();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await fetch(`${gateway.origin}/_nema/launch?ticket=${ticket}`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^nema_session_\d+=[0-9a-f]{64};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(response.headers.get("location")).not.toContain(ticket);
    expect(await (await fetch(`${gateway.origin}/_nema/launch?ticket=${ticket}`, { redirect: "manual" })).status).not.toBe(303);
    expect([...log.mock.calls, ...error.mock.calls].flat().join(" ")).not.toContain(ticket);
    session.close();
  });

  test("an expired launch exchange does not issue a session cookie and upstreams must be loopback", async () => {
    const webTarget = await listen((_req, res) => res.end("web"));
    const hubTarget = await listen((_req, res) => res.end("hub"));
    let now = 10;
    const session = new SessionManager({ now: () => now });
    const gateway = await startGateway({ webTarget, hubTarget, session, port: 0, privateGatewayCredential: createGatewayCredential() });
    gateways.push(gateway);
    const ticket = session.issueTicket();
    now += 60_001;
    const response = await fetch(`${gateway.origin}/_nema/launch?ticket=${ticket}`, { redirect: "manual" });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(startGateway({ webTarget: "https://example.test", hubTarget, session, port: 0, privateGatewayCredential: createGatewayCredential() })).rejects.toThrow(/loopback/);
    session.close();
  });

  test("requires a session for UI, APIs, and SSE; rejects untrusted Host and Origin", async () => {
    const webTarget = await listen((_req, res) => res.end("web"));
    const hubTarget = await listen((_req, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end("data: ok\n\n");
    });
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget, hubTarget, session, port: 0, privateGatewayCredential: createGatewayCredential() });
    gateways.push(gateway);
    const ticket = session.issueTicket();
    const launch = await fetch(`${gateway.origin}/_nema/launch?ticket=${ticket}`, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;

    expect((await fetch(gateway.origin)).status).toBe(401);
    expect((await fetch(`${gateway.origin}/api/workspaces/w1/events`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${gateway.origin}/api/workspaces/w1/events`)).status).toBe(401);
    expect((await fetch(gateway.origin, { headers: { cookie: "nema_session=wrong" } })).status).toBe(401);
    expect((await rawRequest(gateway.origin, "/", { cookie, host: "evil.example" })).status).toBe(403);
    expect((await rawRequest(gateway.origin, "/", { cookie, origin: "null" })).status).toBe(403);
    expect((await rawRequest(gateway.origin, "/", { cookie, origin: "http://evil.example" })).status).toBe(403);
    expect((await rawRequest(gateway.origin, "//[", { cookie, host: new URL(gateway.origin).host })).status).toBe(400);
    session.close();
  });

  test("proxies only fixed same-origin UI and API paths while hiding private hub auth", async () => {
    const webOrigin = await listen((req, res) => res.end(`web:${req.url}`));
    const credential = createGatewayCredential();
    const app = new Hono();
    app.use("/api/*", createGatewayUiAuth(credential));
    app.get("/api/workspaces", (c) => c.text("[]", 200, { "content-type": "application/json" }));
    app.get("/", (c) => c.text("hub home"));
    let seen: Headers | undefined;
    const listener = getRequestListener((request) => {
      seen = request.headers;
      return app.fetch(request);
    });
    const hubOrigin = await listen(listener);
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget: webOrigin, hubTarget: hubOrigin, session, port: 0, privateGatewayCredential: credential });
    gateways.push(gateway);
    const launchUrl = `${gateway.origin}/_nema/launch?ticket=${session.issueTicket()}`;
    const launch = await fetch(launchUrl, { redirect: "manual" });
    const cookie = launch.headers.get("set-cookie")!.split(";")[0]!;

    expect(await (await fetch(gateway.origin, { headers: { cookie } })).text()).toBe("web:/");
    expect(await (await fetch(`${gateway.origin}/w/ws_abc/t/m_xyz?messageId=m_focus`, { headers: { cookie } })).text()).toBe("web:/w/ws_abc/t/m_xyz?messageId=m_focus");
    expect((await fetch(`${gateway.origin}/w/ws_abc/t/m_xyz/extra`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${gateway.origin}/w/ws_abc/t`, { headers: { cookie } })).status).toBe(404);
    const api = await fetch(`${gateway.origin}/api/workspaces`, {
      headers: { cookie, authorization: "Bearer client-secret", "x-nema-gateway-credential": "forged", referer: launchUrl },
    });
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual([]);
    expect(seen?.get(GATEWAY_CREDENTIAL_HEADER)).toBe(credential);
    expect(seen?.get("cookie")).toBeNull();
    expect(seen?.get("authorization")).toBeNull();
    expect(seen?.get("referer")).toBeNull();
    expect([...(seen?.values() ?? [])].some((value) => value.includes(new URL(launchUrl).searchParams.get("ticket")!))).toBe(false);
    expect((await fetch(`${hubOrigin}/api/workspaces`)).status).toBe(401);
    expect((await fetch(`${gateway.origin}/api/no-route`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${gateway.origin}/room`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${gateway.origin}/report`, { headers: { cookie } })).status).toBe(405);
    expect((await fetch(`${gateway.origin}/unknown`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${gateway.origin}/_nema/anything`, { headers: { cookie } })).status).toBe(404);
    session.close();
  });

  test("forwards only the fixed report routes with the caller's bearer token and no browser credentials", async () => {
    const credential = createGatewayCredential();
    const app = new Hono();
    app.post("/report/hook", (c) => c.json({ ok: true }));
    app.post("/report", (c) => c.json({ ok: true }));
    app.get("/report/workpackages/:id", (c) => c.json({ id: c.req.param("id"), git: c.req.query("gitCommonDir") }));
    app.get("/room/plugins", (c) => c.text("room"));
    let seen: Headers | undefined;
    const hubOrigin = await listen(getRequestListener((request) => { seen = request.headers; return app.fetch(request); }));
    const webOrigin = await listen((_req, res) => res.end("web"));
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget: webOrigin, hubTarget: hubOrigin, session, port: 0, privateGatewayCredential: credential });
    gateways.push(gateway);
    const bearer = `Bearer ${"a".repeat(64)}`;
    const post = (path: string, headers: Record<string, string>) => fetch(`${gateway.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

    expect((await post("/report/hook", {})).status).toBe(401);
    expect((await post("/report/hook", { authorization: "Bearer short" })).status).toBe(401);
    expect((await post("/report/hook", { cookie: "nema=1", authorization: bearer, "x-nema-gateway-credential": "forged" })).status).toBe(200);
    expect(seen?.get("authorization")).toBe(bearer);
    expect(seen?.get("cookie")).toBeNull();
    expect(seen?.get(GATEWAY_CREDENTIAL_HEADER)).toBeNull();
    expect((await post("/report", { authorization: bearer })).status).toBe(200);
    const wp = await fetch(`${gateway.origin}/report/workpackages/W-1?gitCommonDir=%2Frepo`, { headers: { authorization: bearer } });
    expect(await wp.json()).toEqual({ id: "W-1", git: "/repo" });
    expect((await fetch(`${gateway.origin}/report/hook`, { headers: { authorization: bearer } })).status).toBe(405);
    expect((await fetch(`${gateway.origin}/report/other`, { headers: { authorization: bearer } })).status).toBe(404);
    expect((await fetch(`${gateway.origin}/room/plugins`, { headers: { authorization: bearer } })).status).toBe(404);
    session.close();
  });

  test("forwards SSE incrementally without waiting for the upstream stream to finish", async () => {
    const webTarget = await listen((_req, res) => res.end("web"));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hubTarget = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      void held.then(() => res.end("data: second\n\n"));
    });
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget, hubTarget, session, port: 0, privateGatewayCredential: createGatewayCredential() });
    gateways.push(gateway);
    const token = session.consumeTicket(session.issueTicket())!;
    const response = await fetch(`${gateway.origin}/api/workspaces/w1/events`, { headers: { cookie: `${sessionCookieName(gateway.origin)}=${token}` } });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("first");
    release();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toContain("second");
    expect((await reader.read()).done).toBe(true);
    session.close();
  });

  test("close cancels active streamed upstream responses before returning", async () => {
    const webTarget = await listen((_req, res) => res.end("web"));
    let resolveUpstreamClosed!: () => void;
    const upstreamClosed = new Promise<void>((resolve) => { resolveUpstreamClosed = resolve; });
    const hubTarget = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: open\n\n");
      res.once("close", resolveUpstreamClosed);
    });
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget, hubTarget, session, port: 0, privateGatewayCredential: createGatewayCredential() });
    gateways.push(gateway);
    const token = session.consumeTicket(session.issueTicket())!;
    const response = await fetch(`${gateway.origin}/api/events`, { headers: { cookie: `${sessionCookieName(gateway.origin)}=${token}` } });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value).toString()).toContain("open");
    await gateway.close();
    await upstreamClosed;
    session.close();
  });
});

describe("attachment upload passthrough", () => {
  type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer };

  async function setup() {
    const credential = createGatewayCredential();
    const seen: Seen[] = [];
    const firstChunk: Array<() => void> = [];
    const received: Buffer[] = [];
    const webTarget = await listen((_req, res) => res.end("web"));
    const hubTarget = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => { chunks.push(chunk); received.push(chunk); firstChunk.splice(0).forEach((notify) => notify()); });
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ size: Buffer.concat(chunks).length }));
      });
    });
    const session = new SessionManager();
    const gateway = await startGateway({ webTarget, hubTarget, session, port: 0, privateGatewayCredential: credential });
    gateways.push(gateway);
    const cookie = `${sessionCookieName(gateway.origin)}=${session.consumeTicket(session.issueTicket())!}`;
    return { credential, seen, firstChunk, received, gateway, session, cookie };
  }

  function upload(origin: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: Buffer }) {
    return fetch(`${origin}${path}`, { method: init.method ?? "POST", headers: init.headers, body: init.body });
  }

  test("the per-file cap is the largest attachment limit", () => {
    expect(ATTACHMENT_UPLOAD_MAX_BYTES).toBe(Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.pdfBytes, ATTACHMENT_LIMITS.textBytes));
    expect(ATTACHMENT_UPLOAD_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  test("the upload counter stops forwarding once more than the limit has passed through", async () => {
    let overflows = 0;
    const counter = uploadByteCounter(10, () => { overflows += 1; });
    const out: Buffer[] = [];
    counter.on("data", (chunk: Buffer) => out.push(chunk));
    counter.write(Buffer.from("01234"));
    counter.write(Buffer.from("56789"));
    counter.write(Buffer.from("X"));
    counter.write(Buffer.from("YZ"));
    counter.end();
    await once(counter, "end");
    expect(Buffer.concat(out).toString()).toBe("0123456789");
    expect(overflows).toBe(1);
  });

  test("forwards an octet-stream upload byte for byte with the gateway credential and no browser credentials", async () => {
    const { credential, seen, gateway, session, cookie } = await setup();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80]);
    const response = await upload(gateway.origin, "/api/workspaces/w1/attachments", {
      headers: { cookie, "content-type": "application/octet-stream", "x-nema-filename": "a%20b.png", "x-nema-upload-key": "4f1c1d1e-5b6a-4c7d-8e9f-0a1b2c3d4e5f", "x-nema-gateway-credential": "forged" },
      body: bytes,
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ size: bytes.length });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/api/workspaces/w1/attachments");
    expect(seen[0]!.body.equals(bytes)).toBe(true);
    expect(seen[0]!.headers[GATEWAY_CREDENTIAL_HEADER]).toBe(credential);
    expect(seen[0]!.headers.cookie).toBeUndefined();
    expect(seen[0]!.headers["content-type"]).toBe("application/octet-stream");
    expect(seen[0]!.headers["content-length"]).toBe(String(bytes.length));
    expect(seen[0]!.headers["x-nema-filename"]).toBe("a%20b.png");
    expect(seen[0]!.headers["x-nema-upload-key"]).toBe("4f1c1d1e-5b6a-4c7d-8e9f-0a1b2c3d4e5f");
    session.close();
  });

  test("requires a session cookie for uploads", async () => {
    const { seen, gateway, session } = await setup();
    const response = await upload(gateway.origin, "/api/workspaces/w1/attachments", { headers: { "content-type": "application/octet-stream" }, body: Buffer.from("hello") });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
    session.close();
  });

  test("keeps every other write JSON-only", async () => {
    const { seen, gateway, session, cookie } = await setup();
    const octet = { cookie, "content-type": "application/octet-stream" };
    const body = Buffer.from("hello");
    for (const method of ["PUT", "PATCH"]) {
      expect((await upload(gateway.origin, "/api/workspaces/w1/attachments", { method, headers: octet, body })).status).toBe(415);
    }
    for (const path of [
      "/api/workspaces/w1/messages",
      "/api/workspaces/w1/attachments/a1",
      "/api/workspaces/w1/attachments/",
      "/api/workspaces//attachments",
      "/api/workspaces/w1/x/attachments",
      "/api/workspaces/w1/attachments?x=1/attachments",
    ]) {
      expect((await upload(gateway.origin, path, { headers: octet, body })).status, path).toBe(415);
    }
    for (const type of ["text/plain", "multipart/form-data; boundary=x", "application/x-www-form-urlencoded"]) {
      expect((await upload(gateway.origin, "/api/workspaces/w1/attachments", { headers: { cookie, "content-type": type }, body })).status, type).toBe(415);
    }
    expect(seen).toHaveLength(0);
    session.close();
  });

  test("rejects a declared length over the per-file cap with 413 before contacting the hub", async () => {
    const { seen, gateway, session, cookie } = await setup();
    const address = new URL(gateway.origin);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: address.hostname, port: Number(address.port), path: "/api/workspaces/w1/attachments", method: "POST",
        headers: { cookie, "content-type": "application/octet-stream", "content-length": String(ATTACHMENT_UPLOAD_MAX_BYTES + 1) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.write(Buffer.alloc(1024));
    });
    expect(status).toBe(413);
    expect(seen).toHaveLength(0);
    session.close();
  });

  test("requires a Content-Length for uploads", async () => {
    const { seen, gateway, session, cookie } = await setup();
    const address = new URL(gateway.origin);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: address.hostname, port: Number(address.port), path: "/api/workspaces/w1/attachments", method: "POST",
        headers: { cookie, "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.write("hello");
    });
    expect(status).toBe(411);
    expect(seen).toHaveLength(0);
    session.close();
  });

  test("never forwards more bytes than the declared Content-Length", async () => {
    const { received, gateway, session, cookie } = await setup();
    const address = new URL(gateway.origin);
    const socket = net.connect(Number(address.port), address.hostname);
    await once(socket, "connect");
    const declared = Buffer.from("0123456789");
    const extra = Buffer.from("EXTRA-BYTES-AFTER-THE-DECLARED-LENGTH");
    socket.resume();
    const closed = once(socket, "close");
    socket.write([
      "POST /api/workspaces/w1/attachments HTTP/1.1",
      `Host: ${address.host}`,
      `Cookie: ${cookie}`,
      "Content-Type: application/octet-stream",
      `Content-Length: ${declared.length}`,
      "", "",
    ].join("\r\n"));
    socket.end(Buffer.concat([declared, extra]));
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const forwarded = Buffer.concat(received);
    expect(forwarded.length).toBeLessThanOrEqual(declared.length);
    expect(forwarded.includes(Buffer.from("EXTRA"))).toBe(false);
    session.close();
  });

  test("streams the body to the hub instead of buffering the whole file", async () => {
    const { seen, firstChunk, gateway, session, cookie } = await setup();
    const address = new URL(gateway.origin);
    const total = 256 * 1024;
    const reachedHub = new Promise<void>((resolve) => firstChunk.push(resolve));
    const response = new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: address.hostname, port: Number(address.port), path: "/api/workspaces/w1/attachments", method: "POST",
        headers: { cookie, "content-type": "application/octet-stream", "content-length": String(total) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.write(Buffer.alloc(total / 2, 0x61));
      // The second half is written only after the hub has already seen bytes from the first half.
      void reachedHub.then(() => req.end(Buffer.alloc(total / 2, 0x62)));
    });
    expect(await response).toBe(201);
    expect(seen[0]!.body.length).toBe(total);
    session.close();
  });
});
