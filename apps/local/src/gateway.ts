import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { Transform } from "node:stream";
import { ATTACHMENT_LIMITS } from "@nema/shared";
import type { MiddlewareHandler } from "hono";
import type { AppReleaseService } from "./appRelease.js";
import type { SessionManager } from "./session.js";
import type { SettingsService } from "./settings.js";

export const GATEWAY_CREDENTIAL_HEADER = "x-nema-gateway-credential";
const SESSION_COOKIE_PREFIX = "nema_session_";

/** Host-scoped cookies do not distinguish ports; include the bound port to isolate local homes. */
export function sessionCookieName(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Invalid gateway origin");
  return `${SESSION_COOKIE_PREFIX}${url.port}`;
}

/** The largest single attachment the hub accepts; the gateway refuses bigger uploads before they reach the hub. */
export const ATTACHMENT_UPLOAD_MAX_BYTES = Math.max(ATTACHMENT_LIMITS.imageBytes, ATTACHMENT_LIMITS.pdfBytes, ATTACHMENT_LIMITS.textBytes);

/** The only hub route that accepts a non-JSON write: raw attachment bytes, POST only. */
const ATTACHMENT_UPLOAD_PATH = /^\/api\/workspaces\/[^/]+\/attachments$/;

/**
 * Passes chunks through until more than `limit` bytes have been seen, then calls `onOverflow` once and drops the rest.
 * HTTP framing already stops at Content-Length; this keeps the cap even if that framing is ever bypassed.
 */
export function uploadByteCounter(limit: number, onOverflow: () => void): Transform {
  let seen = 0;
  let overflowed = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (overflowed) return callback();
      seen += chunk.length;
      if (seen > limit) {
        overflowed = true;
        onOverflow();
        return callback();
      }
      callback(null, chunk);
    },
  });
}

export type GatewayOptions = {
  webTarget: string;
  hubTarget: string;
  session: SessionManager;
  port: number;
  /** Private credential shared with the hub's uiAuth middleware, never sent to the browser. */
  privateGatewayCredential: string;
  settings?: SettingsService;
  appRelease?: AppReleaseService;
};

export type RunningGateway = { origin: string; close(): Promise<void> };

/** Creates the runtime-only secret injected into internal hub UI calls. */
export function createGatewayCredential(): string {
  return randomBytes(32).toString("hex");
}

/** Hono uiAuth gate for direct hub UI/API access. Keep room/report auth separate. */
export function createGatewayUiAuth(credential: string): MiddlewareHandler {
  if (!/^[0-9a-f]{64}$/.test(credential)) throw new Error("Gateway credential must be a 256-bit hex value");
  const expected = Buffer.from(credential, "hex");
  return async (context, next) => {
    const value = context.req.header(GATEWAY_CREDENTIAL_HEADER) ?? "";
    const actual = /^[0-9a-f]{64}$/.test(value) ? Buffer.from(value, "hex") : Buffer.alloc(0);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return context.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

function loopbackTarget(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be a loopback HTTP origin`); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be a loopback HTTP origin`);
  }
  return url;
}

function sessionCookie(req: IncomingMessage, cookieName: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== cookieName) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

const SETTINGS_BODY_LIMIT = 16 * 1024;
async function settingsJson(req: IncomingMessage): Promise<{ value: unknown } | { error: number }> {
  const length = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > SETTINGS_BODY_LIMIT) return { error: 413 };
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > SETTINGS_BODY_LIMIT) return { error: 413 };
    chunks.push(data);
  }
  try { return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }; }
  catch { return { error: 400 }; }
}

function mappedTarget(pathname: string, web: URL, hub: URL): { target: URL; ui: boolean } | null {
  if (pathname === "/api" || pathname.startsWith("/api/")) return { target: hub, ui: false };
  const uiPath = pathname === "/" || /^\/w\/[A-Za-z0-9_-]+\/?$/.test(pathname) ||
    /^\/w\/[A-Za-z0-9_-]+\/t\/[A-Za-z0-9_-]+\/?$/.test(pathname) ||
    /^\/_next\/static\/.+/.test(pathname) || pathname === "/_next/image" ||
    ["/favicon.ico", "/robots.txt", "/manifest.webmanifest", "/icon.svg", "/icon.png", "/nema-room-mark.svg"].includes(pathname);
  return uiPath ? { target: web, ui: true } : null;
}

/** Coding-agent hooks and reports reach the hub with their own bearer report token, never a browser session. */
const reportMethod = (pathname: string): "GET" | "POST" | null =>
  pathname === "/report" || pathname === "/report/hook" ? "POST" : /^\/report\/workpackages(?:\/[A-Za-z0-9_.-]+)?$/.test(pathname) ? "GET" : null;

function sanitizedHeaders(source: IncomingHttpHeaders, credential?: string, bearer?: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const excluded = new Set([
    "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    "cookie", "authorization", "referer", "expect", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
    GATEWAY_CREDENTIAL_HEADER,
  ]);
  const connection = source.connection;
  if (typeof connection === "string") {
    for (const token of connection.split(",")) excluded.add(token.trim().toLowerCase());
  }
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !excluded.has(name.toLowerCase())) headers[name] = value;
  }
  if (credential) headers[GATEWAY_CREDENTIAL_HEADER] = credential;
  if (bearer) headers.authorization = bearer;
  return headers;
}

const RESPONSE_HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie",
]);

function responseHeaders(source: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  const connection = source.connection;
  const excluded = new Set(RESPONSE_HOP_HEADERS);
  if (typeof connection === "string") for (const token of connection.split(",")) excluded.add(token.trim().toLowerCase());
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !excluded.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

/** Serves the web app and authenticated UI API behind a single loopback origin. */
export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
  const webTarget = loopbackTarget(options.webTarget, "webTarget");
  const hubTarget = loopbackTarget(options.hubTarget, "hubTarget");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Gateway port must be between 0 and 65535");
  if (!/^[0-9a-f]{64}$/.test(options.privateGatewayCredential)) throw new Error("Gateway credential must be a 256-bit hex value");

  let origin = "";
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const active = new Set<http.ClientRequest>();
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 400, "bad request");
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const privateUiPath = (req.url ?? "").startsWith("/_nema/");
    const noStore: Record<string, string> = privateUiPath ? { "cache-control": "no-store" } : {};
    if (closing) return send(res, 503, "gateway is closing", noStore);
    if (req.headers.host?.toLowerCase() !== new URL(origin).host.toLowerCase()) return send(res, 403, "forbidden host", noStore);
    const requestOrigin = req.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== origin) return send(res, 403, "forbidden origin", noStore);

    let url: URL;
    try {
      const raw = req.url ?? "";
      if (!raw.startsWith("/") || raw.startsWith("//")) return send(res, 400, "bad request");
      url = new URL(raw, origin);
    } catch {
      return send(res, 400, "bad request");
    }

    if (url.pathname === "/_nema/launch") {
      if (req.method !== "GET" || [...url.searchParams.keys()].some((key) => key !== "ticket") || url.searchParams.getAll("ticket").length !== 1) {
        return send(res, 400, "invalid launch request", { "cache-control": "no-store", "referrer-policy": "no-referrer" });
      }
      const ticket = url.searchParams.get("ticket") ?? "";
      const token = options.session.consumeTicket(ticket);
      if (!token) return send(res, 401, "invalid launch ticket", { "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return send(res, 303, "", {
        location: "/",
        "set-cookie": `${sessionCookieName(origin)}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
    }

    const settingsPath = url.pathname.startsWith("/_nema/");
    const reportAllowed = settingsPath ? null : reportMethod(url.pathname);
    const report = reportAllowed !== null;
    const mapped = settingsPath ? null : report ? { target: hubTarget, ui: false } : mappedTarget(url.pathname, webTarget, hubTarget);
    if (!settingsPath && !mapped) return send(res, 404, "not found");
    if (report) {
      // No cookie session here: only a well-formed bearer is forwarded, and the hub accepts just a registered report token.
      if (req.method !== reportAllowed || !/^Bearer [0-9a-f]{64}$/i.test(req.headers.authorization ?? "")) return send(res, req.method !== reportAllowed ? 405 : 401, req.method !== reportAllowed ? "method not allowed" : "unauthorized", noStore);
    } else {
      const token = sessionCookie(req, sessionCookieName(origin));
      if (!token || !options.session.isValidSession(token)) return send(res, 401, "unauthorized", noStore);
    }

    if (settingsPath) {
      if (url.search !== "") return send(res, 400, JSON.stringify({ error: "invalid_request" }), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      if (!["GET", "POST", "PATCH"].includes(req.method ?? "")) return send(res, 404, "not found", { "cache-control": "no-store" });
      let body: unknown;
      if (req.method !== "GET") {
        const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
        if (contentType !== "application/json") return send(res, 415, JSON.stringify({ error: "content_type" }), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        const parsed = await settingsJson(req);
        if ("error" in parsed) return send(res, parsed.error, JSON.stringify({ error: parsed.error === 413 ? "body_too_large" : "invalid_json" }), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        body = parsed.value;
      }
      const release = options.appRelease ? await options.appRelease.dispatch(req.method ?? "", url.pathname, body) : null;
      if (release) {
        return send(res, release.status, JSON.stringify(release.body), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      }
      if (!options.settings) return send(res, 404, "not found", { "cache-control": "no-store" });
      const result = await options.settings.dispatch(req.method ?? "", url.pathname, body);
      const encoded = JSON.stringify(result.body);
      return send(res, result.status, encoded, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    }

    if (mapped!.ui && req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method not allowed", { allow: "GET, HEAD" });
    if (!mapped!.ui && !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(req.method ?? "")) {
      return send(res, 405, "method not allowed", { allow: "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS" });
    }
    let uploadLimit: number | null = null;
    if (!mapped!.ui && ["POST", "PUT", "PATCH"].includes(req.method ?? "")) {
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const upload = !report && req.method === "POST" && url.search === "" && ATTACHMENT_UPLOAD_PATH.test(url.pathname) && contentType === "application/octet-stream";
      if (!upload && contentType !== "application/json") return send(res, 415, "content-type must be application/json");
      if (upload) {
        // Refuse early, without contacting the hub; close the connection so the unread body is dropped.
        const declared = req.headers["content-length"];
        if (declared === undefined || !/^\d+$/.test(declared)) return send(res, 411, "content-length required", { connection: "close" });
        const length = Number(declared);
        if (length > ATTACHMENT_UPLOAD_MAX_BYTES) return send(res, 413, "attachment too large", { connection: "close" });
        uploadLimit = length;
      }
    }

    let overflowed = false;
    const target = new URL(`${url.pathname}${url.search}`, mapped!.target);
    const headers = sanitizedHeaders(req.headers, mapped!.ui || report ? undefined : options.privateGatewayCredential, report ? req.headers.authorization : undefined);
    const upstream = http.request(target, { method: req.method, headers });
    active.add(upstream);
    upstream.once("close", () => active.delete(upstream));
    upstream.once("response", (upstreamResponse) => {
      if (closing || overflowed || res.destroyed) {
        upstreamResponse.destroy();
        return;
      }
      res.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders(upstreamResponse.headers));
      upstreamResponse.pipe(res);
    });
    upstream.once("error", () => {
      active.delete(upstream);
      if (overflowed) return;
      if (!res.headersSent && !res.destroyed) send(res, 502, "upstream unavailable");
      else if (!res.destroyed) res.destroy();
    });
    req.once("aborted", () => upstream.destroy());
    res.once("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    if (uploadLimit === null) {
      req.pipe(upstream);
      return;
    }
    // Stream the upload through a byte counter: never buffer the file, never forward more than was declared.
    const counter = uploadByteCounter(uploadLimit, () => {
      overflowed = true;
      req.unpipe(counter);
      if (!res.headersSent) send(res, 413, "attachment too large", { connection: "close" });
      else res.destroy();
      upstream.destroy();
    });
    req.pipe(counter).pipe(upstream);
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind a TCP address");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    close() {
      closePromise ??= (async () => {
        if (closing) return;
        closing = true;
        const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections();
        for (const request of active) request.destroy();
        await closed;
        while (active.size > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      })();
      return closePromise;
    },
  };
}
